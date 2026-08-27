// Merge the PR after the loop allows it — but only when every rule permits it.
//
// This is the one action in the whole plugin that is outward-facing and hard to
// undo, so it is built as a deny-list evaluated against live GitHub state, not
// as a step that trusts the loop's own verdict. The loop says the code is fine;
// GitHub says whether merging is permitted. Both must agree.
//
// The rule that matters most: the head SHA must still equal the SHA the
// reviewer actually judged. Anything pushed after the review was never
// reviewed, and merging it would launder unreviewed code through an approval.
//
//   node merge-pr.mjs --state <path> [--dry-run] [--config-json '<json>']

import { emit, bail, parseArgs, readJson, run, nowIso } from "./lib.mjs";

const METHOD_FLAG = { squash: "--squash", merge: "--merge", rebase: "--rebase" };

function ghJson(repoRoot, args) {
  const r = run("gh", args, { cwd: repoRoot, timeout: 30000 });
  if (!r.ok) return { ok: false, detail: (r.stderr || r.stdout || r.error || "").trim() };
  try { return { ok: true, data: JSON.parse(r.stdout) }; }
  catch (e) { return { ok: false, detail: `gh вернул не JSON: ${e}` }; }
}

/**
 * Every rule returns null when it permits the merge, or a blocker object.
 * Order is diagnostic only — all rules are evaluated so the report can list
 * everything that stands in the way, not just the first thing.
 */
export function evaluateRules({ state, pr, cfg, threads, protection }) {
  const m = cfg.merge || {};
  const blockers = [];
  const add = (rule, detail, fixable = false) => blockers.push({ rule, detail, fixable });

  // --- what the plugin itself decided ------------------------------------
  if (m.enabled === false) {
    add("merge.disabled", "Автомерж выключен в настройках (merge.enabled=false).");
  }
  if (state.target.kind !== "pr") {
    add("not_a_pr", "Цель — локальная ветка, а не PR. Мержить нечего.");
  }
  const blocking = state.counts?.blocking ?? 0;
  if (blocking > 0) {
    add("open_blockers", `Осталось блокирующих замечаний: ${blocking}.`);
  }
  const openDisputes = (state.findings || []).filter((f) => f.status === "disputed");
  if (openDisputes.length) {
    add("open_disputes", `Неразрешённые споры: ${openDisputes.map((f) => f.id).join(", ")}.`);
  }
  if (state.human_questions?.length && m.forbid_with_open_questions !== false) {
    add("open_questions", `Есть вопросы к человеку без ответа: ${state.human_questions.length}.`);
  }
  if (m.require_clean_gate !== false && state.gate && state.gate.ok === false) {
    add("gate_red", `Объективные проверки красные: ${(state.gate.blocking || []).join(", ")}.`);
  }
  const advisoryCap = m.max_advisory ?? null;
  if (advisoryCap !== null && (state.counts?.advisory ?? 0) > advisoryCap) {
    add("too_many_advisory", `Необязательных замечаний ${state.counts.advisory}, лимит ${advisoryCap}.`);
  }

  if (!pr) return blockers;

  // --- what GitHub says ---------------------------------------------------
  if (pr.state !== "OPEN") add("pr_not_open", `PR в состоянии ${pr.state}.`);
  if (pr.isDraft) add("draft", "PR в статусе draft.");

  // The heart of it: never merge a SHA nobody reviewed.
  if (state.reviewed_sha && pr.headRefOid !== state.reviewed_sha) {
    add("head_moved",
      `Голова сдвинулась после ревью: ревьюили ${state.reviewed_sha.slice(0, 12)}, ` +
      `сейчас ${pr.headRefOid.slice(0, 12)}. Этот код никто не смотрел.`, true);
  }

  if (pr.mergeable === "CONFLICTING") add("conflicts", "Есть конфликты с базовой веткой.");
  if (pr.mergeable === "UNKNOWN") add("mergeable_unknown", "GitHub ещё не посчитал mergeable. Повтори через минуту.", true);

  const st = pr.mergeStateStatus;
  if (st === "BLOCKED") add("branch_protection", "Правила защиты ветки не выполнены (mergeStateStatus=BLOCKED).");
  if (st === "DIRTY") add("dirty", "mergeStateStatus=DIRTY — конфликты или неготовность.");
  if (st === "BEHIND" && m.allow_behind !== true) {
    add("behind_base", "Ветка отстала от базовой; правила требуют обновления.", true);
  }

  // A human asking for changes outranks anything two models agreed on.
  if (pr.reviewDecision === "CHANGES_REQUESTED") {
    add("changes_requested", "Человек запросил изменения в review.");
  }
  if (pr.reviewDecision === "REVIEW_REQUIRED" && m.allow_without_approval !== true) {
    add("approval_required", "Правила репозитория требуют апрува, которого нет.");
  }

  if (m.require_all_checks !== false) {
    const checks = pr.statusCheckRollup || [];
    const bad = checks.filter((c) => {
      const s = c.conclusion || c.state || "";
      return ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"].includes(s);
    });
    const pending = checks.filter((c) => {
      const s = c.conclusion || c.state || "";
      return ["PENDING", "QUEUED", "IN_PROGRESS", "EXPECTED", ""].includes(s);
    });
    if (bad.length) add("checks_failed", `Проверки упали: ${bad.map((c) => c.name || c.context).join(", ")}.`);
    if (pending.length) add("checks_pending", `Проверки ещё идут: ${pending.map((c) => c.name || c.context).join(", ")}.`, true);
  }

  if (threads?.length && m.forbid_with_unresolved_threads !== false) {
    add("unresolved_threads", `Неразрешённых тредов в PR: ${threads.length}.`);
  }

  if (protection?.required_signatures) add("signatures_required", "Ветка требует подписанных коммитов.");

  // Labels the user marks as "hands off".
  const labels = (pr.labels || []).map((l) => (l.name || "").toLowerCase());
  for (const forbidden of (m.forbid_labels || ["do-not-merge", "wip", "on-hold", "не мержить"])) {
    if (labels.includes(forbidden.toLowerCase())) add("forbidden_label", `На PR метка «${forbidden}».`);
  }

  const paths = (state.target.files || []).map((f) => f.path ?? f);
  for (const pattern of (m.forbid_paths || [])) {
    const hit = paths.filter((p) => p.includes(pattern));
    if (hit.length) add("forbidden_path", `Затронуты защищённые пути (${pattern}): ${hit.slice(0, 5).join(", ")}.`);
  }

  const base = state.target.base_ref;
  const allowedBases = m.allow_base_branches ?? null;
  if (allowedBases && !allowedBases.includes(base)) {
    add("base_not_allowed", `Мерж в «${base}» не разрешён настройками (allow_base_branches: ${allowedBases.join(", ")}).`);
  }

  return blockers;
}

