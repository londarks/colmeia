import { memo, useState } from "react";
import { Handle, NodeResizer, Position, useReactFlow, type NodeProps } from "@xyflow/react";
import { Palette, Ungroup, Users } from "lucide-react";
import { NOTE_COLORS, noteColorValue, type NoteColor } from "../lib/noteColors";

export interface GroupNodeData {
  title: string;
  /** Mesma paleta das notas (tokens do tema). */
  color?: NoteColor;
  /** Band: equipe todos-com-todos (cada membro alcança os outros e o que liga ao grupo). */
  band?: boolean;
}

/** Evento para o hook de grupos desfazer este grupo (mantém os filhos). */
export const UNGROUP_EVENT = "colmeia:ungroup";
/** Evento para ligar/desligar a band deste grupo (tratado em hooks/useNodeActions). */
export const BAND_TOGGLE_EVENT = "colmeia:band-toggle";

function GroupNodeInner({ id, data, selected }: NodeProps) {
  const d = data as unknown as GroupNodeData;
  const { updateNodeData } = useReactFlow();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const color = noteColorValue(d.color, "accent");

  return (
    <div
      className={`group-node ${selected ? "is-selected" : ""} ${d.band ? "is-band" : ""}`}
      style={{ ["--agent" as string]: color } as React.CSSProperties}
    >
      <NodeResizer
        minWidth={160}
        minHeight={100}
        isVisible={!!selected}
        color={color}
        handleClassName="term-resize-handle"
        lineClassName="term-resize-line"
      />
      {/* Só a band conecta (uma aresta para a band alcança todos os membros). */}
      {d.band && <Handle type="target" position={Position.Left} className="term-handle" />}
      <div className="group-header">
        <input
          className="group-title nodrag"
          value={d.title ?? ""}
          placeholder="Grupo"
          onChange={(e) => updateNodeData(id, { title: e.target.value })}
        />
        {(selected || d.band) && (
          <button
            className={`note-btn nodrag group-band-btn ${d.band ? "on" : ""}`}
            title={
              d.band
                ? "Band ligada: todos os membros se enxergam — clique para desligar"
                : "Tornar band (equipe todos-com-todos)"
            }
            onClick={(e) => {
              e.stopPropagation();
              window.dispatchEvent(new CustomEvent(BAND_TOGGLE_EVENT, { detail: { id } }));
            }}
          >
            <Users size={13} strokeWidth={2} />
            {d.band && <span className="group-band-label">band</span>}
          </button>
        )}
        {selected && (
          <>
            <div className="note-palette-wrap">
              <button
                className={`note-btn nodrag ${paletteOpen ? "on" : ""}`}
                title="Cor do grupo"
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
                      className={`tnb-swatch ${(d.color ?? "accent") === k ? "on" : ""}`}
                      style={{ background: NOTE_COLORS[k].value }}
                      title={NOTE_COLORS[k].label}
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
              className="note-btn nodrag"
              title="Desagrupar (Ctrl+Shift+G)"
              onClick={(e) => {
                e.stopPropagation();
                window.dispatchEvent(new CustomEvent(UNGROUP_EVENT, { detail: { id } }));
              }}
            >
              <Ungroup size={13} strokeWidth={2} />
            </button>
          </>
        )}
      </div>
      {d.band && <Handle type="source" position={Position.Right} className="term-handle" />}
    </div>
  );
}

export const GroupNode = memo(GroupNodeInner);
