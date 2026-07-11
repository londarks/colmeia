<div align="center">

<img src="logo-square.png" alt="colmeia" width="150" />

# colmeia

**Orquestrador de agentes de IA em canvas infinito**

_Uma colmeia de mentes: seus agentes conversam entre si — você conduz._

Cross-platform · sem marca-d'água · aprovações centralizadas

<br/>

![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-backend-000000?logo=rust&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![Bun](https://img.shields.io/badge/Bun-runtime-000000?logo=bun&logoColor=white)

</div>

---

## 🐝 O que é

**colmeia** é um orquestrador de agentes de IA num **canvas infinito**, inspirado no
[Maestri](https://www.themaestri.app) mas **cross-platform** (Windows/macOS/Linux) e **sem marca-d'água**.

Cada agente (Claude Code, Codex, Ollama ou um shell) roda num **terminal real** que vira um **nó
arrastável** no canvas. Você conecta os nós e os agentes **conversam entre si** — o dev deixa de ser
executor e vira **maestro**.

## ✨ Recursos

- 🖥️ **Terminais reais** — cada nó é um PTY de verdade rodando um shell ou uma CLI de agente.
- 🔗 **Agentes que se falam** — a CLI `colmeia` deixa um agente ver e mandar mensagem para os
  outros **conectados** a ele. As arestas do canvas definem quem enxerga quem.
- 🎭 **Papéis** — marque cada agente como **Orquestrador, Arquiteto, Engenheiro, Revisor ou
  Testador**. O briefing do papel é injetado no agente (e re-injetado a cada delegação).
- 🛡️ **Aprovações centralizadas** — quando um agente vai rodar um comando ou editar arquivo, a
  ação **pausa e aparece num painel central** para você **aprovar ou recusar**. Nada é
  auto-aprovado; você conduz tudo de um lugar só.
- ⏱️ **Rotinas** — agende um comando para rodar num terminal a cada N segundos.
- 📝 **Notas e conexões** — o próprio agente pode criar notas e conectar nós no canvas.
- 💾 **Persistência** — o canvas salva/carrega sozinho (layout, papéis, notas).
- 🎨 **Temas** — Midnight, Tokyo Night, Dracula, Rosé Pine (os terminais mudam ao vivo).
- 🪟 **App nativo** — janela sem moldura com barra de título própria.

## ⚡ A CLI `colmeia` (dentro de cada terminal)

| Comando | O que faz |
|---|---|
| `colmeia list` | Lista os agentes **conectados** a este nó, com seus papéis |
| `colmeia check "<agente>"` | Lê a saída recente de outro terminal |
| `colmeia ask "<agente>" "<tarefa>"` | Delega uma tarefa a outro agente (com o papel dele na frente) |
| `colmeia note "<título>" "<texto>"` | Cria uma nota no canvas |
| `colmeia connect "<a>" "<b>"` | Conecta dois nós |
| `colmeia routine create/list/delete` | Tarefas agendadas |

## 🧠 Como funciona

```
Terminal do agente ──(CLI colmeia)──►  Servidor loopback (127.0.0.1, com token)
                                         │
   ┌─────────────────────────────────────┼───────────────────────────────┐
   │ list/check/ask  → fala com os agentes conectados                     │
   │ /approve        → pausa o agente e pede aprovação ao painel central  │
   │ note/connect    → emite evento → o canvas (React) muta               │
   └─────────────────────────────────────────────────────────────────────┘
```

- Cada terminal é um **PTY** (`portable-pty`) no backend Rust; a saída vai em base64 por um `Channel` do Tauri.
- A **comunicação e as aprovações** passam por um servidor HTTP **só em loopback**, protegido por
  **token de sessão** e **sem CORS** — um site aberto no navegador não consegue chamar.

## 🧩 Stack

| Camada | Tecnologia |
|---|---|
| Shell nativo + backend | **Tauri 2** (Rust) |
| Pacotes/scripts | **Bun** |
| UI | **React 19 + TypeScript** |
| Canvas | **React Flow** (`@xyflow/react`, MIT — zero marca-d'água) |
| Terminal (UI / backend) | **xterm.js** / **portable-pty** |

> **Por que React Flow e não tldraw?** O foco é *conectar agentes*, e não pode haver marca-d'água.
> React Flow é MIT e, como os nós são DOM de verdade, o terminal xterm.js fica interativo dentro deles.

## 🚀 Rodando

```bash
bun install
bun run tauri dev      # modo desenvolvimento
bun run tauri build    # gera o instalável
```

Requisitos: **Rust** + toolchain do **Tauri** (WebView2 no Windows) + **Node** (a CLI `colmeia` usa).
Para os agentes, tenha os CLIs no `PATH` (`claude`, `codex`, `ollama`). O nó **Shell** funciona sem nada.

## 🗺️ Roadmap

- [x] Terminais reais em canvas, comunicação entre agentes, papéis
- [x] Aprovações centralizadas de permissão · rotinas · notas · persistência · temas
- [ ] **Ombro** — supervisor local (Ollama) que observa os agentes e sugere passos
- [ ] **Floors** — clones isolados do workspace via `git worktree`
- [ ] Conexões tipadas (fluxo de dados × controle) · desenho livre
