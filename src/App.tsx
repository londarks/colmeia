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
import { portalClose } from "./lib/portal";
import { TextNode } from "./nodes/TextNode";
import { ImageNode } from "./nodes/ImageNode";
import { GroupNode } from "./nodes/GroupNode";
import { DeletableEdge } from "./components/DeletableEdge";
import { DrawLayer, type DrawTool, type Stroke } from "./components/DrawLayer";
import { Toolbar } from "./components/Toolbar";
import { RoutinesPanel } from "./components/RoutinesPanel";
import { ApprovalsPanel } from "./components/ApprovalsPanel";
import { FloorsPanel } from "./components/FloorsPanel";
import { OmbroPanel } from "./components/OmbroPanel";
import { TitleBar } from "./components/TitleBar";
import { StatusBar } from "./components/StatusBar";
import { WorkspacePanel } from "./components/WorkspacePanel";
import { LiftOverlay } from "./components/LiftOverlay";
import {
  setActiveCanvas as setTerminalCanvas,
  disposeTerminal,
  disposeCanvas as disposeCanvasTerminals,
} from "./lib/terminalRegistry";
import { PartiturasPanel } from "./components/PartiturasPanel";
import { usePartituras } from "./hooks/usePartituras";
import { useClipboard } from "./hooks/useClipboard";
import { useFileDrop } from "./hooks/useFileDrop";
import { useGrouping } from "./hooks/useGrouping";
import { useCanvasUx } from "./hooks/useCanvasUx";
import { withNodeErrorBoundary } from "./components/NodeErrorBoundary";
import type { CanvasApi } from "./lib/canvas";
import { AGENTS, AGENT_LIST, type AgentId } from "./lib/agents";
import { ROLES, loadRoles, type Role } from "./lib/roles";
import { getStoredTheme, applyTheme } from "./lib/theme";
import { useCanvasControls } from "./lib/useCanvasControls";
import {
  setGraph,
  setPresets,
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

let counter = 0;

/** Mantém o contador de ids acima de todos os ids existentes (evita ids repetidos). */
function bumpCounter(list: Node[]) {
  const maxN = list.reduce((m, n) => {
    const num = parseInt(String(n.id).split("-").pop() ?? "0", 10);
    return Number.isFinite(num) ? Math.max(m, num) : m;
  }, 0);
  counter = Math.max(counter, maxN);
}

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
  // Papéis (built-ins + do usuário), vindos do backend.
  const [roleList, setRoleList] = useState<Role[]>(ROLES);
  const roleMap = useMemo(
    () => Object.fromEntries(roleList.map((r) => [r.id, r])) as Record<string, Role>,
    [roleList],
  );
  const nodeTypes = useMemo<NodeTypes>(
    () =>
      // Error boundary por nó: um nó que quebra não derruba o canvas.
      withNodeErrorBoundary({
        terminal: TerminalNode,
        note: NoteNode,
        browser: BrowserNode,
        text: TextNode,
        image: ImageNode,
        group: GroupNode,
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
  // Terminais criados neste render pertencem ao canvas ativo (escopo do scrollback).
  // Fica no corpo do render porque os efeitos dos nós rodam antes dos efeitos do App.
  setTerminalCanvas(activeCanvas);

  // Palette (Ctrl+K), atalhos, modo connect, notificações, undo/redo e câmera.
  // As ações são lambdas porque as funções abaixo ainda não foram declaradas.
  const controls = useCanvasControls({
    nodes,
    edges,
    strokes,
    setNodes,
    setEdges,
    setStrokes,
    canvases,
    activeCanvas,
    actions: {
      switchCanvas: (id) => void switchCanvas(id),
      addAgent: (a) => addNode(a),
      addNote: () => addNoteNode("Nota", ""),
      addText: () => addTextNode(),
      addBrowser: () => addBrowserNode(),
      setTheme,
      toggleRoutines: () => setShowRoutines((v) => !v),
      toggleFloors: () => setShowFloors((v) => !v),
      toggleOmbro: () => setShowOmbro((v) => !v),
    },
  });

  // Partituras, copiar/colar, drop de arquivos e grupos (lógica nos hooks).
  const canvasApi = useMemo<CanvasApi>(
    () => ({ nodesRef, edgesRef, setNodes, setEdges }),
    [setNodes, setEdges],
  );
  const partituras = usePartituras(canvasApi);
  useClipboard(canvasApi);
  useFileDrop(canvasApi, { onPartitura: partituras.reviewImport });
  const grouping = useGrouping(canvasApi);
  // Menu de contexto, grade/guias, alinhar/tidy, Dock, Composer e validação de conexões.
  const ux = useCanvasUx({
    api: canvasApi,
    nodes: controls.nodes,
    grouping,
    focusNode: controls.focusNode,
  });

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
      ...(n.parentId ? { parentId: n.parentId } : {}),
    })),
    edges: edgesRef.current.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      animated: true,
      data: e.data,
    })),
    strokes: strokesRef.current,
    viewport: controls.camera.getViewport(),
  });

  // Aplica os dados de um canvas no estado do React Flow.
  const applyCanvas = (ws: WorkspaceData) => {
    const list = (ws.nodes as Node[]) ?? [];
    setNodes(list);
    setEdges((ws.edges as Edge[]) ?? []);
    setStrokes((ws.strokes as Stroke[]) ?? []);
    // Novo canvas: histórico limpo + câmera salva dele.
    controls.history.reset();
    controls.camera.restoreViewport(ws.viewport);
    // Evita colisão de ids ao criar novos nós (mantém o contador monotônico).
    bumpCounter(list);
  };

  // Exclusão de canvas: mata os terminais dele (ids lidos do workspace salvo + os que o
  // registry conhece) e apaga o scrollback. Trocar de canvas NÃO mata nada.
  const killCanvasTerminals = async (id: string) => {
    let ids: string[] = [];
    try {
      const ws = await workspaceLoad(id);
      ids = ((ws.nodes as Node[]) ?? [])
        .filter((n) => n.type === "terminal")
        .map((n) => n.id);
    } catch {
      /* sem arquivo: só o que o registry conhece */
    }
    await disposeCanvasTerminals(id, ids);
  };

  // Carrega o índice de canvases + o canvas ativo ao iniciar.
  useEffect(() => {
    workspacesList()
      .then(async (idx) => {
        setCanvases(idx.items);
        const active = idx.active || idx.items[0]?.id || "";
        activeRef.current = active;
        setActiveCanvas(active);
        // Os terminais de todos os canvases ficam vivos ao mesmo tempo: o contador de ids
        // precisa ser global, senão dois canvases podem gerar o mesmo id (= mesmo PTY).
        idx.items
          .filter((c) => c.id !== active)
          .forEach((c) =>
            workspaceLoad(c.id)
              .then((ws) => bumpCounter((ws.nodes as Node[]) ?? []))
              .catch(() => {}),
          );
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
  }, [nodes, edges, strokes, controls.camera.moveTick]);

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
    await killCanvasTerminals(id);
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
      let ws: WorkspaceData;
      try {
        ws = await workspaceLoad(next);
      } catch (e) {
        console.error("Erro ao carregar workspace pós-deleção!", e);
        return;
      }
      activeRef.current = next;
      setActiveCanvas(next);
      applyCanvas(ws);
      workspaceSetActive(next).catch(() => {});
    }
    let idx: WorkspaceIndex | null = null;
    for (const id of ids) {
      try {
        await killCanvasTerminals(id);
        idx = await workspaceDelete(id);
      } catch (e) {
        console.error(`Erro ao deletar workspace ${id}`, e);
        // Atualiza a sidebar após a falha.
        idx = await workspacesList().catch(() => idx);
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

  // Papéis do backend + catálogo de agentes para o `colmeia preset list`.
  useEffect(() => {
    const refresh = () => loadRoles().then(setRoleList).catch(() => {});
    refresh();
    setPresets(
      AGENT_LIST.map((a) => {
        const { command, args } = a.resolve();
        return { id: a.id, label: a.label, command: [command, ...args].join(" ") };
      }),
    ).catch(() => {});
    const sub = listen("colmeia://roles-changed", refresh);
    return () => {
      sub.then((un) => un());
    };
  }, []);

  // Espelha o grafo no backend sempre que nós/arestas mudam (escopo do roteamento).
  useEffect(() => {
    const graphNodes = nodes.map((n) => {
      const d = n.data as {
        title?: string;
        agent?: string;
        role?: string;
        content?: string;
        cwd?: string;
        autoApproveInCwd?: boolean;
        maestro?: boolean;
        locked?: boolean;
        band?: boolean;
      };
      return {
        id: n.id,
        type: n.type ?? "terminal",
        title: d.title ?? n.id,
        agent: d.agent ?? "",
        role: d.role ? (roleMap[d.role]?.label ?? d.role) : "",
        roleId: d.role ?? "",
        // Portal: o backend lê a URL salva do nó para reabrir o navegador.
        content: (n.type === "browser" ? (n.data as { url?: string }).url : d.content) ?? "",
        cwd: d.cwd ?? "",
        autoApproveInCwd: !!d.autoApproveInCwd,
        maestro: !!d.maestro,
        locked: !!d.locked,
        // Bands: o backend expande o alcance pelos membros (parentId) do grupo-band.
        parent: n.parentId ?? "",
        band: n.type === "group" && !!d.band,
      };
    });
    const graphEdges = edges.map((e) => ({ source: e.source, target: e.target }));
    setGraph(graphNodes, graphEdges).catch(() => {});
  }, [nodes, edges, roleMap]);

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

  // Abre/atualiza um browser conectado ao agente (via `colmeia portal open`/`browse`).
  // Com `portalId`, o backend já abriu a sessão CDP com esse id: cria o nó com
  // ele (ligado ao agente) — o quadro só pluga no navegador que já existe.
  const onBrowse = useCallback(
    (url: string, sourceId: string, portalId?: string, portalTitle?: string) => {
      if (portalId) {
        if (nodesRef.current.some((n) => n.id === portalId)) return;
        const src = nodesRef.current.find((n) => n.id === sourceId);
        const srcW = src?.measured?.width ?? (src?.style?.width as number | undefined) ?? 600;
        setNodes((nds) =>
          nds.concat({
            id: portalId,
            type: "browser",
            position: src
              ? { x: src.position.x + srcW + 60, y: src.position.y }
              : { x: 220, y: 180 },
            data: { title: portalTitle || "Portal", url },
            style: { width: 720, height: 520 },
          }),
        );
        if (sourceId) {
          setEdges((eds) =>
            addEdge(
              { id: `e-${sourceId}-${portalId}`, source: sourceId, target: portalId, animated: true },
              eds,
            ),
          );
        }
        return;
      }
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

  // Acha um nó pelo id (o backend já resolve com escopo) ou, por compat, pelo título.
  const findNode = useCallback((ref: string) => {
    if (!ref) return undefined;
    return (
      nodesRef.current.find((n) => n.id === ref) ??
      nodesRef.current.find(
        (n) =>
          ((n.data as { title?: string }).title ?? n.id).toLowerCase() ===
          ref.toLowerCase(),
      )
    );
  }, []);

  // Conecta dois nós (usado por `colmeia connect`; o payload traz ids).
  const connectByTitle = useCallback(
    (source: string, target: string) => {
      const a = findNode(source);
      const b = findNode(target);
      if (a && b && a.id !== b.id) {
        setEdges((eds) =>
          addEdge(
            { id: `e-${a.id}-${b.id}`, source: a.id, target: b.id, animated: true },
            eds,
          ),
        );
      }
    },
    [setEdges, findNode],
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
  // O backend já validou nome (único), agente (catálogo) e papel (id existente).
  const recruitAgent = useCallback(
    (p: { name: string; agent: string; role: string; dir: string; source: string }) => {
      const agentId: AgentId = p.agent in AGENTS ? (p.agent as AgentId) : "claude";
      // Sem --dir, herda a pasta de trabalho do recrutador (força-tarefa na mesma pasta).
      const cwd =
        p.dir ||
        (
          nodesRef.current.find((n) => n.id === p.source)?.data as {
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
        const title = p.name.trim() || `${AGENTS[agentId].label} ${sameKind + 1}`;
        return nds.concat({
          id,
          type: "terminal",
          position: { x: 160 + offset, y: 130 + offset },
          data: { agent: agentId, title, role: p.role || undefined, cwd },
          style: { width: 500, height: 340 },
        });
      });
      if (p.source) {
        setEdges((eds) =>
          addEdge(
            { id: `e-${p.source}-${id}`, source: p.source, target: id, animated: true },
            eds,
          ),
        );
      }
    },
    [setNodes, setEdges],
  );

  // Atualiza dados de um nó a pedido do backend (`role assign`, `recruit --replace`).
  // `restart` muda o `restartKey`, que reinicia o processo mantendo id e arestas.
  const updateNodeFromBackend = useCallback(
    (p: { id: string; patch: Record<string, unknown>; restart: boolean }) => {
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id !== p.id) return n;
          const patch: Record<string, unknown> = { ...p.patch };
          // Papel vazio = sem papel.
          if ("role" in patch && !patch.role) patch.role = undefined;
          if (p.restart) patch.restartKey = Date.now();
          return { ...n, data: { ...n.data, ...patch } };
        }),
      );
    },
    [setNodes],
  );

  // Conteúdo de nota editado por um agente (`colmeia note write/edit`).
  const updateNoteContent = useCallback(
    (id: string, content: string) => {
      setNodes((nds) =>
        nds.map((n) =>
          n.id === id && n.type === "note"
            ? { ...n, data: { ...n.data, content } }
            : n,
        ),
      );
    },
    [setNodes],
  );


  // Dispensa (remove) um agente (via `colmeia dismiss`; o payload traz o id).
  const dismissAgent = useCallback(
    (ref: string) => {
      const node = findNode(ref);
      if (node && node.type === "terminal") {
        disposeTerminal(node.id, { canvasId: activeRef.current });
        setNodes((nds) => nds.filter((n) => n.id !== node.id));
        setEdges((eds) =>
          eds.filter((e) => e.source !== node.id && e.target !== node.id),
        );
      }
    },
    [setNodes, setEdges, findNode],
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
  // Os alvos chegam como ids já resolvidos com escopo pelo servidor.
  useEffect(() => {
    const subs = [
      listen<{ title: string; content: string; source: string; target: string }>(
        "colmeia://add-note",
        (e) => {
          const { title, content, source, target } = e.payload;
          // Destino: o agente indicado, senão o próprio criador.
          const t = target ? findNode(target) : undefined;
          addNoteNode(title, content, t?.id ?? (source || undefined));
        },
      ),
      listen<{ id: string; content: string }>("colmeia://note-update", (e) =>
        updateNoteContent(e.payload.id, e.payload.content),
      ),
      listen<{ source: string; target: string }>("colmeia://connect", (e) =>
        connectByTitle(e.payload.source, e.payload.target),
      ),
      listen<{ name: string; agent: string; role: string; dir: string; source: string }>(
        "colmeia://recruit",
        (e) => recruitAgent(e.payload),
      ),
      listen<{ id: string; patch: Record<string, unknown>; restart: boolean }>(
        "colmeia://node-update",
        (e) => updateNodeFromBackend(e.payload),
      ),
      listen<{ id?: string; title: string }>("colmeia://dismiss", (e) =>
        dismissAgent(e.payload.id || e.payload.title),
      ),
      listen<{ url: string; source: string; id?: string; title?: string }>("colmeia://browse", (e) =>
        onBrowse(e.payload.url, e.payload.source, e.payload.id, e.payload.title),
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
    updateNodeFromBackend,
    updateNoteContent,
    dismissAgent,
    findNode,
    onBrowse,
  ]);

  const nodeColor = useCallback(
    (n: Node) =>
      n.type === "note"
        ? "var(--warning)"
        : n.type === "browser"
          ? "var(--info)"
          : AGENTS[(n.data as { agent: AgentId }).agent]?.color ?? "var(--text-muted)",
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
      </aside>
        )}

      <main className={`canvas ${controls.canvasClassName}`}>
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
          nodes={ux.nodes}
          edges={controls.edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodesDelete={(deleted) => {
            // Nó deletado de verdade (Delete / botão fechar): aí sim mata o PTY.
            deleted
              .filter((n) => n.type === "terminal")
              .forEach((n) => disposeTerminal(n.id, { canvasId: activeRef.current }));
            // Portal deletado: mata o navegador headless e apaga o perfil dele.
            deleted
              .filter((n) => n.type === "browser")
              .forEach((n) => portalClose(n.id).catch(() => {}));
          }}
          onBeforeDelete={grouping.onBeforeDelete}
          onConnect={onConnect}
          {...ux.flowProps}
          onNodeClick={controls.onNodeClick}
          onPaneClick={controls.onPaneClick}
          onMoveEnd={controls.onMoveEnd}
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
          />
          <Controls className="controls" showInteractive={false} />
          {ux.viewportLayer}
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
          showPartituras={partituras.open}
          onTogglePartituras={() => partituras.setOpen((v) => !v)}
          showComposer={ux.composer.open}
          onToggleComposer={ux.composer.toggle}
        />

        {showRoutines && (
          <RoutinesPanel
            terminals={terminals}
            defaultTarget={selectedTerminal?.id ?? ""}
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

        <LiftOverlay nodes={nodes} />

        {showOmbro && <OmbroPanel onClose={() => setShowOmbro(false)} />}

        {partituras.open && <PartiturasPanel api={partituras} />}

        <ApprovalsPanel
          approvals={approvals}
          onResolved={(id) =>
            setApprovals((prev) => prev.filter((a) => a.id !== id))
          }
        />

        {controls.overlays}
        {ux.overlays}

        {nodes.length === 0 && (
          <div className="empty">
            <img src={logoUrl} className="empty-logo" alt="" />
            <h2>Canvas vazio</h2>
            <p>
              Adicione um agente pela barra no topo do canvas (ou Ctrl+K). Cada nó é um{" "}
              <b>terminal real</b>, rodando um shell ou uma CLI de agente de verdade.
            </p>
          </div>
        )}
        </main>
      </div>
      <StatusBar
        canvasName={canvases.find((c) => c.id === activeCanvas)?.name ?? ""}
        terminalIds={terminals.map((t) => t.id)}
        approvals={approvals.length}
        theme={theme}
        onTheme={setTheme}
      />
    </div>
  );
}
