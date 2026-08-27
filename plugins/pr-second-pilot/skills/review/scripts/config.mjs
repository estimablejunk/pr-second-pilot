// Configuration: defaults -> user config -> project config -> CLI flags.
//
// Secrets (Telegram token) never live in the project config — only in the user
// config under ~/.claude/pr-second-pilot/ or in environment variables. A project file
// that sets a secret is rejected rather than silently honored, because that
// file usually ends up in the very PR being reviewed.
//
// Usage:
//   node config.mjs --repo-root <path> [--show] [--set key=value ...]

import path from "node:path";
import { existsSync } from "node:fs";
import {
  USER_CONFIG_DIR, emit, bail, parseArgs, readJson, writeJsonAtomic, ensureDir,
} from "./lib.mjs";

export const USER_CONFIG = path.join(USER_CONFIG_DIR, "config.json");
export const PROJECT_CONFIG_NAMES = [".pr-second-pilot.json", ".pr-second-pilot/config.json"];

export const DEFAULTS = {
  reviewer: {
    engine: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
    service_tier: null,
    profile: null,
    extra_config: [],
    // Which reviewer prompts run, and for how many rounds the full panel runs.
    // Delta rounds default to tech-lead only: a second reviewer re-reading a
    // small delta costs a full quota slot and rarely adds a finding.
    panel: ["tech-lead", "security"],
    panel_rounds: 1,
    stack_profile: "auto",   // auto | none | <имя файла в reviewers/stacks/>
    // Вкладывать изменённые файлы прямо в промпт первого раунда. Ревьюер
    // иначе вычитывает их по кускам десятками ходов, и каждый кусок потом
    // переотправляется во всех последующих — измерено: 4,2 млн токенов за
    // прогон против ~0,5 млн при вложении.
    preload_files: "changed",   // changed | none
    preload_max_kb: 60,         // файл крупнее — пусть грепает сам (i18n-данные и barrel-файлы)
    preload_budget_kb: 200,
    preload_depth: 1,          // 0 — только изменённые, 1 — плюс прямые импорты
    // Прятать от ревьюера чужие скилы из ~/.codex/skills. Не только экономия
    // ходов: среди них проектные скилы под другую архитектуру, велящие постить
    // в PR и заводить мониторы — прямое противоречие промпту.
    isolate_skills: true,
    delta_panel: ["tech-lead"],
    timeout_minutes: 25,
  },
  fixer: {
    // inherit  -> the orchestrator (this Claude Code session) applies the fixes
    // subprocess -> a headless `claude -p` run with its own model and effort
    mode: "inherit",
    model: "opus",
    effort: "high",
    permission_mode: "acceptEdits",
    allowed_tools: ["Read", "Edit", "Write", "Bash", "Grep", "Glob"],
    timeout_minutes: 30,
    // Keep one resumable session across rounds so the fixer remembers what it
    // already tried. Set false for an independent attempt each round.
    continue_session: true,
    // auto — если цель PR, а рабочая копия на другой ветке или грязная, фиксер
    // получает свой worktree в ~/.claude/pr-second-pilot/worktrees/ и не трогает
    // твой чекаут. never — править прямо в рабочей копии.
    worktree: "auto",
    keep_worktree: false,
  },
  loop: {
    max_rounds: 4,
    hard_cap: 8,
    blocking_severities: ["critical", "major"],
    thread_mode: "continue",
    delta_review: true,
    scope_guard: true,
    dispute_rounds_before_escalation: 2,
  },
  gate: {
    enabled: true,
    // local — прогнать команды здесь; ci — прочитать проверки GitHub;
    // both — и то и другое. Для репозиториев, чьи тесты требуют живых сервисов,
    // честный гейт — это ci.
    source: "local",
    ci_wait_minutes: 0,
    autodetect: true,
    commands: [],
    timeout_minutes: 15,
    // A failing gate skips the reviewer and goes straight to the fixer.
    block_review_on_failure: true,
  },
  merge: {
    // The agent may merge once the loop allows it. Every entry below is a rule
    // that can forbid it; merge-pr.mjs evaluates all of them against live
    // GitHub state, not against the loop's own opinion.
    enabled: true,
    method: "auto",              // auto | squash | merge | rebase
    delete_branch: true,
    require_clean_gate: true,
    require_all_checks: true,
    allow_without_approval: false,
    forbid_with_unresolved_threads: true,
    forbid_with_open_questions: true,
    allow_behind: false,
    admin: false,                // never bypass branch protection by default
    max_advisory: null,
    forbid_labels: ["do-not-merge", "wip", "on-hold", "\u043d\u0435 \u043c\u0435\u0440\u0436\u0438\u0442\u044c"],
    forbid_paths: [],
    allow_base_branches: null,
    body: null,
  },
  report: {
    dir: "PR",
    // git-exclude writes to .git/info/exclude, which is local and never lands
    // in the PR. gitignore edits the tracked file — offered, not default.
    exclude_via: "git-exclude",
    language: "ru",
  },
  notify: {
    telegram: {
      enabled: false,
      bot_token: null,
      chat_id: null,
      bot_token_env: "PR_SECOND_PILOT_TG_TOKEN",
      chat_id_env: "PR_SECOND_PILOT_TG_CHAT",
      events: ["needs_human", "allowed", "merged", "stopped", "rate_limited", "failed"],
      silent: false,
    },
  },
};

