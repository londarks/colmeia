// Papéis (roles) que um agente pode assumir no canvas — o "Role Assignment".
//
// O texto completo de cada papel (o prompt que o agente recebe) vive no backend
// (`src-tauri/src/roles.rs`), persistido em `app_data_dir/roles.json` junto com
// os papéis criados pelo usuário/agentes. O papel entra UMA vez, no boot do
// agente — não é mais reinjetado a cada `ask`.
//
// `ROLES`/`ROLE_MAP` continuam exportando os built-ins (id, rótulo, cor e um
// resumo curto) para quem precisa síncrono; `loadRoles()` traz a lista completa.

import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { rolesList } from "./pty";

export interface Role {
  id: string;
  label: string;
  color: string;
  /** Resumo curto do papel (para tooltips). O prompt completo está em `prompt`. */
  briefing: string;
  /** Prompt completo (só nos papéis vindos de `loadRoles()`). */
  prompt?: string;
  builtin?: boolean;
}

export const ROLES: Role[] = [
  {
    id: "orquestrador",
    label: "Orquestrador",
    color: "#f59e0b",
    briefing: "Coordena a equipe: recruta, delega com ask-back, junta e verifica os resultados.",
  },
  {
    id: "architect",
    label: "Arquiteto",
    color: "#10b981",
    briefing: "Define a forma da solução e registra um plano curto antes da implementação.",
  },
  {
    id: "engineer",
    label: "Engenheiro",
    color: "#5ec8ff",
    briefing: "Implementa a tarefa de ponta a ponta e prova que funciona.",
  },
  {
    id: "reviewer",
    label: "Revisor",
    color: "#a855f7",
    briefing: "Revisa criticamente: bugs, bordas, segurança — com localização e correção.",
  },
  {
    id: "tester",
    label: "Testador",
    color: "#eab308",
    briefing: "Prova com execução real se o comportamento está correto.",
  },
];

export const ROLE_MAP: Record<string, Role> = Object.fromEntries(
  ROLES.map((r) => [r.id, r]),
);

const FALLBACK_COLOR = "#94a3b8";

/** Lista completa de papéis (built-ins + do usuário). Cai nos built-ins se o
 *  backend não responder. */
export async function loadRoles(): Promise<Role[]> {
  try {
    const list = await rolesList();
    return list.map((r) => ({
      id: r.id,
      label: r.label,
      color: r.color || ROLE_MAP[r.id]?.color || FALLBACK_COLOR,
      briefing: ROLE_MAP[r.id]?.briefing ?? r.prompt.split("\n")[0].slice(0, 140),
      prompt: r.prompt,
      builtin: r.builtin,
    }));
  } catch {
    return ROLES;
  }
}

// ---------------------------------------------------------------------------
// Store reativo de papéis: carrega do backend e recarrega em `colmeia://roles-changed`
// (quando um agente roda `colmeia role create|edit|write`).


let rolesCache: Role[] = ROLES;
let rolesMap: Record<string, Role> = ROLE_MAP;
let started = false;
const listeners = new Set<() => void>();

function refreshRoles() {
  loadRoles().then((list) => {
    rolesCache = list;
    rolesMap = Object.fromEntries(list.map((r) => [r.id, r]));
    listeners.forEach((l) => l());
  });
}

function ensureRolesStarted() {
  if (started) return;
  started = true;
  refreshRoles();
  listen("colmeia://roles-changed", () => refreshRoles()).catch(() => {});
}

function subscribeRoles(fn: () => void) {
  ensureRolesStarted();
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Lista atual de papéis (built-ins + do usuário), reativa. */
export function useRoles(): Role[] {
  return useSyncExternalStore(subscribeRoles, () => rolesCache);
}

/** Papel pelo id (inclui papéis do usuário já carregados). */
export function roleById(id: string | undefined): Role | undefined {
  return id ? rolesMap[id] : undefined;
}
