// Fold one round's reviewer output into the running findings list.
//
// Everything the loop can detect later — oscillation, stuck rounds, disputes
// that need a human — depends on this file getting the state transitions right,
// so the transitions are explicit and tested rather than inferred at call sites.
//
//   echo '{"state":…,"results":[…],"round":N}' | node merge-findings.mjs
//   node merge-findings.mjs --self-test

import { emit, bail, parseArgs, readStdinJson, nowIso } from "./lib.mjs";

export const STATUSES = ["open", "fixed", "verified", "disputed", "wontfix", "advisory"];

const STOP_WORDS = new Set(["и","в","на","с","для","не","что","как","при","из","по","the","a","an","of","to","in","is","are"]);

function titleTokens(t) {
  return new Set(String(t).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/).filter((w) => w.length > 2 && !STOP_WORDS.has(w)));
}

/**
 * Two reviewers describing one defect produce two ids, because the id hashes
 * the title and their wording differs ("синхронный сетевой вызов" vs
 * "синхронный HTTP-вызов"). Exact hashing is right for tracking one reviewer
 * across rounds; it cannot see cross-reviewer synonyms.
 *
 * Flag the likely pairs instead of merging them. Silently collapsing two
 * findings in the same file is how a real second defect gets lost — and this
 * file legitimately had five separate findings.
 */
function flagDuplicates(findings) {
  const bare = (f) => String(f.file || "").split(":")[0].toLowerCase();
  for (let i = 0; i < findings.length; i++) {
    for (let j = i + 1; j < findings.length; j++) {
      const a = findings[i], b = findings[j];
      if (bare(a) !== bare(b) || !bare(a)) continue;
      // Same reviewer, same round → two genuinely different findings it listed
      // side by side. Same reviewer, DIFFERENT rounds → it rephrased itself
      // between rounds, the hash drifted, and the old id would hang open
      // forever waiting for a verification that now arrives under a new name.
      const sharedSource = (a.sources || []).some((s) => (b.sources || []).includes(s));
      const sameRound = (a.first_round ?? -1) === (b.first_round ?? -2);
      if (sharedSource && sameRound) continue;
      const ta = titleTokens(a.title), tb = titleTokens(b.title);
      const overlap = [...ta].filter((w) => tb.has(w)).length;
      const ratio = overlap / Math.max(1, Math.min(ta.size, tb.size));
      if (ratio >= 0.5 && overlap >= 2) {
        a.possible_duplicate_of = [...new Set([...(a.possible_duplicate_of || []), b.id])];
        b.possible_duplicate_of = [...new Set([...(b.possible_duplicate_of || []), a.id])];
      }
    }
  }
  return findings;
}

function isBlocking(f, blocking) {
  return blocking.includes(f.severity) && !f.out_of_scope && f.status === "open";
}

/**
 * @param prev    findings carried in state (may be empty)
 * @param results per-member parse results for this round
 */
