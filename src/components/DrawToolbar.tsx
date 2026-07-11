import { MousePointer2, Pencil, Eraser, Trash2 } from "lucide-react";
import type { DrawTool } from "./DrawLayer";

const COLORS = ["#e6e9ef", "#f59e0b", "#38bdf8", "#a855f7", "#ef4444", "#22c55e"];

interface Props {
  tool: DrawTool;
  setTool: (t: DrawTool) => void;
  color: string;
  setColor: (c: string) => void;
  onClear: () => void;
}

export function DrawToolbar({ tool, setTool, color, setColor, onClear }: Props) {
  return (
    <div className="draw-toolbar">
      <button
        className={`draw-tool ${tool === "select" ? "on" : ""}`}
        title="Selecionar / mover (V)"
        onClick={() => setTool("select")}
      >
        <MousePointer2 size={17} strokeWidth={1.9} />
      </button>
      <button
        className={`draw-tool ${tool === "draw" ? "on" : ""}`}
        title="Desenhar (D)"
        onClick={() => setTool("draw")}
      >
        <Pencil size={17} strokeWidth={1.9} />
      </button>
      <button
        className={`draw-tool ${tool === "erase" ? "on" : ""}`}
        title="Borracha (E)"
        onClick={() => setTool("erase")}
      >
        <Eraser size={17} strokeWidth={1.9} />
      </button>

      <div className="draw-sep" />

      <div className="draw-swatches">
        {COLORS.map((c) => (
          <button
            key={c}
            className={`draw-swatch ${c === color ? "on" : ""}`}
            style={{ background: c }}
            title="Cor"
            onClick={() => {
              setColor(c);
              if (tool === "select") setTool("draw");
            }}
          />
        ))}
      </div>

      <div className="draw-sep" />

      <button className="draw-tool" title="Limpar desenho" onClick={onClear}>
        <Trash2 size={16} strokeWidth={1.9} />
      </button>
    </div>
  );
}
