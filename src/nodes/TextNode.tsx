import { memo, useEffect, useRef } from "react";
import { NodeResizer, useReactFlow, type NodeProps } from "@xyflow/react";
import { Trash2 } from "lucide-react";

export interface TextNodeData {
  text: string;
  color?: string;
  fontSize?: number;
}

const TEXT_COLORS = ["#e6e9ef", "#f59e0b", "#38bdf8", "#a855f7", "#ef4444", "#22c55e"];

function TextNodeInner({ id, data, selected }: NodeProps) {
  const d = data as unknown as TextNodeData;
  const { updateNodeData, deleteElements } = useReactFlow();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const color = d.color ?? "#e6e9ef";
  const size = d.fontSize ?? 22;
  const noBlur = (e: React.MouseEvent) => e.preventDefault();

  // Foca ao criar um texto vazio (para já poder digitar).
  useEffect(() => {
    if (d.text === "" && bodyRef.current) bodyRef.current.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className={`text-node ${selected ? "is-selected" : ""}`}
      style={{ ["--agent" as string]: "var(--accent)" } as React.CSSProperties}
    >
      <NodeResizer
        minWidth={80}
        minHeight={36}
        isVisible={!!selected}
        handleClassName="term-resize-handle"
        lineClassName="term-resize-line"
      />

      {selected && (
        <div className="text-node-bar nodrag" onMouseDown={noBlur}>
          <button
            className="tnb-btn"
            title="Diminuir"
            onMouseDown={noBlur}
            onClick={() => updateNodeData(id, { fontSize: Math.max(10, size - 3) })}
          >
            A−
          </button>
          <button
            className="tnb-btn"
            title="Aumentar"
            onMouseDown={noBlur}
            onClick={() => updateNodeData(id, { fontSize: Math.min(120, size + 3) })}
          >
            A+
          </button>
          <span className="tnb-div" />
          {TEXT_COLORS.map((c) => (
            <button
              key={c}
              className={`tnb-swatch ${c === color ? "on" : ""}`}
              style={{ background: c }}
              title="Cor do texto"
              onMouseDown={noBlur}
              onClick={() => updateNodeData(id, { color: c })}
            />
          ))}
          <span className="tnb-div" />
          <button
            className="tnb-btn danger"
            title="Excluir texto"
            onMouseDown={noBlur}
            onClick={() => deleteElements({ nodes: [{ id }] })}
          >
            <Trash2 size={14} strokeWidth={1.9} />
          </button>
        </div>
      )}

      <div
        ref={bodyRef}
        className="text-node-body nodrag nowheel"
        contentEditable
        suppressContentEditableWarning
        style={{ color, fontSize: size }}
        onBlur={(e) => updateNodeData(id, { text: e.currentTarget.textContent ?? "" })}
      >
        {d.text}
      </div>
    </div>
  );
}

export const TextNode = memo(TextNodeInner);
