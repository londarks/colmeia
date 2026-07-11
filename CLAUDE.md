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
- Cada `TerminalNode` cria seu `Terminal`, faz `ptySpawn` no mount e `ptyKill` no unmount.

### Arquivos-chave

| Arquivo | Papel |
|---|---|
| `src-tauri/src/pty.rs` | Gerenciador de PTY + estado compartilhado (sessões, grafo, buffer, token). |
| `src-tauri/src/orchestrator.rs` | Servidor HTTP loopback (127.0.0.1) que a CLI `colmeia` consome. |
| `src-tauri/src/cli/colmeia.js` | A CLI injetada no PATH de cada terminal (`list`/`check`/`ask`). |
| `src-tauri/src/lib.rs` | Registra estado + comandos + sobe o servidor loopback. |
| `src/nodes/TerminalNode.tsx` | Nó do canvas com xterm.js ligado ao PTY. |
| `src/lib/pty.ts` | Wrapper TS dos comandos Rust + `Channel`. |
| `src/lib/agents.ts` | Catálogo de agentes (comando + args por tipo). |
| `src/lib/theme.ts` + `src/index.css` | Sistema de temas por `data-theme`. |

## Comunicação entre agentes (roteamento)

Os agentes não recebem auto-encaminhamento de saída. Cada terminal recebe a CLI **`colmeia`** no PATH
+ envs `COLMEIA_NODE_ID`, `COLMEIA_TOKEN`, `COLMEIA_PORT`. A CLI fala com o servidor loopback do backend:

- `colmeia list` — agentes conectados a este nó (escopo pelas arestas do canvas)
- `colmeia check "<agente>"` — lê a saída recente (buffer ~16k) de outro terminal
- `colmeia ask "<agente>" "<prompt>"` — escreve um prompt no stdin de outro terminal

O frontend espelha o grafo via `set_graph` a cada mudança de nós/arestas. Toda chamada ao servidor
exige o token da sessão (sem isso → 403); o bind é só em 127.0.0.1 e **não há CORS**. Regra: manter esse
endurecimento; nunca abrir CORS nem expor o servidor fora do loopback.

## Convenções

- **Adicionar um agente:** inclua uma entrada em `AGENTS` (`src/lib/agents.ts`) com `resolve()`
  retornando `{ command, args }`. Ele aparece automaticamente na barra e no MiniMap.
- **Temas:** cores vêm de tokens CSS (`--bg-*`, `--text-*`, `--accent`, ...) definidos por
  `[data-theme]` em `src/index.css` (portados do projeto irmão `markdown`). Componentes usam os
  tokens; o xterm lê os tokens via `readXtermTheme()`. Não hardcode cores.
- **Português** nos comentários e na UI; código/identificadores em inglês.
- **Windows-first** no ambiente atual (shell padrão = `powershell.exe`), mas mantenha o código
  cross-platform.

## Commits e Pull Requests

- **NÃO se auto-cite.** Mensagens de commit e descrições de PR **não devem** conter linhas como
  `Co-Authored-By: Claude`, `Generated with Claude Code`, nem qualquer menção a Claude/Anthropic
  ou à ferramenta usada. Escreva a mensagem como se fosse do próprio autor humano.
- Commits em imperativo, curtos e descritivos (ex.: "adiciona roteamento entre agentes").
- Não commitar nem dar push sem o usuário pedir. Nunca use `--no-verify`.

## Roadmap (próximos passos)

1. **Roteamento entre agentes** — quando existe aresta A→B, encaminhar a saída de A para o
   `pty_write` de B (detecção de ociosidade por silêncio no stream). É o foco principal.
2. **Ombro** — supervisor local (Ollama) que observa os buffers e sugere próximos passos.
3. **Floors** — clones isolados do workspace via `git worktree`.
4. Desenho livre / sticky notes · persistência do canvas em JSON + Markdown.
