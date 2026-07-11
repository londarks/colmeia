import { memo, useRef, useState } from "react";
import {
  Handle,
  Position,
  NodeResizer,
  useReactFlow,
  type NodeProps,
} from "@xyflow/react";
import { Pencil, X, Eraser } from "lucide-react";

interface Stroke {
  d: string;
  color: string;
  width: number;
}
export interface DrawingNodeData {
  strokes?: Stroke[];
  color?: string;
}

const COLORS = ["#e6e9ef", "#f59e0b", "#38bdf8", "#a855f7", "#ef4444", "#22c55e"];
const NODE_COLOR = "#94a3b8";

function DrawingNodeInner({ id, data, selected }: NodeProps) {
  const d = data as unknown as DrawingNodeData;
  const strokes = d.strokes ?? [];
  const [color, setColor] = useState(d.color ?? COLORS[0]);
  const [curD, setCurD] = useState("");
  const { updateNodeData, deleteElements, getZoom } = useReactFlow();
  const svgRef = useRef<SVGSVGElement>(null);
  const drawing = useRef(false);

  const point = (e: React.PointerEvent) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const z = getZoom() || 1;
    const x = ((e.clientX - rect.left) / z).toFixed(1);
    const y = ((e.clientY - rect.top) / z).toFixed(1);
    return `${x} ${y}`;
  };

  const down = (e: React.PointerEvent) => {
    drawing.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    setCurD(`M ${point(e)}`);
  };
  const move = (e: React.PointerEvent) => {
    if (!drawing.current) return;
    setCurD((prev) => `${prev} L ${point(e)}`);
  };
  const up = () => {
    if (!drawing.current) return;
    drawing.current = false;
    setCurD((prev) => {
      if (prev.includes("L")) {
        updateNodeData(id, {
          strokes: [...strokes, { d: prev, color, width: 2.5 }],
        });
      }
      return "";
    });
  };

  return (
    <div
      className={`drawing-node ${selected ? "is-selected" : ""}`}
      style={{ ["--agent" as string]: NODE_COLOR } as React.CSSProperties}
    >
      <NodeResizer
        minWidth={220}
        minHeight={180}
        isVisible={!!selected}
        color={NODE_COLOR}
        handleClassName="term-resize-handle"
        lineClassName="term-resize-line"
      />
      <Handle type="target" position={Position.Left} className="term-handle" />

      <div className="node-header drawing-header">
        <Pencil size={13} className="node-icon" />
        <div className="draw-colors nodrag">
          {COLORS.map((c) => (
            <button
              key={c}
              className={`draw-color ${c === color ? "on" : ""}`}
              style={{ background: c }}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                setColor(c);
                updateNodeData(id, { color: c });
              }}
            />
          ))}
        </div>
        <button
          className="node-close nodrag"
          title="Limpar"
          onClick={(e) => {
            e.stopPropagation();
            updateNodeData(id, { strokes: [] });
          }}
        >
          <Eraser size={12} strokeWidth={2} />
        </button>
        <button
          className="node-close nodrag"
          title="Excluir"
          onClick={(e) => {
            e.stopPropagation();
            deleteElements({ nodes: [{ id }] });
          }}
        >
          <X size={13} strokeWidth={2} />
        </button>
      </div>

      <div className="drawing-body nodrag nowheel">
        <svg
          ref={svgRef}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
        >
          {strokes.map((s, i) => (
            <path
              key={i}
              d={s.d}
              stroke={s.color}
              strokeWidth={s.width}
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
          {curD && (
            <path
              d={curD}
              stroke={color}
              strokeWidth={2.5}
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}
        </svg>
      </div>

      <Handle type="source" position={Position.Right} className="term-handle" />
    </div>
  );
}

export const DrawingNode = memo(DrawingNodeInner);
