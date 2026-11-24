import { useEffect, useRef } from "react";
import type { Node } from "@xyflow/react";
import { Minimize2, Search } from "lucide-react";
import { AGENTS, type AgentId } from "../lib/agents";
import {
  attachTerminal,
  detachTerminal,
  focusTerminal,
  hasTerminal,
  openSearch,
  unliftTerminal,
  useLiftedTerminal,
  useSearchOpen,
} from "../lib/terminalRegistry";
import { ActivityIndicator, StatusPill } from "./TerminalBadges";
import { TerminalSearchBar } from "./TerminalSearchBar";

/**
 * Lift: abre um terminal num painel grande sobre o canvas desfocado. É o MESMO terminal vivo
 * do registry, reanexado aqui com prioridade maior que o slot do nó. Esc (fora do terminal),
 * F11 (dentro), clique no fundo ou o botão de recolher voltam ao canvas.
 */
export function LiftOverlay({ nodes }: { nodes: Node[] }) {
  const liftedId = useLiftedTerminal();
  const node = liftedId ? nodes.find((n) => n.id === liftedId) : undefined;

  // Trocou de canvas / o nó sumiu: fecha o Lift.
  useEffect(() => {
    if (liftedId && (!node || !hasTerminal(liftedId))) unliftTerminal();
  }, [liftedId, node]);

  if (!liftedId || !node) return null;
  return <LiftPanel key={liftedId} id={liftedId} node={node} />;
}

function LiftPanel({ id, node }: { id: string; node: Node }) {
  const slotRef = useRef<HTMLDivElement>(null);
  const searching = useSearchOpen(id);
  const d = node.data as { agent: AgentId; title?: string; waiting?: boolean };
  const agent = AGENTS[d.agent] ?? AGENTS.shell;

  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    attachTerminal(id, slot, 1);
    const raf = requestAnimationFrame(() => focusTerminal(id));
    return () => {
      cancelAnimationFrame(raf);
      detachTerminal(id, slot);
    };
  }, [id]);

  // Esc volta ao canvas — exceto quando o foco está no terminal (Esc é tecla do TUI,
  // ex.: interromper o Claude Code) ou na busca (que trata o próprio Esc).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const t = e.target as HTMLElement | null;
      if (t?.closest(".xterm, .term-search")) return;
      e.preventDefault();
      unliftTerminal();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="lift-backdrop" onMouseDown={(e) => e.target === e.currentTarget && unliftTerminal()}>
      <div
        className="lift-panel"
        style={{ ["--agent" as string]: agent.color } as React.CSSProperties}
      >
        <div className="node-header lift-header" onDoubleClick={unliftTerminal}>
          <ActivityIndicator id={id} waiting={d.waiting} />
          <span className="node-title">
            <agent.icon className="node-icon" size={13} strokeWidth={1.9} />
            <span className="node-title-text">{d.title ?? agent.label}</span>
          </span>
          <StatusPill id={id} />
          <span className="lift-hint">Esc / F11 para voltar</span>
          <button
            className="node-icon-btn"
            title="Buscar no terminal (Ctrl+F)"
            onClick={() => openSearch(id)}
          >
            <Search size={12} strokeWidth={2} />
          </button>
          <button className="node-icon-btn" title="Recolher (Esc)" onClick={unliftTerminal}>
            <Minimize2 size={12} strokeWidth={2} />
          </button>
        </div>
        <div className="term-body-wrap">
          <div ref={slotRef} className="term-body" />
          {searching && <TerminalSearchBar id={id} />}
        </div>
      </div>
    </div>
  );
}
