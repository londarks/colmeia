import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type Connection,
  type NodeTypes,
} from "@xyflow/react";
import { listen } from "@tauri-apps/api/event";
import { StickyNote, Timer } from "lucide-react";
import logoUrl from "./assets/logo.png";
import { TerminalNode } from "./nodes/TerminalNode";
import { NoteNode } from "./nodes/NoteNode";
import { DeletableEdge } from "./components/DeletableEdge";
import { RoutinesPanel } from "./components/RoutinesPanel";
import { ApprovalsPanel } from "./components/ApprovalsPanel";
import { TitleBar } from "./components/TitleBar";
import { AGENTS, AGENT_LIST, type AgentId } from "./lib/agents";
import { ROLES, ROLE_MAP, type Role } from "./lib/roles";
import { THEMES, getStoredTheme, applyTheme } from "./lib/theme";
import {
  setGraph,
  workspaceSave,
  workspaceLoad,
  type ApprovalRequest,
} from "./lib/pty";
import "./App.css";

let counter = 0;

export default function App() {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [theme, setTheme] = useState<string>(getStoredTheme());
  const [showRoutines, setShowRoutines] = useState(false);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const nodeTypes = useMemo<NodeTypes>(
    () => ({ terminal: TerminalNode, note: NoteNode }),
    [],
  );
  const edgeTypes = useMemo(() => ({ default: DeletableEdge }), []);

  const terminals = nodes
    .filter((n) => n.type === "terminal")
    .map((n) => ({
      id: n.id,
      title: (n.data as { title?: string }).title ?? n.id,
    }));

  // Referências sempre atualizadas, para usar em callbacks/timers.
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const edgesRef = useRef(edges);
  edgesRef.current = edges;

  // Persistência: só salva depois do carregamento inicial (evita salvar vazio).
  const readyRef = useRef(false);
  const saveTimer = useRef<number | undefined>(undefined);

  const buildWorkspace = () => ({
    nodes: nodesRef.current.map((n) => ({
      id: n.id,
      type: n.type,
      position: n.position,
      data: n.data,
      style: n.style,
    })),
    edges: edgesRef.current.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      animated: true,
    })),
  });

  // Carrega o workspace salvo ao iniciar.
  useEffect(() => {
    workspaceLoad()
      .then((ws) => {
        if (ws && Array.isArray(ws.nodes)) {
          setNodes(ws.nodes as Node[]);
          setEdges((ws.edges as Edge[]) ?? []);
          // Evita colisão de ids ao criar novos nós.
          const maxN = (ws.nodes as Node[]).reduce((m, n) => {
            const num = parseInt(String(n.id).split("-").pop() ?? "0", 10);
            return Number.isFinite(num) ? Math.max(m, num) : m;
          }, 0);
          counter = Math.max(counter, maxN);
        }
      })
      .catch(() => {})
      .finally(() => {
        readyRef.current = true;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-salva (debounced) a cada mudança, depois do carregamento inicial.
  useEffect(() => {
    if (!readyRef.current) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      workspaceSave(buildWorkspace()).catch(() => {});
    }, 800);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges]);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Espelha o grafo no backend sempre que nós/arestas mudam (escopo do roteamento).
  useEffect(() => {
    const graphNodes = nodes.map((n) => {
      const d = n.data as {
        title?: string;
        role?: string;
        content?: string;
        cwd?: string;
        autoApproveInCwd?: boolean;
      };
      return {
        id: n.id,
        type: n.type ?? "terminal",
        title: d.title ?? n.id,
        role: d.role ? (ROLE_MAP[d.role]?.label ?? "") : "",
        roleBriefing: d.role ? (ROLE_MAP[d.role]?.briefing ?? "") : "",
        content: d.content ?? "",
        cwd: d.cwd ?? "",
        autoApproveInCwd: !!d.autoApproveInCwd,
      };
    });
    const graphEdges = edges.map((e) => ({ source: e.source, target: e.target }));
    setGraph(graphNodes, graphEdges).catch(() => {});
  }, [nodes, edges]);

  const onConnect = useCallback(
    (c: Connection) => setEdges((eds) => addEdge({ ...c, animated: true }, eds)),
    [setEdges],
  );

  const addNode = useCallback(
    (agent: AgentId) => {
      counter += 1;
      const id = `${agent}-${counter}`;
      const offset = (counter % 5) * 42;
      setNodes((nds) => {
        // Título humano único por tipo: "Claude Code 1", "Shell 2"...
        const sameKind = nds.filter(
          (n) => (n.data as { agent?: AgentId }).agent === agent,
        ).length;
        const title = `${AGENTS[agent].label} ${sameKind + 1}`;
        return nds.concat({
          id,
          type: "terminal",
          position: { x: 140 + offset, y: 110 + offset },
          data: { agent, title },
          style: { width: 500, height: 340 },
        });
      });
    },
    [setNodes],
  );

  const addNoteNode = useCallback(
    (title: string, content: string) => {
      counter += 1;
      const id = `note-${counter}`;
      const offset = (counter % 5) * 42;
      setNodes((nds) =>
        nds.concat({
          id,
          type: "note",
          position: { x: 200 + offset, y: 160 + offset },
          data: { title: title || "Nota", content: content || "" },
          style: { width: 280, height: 200 },
        }),
      );
    },
    [setNodes],
  );

  // Conecta dois nós resolvendo-os pelo título (usado por `colmeia connect`).
  const connectByTitle = useCallback(
    (source: string, target: string) => {
      const byTitle = (t: string) =>
        nodesRef.current.find(
          (n) =>
            ((n.data as { title?: string }).title ?? n.id).toLowerCase() ===
            t.toLowerCase(),
        );
      const a = byTitle(source);
      const b = byTitle(target);
      if (a && b && a.id !== b.id) {
        setEdges((eds) =>
          addEdge(
            { id: `e-${a.id}-${b.id}`, source: a.id, target: b.id, animated: true },
            eds,
          ),
        );
      }
    },
    [setEdges],
  );

  // Acende a aresta entre dois nós quando um agente interage com o outro.
  const edgeTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const highlightEdge = useCallback(
    (source: string, target: string) => {
      let matchedId: string | null = null;
      setEdges((eds) =>
        eds.map((e) => {
          const match =
            (e.source === source && e.target === target) ||
            (e.source === target && e.target === source);
          if (match) {
            matchedId = e.id;
            return { ...e, data: { ...e.data, active: true } };
          }
          return e;
        }),
      );
      if (matchedId) {
        const eid = matchedId;
        clearTimeout(edgeTimers.current[eid]);
        edgeTimers.current[eid] = setTimeout(() => {
          setEdges((eds) =>
            eds.map((e) =>
              e.id === eid ? { ...e, data: { ...e.data, active: false } } : e,
            ),
          );
        }, 1600);
      }
    },
    [setEdges],
  );

  // Recruta um novo agente (via `colmeia recruit`), já conectado ao recrutador.
  // Tolerante: descobre o runtime (claude por padrão) e o papel por aproximação,
  // aceitando os argumentos em qualquer ordem.
  const recruitAgent = useCallback(
    (arg1: string, arg2: string, sourceId: string) => {
      const cands = [arg1, arg2]
        .map((s) => (s || "").toLowerCase().trim())
        .filter(Boolean);
      const AGENT_IDS: AgentId[] = ["shell", "claude", "codex", "ollama"];
      const agentId =
        (cands.find((c) => AGENT_IDS.includes(c as AgentId)) as AgentId) ||
        "claude";
      // Papel por aproximação (ex.: "engenheiro-software" → Engenheiro).
      const matchRole = (s: string) =>
        ROLES.find((r) => {
          const label = r.label.toLowerCase();
          return (
            r.id === s ||
            label === s ||
            (s.length >= 4 &&
              (s.includes(label) || label.includes(s) || s.includes(r.id)))
          );
        });
      let role: Role | undefined;
      for (const c of cands) {
        role = matchRole(c);
        if (role) break;
      }
      // Herda a pasta de trabalho do recrutador (toda a força-tarefa na mesma pasta).
      const cwd = (
        nodesRef.current.find((n) => n.id === sourceId)?.data as {
          cwd?: string;
        }
      )?.cwd;
      counter += 1;
      const id = `${agentId}-${counter}`;
      const offset = (counter % 5) * 42;
      setNodes((nds) => {
        const sameKind = nds.filter(
          (n) => (n.data as { agent?: AgentId }).agent === agentId,
        ).length;
        const title = `${AGENTS[agentId].label} ${sameKind + 1}`;
        return nds.concat({
          id,
          type: "terminal",
          position: { x: 160 + offset, y: 130 + offset },
          data: { agent: agentId, title, role: role?.id, cwd },
          style: { width: 500, height: 340 },
        });
      });
      if (sourceId) {
        setEdges((eds) =>
          addEdge(
            { id: `e-${sourceId}-${id}`, source: sourceId, target: id, animated: true },
            eds,
          ),
        );
      }
    },
    [setNodes, setEdges],
  );

  // Dispensa (remove) um agente pelo título (via `colmeia dismiss`).
  const dismissAgent = useCallback(
    (title: string) => {
      const node = nodesRef.current.find(
        (n) =>
          n.type === "terminal" &&
          ((n.data as { title?: string }).title ?? n.id).toLowerCase() ===
            title.toLowerCase(),
      );
      if (node) {
        setNodes((nds) => nds.filter((n) => n.id !== node.id));
        setEdges((eds) =>
          eds.filter((e) => e.source !== node.id && e.target !== node.id),
        );
      }
    },
    [setNodes, setEdges],
  );

  // Sincroniza o status "aguardando aprovação" nos nós que têm aprovação pendente.
  useEffect(() => {
    const waitingIds = new Set(approvals.map((a) => a.node));
    setNodes((nds) =>
      nds.map((n) => {
        const w = waitingIds.has(n.id);
        if (Boolean((n.data as { waiting?: boolean }).waiting) === w) return n;
        return { ...n, data: { ...n.data, waiting: w } };
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approvals]);

  // Ouve pedidos do backend (agente rodando `colmeia note` / `connect` / interações).
  useEffect(() => {
    const subs = [
      listen<{ title: string; content: string }>("colmeia://add-note", (e) =>
        addNoteNode(e.payload.title, e.payload.content),
      ),
      listen<{ source: string; target: string }>("colmeia://connect", (e) =>
        connectByTitle(e.payload.source, e.payload.target),
      ),
      listen<{ agent: string; role: string; source: string }>(
        "colmeia://recruit",
        (e) => recruitAgent(e.payload.agent, e.payload.role, e.payload.source),
      ),
      listen<{ title: string }>("colmeia://dismiss", (e) =>
        dismissAgent(e.payload.title),
      ),
      listen<{ source: string; target: string }>("colmeia://interaction", (e) =>
        highlightEdge(e.payload.source, e.payload.target),
      ),
      listen<ApprovalRequest>("colmeia://approval-request", (e) =>
        setApprovals((prev) => [...prev, e.payload]),
      ),
      listen<{ id: string }>("colmeia://approval-resolved", (e) =>
        setApprovals((prev) => prev.filter((a) => a.id !== e.payload.id)),
      ),
    ];
    return () => {
      subs.forEach((p) => p.then((un) => un()));
    };
  }, [addNoteNode, connectByTitle, highlightEdge, recruitAgent, dismissAgent]);

  const nodeColor = useCallback(
    (n: Node) =>
      n.type === "note"
        ? "#f59e0b"
        : AGENTS[(n.data as { agent: AgentId }).agent]?.color ?? "#666",
    [],
  );

  // Terminal atualmente selecionado no canvas — alvo padrão de novas rotinas.
  const selectedTerminal = nodes.find(
    (n) => n.type === "terminal" && n.selected,
  );
  const selectedTerminalTitle = selectedTerminal
    ? ((selectedTerminal.data as { title?: string }).title ??
      selectedTerminal.id)
    : "";

  return (
    <div className="app">
      <TitleBar />
      <div className="workspace">
        <aside className="sidebar">
          <div className="side-section">
            <div className="side-label">Adicionar</div>
          <div className="side-actions">
            {AGENT_LIST.map((a) => (
              <button
                key={a.id}
                className="side-btn"
                style={{ ["--c" as string]: a.color } as React.CSSProperties}
                onClick={() => addNode(a.id)}
                title={`Adicionar ${a.label}`}
              >
                <span className="side-dot" />
                <a.icon className="side-icon" size={16} strokeWidth={1.75} />
                <span className="side-btn-label">{a.label}</span>
              </button>
            ))}
            <button
              className="side-btn"
              style={{ ["--c" as string]: "#f59e0b" } as React.CSSProperties}
              onClick={() => addNoteNode("Nota", "")}
              title="Adicionar nota"
            >
              <span className="side-dot" />
              <StickyNote className="side-icon" size={16} strokeWidth={1.75} />
              <span className="side-btn-label">Nota</span>
            </button>
          </div>
        </div>

        <div className="side-section">
          <div className="side-label">Ferramentas</div>
          <button
            className={`side-btn tool ${showRoutines ? "is-active" : ""}`}
            style={{ ["--c" as string]: "var(--accent)" } as React.CSSProperties}
            onClick={() => setShowRoutines((v) => !v)}
            title="Rotinas (tarefas agendadas)"
          >
            <Timer className="side-icon" size={16} strokeWidth={1.75} />
            <span className="side-btn-label">Rotinas</span>
          </button>
        </div>

        <div className="side-spacer" />

        <div className="side-section">
          <div className="side-label">Tema</div>
          <label className="theme-picker" title="Tema">
            <span className="theme-swatch" />
            <select value={theme} onChange={(e) => setTheme(e.target.value)}>
              {THEMES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </aside>

      <main className="canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          deleteKeyCode={["Delete"]}
          connectionRadius={48}
          fitView
          fitViewOptions={{ minZoom: 1, maxZoom: 1 }}
          minZoom={0.2}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
          defaultEdgeOptions={{
            animated: true,
            style: { stroke: "var(--accent)", strokeWidth: 2 },
          }}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={24}
            size={1}
            color="var(--border)"
          />
          <MiniMap
            className="minimap"
            pannable
            zoomable
            nodeColor={nodeColor}
            nodeStrokeWidth={0}
            maskColor="rgba(0, 0, 0, 0.55)"
          />
          <Controls className="controls" showInteractive={false} />
        </ReactFlow>

        {showRoutines && (
          <RoutinesPanel
            terminals={terminals}
            defaultTarget={selectedTerminalTitle}
            onClose={() => setShowRoutines(false)}
          />
        )}

        <ApprovalsPanel
          approvals={approvals}
          onResolved={(id) =>
            setApprovals((prev) => prev.filter((a) => a.id !== id))
          }
        />

        {nodes.length === 0 && (
          <div className="empty">
            <img src={logoUrl} className="empty-logo" alt="" />
            <h2>Canvas vazio</h2>
            <p>
              Adicione um agente na barra à esquerda. Cada nó é um{" "}
              <b>terminal real</b>, rodando um shell ou uma CLI de agente de verdade.
            </p>
          </div>
        )}
        </main>
      </div>
    </div>
  );
}
