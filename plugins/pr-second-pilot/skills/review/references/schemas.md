# Схемы

## `PR/.state/<slug>.json` — источник правды

Единственное место, откуда читается состояние. Отчёт `PR/<slug>.md`
перерисовывается из него и никогда не читается обратно (кроме блока
`## Ответы человека`).

```json
{
  "version": 1,
  "slug": "45",
  "repo_root": "/path/to/repo",
  "session": "a1b2c3d4",
  "status": "in_review",
  "round": 2,
  "reviewed_sha": "a1b2c3d",
  "prev_blocking": 3,
  "target": { "kind": "pr", "number": 45, "base_sha": "…", "head_sha": "…", "files": [] },
  "gate": { "ok": false, "checks": [], "blocking": ["tests"], "summary": "types:pass tests:fail" },
  "findings": [],
  "counts": { "total": 7, "open": 3, "blocking": 2, "fixed": 1, "verified": 3,
              "disputed": 0, "advisory": 1, "wontfix": 0,
              "severity_counts": { "critical": 1, "major": 1, "minor": 1, "nit": 0 },
              "open_ids": ["7f3a91c2", "b21c0d44"] },
  "history": [["7f3a91c2","b21c0d44","c9e0"], ["7f3a91c2","b21c0d44"]],
  "rounds_log": [],
  "human_questions": [],
  "threads": { "tech-lead": "uuid", "security": "uuid" },
  "fixer_session_id": "uuid",
  "config": {},
  "paths": {}
}
```

`status`: `in_review` · `fixing` · `awaiting_human` · `allowed` ·
`allowed_with_advisory` · `needs_human` · `rate_limited` · `oscillating` ·
`stuck` · `regressed` · `max_rounds` · `failed`

`history` — скользящее окно последних трёх наборов `open_ids`. По нему
`evaluate-stop.mjs` ловит застой. Пишется только через `commit-round.mjs`,
ровно один раз за раунд — отсюда защита от повторного коммита.

## Замечание

```json
{
  "id": "7f3a91c2",
  "severity": "critical",
  "declared_severity": "critical",
  "unproven": false,
  "out_of_scope": false,
  "status": "open",
  "sources": ["tech-lead", "security"],
  "title": "Запрос заказов не фильтрует по tenant_id",
  "file": "src/lib/queries/orders.ts:44-58",
  "trigger": "…", "mechanism": "…", "consequence": "…",
  "required": "…", "proof": "…",
  "first_round": 1,
  "rounds_seen": [1, 2],
  "reopened_count": 1,
  "dispute_rounds": 0,
  "history": [
    { "round": 1, "actor": "reviewer", "action": "raised", "at": "…" },
    { "round": 1, "actor": "fixer", "action": "fixed", "note": "…", "edit": "+9/-2 …", "at": "…" },
    { "round": 2, "actor": "reviewer", "action": "reopened", "note": "…", "at": "…" }
  ]
}
```

### Переходы статусов

Реализованы в `merge-findings.mjs`, покрыты самопроверками.

| Было | Ревьюер повторил | Ревьюер молчит |
|---|---|---|
| _нет_ | → `open` (или `advisory`, если вне скоупа либо не блокирующий уровень) | — |
| `open` | остаётся `open` | остаётся `open` |
| `fixed` | → `open`, `reopened_count++` | → `verified` |
| `verified` | → `open`, `reopened_count++` (регресс) | остаётся `verified` |
| `disputed` | → `open`, `dispute_rounds++` | → `wontfix` |
| `advisory` | → `open`, если уровень поднялся до блокирующего | остаётся |

Молчание ревьюера по `open` не считается подтверждением: при ревью дельты он
этого кода просто не видел.

`reopened_count >= 2` → `oscillating`.
`dispute_rounds >= loop.dispute_rounds_before_escalation` → `needs_human`.

## Решение об остановке

`evaluate-stop.mjs` возвращает одно решение. Порядок ветвей — контракт;
всё, что требует человека, старше всего, что похоже на прогресс.

```json
{ "action": "break", "status": "needs_human",
  "reason": "спор не сходится", "human_note": "…",
  "resumable": true, "questions": [] }
```

Порядок: `rate_limited` → `auth_failed` → `codex_missing` → `timeout` →
прочие сбои → `malformed` → `NEEDS_HUMAN` → застрявший спор → красный gate →
сошлось → осцилляция → застой → регресс → бюджет → `continue`.

## Отчёт исполнителя

Пишется в `<work>/round<N>/fix-report.json`. Формат — в
`fixer-prompt-template.md`; обязательна ровно одна запись на каждое замечание
раунда.

```json
{ "round": 2,
  "entries": [
    { "id": "7f3a91c2", "action": "fixed", "note": "…", "edit": "+9/-2 …", "proof": "…" },
    { "id": "b21c0d44", "action": "disputed", "note": "…", "evidence": "file.py:55-68" }
  ],
  "gate_fixed": ["tests"] }
```

## Решение о мерже

`merge-pr.mjs` возвращает список сработавших правил, а не первое из них —
отчёту нужно показать всё, что мешает.

```json
{ "ok": true, "merged": false, "allowed": false,
  "blockers": [
    { "rule": "head_moved", "detail": "…", "fixable": true },
    { "rule": "checks_pending", "detail": "…", "fixable": true }
  ],
  "retryable": true }
```

`fixable:true` означает «пройдёт само или после раунда» (идущие проверки,
отставшая ветка, сдвинувшаяся голова). Все остальные требуют решения человека
или правки конфигурации. Правила покрыты самопроверками:
`node merge-pr.mjs --self-test`.

## Конфигурация

Приоритет: значения по умолчанию → `~/.claude/pr-second-pilot/config.json` →
конфиг проекта (`.pr-second-pilot.json`) → флаги команды.

Секреты (`notify.telegram.bot_token`, `notify.telegram.chat_id`) читаются
только из пользовательского конфига и переменных окружения. Тот же ключ в
конфиге проекта отбрасывается с предупреждением — файл проекта попадёт в
ревьюируемый дифф.

Полный список ключей — `config.example.json` и `DEFAULTS` в `config.mjs`.
