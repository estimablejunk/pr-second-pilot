<p align="center">
  <img src="docs/hero.png" alt="pr-second-pilot — Codex と Claude が同じコックピットに" width="720">
</p>

<h1 align="center">pr-second-pilot</h1>

<p align="center"><em>プルリクエストの副操縦士。Codex が判定し、Claude が直す。<br>
マージが許可されるまでループが回り、規則が許せば自分でマージする。</em></p>

---

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.ru.md">Русский</a> ·
  <a href="README.zh.md">简体中文</a> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.pt.md">Português</a> ·
  <a href="README.ja.md">日本語</a>
</p>

二社のモデルの間でコードレビューのループを回す Claude Code プラグインです。Codex が
プルリクエストをレビューし、Claude が修正を適用し、マージが許可されるか人間の判断が
必要になるまでラウンドを繰り返します。

狙いは「セカンドオピニオン」ではありません。モデルが違えば壊れ方も違い、別系統の
レビュアーは Claude のコードの中に Claude 自身には見えないものを見つけます。本
プラグインを作る土台にした実際のプルリクエストでは、機能が約束したことを決して実現
できない REST 呼び出し、30 秒のイベントループ停止、ユーザーには成功として報告される
失敗、並行書き込みの消失、バックグラウンドタスクとの競合を検出しました。さらに、その
指摘に応じて行った修正の中の欠陥も 2 件見つけています。

手順つきの使い方: [docs/USAGE.md](docs/USAGE.md)。

## しくみ

オーケストレーター（Claude Code 内の skill）が状態機械を進め、
`codex exec --sandbox read-only` でレビュアーをヘッドレス呼び出しします。

「2 つのエージェントが同じファイルを見張る」構成ではありません。エージェントは自分の
ターンの中にしか存在せず、「バックグラウンドで監視」にはどのみち外部トリガーが要り、
1 つの markdown に 2 人が書けば競合します。だから片方が指揮し、もう片方は呼ばれる
関数です。

| | フェーズ | 担当 | 内容 |
|---|---|---|---|
| A | Init | スクリプト | 対象解決、ロック、状態、`PR/` を `.git/info/exclude` へ |
| B | Gate | スクリプト | ビルド・型・lint・テスト。赤いコードはレビューに送らない |
| C | Review | Codex | `codex exec --sandbox read-only`、パネルは並列 |
| D | Triage | スクリプト | 判定の解析、重大度の正規化、安定 id、重複排除 |
| E | Fix | Claude | 修正適用、台帳記録、黙って飛ばさず異議を述べる |
| F | Verify | スクリプト | 再度 gate、`reviewed_sha..HEAD` だけをレビュー |
| G | Merge | スクリプト | GitHub の実状態に対する 17 の規則、その後 `gh pr merge` |
| H | Finish | スクリプト | ラウンド確定、レポート生成、通知 |

停止判断はモデルではなく純関数です。重大度を数え、ラウンド間で指摘集合を比較するのは
算術であり、モデルはそこで間違えます。

## インストール

Claude Code 2.x、Node 18+、git が必要。PR 番号でレビューするには `gh` も。

**1. Codex CLI** — プラグインがヘッドレスで呼ぶので `PATH` に必要です。

```bash
npm install -g @openai/codex
codex login
```

**2. プラグイン** — Claude Code のセッション内で、1 メッセージにつき 1 コマンド：

```
/plugin marketplace add estimablejunk/pr-second-pilot
/plugin install pr-second-pilot@pr-second-pilot
```

**3. 再読み込み** — ターミナル版では `/reload-plugins`。VS Code 拡張にはこの
コマンドがないので **Developer: Reload Window** を使います。

**4. 初期設定** — `/pr-second-pilot:setup` がリポジトリと環境を見て、理由つきで
設定を提案します。あなたが同意するまで何も書き込まず、本当に変更が要る項目だけを
表示します。

判定するのは、たとえばテストが実サービスを必要とするか（必要なら、ローカルの gate は
何も検証できず、gate は CI であるべきです）、コードが認証や決済に触れているか（触れて
いるなら、2 人目のレビュアーは元が取れます）。

**5. 確認** — `/pr-second-pilot:doctor` が何を検出したか、そして何より
**どの枠でレビュー代を払うのか**を表示します。

## 更新

```
claude plugin update pr-second-pilot@pr-second-pilot
```

完全名が必須です。プラグインは `<プラグイン>@<マーケットプレイス>` で指定され、
ここでは両方が同じ名前になります。重複は誤記に見えますが、そうではありません。
短い名前では「見つかりません」と返ります。