const SECRET_PATHS = ["notify.telegram.bot_token", "notify.telegram.chat_id"];

// Проверено ответом API: gpt-5.6-sol принимает ровно эти значения.
const EFFORTS_CODEX = ["none", "low", "medium", "high", "xhigh", "max"];
const EFFORTS_CLAUDE = ["low", "medium", "high", "xhigh", "max"];
const SEVERITIES = ["critical", "major", "minor", "nit"];

function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function deepMerge(base, over) {
  if (!isPlainObject(over)) return over === undefined ? base : over;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isPlainObject(v) && isPlainObject(base?.[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

function getPath(obj, dotted) {
  return dotted.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setPath(obj, dotted, value) {
  const keys = dotted.split(".");
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (!isPlainObject(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[keys.at(-1)] = value;
  return obj;
}

export function findProjectConfig(repoRoot) {
  for (const name of PROJECT_CONFIG_NAMES) {
    const p = path.join(repoRoot, name);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Resolve the effective config plus a per-key origin map, so `--show` and the
 * report can say where each value actually came from.
 */
export function loadConfig(repoRoot, overrides = {}) {
  const warnings = [];
  const sources = {};

  const stamp = (obj, origin, prefix = "") => {
    for (const [k, v] of Object.entries(obj || {})) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (isPlainObject(v)) stamp(v, origin, key);
      else sources[key] = origin;
    }
  };

  let cfg = structuredClone(DEFAULTS);
  stamp(DEFAULTS, "default");

  const user = readJson(USER_CONFIG);
  if (user) { cfg = deepMerge(cfg, user); stamp(user, "user"); }

  const projectPath = repoRoot ? findProjectConfig(repoRoot) : null;
  const project = projectPath ? readJson(projectPath) : null;
  if (project) {
    for (const secret of SECRET_PATHS) {
      if (getPath(project, secret) != null) {
        setPath(project, secret, null);
        warnings.push(
          `${path.basename(projectPath)} задаёт ${secret} — проигнорировано. ` +
          `Секреты держи в ${USER_CONFIG} или в переменных окружения: файл проекта уедет в тот же PR.`
        );
      }
    }
    cfg = deepMerge(cfg, project);
    stamp(project, "project");
  }

  if (Object.keys(overrides).length) {
    cfg = deepMerge(cfg, overrides);
    stamp(overrides, "cli");
  }

  warnings.push(...validate(cfg));
  return { config: cfg, sources, warnings, user_config: USER_CONFIG, project_config: projectPath };
}

export function validate(cfg) {
  const w = [];
  if (!EFFORTS_CODEX.includes(cfg.reviewer.effort)) {
    w.push(`reviewer.effort="${cfg.reviewer.effort}" — codex принимает ${EFFORTS_CODEX.join("|")}.`);
  }
  if (!EFFORTS_CLAUDE.includes(cfg.fixer.effort)) {
    w.push(`fixer.effort="${cfg.fixer.effort}" — claude принимает ${EFFORTS_CLAUDE.join("|")}.`);
  }
  if (!["auto", "never"].includes(cfg.fixer.worktree)) {
    w.push(`fixer.worktree="${cfg.fixer.worktree}" — должно быть auto или never.`);
  }
  if (!["local", "ci", "both"].includes(cfg.gate.source)) {
    w.push(`gate.source="${cfg.gate.source}" — должно быть local, ci или both.`);
  }
  if (!["inherit", "subprocess"].includes(cfg.fixer.mode)) {
    w.push(`fixer.mode="${cfg.fixer.mode}" — должно быть inherit или subprocess.`);
  }
  const bad = (cfg.loop.blocking_severities || []).filter((s) => !SEVERITIES.includes(s));
  if (bad.length) w.push(`loop.blocking_severities содержит неизвестные уровни: ${bad.join(", ")}.`);
  if (cfg.loop.max_rounds > cfg.loop.hard_cap) {
    w.push(`loop.max_rounds (${cfg.loop.max_rounds}) больше hard_cap (${cfg.loop.hard_cap}) — будет обрезан.`);
  }
  if (!Array.isArray(cfg.reviewer.panel) || cfg.reviewer.panel.length === 0) {
    w.push("reviewer.panel пуст — ревьюер не будет запущен.");
  }
  if (!["auto", "squash", "merge", "rebase"].includes(cfg.merge.method)) {
    w.push(`merge.method="${cfg.merge.method}" — должно быть auto|squash|merge|rebase.`);
  }
  if (cfg.merge.admin === true) {
    w.push("merge.admin=true — мерж пойдёт в обход защиты ветки. Убедись, что это осознанно.");
  }
  if (cfg.merge.enabled && cfg.merge.allow_without_approval === true) {
    w.push("merge.allow_without_approval=true — апрув человека не потребуется.");
  }
  if (cfg.notify.telegram.enabled) {
    const tok = cfg.notify.telegram.bot_token || process.env[cfg.notify.telegram.bot_token_env];
    const chat = cfg.notify.telegram.chat_id || process.env[cfg.notify.telegram.chat_id_env];
    if (!tok || !chat) {
      w.push(
        `notify.telegram.enabled=true, но ${!tok ? "токен" : "chat_id"} не найден ` +
        `(ни в ${USER_CONFIG}, ни в $${!tok ? cfg.notify.telegram.bot_token_env : cfg.notify.telegram.chat_id_env}).`
      );
    }
  }
  return w;
}

/** Coerce a `--set key=value` string into the right JS type. */
function coerce(raw) {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (raw.startsWith("[") || raw.startsWith("{")) {
    try { return JSON.parse(raw); } catch { /* keep as string */ }
  }
  if (raw.includes(",")) return raw.split(",").map((s) => s.trim()).filter(Boolean);
  return raw;
}

function main() {
  const args = parseArgs();
  const repoRoot = args["repo-root"] || process.cwd();

  if (args.set) {
    const pairs = [].concat(args.set);
    ensureDir(USER_CONFIG_DIR);
    const current = readJson(USER_CONFIG, {});
    const applied = [];
    for (const pair of pairs) {
      const idx = String(pair).indexOf("=");
      if (idx < 0) bail("set_malformed", { detail: `ожидалось key=value, получено "${pair}"` });
      const key = String(pair).slice(0, idx);
      const value = coerce(String(pair).slice(idx + 1));
      if (getPath(DEFAULTS, key) === undefined) {
        bail("unknown_key", { detail: `нет такого ключа: ${key}` });
      }
      setPath(current, key, value);
      applied.push({ key, value: SECRET_PATHS.includes(key) ? "***" : value });
    }
    writeJsonAtomic(USER_CONFIG, current);
    const { warnings } = loadConfig(repoRoot);
    emit({ ok: true, wrote: USER_CONFIG, applied, warnings });
    return;
  }

  const { config, sources, warnings, user_config, project_config } = loadConfig(repoRoot);
  const redacted = structuredClone(config);
  for (const s of SECRET_PATHS) if (getPath(redacted, s)) setPath(redacted, s, "***");
  emit({ ok: true, config: redacted, sources, warnings, user_config, project_config });
}

if (import.meta.url === `file://${process.argv[1]}`) main();
