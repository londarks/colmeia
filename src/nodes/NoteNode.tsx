import { memo } from "react";
import {
  Handle,
  Position,
  NodeResizer,
  useReactFlow,
  type NodeProps,
} from "@xyflow/react";

export interface NoteNodeData {
  title: string;
  content: string;
}

const NOTE_COLOR = "#f59e0b";

function NoteNodeInner({ id, data, selected }: NodeProps) {
  const d = data as unknown as NoteNodeData;
  const { updateNodeData } = useReactFlow();

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
        <span className="grip" aria-hidden>
          📝
        </span>
        <input
          className="note-title nodrag"
          value={d.title}
          placeholder="Título"
          onChange={(e) => updateNodeData(id, { title: e.target.value })}
        />
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