function pickMethod(repoRoot, pr, configured) {
  if (configured && configured !== "auto") return configured;
  const repo = ghJson(repoRoot, ["repo", "view", "--json", "squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed"]);
  if (!repo.ok) return "squash";
  if (repo.data.squashMergeAllowed) return "squash";
  if (repo.data.mergeCommitAllowed) return "merge";
  if (repo.data.rebaseMergeAllowed) return "rebase";
  return "squash";
}


// ------------------------------------------------------------- self-test ---

function selfTest() {
  const okState = {
    target: { kind: "pr", number: 7, base_ref: "main", files: [{ path: "src/a.ts" }] },
    reviewed_sha: "abc123", counts: { blocking: 0, advisory: 0 },
    findings: [], human_questions: [], gate: { ok: true },
  };
  const okPr = {
    state: "OPEN", isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED", headRefOid: "abc123", labels: [],
    statusCheckRollup: [{ name: "ci", conclusion: "SUCCESS" }],
  };
  const cfg = { merge: {}, loop: {} };
  const rules = (over = {}, prOver = {}, cfgOver = {}) => evaluateRules({
    state: { ...okState, ...over },
    pr: { ...okPr, ...prOver },
    cfg: { ...cfg, ...cfgOver },
    threads: over.__threads ?? [],
  }).map((b) => b.rule);

  const c = [];
  c.push(["чистый случай разрешён", rules().length === 0]);
  c.push(["голова сдвинулась", rules({}, { headRefOid: "def456" }).includes("head_moved")]);
  c.push(["draft", rules({}, { isDraft: true }).includes("draft")]);
  c.push(["закрытый PR", rules({}, { state: "MERGED" }).includes("pr_not_open")]);
  c.push(["конфликты", rules({}, { mergeable: "CONFLICTING" }).includes("conflicts")]);
  c.push(["защита ветки", rules({}, { mergeStateStatus: "BLOCKED" }).includes("branch_protection")]);
  c.push(["человек просит правок", rules({}, { reviewDecision: "CHANGES_REQUESTED" }).includes("changes_requested")]);
  c.push(["нужен апрув", rules({}, { reviewDecision: "REVIEW_REQUIRED" }).includes("approval_required")]);
  c.push(["апрув можно отключить", !rules({}, { reviewDecision: "REVIEW_REQUIRED" },
    { merge: { allow_without_approval: true } }).includes("approval_required")]);
  c.push(["упавшая проверка", rules({}, { statusCheckRollup: [{ name: "ci", conclusion: "FAILURE" }] }).includes("checks_failed")]);
  c.push(["идущая проверка", rules({}, { statusCheckRollup: [{ name: "ci", conclusion: "IN_PROGRESS" }] }).includes("checks_pending")]);
  c.push(["блокеры цикла", rules({ counts: { blocking: 1 } }).includes("open_blockers")]);
  c.push(["красный gate", rules({ gate: { ok: false, blocking: ["t"] } }).includes("gate_red")]);
  c.push(["спор открыт", rules({ findings: [{ id: "x", status: "disputed" }] }).includes("open_disputes")]);
  c.push(["вопрос человеку", rules({ human_questions: [{ question: "q" }] }).includes("open_questions")]);
  c.push(["метка запрета", rules({}, { labels: [{ name: "do-not-merge" }] }).includes("forbidden_label")]);
  c.push(["неразрешённый тред", rules({ __threads: [{ isResolved: false }] }).includes("unresolved_threads")]);
  c.push(["запрещённый путь", rules({}, {}, { merge: { forbid_paths: ["src/"] } }).includes("forbidden_path")]);
  c.push(["база не разрешена", rules({}, {}, { merge: { allow_base_branches: ["develop"] } }).includes("base_not_allowed")]);
  c.push(["мерж выключен", rules({}, {}, { merge: { enabled: false } }).includes("merge.disabled")]);
  c.push(["ветка отстала", rules({}, { mergeStateStatus: "BEHIND" }).includes("behind_base")]);
  c.push(["head_moved помечен fixable", evaluateRules({
    state: okState, pr: { ...okPr, headRefOid: "zzz" }, cfg, threads: [],
  }).find((b) => b.rule === "head_moved").fixable === true]);
  c.push(["блокеры собираются все, а не первый", evaluateRules({
    state: { ...okState, counts: { blocking: 3 }, gate: { ok: false, blocking: ["t"] } },
    pr: { ...okPr, isDraft: true }, cfg, threads: [],
  }).length >= 3]);

  const failed = c.filter(([, ok]) => !ok);
  emit({ ok: failed.length === 0, total: c.length, failed: failed.map(([n]) => n) });
  process.exit(failed.length ? 1 : 0);
}