export function merge(prev, results, round, blockingSeverities) {
  const incoming = new Map();
  for (const r of results) {
    if (r.outcome !== "ok") continue;
    for (const f of r.findings || []) {
      const existing = incoming.get(f.id);
      if (!existing) { incoming.set(f.id, { ...f, sources: [f.source] }); continue; }
      // Same defect seen by both reviewers: keep the harsher severity and
      // whichever description actually carries a mechanism.
      const worse = ["critical", "major", "minor", "nit"];
      const keepSeverity = worse.indexOf(f.severity) < worse.indexOf(existing.severity) ? f.severity : existing.severity;
      incoming.set(f.id, {
        ...existing,
        severity: keepSeverity,
        mechanism: existing.mechanism || f.mechanism,
        trigger: existing.trigger || f.trigger,
        consequence: existing.consequence || f.consequence,
        required: existing.required || f.required,
        proof: existing.proof || f.proof,
        sources: [...new Set([...existing.sources, f.source])],
      });
    }
  }

  const byId = new Map(prev.map((f) => [f.id, structuredClone(f)]));
  const events = [];

  for (const [id, f] of incoming) {
    const old = byId.get(id);
    if (!old) {
      byId.set(id, {
        ...f,
        status: f.out_of_scope || !blockingSeverities.includes(f.severity) ? "advisory" : "open",
        first_round: round,
        rounds_seen: [round],
        reopened_count: 0,
        dispute_rounds: 0,
        history: [{ round, actor: "reviewer", action: "raised", note: f.title, at: nowIso() }],
      });
      events.push({ id, event: "new", severity: f.severity });
      continue;
    }

    // Carry the fresh text — line numbers and wording drift as the code changes.
    Object.assign(old, {
      severity: f.severity, title: f.title, file: f.file,
      trigger: f.trigger || old.trigger,
      mechanism: f.mechanism || old.mechanism,
      consequence: f.consequence || old.consequence,
      required: f.required || old.required,
      proof: f.proof || old.proof,
      out_of_scope: f.out_of_scope,
      sources: [...new Set([...(old.sources || []), ...f.sources])],
    });
    old.rounds_seen = [...new Set([...(old.rounds_seen || []), round])];

    if (old.status === "fixed") {
      old.status = "open";
      old.reopened_count = (old.reopened_count || 0) + 1;
      old.history.push({ round, actor: "reviewer", action: "reopened", note: "правка не закрыла замечание", at: nowIso() });
      events.push({ id, event: "reopened", count: old.reopened_count });
    } else if (old.status === "verified") {
      old.status = "open";
      old.reopened_count = (old.reopened_count || 0) + 1;
      old.history.push({ round, actor: "reviewer", action: "regressed", note: "замечание вернулось после подтверждения", at: nowIso() });
      events.push({ id, event: "regressed", count: old.reopened_count });
    } else if (old.status === "disputed") {
      old.status = "open";
      old.dispute_rounds = (old.dispute_rounds || 0) + 1;
      old.history.push({ round, actor: "reviewer", action: "dispute_rejected", note: f.mechanism || f.title, at: nowIso() });
      events.push({ id, event: "dispute_rejected", rounds: old.dispute_rounds });
    } else if (old.status === "wontfix" || old.status === "advisory") {
      if (blockingSeverities.includes(f.severity) && !f.out_of_scope) {
        old.status = "open";
        old.history.push({ round, actor: "reviewer", action: "escalated", note: `severity поднят до ${f.severity}`, at: nowIso() });
        events.push({ id, event: "escalated" });
      }
    } else {
      old.history.push({ round, actor: "reviewer", action: "restated", at: nowIso() });
    }
  }

  // Findings the reviewer no longer raises.
  for (const [id, f] of byId) {
    if (incoming.has(id)) continue;
    if (f.status === "fixed") {
      f.status = "verified";
      f.history.push({ round, actor: "reviewer", action: "verified", at: nowIso() });
      events.push({ id, event: "verified" });
    } else if (f.status === "disputed") {
      f.status = "wontfix";
      f.history.push({ round, actor: "reviewer", action: "dispute_accepted", note: "ревьюер снял замечание", at: nowIso() });
      events.push({ id, event: "dispute_accepted" });
    }
    // An `open` finding that simply is not restated stays open: in a delta
    // review the reviewer never saw that code again, so silence is not proof.
  }

  const findings = flagDuplicates([...byId.values()]);
  const blocking = findings.filter((f) => isBlocking(f, blockingSeverities));

  return {
    findings,
    events,
    counts: {
      total: findings.length,
      open: findings.filter((f) => f.status === "open").length,
      blocking: blocking.length,
      fixed: findings.filter((f) => f.status === "fixed").length,
      verified: findings.filter((f) => f.status === "verified").length,
      disputed: findings.filter((f) => f.status === "disputed").length,
      advisory: findings.filter((f) => f.status === "advisory").length,
      wontfix: findings.filter((f) => f.status === "wontfix").length,
    },
    severity_counts: ["critical", "major", "minor", "nit"].reduce((acc, s) => {
      acc[s] = findings.filter((f) => f.severity === s && f.status === "open").length;
      return acc;
    }, {}),
    open_ids: findings.filter((f) => f.status === "open").map((f) => f.id).sort(),
    duplicate_pairs: findings.filter((f) => f.possible_duplicate_of?.length)
      .map((f) => ({ id: f.id, same_as: f.possible_duplicate_of })),
  };
}

// ------------------------------------------------------------- self-test ---

