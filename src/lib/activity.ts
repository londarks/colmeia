// Store de atividade/status dos terminais, fora do React.
//
// Fontes:
// - `colmeia://activity` { id, state: "working"|"idle"|"attention", reason? } — emitido pelo backend.
// - `colmeia://status`   { id, state: "working"|"blocked"|"review"|"done"|"", text } — status
//   textual posto pelo agente (pílula no cabeçalho).
// - Fallback local: enquanto o backend ainda não emitiu nenhum `colmeia://activity`, a saída do
//   PTY (reportOutput) marca "working" por ~1,2 s, como o timer antigo do TerminalNode.
//
// "Não visto" (unseen): se um nó passa de working → idle sem estar focado, fica marcado até o
// usuário focá-lo (markSeen). O mesmo vale para "attention".
//
// Consumo no React: `useActivity(id)` (useSyncExternalStore). Fora do React: `getActivity`,
// `subscribe`, `nextAttention`, `listAttention`.

import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

export type ActivityState = "working" | "idle" | "attention";
export type StatusState = "working" | "blocked" | "review" | "done" | "";

export interface NodeStatus {
  state: StatusState;
  text: string;
}

export interface NodeActivity {
  state: ActivityState;
  reason?: string;
  /** Terminou (ou pediu atenção) enquanto o usuário não olhava. */
  unseen: boolean;
  /** Status textual do agente (`colmeia://status`), se houver. */
  status?: NodeStatus;
  /** Momento (ms) da última mudança de estado — usado para ordenar a fila de atenção. */
  since: number;
}

const IDLE: NodeActivity = Object.freeze({ state: "idle", unseen: false, since: 0 }) as NodeActivity;

const map = new Map<string, NodeActivity>();
const listeners = new Set<() => void>();
const localTimers = new Map<string, ReturnType<typeof setTimeout>>();
let focusedId: string | null = null;
/** Vira true no primeiro `colmeia://activity`: a partir daí o backend manda. */
let backendDriven = false;
let listening = false;

function emit() {
  listeners.forEach((fn) => fn());
}

function put(id: string, next: NodeActivity) {
  map.set(id, next);
  emit();
}

function windowFocused(): boolean {
  return typeof document !== "undefined" && document.hasFocus();
}

/** O usuário está olhando para este nó agora? */
function isWatching(id: string): boolean {
  return focusedId === id && windowFocused();
}

function applyState(id: string, state: ActivityState, reason?: string) {
  const prev = map.get(id) ?? IDLE;
  let unseen = prev.unseen;
  let nextState = state;
  if (state === "working") {
    unseen = false;
  } else if (state === "idle") {
    if (prev.state === "working" && !isWatching(id)) unseen = true;
  } else if (state === "attention") {
    if (isWatching(id)) {
      // O usuário já está no nó: não há o que sinalizar.
      nextState = "idle";
      unseen = false;
    } else {
      unseen = true;
    }
  }
  if (prev.state === nextState && prev.unseen === unseen && prev.reason === reason) return;
  put(id, {
    ...prev,
    state: nextState,
    reason,
    unseen,
    since: prev.state === nextState ? prev.since : Date.now(),
  });
}

function ensureListening() {
  if (listening) return;
  listening = true;
  listen<{ id: string; state: ActivityState; reason?: string }>(
    "colmeia://activity",
    (e) => {
      const { id, state, reason } = e.payload ?? ({} as never);
      if (!id || !state) return;
      if (!backendDriven) {
        backendDriven = true;
        localTimers.forEach((t) => clearTimeout(t));
        localTimers.clear();
      }
      applyState(id, state, reason);
    },
  ).catch(() => {
    listening = false;
  });
  listen<{ id: string; state: StatusState; text: string }>("colmeia://status", (e) => {
    const { id, state, text } = e.payload ?? ({} as never);
    if (!id) return;
    setStatus(id, state ?? "", text ?? "");
  }).catch(() => {});
}

// ----------------------------------------------------------------------------
// API pública

/** Inscreve um ouvinte de mudanças (qualquer nó). Devolve a função de cancelar. */
export function subscribe(fn: () => void): () => void {
  ensureListening();
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Estado atual de um nó (objeto imutável; muda de identidade a cada alteração). */
export function getActivity(id: string): NodeActivity {
  return map.get(id) ?? IDLE;
}

/** Hook React: re-renderiza quando a atividade do nó muda. */
export function useActivity(id: string): NodeActivity {
  return useSyncExternalStore(subscribe, () => getActivity(id));
}

/** Nós que pedem a atenção do usuário (attention ou working→idle não visto). */
export function listAttention(order?: string[]): string[] {
  const ids = [...map.entries()]
    .filter(([, a]) => a.state === "attention" || (a.unseen && a.state !== "working"))
    .map(([id]) => id);
  if (order && order.length) {
    const pos = (id: string) => {
      const i = order.indexOf(id);
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    return ids.sort((a, b) => pos(a) - pos(b));
  }
  // Sem ordem explícita: o mais antigo primeiro.
  return ids.sort((a, b) => getActivity(a).since - getActivity(b).since);
}

/**
 * Próximo nó em atenção depois de `afterId` (cíclico), ou o primeiro da fila.
 * `order` opcional (ex.: ids na ordem do canvas). Devolve `null` se ninguém precisa de atenção.
 * Para saber em qual canvas o nó está, use `getTerminalCanvas(id)` do terminalRegistry.
 */
export function nextAttention(afterId?: string | null, order?: string[]): string | null {
  const ids = listAttention(order);
  if (!ids.length) return null;
  if (afterId) {
    const i = ids.indexOf(afterId);
    if (i >= 0) return ids[(i + 1) % ids.length];
  }
  return ids[0];
}

/** O usuário viu o nó: limpa o "não visto" e a atenção. */
export function markSeen(id: string) {
  const prev = map.get(id);
  if (!prev || (!prev.unseen && prev.state !== "attention")) return;
  put(id, {
    ...prev,
    unseen: false,
    state: prev.state === "attention" ? "idle" : prev.state,
    since: Date.now(),
  });
  // Avisa o backend, se ele tiver o comando (outra frente); ignora se não existir.
  invoke("pty_mark_seen", { id }).catch(() => {});
}

/** Marca qual nó está com o foco (terminal focado). `null` = nenhum. */
export function setFocused(id: string | null) {
  focusedId = id;
  if (id) markSeen(id);
}

/** Desfoca só se o foco atual for deste nó. */
export function clearFocused(id: string) {
  if (focusedId === id) focusedId = null;
}

/** Atualiza (ou limpa, com state "" e texto vazio) o status textual de um nó. */
export function setStatus(id: string, state: StatusState, text: string) {
  const prev = map.get(id) ?? IDLE;
  const status = !state && !text ? undefined : { state, text };
  if (prev.status?.state === status?.state && prev.status?.text === status?.text) return;
  put(id, { ...prev, status });
}

/** Fallback local: chamado a cada chunk de saída do PTY (ignorado se o backend já emite). */
export function reportOutput(id: string) {
  if (backendDriven) return;
  applyState(id, "working");
  clearTimeout(localTimers.get(id));
  localTimers.set(
    id,
    setTimeout(() => {
      localTimers.delete(id);
      if (!backendDriven) applyState(id, "idle");
    }, 1200),
  );
}

/** Esquece um nó (ao ser deletado). */
export function clearActivity(id: string) {
  clearTimeout(localTimers.get(id));
  localTimers.delete(id);
  if (focusedId === id) focusedId = null;
  if (map.delete(id)) emit();
}
