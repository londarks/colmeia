// Command palette (Ctrl+K), com cmdk (MIT).
//
// Página raiz: ações, nós do canvas, canvases, criar nó, painéis e tema.
// Fluxos de 2 passos:
//   - "Perguntar a…": escolhe o terminal → digita o prompt (com prévia ao vivo) → ptySubmit.
//   - "Conectar a…": do nó selecionado até o nó escolhido.

import { useEffect, useMemo, useRef, useState } from "react";
import { Command } from "cmdk";
import type { Node } from "@xyflow/react";
import {
  ArrowRightLeft,
  Bell,
  BellOff,
  Crosshair,
  Globe,
  Keyboard,
  Layers,
  LayoutGrid,
  MessageSquareText,
  Palette,
  Redo2,
  StickyNote,
  Timer,
  Type,
  Undo2,
  Eye,
  Siren,
} from "lucide-react";
import { toast } from "sonner";
import { AGENTS, AGENT_LIST, type AgentId } from "../lib/agents";
import { ROLE_MAP } from "../lib/roles";
import { THEMES } from "../lib/theme";
import { ptySubmit, type WorkspaceMeta } from "../lib/pty";
import { readTerminalTail } from "../lib/terminalPreview";
import type { ActivityState } from "../lib/useNotifications";

export interface PaletteActions {
  focusNode: (id: string) => void;
  switchCanvas: (id: string) => void;
  addAgent: (a: AgentId) => void;
  addNote: () => void;
  addText: () => void;
  addBrowser: () => void;
  setTheme: (id: string) => void;
  toggleRoutines: () => void;
  toggleFloors: () => void;
  toggleOmbro: () => void;
  connect: (source: string, target: string) => void;
  undo: () => void;
  redo: () => void;
  frameSelection: () => void;
  nextAttention: () => void;
  showHelp: () => void;
  setOsNotifications: (on: boolean) => void;
}

interface Props {
  open: boolean;
  onClose: () => void;
  nodes: Node[];
  canvases: WorkspaceMeta[];
  activeCanvas: string;
  selectedId: string | null;
  activity: Record<string, ActivityState>;
  attentionIds: string[];
  osNotifications: boolean;
  canUndo: boolean;
  canRedo: boolean;
  actions: PaletteActions;
}

type Page =
  | { kind: "root" }
  | { kind: "ask-pick" }
  | { kind: "ask-type"; target: string }
  | { kind: "connect-pick"; source: string };

const TYPE_LABEL: Record<string, string> = {
  terminal: "terminal",
  note: "nota",
  browser: "navegador",
  text: "texto",
};

function nodeTitle(n: Node): string {
  const d = n.data as { title?: string; text?: string };
  if (n.type === "text") return (d.text || "").trim().split("\n")[0] || "Texto";
  return d.title ?? n.id;
}

function NodeIcon({ node }: { node: Node }) {
  if (node.type === "terminal") {
    const a = AGENTS[(node.data as { agent: AgentId }).agent];
    if (a) return <a.icon size={15} strokeWidth={1.8} style={{ color: a.color }} />;
  }
  if (node.type === "note") return <StickyNote size={15} strokeWidth={1.8} />;
  if (node.type === "browser") return <Globe size={15} strokeWidth={1.8} />;
  return <Type size={15} strokeWidth={1.8} />;
}

