// Ponte fina entre o nó do portal (BrowserNode) e os comandos Rust do portal CDP.

import { Channel, invoke } from "@tauri-apps/api/core";

export type PortalEvent =
  | { kind: "frame"; b64: string; width: number; height: number }
  | { kind: "nav"; url: string; title: string }
  | { kind: "status"; text: string }
  | { kind: "error"; message: string }
  | { kind: "closed"; reason: string };

/** Liga o nó ao navegador do portal (cria a sessão se preciso). */
export async function portalAttach(
  id: string,
  key: string,
  url: string | undefined,
  width: number,
  height: number,
  onEvent: (ev: PortalEvent) => void,
): Promise<void> {
  const channel = new Channel<PortalEvent>();
  channel.onmessage = onEvent;
  await invoke("portal_attach", { id, key, url: url ?? null, channel, width, height });
}

export function portalDetach(id: string, key: string): Promise<void> {
  return invoke("portal_detach", { id, key });
}

/** Nó deletado: mata o navegador e apaga o perfil. */
export function portalClose(id: string): Promise<void> {
  return invoke("portal_close", { id });
}

export function portalResize(id: string, width: number, height: number): Promise<void> {
  return invoke("portal_resize", { id, width, height });
}

export function portalNavigate(id: string, url: string): Promise<void> {
  return invoke("portal_navigate", { id, url });
}

export function portalHistory(id: string, action: "back" | "forward" | "reload"): Promise<void> {
  return invoke("portal_history", { id, action });
}

/** Repassa entrada do usuário (parâmetros CDP de Input.dispatch*). */
export function portalInput(
  id: string,
  event:
    | { kind: "mouse"; params: Record<string, unknown> }
    | { kind: "key"; params: Record<string, unknown> }
    | { kind: "text"; text: string },
): Promise<void> {
  return invoke("portal_input", { id, event });
}

/** Completa o esquema de uma URL digitada (localhost → http, resto → https). */
export function normalizeUrl(raw: string): string {
  const u = raw.trim();
  if (!u) return "";
  if (/^(https?:\/\/|about:blank$)/i.test(u)) return u;
  if (/^(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(u)) return `http://${u}`;
  return `https://${u}`;
}

/** Bitmask de modificadores do CDP: Alt=1, Ctrl=2, Meta=4, Shift=8. */
export function cdpModifiers(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}
