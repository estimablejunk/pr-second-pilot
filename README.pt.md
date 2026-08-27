<p align="center">
  <img src="docs/hero.png" alt="pr-second-pilot — Codex e Claude na mesma cabine" width="720">
</p>

<h1 align="center">pr-second-pilot</h1>

<p align="center"><em>Um segundo piloto para pull requests: Codex revisa, Claude corrige,<br>
o ciclo se repete até o merge ser permitido — e o executa quando as regras deixam.</em></p>

---

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.ru.md">Русский</a> ·
  <a href="README.zh.md">简体中文</a> ·
  <a href="README.es.md">Español</a> ·
  <a href="README.pt.md">Português</a> ·
  <a href="README.ja.md">日本語</a>
</p>

Um plugin do Claude Code que roda um ciclo de revisão de código entre modelos de
dois fornecedores. O Codex revisa o pull request, o Claude aplica as correções, a
rodada se repete até o merge ser permitido ou ser preciso um humano.

Não se trata de uma segunda opinião. Modelos diferentes falham de formas
diferentes, e um revisor de outra família encontra no código do Claude o que o
Claude não vê em si mesmo. No pull request em que este plugin foi construído, a
revisão pegou uma chamada REST que jamais entregaria o que a funcionalidade
prometia, um travamento de 30 segundos no event loop, um erro reportado ao usuário
como sucesso, perda de escritas concorrentes e uma condição de corrida com uma
tarefa em segundo plano — além de dois defeitos nas correções feitas em resposta
aos seus próprios achados.

Uso passo a passo: [docs/USAGE.md](docs/USAGE.md).

## Como funciona

Um orquestrador — uma skill dentro do Claude Code — conduz uma máquina de estados
e chama o revisor sem interface via `codex exec --sandbox read-only`.

Não existem dois agentes vigiando um arquivo. Um agente existe apenas dentro do
próprio turno; "vigiar em segundo plano" precisa de um gatilho externo de qualquer
jeito, e dois escritores no mesmo markdown geram corridas. Então um lado orquestra
e o outro é uma função chamada.

| | Fase | Quem | O que acontece |
|---|---|---|---|
| A | Init | script | resolver alvo, lock, estado, `PR/` em `.git/info/exclude` |
| B | Gate | script | build, tipos, lint, testes — código vermelho nunca vai para revisão |
| C | Review | Codex | `codex exec --sandbox read-only`, painel em paralelo |
| D | Triage | script | parsear veredito, normalizar severidade, ids estáveis, deduplicar |
| E | Fix | Claude | aplicar correções, ledger, contestar em vez de pular em silêncio |
| F | Verify | script | gate de novo, revisar só `reviewed_sha..HEAD` |
| G | Merge | script | 17 regras contra o estado real do GitHub, então `gh pr merge` |
| H | Finish | script | fechar a rodada, renderizar o relatório, notificar |

A decisão de parar é uma função pura, não um modelo. Contar severidades e comparar
conjuntos de achados entre rodadas é aritmética, e modelos erram nisso.

## Instalação

Requer Claude Code 2.x, Node 18+, git. `gh` para revisar por número de PR.

**1. Codex CLI** — o plugin o invoca sem interface, então precisa estar no `PATH`.

```bash
npm install -g @openai/codex
codex login
```

**2. O plugin** — dentro de uma sessão do Claude Code, um comando por mensagem:

```
/plugin marketplace add estimablejunk/pr-second-pilot
/plugin install pr-second-pilot@pr-second-pilot
```

**3. Recarregar** — `/reload-plugins` no cliente de terminal. A extensão do
VS Code não tem esse comando: use **Developer: Reload Window**.

**4. Conferir** — `/pr-second-pilot:doctor` mostra o que foi encontrado e,
principalmente, **qual bolso paga a revisão**.

## Uso

```
/pr-second-pilot:review 45         revisar o PR #45
/pr-second-pilot:review branch      revisar o branch atual contra sua base
/pr-second-pilot:resume 45          continuar após sua resposta ou o reset do limite
/pr-second-pilot:usage              custo das execuções e limites restantes
/pr-second-pilot:settings           ver ou alterar configurações
/pr-second-pilot:doctor             checar o ambiente
```

