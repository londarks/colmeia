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
export type DrawTool = "select" | "draw" | "erase";

interface Props {
  tool: DrawTool;
  color: string;
  strokes: Stroke[];
  setStrokes: Dispatch<SetStateAction<Stroke[]>>;
}

function toPath(pts: Point[]): string {
  if (pts.length === 0) return "";
  return "M " + pts.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" L ");
}

// Camada de desenho livre em coordenadas do canvas (acompanha pan/zoom).
export function DrawLayer({ tool, color, strokes, setStrokes }: Props) {
  const { screenToFlowPosition } = useReactFlow();
  const [cur, setCur] = useState<Point[]>([]);
  const drawing = useRef(false);
  const active = tool === "draw" || tool === "erase";

  const flowPt = (e: React.PointerEvent): Point =>
    screenToFlowPosition({ x: e.clientX, y: e.clientY });

  const eraseAt = (p: Point) => {
    setStrokes((s) =>
      s.filter((st) => !st.points.some((pt) => Math.hypot(pt.x - p.x, pt.y - p.y) < 14)),
    );
  };

  const down = (e: React.PointerEvent) => {
    const p = flowPt(e);
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
      </ViewportPortal>

      {active && (
        <div
          className="draw-capture"
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          style={{ cursor: tool === "erase" ? "cell" : "crosshair" }}
        />
      )}
    </>
  );
}
