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
import { PanelLeftClose, PanelLeft } from "lucide-react";
import logoUrl from "./assets/logo.png";
import { TerminalNode } from "./nodes/TerminalNode";
import { NoteNode } from "./nodes/NoteNode";
import { BrowserNode } from "./nodes/BrowserNode";
import { TextNode } from "./nodes/TextNode";
import { DeletableEdge } from "./components/DeletableEdge";
import { DrawLayer, type DrawTool, type Stroke } from "./components/DrawLayer";
import { Toolbar } from "./components/Toolbar";
import { RoutinesPanel } from "./components/RoutinesPanel";
import { ApprovalsPanel } from "./components/ApprovalsPanel";
import { FloorsPanel } from "./components/FloorsPanel";
import { OmbroPanel } from "./components/OmbroPanel";
import { TitleBar } from "./components/TitleBar";
import { WorkspacePanel } from "./components/WorkspacePanel";
import { AGENTS, type AgentId } from "./lib/agents";
import { ROLES, ROLE_MAP, type Role } from "./lib/roles";
import { THEMES, getStoredTheme, applyTheme } from "./lib/theme";
import {
  setGraph,
  workspacesList,
  workspaceSave,
  workspaceLoad,
  workspaceCreate,
  workspaceRename,
  workspaceDelete,
  workspaceSetActive,
  type ApprovalRequest,
  type WorkspaceMeta,
  type WorkspaceData,
  type WorkspaceIndex,
} from "./lib/pty";
import "./App.css";

let counter = 0;

