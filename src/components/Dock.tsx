// UI do Dock (lógica em hooks/useDock.tsx): barra de abas dos terminais + painel
// com o terminal docado ativo. O painel reanexa o terminal vivo do registry.

import { useEffect, useRef, type RefObject } from "react";
import type { Node } from "@xyflow/react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronDown,
  Maximize2,
  PanelBottom,
  Search,
} from "lucide-react";
import { AGENTS, type AgentId } from "../lib/agents";
import {
  attachTerminal,
  detachTerminal,
  focusTerminal,
  liftTerminal,
  openSearch,
  useSearchOpen,
} from "../lib/terminalRegistry";
import { ActivityIndicator, StatusPill } from "./TerminalBadges";
import { TerminalSearchBar } from "./TerminalSearchBar";

/** Prioridade do slot do Dock: acima do nó (0, que nem monta quando docado), abaixo do Lift (1). */
const DOCK_SLOT_PRIORITY = 0.5;

interface TermData {
  agent: AgentId;
  title?: string;
  docked?: boolean;
  waiting?: boolean;
}

interface Props {
  zoneRef: RefObject<HTMLDivElement | null>;
  open: boolean;
  setOpen: (v: boolean | ((p: boolean) => boolean)) => void;
  terminals: Node[];
  active: string | null;
  setActive: (id: string | null) => void;
  dragging: boolean;
  hover: boolean;
  panelHeight: number;
  setPanelHeight: (h: number) => void;
  onFocus: (id: string) => void;
  onDock: (id: string) => void;
  onUndock: (id: string) => void;
}

export function Dock(p: Props) {
  const dockedCount = p.terminals.filter((n) => (n.data as unknown as TermData).docked).length;
  const activeNode = p.active ? p.terminals.find((n) => n.id === p.active) : undefined;
  const showBar = p.open || p.dragging;

  return (
    <div className={`ux-dock ${p.dragging ? "is-dragging" : ""} ${p.hover ? "is-hover" : ""}`}>
      {activeNode && p.open && (
        <DockPanel
          key={activeNode.id}
          node={activeNode}
          height={p.panelHeight}
          setHeight={p.setPanelHeight}
          onMinimize={() => p.setActive(null)}
          onUndock={() => p.onUndock(activeNode.id)}
        />
      )}
      {showBar ? (
        <div ref={p.zoneRef} className="ux-dock-bar" role="tablist" aria-label="Dock de terminais">
          {p.dragging && (
            <div className="ux-dock-drop">
              {p.hover ? "Solte para estacionar no Dock" : "Arraste até aqui para estacionar"}
            </div>
          )}
          {p.terminals.length === 0 && !p.dragging && (
            <span className="ux-dock-empty">Sem terminais neste canvas</span>
          )}
          {p.terminals.map((n) => {
            const d = n.data as unknown as TermData;
            const agent = AGENTS[d.agent] ?? AGENTS.shell;
            const isActive = p.active === n.id;
            return (
              <div
                key={n.id}
                role="tab"
                aria-selected={isActive}
                className={`ux-dock-tab ${d.docked ? "is-docked" : ""} ${isActive ? "is-active" : ""}`}
                style={{ ["--agent" as string]: agent.color } as React.CSSProperties}
                title={
                  d.docked
                    ? `${d.title ?? agent.label} — estacionado (clique para abrir)`
                    : `${d.title ?? agent.label} — clique para ir até o nó`
                }
                onClick={() => {
                  if (d.docked) p.setActive(isActive ? null : n.id);
                  else p.onFocus(n.id);
                }}
              >
                <ActivityIndicator id={n.id} waiting={d.waiting} />
                <agent.icon size={13} strokeWidth={1.9} className="ux-dock-icon" />
                <span className="ux-dock-title">{d.title ?? agent.label}</span>
                <button
                  className="ux-dock-tab-btn"
                  title={d.docked ? "Devolver ao canvas" : "Estacionar no Dock"}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (d.docked) p.onUndock(n.id);
                    else p.onDock(n.id);
                  }}
                >
                  {d.docked ? (
                    <ArrowUpFromLine size={11} strokeWidth={2} />
                  ) : (
                    <ArrowDownToLine size={11} strokeWidth={2} />
                  )}
                </button>
              </div>
            );
          })}
          <button
            className="ux-dock-collapse"
            title="Esconder o Dock (Ctrl+Shift+D)"
            onClick={() => p.setOpen(false)}
          >
            <ChevronDown size={13} strokeWidth={2} />
          </button>
        </div>
      ) : (
        <button
          className="ux-dock-reopen"
          title="Mostrar o Dock (Ctrl+Shift+D)"
          onClick={() => p.setOpen(true)}
        >
          <PanelBottom size={13} strokeWidth={1.9} />
          Dock{dockedCount ? ` · ${dockedCount}` : ""}
        </button>
      )}
    </div>
  );
}

function DockPanel({
  node,
  height,
  setHeight,
  onMinimize,
  onUndock,
}: {
  node: Node;
  height: number;
  setHeight: (h: number) => void;
  onMinimize: () => void;
  onUndock: () => void;
}) {
  const slotRef = useRef<HTMLDivElement>(null);
  const id = node.id;
  const d = node.data as unknown as TermData;
  const agent = AGENTS[d.agent] ?? AGENTS.shell;
  const searching = useSearchOpen(id);

  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    attachTerminal(id, slot, DOCK_SLOT_PRIORITY);
    const raf = requestAnimationFrame(() => focusTerminal(id));
    return () => {
      cancelAnimationFrame(raf);
      detachTerminal(id, slot);
    };
  }, [id]);

  // Redimensionar arrastando a borda de cima.
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    const move = (ev: PointerEvent) => {
      const h = Math.round(startH + (startY - ev.clientY));
      setHeight(Math.max(160, Math.min(window.innerHeight * 0.85, h)));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div
      className="ux-dock-panel"
      style={{ height, ["--agent" as string]: agent.color } as React.CSSProperties}
    >
      <div className="ux-dock-resize" onPointerDown={startResize} title="Arraste para redimensionar" />
      <div className="node-header ux-dock-panel-header">
        <ActivityIndicator id={id} waiting={d.waiting} />
        <span className="node-title">
          <agent.icon className="node-icon" size={13} strokeWidth={1.9} />
          <span className="node-title-text">{d.title ?? agent.label}</span>
        </span>
        <StatusPill id={id} />
        <span className="lift-hint">estacionado no Dock</span>
        <button className="node-icon-btn" title="Buscar no terminal (Ctrl+F)" onClick={() => openSearch(id)}>
          <Search size={12} strokeWidth={2} />
        </button>
        <button className="node-icon-btn" title="Expandir (Lift)" onClick={() => liftTerminal(id)}>
          <Maximize2 size={12} strokeWidth={2} />
        </button>
        <button className="node-icon-btn" title="Devolver ao canvas" onClick={onUndock}>
          <ArrowUpFromLine size={12} strokeWidth={2} />
        </button>
        <button className="node-icon-btn" title="Minimizar painel" onClick={onMinimize}>
          <ChevronDown size={12} strokeWidth={2} />
        </button>
      </div>
      <div className="term-body-wrap">
        <div ref={slotRef} className="term-body" />
        {searching && <TerminalSearchBar id={id} />}
      </div>
    </div>
  );
}