export function CommandPalette({
  open,
  onClose,
  nodes,
  canvases,
  activeCanvas,
  selectedId,
  activity,
  attentionIds,
  osNotifications,
  canUndo,
  canRedo,
  actions,
}: Props) {
  const [page, setPage] = useState<Page>({ kind: "root" });
  const [search, setSearch] = useState("");
  const [prompt, setPrompt] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const askRef = useRef<HTMLInputElement>(null);
  // Elemento focado antes de abrir (devolvemos o foco ao fechar sem ação).
  const prevFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      prevFocus.current = document.activeElement as HTMLElement | null;
      setPage({ kind: "root" });
      setSearch("");
      setPrompt("");
    }
  }, [open]);

  // Foco no campo certo a cada troca de página.
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => {
      if (page.kind === "ask-type") askRef.current?.focus();
      else inputRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(t);
  }, [open, page]);

  // Prévia ao vivo do terminal escolhido no "Perguntar a…".
  const askTarget = page.kind === "ask-type" ? page.target : null;
  useEffect(() => {
    if (!open || !askTarget) return;
    const tick = () => setPreview(readTerminalTail(askTarget, 30));
    tick();
    const iv = window.setInterval(tick, 400);
    return () => window.clearInterval(iv);
  }, [open, askTarget]);

  const terminals = useMemo(() => nodes.filter((n) => n.type === "terminal"), [nodes]);
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const attention = useMemo(() => new Set(attentionIds), [attentionIds]);

  if (!open) return null;

  const close = (restoreFocus = true) => {
    onClose();
    if (restoreFocus) {
      const el = prevFocus.current;
      window.setTimeout(() => el?.focus?.({ preventScroll: true }), 0);
    }
  };
  /** Executa uma ação e fecha a palette (sem devolver o foco: a ação decide). */
  const run = (fn: () => void) => () => {
    close(false);
    fn();
  };
  const go = (p: Page) => {
    setPage(p);
    setSearch("");
  };
  const back = () => go({ kind: "root" });

  const selected = selectedId ? byId.get(selectedId) : undefined;

  const statusBadge = (id: string) =>
    attention.has(id) ? (
      <span className="cl-badge">atenção</span>
    ) : activity[id] === "working" ? (
      <span className="cl-badge working">trabalhando</span>
    ) : null;

  const nodeItem = (n: Node, onSelect: () => void, prefix = "node") => {
    const role = (n.data as { role?: string }).role;
    const roleLabel = role ? ROLE_MAP[role]?.label : undefined;
    const title = nodeTitle(n);
    return (
      <Command.Item
        key={`${prefix}-${n.id}`}
        value={`${prefix}:${n.id}`}
        keywords={[title, TYPE_LABEL[n.type ?? ""] ?? "", roleLabel ?? ""]}
        onSelect={onSelect}
      >
        <NodeIcon node={n} />
        <span className="cl-item-label">{title}</span>
        {statusBadge(n.id)}
        <span className="cl-item-sub">
          {[roleLabel, TYPE_LABEL[n.type ?? ""]].filter(Boolean).join(" · ")}
        </span>
      </Command.Item>
    );
  };

  const sendAsk = async () => {
    if (page.kind !== "ask-type") return;
    const text = prompt.trim();
    if (!text) return;
    const target = byId.get(page.target);
    const name = target ? nodeTitle(target) : page.target;
    try {
      await ptySubmit(page.target, text);
      toast.success(`Enviado para ${name}`);
      close(true);
    } catch (e) {
      toast.error(`Falha ao enviar para ${name}`, { description: String(e) });
    }
  };

  const onKeyDownRoot = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (page.kind === "root") close();
      else if (page.kind === "ask-type") go({ kind: "ask-pick" });
      else back();
    } else if (e.key === "Backspace" && !search && page.kind !== "root") {
      e.preventDefault();
      back();
    }
  };

  const crumb =
    page.kind === "ask-pick"
      ? "Perguntar a…"
      : page.kind === "ask-type"
        ? `Perguntar a ${nodeTitle(byId.get(page.target) ?? ({ id: page.target, data: {} } as Node))}`
        : page.kind === "connect-pick"
          ? `Conectar ${nodeTitle(byId.get(page.source) ?? ({ id: page.source, data: {} } as Node))} a…`
          : null;

  return (
    <div
      className="cl-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="cl-palette" role="dialog" aria-label="Command palette">
        {page.kind === "ask-type" ? (
          <div className="cl-ask" onKeyDown={onKeyDownRoot}>
            <div className="cl-head">
              <span className="cl-crumb">{crumb}</span>
              <input
                ref={askRef}
                className="cl-ask-input"
                placeholder="Digite o prompt e Enter para enviar…"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    sendAsk();
                  } else if (e.key === "Backspace" && !prompt) {
                    e.preventDefault();
                    e.stopPropagation();
                    go({ kind: "ask-pick" });
                  }
                }}
              />
            </div>
            {preview ? (
              <pre
                className="cl-preview"
                ref={(el) => {
                  if (el) el.scrollTop = el.scrollHeight;
                }}
              >
                {preview}
              </pre>
            ) : (
              <div className="cl-preview empty">
                Prévia indisponível (terminal fora da tela ou ainda sem saída).
              </div>
            )}
            <div className="cl-foot">
              <span>
                <kbd className="cl-kbd">Enter</kbd> enviar
              </span>
              <span>
                <kbd className="cl-kbd">Esc</kbd> voltar
              </span>
            </div>
          </div>
        ) : (
          <Command loop onKeyDown={onKeyDownRoot} label="Command palette">
            <div className="cl-head">
              {crumb && <span className="cl-crumb">{crumb}</span>}
              <Command.Input
                ref={inputRef}
                value={search}
                onValueChange={setSearch}
                placeholder={
                  page.kind === "root"
                    ? "Buscar nós, canvases e comandos…"
                    : "Buscar agente…"
                }
              />
            </div>
            <Command.List>
              <Command.Empty>Nada encontrado.</Command.Empty>

              {page.kind === "root" && (
                <>
                  <Command.Group heading="Ações">
                    <Command.Item
                      value="perguntar a ask"
                      keywords={["ask", "prompt", "mensagem"]}
                      onSelect={() => go({ kind: "ask-pick" })}
                      disabled={!terminals.length}
                    >
                      <MessageSquareText size={15} strokeWidth={1.8} />
                      <span className="cl-item-label">Perguntar a…</span>
                    </Command.Item>
                    {selected && (
                      <Command.Item
                        value="conectar a connect"
                        keywords={["connect", "aresta", "ligar"]}
                        onSelect={() => go({ kind: "connect-pick", source: selected.id })}
                      >
                        <ArrowRightLeft size={15} strokeWidth={1.8} />
                        <span className="cl-item-label">Conectar {nodeTitle(selected)} a…</span>
                      </Command.Item>
                    )}
                    <Command.Item
                      value="proximo em atencao"
                      keywords={["attention", "notificação", "alerta"]}
                      onSelect={run(actions.nextAttention)}
                      disabled={!attentionIds.length}
                    >
                      <Siren size={15} strokeWidth={1.8} />
                      <span className="cl-item-label">Ir para o próximo em atenção</span>
                      {attentionIds.length > 0 && (
                        <span className="cl-badge">{attentionIds.length}</span>
                      )}
                      <kbd className="cl-kbd">Ctrl+Shift+A</kbd>
                    </Command.Item>
                    <Command.Item
                      value="enquadrar selecao"
                      keywords={["fit", "zoom", "frame"]}
                      onSelect={run(actions.frameSelection)}
                    >
                      <Crosshair size={15} strokeWidth={1.8} />
                      <span className="cl-item-label">Enquadrar seleção</span>
                      <kbd className="cl-kbd">F</kbd>
                    </Command.Item>
                    <Command.Item
                      value="desfazer"
                      keywords={["undo"]}
                      onSelect={run(actions.undo)}
                      disabled={!canUndo}
                    >
                      <Undo2 size={15} strokeWidth={1.8} />
                      <span className="cl-item-label">Desfazer</span>
                      <kbd className="cl-kbd">Ctrl+Z</kbd>
                    </Command.Item>
                    <Command.Item
                      value="refazer"
                      keywords={["redo"]}
                      onSelect={run(actions.redo)}
                      disabled={!canRedo}
                    >
                      <Redo2 size={15} strokeWidth={1.8} />
                      <span className="cl-item-label">Refazer</span>
                      <kbd className="cl-kbd">Ctrl+Shift+Z</kbd>
                    </Command.Item>
                    <Command.Item
                      value="notificacoes do sistema"
                      keywords={["notification", "alerta", "so"]}
                      onSelect={run(() => actions.setOsNotifications(!osNotifications))}
                    >
                      {osNotifications ? (
                        <BellOff size={15} strokeWidth={1.8} />
                      ) : (
                        <Bell size={15} strokeWidth={1.8} />
                      )}
                      <span className="cl-item-label">
                        {osNotifications
                          ? "Desligar notificações do sistema"
                          : "Ligar notificações do sistema"}
                      </span>
                    </Command.Item>
                    <Command.Item
                      value="atalhos de teclado"
                      keywords={["shortcuts", "ajuda", "help", "teclas"]}
                      onSelect={run(actions.showHelp)}
                    >
                      <Keyboard size={15} strokeWidth={1.8} />
                      <span className="cl-item-label">Atalhos de teclado</span>
                      <kbd className="cl-kbd">?</kbd>
                    </Command.Item>
                  </Command.Group>

                  {nodes.length > 0 && (
                    <Command.Group heading="Ir para">
                      {nodes.map((n) => nodeItem(n, run(() => actions.focusNode(n.id))))}
                    </Command.Group>
                  )}

                  {canvases.length > 1 && (
                    <Command.Group heading="Canvases">
                      {canvases
                        .filter((c) => c.id !== activeCanvas)
                        .map((c) => (
                          <Command.Item
                            key={c.id}
                            value={`canvas:${c.id}`}
                            keywords={[c.name, "canvas", "workspace"]}
                            onSelect={run(() => actions.switchCanvas(c.id))}
                          >
                            <LayoutGrid size={15} strokeWidth={1.8} />
                            <span className="cl-item-label">{c.name}</span>
                            <span className="cl-item-sub">canvas</span>
                          </Command.Item>
                        ))}
                    </Command.Group>
                  )}

                  <Command.Group heading="Criar">
                    {AGENT_LIST.map((a) => (
                      <Command.Item
                        key={a.id}
                        value={`criar:${a.id}`}
                        keywords={["novo", "criar", "agente", a.label]}
                        onSelect={run(() => actions.addAgent(a.id))}
                      >
                        <a.icon size={15} strokeWidth={1.8} style={{ color: a.color }} />
                        <span className="cl-item-label">Novo {a.label}</span>
                      </Command.Item>
                    ))}
                    <Command.Item
                      value="criar:nota"
                      keywords={["nova", "nota", "sticky"]}
                      onSelect={run(actions.addNote)}
                    >
                      <StickyNote size={15} strokeWidth={1.8} />
                      <span className="cl-item-label">Nova nota</span>
                    </Command.Item>
                    <Command.Item
                      value="criar:texto"
                      keywords={["novo", "texto"]}
                      onSelect={run(actions.addText)}
                    >
                      <Type size={15} strokeWidth={1.8} />
                      <span className="cl-item-label">Novo texto</span>
                    </Command.Item>
                    <Command.Item
                      value="criar:browser"
                      keywords={["novo", "navegador", "browser", "web"]}
                      onSelect={run(actions.addBrowser)}
                    >
                      <Globe size={15} strokeWidth={1.8} />
                      <span className="cl-item-label">Novo navegador</span>
                    </Command.Item>
                  </Command.Group>

                  <Command.Group heading="Painéis">
                    <Command.Item
                      value="painel:rotinas"
                      keywords={["rotinas", "routines", "agendar"]}
                      onSelect={run(actions.toggleRoutines)}
                    >
                      <Timer size={15} strokeWidth={1.8} />
                      <span className="cl-item-label">Rotinas</span>
                    </Command.Item>
                    <Command.Item
                      value="painel:floors"
                      keywords={["floors", "worktree"]}
                      onSelect={run(actions.toggleFloors)}
                    >
                      <Layers size={15} strokeWidth={1.8} />
                      <span className="cl-item-label">Floors</span>
                    </Command.Item>
                    <Command.Item
                      value="painel:ombro"
                      keywords={["ombro", "supervisor", "ollama"]}
                      onSelect={run(actions.toggleOmbro)}
                    >
                      <Eye size={15} strokeWidth={1.8} />
                      <span className="cl-item-label">Ombro</span>
                    </Command.Item>
                  </Command.Group>

                  <Command.Group heading="Tema">
                    {THEMES.map((t) => (
                      <Command.Item
                        key={t.id}
                        value={`tema:${t.id}`}
                        keywords={["tema", "theme", t.label]}
                        onSelect={run(() => actions.setTheme(t.id))}
                      >
                        <Palette size={15} strokeWidth={1.8} />
                        <span className="cl-item-label">Tema: {t.label}</span>
                      </Command.Item>
                    ))}
                  </Command.Group>
                </>
              )}

              {page.kind === "ask-pick" && (
                <Command.Group heading="Terminais">
                  {terminals.map((n) =>
                    nodeItem(n, () => go({ kind: "ask-type", target: n.id }), "ask"),
                  )}
                </Command.Group>
              )}

              {page.kind === "connect-pick" && (
                <Command.Group heading="Alvo">
                  {nodes
                    .filter((n) => n.id !== page.source)
                    .map((n) =>
                      nodeItem(
                        n,
                        run(() => actions.connect(page.source, n.id)),
                        "connect",
                      ),
                    )}
                </Command.Group>
              )}
            </Command.List>
            <div className="cl-foot">
              <span>
                <kbd className="cl-kbd">↑↓</kbd> navegar
              </span>
              <span>
                <kbd className="cl-kbd">Enter</kbd> escolher
              </span>
              <span>
                <kbd className="cl-kbd">Esc</kbd> {page.kind === "root" ? "fechar" : "voltar"}
              </span>
            </div>
          </Command>
        )}
      </div>
    </div>
  );
}
