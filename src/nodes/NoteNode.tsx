import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  Handle,
  Position,
  NodeResizer,
  useReactFlow,
  type NodeProps,
} from "@xyflow/react";
import { StickyNote, X, Lock, LockOpen, Palette, Pencil, Eye } from "lucide-react";
import { Markdown } from "../components/Markdown";
import { NOTE_COLORS, noteColorValue, type NoteColor } from "../lib/noteColors";

export interface NoteNodeData {
  title: string;
  content: string;
  /** Chave da paleta (ver NOTE_COLORS). */
  color?: NoteColor;
  /** Nota travada: sem edição pela UI (e os agentes também respeitam). */
  locked?: boolean;
}

function NoteNodeInner({ id, data, selected }: NodeProps) {
  const d = data as unknown as NoteNodeData;
  const { updateNodeData, deleteElements } = useReactFlow();
  const locked = !!d.locked;
  const [editing, setEditing] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const color = noteColorValue(d.color);
  const content = d.content ?? "";

  // Travar no meio da edição volta para a visualização.
  useEffect(() => {
    if (locked) setEditing(false);
  }, [locked]);

  // Ao entrar em edição, foca e põe o cursor no fim.
  useEffect(() => {
    if (!editing) return;
    const el = areaRef.current;
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [editing]);

  const startEdit = () => {
    if (!locked) setEditing(true);
  };

  const onContentChange = useCallback(
    (next: string) => updateNodeData(id, { content: next }),
    [id, updateNodeData],
  );

  return (
    <div
      className={`note-node ${selected ? "is-selected" : ""} ${locked ? "is-locked" : ""}`}
      style={{ ["--agent" as string]: color } as React.CSSProperties}
    >
      <NodeResizer
        minWidth={200}
        minHeight={140}
        isVisible={!!selected}
        color={color}
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
          readOnly={locked}
          onChange={(e) => updateNodeData(id, { title: e.target.value })}
        />
        {!locked && (
          <button
            className="note-btn nodrag"
            title={editing ? "Visualizar" : "Editar (ou duplo clique)"}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              setEditing((v) => !v);
            }}
          >
            {editing ? <Eye size={13} strokeWidth={2} /> : <Pencil size={13} strokeWidth={2} />}
          </button>
        )}
        <div className="note-palette-wrap">
          <button
            className={`note-btn nodrag ${paletteOpen ? "on" : ""}`}
            title="Cor da nota"
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              setPaletteOpen((v) => !v);
            }}
          >
            <Palette size={13} strokeWidth={2} />
          </button>
          {paletteOpen && (
            <div className="note-palette nodrag" onMouseLeave={() => setPaletteOpen(false)}>
              {(Object.keys(NOTE_COLORS) as NoteColor[]).map((k) => (
                <button
                  key={k}
                  className={`tnb-swatch ${(d.color ?? "amber") === k ? "on" : ""}`}
                  style={{ background: NOTE_COLORS[k].value }}
                  title={NOTE_COLORS[k].label}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => {
                    e.stopPropagation();
                    updateNodeData(id, { color: k });
                    setPaletteOpen(false);
                  }}
                />
              ))}
            </div>
          )}
        </div>
        <button
          className={`note-btn nodrag ${locked ? "on" : ""}`}
          title={locked ? "Destravar nota" : "Travar nota (somente leitura)"}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation();
            updateNodeData(id, { locked: !locked });
          }}
        >
          {locked ? <Lock size={13} strokeWidth={2} /> : <LockOpen size={13} strokeWidth={2} />}
        </button>
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

      {editing ? (
        <textarea
          ref={areaRef}
          className="note-body nodrag nowheel"
          value={content}
          placeholder="Escreva em markdown…"
          onChange={(e) => updateNodeData(id, { content: e.target.value })}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            // Esc sai da edição (renderiza).
            if (e.key === "Escape") {
              e.stopPropagation();
              setEditing(false);
            }
          }}
        />
      ) : (
        <div
          className="note-view nodrag nowheel"
          onDoubleClick={(e) => {
            e.stopPropagation();
            startEdit();
          }}
        >
          {content.trim() ? (
            <Markdown source={content} onChange={locked ? undefined : onContentChange} />
          ) : (
            <div className="note-empty" onClick={startEdit}>
              {locked ? "Nota vazia (travada)" : "Duplo clique para escrever…"}
            </div>
          )}
        </div>
      )}

      <Handle type="source" position={Position.Right} className="term-handle" />
    </div>
  );
}

export const NoteNode = memo(NoteNodeInner);
