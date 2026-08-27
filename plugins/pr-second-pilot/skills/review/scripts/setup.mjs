// Первый запуск: определить, что можно, и объяснить каждую рекомендацию.
//
// В конфиге 64 ключа. Вываливать их на человека, который только что поставил
// плагин, — значит не настроить ничего: он оставит всё по умолчанию, включая
// то, что для его репозитория заведомо неверно.
//
// Поэтому не анкета, а разведка. Скрипт смотрит на репозиторий и окружение и
// возвращает список решений, каждое с текущим значением, рекомендованным и
// ПРИЧИНОЙ. Причина здесь — не украшение: рекомендация без неё неотличима от
// произвола, и человек не может с ней спорить.
//
//   node setup.mjs --detect --repo-root <path>
//   node setup.mjs --apply '{"report.language":"en","gate.source":"ci"}'

import path from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import {
  emit, bail, parseArgs, readJson, writeJsonAtomic, ensureDir, run, git,
  codexAuthMode, resolveCodex, resolveClaude, USER_CONFIG_DIR, HOME,
} from "./lib.mjs";
import { loadConfig, USER_CONFIG } from "./config.mjs";
import { SUPPORTED } from "./i18n.mjs";

const read = (f) => { try { return readFileSync(f, "utf8"); } catch { return ""; } };

/** Язык интерфейса — из окружения, если он среди поддерживаемых. */
function detectLanguage() {
  const raw = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || "";
  const code = raw.slice(0, 2).toLowerCase();
  if (SUPPORTED.includes(code)) {
    return { value: code, why: `системная локаль — ${raw.split(".")[0]}` };
  }
  return { value: "en", why: raw ? `локаль ${raw.split(".")[0]} не поддерживается` : "локаль не определена" };
}

/**
 * Можно ли доверять локальному прогону тестов.
 *
 * Главный признак — нужны ли тестам живые сервисы. Если да, а докера рядом нет,
 * локальный гейт не проверяет ничего и только создаёт ложное спокойствие.
 */
function detectGate(repoRoot) {
  const workflows = existsSync(path.join(repoRoot, ".github", "workflows"))
    ? readdirSync(path.join(repoRoot, ".github", "workflows")).filter((f) => /\.ya?ml$/.test(f))
    : [];
  const compose = ["docker-compose.yml", "docker-compose.yaml", "compose.yml"]
    .map((f) => path.join(repoRoot, f)).find(existsSync);
  const composeText = compose ? read(compose) : "";
  const needsServices = /\b(postgres|mysql|redis|mongo|rabbitmq|clickhouse|elasticsearch)\b/i.test(composeText)
    || /postgresql:\/\/|redis:\/\//.test(read(path.join(repoRoot, "api", "tests", "conftest.py")));
  const dockerUp = run("docker", ["info"], { timeout: 5000 }).ok;

  if (needsServices && !dockerUp && workflows.length) {
    return { value: "ci", why: "тесты требуют живых сервисов, docker не запущен — локальный гейт ничего не проверит" };
  }
  if (needsServices && !dockerUp) {
    return { value: "local", why: "тесты требуют сервисов, а CI не найден — проверь gate.commands вручную", weak: true };
  }
  if (workflows.length && !needsServices) {
    return { value: "local", why: `тесты запускаются локально, CI есть (${workflows.length} workflow) — можно и то и другое` };
  }
  if (workflows.length) return { value: "ci", why: `найдено workflow: ${workflows.length}` };
  return { value: "local", why: "CI не найден" };
}

/** Стоит ли держать в панели ревьюера по безопасности. */
function detectPanel(repoRoot, pool) {
  const hints = [];
  const probe = (dir, depth = 0) => {
    if (depth > 3 || hints.length > 2) return;
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { probe(p, depth + 1); continue; }
      if (!/\.(py|ts|tsx|js|go|rb|java)$/.test(e.name)) continue;
      if (/(auth|login|session|token|payment|billing|tenant|permission|acl)/i.test(e.name)) {
        hints.push(path.relative(repoRoot, p));
      }
    }
  };
  probe(repoRoot);

  if (hints.length) {
    return {
      value: "tech-lead,security",
      why: `в коде есть авторизация или платежи (${hints.slice(0, 2).join(", ")}) — второй ревьюер здесь окупается`,
    };
  }
  if (pool === "subscription") {
    return { value: "tech-lead", why: "признаков авторизации и платежей не видно, а панель из двух стоит вдвое" };
  }
  return { value: "tech-lead,security", why: "оплата по токенам — панель можно позволить" };
}

