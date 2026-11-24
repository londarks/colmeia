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
  /** Id do papel: entra uma vez no boot do agente (não a cada ask). */
  role?: string;
  /** Tipo de agente do catálogo (claude/codex/ollama/shell). */
  agent?: string;
  /** Chave estável da conversa do nó (o backend deriva o --session-id/--resume do Claude). */
  sessionKey?: string;
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
    role: opts.role ?? null,
    agent: opts.agent ?? null,
    sessionKey: opts.sessionKey ?? null,
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
  /** Rótulo do papel (exibição). */
  role?: string;
  /** Id do papel (lógica: "orquestrador" dá privilégio de maestro). */
  roleId?: string;
  agent?: string;
  content?: string;
  cwd?: string;
  autoApproveInCwd?: boolean;
  /** Modo Maestro do nó (recrutar/dispensar/conectar fora do alcance). */
  maestro?: boolean;
  /** Nota travada: agentes leem, mas não escrevem. */
  locked?: boolean;
  /** Id do grupo pai (`parentId`), vazio se for de topo. */
  parent?: string;
  /** Grupo marcado como band (todos-com-todos). */
  band?: boolean;
}
export interface GraphEdge {
  source: string;
  target: string;
}

/** Espelha o grafo do canvas no backend, para o escopo do roteamento. */
export function setGraph(nodes: GraphNode[], edges: GraphEdge[]): Promise<void> {
  return invoke("set_graph", { nodes, edges });
}

export interface PresetInfo {
  id: string;
  label: string;
  command: string;
}

/** Envia o catálogo de agentes ao backend (`colmeia preset list` / `recruit --agent`). */
export function setPresets(presets: PresetInfo[]): Promise<void> {
  return invoke("set_presets", { presets });
}

export interface RoleDef {
  id: string;
  label: string;
  color: string;
  prompt: string;
  builtin: boolean;
}

/** Papéis do backend (built-ins + criados pelo usuário/agentes). */
export function rolesList(): Promise<RoleDef[]> {
  return invoke("roles_list");
}

// ---------------------------------------------------------------- Rotinas

export type RoutineSchedule =
  | { kind: "once"; at: number }
  | { kind: "interval"; secs: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; days: number[]; hour: number; minute: number };

export interface RoutineHistoryEntry {
  at: number;
  /** sent | reminder | skippedBusy | targetMissing */
  outcome: string;
  detail: string;
  manual: boolean;
}

export interface RoutineInfo {
  id: string;
  name: string;
  schedule: RoutineSchedule;
  /** Id do nó alvo; vazio = lembrete (só notificação). */
  targetId: string;
  targetTitle: string;
  text: string;
  enabled: boolean;
  skipIfBusy: boolean;
  notify: boolean;
  maxRuns: number | null;
  createdAt: number;
  lastFiredAt: number | null;
  fireCount: number;
  completed: boolean;
  history: RoutineHistoryEntry[];
  /** Calculados pelo backend. */
  nextRun: number | null;
  spec: string;
  describe: string;
  waitingBusy: boolean;
}

export interface RoutineInput {
  name?: string;
  /** "daily 09:00" | "weekly mon,fri@09:00" | "interval 30m" | "once 2026-06-20 15:00" */
  schedule: string;
  /** Id do nó alvo; vazio/undefined = lembrete. */
  target?: string;
  text: string;
  skipIfBusy?: boolean;
  notify?: boolean;
  enabled?: boolean;
  maxRuns?: number;
}

export type RoutinePatch = Partial<RoutineInput>;

export interface SchedulePreview {
  spec: string;
  describe: string;
  nextRun: number | null;
}

export function routinesList(): Promise<RoutineInfo[]> {
  return invoke("routines_list");
}
export function routineCreate(input: RoutineInput): Promise<RoutineInfo[]> {
  return invoke("routine_create", { input });
}
export function routineEdit(id: string, patch: RoutinePatch): Promise<RoutineInfo[]> {
  return invoke("routine_edit", { id, patch });
}
export function routineDelete(id: string): Promise<RoutineInfo[]> {
  return invoke("routine_delete", { id });
}
export function routineSetEnabled(id: string, enabled: boolean): Promise<RoutineInfo[]> {
  return invoke("routine_set_enabled", { id, enabled });
}
export function routineRun(id: string): Promise<RoutineInfo[]> {
  return invoke("routine_run", { id });
}
export function routinePreview(schedule: string): Promise<SchedulePreview> {
  return invoke("routine_preview", { schedule });
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
  /** Câmera salva do canvas (x, y, zoom do React Flow). */
  viewport?: { x: number; y: number; zoom: number };
}
export interface WorkspaceMeta {
  id: string;
  name: string;
}
export interface WorkspaceIndex {
  active: string;
  items: WorkspaceMeta[];
}

/** Lista os canvases + qual está ativo. */
export function workspacesList(): Promise<WorkspaceIndex> {
  return invoke("workspaces_list");
}
export function workspaceSave(id: string, data: WorkspaceData): Promise<void> {
  return invoke("workspace_save", { id, data });
}
export function workspaceLoad(id: string): Promise<WorkspaceData> {
  return invoke("workspace_load", { id });
}
export function workspaceCreate(name: string): Promise<WorkspaceIndex> {
  return invoke("workspace_create", { name });
}
export function workspaceRename(id: string, name: string): Promise<WorkspaceIndex> {
  return invoke("workspace_rename", { id, name });
}
export function workspaceDelete(id: string): Promise<WorkspaceIndex> {
  return invoke("workspace_delete", { id });
}
export function workspaceSetActive(id: string): Promise<void> {
  return invoke("workspace_set_active", { id });
}

/** Pede ao Ombro (Ollama local) uma análise dos agentes + próximo passo. */
export function ombroAnalyze(model?: string): Promise<string> {
  return invoke("ombro_analyze", { model: model || null });
}

/** Impede (on) ou libera (off) a suspensão do sistema enquanto agentes trabalham. */
export function keepAwake(on: boolean): Promise<void> {
  return invoke("keep_awake", { on });
}

/** Decodifica um chunk base64 vindo do PTY em bytes crus para o xterm. */
export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
