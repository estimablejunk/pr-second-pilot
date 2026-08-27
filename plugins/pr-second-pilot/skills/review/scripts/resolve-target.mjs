// Resolve what is being reviewed: a GitHub PR number, or a local branch
// compared against its base.
//
//   node resolve-target.mjs --repo-root <path> --target 45
//   node resolve-target.mjs --repo-root <path> --target branch [--base main]
//
// For a PR the head SHA comes from GitHub, not from the local checkout — the
// working tree is usually dirty and on some other branch, and reviewing it
// would produce findings about code that is not in the PR at all.

import path from "node:path";
import { emit, fail, bail, parseArgs, run, git, truncate } from "./lib.mjs";

const MAX_DIFF_BYTES = 900_000;

// GitHub hands out TLS handshake timeouts and 5xx often enough that a single
// attempt is not a reliable read. A failed resolve is not cosmetic: the caller
// then has no head SHA, and every downstream default is wrong.
// ETIMEDOUT, а не «timeout»: узел отдаёт код ошибки, а не слово. На живом
// прогоне `spawnSync gh ETIMEDOUT` мимо ретрая и уронил весь раунд.
const TRANSIENT_GH = /TLS handshake timeout|timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|EOF|50[234]|connection reset|temporary failure/i;

function ghJson(repoRoot, args, { attempts = 3 } = {}) {
  let detail = "";
  for (let i = 0; i < attempts; i++) {
    const r = run("gh", args, { cwd: repoRoot, timeout: 30000 });
    if (r.ok) {
      try { return { ok: true, data: JSON.parse(r.stdout) }; }
      catch (e) { return { ok: false, detail: `gh вернул не JSON: ${String(e)}` }; }
    }
    detail = (r.stderr || r.stdout || r.error || "").trim();
    if (!TRANSIENT_GH.test(detail) || i === attempts - 1) break;
    // Короткая пауза: сетевой всплеск обычно проходит за секунды.
    const until = Date.now() + 3000 * (i + 1);
    while (Date.now() < until) { /* busy wait — скрипт синхронный */ }
  }
  return { ok: false, detail, attempts };
}

function detectBase(repoRoot) {
  const head = git(repoRoot, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (head.ok) {
    const m = head.stdout.trim().match(/refs\/remotes\/origin\/(.+)$/);
    if (m) return m[1];
  }
  for (const cand of ["main", "master", "develop"]) {
    if (git(repoRoot, ["rev-parse", "--verify", `refs/heads/${cand}`]).ok) return cand;
  }
  return null;
}

function resolvePr(repoRoot, number) {
  const view = ghJson(repoRoot, [
    "pr", "view", String(number), "--json",
    "number,title,body,state,isDraft,mergeable,baseRefName,headRefName,headRefOid,url,author,additions,deletions,changedFiles,files,statusCheckRollup",
  ]);
  if (!view.ok) return fail("pr_lookup_failed", { detail: view.detail, hint: "gh auth status / правильный ли номер PR" });
  const pr = view.data;

  if (pr.state !== "OPEN") return fail("pr_not_open", { detail: `PR #${number} в состоянии ${pr.state}` });

  // Merge-base against the base branch, so the diff is the PR's own work and
  // not everything that landed on main since the branch was cut.
  const fetch = run("git", ["-C", repoRoot, "fetch", "--quiet", "origin",
    `${pr.baseRefName}`, `pull/${number}/head`], { timeout: 120000 });

  let baseSha = null, diff = null, diffSource = "gh";
  const localHead = git(repoRoot, ["rev-parse", "--verify", pr.headRefOid + "^{commit}"]);
  if (fetch.ok && localHead.ok) {
    const mb = git(repoRoot, ["merge-base", `origin/${pr.baseRefName}`, pr.headRefOid]);
    if (mb.ok) {
      baseSha = mb.stdout.trim();
      const d = git(repoRoot, ["diff", "--no-color", `${baseSha}..${pr.headRefOid}`]);
      if (d.ok) { diff = d.stdout; diffSource = "git(merge-base)"; }
    }
  }
  if (diff === null) {
    const d = run("gh", ["pr", "diff", String(number)], { cwd: repoRoot, timeout: 60000 });
    if (!d.ok) return fail("diff_failed", { detail: d.stderr || d.error });
    diff = d.stdout;
  }

  const checks = (pr.statusCheckRollup || []).map((c) => ({
    name: c.name || c.context,
    status: c.conclusion || c.state,
  }));

  return {
    ok: true,
    target: {
      kind: "pr",
      slug: String(number),
      number: pr.number,
      title: pr.title,
      body: truncate(pr.body || "", 4000),
      url: pr.url,
      author: pr.author?.login ?? null,
      is_draft: pr.isDraft,
      mergeable: pr.mergeable,
      base_ref: pr.baseRefName,
      head_ref: pr.headRefName,
      base_sha: baseSha,
      head_sha: pr.headRefOid,
      files: (pr.files || []).map((f) => ({
        path: f.path, additions: f.additions, deletions: f.deletions, status: f.status ?? null,
      })),
      stats: { additions: pr.additions, deletions: pr.deletions, files: pr.changedFiles },
      checks,
    },
    diff: truncate(diff, MAX_DIFF_BYTES),
    diff_truncated: diff.length > MAX_DIFF_BYTES,
    diff_source: diffSource,
  };
}

function resolveBranch(repoRoot, baseArg) {
  const headRef = git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!headRef.ok) return fail("git_failed", { detail: headRef.stderr });
  const branch = headRef.stdout.trim();
  const base = baseArg || detectBase(repoRoot);
  if (!base) return fail("base_not_found", { detail: "не удалось определить базовую ветку", hint: "передай --base <ветка>" });
  if (branch === base) {
    return fail("on_base_branch", { detail: `HEAD на ${base} — нечего ревьюить`, hint: "переключись на рабочую ветку или укажи --base" });
  }

  const mb = git(repoRoot, ["merge-base", base, "HEAD"]);
  if (!mb.ok) return fail("merge_base_failed", { detail: mb.stderr });
  const baseSha = mb.stdout.trim();
  const headSha = git(repoRoot, ["rev-parse", "HEAD"]).stdout.trim();

  const d = git(repoRoot, ["diff", "--no-color", `${baseSha}..HEAD`]);
  if (!d.ok) return fail("diff_failed", { detail: d.stderr });

  const numstat = git(repoRoot, ["diff", "--numstat", `${baseSha}..HEAD`]);
  const files = numstat.ok ? numstat.stdout.trim().split("\n").filter(Boolean).map((l) => {
    const [add, del, p] = l.split("\t");
    return { path: p, additions: Number(add) || 0, deletions: Number(del) || 0 };
  }) : [];

  const dirty = git(repoRoot, ["status", "--porcelain"]).stdout.trim();

  return {
    ok: true,
    target: {
      kind: "branch",
      slug: branch.replace(/[^A-Za-z0-9._-]+/g, "-"),
      title: `${branch} → ${base}`,
      base_ref: base,
      head_ref: branch,
      base_sha: baseSha,
      head_sha: headSha,
      files,
      stats: {
        additions: files.reduce((a, f) => a + f.additions, 0),
        deletions: files.reduce((a, f) => a + f.deletions, 0),
        files: files.length,
      },
      dirty_worktree: dirty.length > 0,
      checks: [],
    },
    diff: truncate(d.stdout, MAX_DIFF_BYTES),
    diff_truncated: d.stdout.length > MAX_DIFF_BYTES,
    diff_source: "git(merge-base)",
  };
}

