<p align="center">
  <img src="docs/hero.png" alt="pr-second-pilot — Codex 与 Claude 同处一个座舱" width="720">
</p>

<h1 align="center">pr-second-pilot</h1>

<p align="center"><em>拉取请求的副驾驶：Codex 评审，Claude 修复，<br>
循环持续到允许合并——规则允许时它会自己合并。</em></p>

---

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.ru.md">Русский</a> ·
  <a href="README.zh.md">简体中文</a> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.pt.md">Português</a> ·
  <a href="README.ja.md">日本語</a>
</p>

一个 Claude Code 插件，在两家厂商的模型之间运行代码评审循环。Codex 评审 PR，
Claude 应用修复，一轮轮重复，直到允许合并或需要人来决定。

意义不在于"第二意见"。不同模型的失效方式不同，来自另一家族的评审者能在 Claude
写的代码里发现 Claude 自己看不见的问题。在本插件的实测 PR 上，评审抓到了一个
永远无法实现功能承诺的 REST 调用、一处 30 秒的事件循环阻塞、一个被当作成功上报
给用户的失败、并发写入丢失，以及与后台任务的竞态——外加针对它自己的指摘所做修复
中的两个缺陷。

分步使用说明：[docs/USAGE.md](docs/USAGE.md)。

## 工作原理

一个编排者——Claude Code 内的 skill——驱动状态机，通过
`codex exec --sandbox read-only` 无头调用评审者。

不存在"两个智能体盯着同一个文件"。智能体只在自己的回合里存在；"后台监视"无论如何
都需要外部触发，而两个写入者操作同一个 markdown 会产生竞态。所以一方编排，另一方
是被调用的函数。

| | 阶段 | 由谁 | 做什么 |
|---|---|---|---|
| A | Init | 脚本 | 解析目标、加锁、状态、把 `PR/` 写入 `.git/info/exclude` |
| B | Gate | 脚本 | 构建、类型、lint、测试——红的代码绝不送去评审 |
| C | Review | Codex | `codex exec --sandbox read-only`，评审组并行 |
| D | Triage | 脚本 | 解析结论、归一严重度、稳定 id、去重 |
| E | Fix | Claude | 应用修复、记账、有异议要说明而非沉默跳过 |
| F | Verify | 脚本 | 再次 gate，只评审 `reviewed_sha..HEAD` |
| G | Merge | 脚本 | 针对 GitHub 实时状态的 17 条规则，然后 `gh pr merge` |
| H | Finish | 脚本 | 提交本轮、渲染报告、通知 |

停止与否由纯函数决定，而不是模型。统计严重度、比较各轮之间的指摘集合是算术，模型
在这上面会出错。

## 安装

需要 Claude Code 2.x、Node 18+、git。按 PR 号评审还需要 `gh`。

**1. Codex CLI**——插件无头调用它，因此必须在 `PATH` 中。

```bash
npm install -g @openai/codex
codex login
```

**2. 插件**——在 Claude Code 会话中，每条消息一个命令：

```
/plugin marketplace add estimablejunk/pr-second-pilot
/plugin install pr-second-pilot@pr-second-pilot
```

**3. 重载**——终端客户端用 `/reload-plugins`。VS Code 扩展没有该命令，请用
**Developer: Reload Window**。

**4. 检查**——`/pr-second-pilot:doctor` 会显示找到了什么，以及最重要的一点：
**这次评审花的是哪个额度**。

## 使用

```
/pr-second-pilot:review 45         评审 PR #45
/pr-second-pilot:review branch      用当前分支对比其基线分支
/pr-second-pilot:resume 45          在你答复或额度恢复后继续
/pr-second-pilot:usage              运行开销与剩余额度
/pr-second-pilot:settings           查看或修改设置
/pr-second-pilot:doctor             检查环境
```

不需要动你的工作副本：它可以停在毫不相关的分支上并带着未提交的改动。插件会把 PR
检出到自己的 worktree，用完后清理掉。

报告落在 `PR/45.md`，状态在 `PR/.state/45.json`。报告最上方是**改动摘要**——
简短平实地说明这次改动做了什么、什么原来是坏的、怎么修的。一周后有人打开报告，看
的就是这一段；指摘表格回答的是另一个问题。

`PR/` 通过 `.git/info/exclude` 排除——只在本地，不会被提交。改动被跟踪的
`.gitignore` 会直接出现在正在评审的那个 diff 里。

## 设置

默认值 → `~/.claude/pr-second-pilot/config.json` → 仓库里的
`.pr-second-pilot.json` → 命令行参数。完整列表见
[config.example.json](plugins/pr-second-pilot/skills/review/config.example.json)。

```bash
# 评审者：模型、推理强度、评审组
/pr-second-pilot:settings reviewer.model=gpt-5.6-sol reviewer.effort=high
/pr-second-pilot:settings reviewer.panel=tech-lead,security

# 修复者：inherit——当前会话修复，在 IDE 里可见
#         subprocess——独立的 `claude -p`，可指定自己的模型与强度
/pr-second-pilot:settings fixer.mode=subprocess fixer.model=opus fixer.effort=xhigh

# 报告与结论的输出语言：en · ru · zh · es · pt · ja
/pr-second-pilot:settings report.language=zh

# 循环
/pr-second-pilot:settings loop.max_rounds=4 loop.blocking_severities=critical,major
```

修复者的推理强度只在 `subprocess` 模式下可配：Claude Code 的子智能体有 `model`
字段但没有强度字段——它由启动进程时的 `--effort` 参数决定。

### 评审者模型

**在本次发布时，最佳组合是 `gpt-5.6-sol` 配 `effort=high`。**在本插件实测的那个
拉取请求上，正是这个组合找出了全部真实缺陷。