function main() {
  const args = parseArgs();
  if (args["self-test"]) return selfTest();
  if (!args.state) bail("arg_missing", { missing: "--state" });
  const state = readJson(args.state);
  if (!state) bail("state_unreadable", { path: args.state });
  const cfg = args["config-json"] ? JSON.parse(args["config-json"]) : state.config;
  const repoRoot = state.repo_root;
  const number = state.target?.number;

  let pr = null, threads = [], protection = null;
  if (state.target.kind === "pr" && number) {
    const view = ghJson(repoRoot, [
      "pr", "view", String(number), "--json",
      "number,url,state,isDraft,mergeable,mergeStateStatus,reviewDecision,headRefOid,baseRefName,labels,statusCheckRollup",
    ]);
    if (!view.ok) {
      emit({ ok: false, merged: false, error: "pr_lookup_failed", detail: view.detail });
      return;
    }
    pr = view.data;

    // Unresolved conversations are not in the pr view payload; ask GraphQL.
    const q = run("gh", ["api", "graphql", "-f", `query=
      query($owner:String!,$repo:String!,$n:Int!){
        repository(owner:$owner,name:$repo){
          pullRequest(number:$n){
            reviewThreads(first:100){nodes{isResolved isOutdated}}
          }}}`,
      "-F", "n=" + number, "-f", "owner=:owner", "-f", "repo=:repo"],
      { cwd: repoRoot, timeout: 30000 });
    if (q.ok) {
      try {
        const nodes = JSON.parse(q.stdout).data.repository.pullRequest.reviewThreads.nodes || [];
        threads = nodes.filter((t) => !t.isResolved && !t.isOutdated);
      } catch { /* threads stay empty; not a reason to block */ }
    }
  }

  const blockers = evaluateRules({ state, pr, cfg, threads, protection });
  const allowed = blockers.length === 0;

  if (!allowed) {
    emit({
      ok: true, merged: false, allowed: false,
      blockers,
      summary: `Мерж запрещён ${blockers.length === 1 ? "правилом" : "правилами"}: ${blockers.map((b) => b.rule).join(", ")}.`,
      retryable: blockers.every((b) => b.fixable),
      pr_url: pr?.url ?? null,
    });
    return;
  }

  const method = pickMethod(repoRoot, pr, cfg.merge?.method);

  if (args["dry-run"]) {
    emit({
      ok: true, merged: false, allowed: true, dry_run: true,
      method,
      would_run: `gh pr merge ${number} --${method}${cfg.merge?.delete_branch !== false ? " --delete-branch" : ""}`,
      head_sha: pr.headRefOid, pr_url: pr.url,
    });
    return;
  }

  const mergeArgs = ["pr", "merge", String(number), METHOD_FLAG[method] || "--squash"];
  if (cfg.merge?.delete_branch !== false) mergeArgs.push("--delete-branch");
  // Pin the merge to the SHA we validated: if anything lands between the rule
  // check and this call, GitHub refuses instead of merging the newer code.
  mergeArgs.push("--match-head-commit", pr.headRefOid);
  if (cfg.merge?.admin === true) mergeArgs.push("--admin");
  if (cfg.merge?.body) mergeArgs.push("--body", cfg.merge.body);

  const r = run("gh", mergeArgs, { cwd: repoRoot, timeout: 120000 });
  if (!r.ok) {
    // Ненулевой код — ещё не доказательство того, что мерж не прошёл.
    // `gh pr merge --delete-branch` мержит на удалёнке, а ПОТОМ удаляет
    // локальную ветку, и падение на этой уборке возвращает единицу поверх
    // уже выполненного мержа. Живой случай: ветку держал worktree другой
    // сессии, PR смержился, а скрипт отрапортовал провал.
    //
    // Спрашиваем GitHub, а не код выхода.
    const after = ghJson(repoRoot, ["pr", "view", String(number), "--json", "state,mergeCommit,mergedAt"]);
    if (after.ok && after.data.state === "MERGED") {
      emit({
        ok: true, merged: true, allowed: true,
        method,
        head_sha: pr.headRefOid,
        merge_commit: after.data.mergeCommit?.oid ?? null,
        merged_at: after.data.mergedAt ?? null,
        branch_deleted: false,
        cleanup_failed: (r.stderr || r.stdout || "").trim().slice(0, 500),
        note: "Мерж прошёл; ненулевой код относится к уборке после него, а не к самому мержу.",
        pr_url: pr.url,
        at: nowIso(),
      });
      return;
    }
    emit({
      ok: false, merged: false, allowed: true,
      error: "merge_failed",
      detail: (r.stderr || r.stdout || "").trim().slice(0, 1500),
      state_after: after.ok ? after.data.state : null,
      method, command: `gh ${mergeArgs.join(" ")}`,
      hint: "GitHub отказал уже после проверки правил — обычно это защита ветки или гонка с новым пушем.",
    });
    return;
  }

  emit({
    ok: true, merged: true, allowed: true,
    method,
    head_sha: pr.headRefOid,
    branch_deleted: cfg.merge?.delete_branch !== false,
    pr_url: pr.url,
    at: nowIso(),
    output: (r.stdout || r.stderr || "").trim().slice(0, 600),
  });
}

if (import.meta.url === `file://${process.argv[1]}`) main();
