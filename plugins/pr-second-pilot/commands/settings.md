---
description: Показать или изменить настройки pr-second-pilot (модели, усилие, Telegram)
argument-hint: [key=value ...]
allowed-tools: Bash, Read
---

Аргументы: $ARGUMENTS

Без аргументов — покажи текущую конфигурацию:
```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/review/scripts/config.mjs --repo-root "$PWD"
```
Выведи таблицей: ключ, значение, откуда взято (`sources`). Обязательно покажи
`warnings`, если они есть.

С аргументами вида `key=value` — запиши в пользовательский конфиг:
```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/review/scripts/config.mjs --repo-root "$PWD" \
  --set key=value [--set key2=value2]
```

Часто нужные ключи:
- `reviewer.model`, `reviewer.effort` (minimal|low|medium|high)
- `reviewer.panel` (tech-lead,security), `reviewer.panel_rounds`
- `fixer.mode` (inherit|subprocess), `fixer.model`, `fixer.effort` (low|medium|high|xhigh|max)
- `loop.max_rounds`, `loop.blocking_severities`
- `reviewer.stack_profile` (auto|none|nextjs-supabase)
- `gate.commands`, `gate.enabled`
- `merge.enabled`, `merge.method`, `merge.allow_base_branches`, `merge.forbid_paths`,
  `merge.require_all_checks`, `merge.allow_without_approval`
- `notify.telegram.enabled`, `notify.telegram.bot_token`, `notify.telegram.chat_id`

Если просят `merge.admin=true` — предупреди, что это обход защиты ветки, и
поставь только по явному подтверждению.

Секреты пишутся только в `~/.claude/pr-second-pilot/config.json`. Если человек просит
положить токен в конфиг проекта — откажи и объясни: файл проекта уедет в тот
самый PR, который ревьюим.
