// Composer: escreve um prompt com `@Agente` e `#Nota` e entrega a cada agente
// mencionado (via `ptySubmit`), com o conteúdo das notas mencionadas anexado.
// Ctrl+Enter envia · Esc fecha · "Usar seleção" menciona os nós selecionados.

import { useEffect, useMemo, useRef, useState } from "react";
import type { Node } from "@xyflow/react";
import { AtSign, Hash, Send, Users, X } from "lucide-react";
import { toast } from "sonner";
import { AGENTS, type AgentId } from "../lib/agents";
import { ptySubmit } from "../lib/pty";
import {
  activeQuery,
  buildPayload,
  findMentions,
  suggest,
  type Mentionable,
} from "../lib/mentions";

interface Props {
  nodes: Node[];
  /** Texto inicial (ex.: menções da seleção). Muda → substitui o rascunho. */
  initial: { text: string; nonce: number };
  onClose: () => void;
}

const titleOf = (n: Node) => String((n.data as { title?: string }).title ?? n.id);

/** Menções para os nós dados (terminais → @, notas → #). */
export function mentionsFor(nodes: Node[]): string {
  return nodes
    .filter((n) => n.type === "terminal" || n.type === "note")
    .map((n) => `${n.type === "note" ? "#" : "@"}${titleOf(n)}`)
    .join(" ");
}