セッション内では `/plugin` → **Marketplaces → pr-second-pilot → Update** でも
同じことができます。サードパーティのマーケットプレイスは自動更新が既定で無効で、
同じメニューから有効にできます。

## 使い方

```
/pr-second-pilot:review 45         PR #45 をレビュー
/pr-second-pilot:review branch      現在のブランチをベースと比較してレビュー
/pr-second-pilot:resume 45          あなたの回答や上限リセットのあとに再開
/pr-second-pilot:usage              実行コストと残りの上限
/pr-second-pilot:settings           設定の表示・変更
/pr-second-pilot:setup              理由つきの初期設定
/pr-second-pilot:doctor             環境の確認
```

作業コピーに触る必要はありません。無関係なブランチで未コミットの作業を抱えていても
構いません。プラグインは PR を専用の worktree にチェックアウトし、終わったら片付けます。

レポートは `PR/45.md`、状態は `PR/.state/45.json` に出ます。レポートの冒頭は
**変更の要点**——この変更が何をするのか、何が壊れていて、どう直したのかを短く平易に
まとめたものです。1 週間後に開かれるのはこの節で、指摘の表は別の問いに答えるものです。

`PR/` は `.git/info/exclude` で除外されます（ローカルのみ、コミットされません）。
追跡下の `.gitignore` を編集すると、まさにレビュー中の diff の中に現れてしまいます。

## 設定

既定値 → `~/.claude/pr-second-pilot/config.json` → リポジトリの
`.pr-second-pilot.json` → コマンドのフラグ。全一覧は
[config.example.json](plugins/pr-second-pilot/skills/review/config.example.json)。

```bash
# レビュアー：モデル、推論強度、パネル
/pr-second-pilot:settings reviewer.model=gpt-5.6-sol reviewer.effort=high
/pr-second-pilot:settings reviewer.panel=tech-lead,security

# 修正担当：inherit — 現在のセッションが直す（IDE で見える）
#           subprocess — 独立した `claude -p`。モデルと強度を個別指定できる
/pr-second-pilot:settings fixer.mode=subprocess fixer.model=opus fixer.effort=xhigh

# レポートと判定の出力言語：en · ru · zh · es · pt · ja
/pr-second-pilot:settings report.language=ja

# ループ
/pr-second-pilot:settings loop.max_rounds=4 loop.blocking_severities=critical,major
```

修正担当の推論強度は `subprocess` モードでのみ設定できます。Claude Code のサブ
エージェントには `model` フィールドはあっても強度フィールドがなく、プロセス起動時の
`--effort` フラグで決まるためです。

### レビュアーのモデル

**このリリース時点では `gpt-5.6-sol` に `effort=high` が最良の組み合わせ**です。
本プラグインを作る土台にした実測のプルリクエストで、すべての本物の欠陥を見つけたのが
この組み合わせでした。

ただしこれは出発点であって恒久の真実ではありません。モデルは入れ替わります。新しい
ものが出たら比べ直してください。`/pr-second-pilot:usage` があれば、品質だけでなく
コストの比較もできます。

### 言語

`report.language` がレポートとレビュアーの判定の言語を決めます。レビュアー自身への
指示は 1 言語のままです。あれは人が読むものではなくモデルへの指示であり、6 言語に
分けて持てば 5 つが 6 つ目からずれていく運命になります。翻訳の貢献は歓迎ですが、
出力言語の切り替えは今日から動きます。

### 独自のレビュアー

同梱は [reviewers/](plugins/pr-second-pilot/reviewers/) の `tech-lead` と
`security`。特定のリポジトリや技術スタックに縛られない書き方で、プロジェクトのこと
はそのファイル群から読み取ります——`CLAUDE.md` / `AGENTS.md`、マニフェスト、
workflow、マイグレーションのディレクトリ。

技術固有の知識はスタックプロファイル（`reviewers/stacks/*.md`）に置かれ、依存関係の
検出で自動的に付きます。`nextjs-supabase` プロファイルを同梱しています。

### Telegram

通知は人を中断させる価値のある出来事だけに限られます——判断が要る、ループが終わった、
ループが止まった、枠を使い切った。進捗は送りません。毎ラウンド報告するボットは、
結局ミュートされるボットです。

秘密情報はユーザー設定か環境変数（`PR_SECOND_PILOT_TG_TOKEN`、
`PR_SECOND_PILOT_TG_CHAT`）にのみ置きます。プロジェクト設定に同じキーがあれば警告
つきで破棄されます——そのファイルはレビュー対象の diff に載ってしまうからです。

## マージ

ループがマージを許可したら、エージェントが実行します。ただしループの判定は決定の半分
にすぎず、もう半分は GitHub に尋ねます。17 の規則のどれかが禁じます：

