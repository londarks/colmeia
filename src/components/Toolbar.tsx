import { useState } from "react";
import {
  MousePointer2,
  Terminal,
  StickyNote,
  Type,
  Globe,
  Pencil,
  Eraser,
  Trash2,
  Timer,
  Layers,
  Eye,
} from "lucide-react";
import { AGENT_LIST, type AgentId } from "../lib/agents";
import type { DrawTool } from "./DrawLayer";

const COLORS = ["#e6e9ef", "#f59e0b", "#38bdf8", "#a855f7", "#ef4444", "#22c55e"];

interface Props {
  tool: DrawTool;
  setTool: (t: DrawTool) => void;
  color: string;
  setColor: (c: string) => void;
  onClear: () => void;
  onAddAgent: (a: AgentId) => void;
  onAddNote: () => void;
  onAddBrowser: () => void;
  showRoutines: boolean;
  setShowRoutines: (f: (v: boolean) => boolean) => void;
  showFloors: boolean;
  setShowFloors: (f: (v: boolean) => boolean) => void;
  showOmbro: boolean;
  setShowOmbro: (f: (v: boolean) => boolean) => void;
}

export function Toolbar({
  tool,
  setTool,
  color,
  setColor,
  onClear,
  onAddAgent,
  onAddNote,
  onAddBrowser,
  showRoutines,
  setShowRoutines,
  showFloors,
  setShowFloors,
  showOmbro,
  setShowOmbro,
}: Props) {
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [drawOpen, setDrawOpen] = useState(false);

  return (
    <div className="toolbar-wrap">
      <div className="toolbar">
        <button
          className={`tool-item ${tool === "select" ? "on" : ""}`}
          title="Selecionar / mover"
          onClick={() => setTool("select")}
        >
          <MousePointer2 size={17} strokeWidth={1.9} />
        </button>

        <div className="tool-menu">
          <button
            className={`tool-item ${agentsOpen ? "on" : ""}`}
            title="Adicionar agente"
            onClick={() => setAgentsOpen((v) => !v)}
          >
            <Terminal size={17} strokeWidth={1.9} />
          </button>
          {agentsOpen && (
            <>
              <div className="tool-backdrop" onClick={() => setAgentsOpen(false)} />
              <div className="tool-dropdown">
                {AGENT_LIST.map((a) => (
                  <button
                    key={a.id}
                    className="dropdown-item"
                    onClick={() => {
                      onAddAgent(a.id);
                      setAgentsOpen(false);
                    }}
                  >
                    <a.icon size={15} strokeWidth={1.8} style={{ color: a.color }} />
                    {a.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <button className="tool-item" title="Adicionar nota" onClick={onAddNote}>
          <StickyNote size={17} strokeWidth={1.9} />
        </button>
        <button
          className={`tool-item ${tool === "text" ? "on" : ""}`}
          title="Texto no canvas"
          onClick={() => setTool("text")}
        >
          <Type size={17} strokeWidth={1.9} />
        </button>
        <button className="tool-item" title="Adicionar navegador" onClick={onAddBrowser}>
          <Globe size={17} strokeWidth={1.9} />
        </button>

        <div className="tool-divider" />

        <button
          className={`tool-item ${tool === "draw" || tool === "erase" || drawOpen ? "on" : ""}`}
          title="Desenho"
          onClick={() => setDrawOpen((v) => !v)}
        >
          <Pencil size={17} strokeWidth={1.9} />
        </button>

        <div className="tool-divider" />

        <button
          className={`tool-item ${showRoutines ? "on" : ""}`}
          title="Rotinas"
          onClick={() => setShowRoutines((v) => !v)}
        >
          <Timer size={17} strokeWidth={1.9} />
        </button>
        <button
          className={`tool-item ${showFloors ? "on" : ""}`}
          title="Floors"
          onClick={() => setShowFloors((v) => !v)}
        >
          <Layers size={17} strokeWidth={1.9} />
        </button>
        <button
          className={`tool-item ${showOmbro ? "on" : ""}`}
          title="Ombro"
          onClick={() => setShowOmbro((v) => !v)}
        >
          <Eye size={17} strokeWidth={1.9} />
        </button>
      </div>

      {drawOpen && (
        <div className="toolbar toolbar-subrow">
          <button
            className={`tool-item ${tool === "draw" ? "on" : ""}`}
            title="Desenhar"
            onClick={() => setTool("draw")}
          >
            <Pencil size={16} strokeWidth={1.9} />
          </button>
          <button
            className={`tool-item ${tool === "erase" ? "on" : ""}`}
            title="Borracha"
            onClick={() => setTool("erase")}
          >
            <Eraser size={16} strokeWidth={1.9} />
          </button>
          <div className="tool-divider" />
          <div className="tool-swatches">
            {COLORS.map((c) => (
              <button
                key={c}
                className={`tool-swatch ${c === color ? "on" : ""}`}
                style={{ background: c }}
                title="Cor"
                onClick={() => {
                  setColor(c);
                  setTool("draw");
                }}
              />
            ))}
          </div>
          <div className="tool-divider" />
          <button className="tool-item danger" title="Limpar desenho" onClick={onClear}>
            <Trash2 size={16} strokeWidth={1.9} />
          </button>
        </div>
      )}
    </div>
  );
}
