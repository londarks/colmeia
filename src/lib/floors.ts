import { invoke } from "@tauri-apps/api/core";

export interface FloorInfo {
  branch: string;
  path: string;
  isMain: boolean;
}

export function floorList(repo: string): Promise<FloorInfo[]> {
  return invoke("floor_list", { repo });
}
export function floorCreate(repo: string, name: string): Promise<FloorInfo> {
  return invoke("floor_create", { repo, name });
}
export function floorRemove(repo: string, path: string): Promise<FloorInfo[]> {
  return invoke("floor_remove", { repo, path });
}
