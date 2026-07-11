import { memo } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  useReactFlow,
  type EdgeProps,
} from "@xyflow/react";

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
  const d = data as { active?: boolean; kind?: "data" | "control" } | undefined;
  const active = d?.active;
  const isControl = d?.kind === "control";

  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

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