/**
 * Diff of everything the fixer changed since the reviewer last looked.
 *
 * `to` matters: for a PR it is the current PR head, not the local HEAD. The
 * working copy is routinely on an unrelated branch, and defaulting to HEAD
 * there produces a diff between two unrelated commits.
 */
function resolveDelta(repoRoot, reviewedSha, to) {
  // Никакого неявного HEAD. Рабочая копия сплошь и рядом стоит на посторонней
  // ветке, и молчаливый откат на неё даёт дифф между двумя несвязанными
  // деревьями — на живом прогоне это обернулось «дельтой» в 1177 файлов,
  // которую ревьюер честно отревьюил как настоящую.
  if (!to) {
    return {
      ok: false,
      detail: "--to не задан",
      hint: "Для PR передай свежую голову PR, для локальной ветки — HEAD явно.",
    };
  }
  const resolved = git(repoRoot, ["rev-parse", "--verify", `${to}^{commit}`]);
  if (!resolved.ok) {
    return { ok: false, detail: `--to=${to} не разрешается в коммит`, hint: resolved.stderr.trim().slice(0, 200) };
  }
  const d = git(repoRoot, ["diff", "--no-color", `${reviewedSha}..${to}`]);
  if (!d.ok) return { ok: false, detail: d.stderr, hint: `не удалось сравнить ${reviewedSha.slice(0,12)}..${to}` };
  const numstat = git(repoRoot, ["diff", "--numstat", `${reviewedSha}..${to}`]);
  const files = numstat.ok ? numstat.stdout.trim().split("\n").filter(Boolean).map((l) => l.split("\t")[2]) : [];
  return {
    ok: true,
    diff: truncate(d.stdout, MAX_DIFF_BYTES),
    files,
    empty: d.stdout.trim().length === 0,
    from_sha: reviewedSha,
    head_sha: git(repoRoot, ["rev-parse", to]).stdout.trim(),
  };
}

function main() {
  const args = parseArgs();
  const repoRoot = path.resolve(args["repo-root"] || process.cwd());
  const target = args.target;
  if (!target) bail("target_missing", { detail: "нужен --target <номер PR|branch>" });

  const root = git(repoRoot, ["rev-parse", "--show-toplevel"]);
  if (!root.ok) return fail("not_a_repo", { detail: repoRoot });
  const realRoot = root.stdout.trim();

  if (args["delta-from"]) {
    // --to is the SHA the reviewer should look at now; for a PR the caller
    // passes the fresh PR head, never the local checkout.
    const r = resolveDelta(realRoot, args["delta-from"], typeof args.to === "string" && args.to ? args.to : null);
    emit(r.ok ? { ok: true, ...r, repo_root: realRoot } : { ok: false, error: "delta_failed", detail: r.detail, hint: r.hint });
    return;
  }

  const result = /^\d+$/.test(String(target))
    ? resolvePr(realRoot, target)
    : resolveBranch(realRoot, args.base);

  emit({ ...result, repo_root: realRoot });
}

main();
