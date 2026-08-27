// Atomic end-of-round bookkeeping. One write, one place.
//
// Every field updated here was, at some point in a hand-rolled loop, updated
// in the wrong order or twice. Doing it in one guarded script means the
// orchestrator cannot get it wrong by misreading an instruction.
//
//   echo '{…}' | node commit-round.mjs

import { spawnSync } from "node:child_process";
import * as fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { emit, bail, readStdinJson, readJson, writeJsonAtomic, nowIso, git } from "./lib.mjs";

const HISTORY_WINDOW = 3;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function refreshLock(lockPath, session) {
  const r = spawnSync(process.execPath, [
    path.join(SCRIPT_DIR, "lock.mjs"), "--refresh", "--lock", lockPath, "--session", session,
  ], { encoding: "utf8" });
  try { return JSON.parse(r.stdout); } catch { return { ok: false, error: "lock_script_failed" }; }
}


// ------------------------------------------------------------- self-test ---
// Regression guard for the bug a real run exposed: reviewed_sha must be the
// SHA the reviewer judged, never the local checkout's HEAD.

function selfTest() {
  const { mkdtempSync, writeFileSync, readFileSync } = fsSync;
  const dir = mkdtempSync(path.join(os.tmpdir(), "psp-commit-"));
  const results = [];
  const check = (name, ok) => results.push([name, ok]);

  const base = {
    round: 0, repo_root: dir, history: [], rounds_log: [], findings: [],
    target: { kind: "pr", number: 9, head_sha: "prhead0000000000" },
  };
  const write = (o) => {
    const f = path.join(dir, `state-${results.length}.json`);
    writeFileSync(f, JSON.stringify(o));
    return f;
  };
  const commit = (state, input) => {
    const f = write(state);
    const r = spawnSync(process.execPath, [new URL(import.meta.url).pathname], {
      input: JSON.stringify({ state_path: f, round: input.round ?? 1, ...input }), encoding: "utf8",
    });
    return { out: JSON.parse(r.stdout), state: JSON.parse(readFileSync(f, "utf8")) };
  };

  const pr = commit(base, {});
  check("PR: reviewed_sha = голова PR, а не локальный HEAD", pr.state.reviewed_sha === "prhead0000000000");

  const explicit = commit(base, { reviewed_sha: "explicit111111" });
  check("явный reviewed_sha уважается", explicit.state.reviewed_sha === "explicit111111");

  const branch = commit({ ...base, target: { kind: "branch", head_sha: "prhead0000000000" } }, {});
  check("ветка: НЕ берёт head_sha цели, а спрашивает git", branch.state.reviewed_sha !== "prhead0000000000");

  const twice = commit({ ...base, round: 1 }, {});
  check("повторный коммит того же раунда отбит", twice.out.error === "round_already_committed");

  const ahead = commit(base, { round: 3 });
  check("раунд не по порядку отбит", ahead.out.error === "round_out_of_sequence");

  const noVerdict = commit({ ...base, prev_blocking: null }, { counts: { blocking: 0 }, verdict: null });
  check("раунд без вердикта не задаёт базу регресса", noVerdict.state.prev_blocking === null);
  const withVerdict = commit({ ...base, prev_blocking: null }, { counts: { blocking: 4 }, verdict: "BLOCK" });
  check("раунд с вердиктом базу задаёт", withVerdict.state.prev_blocking === 4);

  const hist = commit({ ...base, history: [["a"], ["b"], ["c"]] }, { counts: { open_ids: ["d"] } });
  check("окно истории обрезано до 3", hist.state.history.length === 3 && hist.state.history.at(-1)[0] === "d");

  const failed = results.filter(([, ok]) => !ok);
  emit({ ok: failed.length === 0, total: results.length, failed: failed.map(([n]) => n) });
  process.exit(failed.length ? 1 : 0);
}

async function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  const input = await readStdinJson();
  for (const k of ["state_path", "round"]) if (input[k] === undefined) bail("input_incomplete", { missing: k });

  const state = readJson(input.state_path);
  if (!state) bail("state_unreadable", { path: input.state_path });

  // Idempotency: a retried commit must not push history twice.
  if (state.round >= input.round) {
    emit({ ok: false, error: "round_already_committed", state_round: state.round, requested: input.round });
    return;
  }
  if (state.round !== input.round - 1) {
    emit({ ok: false, error: "round_out_of_sequence", state_round: state.round, requested: input.round });
    return;
  }

  // The lock is refreshed BEFORE the state write: if another session took over,
  // we must not commit at all.
  if (input.lock?.path && input.lock?.session) {
    const lock = refreshLock(input.lock.path, input.lock.session);
    if (!lock.ok) {
      emit({ ok: false, error: "lock_refresh_failed", detail: lock.error ?? lock.detail ?? null });
      return;
    }
  }

  const next = { ...state };
  next.round = input.round;
  next.updated_at = nowIso();

  if (input.findings) next.findings = input.findings;
  if (input.counts) next.counts = input.counts;
  if (input.gate !== undefined) next.gate = input.gate;
  if (input.status) next.status = input.status;
  if (input.stop) next.last_stop = input.stop;
  if (input.human_questions) {
    next.human_questions = [...(state.human_questions || []), ...input.human_questions];
  }

  // reviewed_sha is what "delta" means next round, and what the merge rules
  // compare against to prove nothing landed after the review.
  //
  // It must be the SHA the reviewer actually judged — for a PR that is the PR
  // head, NOT `git rev-parse HEAD`. A real run caught this: the working copy
  // sat on an unrelated branch, so HEAD recorded a commit that was never
  // reviewed, which would have made delta review meaningless and the
  // head_moved merge rule compare against the wrong thing.
  if (input.reviewed_sha) {
    next.reviewed_sha = input.reviewed_sha;
  } else if (state.target?.kind === "pr" && state.target.head_sha) {
    next.reviewed_sha = state.target.head_sha;
  } else {
    const head = git(state.repo_root, ["rev-parse", "HEAD"]);
    if (head.ok) next.reviewed_sha = head.stdout.trim();
  }

  // Rolling window of open-id sets, for stuck detection. Prior rounds only —
  // the caller compares this round against it before we push.
  const openIds = (input.counts?.open_ids ?? []).slice().sort();
  next.history = [...(state.history || []), openIds].slice(-HISTORY_WINDOW);
  // Only a round that actually produced a verdict may set the regression
  // baseline. A round that died on a rate limit committed zero findings — using
  // that as "before" makes the next real review look like a regression from
  // nothing, and the loop stops on a defect it invented.
  next.prev_blocking = input.verdict
    ? (input.counts?.blocking ?? state.prev_blocking ?? null)
    : (state.prev_blocking ?? null);

  if (input.threads) next.threads = { ...(state.threads || {}), ...input.threads };
  if (input.fixer_session_id) next.fixer_session_id = input.fixer_session_id;

  next.rounds_log = [...(state.rounds_log || []), {
    round: input.round,
    at: next.updated_at,
    verdict: input.verdict ?? null,
    reviewed_sha: next.reviewed_sha,
    gate: input.gate ? input.gate.summary : null,
    counts: input.counts ?? null,
    stop: input.stop ?? null,
    panel: input.panel ?? null,
    seconds: input.seconds ?? null,
    usage: input.usage ?? null,
  }];

  writeJsonAtomic(input.state_path, next);

  emit({
    ok: true,
    round: next.round,
    status: next.status,
    reviewed_sha: next.reviewed_sha,
    history_len: next.history.length,
    counts: next.counts ?? null,
  });
}

main();
