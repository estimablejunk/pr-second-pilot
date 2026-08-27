// Короткий человеческий итог для отчёта: что в изменении сделано и что
// поправили по ходу ревью.
//
// Таблицы находок отвечают на вопрос «что нашли», но не на вопрос «что в
// итоге получилось». Второй и есть тот, ради которого отчёт открывают через
// неделю — и восстанавливать ответ по пятнадцати карточкам с историями
// никто не станет.
//
// Черновик собирается механически из ledger'а: заголовки закрытых замечаний
// и правки, которыми их закрыли. Оркестратор переписывает его человеческим
// языком и сохраняет обратно — в этом и смысл разделения.
//
//   node summarize.mjs --state <path> --draft          черновик из ledger
//   node summarize.mjs --state <path> --text "..."     сохранить итог
//   echo "..." | node summarize.mjs --state <path>     то же со stdin

import {
  emit, bail, parseArgs, readJson, writeJsonAtomic, readStdin, nowIso,
} from "./lib.mjs";

/** Последнее, что исполнитель сделал с замечанием, — по его же истории. */
function lastFixerAction(f) {
  return [...(f.history || [])].reverse().find((h) => h.actor === "fixer") ?? null;
}

function buildDraft(state) {
  const findings = state.findings || [];
  const closed = findings.filter((f) => f.status === "verified");
  const refused = findings.filter((f) => f.status === "wontfix");
  const advisory = findings.filter((f) => f.status === "advisory");
  const open = findings.filter((f) => f.status === "open" || f.status === "fixed");

  const line = (f) => {
    const act = lastFixerAction(f);
    return {
      id: f.id,
      severity: f.severity,
      title: f.title,
      file: (f.file || "").split(":")[0] || null,
      // Механизм отказа — то, ради чего правка делалась; в итоге он важнее
      // формулировки замечания.
      mechanism: f.mechanism || null,
      fix: act?.note || null,
      edit: act?.edit || null,
      reason: f.status === "wontfix" ? (act?.note || null) : null,
    };
  };

  const rounds = (state.rounds_log || []).length;
  const files = new Set();
  for (const f of findings) {
    const act = lastFixerAction(f);
    for (const m of String(act?.edit || "").matchAll(/[\w./-]+\.(?:py|tsx?|jsx?|json|md|ya?ml)/g)) {
      files.add(m[0]);
    }
  }

  return {
    target: state.target?.title || state.target?.slug || null,
    rounds,
    merged: !!state.merge?.merged,
    closed: closed.map(line),
    refused: refused.map(line),
    advisory: advisory.map(line),
    still_open: open.map(line),
    touched_files: [...files].sort(),
  };
}

function main() {
  const args = parseArgs();
  if (!args.state) bail("arg_missing", { missing: "--state" });
  const state = readJson(args.state);
  if (!state) bail("state_unreadable", { path: args.state });

  if (args.draft) {
    emit({ ok: true, draft: buildDraft(state), existing: state.summary?.text ?? null });
    return;
  }

  const text = typeof args.text === "string" ? args.text : null;
  if (text !== null) return save(state, args.state, text);

  readStdin().then((raw) => {
    if (!raw.trim()) {
      emit({
        ok: false, error: "empty_summary",
        detail: "Нечего сохранять. Передай --text, подай текст на stdin или возьми --draft.",
      });
      return;
    }
    save(state, args.state, raw.trim());
  });
}

function save(state, statePath, text) {
  state.summary = { text, at: nowIso(), round: state.round ?? null };
  writeJsonAtomic(statePath, state);
  emit({
    ok: true,
    saved: true,
    chars: text.length,
    lines: text.split("\n").length,
    // Длинный итог перестаёт быть итогом; называем это вслух, а не режем молча.
    too_long: text.length > 2500 ? "Больше 2500 символов — это уже не краткий итог." : null,
  });
}

main();
