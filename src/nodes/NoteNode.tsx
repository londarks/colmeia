import { memo } from "react";
import {
  Handle,
  Position,
  NodeResizer,
  useReactFlow,
  type NodeProps,
} from "@xyflow/react";
import { StickyNote, X } from "lucide-react";

export interface NoteNodeData {
  title: string;
  content: string;
}

const NOTE_COLOR = "#f59e0b";

function NoteNodeInner({ id, data, selected }: NodeProps) {
  const d = data as unknown as NoteNodeData;
  const { updateNodeData, deleteElements } = useReactFlow();

  return (
    <div
      className={`note-node ${selected ? "is-selected" : ""}`}
      style={{ ["--agent" as string]: NOTE_COLOR } as React.CSSProperties}
    >
      <NodeResizer
        minWidth={200}
        minHeight={140}
        isVisible={!!selected}
        color={NOTE_COLOR}
        handleClassName="term-resize-handle"
        lineClassName="term-resize-line"
      />
      <Handle type="target" position={Position.Left} className="term-handle" />

      <div className="note-header">
        <StickyNote className="node-icon" size={14} strokeWidth={1.8} />
        <input
          className="note-title nodrag"
          value={d.title}
          placeholder="Título"
          onChange={(e) => updateNodeData(id, { title: e.target.value })}
        />
        <button
          className="node-close nodrag"
          title="Excluir nota"
          onClick={(e) => {
            e.stopPropagation();
            deleteElements({ nodes: [{ id }] });
          }}
        >
          <X size={13} strokeWidth={2} />
        </button>
      </div>

      <textarea
        className="note-body nodrag nowheel"
        value={d.content}
        placeholder="Escreva aqui…"
        onChange={(e) => updateNodeData(id, { content: e.target.value })}
      />

      <Handle type="source" position={Position.Right} className="term-handle" />
    </div>
  );
}

export const NoteNode = memo(NoteNodeInner);
