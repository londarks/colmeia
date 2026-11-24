// Alinhar / Distribuir / Arrumar (tidy) a seleção do canvas, com atalhos:
//   Alt+Shift+←/→/↑/↓  alinhar esquerda/direita/topo/base
//   Alt+Shift+C / M     alinhar centro (horizontal) / meio (vertical)
//   Alt+Shift+H / V     distribuir horizontal / vertical
//   Ctrl+Shift+T        arrumar (tidy) a seleção, ou o canvas inteiro
// Nós travados (`data.pinned`) e estacionados no Dock (`data.docked`) não se mexem.

import { useCallback, useEffect } from "react";
import { useReactFlow, type Node } from "@xyflow/react";
import { toast } from "sonner";
import {
  absolutePosition,
  isEditableTarget,
  nodeSize,
  type CanvasApi,
} from "../lib/canvas";
import {
  alignBoxes,
  distributeBoxes,
  tidyLayered,
  type AlignMode,
  type Axis,
  type Box,
  type Pos,
} from "../lib/layout";

type Flags = { pinned?: boolean; docked?: boolean; maestro?: boolean; role?: string };

const flags = (n: Node) => (n.data ?? {}) as Flags;

export function boxOf(n: Node, all: Node[]): Box {
  const p = absolutePosition(n, all);
  const s = nodeSize(n);
  return { id: n.id, x: p.x, y: p.y, w: s.width, h: s.height };
}

/** Converte posições absolutas em relativas ao pai e aplica. */
export function applyAbsolute(api: CanvasApi, positions: Map<string, Pos>) {
  if (positions.size === 0) return;
  api.setNodes((nds) =>
    nds.map((n) => {
      const p = positions.get(n.id);
      if (!p) return n;
      const parent = n.parentId ? nds.find((m) => m.id === n.parentId) : undefined;
      const base = parent ? absolutePosition(parent, nds) : { x: 0, y: 0 };
      return { ...n, position: { x: p.x - base.x, y: p.y - base.y } };
    }),
  );
}

export interface LayoutApi {
  align: (mode: AlignMode, ids?: string[]) => void;
  distribute: (axis: Axis, ids?: string[]) => void;
  /** Sem ids: a seleção (2+) ou o canvas inteiro. `"all"`: sempre o canvas inteiro. */
  tidy: (ids?: string[] | "all") => void;
}

export function useLayout(api: CanvasApi): LayoutApi {
  const rf = useReactFlow();

  /** Nós móveis do conjunto: sem trava, fora do Dock e sem ancestral também no conjunto. */
  const movable = useCallback(
    (ids?: string[]): Node[] => {
      const all = api.nodesRef.current;
      const set = new Set(ids ?? all.filter((n) => n.selected).map((n) => n.id));
      const hasPickedAncestor = (n: Node) => {
        let p = n.parentId;
        let guard = 0;
        while (p && guard < 32) {
          if (set.has(p)) return true;
          p = all.find((m) => m.id === p)?.parentId;
          guard += 1;
        }
        return false;
      };
      return all.filter(
        (n) =>
          set.has(n.id) && !flags(n).pinned && !flags(n).docked && !n.hidden && !hasPickedAncestor(n),
      );
    },
    [api],
  );

  const align = useCallback(
    (mode: AlignMode, ids?: string[]) => {
      const pick = movable(ids);
      if (pick.length < 2) {
        toast.info("Selecione 2 ou mais nós para alinhar");
        return;
      }
      const all = api.nodesRef.current;
      applyAbsolute(api, alignBoxes(pick.map((n) => boxOf(n, all)), mode));
    },
    [api, movable],
  );

  const distribute = useCallback(
    (axis: Axis, ids?: string[]) => {
      const pick = movable(ids);
      if (pick.length < 3) {
        toast.info("Selecione 3 ou mais nós para distribuir");
        return;
      }
      const all = api.nodesRef.current;
      applyAbsolute(api, distributeBoxes(pick.map((n) => boxOf(n, all)), axis));
    },
    [api, movable],
  );

  const tidy = useCallback(
    (ids?: string[] | "all") => {
      const all = api.nodesRef.current;
      const selected = all.filter((n) => n.selected).map((n) => n.id);
      const explicit =
        ids === "all"
          ? null
          : ids && ids.length >= 2
            ? ids
            : selected.length >= 2
              ? selected
              : null;
      // Sem seleção: o canvas inteiro (só os nós de topo; grupos movem os filhos junto).
      const pick = explicit ? movable(explicit) : movable(all.filter((n) => !n.parentId).map((n) => n.id));
      if (pick.length < 2) {
        toast.info("Nada para arrumar");
        return;
      }
      const boxes = pick.map((n) => boxOf(n, all));
      const leaders = new Set(
        pick
          .filter((n) => n.type === "terminal" && (flags(n).maestro || flags(n).role === "orquestrador"))
          .map((n) => n.id),
      );
      const edges = api.edgesRef.current.map((e) => ({ source: e.source, target: e.target }));
      applyAbsolute(api, tidyLayered(boxes, edges, { leaders }));
      // Enquadra o resultado depois que o React Flow aplicar as posições.
      const ids2 = pick.map((n) => ({ id: n.id }));
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          rf.fitView({ nodes: ids2, padding: 0.15, maxZoom: 1, duration: 300 }),
        ),
      );
    },
    [api, movable, rf],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.isComposing) return;
      if (isEditableTarget(e.target) || isEditableTarget(document.activeElement)) return;
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.shiftKey && !e.altKey && e.code === "KeyT") {
        e.preventDefault();
        tidy();
        return;
      }
      if (!(e.altKey && e.shiftKey) || ctrl) return;
      const map: Record<string, () => void> = {
        ArrowLeft: () => align("left"),
        ArrowRight: () => align("right"),
        ArrowUp: () => align("top"),
        ArrowDown: () => align("bottom"),
        KeyC: () => align("center"),
        KeyM: () => align("middle"),
        KeyH: () => distribute("h"),
        KeyV: () => distribute("v"),
      };
      const fn = map[e.code] ?? map[e.key];
      if (!fn) return;
      e.preventDefault();
      e.stopPropagation();
      fn();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [align, distribute, tidy]);

  return { align, distribute, tidy };
}
