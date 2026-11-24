// Snap e guias magnéticas ao arrastar nós.
//
// - Grade: toggle (Alt+G), persistido; usa o `snapToGrid` nativo do React Flow com o
//   mesmo passo do fundo pontilhado.
// - Guias magnéticas: ao arrastar, as bordas/centros do nó encaixam nas dos vizinhos
//   (mesmo pai) a menos de ~6 px de tela, e as linhas-guia são desenhadas. Segurar
//   Alt durante o arraste solta o ímã. Implementação própria (ver lib/layout.ts).
// - Soltar dentro de um grupo: o nó vira filho dele (entra na band, se for band);
//   arrastar para fora solta do grupo.

import { useCallback, useRef, useState } from "react";
import { ViewportPortal, useReactFlow, useStore, type Node } from "@xyflow/react";
import { absolutePosition, sortParentsFirst, type CanvasApi } from "../lib/canvas";
import { centerInside, computeSnap, type Box, type Guide } from "../lib/layout";
import { usePref } from "../lib/uxPrefs";
import { boxOf } from "./useLayout";

export const GRID_STEP = 24;
const SNAP_PX = 6;
const GROUP_PAD = 12;
const GROUP_HEADER = 44;

type DragEvent = MouseEvent | TouchEvent;

function isDescendantOf(n: Node, ids: Set<string>, all: Node[]): boolean {
  let p = n.parentId;
  let guard = 0;
  while (p && guard < 32) {
    if (ids.has(p)) return true;
    p = all.find((m) => m.id === p)?.parentId;
    guard += 1;
  }
  return false;
}

function ancestorsOf(n: Node, all: Node[]): Set<string> {
  const out = new Set<string>();
  let p = n.parentId;
  let guard = 0;
  while (p && guard < 32) {
    out.add(p);
    p = all.find((m) => m.id === p)?.parentId;
    guard += 1;
  }
  return out;
}

const isDocked = (n: Node) => !!(n.data as { docked?: boolean } | undefined)?.docked;

export function useSnapGuides(api: CanvasApi) {
  const rf = useReactFlow();
  const [gridOn, setGridOn] = usePref("snapGrid", false);
  const [guidesOn, setGuidesOn] = usePref("snapGuides", true);
  const [guides, setGuides] = useState<Guide[]>([]);
  const guidesKey = useRef("");

  const showGuides = useCallback((g: Guide[]) => {
    const key = JSON.stringify(g);
    if (key === guidesKey.current) return;
    guidesKey.current = key;
    setGuides(g);
  }, []);

  /** Aplica o ímã ao conjunto arrastado (mesmo deslocamento para todos). */
  const magnet = useCallback(
    (e: DragEvent, node: Node, dragged: Node[]) => {
      if (!guidesOn || (e as MouseEvent).altKey) {
        showGuides([]);
        return;
      }
      const all = api.nodesRef.current;
      const draggedIds = new Set(dragged.map((n) => n.id));
      const parent = node.parentId ? all.find((m) => m.id === node.parentId) : undefined;
      const base = parent ? absolutePosition(parent, all) : { x: 0, y: 0 };
      const size = boxOf(node, all);
      const me: Box = {
        id: node.id,
        x: base.x + node.position.x,
        y: base.y + node.position.y,
        w: size.w,
        h: size.h,
      };
      const anc = ancestorsOf(node, all);
      const others = all
        .filter(
          (n) =>
            !draggedIds.has(n.id) &&
            !anc.has(n.id) &&
            !n.hidden &&
            !isDocked(n) &&
            !isDescendantOf(n, draggedIds, all),
        )
        .map((n) => boxOf(n, all));
      const zoom = rf.getViewport().zoom || 1;
      const snap = computeSnap(me, others, SNAP_PX / zoom);
      if (snap.dx || snap.dy) {
        const pos = new Map(dragged.map((n) => [n.id, n.position]));
        api.setNodes((nds) =>
          nds.map((n) => {
            const p = pos.get(n.id);
            return p ? { ...n, position: { x: p.x + snap.dx, y: p.y + snap.dy } } : n;
          }),
        );
      }
      showGuides(snap.guides);
    },
    [api, guidesOn, rf, showGuides],
  );

  const onNodeDrag = useCallback(
    (e: DragEvent, node: Node, dragged: Node[]) => magnet(e, node, dragged),
    [magnet],
  );

  /** Fim do arraste: ímã final, some com as guias e ajusta o grupo pai. */
  const onNodeDragStop = useCallback(
    (e: DragEvent, node: Node, dragged: Node[]) => {
      magnet(e, node, dragged);
      showGuides([]);
      reparentOnDrop(api, dragged.map((n) => n.id));
    },
    [api, magnet, showGuides],
  );

  const clearGuides = useCallback(() => showGuides([]), [showGuides]);

  const layer = <GuidesLayer guides={guides} />;

  return {
    gridOn,
    setGridOn,
    guidesOn,
    setGuidesOn,
    onNodeDrag,
    onNodeDragStop,
    clearGuides,
    layer,
    flowProps: {
      snapToGrid: gridOn,
      snapGrid: [GRID_STEP, GRID_STEP] as [number, number],
    },
  };
}

