// Shared helpers for every pr-second-pilot script.
// Rules that hold across the whole plugin:
//   - state writes are atomic (tmp + rename), never partial
//   - every script returns exactly one JSON object on stdout
//   - non-zero exit means "the caller passed something malformed", not
//     "the operation failed" — operational failures are encoded in the JSON

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

export const HOME = os.homedir();
export const USER_CONFIG_DIR = path.join(HOME, ".claude", "pr-second-pilot");

// ---------------------------------------------------------------- output ---

// Вывод скриптов пайпят в `head`, `grep -q` и подобное. Закрытый на той
// стороне канал приходит асинхронным событием сокета, а не исключением из
// write() — поэтому try/catch вокруг записи бесполезен, нужен обработчик.
// Работа к этому моменту уже сделана, падать стеком незачем.
process.stdout.on("error", (e) => { if (e?.code === "EPIPE") process.exit(0); });

export function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

export function fail(error, extra = {}) {
  emit({ ok: false, error, ...extra });
  process.exit(0);
}

/** Malformed input from the caller — a bug in the orchestrator, not a run failure. */
export function bail(error, extra = {}) {
  emit({ ok: false, error, fatal: true, ...extra });
  process.exit(2);
}

// ------------------------------------------------------------------- argv ---

/** Minimal `--key value` / `--flag` parser. Repeated keys collect into arrays. */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) { out[key] = true; continue; }
    if (key in out) out[key] = [].concat(out[key], next);
    else out[key] = next;
    i++;
  }
  return out;
}

export async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

export async function readStdinJson() {
  const raw = await readStdin();
  if (!raw.trim()) bail("stdin_empty");
  try { return JSON.parse(raw); }
  catch (e) { bail("stdin_invalid_json", { detail: String(e) }); }
}

// ------------------------------------------------------------------- disk ---

export function readJson(file, fallback = null) {
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch { return fallback; }
}

/** Atomic write: tmp file in the same directory, then rename. */
export function writeAtomic(file, content) {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, file);
}

export function writeJsonAtomic(file, obj) {
  writeAtomic(file, JSON.stringify(obj, null, 2) + "\n");
}

export function sha256File(file) {
  if (!existsSync(file)) return null;
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export function sha1(s) {
  return createHash("sha1").update(s, "utf8").digest("hex");
}

export function rm(file) {
  try { unlinkSync(file); return true; } catch { return false; }
}

// ------------------------------------------------------------------ paths ---

/** Everything pr-second-pilot writes for one target lives under these paths. */
export function targetPaths(repoRoot, reportDir, slug) {
  const base = path.join(repoRoot, reportDir);
  return {
    reportDir: base,
    report: path.join(base, `${slug}.md`),
    stateDir: path.join(base, ".state"),
    state: path.join(base, ".state", `${slug}.json`),
    lock: path.join(base, ".state", `${slug}.lock`),
    work: path.join(base, ".state", `${slug}.work`),
  };
}

// -------------------------------------------------------------------- exec ---

/** Synchronous command runner. Never throws; encodes failure in the result. */
export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    ...opts,
  });
  return {
    ok: r.status === 0,
    code: r.status === null ? -1 : r.status,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    error: r.error ? String(r.error) : null,
  };
}

/** Async spawn with stdin payload. Never rejects. */
export function runAsync(cmd, args, { stdin, cwd, env, timeoutMs } = {}) {
  return new Promise((resolve) => {
    let out = "", err = "", timer = null, killed = false;
    const started = Date.now();
    let child;
    try {
      child = spawn(cmd, args, {
        cwd, env: env || process.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      resolve({ ok: false, code: -1, stdout: "", stderr: "", error: String(e), seconds: 0 });
      return;
    }
    if (timeoutMs) {
      timer = setTimeout(() => { killed = true; try { child.kill("SIGKILL"); } catch { /* gone */ } }, timeoutMs);
    }
    child.stdout.on("data", (d) => { out += d.toString("utf8"); });
    child.stderr.on("data", (d) => { err += d.toString("utf8"); });
    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout: out, stderr: err, error: String(e), seconds: 0 });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        ok: code === 0 && !killed,
        code: code === null ? -1 : code,
        stdout: out, stderr: err,
        error: killed ? "timeout" : null,
        seconds: Number(((Date.now() - started) / 1000).toFixed(2)),
      });
    });
    try { child.stdin.end(stdin ?? "", "utf8"); }
    catch { try { child.stdin.end(); } catch { /* already closed */ } }
  });
}

export function git(repoRoot, args) {
  return run("git", ["-C", repoRoot, ...args]);
}

// ------------------------------------------------------------- executables ---

/**
 * Locate the codex CLI. Prefers PATH; falls back to the binary the ChatGPT
 * desktop app ships, which is a full codex CLI but is not linked into PATH.
 */
export function resolveCodex() {
  const which = run("which", ["codex"]);
  if (which.ok && which.stdout.trim()) {
    return { command: which.stdout.trim().split("\n")[0], source: "path" };
  }
  const bundled = "/Applications/ChatGPT.app/Contents/Resources/codex";
  if (existsSync(bundled)) return { command: bundled, source: "chatgpt-app" };
  const npmPrefix = run("npm", ["prefix", "-g"]);
  if (npmPrefix.ok) {
    const cand = path.join(npmPrefix.stdout.trim(), "bin", "codex");
    if (existsSync(cand)) return { command: cand, source: "npm-global" };
  }
  return { command: null, source: "missing" };
}

export function resolveClaude() {
  const which = run("which", ["claude"]);
  if (which.ok && which.stdout.trim()) return which.stdout.trim().split("\n")[0];
  const cand = path.join(HOME, ".local", "bin", "claude");
  return existsSync(cand) ? cand : null;
}

/**
 * Which billing pool a codex run will draw from.
 * chatgpt  -> the user's ChatGPT plan limits (shared with the desktop app)
 * apikey   -> per-token API billing
 */
export function codexAuthMode() {
  const auth = readJson(path.join(HOME, ".codex", "auth.json"));
  if (!auth) return { mode: "none", plan: null };
  let plan = null;
  try {
    const payload = auth.tokens?.id_token?.split(".")[1];
    if (payload) {
      const json = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
      plan = json["https://api.openai.com/auth"]?.chatgpt_plan_type ?? null;
    }
  } catch { /* claim is diagnostic only */ }
  return { mode: auth.auth_mode || (auth.OPENAI_API_KEY ? "apikey" : "unknown"), plan };
}

// ------------------------------------------------------------------ misc ---

export function truncate(s, max) {
  if (!s) return "";
  return s.length <= max ? s : s.slice(0, max) + `\n… [обрезано, ещё ${s.length - max} символов]`;
}

export function tail(s, max) {
  if (!s) return "";
  return s.length <= max ? s : s.slice(s.length - max);
}

export function nowIso() {
  return new Date().toISOString();
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}
