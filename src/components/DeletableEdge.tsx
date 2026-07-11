import { memo } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  useReactFlow,
  type EdgeProps,
} from "@xyflow/react";

// Aresta com um botão ✕ no meio, que aparece quando a conexão é selecionada.
// Clique na linha para selecioná-la; depois no ✕ para removê-la.
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
  const { setEdges } = useReactFlow();
  const active = (data as { active?: boolean } | undefined)?.active;
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={active ? { ...style, strokeWidth: 3.5 } : style}
        className={active ? "edge-active" : undefined}
      />
      <EdgeLabelRenderer>
        <button
          className={`edge-del nodrag nopan ${selected ? "is-visible" : ""}`}
          style={{
            position: "absolute",
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: "all",
          }}
          title="Remover conexão"
          onClick={(e) => {
            e.stopPropagation();
            setEdges((eds) => eds.filter((x) => x.id !== id));
          }}
        >
          ✕
        </button>
      </EdgeLabelRenderer>
    </>
  );
}

export const DeletableEdge = memo(DeletableEdgeInner);
