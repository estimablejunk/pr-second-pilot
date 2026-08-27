<p align="center">
  <img src="docs/hero.png" alt="pr-second-pilot — Codex y Claude en la misma cabina" width="720">
</p>

<h1 align="center">pr-second-pilot</h1>

<p align="center"><em>Un segundo piloto para pull requests: Codex revisa, Claude corrige,<br>
el ciclo se repite hasta permitir la fusión — y la ejecuta cuando las reglas lo permiten.</em></p>

---

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.ru.md">Русский</a> ·
  <a href="README.zh.md">简体中文</a> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.pt.md">Português</a> ·
  <a href="README.ja.md">日本語</a>
</p>

Un plugin de Claude Code que ejecuta un ciclo de revisión de código entre modelos
de dos proveedores. Codex revisa el pull request, Claude aplica las correcciones,
la ronda se repite hasta que la fusión esté permitida o haga falta una persona.

No se trata de una segunda opinión. Modelos distintos fallan de forma distinta, y
un revisor de otra familia encuentra en el código de Claude lo que Claude no ve en
sí mismo. En el pull request sobre el que se construyó este plugin, la revisión
detectó una llamada REST que nunca podría cumplir lo que la función prometía, un
bloqueo del event loop de 30 segundos, un error reportado al usuario como éxito,
pérdida de escrituras concurrentes y una condición de carrera con una tarea en
segundo plano — además de dos defectos en las correcciones hechas en respuesta a
sus propios hallazgos.

Uso paso a paso: [docs/USAGE.md](docs/USAGE.md).

## Cómo funciona

Un orquestador — un skill dentro de Claude Code — conduce una máquina de estados
y llama al revisor sin interfaz mediante `codex exec --sandbox read-only`.

No hay dos agentes vigilando un archivo. Un agente existe solo dentro de su
propio turno; "vigilar en segundo plano" necesita un disparador externo de todos
modos, y dos escritores sobre un mismo markdown producen carreras. Así que un
lado orquesta y el otro es una función invocada.

| | Fase | Quién | Qué ocurre |
|---|---|---|---|
| A | Init | script | resolver objetivo, lock, estado, `PR/` a `.git/info/exclude` |
| B | Gate | script | build, tipos, lint, tests — el código en rojo nunca va a revisión |
| C | Review | Codex | `codex exec --sandbox read-only`, panel en paralelo |
| D | Triage | script | parsear veredicto, normalizar severidad, ids estables, deduplicar |
| E | Fix | Claude | aplicar correcciones, ledger, disputar en vez de omitir en silencio |
| F | Verify | script | gate otra vez, revisar solo `reviewed_sha..HEAD` |
| G | Merge | script | 17 reglas contra el estado real de GitHub, luego `gh pr merge` |
| H | Finish | script | cerrar la ronda, renderizar el informe, notificar |

La decisión de parar es una función pura, no un modelo. Contar severidades y
comparar conjuntos de hallazgos entre rondas es aritmética, y los modelos se
equivocan en eso.

## Instalación

Requiere Claude Code 2.x, Node 18+, git. `gh` para revisar por número de PR.

**1. Codex CLI** — el plugin lo invoca sin interfaz, así que debe estar en `PATH`.

```bash
npm install -g @openai/codex
codex login
```

**2. El plugin** — dentro de una sesión de Claude Code, un comando por mensaje:

```
/plugin marketplace add estimablejunk/pr-second-pilot
/plugin install pr-second-pilot@pr-second-pilot
```

**3. Recargar** — `/reload-plugins` en el cliente de terminal. La extensión de
VS Code no tiene ese comando: usa **Developer: Reload Window**.

**4. Configurar** — `/pr-second-pilot:setup` mira tu repositorio y tu entorno y
propone ajustes, cada uno con su motivo. No escribe nada hasta que lo apruebes, y
solo muestra lo que realmente hay que cambiar.

Detecta, entre otras cosas, si tus tests necesitan servicios vivos (en cuyo caso un
gate local no comprueba nada y el gate debe ser CI) y si el código toca
autenticación o pagos (en cuyo caso el segundo revisor se paga solo).

**5. Comprobar** — `/pr-second-pilot:doctor` muestra qué se encontró y, sobre
todo, **con qué bolsa se paga la revisión**.

## Actualización

```
claude plugin update pr-second-pilot@pr-second-pilot
```

El nombre completo es obligatorio. Un plugin se direcciona como
`<plugin>@<marketplace>`, y aquí ambos coinciden — la duplicación parece una
errata, pero no lo es. La forma corta responde «no encontrado».

