// Grupos/frames: Ctrl+G agrupa a seleção num nó `group` (filhos via `parentId`
// do React Flow, então mover o grupo leva os filhos junto); Ctrl+Shift+G (ou o
// botão do grupo) desagrupa. Excluir um grupo só remove a moldura — os filhos
// continuam no canvas (terminais não são mortos por acidente).

import { useCallback, useEffect } from "react";
import type { Edge, Node } from "@xyflow/react";
import { UNGROUP_EVENT } from "../nodes/GroupNode";
import {
  absolutePosition,
  boundsOf,
  isEditableTarget,
  newNodeId,
  type CanvasApi,
} from "../lib/canvas";

const PAD = 28;
const HEADER = 38;

export function useGrouping(api: CanvasApi) {
  /** Agrupa os nós selecionados (que ainda não estão num grupo). */
  const groupSelection = useCallback(() => {
    const all = api.nodesRef.current;
    const pick = all.filter((n) => n.selected && !n.parentId && n.type !== "group");
    if (pick.length === 0) return null;
    const b = boundsOf(pick, all)!;
    const gid = newNodeId("group");
    const gx = b.x - PAD;
    const gy = b.y - PAD - HEADER;
    const group: Node = {
      id: gid,
      type: "group",
      position: { x: gx, y: gy },
      data: { title: "Grupo", color: "accent" },
      style: { width: b.width + PAD * 2, height: b.height + PAD * 2 + HEADER },
      selected: true,
    };
    const ids = new Set(pick.map((n) => n.id));
    api.setNodes((nds) => [
      // Grupo antes dos filhos (exigência do React Flow) e por baixo deles.
      group,
      ...nds.map((n): Node => {
        if (!ids.has(n.id)) return n.selected ? { ...n, selected: false } : n;
        const abs = absolutePosition(n, nds);
        return {
          ...n,
          parentId: gid,
          position: { x: abs.x - gx, y: abs.y - gy },
          selected: false,
        };
      }),
    ]);
    return gid;
  }, [api]);

  /** Desfaz grupos: filhos voltam a ser nós de topo na mesma posição. */
  const ungroup = useCallback(
    (groupIds: string[], removeFrame = true) => {
      const gids = new Set(groupIds);
      if (gids.size === 0) return;
      api.setNodes((nds) => {
        const byId = new Map(nds.map((n) => [n.id, n]));
        return nds
          .filter((n) => !(removeFrame && gids.has(n.id)))
          .map((n): Node => {
            if (!n.parentId || !gids.has(n.parentId)) return n;
            const g = byId.get(n.parentId);
            const { parentId: _p, extent: _e, ...rest } = n;
            return {
              ...rest,
              position: {
                x: n.position.x + (g?.position.x ?? 0),
                y: n.position.y + (g?.position.y ?? 0),
              },
            } as Node;
          });
      });
    },
    [api],
  );

  const ungroupSelection = useCallback(() => {
    const gids = api.nodesRef.current
      .filter((n) => n.selected && n.type === "group")
      .map((n) => n.id);
    ungroup(gids);
  }, [api, ungroup]);

  /**
   * Para o `onBeforeDelete` do ReactFlow: ao excluir um grupo, solta os filhos
   * que não estavam selecionados em vez de excluí-los junto.
   */
  const onBeforeDelete = useCallback(
    async ({ nodes, edges }: { nodes: Node[]; edges: Edge[] }) => {
      const groups = nodes.filter((n) => n.type === "group").map((n) => n.id);
      if (groups.length === 0) return true;
      const gset = new Set(groups);
      // Olha o canvas inteiro (não só `nodes`) para nunca deixar filho órfão.
      const keep = new Set(
        api.nodesRef.current
          .filter((n) => n.parentId && gset.has(n.parentId) && !n.selected)
          .map((n) => n.id),
      );
      if (keep.size === 0) return true;
      ungroup(groups, false);
      return {
        nodes: nodes.filter((n) => !keep.has(n.id)),
        edges: edges.filter((e) => !keep.has(e.source) && !keep.has(e.target)),
      };
    },
    [api, ungroup],
  );

  // Atalhos Ctrl+G / Ctrl+Shift+G (fora de terminais/campos) e o botão do grupo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== "g") return;
      if (isEditableTarget(e.target) || isEditableTarget(document.activeElement)) return;
      e.preventDefault();
      if (e.shiftKey) ungroupSelection();
      else groupSelection();
    };
    const onUngroup = (e: Event) => {
      const id = (e as CustomEvent<{ id: string }>).detail?.id;
      if (id) ungroup([id]);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener(UNGROUP_EVENT, onUngroup);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(UNGROUP_EVENT, onUngroup);
    };
  }, [groupSelection, ungroupSelection, ungroup]);

  return { groupSelection, ungroupSelection, ungroup, onBeforeDelete };
}
