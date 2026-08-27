// Spawn the reviewer. One codex exec per panel member, run concurrently.
//
// Two things this wrapper exists to guarantee:
//   1. --sandbox read-only is a literal, never derived from user config. A
//      reviewer that can edit the code it is judging is not a reviewer.
//   2. hitting the ChatGPT plan limit is a distinct, resumable outcome — not
//      a crash. On a subscription the loop WILL hit it, and losing the round's
//      state to an abort is the difference between "wait an hour" and
//      "start over".
//
//   node run-codex-review.mjs <params.json>

import { existsSync, readFileSync, writeFileSync, symlinkSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  emit, bail, resolveCodex, runAsync, readJson, tail, ensureDir, nowIso, HOME, USER_CONFIG_DIR,
} from "./lib.mjs";
import { parse } from "./parse-verdict.mjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * What the run cost. `codex exec` never says — the numbers live in the thread's
 * rollout log, and on a subscription they are the difference between "three
 * more rounds" and "wall in twenty minutes".
 */
function readUsage(sessionId, since) {
  if (!sessionId) return null;
  try {
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "usage.mjs");
    // `since` обязателен при thread_mode=continue: возобновлённый прогон пишет
    // в тот же rollout, и без границы счёт складывает раунды.
    const argv = [script, "--session", sessionId];
    if (since) argv.push("--since", since);
    const r = spawnSync(process.execPath, argv, { encoding: "utf8", timeout: 15000 });
    const out = JSON.parse(r.stdout);
    return out.ok ? out : null;
  } catch { return null; }
}

// Codex reports plan exhaustion in several shapes depending on version and
// whether the limit is the 5-hour or the weekly window.
const RATE_LIMIT_RE = /(usage limit|rate.?limit|quota|429|too many requests|you'?ve (?:hit|reached) your|try again (?:in|at)|limit (?:will )?reset)/i;
const AUTH_RE = /(not logged in|unauthorized|401|invalid.*(?:token|credential)|codex login|authentication)/i;
// Cosmetic stderr line codex emits on successful exec since 0.125.
const ROLLOUT_NOISE_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z ERROR codex_core::session: failed to record rollout items: thread [0-9a-f-]+ not found\s*$/;

/**
 * Pull the authoritative error out of the JSONL stream.
 *
 * Codex emits `error` / `turn.failed` events near the START of stdout, while a
 * blind tail() of the stream returns whatever the model happened to echo last —
 * on a real run that turned out to be a slab of the prompt, which told the
 * operator nothing. Read the event, not the noise.
 */
function errorFromJsonl(stdout) {
  let message = null;
  for (const line of (stdout || "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const ev = JSON.parse(t);
      const type = ev.type ?? ev.msg?.type ?? "";
      if (type === "error" || type === "turn.failed" || type === "stream_error") {
        message = ev.message ?? ev.error?.message ?? ev.msg?.message ?? message;
      }
    } catch { /* partial line */ }
  }
  return message;
}

// Всё из ~/.codex, КРОМЕ источников чужих инструкций.
const ISOLATE_EXCLUDE = new Set(["skills", "prompts", "AGENTS.md", "plugins"]);

/**
 * Codex-дом без чужих скилов.
 *
 * Codex безусловно подхватывает всё из `$CODEX_HOME/skills`, и отключить это
 * флагом нельзя. Замерено: пять ходов из семнадцати уходили на чтение чужих
 * скилов — но дороже другое. Среди подхваченного оказывался старый
 * проектный скил с `project-context.md` под другую архитектуру и с прямым
 * указанием постить комментарий в PR и заводить мониторы. Ревьюер получал
 * инструкции, противоречащие этому промпту, и мог судить чужими конвенциями.
 *
 * Запрет в промпте не помог — модель всё равно шла перечислять каталог.
 * Поэтому каталога просто не будет: теневой дом с симлинками на auth, config,
 * sessions и cache, но без skills. Симлинк на auth.json означает, что
 * обновление токена проходит в настоящий файл, а не расходится с ним.
 */
function prepareIsolatedHome() {
  const real = path.join(HOME, ".codex");
  if (!existsSync(real)) return { home: null, reason: "нет ~/.codex" };
  const shadow = path.join(USER_CONFIG_DIR, "codex-home");
  try {
    ensureDir(shadow);
    for (const entry of readdirSync(real)) {
      if (ISOLATE_EXCLUDE.has(entry) || entry.startsWith(".")) continue;
      const dst = path.join(shadow, entry);
      if (existsSync(dst)) continue;
      try { symlinkSync(path.join(real, entry), dst); } catch { /* уже есть или нельзя */ }
    }
    if (!existsSync(path.join(shadow, "auth.json"))) {
      return { home: null, reason: "не удалось связать auth.json" };
    }
    return { home: shadow, reason: null };
  } catch (e) {
    return { home: null, reason: String(e).slice(0, 200) };
  }
}

function cleanStderr(s) {
  if (!s) return "";
  return s.split(/\r?\n/).filter((l) => !ROLLOUT_NOISE_RE.test(l)).join("\n");
}

function extractResetHint(text) {
  const m = text.match(/(?:try again (?:in|at)|resets? (?:in|at)|available again (?:in|at))\s+([^\n."]{1,60})/i);
  if (m) return m[1].trim();
  const clock = text.match(/\b(\d{1,2}:\d{2}\s*(?:AM|PM))\b/i);
  return clock ? clock[1] : null;
}

function buildArgs(params, member, resumeThreadId) {
  const r = params.reviewer;
  const args = [
    "exec",
    "-C", params.repo_root,
    "--json",
    "--sandbox", "read-only",   // invariant — never configurable
    "--skip-git-repo-check",
    "-o", member.last_message_file,
  ];
  if (r.profile) args.push("-p", r.profile);
  for (const kv of r.extra_config || []) args.push("-c", kv);
  args.push("-c", `model_reasoning_effort="${r.effort}"`);
  if (r.service_tier) args.push("-c", `service_tier="${r.service_tier}"`);
  if (r.model) args.push("-m", r.model);
  if (resumeThreadId) args.push("resume", resumeThreadId);
  args.push("-");   // prompt via stdin
  return args;
}

function sessionIdFromJsonl(stdout) {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const ev = JSON.parse(line);
      const id = ev.session_id || ev.thread_id || ev.id ||
        ev.msg?.session_id || ev.msg?.thread_id;
      if (id && /^[0-9a-f-]{20,}$/i.test(String(id))) return String(id);
    } catch { /* not every line is an event */ }
  }
  return null;
}

function agentTextFromJsonl(stdout) {
  let text = "";
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const ev = JSON.parse(line);
      const t = ev.msg?.message ?? ev.msg?.text ?? ev.message ?? null;
      const type = ev.msg?.type ?? ev.type ?? "";
      if (typeof t === "string" && /agent_message|assistant|final/i.test(type)) text = t;
    } catch { /* ignore */ }
  }
  return text;
}

