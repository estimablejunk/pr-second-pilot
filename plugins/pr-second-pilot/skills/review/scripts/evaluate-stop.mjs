// Decide whether the loop continues. Pure function, no model involved.
//
// Severity arithmetic and set comparisons between rounds are exactly the kind
// of bookkeeping a language model gets subtly wrong, and a wrong answer here
// either merges unreviewed code or spins the loop until the quota is gone.
//
//   echo '{…}' | node evaluate-stop.mjs
//   node evaluate-stop.mjs --self-test

import { emit, bail, parseArgs, readStdinJson } from "./lib.mjs";

/**
 * Branch order is the contract — earlier branches win. Anything that needs a
 * human outranks anything that looks like progress.
 */
export function evaluate(input) {
  const {
    round, review, counts, findings = [], history = [],
    max_rounds, hard_cap = 8, dispute_rounds_before_escalation = 2,
    gate, fell_back_to_fresh = false, prev_blocking = null,
  } = input;

  const stop = (status, reason, human_note = null, extra = {}) =>
    ({ action: "break", status, reason, human_note, ...extra });

  // --- infrastructure outcomes -------------------------------------------
  if (review?.outcome === "rate_limited") {
    return stop("rate_limited",
      "лимит подписки исчерпан",
      `Ревьюер упёрся в лимит плана ChatGPT${review.reset_hint ? ` (сброс: ${review.reset_hint})` : ""}. ` +
      `Состояние сохранено — продолжи через /pr-second-pilot:resume, когда окно откроется.`,
      { resumable: true, reset_hint: review.reset_hint ?? null });
  }
  if (review?.outcome === "auth_failed") {
    return stop("failed", "codex не авторизован", "Выполни `codex login` и повтори.", { resumable: true });
  }
  if (review?.outcome === "codex_missing") {
    return stop("failed", "codex CLI не найден", "npm install -g @openai/codex", { resumable: true });
  }
  if (review?.outcome === "timeout") {
    return stop("failed", "ревьюер не уложился в таймаут",
      "Увеличь reviewer.timeout_minutes или понизь reviewer.effort.", { resumable: true });
  }
  if (review && !["ok", "malformed"].includes(review.outcome)) {
    return stop("failed", `ревьюер вернул ${review.outcome}`, review.detail ?? null, { resumable: true });
  }
  if (review?.outcome === "malformed") {
    return stop("failed", "вердикт не соответствует контракту",
      "Ревьюер не выдал распознаваемую строку вердикта даже после повтора. Посмотри сырой ответ в рабочей папке раунда.");
  }

  // --- human decisions ----------------------------------------------------
  const asking = (review?.results || []).filter((r) => r.verdict === "NEEDS_HUMAN");
  if (asking.length) {
    return stop("needs_human", "ревьюер не вправе решить сам",
      asking.map((r) => `${r.member}: ${r.question}`).join("\n"),
      { questions: asking.map((r) => ({ member: r.member, question: r.question })) });
  }

  const stuckDisputes = findings.filter((f) => (f.dispute_rounds || 0) >= dispute_rounds_before_escalation);
  if (stuckDisputes.length) {
    return stop("needs_human", "спор не сходится",
      `Ревьюер и исполнитель не договорились за ${dispute_rounds_before_escalation} круга по: ` +
      stuckDisputes.map((f) => `[${f.id}] ${f.title}`).join("; ") + ". Нужно твоё решение.",
      { disputes: stuckDisputes.map((f) => ({ id: f.id, title: f.title, file: f.file })) });
  }

  // --- gate ---------------------------------------------------------------
  // A red gate never allows a merge, even if the reviewer had nothing to say.
  if (gate && gate.ok === false && counts.blocking === 0) {
    return { action: "continue", status: "continue", reason: "gate_failed", human_note: null };
  }

  // --- converged ----------------------------------------------------------
  if (counts.blocking === 0) {
    const advisory = findings.filter((f) => f.status === "advisory" || (f.status === "open" && !f.blocking));
    return stop(
      advisory.length ? "allowed_with_advisory" : "allowed",
      advisory.length ? "блокеров нет, остались необязательные замечания" : "блокеров нет",
      null,
      { advisory_count: advisory.length });
  }

  // --- not converging -----------------------------------------------------
  const oscillating = findings.filter((f) => (f.reopened_count || 0) >= 2);
  if (oscillating.length) {
    return stop("oscillating", "замечание открывается повторно",
      `Не сходится: ${oscillating.map((f) => `[${f.id}] ${f.title} (открывалось ${f.reopened_count + 1} раза)`).join("; ")}. ` +
      `Обычно это значит, что требование сформулировано неоднозначно — реши сам, что именно должно получиться.`,
      { ids: oscillating.map((f) => f.id) });
  }

  const openKey = [...counts.open_ids].sort().join(",");
  const prevKey = history.length ? [...history.at(-1)].sort().join(",") : null;
  if (prevKey !== null && openKey === prevKey && openKey !== "") {
    return stop("stuck", "набор замечаний не изменился за раунд",
      `После правок ревьюер видит ровно тот же список из ${counts.open_ids.length} замечаний. ` +
      `Исполнитель не продвинулся — вмешайся.`);
  }

  if (prev_blocking !== null && counts.blocking > prev_blocking) {
    if (fell_back_to_fresh) {
      return { action: "continue", status: "continue", reason: "regression_suppressed_fresh_thread",
        human_note: `Блокеров стало больше (${prev_blocking} → ${counts.blocking}), но ревьюер шёл в свежем треде — более дотошный проход это не регресс.` };
    }
    return stop("regressed", "блокеров стало больше",
      `Было ${prev_blocking}, стало ${counts.blocking}. Либо правки сломали что-то ещё, либо ревьюер поднял планку. Посмотри дифф раунда.`);
  }

  // --- budget -------------------------------------------------------------
  const cap = Math.min(max_rounds, hard_cap);
  if (round >= cap) {
    return stop("max_rounds", "исчерпан бюджет раундов",
      `Раундов: ${round} из ${cap}. Осталось блокеров: ${counts.blocking}. ` +
      `Продли лимит (loop.max_rounds, потолок ${hard_cap}) или доводи руками.`,
      { blocking: counts.blocking });
  }

  return { action: "continue", status: "continue", reason: "blocking_findings_remain", human_note: null };
}