export function Composer({ nodes, initial, onClose }: Props) {
  const [text, setText] = useState(initial.text);
  const [caret, setCaret] = useState(initial.text.length);
  const [pick, setPick] = useState(0);
  const [menuOff, setMenuOff] = useState(false);
  const [sending, setSending] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);

  // Novo pedido de abertura com texto (ex.: "perguntar sobre a seleção").
  useEffect(() => {
    setText(initial.text);
    setCaret(initial.text.length);
    requestAnimationFrame(() => {
      const el = ta.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(initial.text.length, initial.text.length);
    });
  }, [initial.nonce, initial.text]);

  const items = useMemo<Mentionable[]>(
    () =>
      nodes
        .filter((n) => n.type === "terminal" || n.type === "note")
        .map((n) => ({ id: n.id, title: titleOf(n), sym: n.type === "note" ? "#" : "@" })),
    [nodes],
  );
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  const hits = useMemo(() => findMentions(text, items), [text, items]);
  const agentIds = [...new Set(hits.filter((h) => h.sym === "@").map((h) => h.id))];
  const noteIds = [...new Set(hits.filter((h) => h.sym === "#").map((h) => h.id))];

  const q = menuOff ? null : activeQuery(text, caret);
  const options = q ? suggest(items, q.sym, q.query) : [];
  // Depois de inserir "@Nome " a busca termina em espaço e não casa mais: o menu some sozinho.
  const showMenu = !!q && options.length > 0;

  const insert = (it: Mentionable) => {
    if (!q) return;
    const before = text.slice(0, q.start);
    const after = text.slice(caret);
    const token = `${it.sym}${it.title} `;
    const next = before + token + after.replace(/^\s+/, "");
    const pos = before.length + token.length;
    setText(next);
    setCaret(pos);
    setPick(0);
    requestAnimationFrame(() => {
      ta.current?.focus();
      ta.current?.setSelectionRange(pos, pos);
    });
  };

  const addSelection = () => {
    const sel = nodes.filter((n) => n.selected);
    const m = mentionsFor(sel);
    if (!m) {
      toast.info("Selecione agentes ou notas no canvas");
      return;
    }
    const next = text.trim() ? `${m} ${text}` : `${m} `;
    setText(next);
    setCaret(next.length);
    requestAnimationFrame(() => ta.current?.focus());
  };

  const send = async () => {
    if (sending) return;
    if (!agentIds.length) {
      toast.warning("Mencione ao menos um agente com @");
      return;
    }
    if (!text.trim()) return;
    const notes = noteIds
      .map((id) => byId.get(id))
      .filter((n): n is Node => !!n)
      .map((n) => ({ title: titleOf(n), content: String((n.data as { content?: string }).content ?? "") }));
    const payload = buildPayload(text, notes);
    setSending(true);
    const results = await Promise.allSettled(agentIds.map((id) => ptySubmit(id, payload)));
    setSending(false);
    const ok = agentIds.filter((_, i) => results[i].status === "fulfilled");
    const failed = agentIds.filter((_, i) => results[i].status === "rejected");
    const names = (ids: string[]) => ids.map((id) => titleOf(byId.get(id) ?? ({ id, data: {} } as Node))).join(", ");
    if (ok.length) toast.success(`Enviado para ${names(ok)}`);
    if (failed.length) toast.error(`Não foi possível entregar a ${names(failed)}`, { description: "O terminal não tem processo ativo." });
    if (!failed.length) {
      setText("");
      setCaret(0);
      onClose();
    }
  };

  const syncCaret = () => setCaret(ta.current?.selectionStart ?? text.length);

  return (
    <div className="ux-composer" role="dialog" aria-label="Composer">
      <div className="ux-composer-head">
        <b>Composer</b>
        <span className="ux-composer-hint">
          <AtSign size={11} /> agente · <Hash size={11} /> nota · Ctrl+Enter envia · Esc fecha
        </span>
        <button className="node-icon-btn" title="Mencionar os nós selecionados" onClick={addSelection}>
          <Users size={12} strokeWidth={2} />
        </button>
        <button className="node-icon-btn" title="Fechar (Esc)" onClick={onClose}>
          <X size={12} strokeWidth={2} />
        </button>
      </div>
      <div className="ux-composer-body">
        <textarea
          ref={ta}
          className="ux-composer-input"
          value={text}
          rows={4}
          placeholder="Ex.: @Claude Code 1 revise o plano em #Plano e responda com os riscos"
          onChange={(e) => {
            setText(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            setMenuOff(false);
            setPick(0);
          }}
          onSelect={syncCaret}
          onClick={syncCaret}
          onKeyDown={(e) => {
            if (showMenu) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setPick((p) => (p + 1) % options.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setPick((p) => (p - 1 + options.length) % options.length);
                return;
              }
              if ((e.key === "Enter" && !e.ctrlKey && !e.metaKey) || e.key === "Tab") {
                e.preventDefault();
                insert(options[Math.min(pick, options.length - 1)]);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setMenuOff(true);
                return;
              }
            }
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void send();
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            }
          }}
        />
        {showMenu && (
          <div className="ux-composer-menu" role="listbox">
            {options.map((it, i) => {
              const n = byId.get(it.id);
              const agent = n?.type === "terminal" ? AGENTS[(n.data as { agent: AgentId }).agent] : undefined;
              return (
                <button
                  key={it.id}
                  role="option"
                  aria-selected={i === pick}
                  className={`ux-composer-option ${i === pick ? "active" : ""}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    insert(it);
                  }}
                >
                  {agent ? (
                    <agent.icon size={12} strokeWidth={1.9} style={{ color: agent.color }} />
                  ) : (
                    <Hash size={12} strokeWidth={1.9} />
                  )}
                  {it.title}
                </button>
              );
            })}
          </div>
        )}
      </div>
      <div className="ux-composer-foot">
        <span className="ux-composer-to">
          {agentIds.length ? (
            <>
              Para:{" "}
              {agentIds.map((id) => (
                <span key={id} className="ux-chip">
                  @{titleOf(byId.get(id)!)}
                </span>
              ))}
            </>
          ) : (
            <span className="ux-muted">Nenhum agente mencionado</span>
          )}
          {noteIds.map((id) => (
            <span key={id} className="ux-chip ux-chip-note">
              #{titleOf(byId.get(id)!)}
            </span>
          ))}
        </span>
        <button
          className="ux-composer-send"
          disabled={!agentIds.length || !text.trim() || sending}
          onClick={() => void send()}
          title="Enviar (Ctrl+Enter)"
        >
          <Send size={12} strokeWidth={2} /> Enviar
        </button>
      </div>
    </div>
  );
}
