---
description: Проверить окружение pr-second-pilot и показать, каким пулом оплачивается ревью
allowed-tools: Bash, Read
---

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/review/scripts/doctor.mjs --repo-root "$PWD"
```

Покажи результат таблицей: проверка, статус, детали. Для каждого `fail`
покажи поле `fix`.

Отдельно назови:
- `pool` — `subscription` означает, что ревью тратит лимиты плана ChatGPT,
  общие с десктопным Codex; `api` — оплата по токенам;
- `reviewer` и `fixer` — какие модели и усилие подставятся сейчас.
