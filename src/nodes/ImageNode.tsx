import { memo } from "react";
import {
  Handle,
  Position,
  NodeResizer,
  useReactFlow,
  type NodeProps,
} from "@xyflow/react";
import { X } from "lucide-react";

export interface ImageNodeData {
  /** data URL (imagens soltas/coladas ficam embutidas no canvas). */
  src: string;
  title?: string;
}

function ImageNodeInner({ id, data, selected }: NodeProps) {
  const d = data as unknown as ImageNodeData;
  const { deleteElements } = useReactFlow();

  return (
    <div
      className={`image-node ${selected ? "is-selected" : ""}`}
      style={{ ["--agent" as string]: "var(--accent)" } as React.CSSProperties}
      title={d.title}
    >
      <NodeResizer
        minWidth={60}
        minHeight={40}
        keepAspectRatio
        isVisible={!!selected}
        handleClassName="term-resize-handle"
        lineClassName="term-resize-line"
      />
      <Handle type="target" position={Position.Left} className="term-handle" />
      {d.src ? (
        <img src={d.src} alt={d.title ?? ""} draggable={false} />
      ) : (
        <div className="image-missing">imagem indisponível</div>
      )}
      {selected && (
        <button
          className="node-close image-close nodrag"
          title="Excluir imagem"
          onClick={(e) => {
            e.stopPropagation();
            deleteElements({ nodes: [{ id }] });
          }}
        >
          <X size={13} strokeWidth={2} />
        </button>
      )}
      <Handle type="source" position={Position.Right} className="term-handle" />
    </div>
  );
}

export const ImageNode = memo(ImageNodeInner);
