---
description: Запустить цикл ревью PR или текущей ветки
argument-hint: <номер PR|branch> [--reviewer-effort high] [--fixer-model opus] [--max-rounds 4]
allowed-tools: Bash, Read, Edit, Write, Grep, Glob, Task
---

Запусти скилл `review` из плагина pr-second-pilot для цели: $ARGUMENTS

Если аргументов нет — цель `branch` (текущая ветка против базовой).
Следуй `${CLAUDE_PLUGIN_ROOT}/skills/review/SKILL.md` начиная с фазы A.