async function runMember(codex, params, member) {
  const startedAt = new Date().toISOString();
  const prompt = readFileSync(member.prompt_file, "utf8");
  writeFileSync(member.last_message_file, "", "utf8");

  const wantResume = params.thread_mode === "continue" && member.resume_thread_id;
  const env = params.codex_home
    ? { ...process.env, CODEX_HOME: params.codex_home }
    : process.env;

  let args = buildArgs(params, member, wantResume ? member.resume_thread_id : null);
  let r = await runAsync(codex.command, args, {
    cwd: params.repo_root,
    stdin: prompt,
    env,
    timeoutMs: (params.reviewer.timeout_minutes || 25) * 60_000,
  });

  const stderr = cleanStderr(r.stderr);
  let fellBackToFresh = false;

  // A lost thread is not a failure — start a fresh one and say so, because a
  // fresh reviewer being more thorough must not read as a regression later.
  if (!r.ok && wantResume && /thread\s+[0-9a-f-]+\s+not found|session not found|no such session/i.test(stderr)) {
    fellBackToFresh = true;
    args = buildArgs(params, member, null);
    writeFileSync(member.last_message_file, "", "utf8");
    r = await runAsync(codex.command, args, {
      cwd: params.repo_root, stdin: prompt, env,
      timeoutMs: (params.reviewer.timeout_minutes || 25) * 60_000,
    });
  }

  const eventError = errorFromJsonl(r.stdout);
  // Prefer the structured event; fall back to the raw streams only when the
  // process died before emitting one.
  const combined = [eventError, cleanStderr(r.stderr), r.stdout.slice(0, 8000)]
    .filter(Boolean).join("\n");
  const diagnostic = eventError || tail(cleanStderr(r.stderr).trim(), 600) || tail(r.stdout.trim(), 600);

  if (!r.ok) {
    if (r.error === "timeout") {
      return { member: member.name, outcome: "timeout", detail: `превышен лимит ${params.reviewer.timeout_minutes} мин` };
    }
    if (RATE_LIMIT_RE.test(combined)) {
      return {
        member: member.name, outcome: "rate_limited",
        detail: diagnostic, exit_code: r.code,
        reset_hint: extractResetHint(combined),
      };
    }
    if (AUTH_RE.test(combined)) {
      return { member: member.name, outcome: "auth_failed", detail: diagnostic, exit_code: r.code, fix: "codex login" };
    }
    return { member: member.name, outcome: "failed", exit_code: r.code, detail: diagnostic };
  }

  let text = "";
  try { text = readFileSync(member.last_message_file, "utf8"); } catch { /* fall through */ }
  if (!text.trim()) text = agentTextFromJsonl(r.stdout);

  if (!text.trim()) {
    // Empty output on exit 0 is usually a soft limit refusal.
    if (RATE_LIMIT_RE.test(combined)) {
      return { member: member.name, outcome: "rate_limited", detail: diagnostic, exit_code: r.code, reset_hint: extractResetHint(combined) };
    }
    return { member: member.name, outcome: "empty", detail: diagnostic };
  }

  const parsed = parse(text, { source: member.name, changedFiles: params.changed_files || null });
  const threadId = sessionIdFromJsonl(r.stdout);
  const usage = readUsage(threadId, startedAt);
  return {
    member: member.name,
    usage: usage && {
      turns: usage.turns,
      total_tokens: usage.total_tokens,
      window_spent_percent: usage.window_spent,
      window_used_percent: usage.limits?.short_window?.used_percent ?? null,
      week_used_percent: usage.limits?.long_window?.used_percent ?? null,
    },
    outcome: parsed.verdict === "MALFORMED" ? "malformed" : "ok",
    ...parsed,
    thread_id: threadId,
    fell_back_to_fresh: fellBackToFresh,
    seconds: r.seconds,
    last_message_file: member.last_message_file,
  };
}