export default function App() {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [theme, setTheme] = useState<string>(getStoredTheme());
  const [showRoutines, setShowRoutines] = useState(false);
  const [showFloors, setShowFloors] = useState(false);
  const [showOmbro, setShowOmbro] = useState(false);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [canvases, setCanvases] = useState<WorkspaceMeta[]>([]);
  const [activeCanvas, setActiveCanvas] = useState<string>("");
  const [tool, setTool] = useState<DrawTool>("select");
  const [drawColor, setDrawColor] = useState("#e6e9ef");
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const nodeTypes = useMemo<NodeTypes>(
    () => ({
      terminal: TerminalNode,
      note: NoteNode,
      browser: BrowserNode,
      text: TextNode,
    }),
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
  const strokesRef = useRef(strokes);
  strokesRef.current = strokes;
  const activeRef = useRef(activeCanvas);
  activeRef.current = activeCanvas;

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
      data: e.data,
    })),
    strokes: strokesRef.current,
  });

  // Aplica os dados de um canvas no estado do React Flow.
  const applyCanvas = (ws: WorkspaceData) => {
    const list = (ws.nodes as Node[]) ?? [];
    setNodes(list);
    setEdges((ws.edges as Edge[]) ?? []);
    setStrokes((ws.strokes as Stroke[]) ?? []);
    // Evita colisão de ids ao criar novos nós (mantém o contador monotônico).
    const maxN = list.reduce((m, n) => {
      const num = parseInt(String(n.id).split("-").pop() ?? "0", 10);
      return Number.isFinite(num) ? Math.max(m, num) : m;
    }, 0);
    counter = Math.max(counter, maxN);
  };

  // Carrega o índice de canvases + o canvas ativo ao iniciar.
  useEffect(() => {
    workspacesList()
      .then(async (idx) => {
        setCanvases(idx.items);
        const active = idx.active || idx.items[0]?.id || "";
        activeRef.current = active;
        setActiveCanvas(active);
        if (active) applyCanvas(await workspaceLoad(active));
      })
      .catch(() => {})
      .finally(() => {
        readyRef.current = true;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-salva (debounced) o canvas ativo a cada mudança.
  useEffect(() => {
    if (!readyRef.current || !activeRef.current) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      workspaceSave(activeRef.current, buildWorkspace()).catch(() => {});
    }, 800);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, strokes]);

  // Salva o canvas atual antes de sair dele (usado ao trocar/criar).
  const flushActive = async () => {
    window.clearTimeout(saveTimer.current);
    if (activeRef.current) {
      try {
        await workspaceSave(activeRef.current, buildWorkspace());
      } catch {
        /* ignora */
      }
    }
  };

  const switchCanvas = async (id: string) => {
    if (id === activeRef.current) return;
    await flushActive();
    let ws: WorkspaceData;
    try {
      ws = await workspaceLoad(id);
    } catch {
      return;
    }
    activeRef.current = id;
    setActiveCanvas(id);
    applyCanvas(ws);
    workspaceSetActive(id).catch(() => {});
  };

  const newCanvas = async () => {
    await flushActive();
    const idx = await workspaceCreate("");
    setCanvases(idx.items);
    activeRef.current = idx.active;
    setActiveCanvas(idx.active);
    applyCanvas({ nodes: [], edges: [], strokes: [] });
  };

  const removeCanvas = async (id: string) => {
    const idx = await workspaceDelete(id);
    setCanvases(idx.items);
    if (activeRef.current === id && !idx.items.some((c) => c.id === id)) {
      activeRef.current = idx.active;
      setActiveCanvas(idx.active);
      applyCanvas(await workspaceLoad(idx.active));
    }
  };

  // Remoção em lote (multi-seleção / cascata de pasta). Mantém a garantia de
  // ≥1 workspace: se a seleção cobrir todos, aborta sem apagar nada.
  const removeCanvases = async (ids: string[]) => {
    const toDelete = new Set(ids);
    // Filtra todos os canvas a serem removidos da lista de canvas.
    const survivors = canvases.filter((c) => !toDelete.has(c.id));
    if (survivors.length === 0) return; // não deixa o app sem nenhum canvas
    // Se o ativo está no lote, muda para um sobrevivente antes de apagar.
    if (toDelete.has(activeRef.current)) {
      const next = survivors[0].id;
      let ws: WorkspaceData | null = null;
      try {
        ws = await workspaceLoad(next);
      } catch(e) {
        console.error("Erro ao carregar workflow pós-deleção!");
      }
      activeRef.current = next;
      setActiveCanvas(next);
      applyCanvas(ws ?? { nodes: [], edges: [], strokes: [] });
      workspaceSetActive(next).catch(() => {});
    }
    let idx: WorkspaceIndex | null = null;
    for (const id of ids) {
      try {
        idx = await workspaceDelete(id);
      } catch(e) {
        console.error(`Erro ao deletar workflow com id ${id}!`);
        break; // Cancelar deleção dos próximos porque ocorreu um erro.
      }
    }
    if (idx) setCanvases(idx.items);
  };

  const commitRename = async (id: string, name: string) => {
    const idx = await workspaceRename(id, name);
    setCanvases(idx.items);
  };


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
    (title: string, content: string, connectToId?: string) => {
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
      // Conecta a nota ao nó indicado (para cair no `colmeia context` dele).
      if (connectToId && nodesRef.current.some((n) => n.id === connectToId)) {
        setEdges((eds) =>
          addEdge(
            {
              id: `e-${connectToId}-${id}`,
              source: connectToId,
              target: id,
              animated: true,
            },
            eds,
          ),
        );
      }
    },
    [setNodes, setEdges],
  );

  const addTextNode = useCallback(() => {
    counter += 1;
    const id = `text-${counter}`;
    const offset = (counter % 5) * 42;
    setNodes((nds) =>
      nds.concat({
        id,
        type: "text",
        position: { x: 240 + offset, y: 200 + offset },
        data: { text: "", color: "#e6e9ef", fontSize: 22 },
        style: { width: 220, height: 60 },
      }),
    );
  }, [setNodes]);

  const addBrowserNode = useCallback(
    (url?: string) => {
      counter += 1;
      const id = `browser-${counter}`;
      const offset = (counter % 5) * 42;
      setNodes((nds) =>
        nds.concat({
          id,
          type: "browser",
          position: { x: 220 + offset, y: 180 + offset },
          data: { title: "Browser", url },
          style: { width: 560, height: 420 },
        }),
      );
    },
    [setNodes],
  );

  // Abre/atualiza um browser conectado ao agente (via `colmeia browse`).
  const onBrowse = useCallback(
    (url: string, sourceId: string) => {
      const connected = edgesRef.current
        .filter((e) => e.source === sourceId || e.target === sourceId)
        .map((e) => (e.source === sourceId ? e.target : e.source));
      const existing = nodesRef.current.find(
        (n) => n.type === "browser" && connected.includes(n.id),
      );
      if (existing) {
        setNodes((nds) =>
          nds.map((n) =>
            n.id === existing.id ? { ...n, data: { ...n.data, url } } : n,
          ),
        );
        return;
      }
      counter += 1;
      const id = `browser-${counter}`;
      const offset = (counter % 5) * 42;
      setNodes((nds) =>
        nds.concat({
          id,
          type: "browser",
          position: { x: 220 + offset, y: 180 + offset },
          data: { title: "Browser", url },
          style: { width: 560, height: 420 },
        }),
      );
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

  // Roteia um click/type para o browser node conectado ao agente.
  const cmdNonce = useRef(0);
  const onWebviewAction = useCallback(
    (action: string, selector: string, text: string, sourceId: string) => {
      const connected = edgesRef.current
        .filter((e) => e.source === sourceId || e.target === sourceId)
        .map((e) => (e.source === sourceId ? e.target : e.source));
      const bn = nodesRef.current.find(
        (n) => n.type === "browser" && connected.includes(n.id),
      );
      if (!bn) return;
      cmdNonce.current += 1;
      const n = cmdNonce.current;
      setNodes((nds) =>
        nds.map((x) =>
          x.id === bn.id
            ? { ...x, data: { ...x.data, command: { action, selector, text, n } } }
            : x,
        ),
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
      const name = (arg1 || "").trim();
      const roleStr = (arg2 || "").trim();
      const cands = [name, roleStr].map((s) => s.toLowerCase()).filter(Boolean);
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
      // Papel vem do 2º argumento; se ausente, tenta inferir do nome (compat: recruit "Testador").
      let role: Role | undefined = matchRole(roleStr.toLowerCase());
      if (!role && !roleStr) role = matchRole(name.toLowerCase());
      // Herda a pasta de trabalho do recrutador (toda a força-tarefa na mesma pasta).
      const cwd = (
        nodesRef.current.find((n) => n.id === sourceId)?.data as {
          cwd?: string;
        }
      )?.cwd;
      counter += 1;
      const id = `${agentId}-${counter}`;
      const offset = (counter % 5) * 42;
      // O nome vira o título — a menos que seja só uma palavra-chave (runtime, ou o
      // papel inferido do próprio nome), caso em que cai no rótulo auto-numerado.
      const nameLower = name.toLowerCase();
      const nameIsKeyword =
        AGENT_IDS.includes(nameLower as AgentId) ||
        (!roleStr && !!matchRole(nameLower));
      setNodes((nds) => {
        const sameKind = nds.filter(
          (n) => (n.data as { agent?: AgentId }).agent === agentId,
        ).length;
        const title =
          name && !nameIsKeyword
            ? name
            : `${AGENTS[agentId].label} ${sameKind + 1}`;
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
      listen<{ title: string; content: string; source: string; target: string }>(
        "colmeia://add-note",
        (e) => {
          const { title, content, source, target } = e.payload;
          // Destino: o agente indicado (por título), senão o próprio criador.
          let connectId: string | undefined = source || undefined;
          if (target) {
            const t = nodesRef.current.find(
              (n) =>
                n.type === "terminal" &&
                ((n.data as { title?: string }).title ?? n.id).toLowerCase() ===
                  target.toLowerCase(),
            );
            if (t) connectId = t.id;
          }
          addNoteNode(title, content, connectId);
        },
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
      listen<{ url: string; source: string }>("colmeia://browse", (e) =>
        onBrowse(e.payload.url, e.payload.source),
      ),
      listen<{ action: string; selector: string; text: string; source: string }>(
        "colmeia://webview-action",
        (e) =>
          onWebviewAction(
            e.payload.action,
            e.payload.selector,
            e.payload.text,
            e.payload.source,
          ),
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
  }, [
    addNoteNode,
    connectByTitle,
    highlightEdge,
    recruitAgent,
    dismissAgent,
    onBrowse,
    onWebviewAction,
  ]);

  const nodeColor = useCallback(
    (n: Node) =>
      n.type === "note"
        ? "#f59e0b"
        : n.type === "browser"
          ? "#38bdf8"
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

  // Atribui um floor (worktree) ao terminal selecionado → reinicia o agente nele.
  const assignFloor = (path: string) => {
    const sid = selectedTerminal?.id;
    if (!sid) return;
    setNodes((nds) =>
      nds.map((n) =>
        n.id === sid ? { ...n, data: { ...n.data, cwd: path } } : n,
      ),
    );
  };

  return (
    <div className="app">
      <TitleBar />
      <div className="workspace">
        {sidebarOpen && (
        <aside className="sidebar">
          <div className="side-topbar">
            <button
              className="side-collapse"
              onClick={() => setSidebarOpen(false)}
              title="Esconder menu"
            >
              <PanelLeftClose size={16} strokeWidth={1.9} />
            </button>
          </div>

          <WorkspacePanel
            items={canvases}
            active={activeCanvas}
            onSwitch={switchCanvas}
            onCreate={newCanvas}
            onRename={commitRename}
            onDelete={removeCanvas}
            onDeleteMany={removeCanvases}
          />
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
        )}

      <main className="canvas">
        {!sidebarOpen && (
          <button
            className="sidebar-reopen"
            onClick={() => setSidebarOpen(true)}
            title="Mostrar menu"
          >
            <PanelLeft size={16} strokeWidth={1.9} />
          </button>
        )}
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
          panOnDrag={tool === "select"}
          nodesDraggable={tool === "select"}
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
          <DrawLayer
            tool={tool}
            color={drawColor}
            strokes={strokes}
            setStrokes={setStrokes}
          />
        </ReactFlow>

        <Toolbar
          tool={tool}
          setTool={setTool}
          color={drawColor}
          setColor={setDrawColor}
          onClear={() => setStrokes([])}
          onAddAgent={addNode}
          onAddNote={() => addNoteNode("Nota", "")}
          onAddText={addTextNode}
          onAddBrowser={() => addBrowserNode()}
          showRoutines={showRoutines}
          setShowRoutines={setShowRoutines}
          showFloors={showFloors}
          setShowFloors={setShowFloors}
          showOmbro={showOmbro}
          setShowOmbro={setShowOmbro}
        />

        {showRoutines && (
          <RoutinesPanel
            terminals={terminals}
            defaultTarget={selectedTerminalTitle}
            onClose={() => setShowRoutines(false)}
          />
        )}

        {showFloors && (
          <FloorsPanel
            selectedTitle={selectedTerminalTitle}
            onAssign={assignFloor}
            onClose={() => setShowFloors(false)}
          />
        )}

        {showOmbro && <OmbroPanel onClose={() => setShowOmbro(false)} />}

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