请把它当作起点，而不是永恒结论。模型会被替换。有新模型时请重新比较——配合
`/pr-second-pilot:usage`，你可以同时权衡质量与开销。

### 语言

`report.language` 决定报告和评审结论的语言。评审者自身的指令保持单一语言——那是
给模型看的指令，不是给人读的，把它们维护成六份翻译只会让其中五份逐渐与第六份脱节。
欢迎贡献翻译；输出语言的切换现在就能用。

### 自定义评审者

内置的是 [reviewers/](plugins/pr-second-pilot/reviewers/) 里的 `tech-lead` 和
`security`，写法上不绑定任何仓库或技术栈：它们从项目自身的文件里推断情况——
`CLAUDE.md` / `AGENTS.md`、清单文件、workflow、迁移目录。

特定技术的知识放在技术栈档案（`reviewers/stacks/*.md`）里，按依赖自动挂载。插件
自带 `nextjs-supabase` 档案。

### Telegram

只在值得打断人的事件上通知：需要决定、循环结束、循环中止、额度用尽。进度永不发送——
每轮都汇报的机器人，最后会被静音。

密钥只写入用户配置或环境变量（`PR_SECOND_PILOT_TG_TOKEN`、
`PR_SECOND_PILOT_TG_CHAT`）。项目配置里的同名键会被丢弃并给出警告——那个文件会
出现在被评审的 diff 里。

## 合并

循环允许合并后，由智能体执行。但循环的结论只是决定的一半，另一半要问 GitHub。
17 条规则中的任何一条都能否决：

| 规则 | 何时否决 |
|---|---|
| `head_moved` | 评审之后 head 变了——那段代码没人看过 |
| `open_blockers` · `open_disputes` · `open_questions` | 循环没有关闭自己的指摘 |
| `gate_red` | 客观检查是红的 |
| `checks_failed` · `checks_pending` | CI 失败或仍在运行 |
| `changes_requested` | 有人在 review 里要求修改 |
| `approval_required` | 仓库规则要求审批 |
| `branch_protection` · `conflicts` · `behind_base` | GitHub 尚未就绪 |
| `unresolved_threads` | PR 里有未解决的讨论 |
| `forbidden_label` | 打了 `do-not-merge`、`wip`、`on-hold` 标签 |
| `forbidden_path` · `base_not_allowed` | 触及受保护路径或基线分支 |

合并会锁定到被评审的 SHA（`--match-head-commit`）：如果在规则检查与调用之间有新
提交落地，GitHub 会拒绝，而不是把更新的代码合进去。

`merge.admin=true` 会绕过分支保护。智能体绝不自行设置它，配置在你打开时会警告。

## 一次运行的开销

评审不是"读一遍 diff"。评审者会用几十个回合走查代码，而每个回合都要重新发送全部已
累积的上下文。实测数据：一轮花掉 270 万输入 token，输出只有 1.5 万。你付的是"读"的
钱。

| 措施 | 回合 | Token |
|---|---|---|
| 什么都不做 | 27 | 2,710,833 |
| `preload_files`——源码放进提示 | 25 | 2,655,348 |
| 评审者指令内联 | 17 | 1,404,418 |
| `isolate_skills` + 复用线程 | 4 | 664,772 |

**指令内联**贡献了一半的节省。给出 skill 文件的路径，就意味着评审者要花一个回合去
读它。

**skill 隔离**（`reviewer.isolate_skills`）——Codex 会无条件加载
`~/.codex/skills` 里的一切，且没有开关可以关掉。插件在影子 `CODEX_HOME` 中运行
它：软链接指向认证与会话，但没有 skills 目录。这不只关乎 token：被自动加载的其中就有
面向另一套架构的项目专用 skill，指示模型往 PR 里发评论、启动监视器——与评审提示直接
矛盾。

`/pr-second-pilot:usage` 显示每次运行的价格与剩余额度。

## 订阅额度

使用 `codex login` 时，评审消耗的是你的 ChatGPT 套餐额度——与桌面版 Codex 同一个
池子。一次运行花多少，取决于你的套餐、diff 的大小和仓库的结构，所以请用
`/pr-second-pilot:usage` 看你自己环境的真实数字，而不是这里引用的任何数值。

额度耗尽已写进设计：

- 触顶是可恢复的结果而非崩溃：状态已保存，`/pr-second-pilot:resume` 从原处继续；
- 红的检查绝不送去评审；
- 从第二轮起评审者只看增量；
- 双评审者只在第一轮出动；
- 绝不为一个 `nit` 再跑一轮。

## 不变量

- 评审者在 `--sandbox read-only` 下运行；该参数在封装里是字面量，不对配置开放。
- 任何文件读取都来自被评审的 SHA，绝不来自工作副本。在一次实测中，这条规则抓出了四个
  独立的 bug。
- 报告是状态的视图。只有"人工答复"区块由手工编辑，并且能在重新渲染中保留。
- 修复者不得为了关闭指摘而削弱测试。它可以带证据提出异议，但不能悄悄改写。
- 关于 diff 之外文件的指摘永不阻塞合并。
- `loop.hard_cap` 永不被突破。

## 开发

```bash
cd plugins/pr-second-pilot/skills/review/scripts
node parse-verdict.mjs   --self-test    # 17 项
node merge-findings.mjs  --self-test    # 13 项
node evaluate-stop.mjs   --self-test    # 17 项
node merge-pr.mjs        --self-test    # 23 项合并规则
node commit-round.mjs    --self-test    #  8 项记账
```

评审者的原始回复、提示与简报保留在 `PR/.state/<slug>.work/round<N>/`。结论看起来
可疑时，从这里查起。

## 许可

MIT。
