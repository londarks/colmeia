// Dock: barra recolhível com uma aba por terminal (ícone, nome, atividade). Clicar
// numa aba desliza a câmera até o nó; arrastar um terminal até a barra (ou "Estacionar
// no Dock" no menu) estaciona o terminal num painel docado: o nó some do canvas
// (`data.docked` → `hidden`), mas o processo continua vivo — o mesmo terminal do
// registry é reanexado no painel com prioridade de slot própria (como o Lift).
//
// Atalho: Ctrl+Shift+D mostra/esconde a barra.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Node, XYPosition } from "@xyflow/react";
import { toast } from "sonner";
import { acquireTerminal } from "../lib/terminalRegistry";
import type { AgentId } from "../lib/agents";
import { isEditableTarget, type CanvasApi } from "../lib/canvas";
import { usePref } from "../lib/uxPrefs";
import { Dock } from "../components/Dock";

type DragEvent = MouseEvent | TouchEvent;

interface TermData {
  agent: AgentId;
  title?: string;
  cwd?: string;
  role?: string;
  restartKey?: number;
  docked?: boolean;
  waiting?: boolean;
}

function clientPoint(e: DragEvent): { x: number; y: number } | null {
  if ("clientX" in e) return { x: e.clientX, y: e.clientY };
  const t = e.changedTouches?.[0] ?? e.touches?.[0];
  return t ? { x: t.clientX, y: t.clientY } : null;
}

export interface DockApi {
  dock: (ids: string[]) => void;
  undock: (id: string) => void;
  isDocked: (id: string) => boolean;
  open: boolean;
  setOpen: (v: boolean | ((p: boolean) => boolean)) => void;
}

export function useDock(api: CanvasApi, nodes: Node[], focusNode: (id: string) => void) {
  const [open, setOpen] = usePref("dockOpen", true);
  const [panelHeight, setPanelHeight] = usePref("dockHeight", 320);
  const [active, setActive] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [hover, setHover] = useState(false);
  const zoneRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef(new Map<string, XYPosition>());
  const hoverRef = useRef(false);

  const terminals = nodes.filter((n) => n.type === "terminal");
  const docked = terminals.filter((n) => (n.data as unknown as TermData).docked);

  // Terminais docados não montam o TerminalNode: garante o processo aqui (mesma
  // chamada do nó; é idempotente e só reinicia se pasta/agente/restartKey mudarem).
  const specKey = docked
    .map((n) => {
      const d = n.data as unknown as TermData;
      return [n.id, d.agent, d.cwd ?? "", d.role ?? "", d.restartKey ?? 0].join("\u0001");
    })
    .join("\u0002");
  useEffect(() => {
    for (const n of docked) {
      const d = n.data as unknown as TermData;
      acquireTerminal(n.id, { agent: d.agent, cwd: d.cwd, role: d.role, restartKey: d.restartKey });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specKey]);

  // O painel ativo precisa ser um terminal docado que ainda existe.
  useEffect(() => {
    if (active && !docked.some((n) => n.id === active)) setActive(null);
  }, [active, docked]);

  const isDocked = useCallback(
    (id: string) =>
      !!(api.nodesRef.current.find((n) => n.id === id)?.data as TermData | undefined)?.docked,
    [api],
  );

  const dock = useCallback(
    (ids: string[]) => {
      const set = new Set(ids);
      const terms = api.nodesRef.current.filter((n) => set.has(n.id) && n.type === "terminal");
      if (!terms.length) return;
      api.setNodes((nds) =>
        nds.map((n) =>
          terms.some((t) => t.id === n.id)
            ? { ...n, selected: false, data: { ...n.data, docked: true } }
            : n,
        ),
      );
      setActive(terms[terms.length - 1].id);
      setOpen(true);
    },
    [api, setOpen],
  );

  const undock = useCallback(
    (id: string) => {
      api.setNodes((nds) =>
        nds.map((n) => {
          if (n.id !== id) return n;
          const { docked: _d, ...rest } = n.data as Record<string, unknown>;
          return { ...n, hidden: undefined, data: rest };
        }),
      );
      setActive((a) => (a === id ? null : a));
      // Espera o nó voltar a ser renderizado antes de deslizar até ele.
      requestAnimationFrame(() => requestAnimationFrame(() => focusNode(id)));
    },
    [api, focusNode],
  );

  // ---- Arrastar até o Dock -------------------------------------------------

  const overZone = (e: DragEvent): boolean => {
    const el = zoneRef.current;
    const p = clientPoint(e);
    if (!el || !p) return false;
    const r = el.getBoundingClientRect();
    return p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
  };

  const onNodeDragStart = useCallback((_e: DragEvent, _node: Node, dragged: Node[]) => {
    const terms = dragged.filter((n) => n.type === "terminal");
    dragStart.current = new Map(terms.map((n) => [n.id, { ...n.position }]));
    if (terms.length) setDragging(true);
  }, []);

  const onNodeDrag = useCallback((e: DragEvent) => {
    if (!dragStart.current.size) return;
    const h = overZone(e);
    if (h !== hoverRef.current) {
      hoverRef.current = h;
      setHover(h);
    }
  }, []);

  /** Devolve true se o arraste terminou no Dock (os terminais foram estacionados). */
  const onNodeDragStop = useCallback(
    (e: DragEvent): boolean => {
      const starts = dragStart.current;
      dragStart.current = new Map();
      const dropped = starts.size > 0 && overZone(e);
      hoverRef.current = false;
      setHover(false);
      setDragging(false);
      if (!dropped) return false;
      // Volta os nós para onde estavam (é lá que reaparecem ao desestacionar).
      api.setNodes((nds) =>
        nds.map((n) => {
          const p = starts.get(n.id);
          return p ? { ...n, position: p } : n;
        }),
      );
      dock([...starts.keys()]);
      toast.success(
        starts.size === 1 ? "Terminal estacionado no Dock" : `${starts.size} terminais estacionados no Dock`,
      );
      return true;
    },
    [api, dock],
  );

  // Ctrl+Shift+D: mostra/esconde o Dock.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey || e.code !== "KeyD") return;
      if (isEditableTarget(e.target) || isEditableTarget(document.activeElement)) return;
      e.preventDefault();
      setOpen((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);

  const element = (
    <Dock
      zoneRef={zoneRef}
      open={open}
      setOpen={setOpen}
      terminals={terminals}
      active={active}
      setActive={setActive}
      dragging={dragging}
      hover={hover}
      panelHeight={panelHeight}
      setPanelHeight={setPanelHeight}
      onFocus={focusNode}
      onDock={(id) => dock([id])}
      onUndock={undock}
    />
  );

  const dockApi: DockApi = { dock, undock, isDocked, open, setOpen };
  return { api: dockApi, element, onNodeDragStart, onNodeDrag, onNodeDragStop };
}
