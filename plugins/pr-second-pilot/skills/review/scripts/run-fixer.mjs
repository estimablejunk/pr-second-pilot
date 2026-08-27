// Prepare — and in subprocess mode, run — the fixer for one round.
//
// Two modes, one prompt:
//   inherit    — renders the brief and hands it back; the orchestrator (this
//                Claude Code session) applies the fixes with its own tools.
//                You watch it happen in the IDE and can interrupt.
//   subprocess — spawns `claude -p --model … --effort …`. This is the only way
//                to give the fixer a model and effort different from the
//                session's, because subagent frontmatter carries `model` but
//                has no effort field.
//
//   node run-fixer.mjs --state <path> --work <dir> --round N --plugin-root <p>
//                      [--config-json '<json>'] [--run]

import path from "node:path";
import { readFileSync, existsSync } from "node:fs";
import {
  emit, bail, parseArgs, readJson, writeAtomic, ensureDir, resolveClaude,
  runAsync, tail, nowIso,
} from "./lib.mjs";

function renderFindings(findings) {
  return findings.map((f) => [
    `### [${f.id}] ${f.severity.toUpperCase()} — ${f.title}`,
    `- файл: ${f.file || "не указан"}`,
    f.trigger ? `- триггер: ${f.trigger}` : null,
    f.mechanism ? `- механизм: ${f.mechanism}` : null,
    f.consequence ? `- последствие: ${f.consequence}` : null,
    f.required ? `- требуется: ${f.required}` : null,
    f.proof ? `- доказательство исправления: ${f.proof}` : null,
    (f.reopened_count || 0) > 0
      ? `- ВНИМАНИЕ: это замечание уже открывалось ${f.reopened_count + 1} раз. Прошлая правка его не закрыла — не повторяй тот же подход.`
      : null,
    (f.dispute_rounds || 0) > 0
      ? `- Ты уже оспаривал это, ревьюер не принял аргумент. Либо исправляй, либо приводи новое доказательство.`
      : null,
  ].filter(Boolean).join("\n")).join("\n\n");
}

function renderGate(gate) {
  if (!gate || gate.ok !== false) return "";
  const failed = gate.checks.filter((c) => c.status === "fail" || c.status === "timeout");
  return [
    "## Красные объективные проверки",
    "Их надо починить в первую очередь — пока они красные, ревью не запускается.",
    "",
    ...failed.map((c) => `### ${c.name} — \`${c.command}\`\n\`\`\`\n${tail(c.output, 2500)}\n\`\`\``),
  ].join("\n");
}

function buildBrief({ template, state, round, findings, reportPath }) {
  const t = state.target;
  // replaceAll, а не replace: со строкой replace меняет ТОЛЬКО первое вхождение,
  // а {{ROUND}} и {{REPORT_PATH}} стоят в шаблоне по два раза — в заголовке и в
  // примере JSON. Исполнитель получал бриф, где путь для отчёта остался
  // плейсхолдером, и писать отчёт было некуда.
  return template
    .replaceAll("{{ROUND}}", String(round))
    .replaceAll("{{TARGET}}", t.number ? `PR #${t.number} — ${t.title}` : `ветка ${t.head_ref} → ${t.base_ref}`)
    .replaceAll("{{REPO_ROOT}}", state.repo_root)
    .replaceAll("{{GATE}}", renderGate(state.gate))
    .replaceAll("{{FINDINGS}}", findings.length ? renderFindings(findings) : "Замечаний нет — правь только красные проверки выше.")
    .replaceAll("{{FINDING_IDS}}", findings.map((f) => f.id).join(", ") || "—")
    .replaceAll("{{REPORT_PATH}}", reportPath);
}

