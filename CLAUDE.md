# CLAUDE.md

Guia para agentes trabalhando neste repositório.

## O que é

**colmeia** é um orquestrador de agentes de IA em canvas infinito, inspirado no
[Maestri](https://www.themaestri.app) mas **cross-platform** e **sem marca-d'água**.
Cada agente (Claude Code, Codex, Ollama ou shell) roda num **terminal real** (PTY) que vira
um nó arrastável no canvas. O objetivo é conectar os nós e fazer os agentes conversarem via PTY.

## Stack

- **Tauri 2** (shell nativo + backend Rust) · **Bun** (pkg manager/scripts)
- **React 19 + TypeScript** · **React Flow** (`@xyflow/react`, MIT) para o canvas
- **xterm.js** (UI do terminal) · **portable-pty** (Rust) para os pseudo-terminais

> Regra de produto: **nunca** introduzir dependência que imponha marca-d'água. Foi por isso que
> escolhemos React Flow em vez de tldraw. Mantenha `proOptions.hideAttribution` ligado.

## Comandos

```bash
bun install               # instala deps do frontend
bun run tauri dev         # sobe o app em dev (Vite :1420 + binário Rust)
bun run tauri build       # gera o instalável
bunx tsc --noEmit         # type-check
bunx vite build           # build só do frontend (pega erros de import/CSS)
cd src-tauri && cargo check   # checa o backend Rust
```

Se a porta **1420** ficar presa (Vite órfão), mate o processo dono da porta antes de rodar de novo.

## Arquitetura

```
Frontend (React)                         Backend (Rust / Tauri)
─────────────────                        ──────────────────────
App.tsx            canvas + barra        pty.rs   PtyState<HashMap<id, sessão>>
 └ TerminalNode    xterm.js por nó  ◄──►  comandos: pty_spawn / pty_write
 └ lib/pty.ts      ponte invoke()                  / pty_resize / pty_kill
 └ lib/agents.ts   catálogo de agentes    portable-pty (native_pty_system)
 └ lib/theme.ts    temas + cores xterm
```

- A **saída do PTY** vai em **base64** por um `Channel<PtyOutput>` do Tauri (evita corromper UTF-8
  quando um caractere multibyte é partido entre chunks). Decodificada em `b64ToBytes`.
- O **`id` do nó** no canvas é a chave da sessão de PTY no backend. Um `id` = um processo.
- Os terminais vivem no `terminalRegistry` (fora do React): o nó só anexa o elemento; `ptyKill` acontece ao deletar o nó ou o canvas, não ao trocar de canvas.

### Arquivos-chave

| Arquivo | Papel |
|---|---|
| `src-tauri/src/pty.rs` | Sessões de PTY + estado compartilhado (`Shared`: grafo, tokens por nó, presets) + geração da CLI/hooks. |
| `src-tauri/src/screen.rs` | Modelo de tela headless (`vt100`) por sessão: texto limpo, cursor, bracketed paste, hash da tela. |
| `src-tauri/src/scope.rs` | Escopo pelas arestas (`reach`, `team_reach`, `resolve` com NotFound/NotConnected/Ambiguous). |
| `src-tauri/src/delivery.rs` | Entrega robusta de prompt (`Shared::deliver`): fila por terminal, paste, Enter confirmado. |
| `src-tauri/src/activity.rs` | Estado working/idle/attention (hooks do Claude + heurística de tela), `wait_turn`. |
| `src-tauri/src/asks.rs` | `ask` bloqueante, ask-back, quebra de deadlock, `--raw`. |
| `src-tauri/src/roles.rs` | Papéis (built-ins + `app_data_dir/roles.json`), comando `roles_list`. |
| `src-tauri/src/skills.rs` + `src/skills/*/SKILL.md` | Plugin de skills do Claude (`--plugin-dir`) e AGENTS.md dos diretórios de papel. |
| `src-tauri/src/routines.rs` | Scheduler único de rotinas (once/interval/daily/weekly), persistido em `routines.json`; espera alvo ocupado. |
| `src-tauri/src/floors/` | Floors (git worktree) com registro de posse, seeding de `.env`/deps, land com prévia de conflitos, status e env por floor (`COLMEIA_PORT_BASE`). |
| `src-tauri/src/partituras.rs` | Partituras (templates de equipe) em `app_data_dir/partituras` + `colmeia partitura list/insert`. |
| `src-tauri/src/scrollback.rs` · `power.rs` · `dropfiles.rs` | Scrollback em disco · keep-awake · leitura de arquivos soltos no canvas. |
| `src-tauri/src/orchestrator.rs` | Servidor HTTP loopback (127.0.0.1) que a CLI `colmeia` consome. |
| `src-tauri/src/cli/colmeia.js` | A CLI injetada no PATH de cada terminal. `colmeia-approve.js`/`colmeia-event.js` são os hooks do Claude. |
| `src-tauri/src/lib.rs` | Registra estado + comandos + sobe o servidor loopback e o ticker de atividade. |
| `src/nodes/TerminalNode.tsx` | Nó do canvas: só anexa o terminal do registry (não mata o PTY ao desmontar). |
| `src/lib/terminalRegistry.ts` | Terminais vivos fora do React (sobrevivem à troca de canvas), scrollback, busca, Lift. `ptyKill` só ao deletar o nó/canvas. |
| `src/lib/activity.ts` | Store de atividade/status por nó (eventos `colmeia://activity`/`status`). |
| `src/lib/useCanvasControls.tsx` | Palette (Ctrl+K), atalhos, notificações, undo/redo, câmera — integrados num hook. |
| `src/hooks/use*.ts` | Partituras, copiar/colar, drop de arquivos, grupos. |
| `src/lib/pty.ts` | Wrapper TS dos comandos Rust + `Channel`. |
| `src/lib/agents.ts` | Catálogo de agentes (comando + args por tipo). |
| `src/lib/roles.ts` | Built-ins (`ROLES`/`ROLE_MAP`) + `loadRoles()` do backend. |
| `src/lib/theme.ts` + `src/styles/themes/` | Sistema de temas por `data-theme`. |

## Comunicação entre agentes (roteamento)

Os agentes não recebem auto-encaminhamento de saída. Cada terminal recebe a CLI **`colmeia`** no PATH
+ envs `COLMEIA_NODE_ID`, `COLMEIA_TOKEN` (**um token por terminal**, gerado no spawn e invalidado no
kill), `COLMEIA_PORT`, `COLMEIA_CLI`. A CLI manda o token no header `X-Colmeia-Token`; o servidor deriva
**quem chama só do token** (nunca de query/corpo) e resolve todo nome **com escopo** pelas arestas
(`scope.rs`) em todas as rotas. Comandos estruturais (recruit/dismiss/role create|edit|write|assign/
routine create|delete, connect fora do alcance direto) exigem `data.maestro` no nó **ou** o papel
`orquestrador`. Sintaxe completa: `colmeia help` e as skills em `src-tauri/src/skills/`.

- `colmeia list` / `check` (tela renderizada) / `wait` / `ask` (bloqueante; `--no-wait`, `--batch`,
  `--raw`, `--file`, `-`) / `context` / `note list|read|write|edit|create` / `notify` / `status`
  / `recruit [--agent --role --dir --replace]` / `dismiss` / `connect` / `role …` / `preset list`
  / `routine create|list|show|edit|enable|disable|run|delete` / `floor list|create|status|land|delete`
  / `partitura list|insert` / `debug` (usa `GET /health`, a única rota sem token).
- Contrato da CLI: exit 0 = ok, 2 = aviso (header `X-Colmeia-Warning`, texto "aviso: …"), 1 = erro.
- O papel entra **uma vez** no boot: Claude via `--append-system-prompt` (`<seu_papel>`); Codex e
  outros via `<cwd>/.colmeia/roles/<papel>/AGENTS.md` (+CLAUDE.md) usado como cwd. Nunca a cada ask.
- Skills do Claude: plugin gerado em runtime em `<bin>/colmeia-plugin/` e passado com `--plugin-dir`
  (nada em `~/.claude`). Para adicionar uma skill: crie `src/skills/<nome>/SKILL.md` e inclua em `SKILLS`.

Eventos backend→frontend: `add-note`, `note-update`, `connect`, `recruit`, `node-update` (patch +
`restart` → `restartKey` reinicia o processo mantendo id/arestas), `dismiss`, `interaction`,
`activity`, `status`, `notify`, `asks-in-flight`, `roles-changed`, `approval-*` (todos `colmeia://…`).

O frontend espelha o grafo via `set_graph` a cada mudança de nós/arestas. O bind é só em 127.0.0.1,
o header Host precisa ser de loopback e **não há CORS**. Regra: manter esse endurecimento; nunca abrir
CORS nem expor o servidor fora do loopback.

Mutações do canvas pedidas pelo agente (note/connect/routine) usam **eventos Tauri** backend→frontend;
o servidor loopback roda no `setup()` para ter o `AppHandle`. O canvas é persistido em `workspace.json`
(`app_data_dir`) via `workspace_save`/`workspace_load` — auto-load ao abrir, auto-save com debounce.

## Convenções

- **Adicionar um agente:** inclua uma entrada em `AGENTS` (`src/lib/agents.ts`) com `resolve()`
  retornando `{ command, args }`. Ele aparece automaticamente na barra e no MiniMap.
- **Temas:** cores vêm de tokens CSS (`--bg-*`, `--text-*`, `--accent`, ...) definidos por
  `[data-theme]` em `src/styles/themes/*.css` (13 temas portados do projeto irmão `markdown`,
  + paleta `--ansi-*` do terminal). Estilos em `src/styles/{base,shell,nodes,panels,overlays}.css`
  (importados em `main.tsx`); primitivas reutilizáveis `.ui-*` em `base.css`. Componentes usam os
  tokens; o xterm lê os tokens via `readXtermTheme()`. Não hardcode cores.
- **Português** nos comentários e na UI; código/identificadores em inglês.
- **Windows-first** no ambiente atual (shell padrão = `powershell.exe`), mas mantenha o código
  cross-platform.

## Commits e Pull Requests

- **Escreva os commits em INGLÊS**, com mensagens **profissionais**, no imperativo e concisas
  (ex.: `add agent routing over PTY edges`, `fix approval hook not loading via --settings`).
  Um resumo curto na primeira linha; se precisar, detalhe em bullets no corpo.
- **NÃO se auto-cite.** Mensagens de commit e descrições de PR **não devem** conter linhas como
  `Co-Authored-By: Claude`, `Generated with Claude Code`, nem qualquer menção a Claude/Anthropic
  ou à ferramenta usada. Escreva a mensagem como se fosse do próprio autor humano.
- Não commitar nem dar push sem o usuário pedir. Nunca use `--no-verify`.

## Roadmap (próximos passos)

1. **Roteamento entre agentes** — quando existe aresta A→B, encaminhar a saída de A para o
   `pty_write` de B (detecção de ociosidade por silêncio no stream). É o foco principal.
2. **Ombro** — supervisor local (Ollama) que observa os buffers e sugere próximos passos.
3. **Floors** — clones isolados do workspace via `git worktree`.
4. Desenho livre / sticky notes · persistência do canvas em JSON + Markdown.
