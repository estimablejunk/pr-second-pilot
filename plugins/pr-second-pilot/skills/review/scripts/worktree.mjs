// Give the fixer a checkout of the reviewed code without touching the user's
// working copy.
//
// People keep uncommitted work on an unrelated branch — that is the normal
// state of a working repository, not an edge case. Checking out the PR branch
// underneath them would be destructive, so the fixer gets its own worktree.
//
// Worktrees are detached at the reviewed SHA and pushed explicitly to the PR
// branch, so several sessions can work on the same branch without git refusing
// ("branch is already checked out in another worktree").
//
//   node worktree.mjs --add    --repo-root <p> --slug 417 --sha <sha>
//   node worktree.mjs --remove --repo-root <p> --slug 417
//   node worktree.mjs --list   --repo-root <p>
//   node worktree.mjs --prune  --repo-root <p> [--force]

import path from "node:path";
import { existsSync, symlinkSync, rmSync } from "node:fs";
import {
  emit, bail, parseArgs, run, git, ensureDir, USER_CONFIG_DIR,
} from "./lib.mjs";

export const WORKTREE_ROOT = path.join(USER_CONFIG_DIR, "worktrees");

function worktreePath(repoRoot, slug) {
  return path.join(WORKTREE_ROOT, path.basename(repoRoot), String(slug));
}

function listWorktrees(repoRoot) {
  const r = git(repoRoot, ["worktree", "list", "--porcelain"]);
  if (!r.ok) return [];
  const out = [];
  let cur = null;
  for (const line of r.stdout.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) { if (cur) out.push(cur); cur = { path: line.slice(9) }; }
    else if (line.startsWith("HEAD ")) cur.head = line.slice(5);
    else if (line.startsWith("branch ")) cur.branch = line.slice(7).replace("refs/heads/", "");
    else if (line === "detached") cur.detached = true;
    else if (line === "prunable" || line.startsWith("prunable ")) cur.prunable = true;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Link the heavyweight dependency directories from the main checkout instead of
 * reinstalling them. Saves minutes and gigabytes; safe because the fixer never
 * writes into them.
 */
const LINKABLE = ["node_modules", "app/node_modules", "web/node_modules", "api/.venv"];

/**
 * Незакоммиченные правки в каталоге — но не те, что мы сами туда положили.
 *
 * linkDeps создаёт симлинки на зависимости; git видит их как untracked, и
 * проверка «грязный ли каталог» срабатывала на собственном мусоре плагина.
 * Итог: он отказывался убирать за собой из-за того, что сам же и сделал.
 */
function foreignChanges(wt) {
  const r = git(wt, ["status", "--porcelain"]);
  if (!r.ok) return [];
  const ours = new Set(LINKABLE);
  return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean).filter((line) => {
    const p = line.replace(/^\S+\s+/, "").replace(/\/$/, "");
    return !ours.has(p);
  });
}

function linkDeps(repoRoot, wt) {
  const linked = [];
  for (const rel of LINKABLE) {
    const src = path.join(repoRoot, rel);
    const dst = path.join(wt, rel);
    if (!existsSync(src) || existsSync(dst)) continue;
    try { symlinkSync(src, dst); linked.push(rel); } catch { /* optional */ }
  }
  return linked;
}

function add(repoRoot, slug, sha) {
  const wt = worktreePath(repoRoot, slug);
  ensureDir(path.dirname(wt));

  const existing = listWorktrees(repoRoot).find((w) => w.path === wt);
  if (existing) {
    if (existing.head === sha) {
      return { ok: true, path: wt, reused: true, head: sha };
    }
    // Reused worktree pointing somewhere else: move it, but never over
    // uncommitted work.
    const dirty = foreignChanges(wt);
    if (dirty.length) {
      return {
        ok: false, error: "worktree_dirty", path: wt, changes: dirty.slice(0, 10),
        detail: "В рабочем каталоге есть незакоммиченные правки — не перезаписываю. Разберись руками или удали его через --remove.",
      };
    }
    const co = git(wt, ["checkout", "--detach", sha]);
    if (!co.ok) return { ok: false, error: "checkout_failed", detail: co.stderr.trim().slice(0, 400) };
    return { ok: true, path: wt, reused: true, moved: true, head: sha, linked: linkDeps(repoRoot, wt) };
  }

  // --detach on purpose: the same branch may be checked out elsewhere, and git
  // refuses a second checkout of it.
  const r = git(repoRoot, ["worktree", "add", "--quiet", "--detach", wt, sha]);
  if (!r.ok) return { ok: false, error: "worktree_add_failed", detail: r.stderr.trim().slice(0, 600) };
  return { ok: true, path: wt, created: true, head: sha, linked: linkDeps(repoRoot, wt) };
}

function remove(repoRoot, slug, force) {
  const wt = worktreePath(repoRoot, slug);
  if (!existsSync(wt)) {
    git(repoRoot, ["worktree", "prune"]);
    return { ok: true, removed: false, reason: "not_present" };
  }
  const dirty = foreignChanges(wt);
  if (!force && dirty.length) {
    return {
      ok: false, error: "worktree_dirty", path: wt,
      changes: dirty.slice(0, 10), count: dirty.length,
      detail: "Есть незакоммиченные правки. Передай --force, если они точно не нужны.",
    };
  }
  const r = git(repoRoot, ["worktree", "remove", ...(force ? ["--force"] : []), wt]);
  if (!r.ok) {
    rmSync(wt, { recursive: true, force: true });
    git(repoRoot, ["worktree", "prune"]);
    return { ok: true, removed: true, path: wt, fallback: "удалён каталогом + prune" };
  }
  return { ok: true, removed: true, path: wt };
}

function main() {
  const args = parseArgs();
  const repoRoot = args["repo-root"];
  if (!repoRoot) bail("arg_missing", { missing: "--repo-root" });

  if (args.list) {
    const all = listWorktrees(repoRoot);
    emit({
      ok: true,
      total: all.length,
      ours: all.filter((w) => w.path.startsWith(WORKTREE_ROOT)),
      prunable: all.filter((w) => w.prunable).map((w) => w.path),
      root: WORKTREE_ROOT,
    });
    return;
  }

  if (args.prune) {
    const before = listWorktrees(repoRoot);
    const stale = before.filter((w) => w.prunable);
    const r = git(repoRoot, ["worktree", "prune", ...(args.force ? ["--expire", "now"] : [])]);
    emit({
      ok: r.ok,
      pruned: stale.map((w) => w.path),
      count: stale.length,
      remaining: listWorktrees(repoRoot).length,
      note: "Убираются только записи о несуществующих каталогах — рабочие worktree не трогаются.",
    });
    return;
  }

  if (!args.slug) bail("arg_missing", { missing: "--slug" });

  if (args.remove) { emit(remove(repoRoot, args.slug, !!args.force)); return; }

  if (args.add) {
    if (!args.sha) bail("arg_missing", { missing: "--sha" });
    emit(add(repoRoot, args.slug, args.sha));
    return;
  }

  bail("no_action", { detail: "нужен один из --add --remove --list --prune" });
}

main();
