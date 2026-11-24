// Câmera do canvas: glide animado até um nó, enquadrar seleção e viewport por canvas.
//
// Precisa estar dentro de um <ReactFlowProvider> (ver main.tsx).

import { useCallback, useRef, useState } from "react";
import { useReactFlow, useStoreApi, type Viewport } from "@xyflow/react";

const GLIDE_MS = 350;

/** Respeita o pedido do SO por menos animação (vai direto, sem glide). */
function motionMs(ms: number): number {
  try {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return 0;
  } catch {
    /* ignora */
  }
  return ms;
}

/** Elemento DOM do nó no canvas (o React Flow marca com data-id). */
export function nodeElement(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `.react-flow__node[data-id="${CSS.escape(id)}"]`,
  );
}

/** Foca o xterm de um nó terminal (sem rolar o container do canvas). */
export function focusTerminalDom(id: string): boolean {
  const ta = nodeElement(id)?.querySelector<HTMLTextAreaElement>(
    ".xterm-helper-textarea",
  );
  if (!ta) return false;
  ta.focus({ preventScroll: true });
  return true;
}

/** id do nó que contém o foco atual do documento (ex.: um xterm), se houver. */
export function nodeIdOfActiveElement(): string | null {
  const el = document.activeElement as HTMLElement | null;
  const host = el?.closest<HTMLElement>(".react-flow__node");
  return host?.dataset.id ?? null;
}

export interface GlideOptions {
  /** Seleciona o nó (e só ele) ao chegar. Padrão: true. */
  select?: boolean;
  /** Foca o terminal ao chegar (se for terminal). Padrão: true. */
  focus?: boolean;
}

export function useCamera() {
  const rf = useReactFlow();
  const store = useStoreApi();
  // Incrementa quando a câmera para de mexer → dispara o auto-save do canvas.
  const [moveTick, setMoveTick] = useState(0);
  const focusTimer = useRef<number | undefined>(undefined);

  /** Desliza a câmera até o nó, enquadrando-o (zoom ≤ 100%), seleciona e foca. */
  const glideTo = useCallback(
    (nodeId: string, opts: GlideOptions = {}) => {
      const internal = rf.getInternalNode(nodeId);
      if (!internal) return false;
      const pos = internal.internals.positionAbsolute;
      const w = internal.measured?.width ?? internal.width ?? 300;
      const h = internal.measured?.height ?? internal.height ?? 200;
      const dom = store.getState().domNode;
      const vw = dom?.clientWidth ?? window.innerWidth;
      const vh = dom?.clientHeight ?? window.innerHeight;
      // Zoom que faz o nó caber com folga, nunca acima de 100% (legibilidade do xterm).
      const fit = Math.min((vw * 0.85) / w, (vh * 0.85) / h);
      const zoom = Math.max(0.2, Math.min(1, fit));
      const duration = motionMs(GLIDE_MS);
      rf.setCenter(pos.x + w / 2, pos.y + h / 2, { zoom, duration });

      if (opts.select !== false) {
        // Mudanças do tipo "select" (não "replace"): não copiam para o estado as
        // classes decorativas que o App aplica nos nós passados ao <ReactFlow>.
        store.getState().addSelectedNodes([nodeId]);
      }
      if (opts.focus !== false && internal.type === "terminal") {
        window.clearTimeout(focusTimer.current);
        // Foca depois da animação para o foco não brigar com o pan.
        focusTimer.current = window.setTimeout(
          () => focusTerminalDom(nodeId),
          duration + 20,
        );
      }
      return true;
    },
    [rf, store],
  );

  /** Enquadra a seleção (ou o canvas inteiro, se nada estiver selecionado). */
  const frameSelection = useCallback(() => {
    const sel = rf.getNodes().filter((n) => n.selected);
    rf.fitView({
      nodes: sel.length ? sel.map((n) => ({ id: n.id })) : undefined,
      padding: 0.15,
      maxZoom: 1,
      duration: motionMs(GLIDE_MS),
    });
  }, [rf]);

  /** Viewport atual, para salvar no JSON do canvas. */
  const getViewport = useCallback((): Viewport => rf.getViewport(), [rf]);

  /** Restaura a câmera salva de um canvas; sem câmera salva, centraliza o conteúdo. */
  const restoreViewport = useCallback(
    (vp?: Viewport | null) => {
      const valid =
        vp &&
        Number.isFinite(vp.x) &&
        Number.isFinite(vp.y) &&
        Number.isFinite(vp.zoom) &&
        vp.zoom > 0;
      if (valid) {
        // Cancela o `fitView` inicial pendente (senão ele sobrescreve a câmera
        // salva quando os nós carregados terminam de medir).
        store.setState({ fitViewQueued: false });
        rf.setViewport({ x: vp.x, y: vp.y, zoom: vp.zoom });
      } else {
        // Mesmo comportamento do `fitView` do App (centraliza em 100%).
        rf.fitView({ minZoom: 1, maxZoom: 1 });
      }
    },
    [rf, store],
  );

  const onMoveEnd = useCallback(() => setMoveTick((t) => t + 1), []);

  return { glideTo, frameSelection, getViewport, restoreViewport, onMoveEnd, moveTick };
}

export type Camera = ReturnType<typeof useCamera>;