// ------------------------------------------------------------- self-test ---

function selfTest() {
  const base = {
    round: 1, max_rounds: 4, hard_cap: 8, dispute_rounds_before_escalation: 2,
    review: { outcome: "ok", results: [{ verdict: "BLOCK" }] },
    counts: { blocking: 1, open: 1, open_ids: ["aaa"] },
    findings: [{ id: "aaa", title: "t", status: "open", reopened_count: 0, dispute_rounds: 0 }],
    history: [], gate: { ok: true },
  };
  const c = [];
  const ev = (over) => evaluate({ ...base, ...over });

  c.push(["блокеры есть → continue", ev({}).action === "continue"]);
  c.push(["нет блокеров → allowed", ev({ counts: { blocking: 0, open: 0, open_ids: [] }, findings: [] }).status === "allowed"]);
  c.push(["rate limit → resumable", ev({ review: { outcome: "rate_limited", reset_hint: "2 часа" } }).status === "rate_limited"]);
  c.push(["rate limit бьёт всё", ev({ review: { outcome: "rate_limited" }, counts: { blocking: 0, open: 0, open_ids: [] } }).status === "rate_limited"]);
  c.push(["NEEDS_HUMAN", ev({ review: { outcome: "ok", results: [{ verdict: "NEEDS_HUMAN", member: "tech-lead", question: "ломать ли v1?" }] } }).status === "needs_human"]);
  c.push(["спор эскалируется", ev({ findings: [{ id: "aaa", title: "t", status: "open", dispute_rounds: 2 }] }).status === "needs_human"]);
  c.push(["осцилляция", ev({ findings: [{ id: "aaa", title: "t", status: "open", reopened_count: 2 }] }).status === "oscillating"]);
  c.push(["застой", ev({ history: [["aaa"]] }).status === "stuck"]);
  c.push(["не застой при другом наборе", ev({ history: [["bbb"]] }).action === "continue"]);
  c.push(["регресс", ev({ prev_blocking: 0, history: [["zzz"]] }).status === "regressed"]);
  c.push(["регресс подавлен на свежем треде", ev({ prev_blocking: 0, history: [["zzz"]], fell_back_to_fresh: true }).action === "continue"]);
  c.push(["бюджет", ev({ round: 4 }).status === "max_rounds"]);
  c.push(["hard_cap режет max_rounds", ev({ round: 3, max_rounds: 99, hard_cap: 3 }).status === "max_rounds"]);
  c.push(["красный gate не даёт allowed", ev({ counts: { blocking: 0, open: 0, open_ids: [] }, findings: [], gate: { ok: false } }).action === "continue"]);
  c.push(["malformed → failed", ev({ review: { outcome: "malformed" } }).status === "failed"]);
  c.push(["needs_human важнее осцилляции", ev({
    review: { outcome: "ok", results: [{ verdict: "NEEDS_HUMAN", member: "m", question: "q" }] },
    findings: [{ id: "aaa", status: "open", reopened_count: 5 }],
  }).status === "needs_human"]);
  c.push(["advisory-остаток отмечен", ev({
    counts: { blocking: 0, open: 0, open_ids: [] },
    findings: [{ id: "n", status: "advisory" }],
  }).status === "allowed_with_advisory"]);

  const failed = c.filter(([, ok]) => !ok);
  emit({ ok: failed.length === 0, total: c.length, failed: failed.map(([n]) => n) });
  process.exit(failed.length ? 1 : 0);
}

async function main() {
  if (parseArgs()["self-test"]) return selfTest();
  const input = await readStdinJson();
  if (!input.counts) bail("input_incomplete", { missing: "counts" });
  emit({ ok: true, ...evaluate(input) });
}

if (import.meta.url === `file://${process.argv[1]}`) main();
