import { memo } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  getSmoothStepPath,
  getStraightPath,
  useReactFlow,
  type EdgeProps,
} from "@xyflow/react";
import type { EdgePath } from "../lib/connections";

// Aresta tipada (dados/controle) com uma pequena barra ao ser selecionada:
// alterna o tipo e remove a conexão.
function DeletableEdgeInner({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
  markerEnd,
  style,
  data,
}: EdgeProps) {
  const { setEdges, updateEdgeData } = useReactFlow();
  const d = data as
    | { active?: boolean; kind?: "data" | "control"; path?: EdgePath }
    | undefined;
  const active = d?.active;
  const isControl = d?.kind === "control";

  // Traçado escolhido por aresta no menu de contexto (padrão: curva).
  const geo = { sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition };
  const [path, labelX, labelY] =
    d?.path === "straight"
      ? getStraightPath(geo)
      : d?.path === "step"
        ? getSmoothStepPath({ ...geo, borderRadius: 8 })
        : getBezierPath(geo);

  const edgeStyle: React.CSSProperties = {
    ...style,
    stroke: isControl ? "var(--warning)" : "var(--accent)",
    strokeWidth: active ? 3.5 : 2,
    strokeDasharray: isControl ? "7 5" : undefined,
  };

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={edgeStyle}
        className={active ? "edge-active" : undefined}
      />
      {selected && (
        <EdgeLabelRenderer>
          <div
            className="edge-toolbar nodrag nopan"
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: "all",
            }}
          >
            <button
              className="edge-kind"
              title="Alternar tipo (dados / controle)"
              onClick={(e) => {
                e.stopPropagation();
                updateEdgeData(id, { kind: isControl ? "data" : "control" });
              }}
            >
              {isControl ? "controle" : "dados"}
            </button>
            <button
              className="edge-del"
              title="Remover conexão"
              onClick={(e) => {
                e.stopPropagation();
                setEdges((eds) => eds.filter((x) => x.id !== id));
              }}
            >
              ✕
            </button>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const DeletableEdge = memo(DeletableEdgeInner);
