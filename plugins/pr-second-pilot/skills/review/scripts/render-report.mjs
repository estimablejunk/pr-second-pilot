// Render PR/<slug>.md from state. The report is a view, never the source of
// truth — regenerating it must always be safe, and hand-edits to it are only
// read back from the one block that invites them (## Ответы человека).
//
//   node render-report.mjs --state <path>

import { existsSync, readFileSync } from "node:fs";
import { emit, bail, parseArgs, readJson, writeAtomic, sha256File } from "./lib.mjs";
import { dict, fmt } from "./i18n.mjs";

// Уровни не переводятся: их ищут поиском и сверяют с конфигом.
const SEV = { critical: "🔴 critical", major: "🟠 major", minor: "🟡 minor", nit: "⚪ nit" };

/**
 * The rounds table needs a glance-readable cell, not the raw gate summary.
 * With gate.source="ci" that summary is six job names with statuses — it turns
 * a five-row table into an unreadable wall.
 */
function compactGate(summary) {
  if (!summary) return "—";
  // Считаем сами статусы, а не разбиваем строку: имена джоб содержат и
  // двоеточия, и пробелы («ci:api · ruff (lint + format) [non-blocking]:pass»),
  // и любое разбиение по разделителю их дробит.
  const statuses = [...String(summary).matchAll(/:(pass|fail|pending|timeout|skipped|unavailable)(?=\s|$)/g)]
    .map((m) => m[1]);
  if (!statuses.length) return "—";
  const pass = statuses.filter((x) => x === "pass").length;
  const bad = statuses.filter((x) => ["fail", "timeout", "pending"].includes(x));
  return bad.length ? `${pass}/${statuses.length} ✓, ${bad.length} ✗` : `${pass}/${statuses.length} ✓`;
}

// Якорь блока человека — машинный комментарий, а не заголовок. Заголовок
// переводится вместе с остальным отчётом, и если искать по нему, то смена
// report.language потеряет всё, что человек написал. Старый русский заголовок
// распознаётся как запасной вариант, чтобы отчёты, созданные до локализации,
// не осиротели.
const HUMAN_ANCHOR = "<!-- pr-second-pilot:human -->";
const HUMAN_ANCHOR_LEGACY = "## Ответы человека";