Dentro de una sesión también sirve `/plugin` → **Marketplaces →
pr-second-pilot → Update**. Los marketplaces de terceros traen la
autoactualización desactivada; se activa en ese mismo menú.

## Uso

```
/pr-second-pilot:review 45         revisar el PR #45
/pr-second-pilot:review branch      revisar la rama actual contra su base
/pr-second-pilot:resume 45          continuar tras tu respuesta o el reinicio del límite
/pr-second-pilot:usage              coste de las ejecuciones y límites restantes
/pr-second-pilot:settings           ver o cambiar ajustes
/pr-second-pilot:setup              configuración inicial con motivos
/pr-second-pilot:doctor             comprobar el entorno
```

No hace falta tocar tu copia de trabajo: puede estar en una rama ajena con
cambios sin confirmar. El plugin extrae el PR en su propio worktree y lo elimina
después.

El informe queda en `PR/45.md`, el estado en `PR/.state/45.json`. Arriba del
informe está **Qué se hizo**: un resumen breve y llano de qué hace el cambio, qué
resultó estar roto y cómo se arregló. Es la sección que alguien abre una semana
después; las tablas de hallazgos responden a otra pregunta.

`PR/` se excluye mediante `.git/info/exclude` — local, nunca se confirma.
Editar el `.gitignore` versionado aparecería dentro del mismo diff bajo revisión.

## Ajustes

Valores por defecto → `~/.claude/pr-second-pilot/config.json` →
`.pr-second-pilot.json` del repositorio → flags del comando. Lista completa en
[config.example.json](plugins/pr-second-pilot/skills/review/config.example.json).

```bash
# Revisor: modelo, esfuerzo, panel
/pr-second-pilot:settings reviewer.model=gpt-5.6-sol reviewer.effort=high
/pr-second-pilot:settings reviewer.panel=tech-lead,security

# Ejecutor: inherit — corrige la sesión actual, visible en el IDE
#           subprocess — un `claude -p` aparte con su modelo y esfuerzo
/pr-second-pilot:settings fixer.mode=subprocess fixer.model=opus fixer.effort=xhigh

# Idioma de informes y veredictos: en · ru · zh · es · pt · ja
/pr-second-pilot:settings report.language=es

# Ciclo
/pr-second-pilot:settings loop.max_rounds=4 loop.blocking_severities=critical,major
```

El esfuerzo del ejecutor solo se configura en modo `subprocess`: los subagentes
de Claude Code tienen campo `model` pero no campo de esfuerzo — se fija con el
flag `--effort` al lanzar el proceso.

### Modelo del revisor

**En el momento de esta versión, la mejor combinación es `gpt-5.6-sol` con
`effort=high`.** Fue la que encontró todos los defectos reales en el pull request
sobre el que se probó este plugin.

Tómalo como punto de partida, no como verdad permanente. Los modelos se
reemplazan. Cuando salga uno nuevo, compara — con `/pr-second-pilot:usage` puedes
sopesar tanto el coste como la calidad.

### Idioma

`report.language` gobierna el informe y los veredictos del revisor. Las
instrucciones del propio revisor se mantienen en un solo idioma: son
instrucciones para un modelo, no algo que lea una persona, y tenerlas en seis
traducciones condenaría a cinco a desviarse de la sexta. Traducirlas es una
contribución bienvenida; el idioma de salida ya funciona.

### Revisores propios

Los integrados son `tech-lead` y `security` en
[reviewers/](plugins/pr-second-pilot/reviewers/), escritos sin atarse a ningún
repositorio ni stack: deducen el proyecto de sus propios archivos — `CLAUDE.md`
/ `AGENTS.md`, manifiestos, workflows, directorios de migraciones.

El conocimiento específico de cada tecnología vive en perfiles de stack
(`reviewers/stacks/*.md`) y se adjunta automáticamente por detección de
dependencias. El plugin trae un perfil `nextjs-supabase`.

### Telegram

Las notificaciones se disparan solo por eventos que merecen interrumpir a alguien:
hace falta una decisión, el ciclo terminó, el ciclo se detuvo, se agotó la cuota.
El progreso no se envía nunca — un bot que reporta cada ronda es un bot que la
gente silencia.

Los secretos van solo a la configuración de usuario o a variables de entorno
(`PR_SECOND_PILOT_TG_TOKEN`, `PR_SECOND_PILOT_TG_CHAT`). La misma clave en la
configuración del proyecto se descarta con aviso — ese archivo acabaría en el diff
revisado.

## Fusión

Cuando el ciclo permite la fusión, el agente la ejecuta. Pero el veredicto del
ciclo es solo la mitad de la decisión; la otra mitad se le pregunta a GitHub.
Diecisiete reglas pueden prohibirla:

