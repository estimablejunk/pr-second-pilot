// Build the prompt and params for one review round.
//
// Round 1 sends the whole diff to the full panel. Later rounds send only what
// changed since the reviewer last looked, plus the findings still open — the
// reviewer's job then is to verify claimed fixes, not to re-read approved code.
//
//   node prepare-round.mjs --state <path> --work <dir> --plugin-root <path> \
//     --round N --diff-file <path> [--delta] [--config-json '<json>']

import path from "node:path";
import { readFileSync, existsSync } from "node:fs";
import {
  emit, bail, parseArgs, readJson, writeAtomic, ensureDir, truncate, git,
} from "./lib.mjs";
import { OUTPUT_INSTRUCTION } from "./i18n.mjs";

const RESET_BLOCK = `<reset>
Забудь свои прошлые оценки этого изменения. Ты видишь текущее состояние кода
и обязан оценить его заново. Не подтверждай прошлый вердикт по инерции и не
повторяй замечание, если код его больше не подтверждает.
</reset>

`;

function renderTarget(t) {
  const lines = [
    `kind: ${t.kind}`,
    t.number ? `pull request: #${t.number} — ${t.title}` : `branch: ${t.head_ref} → ${t.base_ref}`,
    t.url ? `url: ${t.url}` : null,
    `base: ${t.base_sha ?? t.base_ref}`,
    `head: ${t.head_sha}`,
    `объём: +${t.stats?.additions ?? "?"} / -${t.stats?.deletions ?? "?"} в ${t.stats?.files ?? "?"} файлах`,
    t.is_draft ? "ВНИМАНИЕ: PR в статусе draft." : null,
    t.dirty_worktree ? "ВНИМАНИЕ: рабочая копия грязная — ревьюй только коммиты, не незакоммиченные правки." : null,
  ].filter(Boolean);
  if (t.checks?.length) {
    lines.push(`CI: ${t.checks.map((c) => `${c.name}=${c.status}`).join(", ")}`);
  }
  return lines.join("\n");
}

function renderGate(gate) {
  if (!gate || gate.skipped) return "Объективные проверки не запускались.";
  return [
    "Результат объективных проверок, запущенных до ревью:",
    ...gate.checks.map((c) => `  ${c.name}: ${c.status}${c.optional ? " (необязательная)" : ""}`),
    gate.ok ? "Все обязательные проверки прошли." : `Провалены: ${gate.blocking.join(", ")}.`,
  ].join("\n");
}

function renderOpenFindings(findings, cfg) {
  const open = findings.filter((f) => ["open", "fixed", "disputed"].includes(f.status));
  if (!open.length) return "";
  const blocks = open.map((f) => {
    const head = `[${f.id}] [${f.severity}] ${f.title}\n  файл: ${f.file || "—"}\n  статус: ${f.status}`;
    if (f.status === "fixed") {
      const last = [...(f.history || [])].reverse().find((h) => h.action === "fixed");
      return `${head}\n  исполнитель заявил исправление: ${last?.note || "без комментария"}\n  правка: ${last?.edit || "—"}`;
    }
    if (f.status === "disputed") {
      const last = [...(f.history || [])].reverse().find((h) => h.action === "disputed");
      return `${head}\n  исполнитель НЕ СОГЛАСЕН: ${last?.note || "без аргумента"}\n  ` +
        `Ответь по существу: accepted (замечание снимается) или rejected (замечание остаётся, объясни чем код это опровергает).`;
    }
    return `${head}\n  требовалось: ${f.required || "—"}`;
  });
  return [
    "<open_findings>",
    `Это замечания предыдущих раундов. По каждому вынеси явное решение.`,
    `Правило приоритета: сначала проверь эти, потом ищи новое в дельте.`,
    "",
    ...blocks,
    "</open_findings>",
  ].join("\n");
}

/**
 * Pick a stack profile for the reviewer. Purely additive: a profile sharpens
 * the generic categories with the antipatterns of one technology, and a repo
 * we cannot classify simply gets no profile rather than a wrong one.
 */
