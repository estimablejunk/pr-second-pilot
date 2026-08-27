// Закрыть раунд целиком: свести находки → решить об остановке → записать
// состояние → перерисовать отчёт → оповестить.
//
// Существует потому, что закрывать раунд по шагам вручную оказалось делом,
// которое забывают. За один прогон отчёт PR отстал на два раунда: ревью шло,
// правки уезжали в PR, а PR/417.md показывал позавчерашнюю картину — потому
// что вызовы merge-findings/commit-round/render-report просто не были
// сделаны. SKILL.md требует фиксировать раунд всегда; одна команда вместо
// пяти делает это требование исполнимым.
//
//   node finish-round.mjs --state <path> --round N --review <review.json> \
//     [--gate <gate.json>] [--reviewed-sha <sha>] [--session <id>] [--no-notify]

import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { emit, bail, parseArgs, readJson } from "./lib.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));

function runScript(name, { args = [], stdin } = {}) {
  const r = spawnSync(process.execPath, [path.join(DIR, name), ...args], {
    input: stdin, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  try { return { ok: true, data: JSON.parse(r.stdout) }; }
  catch {
    return { ok: false, detail: (r.stderr || r.stdout || "").trim().slice(0, 600), code: r.status };
  }
}

async function main() {
  const args = parseArgs();
  for (const k of ["state", "round", "review"]) {
    if (!args[k]) bail("arg_missing", { missing: `--${k}` });
  }
  const statePath = args.state;
  const round = Number(args.round);
  const state = readJson(statePath);
  if (!state) bail("state_unreadable", { path: statePath });
  const review = readJson(args.review);
  if (!review) bail("review_unreadable", { path: args.review });
  const gate = args.gate ? readJson(args.gate) : state.gate;

  const steps = [];

  // 1. свести находки — но только если этот раунд ещё не сведён.
  //
  // Повторное сведение того же вердикта разрушительно: замечания, которые
  // исполнитель уже пометил исправленными, встречаются во входящих результатах
  // снова, и переходы merge-findings честно переводят их fixed → open с
  // reopened_count++. На живом прогоне это выглядело как `raised → fixed →
  // reopened` и делало исправления невидимыми.
  //
  // Порядок фаз это предотвращает (сведение идёт до правок), но полагаться
  // только на порядок нельзя: повторный вызов после сбоя, ручная отладка или
  // будущая правка SKILL.md вернут проблему молча.
  const alreadyCommitted = (state.round ?? 0) >= round;
  let m;
  if (alreadyCommitted) {
    m = {
      findings: state.findings || [],
      counts: state.counts || {},
      open_ids: (state.counts?.open_ids) || [],
      severity_counts: state.counts?.severity_counts || {},
      duplicate_pairs: [],
    };
    steps.push({ step: "merge", skipped: "round_already_merged", state_round: state.round });
  } else {
    const merged = runScript("merge-findings.mjs", {
      stdin: JSON.stringify({ state, results: review.results ?? [], round }),
    });
    if (!merged.ok || !merged.data.ok) {
      emit({ ok: false, error: "merge_failed", detail: merged.detail ?? merged.data });
      return;
    }
    m = merged.data;
    steps.push({ step: "merge", counts: m.counts, duplicates: m.duplicate_pairs?.length ?? 0 });
  }

  // 2. решение об остановке
  const cfg = state.config ?? {};
  const stop = runScript("evaluate-stop.mjs", {
    stdin: JSON.stringify({
      round,
      review,
      counts: { ...m.counts, open_ids: m.open_ids },
      findings: m.findings,
      history: state.history ?? [],
      max_rounds: cfg.loop?.max_rounds ?? 4,
      hard_cap: cfg.loop?.hard_cap ?? 8,
      dispute_rounds_before_escalation: cfg.loop?.dispute_rounds_before_escalation ?? 2,
      gate,
      fell_back_to_fresh: (review.results ?? []).some((r) => r.fell_back_to_fresh),
      prev_blocking: state.prev_blocking ?? null,
    }),
  });
  if (!stop.ok) { emit({ ok: false, error: "evaluate_failed", detail: stop.detail }); return; }
  const decision = stop.data;
  steps.push({ step: "evaluate", action: decision.action, status: decision.status, reason: decision.reason });

  // 3. записать состояние. Треды берём из ответа ревьюера, а не из рук
  //    оркестратора: именно на этом шаге они терялись, и каждый следующий
  //    раунд стартовал с холодного треда без единого попадания в кэш.
  const threads = {};
  for (const r of review.results ?? []) {
    if (r.member && r.thread_id) threads[r.member] = r.thread_id;
  }
  const verdicts = (review.results ?? []).map((r) => r.verdict).filter(Boolean);
  const commit = runScript("commit-round.mjs", {
    stdin: JSON.stringify({
      state_path: statePath,
      round,
      findings: m.findings,
      counts: { ...m.counts, severity_counts: m.severity_counts, open_ids: m.open_ids },
      gate,
      status: decision.action === "continue" ? "fixing" : decision.status,
      stop: decision,
      verdict: verdicts.includes("BLOCK") ? "BLOCK" : (verdicts[0] ?? null),
      panel: (review.results ?? []).map((r) => r.member),
      threads: Object.keys(threads).length ? threads : undefined,
      usage: review.usage ?? null,
      reviewed_sha: args["reviewed-sha"] || undefined,
      human_questions: decision.questions ?? undefined,
      lock: args.session && state.paths?.lock
        ? { path: state.paths.lock, session: args.session } : undefined,
    }),
  });
  if (!commit.ok) { emit({ ok: false, error: "commit_failed", detail: commit.detail }); return; }
  if (!commit.data.ok) {
    // round_already_committed — не беда: раунд закрыт, отчёт всё равно рисуем.
    steps.push({ step: "commit", skipped: commit.data.error });
  } else {
    steps.push({ step: "commit", round: commit.data.round, reviewed_sha: commit.data.reviewed_sha });
  }

  // 4. отчёт — всегда, даже если запись состояния была пропущена
  const render = runScript("render-report.mjs", { args: ["--state", statePath] });
  if (!render.ok) { emit({ ok: false, error: "render_failed", detail: render.detail }); return; }
  steps.push({ step: "render", report: render.data.report, human_answers: render.data.human_answers });

  // 5. оповещение — только на терминальных исходах
  let notified = null;
  if (!args["no-notify"] && decision.action === "break") {
    const n = runScript("notify.mjs", { args: ["--event", decision.status, "--state", statePath] });
    notified = n.ok ? (n.data.skipped ?? n.data.ok) : "ошибка оповещения";
  }

  emit({
    ok: true,
    round,
    action: decision.action,
    status: decision.status,
    counts: m.counts,
    report: render.data.report,
    human_answers: render.data.human_answers,
    threads_persisted: Object.keys(threads),
    notified,
    steps,
  });
}

main();
