// Catálogo de tipos de agente que um nó do canvas pode rodar.
// Cada agente é só um comando que sobe dentro de um PTY.

export type AgentId = "shell" | "claude" | "codex" | "ollama";

export interface AgentDef {
  id: AgentId;
  label: string;
  emoji: string;
  color: string;
  /** Resolve o comando + args para spawnar no PTY. */
  resolve: () => { command: string; args: string[] };
}

const isWindows =
  typeof navigator !== "undefined" && /Win/i.test(navigator.userAgent);

const defaultShell = () =>
  isWindows
    ? { command: "powershell.exe", args: [] as string[] }
    : { command: "bash", args: [] as string[] };

export const AGENTS: Record<AgentId, AgentDef> = {
  shell: {
    id: "shell",
    label: "Shell",
    emoji: "🖥️",
    color: "#64748b",
    resolve: defaultShell,
  },
  claude: {
    id: "claude",
    label: "Claude Code",
    emoji: "🟣",
    color: "#a855f7",
    resolve: () => ({ command: "claude", args: [] }),
  },
  codex: {
    id: "codex",
    label: "Codex",
    emoji: "🟢",
    color: "#10b981",
    resolve: () => ({ command: "codex", args: [] }),
  },
  ollama: {
    id: "ollama",
    label: "Ollama",
    emoji: "🦙",
    color: "#f59e0b",
    // REPL interativo do Ollama. Troque o modelo conforme o que tiver puxado.
    resolve: () => ({ command: "ollama", args: ["run", "llama3.2"] }),
  },
};

export const AGENT_LIST = Object.values(AGENTS);
