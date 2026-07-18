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

/** Envia uma linha + Enter separado (correto para TUIs como Claude Code). */
export function ptySubmit(id: string, data: string): Promise<void> {
  return invoke("pty_submit", { id, data });
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
  role?: string;
  roleBriefing?: string;
  content?: string;
  cwd?: string;
  autoApproveInCwd?: boolean;
}
export interface GraphEdge {
  source: string;
  target: string;
}

/** Espelha o grafo do canvas no backend, para o escopo do roteamento. */
export function setGraph(nodes: GraphNode[], edges: GraphEdge[]): Promise<void> {
  return invoke("set_graph", { nodes, edges });
}

export interface RoutineInfo {
  id: string;
  target: string;
  interval: number;
  command: string;
}

export function routinesList(): Promise<RoutineInfo[]> {
  return invoke("routines_list");
}
export function routineCreate(
  target: string,
  interval: number,
  command: string,
): Promise<RoutineInfo[]> {
  return invoke("routine_create", { target, interval, command });
}
export function routineDelete(id: string): Promise<RoutineInfo[]> {
  return invoke("routine_delete", { id });
}

export interface ApprovalRequest {
  id: string;
  node: string;
  title: string;
  tool: string;
  summary: string;
}

/** Responde a uma aprovação pendente. `always` cria uma regra de auto-aprovação
 *  para (node, tool) pelo resto da sessão. */
export function approvalResolve(
  id: string,
  allow: boolean,
  always: boolean,
  node: string,
  tool: string,
): Promise<void> {
  return invoke("approval_resolve", { id, allow, always, node, tool });
}

export interface WorkspaceData {
  nodes: unknown[];
  edges: unknown[];
  strokes?: unknown[];
  texts?: unknown[];
}

export function workspaceSave(data: WorkspaceData): Promise<void> {
  return invoke("workspace_save", { data });
}
export function workspaceLoad(): Promise<WorkspaceData | null> {
  return invoke("workspace_load");
}
export interface WorkspaceList {
  current: string;
  names: string[];
}

export function workspaceList(): Promise<WorkspaceList> {
  return invoke("workspace_list");
}
export function workspaceSwitch(name: string): Promise<void> {
  return invoke("workspace_switch", { name });
}
export function workspaceRename(oldName: string, newName: string): Promise<void> {
  return invoke("workspace_rename", { oldName, newName });
}
export function workspaceDelete(name: string): Promise<void> {
  return invoke("workspace_delete", { name });
}
export function workspaceMetaLoad(): Promise<unknown | null> {
  return invoke("workspace_meta_load");
}
export function workspaceMetaSave(data: unknown): Promise<void> {
  return invoke("workspace_meta_save", { data });
}

/** Pede ao Ombro (Ollama local) uma análise dos agentes + próximo passo. */
export function ombroAnalyze(model?: string): Promise<string> {
  return invoke("ombro_analyze", { model: model || null });
}

/** Decodifica um chunk base64 vindo do PTY em bytes crus para o xterm. */
export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
