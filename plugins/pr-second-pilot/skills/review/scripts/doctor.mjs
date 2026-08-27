// Environment check. Runs as a SessionStart hook (--hook, one quiet line only
// when something is actually wrong) and as /pr-second-pilot:doctor (full report).
//
// The most important thing it reports is which billing pool a review will
// spend, because with ChatGPT auth the loop shares limits with the desktop app.

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  emit, parseArgs, run, resolveCodex, resolveClaude, codexAuthMode, readJson, HOME,
} from "./lib.mjs";
import { loadConfig, USER_CONFIG } from "./config.mjs";

function checkCodex() {
  const { command, source } = resolveCodex();
  if (!command) {
    return {
      name: "codex", status: "fail",
      detail: "codex CLI не найден.",
      fix: "npm install -g @openai/codex  (или укажи путь в reviewer.command)",
    };
  }
  const v = run(command, ["--version"], { timeout: 8000 });
  const version = v.ok ? v.stdout.trim().split("\n")[0] : "версия не определена";
  return {
    name: "codex", status: "ok",
    detail: `${version} (${source === "chatgpt-app" ? "бинарь из ChatGPT.app, не в PATH" : source})`,
    command,
    warn: source === "chatgpt-app"
      ? "Работает, но версия привязана к обновлениям десктопного приложения. Надёжнее npm install -g @openai/codex."
      : null,
  };
}

function checkCodexAuth() {
  const { mode, plan } = codexAuthMode();
  if (mode === "none") {
    return { name: "codex auth", status: "fail", detail: "нет ~/.codex/auth.json", fix: "codex login" };
  }
  if (mode === "chatgpt") {
    // Показать не только «какой пул», но и сколько в нём осталось: на
    // подписке один прогон ревью съедает около пятой части пятичасового окна.
    let left = null;
    try {
      const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "usage.mjs");
      const r = spawnSync(process.execPath, [script, "--limits"], { encoding: "utf8", timeout: 10000 });
      const u = JSON.parse(r.stdout);
      if (u.ok && u.limits?.short_window) {
        left = `окно ${u.limits.short_window.window_hours}ч: ${u.limits.short_window.used_percent}% использовано` +
               (u.limits.long_window ? `, неделя: ${u.limits.long_window.used_percent}%` : "");
      }
    } catch { /* диагностика не обязана работать */ }
    return {
      name: "codex auth", status: "ok",
      detail: `подписка ChatGPT${plan ? ` (${plan})` : ""} — общий пул с десктопным Codex` +
              (left ? `. ${left}` : ""),
      pool: "subscription",
    };
  }
  if (mode === "apikey") {
    return { name: "codex auth", status: "ok", detail: "API-ключ — оплата по токенам", pool: "api" };
  }
  return { name: "codex auth", status: "warn", detail: `неизвестный auth_mode="${mode}"` };
}

function checkClaude() {
  const cmd = resolveClaude();
  if (!cmd) {
    return {
      name: "claude", status: "warn",
      detail: "claude CLI не в PATH — режим fixer.mode=subprocess недоступен",
      fix: "fixer.mode=inherit работает и без него",
    };
  }
  const v = run(cmd, ["--version"], { timeout: 8000 });
  return { name: "claude", status: "ok", detail: v.ok ? v.stdout.trim() : cmd, command: cmd };
}

function checkGit(repoRoot) {
  const r = run("git", ["-C", repoRoot, "rev-parse", "--show-toplevel"]);
  if (!r.ok) {
    return { name: "git", status: "fail", detail: "не git-репозиторий", fix: "git init, либо запусти из репозитория" };
  }
  return { name: "git", status: "ok", detail: r.stdout.trim() };
}

function checkGh(repoRoot) {
  const which = run("which", ["gh"]);
  if (!which.ok) {
    return { name: "gh", status: "warn", detail: "не установлен — ревью по номеру PR недоступно, локальные ветки работают" };
  }
  const auth = run("gh", ["auth", "status"], { timeout: 10000, cwd: repoRoot });
  return auth.ok || /Logged in/.test(auth.stderr + auth.stdout)
    ? { name: "gh", status: "ok", detail: run("gh", ["--version"]).stdout.split("\n")[0] }
    : { name: "gh", status: "warn", detail: "установлен, но не авторизован", fix: "gh auth login" };
}

function checkTelegram(cfg) {
  const tg = cfg.notify.telegram;
  if (!tg.enabled) return { name: "telegram", status: "skip", detail: "выключен" };
  const tok = tg.bot_token || process.env[tg.bot_token_env];
  const chat = tg.chat_id || process.env[tg.chat_id_env];
  if (!tok || !chat) {
    return {
      name: "telegram", status: "fail",
      detail: `нет ${!tok ? "bot_token" : "chat_id"}`,
      fix: `node config.mjs --set notify.telegram.${!tok ? "bot_token" : "chat_id"}=…  (пишется в ${USER_CONFIG})`,
    };
  }
  return { name: "telegram", status: "ok", detail: `бот настроен, события: ${tg.events.join(", ")}` };
}

function checkReviewers(cfg, pluginRoot) {
  const missing = [];
  for (const name of cfg.reviewer.panel) {
    const custom = cfg.reviewer.skills?.[name];
    const p = custom || path.join(pluginRoot, "reviewers", `${name}.md`);
    if (!existsSync(p)) missing.push(`${name} → ${p}`);
  }
  return missing.length
    ? { name: "reviewers", status: "fail", detail: `не найдены: ${missing.join("; ")}` }
    : { name: "reviewers", status: "ok", detail: cfg.reviewer.panel.join(" + ") };
}

function main() {
  const args = parseArgs();
  const repoRoot = args["repo-root"] || process.cwd();
  const pluginRoot = args["plugin-root"] || process.env.CLAUDE_PLUGIN_ROOT ||
    path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");

  const { config, warnings } = loadConfig(repoRoot);

  const checks = [
    checkCodex(),
    checkCodexAuth(),
    checkClaude(),
    checkGit(repoRoot),
    checkGh(repoRoot),
    checkReviewers(config, pluginRoot),
    checkTelegram(config),
  ];

  const failed = checks.filter((c) => c.status === "fail");
  const warned = checks.filter((c) => c.status === "warn" || c.warn);

  if (args.hook) {
    // Quiet unless codex itself is unusable — a SessionStart hook that chatters
    // on every start is a hook people disable.
    const blocking = failed.filter((c) => c.name === "codex" || c.name === "codex auth");
    if (blocking.length) {
      process.stdout.write(
        `pr-second-pilot: ${blocking.map((c) => `${c.name} — ${c.detail}`).join("; ")}. ` +
        `Проверь /pr-second-pilot:doctor.\n`
      );
    }
    process.exit(0);
  }

  emit({
    ok: failed.length === 0,
    checks,
    failed: failed.map((c) => c.name),
    warned: warned.map((c) => c.name),
    config_warnings: warnings,
    pool: checks.find((c) => c.name === "codex auth")?.pool ?? null,
    reviewer: `${config.reviewer.model} / effort=${config.reviewer.effort}`,
    fixer: config.fixer.mode === "inherit"
      ? "inherit (текущая сессия)"
      : `${config.fixer.model} / effort=${config.fixer.effort}`,
    user_config: USER_CONFIG,
    user_config_exists: !!readJson(USER_CONFIG),
    home: HOME,
  });
}

main();
