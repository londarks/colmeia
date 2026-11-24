// UX do canvas num hook só (para o App.tsx ficar com poucas linhas de integração):
// menu de contexto, grade/guias magnéticas, alinhar/distribuir/tidy, Dock, Composer,
// validação de conexões e derivação visual dos flags dos nós.
//
// Flags persistidos em `node.data` (entram no auto-save e no undo):
//   pinned → draggable:false · z → zIndex · docked → hidden (terminal no Dock)
// e `edge.data.path` (curva/reta/degrau) é lido pelo DeletableEdge.
//
// Atalhos (fora de terminais/campos): Ctrl+D duplicar · Ctrl+Enter composer ·
// Alt+G grade · Ctrl+] / Ctrl+[ frente/trás · Ctrl+Shift+L travar · F2 renomear.
// (Alinhar/tidy em useLayout; Ctrl+Shift+D em useDock.)

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Connection, Edge, Node } from "@xyflow/react";
import { isEditableTarget, type CanvasApi } from "../lib/canvas";
import { canConnect } from "../lib/connections";
import { Composer, mentionsFor } from "../components/Composer";
import { useContextMenu } from "./useContextMenu";
import { useDock } from "./useDock";
import { useLayout } from "./useLayout";
import { useNodeActions } from "./useNodeActions";
import { useSnapGuides } from "./useSnapGuides";

type DragEvent = MouseEvent | TouchEvent;

interface Params {
  api: CanvasApi;
  /** Nós já decorados (useCanvasControls) — recebem mais uma camada aqui. */
  nodes: Node[];
  grouping: { groupSelection: () => string | null; ungroup: (ids: string[]) => void };
  focusNode: (id: string) => void;
}

/** Classes que só este hook aplica (limpas antes de reaplicar; ver useCanvasDecorations). */
const OWN = new Set(["node-pinned"]);

function withClass(cls: string | undefined, add: string | null): string | undefined {
  const kept = (cls ?? "").split(/\s+/).filter((c) => c && !OWN.has(c));
  if (add) kept.push(add);
  return kept.length ? kept.join(" ") : undefined;
}

/** Deriva hidden/draggable/zIndex/className dos flags em `data`, preservando identidade. */
function useUxNodes(nodes: Node[]): Node[] {
  return useMemo(
    () =>
      nodes.map((n) => {
        const d = (n.data ?? {}) as { pinned?: boolean; z?: number; docked?: boolean };
        const hidden = n.type === "terminal" && d.docked ? true : undefined;
        const draggable = d.pinned ? false : undefined;
        const zIndex = typeof d.z === "number" ? d.z : undefined;
        const className = withClass(n.className, d.pinned ? "node-pinned" : null);
        if (
          n.hidden === hidden &&
          n.draggable === draggable &&
          n.zIndex === zIndex &&
          n.className === className
        ) {
          return n;
        }
        return { ...n, hidden, draggable, zIndex, className };
      }),
    [nodes],
  );
}

