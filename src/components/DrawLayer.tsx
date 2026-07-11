import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import { ViewportPortal, useReactFlow } from "@xyflow/react";

export interface Point {
  x: number;
  y: number;
}
export interface Stroke {
  points: Point[];
  color: string;
  width: number;
}
export interface TextItem {
  id: string;
  x: number;
  y: number;
  text: string;
  color: string;
}
export type DrawTool = "select" | "draw" | "erase" | "text";

interface Props {
  tool: DrawTool;
  setTool: (t: DrawTool) => void;
  color: string;
  strokes: Stroke[];
  setStrokes: Dispatch<SetStateAction<Stroke[]>>;
  texts: TextItem[];
  setTexts: Dispatch<SetStateAction<TextItem[]>>;
}

function toPath(pts: Point[]): string {
  if (pts.length === 0) return "";
  return "M " + pts.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" L ");
}

// Camada de desenho livre + texto em coordenadas do canvas (acompanha pan/zoom).
export function DrawLayer({
  tool,
  setTool,
  color,
  strokes,
  setStrokes,
  texts,
  setTexts,
}: Props) {
  const { screenToFlowPosition } = useReactFlow();
  const [cur, setCur] = useState<Point[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const drawing = useRef(false);
  const active = tool === "draw" || tool === "erase" || tool === "text";

  const flowPt = (e: React.PointerEvent): Point =>
    screenToFlowPosition({ x: e.clientX, y: e.clientY });

  const eraseAt = (p: Point) => {
    setStrokes((s) =>
      s.filter((st) => !st.points.some((pt) => Math.hypot(pt.x - p.x, pt.y - p.y) < 14)),
    );
  };

  const down = (e: React.PointerEvent) => {
    const p = flowPt(e);
    if (tool === "text") {
      const id = `text-${Date.now()}`;
      setTexts((t) => [...t, { id, x: p.x, y: p.y, text: "", color }]);
      setEditing(id);
      setTool("select");
      return;
    }
    drawing.current = true;
    (e.target as Element).setPointerCapture(e.pointerId);
    if (tool === "draw") setCur([p]);
    else eraseAt(p);
  };
  const move = (e: React.PointerEvent) => {
    if (!drawing.current) return;
    const p = flowPt(e);
    if (tool === "draw") setCur((c) => [...c, p]);
    else eraseAt(p);
  };
  const up = () => {
    if (!drawing.current) return;
    drawing.current = false;
    if (tool === "draw") {
      setCur((c) => {
        if (c.length > 1) setStrokes((s) => [...s, { points: c, color, width: 3 }]);
        return [];
      });
    }
  };

  const commitText = (id: string, value: string) => {
    if (!value.trim()) setTexts((t) => t.filter((x) => x.id !== id));
    else setTexts((t) => t.map((x) => (x.id === id ? { ...x, text: value } : x)));
    setEditing((cur) => (cur === id ? null : cur));
  };

  return (
    <>
      <ViewportPortal>
        <svg
          className="draw-svg"
          width={1}
          height={1}
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            overflow: "visible",
            pointerEvents: "none",
          }}
        >
          {strokes.map((st, i) => (
            <path
              key={i}
              d={toPath(st.points)}
              stroke={st.color}
              strokeWidth={st.width}
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
          {cur.length > 0 && (
            <path
              d={toPath(cur)}
              stroke={color}
              strokeWidth={3}
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}
        </svg>

        {texts.map((t) => (
          <div
            key={t.id}
            className="canvas-text nodrag nowheel"
            contentEditable
            suppressContentEditableWarning
            ref={(el) => {
              if (el && editing === t.id) el.focus();
            }}
            style={{
              position: "absolute",
              left: t.x,
              top: t.y,
              color: t.color,
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onBlur={(e) => commitText(t.id, e.currentTarget.textContent ?? "")}
          >
            {t.text}
          </div>
        ))}
      </ViewportPortal>

      {active && (
        <div
          className="draw-capture"
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          style={{ cursor: tool === "text" ? "text" : tool === "erase" ? "cell" : "crosshair" }}
        />
      )}
    </>
  );
}