Você não precisa mexer na sua cópia de trabalho: ela pode estar num branch alheio
com alterações não commitadas. O plugin faz checkout do PR no próprio worktree e o
remove depois.

O relatório fica em `PR/45.md`, o estado em `PR/.state/45.json`. No topo do
relatório está **O que foi feito**: um resumo curto e direto do que a mudança faz,
o que estava quebrado e como foi corrigido. É essa a seção que alguém abre uma
semana depois; as tabelas de achados respondem a outra pergunta.

`PR/` é excluído via `.git/info/exclude` — local, nunca commitado. Editar o
`.gitignore` versionado apareceria dentro do próprio diff em revisão.

## Configurações

Padrões → `~/.claude/pr-second-pilot/config.json` → `.pr-second-pilot.json` do
repositório → flags do comando. Lista completa em
[config.example.json](plugins/pr-second-pilot/skills/review/config.example.json).

```bash
# Revisor: modelo, esforço, painel
/pr-second-pilot:settings reviewer.model=gpt-5.6-sol reviewer.effort=high
/pr-second-pilot:settings reviewer.panel=tech-lead,security

# Executor: inherit — a sessão atual corrige, visível na IDE
#           subprocess — um `claude -p` separado com modelo e esforço próprios
/pr-second-pilot:settings fixer.mode=subprocess fixer.model=opus fixer.effort=xhigh

# Idioma de relatórios e vereditos: en · ru · zh · es · pt · ja
/pr-second-pilot:settings report.language=pt

# Ciclo
/pr-second-pilot:settings loop.max_rounds=4 loop.blocking_severities=critical,major
```

O esforço do executor só é configurável no modo `subprocess`: subagentes do
Claude Code têm campo `model`, mas não campo de esforço — ele é definido pela
flag `--effort` ao iniciar o processo.

### Modelo do revisor

**No momento deste lançamento, a melhor combinação é `gpt-5.6-sol` com
`effort=high`.** Foi ela que encontrou todos os defeitos reais no pull request em
que este plugin foi testado.

Encare isso como ponto de partida, não como verdade permanente. Modelos são
substituídos. Quando surgir um novo, compare — com `/pr-second-pilot:usage` dá
para pesar custo além de qualidade.

### Idioma

`report.language` comanda o relatório e os vereditos do revisor. As instruções do
próprio revisor ficam num único idioma: são instruções para um modelo, não algo que
uma pessoa leia, e mantê-las em seis traduções condenaria cinco a divergir da sexta.
Traduzi-las é uma contribuição bem-vinda; o idioma de saída já funciona.

### Revisores próprios

Os embutidos são `tech-lead` e `security` em
[reviewers/](plugins/pr-second-pilot/reviewers/), escritos sem amarras a repositório
ou stack: eles deduzem o projeto pelos próprios arquivos — `CLAUDE.md` /
`AGENTS.md`, manifestos, workflows, diretórios de migração.

Conhecimento específico de tecnologia vive em perfis de stack
(`reviewers/stacks/*.md`), anexados automaticamente por detecção de dependências.
O plugin traz um perfil `nextjs-supabase`.

### Telegram

Notificações disparam só em eventos que justificam interromper alguém: precisa de
decisão, o ciclo terminou, o ciclo parou, a cota acabou. Progresso nunca é enviado —
um bot que reporta cada rodada é um bot que as pessoas silenciam.

Segredos vão só para a configuração de usuário ou variáveis de ambiente
(`PR_SECOND_PILOT_TG_TOKEN`, `PR_SECOND_PILOT_TG_CHAT`). A mesma chave na
configuração do projeto é descartada com aviso — aquele arquivo acabaria no diff
revisado.

## Merge

Quando o ciclo permite o merge, o agente o executa. Mas o veredito do ciclo é só
metade da decisão; a outra metade é perguntada ao GitHub. Dezessete regras podem
proibi-lo:

