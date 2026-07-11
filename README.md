# 🐝 colmeia

Orquestrador de agentes de IA em **canvas infinito** — inspirado no [Maestri](https://www.themaestri.app),
mas **cross-platform** (Windows/macOS/Linux) e **sem marca-d'água**, construído com Tauri + Bun.

Cada agente (Claude Code, Codex, Ollama ou um shell) roda num **terminal real** que vira um nó
arrastável no canvas. Você conecta os nós com linhas — a ideia é que os agentes conversem entre si
via PTY, sem API no meio.

## Stack

| Camada | Tecnologia | Papel |
|---|---|---|
| App shell | **Tauri 2** | Janela nativa, backend Rust, empacotamento |
| Runtime/pkg | **Bun** | Instalação e scripts do frontend |
| Frontend | **React 19 + TypeScript** | UI |
| Canvas | **React Flow** (`@xyflow/react`, MIT) | Canvas infinito, nós conectáveis, pan/zoom, minimap |
| Terminal (UI) | **xterm.js** | Renderiza cada terminal |
| Terminal (backend) | **portable-pty** (Rust) | Spawna/gerencia os pseudo-terminais |

> **Por que React Flow e não tldraw?** O foco é *conectar agentes*, e não pode haver marca-d'água.
> React Flow é MIT, feito exatamente para grafos de nós, e como os nós são DOM de verdade o terminal
> xterm.js fica interativo dentro deles. tldraw exige licença paga para remover a marca-d'água.

## Arquitetura

```
┌─────────────────────────── Frontend (React) ───────────────────────────┐
│  App.tsx ── React Flow (canvas) ── TerminalNode (xterm.js por nó)        │
│                    │                        │                            │
│                    │ invoke()               │ Channel<PtyOutput> (stream)│
└────────────────────┼────────────────────────┼────────────────────────────┘
                     ▼                        ▲
┌─────────────────────────── Backend (Rust / Tauri) ─────────────────────┐
│  pty.rs ── PtyState (HashMap<id, sessão>) ── portable-pty               │
│  comandos: pty_spawn · pty_write · pty_resize · pty_kill               │
└─────────────────────────────────────────────────────────────────────────┘
```

- A saída do PTY vai em **base64** por um `Channel` do Tauri (evita corromper UTF-8 em chunks).
- O `id` do nó no canvas é a chave da sessão de PTY no backend.

## Rodando

```bash
bun install
bun run tauri dev      # sobe o app em modo dev
bun run tauri build    # gera o instalável
```

Requisitos: Rust + toolchain do Tauri (WebView2 no Windows). Para os agentes, tenha os CLIs no `PATH`
(`claude`, `codex`, `ollama`). O nó **Shell** funciona sem nada instalado.

## Estado atual (MVP)

- [x] Canvas infinito com nós de terminal reais (PTY ponta-a-ponta)
- [x] Agentes: Shell, Claude Code, Codex, Ollama
- [x] Nós arrastáveis, redimensionáveis, conectáveis; minimap; pan/zoom
- [ ] **Roteamento entre agentes** — encaminhar saída de um agente para a entrada de outro pela conexão
- [ ] **Ombro** — monitor local (Ollama) que observa os agentes e sugere próximos passos
- [ ] **Floors** — clones isolados do workspace via git worktree
- [ ] Desenho livre / sticky notes (camada de anotação)
- [ ] Persistência do canvas em JSON + Markdown local

## Roadmap técnico

1. **Roteamento** (`src-tauri`): ao existir uma aresta A→B, detectar quando A fica ocioso e
   encaminhar sua última saída para o `pty_write` de B. Detecção de ociosidade por silêncio no
   stream (sem bytes por N ms) + heurística de prompt.
2. **Ombro**: um agente supervisor via MCP/Ollama lendo o buffer dos terminais.
3. **Floors**: `git worktree add` por floor, cada agente com seu diretório isolado.