/** The one hand-editable region: preserved verbatim across re-renders. */
function extractHumanBlock(reportPath) {
  if (!existsSync(reportPath)) return null;
  const text = readFileSync(reportPath, "utf8");
  let mark = HUMAN_ANCHOR;
  let i = text.indexOf(mark);
  if (i < 0) { mark = HUMAN_ANCHOR_LEGACY; i = text.indexOf(mark); }
  if (i < 0) return null;
  let rest = text.slice(i + mark.length);
  // За новым якорем идёт локализованный заголовок — он не часть ответа.
  rest = rest.replace(/^\s*##[^\n]*\n/, "");
  const end = rest.search(/\n<!-- pr-second-pilot:end-human -->/);
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}

function renderFinding(f, L) {
  const lines = [
    `#### \`${f.id}\` ${SEV[f.severity] ?? f.severity} — ${f.title}`,
    ``,
    `**${L.f_status}:** ${L.fs[f.status] ?? f.status}${f.out_of_scope ? ` · ${L.out_of_scope}` : ""}` +
    `${f.unproven ? ` · ${L.downgraded}` : ""}` +
    `${(f.reopened_count || 0) > 0 ? ` · ${L.reopened} ×${f.reopened_count}` : ""}`,
    f.file ? `**${L.f_where}:** \`${f.file}\`` : null,
    f.sources?.length ? `**${L.f_found_by}:** ${f.sources.join(", ")}` : null,
    ``,
    f.trigger ? `- **${L.f_trigger}.** ${f.trigger}` : null,
    f.mechanism ? `- **${L.f_mechanism}.** ${f.mechanism}` : null,
    f.consequence ? `- **${L.f_consequence}.** ${f.consequence}` : null,
    f.required ? `- **${L.f_required}.** ${f.required}` : null,
    f.proof ? `- **${L.f_proof}.** ${f.proof}` : null,
  ].filter((l) => l !== null);

  const history = (f.history || []).filter((h) => h.actor === "fixer" || h.action === "dispute_rejected");
  if (history.length) {
    lines.push(``, `<details><summary>${L.history}</summary>`, ``);
    for (const h of history) {
      lines.push(`- ${L.t_round} ${h.round} · ${h.actor} · ${h.action}${h.note ? ` — ${h.note}` : ""}${h.edit ? ` (\`${h.edit}\`)` : ""}`);
    }
    lines.push(``, `</details>`);
  }
  return lines.join("\n");
}

function render(state, humanBlock) {
  const L = dict(state.config?.report?.language);
  const t = state.target;
  const c = state.counts || {};
  const findings = state.findings || [];
  const group = (pred) => findings.filter(pred);

  const open = group((f) => f.status === "open");
  const fixed = group((f) => f.status === "fixed");
  const disputed = group((f) => f.status === "disputed");
  const advisory = group((f) => f.status === "advisory");
  const closed = group((f) => f.status === "verified" || f.status === "wontfix");

  const out = [];
  out.push(`# ${t.number ? fmt(L.title_pr, t.number) : fmt(L.title_branch, t.head_ref)}`);
  out.push(``);
  out.push(`> ${L.st[state.status] ?? state.status}`);
  out.push(``);
  out.push(`| | |`);
  out.push(`|---|---|`);
  if (t.title) out.push(`| ${L.m_title} | ${t.title} |`);
  if (t.url) out.push(`| ${L.m_link} | ${t.url} |`);
  out.push(`| ${L.m_base_head} | \`${t.base_ref}\` → \`${t.head_ref}\` |`);
  out.push(`| ${L.m_reviewed} | \`${(state.reviewed_sha || t.head_sha || "").slice(0, 12)}\` |`);
  out.push(`| ${L.m_size} | +${t.stats?.additions ?? "?"} / −${t.stats?.deletions ?? "?"} ${t.stats?.files ?? "?"} ${L.m_files} |`);
  out.push(`| ${L.t_round} | ${fmt(L.round_of, state.round, Math.min(state.config?.loop?.max_rounds ?? 4, state.config?.loop?.hard_cap ?? 8))} |`);
  out.push(`| ${L.m_reviewer} | ${state.config?.reviewer?.model} · ${L.effort} ${state.config?.reviewer?.effort} · ${(state.config?.reviewer?.panel ?? []).join(" + ")} |`);
  out.push(`| ${L.m_fixer} | ${state.config?.fixer?.mode === "inherit" ? L.inherit : `${state.config?.fixer?.model} · ${L.effort} ${state.config?.fixer?.effort}`} |`);
  out.push(`| ${L.m_updated} | ${state.updated_at} |`);
  out.push(``);

  // Итог — сразу под статусом. Отчёт открывают через неделю ради ответа
  // «что в итоге получилось», а не ради пятнадцати карточек с историями.
  if (state.summary?.text) {
    out.push(`## ${L.summary}`, ``, state.summary.text.trim(), ``);
  }

  if (state.merge?.merged) {
    out.push(`## ${L.merged}`, ``);
    out.push(`${L.method}: **${state.merge.method}**, ${L.commit} \`${(state.merge.merge_commit || "").slice(0, 12)}\`` +
      `${state.merge.merged_at ? `, ${state.merge.merged_at}` : ""}.`);
    if (state.merge.branch_deleted === false) {
      out.push(``, `${L.branch_kept}: ${state.merge.cleanup_note || "cleanup after merge did not run"}.`);
    }
    out.push(``);
  }

  if (state.last_stop?.human_note) {
    out.push(`## ⚠️ ${L.decision_needed}`, ``, state.last_stop.human_note, ``);
  }

  if (state.gate && !state.gate.skipped) {
    out.push(`## ${L.gate}`, ``);
    out.push(state.gate.checks.map((c2) =>
      `- ${c2.status === "pass" ? "✅" : c2.status === "unavailable" ? "➖" : "❌"} **${c2.name}** — \`${c2.command}\`` +
      `${c2.status === "pass" ? "" : ` → ${c2.status}`}`).join("\n"));
    out.push(``);
  }

  out.push(`## ${L.outcome}`, ``);
  out.push(`${L.blockers}: **${c.blocking ?? 0}** · ${L.open}: ${c.open ?? 0} · ${L.awaiting}: ${c.fixed ?? 0} · ` +
           `${L.closed}: ${(c.verified ?? 0) + (c.wontfix ?? 0)} · ${L.advisory_n}: ${c.advisory ?? 0}`);
  out.push(``);
  if (state.counts?.severity_counts) {
    const s = state.counts.severity_counts;
    out.push(`${L.by_severity}: 🔴 ${s.critical ?? 0} · 🟠 ${s.major ?? 0} · 🟡 ${s.minor ?? 0} · ⚪ ${s.nit ?? 0}`);
    out.push(``);
  }

  const section = (title, list) => {
    if (!list.length) return;
    out.push(`## ${title} (${list.length})`, ``);
    for (const f of list) { out.push(renderFinding(f, L), ``); }
  };

  section(L.sec_blocking, open.filter((f) => (state.config?.loop?.blocking_severities ?? ["critical", "major"]).includes(f.severity)));
  section(L.sec_open, open.filter((f) => !(state.config?.loop?.blocking_severities ?? ["critical", "major"]).includes(f.severity)));
  section(L.sec_fixed, fixed);
  section(L.sec_disputed, disputed);
  section(L.sec_advisory, advisory);

  if (closed.length) {
    out.push(`## ${L.sec_closed} (${closed.length})`, ``, `<details><summary>${L.show}</summary>`, ``);
    for (const f of closed) {
      out.push(`- \`${f.id}\` ${SEV[f.severity] ?? f.severity} ${f.title} — ${L.fs[f.status] ?? f.status}`);
    }
    out.push(``, `</details>`, ``);
  }

  if (state.human_questions?.length) {
    out.push(`## ${L.sec_questions}`, ``);
    for (const q of state.human_questions) {
      out.push(`- **${q.member ?? "reviewer"}** (${L.t_round} ${q.round ?? "?"}): ${q.question}`);
    }
    out.push(``);
  }

  out.push(HUMAN_ANCHOR);
  out.push(`## ${L.sec_human}`, ``);
  out.push(humanBlock || fmt(L.human_hint, state.target.slug));
  out.push(``, `<!-- pr-second-pilot:end-human -->`, ``);

  if (state.rounds_log?.length) {
    out.push(`## ${L.sec_log}`, ``);
    out.push(`| ${L.t_round} | ${L.t_verdict} | ${L.t_blockers} | ${L.t_checks} | ${L.t_cost} | ${L.t_stop} |`);
    out.push(`|---|---|---|---|---|---|`);
    for (const r of state.rounds_log) {
      out.push(`| ${r.round} | ${r.verdict ?? "—"} | ${r.counts?.blocking ?? "—"} | ${compactGate(r.gate)} | ${r.usage?.window_spent_percent != null ? `${r.usage.window_spent_percent}%` : "—"} | ${r.stop?.status ?? "—"} |`);
    }
    out.push(``);
  }

  out.push(`---`, ``, `<!-- pr-second-pilot:state ${state.target.slug} round=${state.round} -->`);
  out.push(L.generated);
  return out.join("\n") + "\n";
}

function main() {
  const args = parseArgs();
  if (!args.state) bail("arg_missing", { missing: "--state" });
  const state = readJson(args.state);
  if (!state) bail("state_unreadable", { path: args.state });
  const reportPath = args.out || state.paths?.report;
  if (!reportPath) bail("report_path_unknown");

  const humanBlock = extractHumanBlock(reportPath);
  writeAtomic(reportPath, render(state, humanBlock));

  emit({
    ok: true,
    report: reportPath,
    sha256: sha256File(reportPath),
    human_block_preserved: humanBlock !== null && humanBlock.length > 0,
    human_answers: humanBlock && !humanBlock.startsWith("_") ? humanBlock : null,
  });
}

main();
