// Записать в состояние, что исполнитель сделал с каждым замечанием.
//
// Вторая половина бухгалтерии раунда. Без неё замечание не получает статус
// `fixed`, а значит никогда не станет `verified`: переход в merge-findings идёт
// только из `fixed`, потому что молчание ревьюера при ревью дельты
// доказательством не является. На живом прогоне два исправленных и
// подтверждённых замечания так и остались висеть открытыми — правки уехали в
// PR, ревьюер их принял, а отчёт показывал блокеры.
//
// SKILL.md предписывал делать это вручную; ручной шаг и был пропущен.
//
//   node apply-fix-report.mjs --state <path> --round N --report <fix-report.json>
//   echo '{"entries":[...]}' | node apply-fix-report.mjs --state <path> --round N

import {
  emit, bail, parseArgs, readJson, writeJsonAtomic, readStdin, nowIso,
} from "./lib.mjs";

const ACTIONS = {
  // Заявлено исправленным — ждёт подтверждения ревьюером.
  fixed: "fixed",
  // Исполнитель не согласен: ревьюер обязан ответить в следующем раунде.
  disputed: "disputed",
  // Решение не его — остаётся открытым, вопрос уходит человеку.
  deferred: "open",
  // Осознанный отказ с обоснованием.
  wontfix: "wontfix",
  // Частично: закрыта только часть, замечание остаётся открытым.
  partial: "open",
};

async function main() {
  const args = parseArgs();
  for (const k of ["state", "round"]) if (!args[k]) bail("arg_missing", { missing: `--${k}` });
  const statePath = args.state;
  const round = Number(args.round);

  const state = readJson(statePath);
  if (!state) bail("state_unreadable", { path: statePath });

  let report = args.report ? readJson(args.report) : null;
  if (!report) {
    const raw = await readStdin();
    if (raw.trim()) { try { report = JSON.parse(raw); } catch (e) { bail("stdin_invalid_json", { detail: String(e) }); } }
  }
  if (!report?.entries?.length) {
    emit({ ok: false, error: "empty_report", detail: "нет ни одной записи — все замечания останутся открытыми" });
    return;
  }

  const byId = new Map((state.findings || []).map((f) => [f.id, f]));
  const applied = [], unknown = [], at = nowIso();

  for (const e of report.entries) {
    const f = byId.get(e.id);
    if (!f) { unknown.push(e.id); continue; }
    const status = ACTIONS[e.action];
    if (!status) { unknown.push(`${e.id}:${e.action}`); continue; }

    f.status = status;
    f.history = f.history || [];
    f.history.push({
      round, actor: "fixer", action: e.action,
      note: e.note ?? null, edit: e.edit ?? null,
      proof: e.proof ?? null, evidence: e.evidence ?? null, at,
    });
    if (e.action === "deferred" && e.note) {
      state.human_questions = [...(state.human_questions || []),
        { round, finding: e.id, question: e.note }];
    }
    applied.push({ id: e.id, action: e.action, status });
  }

  // Замечание, о котором исполнитель промолчал, остаётся открытым — и это надо
  // назвать вслух, иначе пропуск выглядит как выполненная работа.
  const untouched = (state.findings || [])
    .filter((f) => f.status === "open" && !applied.some((a) => a.id === f.id))
    .map((f) => ({ id: f.id, severity: f.severity, title: f.title }));

  // Пересчитать счётчики. Без этого состояние расходится само с собой:
  // findings говорят «открытых нет», а counts.blocking остаётся от прошлого
  // раунда — и движок правил мержа, который читает именно counts, запрещает
  // мерж по замечаниям, которых уже нет.
  const blockingSeverities = state.config?.loop?.blocking_severities ?? ["critical", "major"];
  const all = state.findings || [];
  const by = (st) => all.filter((f) => f.status === st).length;
  state.counts = {
    total: all.length,
    open: by("open"),
    blocking: all.filter((f) => f.status === "open" && !f.out_of_scope
      && blockingSeverities.includes(f.severity)).length,
    fixed: by("fixed"),
    verified: by("verified"),
    disputed: by("disputed"),
    advisory: by("advisory"),
    wontfix: by("wontfix"),
    severity_counts: ["critical", "major", "minor", "nit"].reduce((acc, sev) => {
      acc[sev] = all.filter((f) => f.severity === sev && f.status === "open").length;
      return acc;
    }, {}),
    open_ids: all.filter((f) => f.status === "open").map((f) => f.id).sort(),
  };
  state.updated_at = at;
  writeJsonAtomic(statePath, state);

  emit({
    ok: true,
    round,
    applied,
    unknown_ids: unknown,
    untouched,
    counts: state.counts,
    applied_counts: {
      fixed: applied.filter((a) => a.status === "fixed").length,
      disputed: applied.filter((a) => a.status === "disputed").length,
      still_open: untouched.length,
    },
  });
}

main();
