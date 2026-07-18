import { useCallback, useEffect, useRef, useState } from "react";
import {
  workspaceDelete,
  workspaceList,
  workspaceLoad,
  workspaceRename,
  workspaceSave,
  workspaceSwitch,
  type WorkspaceData,
  type WorkspaceList,
} from "../lib/pty";

interface WorkspacePanelManagerDependencies {
  buildWorkspace: () => WorkspaceData;
  applyWorkspace: (workspace: WorkspaceData | null) => void;
  cancelPendingSave: () => void;
  setAutosaveEnabled: (enabled: boolean) => void;
}

export function useWorkspacePanelManager({
  buildWorkspace,
  applyWorkspace,
  setAutosaveEnabled,
  cancelPendingSave,
}: WorkspacePanelManagerDependencies) {
  const [workspaceInfo, setWorkspaceInfo] = useState<WorkspaceList>({
    current: "default",
    names: [],
  });
  const buildWorkspaceRef = useRef(buildWorkspace);
  buildWorkspaceRef.current = buildWorkspace;
  const applyWorkspaceRef = useRef(applyWorkspace);
  applyWorkspaceRef.current = applyWorkspace;
  const cancelPendingSaveRef = useRef(cancelPendingSave);
  cancelPendingSaveRef.current = cancelPendingSave;
  const setAutosaveEnabledRef = useRef(setAutosaveEnabled);
  setAutosaveEnabledRef.current = setAutosaveEnabled;

  useEffect(() => {
    workspaceList().then(setWorkspaceInfo).catch(() => {});
  }, []);

  const switchWorkspace = useCallback(async (rawName: string) => {
    const name = rawName.trim();
    if (!name || name === workspaceInfo.current) return;
    cancelPendingSaveRef.current();
    setAutosaveEnabledRef.current(false);
    await workspaceSave(buildWorkspaceRef.current()).catch(() => {});
    try {
      await workspaceSwitch(name);
    } catch {
      setAutosaveEnabledRef.current(true);
      return;
    }
    const workspace = await workspaceLoad().catch(() => null);
    applyWorkspaceRef.current(
      workspace && Array.isArray(workspace.nodes) ? workspace : null,
    );
    setWorkspaceInfo((previous) => ({
      current: name,
      names: previous.names.includes(name)
        ? previous.names
        : [...previous.names, name].sort(),
    }));
    setAutosaveEnabledRef.current(true);
  }, [workspaceInfo.current]);

  const renameWorkspace = useCallback(async (oldName: string, newName: string) => {
    try {
      await workspaceRename(oldName, newName);
    } catch {
      return false;
    }
    setWorkspaceInfo((previous) => ({
      current: previous.current === oldName ? newName : previous.current,
      names: previous.names
        .map((name) => (name === oldName ? newName : name))
        .sort(),
    }));
    return true;
  }, []);

  const deleteWorkspace = useCallback(async (name: string) => {
    const index = workspaceInfo.names.indexOf(name);
    let fallback =
      workspaceInfo.names[index - 1] ?? workspaceInfo.names[index + 1];
    if (!fallback) {
      fallback = "Workspace";
      let suffix = 1;
      while (fallback === name) fallback = `Workspace ${suffix++}`;
    }
    const deletingActive = name === workspaceInfo.current;

    cancelPendingSaveRef.current();
    setAutosaveEnabledRef.current(false);
    try {
      if (deletingActive) {
        await workspaceSave(buildWorkspaceRef.current());
        await workspaceSwitch(fallback);
        const workspace = await workspaceLoad();
        applyWorkspaceRef.current(
          workspace && Array.isArray(workspace.nodes) ? workspace : null,
        );
      }
      await workspaceDelete(name);
    } catch {
      setAutosaveEnabledRef.current(true);
      return false;
    }

    setWorkspaceInfo((previous) => ({
      current: deletingActive ? fallback : previous.current,
      names: previous.names.filter((workspace) => workspace !== name).includes(fallback)
        ? previous.names.filter((workspace) => workspace !== name)
        : [...previous.names.filter((workspace) => workspace !== name), fallback].sort(),
    }));
    setAutosaveEnabledRef.current(true);
    return true;
  }, [workspaceInfo]);

  return {
    workspaceInfo,
    switchWorkspace,
    renameWorkspace,
    deleteWorkspace,
  };
}