async function main() {
  const paramsPath = process.argv[2];
  if (!paramsPath || !existsSync(paramsPath)) bail("params_missing", { path: paramsPath });
  const params = readJson(paramsPath);
  if (!params) bail("params_invalid_json", { path: paramsPath });
  for (const k of ["repo_root", "reviewer", "members"]) {
    if (!params[k]) bail("params_incomplete", { missing: k });
  }

  const codex = resolveCodex();
  if (!codex.command) {
    emit({
      ok: false, outcome: "codex_missing",
      detail: "codex CLI не найден",
      fix: "npm install -g @openai/codex",
    });
    return;
  }
  ensureDir(path.dirname(params.members[0].last_message_file));

  let isolation = { home: null, reason: "выключено настройкой" };
  if (params.reviewer.isolate_skills !== false) {
    isolation = prepareIsolatedHome();
    params.codex_home = isolation.home;
  }

  const results = await Promise.all(params.members.map((m) => runMember(codex, params, m)));

  const rateLimited = results.filter((r) => r.outcome === "rate_limited");
  const usable = results.filter((r) => r.outcome === "ok");

  emit({
    ok: usable.length > 0,
    outcome:
      usable.length > 0 ? "ok" :
      rateLimited.length ? "rate_limited" :
      results.every((r) => r.outcome === "malformed") ? "malformed" :
      results[0]?.outcome ?? "failed",
    results,
    rate_limited: rateLimited.length > 0,
    reset_hint: rateLimited.find((r) => r.reset_hint)?.reset_hint ?? null,
    usage: (() => {
      const u = results.map((r) => r.usage).filter(Boolean);
      if (!u.length) return null;
      return {
        turns: u.reduce((a, x) => a + (x.turns || 0), 0),
        total_tokens: u.reduce((a, x) => a + (x.total_tokens || 0), 0),
        window_spent_percent: Number(u.reduce((a, x) => a + (x.window_spent_percent || 0), 0).toFixed(1)),
        window_used_percent: Math.max(...u.map((x) => x.window_used_percent ?? 0)) || null,
        week_used_percent: Math.max(...u.map((x) => x.week_used_percent ?? 0)) || null,
      };
    })(),
    codex_source: codex.source,
    skills_isolated: !!isolation.home,
    isolation_note: isolation.reason,
    ran_at: nowIso(),
  });
}

main();
