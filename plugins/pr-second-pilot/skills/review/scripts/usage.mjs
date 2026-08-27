// What a review actually cost, and how much of the plan is left.
//
// Codex writes a rollout log per thread under ~/.codex/sessions/, and every
// turn appends a token_count event carrying both the running token totals and
// the live rate_limits snapshot. That is the only place the real price of a run
// is visible — `codex exec` itself prints a verdict and nothing else.
//
// Without this the loop is flying blind: on a subscription a single review can
// eat a fifth of the five-hour window, and you find out by hitting the wall
// three rounds later.
//
//   node usage.mjs --session <thread-id>     цена одного прогона
//   node usage.mjs --since <ISO|HH:MM>       сводка за период
//   node usage.mjs --limits                  только остаток лимитов

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { emit, parseArgs, HOME } from "./lib.mjs";

const SESSIONS = path.join(HOME, ".codex", "sessions");

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.name.endsWith(".jsonl") && entry.name.startsWith("rollout-")) out.push(p);
  }
  return out;
}

/**
 * Last token_count event of a rollout — it carries the running totals.
 *
 * `since` существует из-за переиспользования тредов: возобновлённый прогон
 * дописывает в ТОТ ЖЕ файл, и подсчёт по всему файлу даёт сумму нескольких
 * раундов. На живом прогоне раунд из четырёх ходов отчитался двадцатью одним —
 * своими четырьмя плюс семнадцатью предыдущего.
 */
function readRollout(file, since = null) {
  let first = null, last = null, turns = 0;
  let text;
  try { text = readFileSync(file, "utf8"); } catch { return null; }
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const p = d.payload;
    if (p?.type !== "token_count" || !p.info) continue;
    if (since && d.timestamp && d.timestamp < since) continue;
    turns += 1;
    last = { info: p.info, limits: p.rate_limits ?? null, at: d.timestamp };
    if (!first && p.rate_limits?.primary) first = p.rate_limits.primary.used_percent;
  }
  if (!last) return null;
  const u = last.info.total_token_usage ?? {};
  const after = last.limits?.primary?.used_percent ?? null;
  return {
    file: path.basename(file),
    thread_id: path.basename(file).replace(/^rollout-[\dT-]+-/, "").replace(/\.jsonl$/, ""),
    at: last.at,
    turns,
    input_tokens: u.input_tokens ?? 0,
    cached_input_tokens: u.cached_input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    reasoning_tokens: u.reasoning_output_tokens ?? 0,
    total_tokens: u.total_tokens ?? 0,
    // Wrapping past 100 means the window reset mid-run; count only what is real.
    window_before: first,
    window_after: after,
    window_spent: first !== null && after !== null
      ? Number((after >= first ? after - first : after).toFixed(1))
      : null,
    limits: last.limits,
  };
}

function describeLimits(limits) {
  if (!limits) return null;
  const fmt = (w) => w ? {
    used_percent: w.used_percent,
    window_hours: Math.round((w.window_minutes ?? 0) / 60),
    resets_at: w.resets_at ? new Date(w.resets_at * 1000).toISOString() : null,
  } : null;
  return {
    plan: limits.plan_type ?? null,
    short_window: fmt(limits.primary),
    long_window: fmt(limits.secondary),
    credits: limits.credits?.balance ?? null,
  };
}

function parseSince(raw) {
  if (!raw) return null;
  if (/^\d{1,2}:\d{2}$/.test(raw)) {
    const [h, m] = raw.split(":").map(Number);
    const d = new Date();
    d.setHours(h, m, 0, 0);
    // «20:00» в час ночи означает вчерашние 20:00, а не сегодняшние: иначе
    // граница уезжает в будущее и сводка выходит пустой.
    if (d.getTime() > Date.now()) d.setDate(d.getDate() - 1);
    return d;
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function main() {
  const args = parseArgs();
  const files = walk(SESSIONS);

  if (args.session) {
    const hit = files.find((f) => f.includes(String(args.session)));
    if (!hit) { emit({ ok: false, error: "session_not_found", session: args.session }); return; }
    const r = readRollout(hit, args.since || null);
    if (!r) { emit({ ok: false, error: "no_token_events", file: hit }); return; }
    emit({ ok: true, ...r, limits: describeLimits(r.limits) });
    return;
  }

  const since = parseSince(args.since) ?? new Date(Date.now() - 12 * 3600_000);
  const runs = [];
  for (const f of files) {
    let mt;
    try { mt = statSync(f).mtime; } catch { continue; }
    if (mt < since) continue;
    const r = readRollout(f);
    // Fewer than a handful of turns is a probe, not a review.
    if (r && r.turns > 5) runs.push(r);
  }
  runs.sort((a, b) => String(a.at).localeCompare(String(b.at)));

  // Прогон, оборвавшийся на лимите, снимка лимитов не содержит — берём
  // последний, у которого он есть, иначе сводка молчит именно тогда, когда
  // она нужнее всего.
  const latest = [...runs].reverse().find((r) => r.limits?.primary) ?? runs.at(-1);
  const spent = runs.map((r) => r.window_spent).filter((x) => x !== null);

  if (args.limits) {
    emit({ ok: true, limits: describeLimits(latest?.limits ?? null), sampled_at: latest?.at ?? null });
    return;
  }

  emit({
    ok: true,
    since: since.toISOString(),
    runs: runs.map((r) => ({
      at: r.at, turns: r.turns, total_tokens: r.total_tokens,
      window_spent_percent: r.window_spent,
    })),
    totals: {
      runs: runs.length,
      tokens: runs.reduce((a, r) => a + r.total_tokens, 0),
      // Cached input still counts toward the plan; it is cheaper, not free.
      cached_share: runs.length
        ? Number((runs.reduce((a, r) => a + r.cached_input_tokens, 0) /
            Math.max(1, runs.reduce((a, r) => a + r.input_tokens, 0)) * 100).toFixed(1))
        : null,
      avg_window_percent_per_run: spent.length
        ? Number((spent.reduce((a, b) => a + b, 0) / spent.length).toFixed(1))
        : null,
      runs_left_in_window: spent.length && latest?.limits?.primary
        ? Math.floor((100 - latest.limits.primary.used_percent) /
            Math.max(0.1, spent.reduce((a, b) => a + b, 0) / spent.length))
        : null,
    },
    limits: describeLimits(latest?.limits ?? null),
  });
}

main();
