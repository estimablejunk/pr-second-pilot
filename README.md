<p align="center">
  <img src="docs/hero.png" alt="pr-second-pilot — Codex and Claude in one cockpit" width="720">
</p>

<h1 align="center">pr-second-pilot</h1>

<p align="center"><em>A second pilot for pull requests: Codex judges, Claude fixes,<br>
the loop runs until the merge is allowed — and merges it when the rules permit.</em></p>

---

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.ru.md">Русский</a> ·
  <a href="README.zh.md">简体中文</a> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.pt.md">Português</a> ·
  <a href="README.ja.md">日本語</a>
</p>

A Claude Code plugin that runs a code review loop between two vendors' models.
Codex reviews the pull request, Claude applies the fixes, the round repeats
until the merge is allowed or a human is needed.

The point is not a second opinion. Different models fail differently, and a
reviewer from another family finds things in Claude's code that Claude does not
see in itself. On the pull request this plugin was built against, the review
caught a REST call that could never do what the feature promised, a 30-second
event-loop stall, an error reported to the user as success, lost concurrent
writes, and a race with a background task — plus two defects in the fixes made
in response to its own findings.

Step-by-step usage: [docs/USAGE.md](docs/USAGE.md).

## How it works

One orchestrator — a skill inside Claude Code — drives a state machine and
calls the reviewer headlessly through `codex exec --sandbox read-only`.

There are no two agents watching a file. An agent exists only inside its own
turn; "watching in the background" needs an external trigger anyway, and two
writers on one markdown file give you races. So one side orchestrates and the
other is a called function.

| | Phase | Who | What happens |
|---|---|---|---|
| A | Init | script | resolve target, lock, state, `PR/` into `.git/info/exclude` |
| B | Gate | script | build, types, lint, tests — red code is never sent to review |
| C | Review | Codex | `codex exec --sandbox read-only`, panel members in parallel |
| D | Triage | script | parse verdict, normalize severity, stable ids, dedupe |
| E | Fix | Claude | apply fixes, ledger, dispute instead of silent skipping |
| F | Verify | script | gate again, review only `reviewed_sha..HEAD` |
| G | Merge | script | 17 rules against live GitHub state, then `gh pr merge` |
| H | Finish | script | commit round, render report, notify |

The stop decision is a pure function, not a model. Counting severities and
diffing finding sets between rounds is arithmetic, and models get it wrong.

## Install

Requires Claude Code 2.x, Node 18+, git. `gh` for reviewing by PR number.

**1. Codex CLI** — the plugin calls it headlessly, so it must be on `PATH`.

```bash
npm install -g @openai/codex
codex login
```

**2. The plugin** — inside a Claude Code session, one command per message:

```
/plugin marketplace add estimablejunk/pr-second-pilot
/plugin install pr-second-pilot@pr-second-pilot
```

**3. Reload** — `/reload-plugins` in the terminal client. The VS Code extension
has no such command: use **Developer: Reload Window**.

**4. Set up** — `/pr-second-pilot:setup` looks at your repository and environment
and proposes settings, each with the reason behind it. It writes nothing until you
say so, and it only shows what actually needs changing.

It detects, among other things, whether your tests need live services (in which
case a local gate checks nothing and CI should be the gate) and whether the code
touches auth or payments (in which case the second reviewer earns its cost).

**5. Check** — `/pr-second-pilot:doctor` shows what was found and, importantly,
**which pool pays for the review**.

## Update

```
claude plugin update pr-second-pilot@pr-second-pilot
```

The qualified name is required. A plugin is addressed as
`<plugin>@<marketplace>`, and here both happen to be `pr-second-pilot` — the
doubling looks like a typo but is not. The short form answers "not found".

In a session you can also use `/plugin` → **Marketplaces → pr-second-pilot →
Update**. Third-party marketplaces have auto-update off by default; the same
menu turns it on.

## Usage