function detectMerge(repoRoot) {
  const gh = run("gh", ["repo", "view", "--json", "defaultBranchRef"], { cwd: repoRoot, timeout: 15000 });
  if (!gh.ok) {
    return { value: false, why: "gh недоступен или репозиторий не на GitHub — мержить будет нечем" };
  }
  return {
    value: false,
    why: "на первом прогоне лучше один раз увидеть решение движка правил, прежде чем оно станет автоматическим",
  };
}

function detectFixer() {
  return resolveClaude()
    ? { value: "inherit", why: "правки видно в IDE и можно вмешаться; subprocess нужен, только если хочешь другую модель" }
    : { value: "inherit", why: "claude CLI не в PATH — subprocess недоступен" };
}

function main() {
  const args = parseArgs();

  if (args.apply) {
    let patch;
    try { patch = JSON.parse(args.apply); }
    catch (e) { bail("apply_invalid_json", { detail: String(e) }); }
    ensureDir(USER_CONFIG_DIR);
    const current = readJson(USER_CONFIG, {});
    const applied = [];
    for (const [dotted, value] of Object.entries(patch)) {
      const keys = dotted.split(".");
      let cur = current;
      for (const k of keys.slice(0, -1)) {
        if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {};
        cur = cur[k];
      }
      cur[keys.at(-1)] = value;
      applied.push({ key: dotted, value });
    }
    writeJsonAtomic(USER_CONFIG, current);
    emit({ ok: true, wrote: USER_CONFIG, applied });
    return;
  }

  const repoRoot = args["repo-root"] || process.cwd();
  const inRepo = git(repoRoot, ["rev-parse", "--show-toplevel"]).ok;
  const { config } = loadConfig(inRepo ? repoRoot : null);
  const firstRun = !existsSync(USER_CONFIG);
  const codex = resolveCodex();
  const { mode: pool, plan } = codexAuthMode();

  const blockers = [];
  if (!codex.command) blockers.push({ what: "codex CLI не найден", fix: "npm install -g @openai/codex" });
  if (pool === "none") blockers.push({ what: "нет авторизации Codex", fix: "codex login" });
  if (!inRepo) blockers.push({ what: "это не git-репозиторий", fix: "запусти из репозитория" });

  const lang = detectLanguage();
  const gate = inRepo ? detectGate(repoRoot) : { value: "ci", why: "вне репозитория не определить" };
  const panel = inRepo ? detectPanel(repoRoot, pool) : { value: "tech-lead", why: "вне репозитория не определить" };
  const merge = inRepo ? detectMerge(repoRoot) : { value: false, why: "вне репозитория не определить" };
  const fixer = detectFixer();

  const decisions = [
    {
      key: "report.language", ...lang,
      current: config.report.language,
      question: "На каком языке писать отчёт и вердикты",
    },
    {
      key: "reviewer.model", value: "gpt-5.6-sol",
      current: config.reviewer.model,
      why: "лучшее сочетание на момент релиза плагина; модели меняются — новую стоит сравнить",
      question: "Модель ревьюера",
    },
    {
      key: "reviewer.effort", value: "high",
      current: config.reviewer.effort,
      why: "ревью — редкая и дорогая операция; экономить на глубине здесь не окупается",
      question: "Усилие ревьюера",
    },
    {
      key: "reviewer.panel", ...panel,
      current: config.reviewer.panel.join(","),
      question: "Сколько ревьюеров в первом раунде",
    },
    {
      key: "gate.source", ...gate,
      current: config.gate.source,
      question: "Чем проверять код до ревью",
    },
    {
      key: "merge.enabled", ...merge,
      current: config.merge.enabled,
      question: "Мержит агент или ты",
    },
    {
      key: "fixer.mode", ...fixer,
      current: config.fixer.mode,
      question: "Кто применяет правки",
    },
  ].map((d) => ({
    ...d,
    recommended: d.value,
    changes: String(d.current) !== String(d.value),
  }));

  emit({
    ok: blockers.length === 0,
    first_run: firstRun,
    user_config: USER_CONFIG,
    environment: {
      codex: codex.command ? `${codex.source}` : null,
      pool, plan,
      claude_cli: !!resolveClaude(),
      gh: run("which", ["gh"]).ok,
      repo: inRepo ? git(repoRoot, ["rev-parse", "--show-toplevel"]).stdout.trim() : null,
    },
    blockers,
    decisions,
    // Что менять не надо — тоже ответ, и он экономит человеку время.
    already_fine: decisions.filter((d) => !d.changes).map((d) => d.key),
    telegram_hint: config.notify.telegram.enabled
      ? null
      : "Оповещения выключены. Включаются отдельно: нужны bot_token и chat_id, и они пишутся только в пользовательский конфиг.",
  });
}

main();
