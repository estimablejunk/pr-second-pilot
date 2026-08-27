// Objective checks that run before the reviewer: build, types, lint, tests.
//
// This is the cheapest phase in the loop and the one that saves the most quota.
// A high-effort review of code that does not compile spends a full rate-limit
// slot to report something the compiler already said in two seconds.
//
//   node run-gate.mjs --repo-root <path> [--config-json '<json>']

import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { emit, parseArgs, runAsync, run, readJson, tail } from "./lib.mjs";
import { loadConfig } from "./config.mjs";

const TAIL = 4000;

/** Pick check commands from whatever the repo actually declares. */
function autodetect(repoRoot) {
  const found = [];
  const pkgPath = path.join(repoRoot, "package.json");
  const pkg = readJson(pkgPath);

  if (pkg) {
    const scripts = pkg.scripts || {};
    const pm =
      existsSync(path.join(repoRoot, "pnpm-lock.yaml")) ? "pnpm" :
      existsSync(path.join(repoRoot, "yarn.lock")) ? "yarn" :
      existsSync(path.join(repoRoot, "bun.lockb")) ? "bun" : "npm";
    const call = (s) => (pm === "npm" ? ["npm", "run", s] : [pm, "run", s]);

    for (const [name, candidates] of [
      ["types", ["typecheck", "type-check", "tsc"]],
      ["lint", ["lint"]],
      ["build", ["build"]],
      ["tests", ["test", "test:unit"]],
    ]) {
      const hit = candidates.find((c) => scripts[c]);
      if (hit) found.push({ name, cmd: call(hit), optional: name === "build" });
    }
    if (!found.some((f) => f.name === "types") && existsSync(path.join(repoRoot, "tsconfig.json"))) {
      found.push({ name: "types", cmd: ["npx", "--no-install", "tsc", "--noEmit"] });
    }
  }

  if (existsSync(path.join(repoRoot, "pyproject.toml"))) {
    const toml = readFileSync(path.join(repoRoot, "pyproject.toml"), "utf8");
    if (/\[tool\.ruff/.test(toml)) found.push({ name: "lint", cmd: ["ruff", "check", "."] });
    if (/\[tool\.mypy/.test(toml)) found.push({ name: "types", cmd: ["mypy", "."] });
    if (/pytest/.test(toml)) found.push({ name: "tests", cmd: ["pytest", "-q"] });
  }

  if (existsSync(path.join(repoRoot, "Cargo.toml"))) {
    found.push({ name: "build", cmd: ["cargo", "check", "--quiet"] });
    found.push({ name: "tests", cmd: ["cargo", "test", "--quiet"] });
  }
  if (existsSync(path.join(repoRoot, "go.mod"))) {
    found.push({ name: "build", cmd: ["go", "build", "./..."] });
    found.push({ name: "tests", cmd: ["go", "test", "./..."] });
  }

  // One entry per name; first detection wins.
  const seen = new Set();
  return found.filter((f) => (seen.has(f.name) ? false : seen.add(f.name)));
}

const CI_DONE = ["SUCCESS", "FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "SKIPPED", "NEUTRAL", "ACTION_REQUIRED", "STALE"];
const CI_BAD = ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"];

function readCiChecks(repoRoot, prNumber) {
  const r = run("gh", ["pr", "view", String(prNumber), "--json", "statusCheckRollup"],
    { cwd: repoRoot, timeout: 45000 });
  if (!r.ok) return { ok: false, detail: (r.stderr || r.stdout || "").trim().slice(0, 400) };
  try {
    const rollup = JSON.parse(r.stdout).statusCheckRollup || [];
    return {
      ok: true,
      checks: rollup.map((c) => ({
        name: c.name || c.context || "check",
        conclusion: (c.conclusion || c.state || "").toUpperCase(),
        link: c.detailsUrl || c.targetUrl || null,
      })),
    };
  } catch (e) { return { ok: false, detail: String(e) }; }
}

/**
 * For repos whose test suite needs live services (Postgres, Redis, browsers),
 * the honest gate is CI, not a local run that cannot start them. Poll until no
 * check is still in flight, then report the same shape a local gate reports.
 */
async function ciGate(repoRoot, prNumber, waitMinutes, headSha) {
  const deadline = Date.now() + Math.max(0, waitMinutes) * 60_000;
  let consecutiveErrors = 0;
  let lastError = null;
  for (;;) {
    const last = readCiChecks(repoRoot, prNumber);
    if (!last.ok) {
      // A poll loop must survive a flaky call. GitHub hands out TLS timeouts
      // and 502s regularly; treating the first one as "CI unavailable" throws
      // away the whole wait window over a hiccup. Give up only after several
      // failures in a row, or when the window closes.
      consecutiveErrors += 1;
      lastError = last.detail;
      if (consecutiveErrors >= 4 || Date.now() >= deadline) {
        return { checks: [], error: lastError, attempts: consecutiveErrors };
      }
      await new Promise((r) => setTimeout(r, 15_000));
      continue;
    }
    consecutiveErrors = 0;
    const pending = last.checks.filter((c) => !CI_DONE.includes(c.conclusion));
    if (!pending.length || Date.now() >= deadline) {
      return { checks: last.checks, timed_out: pending.length > 0, pending: pending.map((c) => c.name) };
    }
    await new Promise((r) => setTimeout(r, 30_000));
  }
}

function normalize(entry) {
  if (Array.isArray(entry.cmd)) return entry;
  if (typeof entry.cmd === "string") {
    // A configured string command goes through the shell so users can write
    // pipes and && chains the way they would in a terminal.
    return { ...entry, cmd: ["/bin/sh", "-c", entry.cmd], shell: true };
  }
  return null;
}

async function main() {
  const args = parseArgs();
  const repoRoot = path.resolve(args["repo-root"] || process.cwd());
  const cfg = args["config-json"]
    ? JSON.parse(args["config-json"])
    : loadConfig(repoRoot).config;
  const gate = cfg.gate || {};

  if (gate.enabled === false) {
    emit({ ok: true, skipped: true, reason: "gate.enabled=false", checks: [] });
    return;
  }

  const source = gate.source || "local";
  let ciChecks = [];
  if ((source === "ci" || source === "both") && args.pr) {
    const ci = await ciGate(repoRoot, args.pr, Number(gate.ci_wait_minutes ?? 0), args["head-sha"]);
    if (ci.error) {
      emit({ ok: false, source, error: "ci_unavailable", detail: ci.error, checks: [] });
      return;
    }
    ciChecks = ci.checks.map((c) => ({
      name: `ci:${c.name}`,
      command: c.link || "GitHub Actions",
      status: CI_BAD.includes(c.conclusion) ? "fail"
        : CI_DONE.includes(c.conclusion) ? (c.conclusion === "SUCCESS" ? "pass" : "skipped")
        : "pending",
      // «non-blocking» в имени — про lint, но такая джоба часто тащит рядом
      // сборку и юнит-тесты. Живой прогон: `app · lint (non-blocking) + build`
      // упал на юнит-тесте, а гейт отрапортовал «CI зелёный» и пустил раунд
      // дальше. Необязательной считаем только ту, где НЕТ признаков сборки или
      // тестов.
      optional: /non-blocking/i.test(c.name) && !/\b(build|test|pytest|vitest|jest)\b/i.test(c.name),
      output: "",
    }));
    if (source === "ci") {
      const blocking = ciChecks.filter((c) => (c.status === "fail" || c.status === "pending") && !c.optional);
      // Падение необязательной джобы не блокирует, но замолчать его нельзя:
      // человек должен увидеть, что что-то красное, даже если цикл едет дальше.
      const failedOptional = ciChecks.filter((c) => c.status === "fail" && c.optional);
      emit({
        ok: blocking.length === 0,
        source: "ci",
        checks: ciChecks,
        blocking: blocking.map((c) => c.name),
        failed_optional: failedOptional.map((c) => c.name),
        timed_out: ci.timed_out ?? false,
        still_pending: ci.pending ?? [],
        summary: ciChecks.map((c) => `${c.name}:${c.status}`).join(" "),
      });
      return;
    }
  }

  let entries = (gate.commands || []).map(normalize).filter(Boolean);
  let detected = false;
  if (entries.length === 0 && gate.autodetect !== false) {
    entries = autodetect(repoRoot).map(normalize).filter(Boolean);
    detected = true;
  }

  if (entries.length === 0) {
    emit({
      ok: true, skipped: true, checks: [],
      reason: "не нашлось ни одной проверки",
      hint: "задай gate.commands, например [{\"name\":\"tests\",\"cmd\":\"npm test\"}]",
    });
    return;
  }

  const timeoutMs = (gate.timeout_minutes || 15) * 60_000;
  const checks = [];
  for (const e of entries) {
    const [cmd, ...cmdArgs] = e.cmd;
    const r = await runAsync(cmd, cmdArgs, { cwd: repoRoot, timeoutMs });
    const notInstalled = r.code === -1 && /ENOENT/.test(r.error || "");
    checks.push({
      name: e.name,
      command: e.shell ? e.cmd[2] : e.cmd.join(" "),
      status: notInstalled ? "unavailable" : r.ok ? "pass" : r.error === "timeout" ? "timeout" : "fail",
      seconds: r.seconds,
      optional: !!e.optional,
      // Tail, not head: compilers and test runners put the verdict at the end.
      output: r.ok ? "" : tail((r.stdout + "\n" + r.stderr).trim(), TAIL),
    });
  }

  const all = [...ciChecks, ...checks];
  const blocking = all.filter((c) => ["fail", "timeout", "pending"].includes(c.status)).filter((c) => !c.optional);
  emit({
    ok: blocking.length === 0,
    source,
    autodetected: detected,
    checks: all,
    blocking: blocking.map((c) => c.name),
    summary: all.map((c) => `${c.name}:${c.status}`).join(" "),
  });
}

main();