| Regra | Proíbe quando |
|---|---|
| `head_moved` | o head mudou após a revisão — ninguém olhou aquele código |
| `open_blockers` · `open_disputes` · `open_questions` | o ciclo não fechou seus achados |
| `gate_red` | as verificações objetivas estão falhando |
| `checks_failed` · `checks_pending` | CI falhou ou ainda está rodando |
| `changes_requested` | uma pessoa pediu mudanças no review |
| `approval_required` | regras do repositório exigem aprovação |
| `branch_protection` · `conflicts` · `behind_base` | o GitHub não está pronto |
| `unresolved_threads` | o PR tem conversas não resolvidas |
| `forbidden_label` | label `do-not-merge`, `wip`, `on-hold` |
| `forbidden_path` · `base_not_allowed` | caminhos protegidos ou branch base tocados |

O merge é fixado no SHA revisado (`--match-head-commit`): se algo chegar entre a
checagem das regras e a chamada, o GitHub recusa em vez de mesclar código mais novo.

`merge.admin=true` ignora a proteção de branch. O agente nunca o ativa, e a
configuração avisa quando você ativa.

## Custo de uma execução

Uma revisão não é "ler um diff". O revisor percorre o código por dezenas de turnos,
e cada turno reenvia todo o contexto acumulado. Medido num PR real: uma rodada
custou 2,7 M de tokens de entrada contra 15 K de saída. Você paga pela leitura.

| Medida | Turnos | Tokens |
|---|---|---|
| nada | 27 | 2.710.833 |
| `preload_files` — fontes no prompt | 25 | 2.655.348 |
| instruções do revisor embutidas | 17 | 1.404.418 |
| `isolate_skills` + reuso de thread | 4 | 664.772 |

**Instruções embutidas** são metade da economia. Um caminho para um arquivo de
skill significa que o revisor gastará um turno lendo-o.

**Isolamento de skills** (`reviewer.isolate_skills`) — o Codex carrega
incondicionalmente tudo de `~/.codex/skills`, e nenhuma flag desliga isso. O
plugin o roda num `CODEX_HOME` sombra, com links para auth e sessões mas sem
diretório de skills. Não é só sobre tokens: entre as skills carregadas
automaticamente havia as de outro projeto e outra arquitetura, mandando o modelo
publicar no PR e iniciar monitores — em contradição direta com o prompt de revisão.

## Limites da assinatura

Com `codex login`, a revisão gasta os limites do seu plano ChatGPT — o mesmo bolso
do Codex de desktop. Quanto uma execução custa depende do seu plano, do tamanho do
diff e do formato do repositório, então leia os números reais do seu ambiente com
`/pr-second-pilot:usage` em vez de qualquer valor citado aqui.

Esgotar está previsto no design:

- bater no limite é um resultado retomável, não uma falha: o estado é salvo e
  `/pr-second-pilot:resume` continua do mesmo ponto;
- código vermelho nunca vai para revisão;
- da segunda rodada em diante o revisor vê só o delta;
- o painel de dois revisores roda apenas na primeira rodada;
- nunca se gasta uma rodada com um `nit`.

## Invariantes

- O revisor roda sob `--sandbox read-only`; a flag é literal e não é exposta à
  configuração.
- Toda leitura de arquivo vem do SHA revisado, nunca da cópia de trabalho. Numa
  única execução real essa regra pegou quatro bugs distintos.
- O relatório é uma visão do estado. Só o bloco de respostas humanas é editado à
  mão, e ele sobrevive à re-renderização.
- O executor não pode enfraquecer testes para fechar um achado. Pode contestar um
  teste com evidência, mas não reescrevê-lo em silêncio.
- Achados sobre arquivos fora do diff nunca bloqueiam o merge.
- `loop.hard_cap` nunca é ultrapassado.

## Desenvolvimento

```bash
cd plugins/pr-second-pilot/skills/review/scripts
node parse-verdict.mjs   --self-test    # 17 checagens
node merge-findings.mjs  --self-test    # 13 checagens
node evaluate-stop.mjs   --self-test    # 17 checagens
node merge-pr.mjs        --self-test    # 23 regras de merge
node commit-round.mjs    --self-test    #  8 de contabilidade
```

Respostas brutas do revisor, prompts e briefings ficam em
`PR/.state/<slug>.work/round<N>/`. Se um veredito parecer estranho, comece por aí.

## Licença

MIT.