/**
 * Hand the reviewer the changed files up front instead of making it fetch them.
 *
 * Measured on a real run: the reviewer spent 38 turns running git/sed/grep to
 * read ~146k tokens of source a slice at a time. Every slice then rode along in
 * every later turn — context grew 29k → 175k and the run cost 4.2M tokens.
 * The same content delivered once costs a fraction of that.
 *
 * Deliberately NOT a replacement for exploration. The single best finding of
 * that run came from a file outside the diff (the reviewer opened recall.py on
 * its own and read a docstring). Preloading lowers the floor; it must not fence
 * the reviewer in — the prompt still tells it to follow callers and callees.
 */
/**
 * Depth-1 local imports of the changed files.
 *
 * Not a substitute for exploration, and the prompt says so. On the run this was
 * built from, the single best finding came from `recall.py` — three import hops
 * from the changed file, so no sane depth would have preloaded it. What this
 * does buy is the first hop, which is where most "what does this call actually
 * do" turns go.
 *
 * Resolution is deliberately conservative: a candidate is included only if the
 * path exists in the reviewed commit. A wrong guess costs tokens and teaches
 * the reviewer nothing.
 */
function resolveImports(repoRoot, sha, rel, body) {
  const out = new Set();
  const exists = (p) => sha
    ? git(repoRoot, ["cat-file", "-e", `${sha}:${p}`]).ok
    : existsSync(path.join(repoRoot, p));

  if (/\.(py)$/.test(rel)) {
    // `api/app/routers/meetings.py` + `app.services.recall` → `api/app/services/recall.py`
    const parts = rel.split("/");
    for (let i = 0; i < parts.length - 1; i++) {
      const pkg = parts[i];
      const prefix = parts.slice(0, i).join("/");
      const re = new RegExp(`^\\s*(?:from\\s+(${pkg}(?:\\.[\\w.]+)?)\\s+import\\s+([\\w,\\s*]+)|import\\s+(${pkg}(?:\\.[\\w.]+)?))`, "gm");
      for (const m of body.matchAll(re)) {
        const mod = m[1] || m[3];
        if (!mod) continue;
        const base = (prefix ? prefix + "/" : "") + mod.replace(/\./g, "/");
        for (const cand of [`${base}.py`, `${base}/__init__.py`]) {
          if (exists(cand)) out.add(cand);
        }
        // `from app.services import recall, quota` — имена тоже могут быть модулями.
        for (const name of (m[2] || "").split(",").map((x) => x.trim().split(/\s+as\s+/)[0]).filter(Boolean)) {
          if (name === "*") continue;
          for (const cand of [`${base}/${name}.py`, `${base}/${name}/__init__.py`]) {
            if (exists(cand)) out.add(cand);
          }
        }
      }
      // Корень питон-пакета — не обязательно первый сегмент пути:
      // у `api/app/routers/meetings.py` импорты идут от `app`, а не от `api`.
      // Перебираем все сегменты; для неверных регулярка просто не совпадёт.
    }
  }

  if (/\.(ts|tsx|js|jsx|mjs)$/.test(rel)) {
    const dir = path.posix.dirname(rel);
    for (const m of body.matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*from\s+['"](\.[^'"]+)['"]/g)) {
      const base = path.posix.normalize(path.posix.join(dir, m[1]));
      for (const ext of [".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx"]) {
        if (exists(base + ext)) { out.add(base + ext); break; }
      }
    }
  }
  return [...out];
}