| 規則 | 禁じる条件 |
|---|---|
| `head_moved` | レビュー後に head が動いた——そのコードは誰も見ていない |
| `open_blockers` · `open_disputes` · `open_questions` | ループが指摘を閉じ切っていない |
| `gate_red` | 客観的チェックが赤 |
| `checks_failed` · `checks_pending` | CI が失敗、または実行中 |
| `changes_requested` | 人が review で修正を要求した |
| `approval_required` | リポジトリ規則が承認を要求している |
| `branch_protection` · `conflicts` · `behind_base` | GitHub 側が未準備 |
| `unresolved_threads` | PR に未解決の会話がある |
| `forbidden_label` | `do-not-merge`、`wip`、`on-hold` ラベル |
| `forbidden_path` · `base_not_allowed` | 保護対象のパスやベースブランチに触れた |

マージはレビュー済み SHA に固定されます（`--match-head-commit`）。規則チェックから
呼び出しまでの間に何かが着地したら、GitHub は新しいコードをマージせず拒否します。

`merge.admin=true` はブランチ保護を迂回します。エージェントが自分で設定することは
なく、設定側も有効化時に警告します。

## 1 回の実行コスト

レビューは「diff を読む」ことではありません。レビュアーは数十ターンかけてコードを歩き、
毎ターン蓄積した文脈をすべて送り直します。実測では、あるラウンドは入力 270 万トークン
に対し出力は 1.5 万でした。払っているのは「読む」代金です。

| 施策 | ターン | トークン |
|---|---|---|
| 何もしない | 27 | 2,710,833 |
| `preload_files`——ソースをプロンプトに | 25 | 2,655,348 |
| レビュアーの指示をプロンプト内に展開 | 17 | 1,404,418 |
| `isolate_skills` + スレッド再利用 | 4 | 664,772 |

**指示の展開**が節約の半分を占めます。skill ファイルへのパスを渡すということは、
レビュアーがそれを読むためにターンを 1 つ使うということです。

**skill の隔離**（`reviewer.isolate_skills`）——Codex は `~/.codex/skills` の
中身を無条件に読み込み、それを止めるフラグはありません。プラグインは影の
`CODEX_HOME` で実行します。auth とセッションへはシンボリックリンクを張り、skills
ディレクトリだけ置きません。理由はトークンだけではありません。自動で読み込まれたものの
中に、別アーキテクチャ向けのプロジェクト固有 skill があり、PR にコメントを投稿しろ、
モニターを起動しろと指示していました——レビュー用プロンプトと真っ向から矛盾します。

## サブスクリプションの枠

`codex login` を使う場合、レビューはあなたの ChatGPT プランの枠を消費します——
デスクトップ版 Codex と同じ財布です。1 回の実行がどれだけ食うかはプラン、diff の
大きさ、リポジトリの構造で変わるので、一般論より
`/pr-second-pilot:usage` の実測値を見てください。

枠切れは設計に織り込まれています：

- 上限到達は障害ではなく再開可能な結果です。状態は保存され、
  `/pr-second-pilot:resume` が同じ地点から続けます；
- 赤いチェックはレビューに送りません；
- 2 ラウンド目からレビュアーは差分だけを見ます；
- 2 人のパネルは 1 ラウンド目だけ；
- `nit` のためにラウンドを消費しません。

`/pr-second-pilot:doctor` は `pool` を表示します：`subscription` か `api` か。

## 不変条件

- レビュアーは `--sandbox read-only` で動きます。このフラグはラッパー内のリテラルで、
  設定には露出しません。
- ファイルの読み取りは常にレビュー対象の SHA から行い、作業コピーからは決して読みません。
  実測 1 回のうちに、この規則が別々のバグを 4 件捕まえました。
- レポートは状態のビューです。手で編集するのは「人間の回答」ブロックだけで、それは再生成
  を生き延びます。
- 修正担当は指摘を閉じるためにテストを弱めてはいけません。証拠つきで異議を述べることは
  できますが、黙って書き換えることはできません。
- diff の外のファイルに関する指摘はマージを妨げません。
- `loop.hard_cap` を超えることはありません。

## 開発

```bash
cd plugins/pr-second-pilot/skills/review/scripts
node parse-verdict.mjs   --self-test    # 17 件
node merge-findings.mjs  --self-test    # 13 件
node evaluate-stop.mjs   --self-test    # 17 件
node merge-pr.mjs        --self-test    # 23 件（マージ規則）
node commit-round.mjs    --self-test    #  8 件（記帳）
```

レビュアーの生の返答、プロンプト、ブリーフは
`PR/.state/<slug>.work/round<N>/` に残ります。判定がおかしいと感じたら、まずそこから。

## ライセンス

MIT。
