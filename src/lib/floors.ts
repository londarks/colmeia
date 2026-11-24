import { invoke } from "@tauri-apps/api/core";

export type FloorStatusState = "working" | "blocked" | "review" | "done";

export interface FloorStatus {
  state: FloorStatusState;
  text: string;
  updatedAt: number;
}

export interface FloorInfo {
  /** Id no registro do colmeia (null para o Ground e worktrees externos). */
  id: string | null;
  name: string;
  branch: string;
  path: string;
  isMain: boolean;
  /** Criado/adotado pelo colmeia (pode ser removido/landed por ele). */
  managed: boolean;
  legacy: boolean;
  state: "pending" | "ready" | "deleting" | "orphaned" | "external" | "ground";
  status: FloorStatus | null;
  index: number;
  portBase: number | null;
  dirty: number;
  depsMode: string;
  note: string;
}

export interface CommitInfo {
  oid: string;
  subject: string;
}

export interface LossReport {
  floor: string;
  branch: string;
  dirty: string[];
  uniqueCommits: CommitInfo[];
  uniqueCommitCount: number;
  branchWillBeDeleted: boolean;
  operation: string | null;
  fingerprint: string;
}

export interface RemoveResult {
  removed: boolean;
  branchDeleted: boolean;
  loss: LossReport | null;
  message: string;
}

export interface LandPreview {
  floor: string;
  branch: string;
  target: string;
  ahead: number;
  behind: number;
  files: string[];
  conflicts: string[];
  blockers: string[];
  mergeTreeSupported: boolean;
  targets: string[];
}

export interface LandResult {
  landed: boolean;
  target: string;
  mergeCommit: string | null;
  conflicts: string[];
  blockers: string[];
  floorRemoved: boolean;
  branchDeleted: boolean;
  message: string;
}

/** Como levar `node_modules`/`.venv` para o floor. */
export type DepsMode = "copy" | "link" | "skip";

export function floorList(repo: string): Promise<FloorInfo[]> {
  return invoke("floor_list", { repo });
}
export function floorCreate(
  repo: string,
  name: string,
  opts: { branch?: string; existingBranch?: boolean; deps?: DepsMode } = {},
): Promise<FloorInfo> {
  return invoke("floor_create", { repo, name, ...opts });
}
export function floorInspect(id: string, keepBranch = false): Promise<LossReport> {
  return invoke("floor_inspect", { id, keepBranch });
}
/** Sem `force`, recusa se algo seria perdido (devolve `loss`). `force` = `loss.fingerprint`. */
export function floorRemove(
  id: string,
  force?: string,
  keepBranch = false,
): Promise<RemoveResult> {
  return invoke("floor_remove", { id, force: force ?? null, keepBranch });
}
export function floorLandPreview(id: string, into?: string): Promise<LandPreview> {
  return invoke("floor_land_preview", { id, into: into ?? null });
}
export function floorLand(
  id: string,
  opts: { into?: string; deleteBranch?: boolean; keepFloor?: boolean } = {},
): Promise<LandResult> {
  return invoke("floor_land", {
    id,
    into: opts.into ?? null,
    deleteBranch: opts.deleteBranch ?? false,
    keepFloor: opts.keepFloor ?? false,
  });
}
export function floorSetStatus(
  id: string,
  state: FloorStatusState,
  text: string,
): Promise<FloorInfo> {
  return invoke("floor_set_status", { id, state, text });
}
export function floorClearStatus(id: string): Promise<FloorInfo> {
  return invoke("floor_set_status", { id, clear: true });
}