function selfTest() {
  const B = ["critical", "major"];
  const mk = (id, severity = "critical", extra = {}) => ({
    id, severity, title: `t-${id}`, file: "a.ts:1", source: extra.source ?? "tech-lead",
    mechanism: "m", out_of_scope: false, ...extra,
  });
  const res = (findings) => [{ outcome: "ok", source: "tech-lead", findings }];
  const checks = [];

  let s = merge([], res([mk("aaa"), mk("bbb", "nit")]), 1, B);
  checks.push(["новые: 1 blocking + 1 advisory", s.counts.blocking === 1 && s.counts.advisory === 1]);

  const fixed = s.findings.map((f) => (f.id === "aaa" ? { ...f, status: "fixed" } : f));
  let s2 = merge(fixed, res([]), 2, B);
  checks.push(["fixed без повтора → verified", s2.findings.find((f) => f.id === "aaa").status === "verified"]);

  let s3 = merge(fixed, res([mk("aaa")]), 2, B);
  const a = s3.findings.find((f) => f.id === "aaa");
  checks.push(["fixed с повтором → open + reopened", a.status === "open" && a.reopened_count === 1]);

  const disputed = s.findings.map((f) => (f.id === "aaa" ? { ...f, status: "disputed" } : f));
  let s4 = merge(disputed, res([mk("aaa")]), 2, B);
  checks.push(["спор отклонён → dispute_rounds=1", s4.findings.find((f) => f.id === "aaa").dispute_rounds === 1]);
  let s5 = merge(disputed, res([]), 2, B);
  checks.push(["спор принят → wontfix", s5.findings.find((f) => f.id === "aaa").status === "wontfix"]);

  const twoSources = [
    { outcome: "ok", source: "tech-lead", findings: [mk("ccc", "minor", { source: "tech-lead" })] },
    { outcome: "ok", source: "security", findings: [mk("ccc", "critical", { source: "security" })] },
  ];
  let s6 = merge([], twoSources, 1, B);
  const c = s6.findings.find((f) => f.id === "ccc");
  checks.push(["дедуп двух ревьюеров", s6.findings.length === 1 && c.severity === "critical" && c.sources.length === 2]);

  let s7 = merge([], res([mk("ddd", "critical", { out_of_scope: true })]), 1, B);
  checks.push(["out_of_scope → advisory", s7.findings[0].status === "advisory" && s7.counts.blocking === 0]);

  let s8 = merge(s.findings, res([]), 2, B);
  checks.push(["open без упоминания остаётся open", s8.findings.find((f) => f.id === "aaa").status === "open"]);

  const verified = s.findings.map((f) => (f.id === "aaa" ? { ...f, status: "verified" } : f));
  let s9 = merge(verified, res([mk("aaa")]), 3, B);
  checks.push(["verified вернулся → regressed", s9.events.some((e) => e.event === "regressed")]);

  const dupA = { ...mk("d1", "major"), title: "Синхронный сетевой вызов блокирует event loop API", file: "api/x.py:10", source: "tech-lead" };
  const dupB = { ...mk("d2", "major"), title: "Синхронный HTTP-вызов блокирует event loop API", file: "api/x.py:30", source: "security" };
  const dup = merge([], [
    { outcome: "ok", source: "tech-lead", findings: [dupA] },
    { outcome: "ok", source: "security", findings: [dupB] },
  ], 1, B);
  checks.push(["дубль между ревьюерами помечен", dup.duplicate_pairs.length === 2]);
  const distinct = merge([], [
    { outcome: "ok", source: "tech-lead", findings: [{ ...mk("x1"), title: "Гонка при создании бота", file: "api/x.py:1", source: "tech-lead" }] },
    { outcome: "ok", source: "security", findings: [{ ...mk("x2"), title: "Потеря конкурентных изменений options", file: "api/x.py:9", source: "security" }] },
  ], 1, B);
  checks.push(["разные дефекты в одном файле не слиты", distinct.duplicate_pairs.length === 0]);
  const sameReviewer = merge([], [{ outcome: "ok", source: "tech-lead", findings: [dupA, { ...dupB, source: "tech-lead" }] }], 1, B);
  checks.push(["один ревьюер дважды в одном раунде — не дубль", sameReviewer.duplicate_pairs.length === 0]);
  const rephrased = merge(
    [{ ...mk("r1", "minor"), title: "Кнопка видна пользователю без прав", file: "app/x.tsx:10",
       sources: ["tech-lead"], status: "open", first_round: 1, history: [], rounds_seen: [1] }],
    [{ outcome: "ok", source: "tech-lead", findings: [
      { ...mk("r2", "minor"), title: "Кнопка видна пользователю без прав управления", file: "app/x.tsx:20", source: "tech-lead" }] }],
    2, B);
  checks.push(["переформулировка между раундами — дубль", rephrased.duplicate_pairs.length === 2]);

  const failed = checks.filter(([, ok]) => !ok);
  emit({ ok: failed.length === 0, total: checks.length, failed: failed.map(([n]) => n) });
  process.exit(failed.length ? 1 : 0);
}

async function main() {
  if (parseArgs()["self-test"]) return selfTest();
  const input = await readStdinJson();
  for (const k of ["state", "results", "round"]) if (input[k] === undefined) bail("input_incomplete", { missing: k });
  const blocking = input.state.config?.loop?.blocking_severities || ["critical", "major"];
  emit({ ok: true, ...merge(input.state.findings || [], input.results, input.round, blocking) });
}

if (import.meta.url === `file://${process.argv[1]}`) main();