```
/pr-second-pilot:review 45         review PR #45
/pr-second-pilot:review branch      review the current branch against its base
/pr-second-pilot:resume 45          continue after your answer or a limit reset
/pr-second-pilot:usage              cost of runs and remaining limits
/pr-second-pilot:settings           show or change settings
/pr-second-pilot:setup              first-time setup with reasons
/pr-second-pilot:doctor             check the environment
```

You do not need to touch your working copy: it may sit on an unrelated branch
with uncommitted work. The plugin checks the PR out into its own worktree and
removes it afterwards.

The report lands in `PR/45.md`, state in `PR/.state/45.json`. At the top of the
report is **What was done** — a short plain summary of what the change does,
what turned out to be broken, and how it was fixed. That is the section people
open a week later; the finding tables answer a different question.

`PR/` is excluded through `.git/info/exclude` — local, never committed. Editing
the tracked `.gitignore` would show up inside the very diff under review.

## Settings

Defaults → `~/.claude/pr-second-pilot/config.json` → `.pr-second-pilot.json` in
the repo → command flags. Full list in
[config.example.json](plugins/pr-second-pilot/skills/review/config.example.json).

```bash
# Reviewer: model, effort, panel
/pr-second-pilot:settings reviewer.model=gpt-5.6-sol reviewer.effort=high
/pr-second-pilot:settings reviewer.panel=tech-lead,security

# Fixer: inherit — the current session applies fixes, visible in the IDE
#        subprocess — a separate `claude -p` with its own model and effort
/pr-second-pilot:settings fixer.mode=subprocess fixer.model=opus fixer.effort=xhigh

# Output language of reports and verdicts: en · ru · zh · es · pt · ja
/pr-second-pilot:settings report.language=en

# Loop
/pr-second-pilot:settings loop.max_rounds=4 loop.blocking_severities=critical,major
```

Fixer effort is configurable only in `subprocess` mode: Claude Code subagents
carry a `model` field but no effort field — it is set by the `--effort` flag
when spawning the process.

### Reviewer model

**As of this release, the best combination is `gpt-5.6-sol` with `effort=high`.**
That is what found every real defect on the live pull request this plugin was
built against.

Treat it as a starting point, not a permanent truth. Models get replaced. When a
new one ships, compare — with `/pr-second-pilot:usage` you can weigh cost as well
as quality.

### Language

`report.language` drives the report and the reviewer's verdicts. The reviewer's
own instructions stay in one language — they are instructions to a model, not
something a human reads, and keeping them in six translations would doom five of
them to drift from the sixth. Translating them is a welcome contribution; the
output language works today.

### Custom reviewers

Built-in ones are `tech-lead` and `security` in
[reviewers/](plugins/pr-second-pilot/reviewers/), written without ties to any
repository or stack: they work the project out from its own files — `CLAUDE.md`
/ `AGENTS.md`, manifests, workflows, migration directories.

Technology-specific knowledge lives in stack profiles
(`reviewers/stacks/*.md`) and is attached automatically by dependency
detection. A `nextjs-supabase` profile ships with the plugin.

```json
{ "reviewer": { "panel": ["tech-lead", "security", "perf"],
                "skills": { "perf": "/path/to/perf-review.md" } } }
```

### Telegram

Notifications fire only for events worth interrupting someone over: a decision
is needed, the loop finished, the loop stopped, the quota ran out. Progress is
never sent — a bot that reports every round is a bot people mute.

```bash
/pr-second-pilot:settings notify.telegram.enabled=true
/pr-second-pilot:settings notify.telegram.bot_token=123:ABC notify.telegram.chat_id=456
```

Secrets go only into the user config or environment variables
(`PR_SECOND_PILOT_TG_TOKEN`, `PR_SECOND_PILOT_TG_CHAT`). The same key in the
project config is dropped with a warning — that file would land in the reviewed
diff.

## Merge

When the loop allows the merge, the agent performs it. But the loop's verdict
is only half of the decision; the other half is asked of GitHub. Seventeen
rules can forbid it:

