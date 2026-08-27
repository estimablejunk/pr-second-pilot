// Create or resume the state for one target, and make sure the report folder
// never lands in the PR being reviewed.
//
// The default exclusion goes into .git/info/exclude, not .gitignore: the
// tracked .gitignore would show up as a change inside the very diff under
// review, which is both noise and a finding waiting to happen.
//
//   node init.mjs --repo-root <p> --target 45 --target-json <file> [--config-json '<json>'] --session <id>

import path from "node:path";
import { existsSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import {
  emit, bail, parseArgs, readJson, writeJsonAtomic, writeAtomic, ensureDir,
  targetPaths, nowIso, git,
} from "./lib.mjs";
import { loadConfig } from "./config.mjs";

const EXCLUDE_MARK = "# pr-second-pilot";

function ensureExcluded(repoRoot, reportDir, how) {
  if (how === "none") return { method: "none", changed: false };

  if (how === "gitignore") {
    const p = path.join(repoRoot, ".gitignore");
    const cur = existsSync(p) ? readFileSync(p, "utf8") : "";
    if (cur.includes(`${reportDir}/`)) return { method: "gitignore", changed: false, path: p };
    appendFileSync(p, `${cur && !cur.endsWith("\n") ? "\n" : ""}${EXCLUDE_MARK}\n${reportDir}/\n`, "utf8");
    return { method: "gitignore", changed: true, path: p,
      warning: ".gitignore отслеживается — эта правка попадёт в дифф ревьюируемого PR." };
  }

  const gitDir = git(repoRoot, ["rev-parse", "--git-dir"]);
  if (!gitDir.ok) return { method: "git-exclude", changed: false, error: "не удалось определить .git" };
  const excludePath = path.resolve(repoRoot, gitDir.stdout.trim(), "info", "exclude");
  ensureDir(path.dirname(excludePath));
  const cur = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
  if (cur.includes(`${reportDir}/`)) return { method: "git-exclude", changed: false, path: excludePath };
  writeFileSync(excludePath, `${cur}${cur && !cur.endsWith("\n") ? "\n" : ""}${EXCLUDE_MARK}\n${reportDir}/\n`, "utf8");
  return { method: "git-exclude", changed: true, path: excludePath };
}

function main() {
  const args = parseArgs();
  for (const k of ["repo-root", "target-json", "session"]) {
    if (!args[k]) bail("arg_missing", { missing: `--${k}` });
  }
  const repoRoot = path.resolve(args["repo-root"]);
  const resolved = readJson(args["target-json"]);
  if (!resolved?.ok) bail("target_unresolved", { detail: resolved?.error ?? "resolve-target не отдал ok" });

  const overrides = args["config-json"] ? JSON.parse(args["config-json"]) : {};
  const { config, sources, warnings, user_config, project_config } = loadConfig(repoRoot, overrides);

  const slug = resolved.target.slug;
  const paths = targetPaths(repoRoot, config.report.dir, slug);
  ensureDir(paths.reportDir);
  ensureDir(paths.stateDir);
  ensureDir(paths.work);

  const exclusion = ensureExcluded(repoRoot, config.report.dir, config.report.exclude_via);
  // Belt and braces: a self-ignoring folder survives someone force-adding it.
  const selfIgnore = path.join(paths.reportDir, ".gitignore");
  if (!existsSync(selfIgnore)) writeAtomic(selfIgnore, "*\n");

  const existing = readJson(paths.state);
  const resuming = !!existing;

  if (resuming) {
    // Head moved since the last round — that is normal (the fixer committed),
    // but the target metadata must be refreshed so the report is not stale.
    existing.target = { ...existing.target, ...resolved.target };
    existing.config = config;
    existing.updated_at = nowIso();
    existing.paths = paths;
    existing.session = args.session;
    writeJsonAtomic(paths.state, existing);
    emit({
      ok: true, resumed: true, state_path: paths.state, paths, slug,
      round: existing.round, status: existing.status,
      reviewed_sha: existing.reviewed_sha ?? null,
      head_sha: resolved.target.head_sha,
      head_moved: existing.reviewed_sha && existing.reviewed_sha !== resolved.target.head_sha,
      counts: existing.counts ?? null,
      config_warnings: warnings, exclusion,
    });
    return;
  }

  const state = {
    version: 1,
    slug,
    repo_root: repoRoot,
    session: args.session,
    created_at: nowIso(),
    updated_at: nowIso(),
    status: "in_review",
    round: 0,
    reviewed_sha: null,
    prev_blocking: null,
    target: resolved.target,
    gate: null,
    findings: [],
    counts: null,
    history: [],
    rounds_log: [],
    human_questions: [],
    threads: {},
    fixer_session_id: null,
    config,
    config_sources: sources,
    paths,
  };
  writeJsonAtomic(paths.state, state);

  emit({
    ok: true, resumed: false, state_path: paths.state, paths, slug,
    round: 0,
    target_kind: resolved.target.kind,
    head_sha: resolved.target.head_sha,
    config_warnings: warnings,
    config_sources: { user: user_config, project: project_config },
    exclusion,
    plan: {
      reviewer: `${config.reviewer.model} · effort=${config.reviewer.effort} · ${config.reviewer.panel.join(" + ")}`,
      fixer: config.fixer.mode === "inherit" ? "inherit (текущая сессия)" : `${config.fixer.model} · effort=${config.fixer.effort}`,
      max_rounds: Math.min(config.loop.max_rounds, config.loop.hard_cap),
      blocking: config.loop.blocking_severities.join(", "),
    },
  });
}

main();