function preloadFiles(repoRoot, target, cfg) {
  // Содержимое берётся из ревьюемого коммита, а НЕ из рабочего дерева.
  // Копия пользователя обычно стоит на посторонней ветке: оттуда файл либо
  // не существует, либо, что хуже, существует в другой версии — и ревьюер
  // молча получает не тот код, который правили. Проверено на живом прогоне:
  // один из файлов PR в рабочем дереве просто отсутствовал.
  const mode = cfg.reviewer?.preload_files ?? "changed";
  if (mode === "none" || mode === false) return { text: "", included: [], skipped: [] };
  const capKb = Number(cfg.reviewer?.preload_max_kb ?? 60);
  const budgetKb = Number(cfg.reviewer?.preload_budget_kb ?? 200);

  const paths = (target.files || []).map((f) => f.path ?? f).filter(Boolean);
  const included = [], skipped = [], bodies = [];
  let used = 0;
  const blocks = [];

  const sha = target.head_sha;
  for (const rel of paths) {
    let body = null;
    if (sha) {
      const show = git(repoRoot, ["show", `${sha}:${rel}`]);
      if (show.ok) body = show.stdout;
    }
    if (body === null) {
      // Без SHA (локальная ветка без коммита) — рабочее дерево допустимо.
      const abs = path.join(repoRoot, rel);
      if (!existsSync(abs)) { skipped.push({ path: rel, why: sha ? "нет в ревьюемом коммите" : "нет в рабочем дереве" }); continue; }
      try { body = readFileSync(abs, "utf8"); } catch { skipped.push({ path: rel, why: "не читается" }); continue; }
    }
    const kb = Buffer.byteLength(body, "utf8") / 1024;
    // A 94kB barrel file costs more than it explains; let the reviewer grep it.
    if (kb > capKb) { skipped.push({ path: rel, why: `${Math.round(kb)} КБ > лимита ${capKb} КБ` }); continue; }
    if (used + kb > budgetKb) { skipped.push({ path: rel, why: "исчерпан бюджет вложения" }); continue; }
    used += kb;
    included.push(rel);
    bodies.push(body);
    blocks.push(`<file path="${rel}">\n${body}\n</file>`);
  }

  // Зависимости — только на остаток бюджета и только для первого раунда.
  const deps = [];
  if ((cfg.reviewer?.preload_depth ?? 1) >= 1 && blocks.length) {
    const seen = new Set([...paths, ...included]);
    const candidates = new Set();
    for (const [i, rel] of included.entries()) {
      const body = bodies[i];
      if (!body) continue;
      for (const dep of resolveImports(repoRoot, sha, rel, body)) {
        if (!seen.has(dep)) candidates.add(dep);
      }
    }
    // Порядок важен: бюджет кончается раньше кандидатов. Сначала исходники
    // из тех же каталогов, что и изменённые файлы, потом остальное; данные и
    // тесты — в последнюю очередь, они объёмные и объясняют мало.
    const dirsOfInterest = new Set(included.map((f) => path.posix.dirname(f)));
    const rank = (f) => (
      (/(^|\/)(tests?|__tests__)\//.test(f) || /\.(test|spec)\./.test(f) ? 40 : 0) +
      (/\.(json|md|lock|snap)$/.test(f) ? 30 : 0) +
      (dirsOfInterest.has(path.posix.dirname(f)) ? 0 : 10)
    );
    for (const dep of [...candidates].sort((a, b) => rank(a) - rank(b))) {
      if (used >= budgetKb) break;
      let body = null;
      if (sha) { const show = git(repoRoot, ["show", `${sha}:${dep}`]); if (show.ok) body = show.stdout; }
      if (body === null) continue;
      const kb = Buffer.byteLength(body, "utf8") / 1024;
      if (kb > capKb || used + kb > budgetKb) continue;
      used += kb;
      deps.push(dep);
      blocks.push(`<file path="${dep}" role="import">\n${body}\n</file>`);
    }
  }

  if (!blocks.length) return { text: "", included, deps, skipped };
  const note = skipped.length
    ? `\nНе вложены (открой сам, если понадобятся): ${skipped.map((x) => `${x.path} — ${x.why}`).join("; ")}.`
    : "";
  return {
    text: [
      "<preloaded_files>",
      "Полный текст на ревьюемом коммите. Файлы с role=\"import\" — то, что",
      "изменённые файлы импортируют напрямую.",
      "",
      "НЕ трать ходы на повторное чтение того, что уже здесь: каждый прочитанный",
      "кусок потом едет во всех следующих ходах, и на этом уходит основная часть",
      "стоимости прогона. Читай командами только то, чего здесь нет.",
      "",
      "И это НЕ ограничение области. Половина настоящих дефектов живёт глубже —",
      "у вызывающих, у вызываемых на второй прыжок, в тестах. Туда ходи." + note,
      "",
      ...blocks,
      "</preloaded_files>",
    ].join("\n"),
    included, deps, skipped,
    kb: Math.round(used),
  };
}

function detectStack(repoRoot) {
  // Monorepos keep their manifests one level down (api/, web/, app/, services/),
  // so a root-only probe reports "no stack" for exactly the repos that have
  // several. Look at the root first, then the usual subdirectories.
  const SUBDIRS = ["", "api", "app", "web", "server", "backend", "frontend", "services", "packages"];
  const find = (name) => SUBDIRS
    .map((d) => path.join(repoRoot, d, name))
    .find((f) => existsSync(f));

  const pkgPath = find("package.json");
  const pkg = pkgPath ? readJson(pkgPath) : null;
  const deps = pkg ? { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) } : {};
  const has = (name) => Object.keys(deps).some((d) => d === name || d.startsWith(name + "/"));

  if (has("next") && (has("@supabase") || has("@supabase/supabase-js"))) return "nextjs-supabase";
  if (has("next")) return "nextjs";

  // Python deps live in pyproject.toml, requirements.txt, Pipfile or setup.cfg
  // depending on the project — and a pyproject.toml that only carries pytest
  // config (common) says nothing about the framework. Read whatever is there.
  const pyText = ["pyproject.toml", "requirements.txt", "requirements/base.txt", "Pipfile", "setup.cfg"]
    .map((n) => find(n))
    .filter(Boolean)
    .map((f) => { try { return readFileSync(f, "utf8"); } catch { return ""; } })
    .join("\n");
  if (/^\s*fastapi\b|["']fastapi\b|\bfastapi[><=~\[]/im.test(pyText)) return "fastapi";
  if (/^\s*django\b|["']django\b|\bdjango[><=~\[]/im.test(pyText)) return "django";
  if (/^\s*flask\b|\bflask[><=~\[]/im.test(pyText)) return "flask";

  if (find("go.mod")) return "go";
  return null;
}

function loadStackProfile(pluginRoot, repoRoot, cfg) {
  const configured = cfg.reviewer?.stack_profile;
  if (configured === false || configured === "none") return { name: null, text: "" };
  const name = configured && configured !== "auto" ? configured : detectStack(repoRoot);
  if (!name) return { name: null, text: "" };
  const file = path.join(pluginRoot, "reviewers", "stacks", `${name}.md`);
  // A detected stack with no profile written yet is not an error: the reviewer
  // falls back to the stack-agnostic categories, which is the correct behavior.
  // Report the detection so it is visible that a profile could be added.
  if (!existsSync(file)) return { name: null, text: "", detected: name, no_profile: true };
  return { name, text: readFileSync(file, "utf8") };
}

const OPEN_MARK = "<!--BEGIN-PROMPT-->";
const CLOSE_MARK = "<!--END-PROMPT-->";

/**
 * Pull the response contract out of verdict-contract.md.
 *
 * Deliberately strict. An earlier version split on a single marker, latched
 * onto the marker's own mention in the surrounding prose, and shipped a
 * paragraph of documentation to the reviewer instead of the output format —
 * which turns every round into MALFORMED for a reason nothing points at.
 * A prompt without a contract is worse than no run at all, so this bails.
 */
/**
 * Inline the reviewer's own instructions instead of handing over a path.
 *
 * Measured: 7 of 23 turns in a real run went to reading instruction files —
 * my reviewer skill, my checklist, and (unbidden) the user's older
 * project-specific skills that Codex auto-discovers from ~/.codex/skills.
 * Each of those turns costs a full context re-send, and the auto-discovered
 * ones actively contradicted this prompt's overrides.
 *
 * Markdown links to sibling .md files are inlined one level deep, so the
 * checklist arrives with the skill rather than as another fetch.
 */
function loadReviewerText(skillPath) {
  let text = readFileSync(skillPath, "utf8");
  const dir = path.dirname(skillPath);
  const seen = new Set();
  text = text.replace(/\[([^\]]+)\]\((\.\/)?([\w./-]+\.md)\)/g, (whole, label, _dot, rel) => {
    const target = path.resolve(dir, rel);
    if (seen.has(target) || !existsSync(target)) return label;
    seen.add(target);
    try {
      return `${label} (вложен ниже под заголовком «${rel}»)`;
    } catch { return label; }
  });
  const attachments = [...seen].map((f) =>
    `\n\n<<< ${path.basename(f)} >>>\n${readFileSync(f, "utf8")}`).join("");
  return { text: text + attachments, inlined: [...seen].map((f) => path.basename(f)) };
}

function extractContract(contractPath) {
  if (!existsSync(contractPath)) bail("contract_missing", { path: contractPath });
  const raw = readFileSync(contractPath, "utf8");
  const start = raw.indexOf(OPEN_MARK);
  const end = raw.indexOf(CLOSE_MARK);
  if (start < 0 || end < 0 || end <= start) {
    bail("contract_markers_missing", {
      path: contractPath,
      detail: `нужны маркеры ${OPEN_MARK} … ${CLOSE_MARK} именно в таком порядке`,
    });
  }
  const body = raw.slice(start + OPEN_MARK.length, end).trim();
  // Sanity check on content, not just on markers: the three verdict words are
  // the part the parser actually depends on.
  for (const token of ["ALLOW:", "BLOCK:", "NEEDS_HUMAN:", "SEVERITY"]) {
    if (!body.includes(token)) {
      bail("contract_incomplete", { path: contractPath, missing: token, extracted_bytes: body.length });
    }
  }
  return body;
}

function buildPrompt({ template, reviewerText, target, diff, gate, findings, isDelta, round, cfg, contract, stack, preload }) {
  return template
    .replace("{{RESET_BLOCK}}", round > 1 ? RESET_BLOCK : "")
    .replace("{{REVIEWER_INSTRUCTIONS}}", reviewerText)
    .replace("{{ROUND}}", String(round))
    .replace("{{MODE}}", isDelta
      ? "ПОВТОРНОЕ РЕВЬЮ ПОСЛЕ ПРАВОК. Ниже дельта — только то, что изменилось с прошлого твоего вердикта."
      : "ПЕРВОЕ РЕВЬЮ. Ниже полный дифф изменения.")
    .replace("{{TARGET}}", renderTarget(target))
    .replace("{{GATE}}", renderGate(gate))
    .replace("{{OPEN_FINDINGS}}", renderOpenFindings(findings, cfg))
    .replace("{{OUTPUT_LANGUAGE}}",
      OUTPUT_INSTRUCTION[String(cfg.report?.language || "en").slice(0, 2)] ?? OUTPUT_INSTRUCTION.en)
    .replace("{{FILES}}", preload?.text ?? "")
    .replace("{{DIFF}}", diff)
    .replace("{{BLOCKING}}", (cfg.loop.blocking_severities || []).join(", "))
    .replace("{{STACK_PROFILE}}", stack?.text
      ? `<stack_profile name="${stack.name}">\n${stack.text}\n</stack_profile>`
      : "")
    .replace("{{CONTRACT}}", contract);
}

function main() {
  const args = parseArgs();
  for (const k of ["state", "work", "plugin-root", "round", "diff-file"]) {
    if (!args[k]) bail("arg_missing", { missing: `--${k}` });
  }
  const state = readJson(args.state);
  if (!state) bail("state_unreadable", { path: args.state });
  const cfg = args["config-json"] ? JSON.parse(args["config-json"]) : state.config;
  const round = Number(args.round);

  // A delta review only makes sense once some earlier round actually produced a
  // verdict. A round that ended on a rate limit or a crash committed state
  // without ever reviewing anything — resuming into "delta mode" there would
  // send the reviewer an empty diff and call the result a re-review.
  const hasPriorVerdict = (state.rounds_log || []).some((r) => r.verdict);
  const isDelta = !!args.delta && hasPriorVerdict;
  const deltaDowngraded = !!args.delta && !hasPriorVerdict;
  const pluginRoot = args["plugin-root"];
  const work = ensureDir(path.join(args.work, `round${round}`));

  const templatePath = path.join(pluginRoot, "skills", "review", "references", "review-prompt-template.md");
  const contractPath = path.join(pluginRoot, "skills", "review", "references", "verdict-contract.md");
  if (!existsSync(templatePath)) bail("template_missing", { path: templatePath });
  const template = readFileSync(templatePath, "utf8");
  const contract = extractContract(contractPath);

  const diff = readFileSync(args["diff-file"], "utf8");
  // resolve-target --delta-from кладёт рядом список изменённых в дельте файлов.
  const deltaFileList = args["delta-files"]
    ? String(args["delta-files"]).split(",").map((x) => x.trim()).filter(Boolean)
    : null;
  const stack = loadStackProfile(pluginRoot, state.repo_root, cfg);
  // Вкладываем и в повторных раундах. Казалось бы, файлы уже в треде — но
  // тред живёт только при thread_mode=continue и теряется при любом сбое,
  // а холодный раунд иначе снова вычитывает всё командами. На дельте
  // вкладываем только её файлы и без импортов: контекст задачи узкий.
  const deltaFiles = isDelta
    ? { files: (deltaFileList || []).map((p) => ({ path: p })), head_sha: state.target.head_sha }
    : null;
  const preload = isDelta
    ? preloadFiles(state.repo_root, deltaFiles, { ...cfg, reviewer: { ...cfg.reviewer, preload_depth: 0 } })
    : preloadFiles(state.repo_root, state.target, cfg);

  const panel = (isDelta && round > (cfg.reviewer.panel_rounds ?? 1))
    ? (cfg.reviewer.delta_panel?.length ? cfg.reviewer.delta_panel : cfg.reviewer.panel)
    : cfg.reviewer.panel;

  const members = [];
  const inlinedRefs = [];
  for (const name of panel) {
    const skillPath = cfg.reviewer.skills?.[name] || path.join(pluginRoot, "reviewers", `${name}.md`);
    if (!existsSync(skillPath)) {
      bail("reviewer_skill_missing", { member: name, path: skillPath });
    }
    const promptFile = path.join(work, `${name}.prompt.md`);
    const loaded = loadReviewerText(skillPath);
    inlinedRefs.push(...loaded.inlined);
    writeAtomic(promptFile, buildPrompt({
      template, reviewerText: loaded.text, target: state.target, diff,
      gate: state.gate, findings: state.findings || [], isDelta, round, cfg, contract, stack, preload,
    }));
    members.push({
      name,
      prompt_file: promptFile,
      last_message_file: path.join(work, `${name}.last-message.txt`),
      resume_thread_id: cfg.loop.thread_mode === "continue" ? (state.threads?.[name] ?? null) : null,
    });
  }

  const paramsFile = path.join(work, "params.json");
  const params = {
    repo_root: state.repo_root,
    round,
    is_delta: isDelta,
    thread_mode: cfg.loop.thread_mode,
    reviewer: cfg.reviewer,
    changed_files: (state.target.files || []).map((f) => f.path ?? f),
    members,
  };
  writeAtomic(paramsFile, JSON.stringify(params, null, 2) + "\n");

  emit({
    ok: true,
    params_file: paramsFile,
    work_dir: work,
    panel,
    delta_downgraded_to_full: deltaDowngraded || undefined,
    inlined_references: [...new Set(inlinedRefs)],
    preloaded: preload.included,
    preloaded_deps: preload.deps ?? [],
    preload_skipped: preload.skipped,
    preload_kb: preload.kb ?? 0,
    stack_profile: stack.name,
    stack_detected: stack.detected ?? stack.name ?? null,
    stack_profile_available: !stack.no_profile,
    is_delta: isDelta,
    diff_bytes: diff.length,
    prompt_bytes: members.map((m) => ({ member: m.name, bytes: Buffer.byteLength(readFileSync(m.prompt_file, "utf8"), "utf8") })),
    resuming_threads: members.filter((m) => m.resume_thread_id).map((m) => m.name),
  });
}

main();