export function useCanvasUx({ api, nodes, grouping, focusNode }: Params) {
  const actions = useNodeActions(api);
  const layout = useLayout(api);
  const snap = useSnapGuides(api);
  const dock = useDock(api, nodes, focusNode);

  // ---- Composer -------------------------------------------------------------
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerInit, setComposerInit] = useState({ text: "", nonce: 0 });
  const openComposer = useCallback(
    (mentionIds?: string[]) => {
      const all = api.nodesRef.current;
      const ids = mentionIds ?? all.filter((n) => n.selected).map((n) => n.id);
      const m = mentionsFor(all.filter((n) => ids.includes(n.id)));
      setComposerInit((p) => ({ text: m ? `${m} ` : "", nonce: p.nonce + 1 }));
      setComposerOpen(true);
    },
    [api],
  );
  const toggleComposer = useCallback(() => {
    if (composerOpen) setComposerOpen(false);
    else openComposer();
  }, [composerOpen, openComposer]);

  const menu = useContextMenu({
    api,
    actions,
    layout,
    grouping,
    dock: dock.api,
    snap,
    focusNode,
    openComposer,
  });

  // ---- Conexões -------------------------------------------------------------
  const isValidConnection = useCallback(
    (c: Connection | Edge) => canConnect(api.nodesRef.current, api.edgesRef.current, c),
    [api],
  );

  // ---- Arraste (Dock tem prioridade; depois ímã + soltar em grupo) ------------
  const onNodeDragStart = useCallback(
    (e: DragEvent, node: Node, dragged: Node[]) => dock.onNodeDragStart(e, node, dragged),
    [dock],
  );
  const onNodeDrag = useCallback(
    (e: DragEvent, node: Node, dragged: Node[]) => {
      dock.onNodeDrag(e);
      snap.onNodeDrag(e, node, dragged);
    },
    [dock, snap],
  );
  const onNodeDragStop = useCallback(
    (e: DragEvent, node: Node, dragged: Node[]) => {
      if (dock.onNodeDragStop(e)) {
        snap.clearGuides();
        return;
      }
      snap.onNodeDragStop(e, node, dragged);
    },
    [dock, snap],
  );

  // ---- Atalhos ----------------------------------------------------------------
  const h = useRef({ actions, openComposer, snap, startRename: menu.startRename });
  h.current = { actions, openComposer, snap, startRename: menu.startRename };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.isComposing) return;
      if (isEditableTarget(e.target) || isEditableTarget(document.activeElement)) return;
      if (document.querySelector(".cl-overlay")) return; // palette/ajuda abertas
      const H = h.current;
      const ctrl = e.ctrlKey || e.metaKey;
      const sel = api.nodesRef.current.filter((n) => n.selected).map((n) => n.id);
      const consume = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (ctrl && !e.shiftKey && !e.altKey && e.key === "Enter") {
        consume();
        H.openComposer();
        return;
      }
      if (e.altKey && !ctrl && !e.shiftKey && e.code === "KeyG") {
        consume();
        H.snap.setGridOn((v) => !v);
        return;
      }
      if (!e.altKey && !ctrl && !e.shiftKey && e.key === "F2" && sel.length === 1) {
        consume();
        H.startRename(sel[0]);
        return;
      }
      if (!ctrl || e.altKey || !sel.length) return;
      if (!e.shiftKey && e.code === "KeyD") {
        consume();
        H.actions.duplicate(sel);
      } else if (e.shiftKey && e.code === "KeyL") {
        consume();
        H.actions.togglePin(sel);
      } else if (!e.shiftKey && e.code === "BracketRight") {
        consume();
        H.actions.bringToFront(sel);
      } else if (!e.shiftKey && e.code === "BracketLeft") {
        consume();
        H.actions.sendToBack(sel);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [api]);

  const renderNodes = useUxNodes(nodes);

  const overlays: ReactNode = (
    <>
      {dock.element}
      {composerOpen && (
        <Composer
          nodes={api.nodesRef.current}
          initial={composerInit}
          onClose={() => setComposerOpen(false)}
        />
      )}
      {menu.element}
    </>
  );

  return {
    /** Nós para o <ReactFlow> (com hidden/draggable/zIndex derivados). */
    nodes: renderNodes,
    /** Props extras para espalhar no <ReactFlow>. */
    flowProps: {
      ...menu.flowProps,
      ...snap.flowProps,
      isValidConnection,
      onNodeDragStart,
      onNodeDrag,
      onNodeDragStop,
    },
    /** Camada dentro do <ReactFlow> (linhas-guia no espaço do canvas). */
    viewportLayer: snap.layer,
    /** Overlays fora do <ReactFlow> (Dock, Composer, menu, renomear). */
    overlays,
    composer: { open: composerOpen, toggle: toggleComposer },
    snap: { gridOn: snap.gridOn },
  };
}