/** Soltar dentro/fora de grupos: muda o `parentId` mantendo a posição na tela. */
function reparentOnDrop(api: CanvasApi, ids: string[]) {
  const moved = new Set(ids);
  api.setNodes((nds) => {
    let changed = false;
    const groups = nds.filter((g) => g.type === "group" && !g.hidden);
    let next = nds.map((n) => ({ ...n }));
    const find = (id: string) => next.find((m) => m.id === id);
    for (const id of ids) {
      const n = find(id);
      if (!n || n.type === "group") continue; // grupos não se aninham por arraste
      if (n.parentId && moved.has(n.parentId)) continue; // vai junto com o pai
      const box = boxOf(n, next);
      // Menor grupo cujo retângulo contém o centro do nó.
      const target = groups
        .filter((g) => g.id !== n.id && !moved.has(g.id))
        .map((g) => ({ g, b: boxOf(find(g.id) ?? g, next) }))
        .filter(({ b }) => centerInside(box, b))
        .sort((a, b) => a.b.w * a.b.h - b.b.w * b.b.h)[0];
      const targetId = target?.g.id;
      if (targetId === n.parentId) continue;
      changed = true;
      if (!target) {
        const { parentId: _p, extent: _e, ...rest } = n;
        next = next.map((m) => (m.id === n.id ? ({ ...rest, position: { x: box.x, y: box.y } } as Node) : m));
        continue;
      }
      const gb = target.b;
      const rel = {
        x: Math.max(GROUP_PAD, box.x - gb.x),
        y: Math.max(GROUP_HEADER, box.y - gb.y),
      };
      const needW = rel.x + box.w + GROUP_PAD;
      const needH = rel.y + box.h + GROUP_PAD;
      next = next.map((m) => {
        if (m.id === n.id) return { ...m, parentId: targetId, position: rel } as Node;
        if (m.id === targetId && (needW > gb.w || needH > gb.h)) {
          // O grupo cresce para caber o novo membro.
          const width = Math.max(gb.w, needW);
          const height = Math.max(gb.h, needH);
          const style = { ...(m.style ?? {}), width, height };
          // `width/height` só se o nó já usava (o NodeResizer grava ali).
          return {
            ...m,
            style,
            ...(m.width !== undefined ? { width } : {}),
            ...(m.height !== undefined ? { height } : {}),
          } as Node;
        }
        return m;
      });
    }
    return changed ? sortParentsFirst(next) : nds;
  });
}

function GuidesLayer({ guides }: { guides: Guide[] }) {
  const zoom = useStore((s) => s.transform[2]);
  if (!guides.length) return null;
  const t = 1 / (zoom || 1);
  return (
    <ViewportPortal>
      {guides.map((g, i) => (
        <div
          key={`${g.dir}-${g.pos}-${i}`}
          className={`ux-guide ux-guide-${g.dir}`}
          style={
            g.dir === "v"
              ? { transform: `translate(${g.pos - t / 2}px, ${g.from}px)`, width: t, height: g.to - g.from }
              : { transform: `translate(${g.from}px, ${g.pos - t / 2}px)`, height: t, width: g.to - g.from }
          }
        />
      ))}
    </ViewportPortal>
  );
}