async function runSubprocess(cfg, state, brief, work, resumeSessionId) {
  const claude = resolveClaude();
  if (!claude) {
    return { outcome: "claude_missing", detail: "claude CLI не найден в PATH", fix: "используй fixer.mode=inherit" };
  }
  const args = [
    "-p",
    "--model", cfg.fixer.model,
    "--effort", cfg.fixer.effort,
    "--output-format", "json",
    "--permission-mode", cfg.fixer.permission_mode || "acceptEdits",
    "--add-dir", state.repo_root,
  ];
  if (cfg.fixer.allowed_tools?.length) args.push("--allowedTools", cfg.fixer.allowed_tools.join(","));
  if (resumeSessionId) args.push("--resume", resumeSessionId);

  const r = await runAsync(claude, args, {
    cwd: state.repo_root,
    stdin: brief,
    timeoutMs: (cfg.fixer.timeout_minutes || 30) * 60_000,
  });

  if (r.error === "timeout") {
    return { outcome: "timeout", detail: `исполнитель не уложился в ${cfg.fixer.timeout_minutes} мин` };
  }
  if (!r.ok) {
    const combined = (r.stderr + "\n" + r.stdout).trim();
    if (/usage limit|rate.?limit|429|quota/i.test(combined)) {
      return { outcome: "rate_limited", detail: tail(combined, 600) };
    }
    return { outcome: "failed", exit_code: r.code, detail: tail(combined, 1500) };
  }

  let sessionId = null, resultText = "";
  try {
    const j = JSON.parse(r.stdout);
    sessionId = j.session_id ?? null;
    resultText = j.result ?? j.text ?? "";
  } catch {
    resultText = r.stdout;
  }
  return { outcome: "ok", session_id: sessionId, result: tail(resultText, 4000), seconds: r.seconds };
}

async function main() {
  const args = parseArgs();
  for (const k of ["state", "work", "round", "plugin-root"]) {
    if (!args[k]) bail("arg_missing", { missing: `--${k}` });
  }
  const state = readJson(args.state);
  if (!state) bail("state_unreadable", { path: args.state });
  const cfg = args["config-json"] ? JSON.parse(args["config-json"]) : state.config;
  const round = Number(args.round);
  const work = ensureDir(path.join(args.work, `round${round}`));

  const templatePath = path.join(args["plugin-root"], "skills", "review", "references", "fixer-prompt-template.md");
  if (!existsSync(templatePath)) bail("template_missing", { path: templatePath });

  const toFix = (state.findings || [])
    .filter((f) => f.status === "open")
    .sort((a, b) => ["critical", "major", "minor", "nit"].indexOf(a.severity)
                  - ["critical", "major", "minor", "nit"].indexOf(b.severity));

  const fixReport = path.join(work, "fix-report.json");
  const brief = buildBrief({
    template: readFileSync(templatePath, "utf8"),
    state, round, findings: toFix, reportPath: fixReport,
  });
  const briefFile = path.join(work, "fixer.brief.md");
  writeAtomic(briefFile, brief);

  if (cfg.fixer.mode === "inherit" || !args.run) {
    emit({
      ok: true,
      mode: cfg.fixer.mode,
      ran: false,
      brief_file: briefFile,
      fix_report_path: fixReport,
      findings_to_fix: toFix.map((f) => ({ id: f.id, severity: f.severity, title: f.title, file: f.file })),
      note: cfg.fixer.mode === "inherit"
        ? "Режим inherit: примени правки сам по брифу, затем запиши отчёт в fix_report_path."
        : "Подготовлено. Передай --run, чтобы запустить подпроцесс.",
    });
    return;
  }

  const resumeId = cfg.fixer.continue_session ? (state.fixer_session_id ?? null) : null;
  const r = await runSubprocess(cfg, state, brief, work, resumeId);
  const report = readJson(fixReport);

  emit({
    ok: r.outcome === "ok",
    mode: "subprocess",
    ran: true,
    ...r,
    brief_file: briefFile,
    fix_report_path: fixReport,
    fix_report: report,
    fix_report_missing: r.outcome === "ok" && !report,
    model: cfg.fixer.model,
    effort: cfg.fixer.effort,
    at: nowIso(),
  });
}

main();
