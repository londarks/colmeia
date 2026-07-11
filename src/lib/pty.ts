// Ponte fina entre o frontend e os comandos de PTY em Rust.

import { Channel, invoke } from "@tauri-apps/api/core";

export type PtyOutput =
  | { kind: "data"; b64: string }
  | { kind: "exit"; code: number | null };

export interface SpawnOptions {
  id: string;
  command: string;
  args: string[];
  cwd?: string;
  cols: number;
  rows: number;
}

/** Sobe um PTY no backend e devolve um canal com a saída em streaming. */
export async function ptySpawn(
  opts: SpawnOptions,
  onOutput: (msg: PtyOutput) => void,
): Promise<void> {
  const channel = new Channel<PtyOutput>();
  channel.onmessage = onOutput;
  await invoke("pty_spawn", {
    id: opts.id,
    command: opts.command,
    args: opts.args,
    cwd: opts.cwd ?? null,
    cols: opts.cols,
    rows: opts.rows,
    channel,
  });
}

export function ptyWrite(id: string, data: string): Promise<void> {
  return invoke("pty_write", { id, data });
}

export function ptyResize(id: string, cols: number, rows: number): Promise<void> {
  return invoke("pty_resize", { id, cols, rows });
}

export function ptyKill(id: string): Promise<void> {
  return invoke("pty_kill", { id });
}

export interface GraphNode {
  id: string;
  type: string;
  title: string;
}
export interface GraphEdge {
  source: string;
  target: string;
}

/** Espelha o grafo do canvas no backend, para o escopo do roteamento. */
export function setGraph(nodes: GraphNode[], edges: GraphEdge[]): Promise<void> {
  return invoke("set_graph", { nodes, edges });
}

/** Decodifica um chunk base64 vindo do PTY em bytes crus para o xterm. */
export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