| Regla | Prohíbe cuando |
|---|---|
| `head_moved` | el head se movió tras la revisión — nadie miró ese código |
| `open_blockers` · `open_disputes` · `open_questions` | el ciclo no cerró sus hallazgos |
| `gate_red` | las comprobaciones objetivas fallan |
| `checks_failed` · `checks_pending` | CI falló o sigue corriendo |
| `changes_requested` | una persona pidió cambios en review |
| `approval_required` | las reglas del repositorio exigen aprobación |
| `branch_protection` · `conflicts` · `behind_base` | GitHub no está listo |
| `unresolved_threads` | el PR tiene conversaciones sin resolver |
| `forbidden_label` | etiqueta `do-not-merge`, `wip`, `on-hold` |
| `forbidden_path` · `base_not_allowed` | rutas protegidas o rama base tocadas |

La fusión se fija al SHA revisado (`--match-head-commit`): si algo aterriza
entre la comprobación de reglas y la llamada, GitHub rechaza en vez de fusionar
código más nuevo.

`merge.admin=true` salta la protección de rama. El agente nunca lo activa, y la
configuración avisa cuando lo haces.

## Coste de una ejecución

Una revisión no es "leer un diff". El revisor recorre el código durante decenas de
turnos, y cada turno reenvía todo el contexto acumulado. Medido en un PR real: una
ronda costó 2,7 M de tokens de entrada frente a 15 K de salida. Pagas por leer.

| Medida | Turnos | Tokens |
|---|---|---|
| nada | 27 | 2.710.833 |
| `preload_files` — fuentes en el prompt | 25 | 2.655.348 |
| instrucciones del revisor incorporadas | 17 | 1.404.418 |
| `isolate_skills` + reutilización de hilo | 4 | 664.772 |

**Las instrucciones incorporadas** son la mitad del ahorro. Una ruta a un archivo
de skill significa que el revisor gastará un turno en leerlo.

**Aislamiento de skills** (`reviewer.isolate_skills`) — Codex carga
incondicionalmente todo lo de `~/.codex/skills`, y ningún flag lo desactiva. El
plugin lo ejecuta en un `CODEX_HOME` sombra, con enlaces a auth y sesiones pero
sin directorio de skills. No es solo cuestión de tokens: entre lo cargado
automáticamente había skills de otro proyecto y otra arquitectura, que ordenaban al
modelo publicar en el PR y lanzar monitores — en contradicción directa con el
prompt de revisión.

## Límites de la suscripción

Con `codex login`, la revisión gasta los límites de tu plan de ChatGPT — la misma
bolsa que el Codex de escritorio. Cuánto cuesta una ejecución depende de tu plan,
del tamaño del diff y de la forma del repositorio, así que lee las cifras reales de
tu entorno con `/pr-second-pilot:usage` en lugar de cualquier número citado aquí.

Agotarlos está previsto en el diseño:

- alcanzar el límite es un resultado reanudable, no un fallo: el estado se guarda y
  `/pr-second-pilot:resume` continúa desde el mismo punto;
- el código en rojo nunca va a revisión;
- desde la segunda ronda el revisor ve solo el delta;
- el panel de dos revisores corre solo en la primera ronda;
- nunca se gasta una ronda en un `nit`.

## Invariantes

- El revisor corre bajo `--sandbox read-only`; el flag es un literal y no se
  expone a la configuración.
- Toda lectura de archivo viene del SHA revisado, nunca de la copia de trabajo. En
  una sola ejecución real esta regla atrapó cuatro bugs distintos.
- El informe es una vista del estado. Solo el bloque de respuestas humanas se edita
  a mano, y sobrevive al re-renderizado.
- El ejecutor no puede debilitar tests para cerrar un hallazgo. Puede disputar un
  test con evidencia, pero no reescribirlo en silencio.
- Los hallazgos sobre archivos fuera del diff nunca bloquean la fusión.
- `loop.hard_cap` nunca se supera.

## Desarrollo

```bash
cd plugins/pr-second-pilot/skills/review/scripts
node parse-verdict.mjs   --self-test    # 17 comprobaciones
node merge-findings.mjs  --self-test    # 13 comprobaciones
node evaluate-stop.mjs   --self-test    # 17 comprobaciones
node merge-pr.mjs        --self-test    # 23 reglas de fusión
node commit-round.mjs    --self-test    #  8 de contabilidad
```

Las respuestas en bruto del revisor, los prompts y los briefs quedan en
`PR/.state/<slug>.work/round<N>/`. Si un veredicto parece raro, empieza por ahí.

## Licencia

MIT.