| Rule | Forbids when |
|---|---|
| `head_moved` | the head moved after the review — nobody looked at that code |
| `open_blockers` · `open_disputes` · `open_questions` | the loop did not close its findings |
| `gate_red` | objective checks are failing |
| `checks_failed` · `checks_pending` | CI failed or is still running |
| `changes_requested` | a human requested changes in review |
| `approval_required` | repository rules require an approval |
| `branch_protection` · `conflicts` · `behind_base` | GitHub is not ready to merge |
| `unresolved_threads` | the PR has unresolved conversations |
| `forbidden_label` | a `do-not-merge`, `wip`, `on-hold` label |
| `forbidden_path` · `base_not_allowed` | protected paths or base branch touched |

The merge is pinned to the reviewed SHA (`--match-head-commit`): if anything
lands between the rule check and the call, GitHub refuses instead of merging
newer code.

`merge.admin=true` bypasses branch protection. The agent never sets it, and the
config warns when you do.

## Cost of a run

A review is not "reading a diff". The reviewer walks the code over dozens of
turns, and every turn re-sends the whole accumulated context. Measured on a
real PR: one round cost 2.7M input tokens against 15K output. You pay for
reading.

| Measure | Turns | Tokens |
|---|---|---|
| nothing | 27 | 2,710,833 |
| `preload_files` — sources in the prompt | 25 | 2,655,348 |
| reviewer instructions inlined | 17 | 1,404,418 |
| `isolate_skills` + thread reuse | 4 | 664,772 |

**Inlined instructions** are half the saving. A path to a skill file means the
reviewer spends a turn reading it.

**Skill isolation** (`reviewer.isolate_skills`) — Codex unconditionally loads
everything from `~/.codex/skills`, and no flag turns that off. The plugin runs
it in a shadow `CODEX_HOME` symlinked to auth and sessions but without a skills
directory. This is not only about tokens: among the auto-loaded skills were
project-specific ones for a different architecture, instructing the model to
post to the PR and start monitors — directly contradicting the review prompt.

`/pr-second-pilot:usage` shows the price of each run and the remaining limits.

## Subscription limits

With `codex login`, the review spends your ChatGPT plan limits — the same pool as
the desktop Codex. How much one run costs depends on your plan, the size of the
diff and the shape of the repository, so read the real numbers for your setup from
`/pr-second-pilot:usage` rather than any figure quoted here.

Running out is built into the design:

- hitting the limit is a resumable outcome, not a crash: state is saved and
  `/pr-second-pilot:resume` continues from the same place;
- red checks are never sent to review;
- from the second round the reviewer sees only the delta;
- a two-reviewer panel runs in the first round only;
- a round is never spent on a `nit`.

`/pr-second-pilot:doctor` reports the `pool` field: `subscription` or `api`.

## Invariants

- The reviewer runs under `--sandbox read-only`; the flag is a literal in the
  wrapper and is not exposed to config.
- Every file read comes from the reviewed SHA, never the working copy. Across
  one live run this rule caught four separate bugs.
- The report is a view of the state. Only the human-answers block is edited by
  hand, and it survives re-rendering.
- The fixer may not weaken tests to close a finding. It can dispute a test with
  evidence, but not rewrite it silently.
- Findings about files outside the diff never block the merge.
- `loop.hard_cap` is never exceeded.

## Development

```bash
cd plugins/pr-second-pilot/skills/review/scripts
node parse-verdict.mjs   --self-test    # 17 checks
node merge-findings.mjs  --self-test    # 13 checks
node evaluate-stop.mjs   --self-test    # 17 checks
node merge-pr.mjs        --self-test    # 23 merge-rule checks
node commit-round.mjs    --self-test    #  8 bookkeeping checks
```

Raw reviewer replies, prompts and briefs stay in
`PR/.state/<slug>.work/round<N>/`. If a verdict looks strange, start there.

## License

MIT.
