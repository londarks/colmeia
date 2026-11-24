// Junta palette, atalhos, modo connect, notificações, undo/redo e câmera num hook só,
// para o App.tsx ficar com poucas linhas de integração.

import { useCallback, useRef, useState, type ReactNode } from "react";
import { addEdge, type Edge, type Node, type NodeMouseHandler } from "@xyflow/react";
import { toast } from "sonner";
import type { Stroke } from "../components/DrawLayer";
import { CommandPalette, type PaletteActions } from "../components/CommandPalette";
import { ShortcutsHelp } from "../components/ShortcutsHelp";
import { ThemedToaster } from "../components/Toasts";
import type { AgentId } from "./agents";
import type { WorkspaceMeta } from "./pty";
import { nodeIdOfActiveElement, useCamera } from "./camera";
import { useHistory } from "./history";
import { kindsCompatible } from "./connections";
import { useShortcuts } from "./shortcuts";
import { useNotifications } from "./useNotifications";
import {
  useAsksInFlight,
  useDecoratedEdges,
  useDecoratedNodes,
} from "./useCanvasDecorations";

interface Params {
  nodes: Node[];
  edges: Edge[];
  strokes: Stroke[];
  setNodes: (nodes: Node[]) => void;
  setEdges: React.Dispatch<React.SetStateAction<Edge[]>>;
  setStrokes: (strokes: Stroke[]) => void;
  canvases: WorkspaceMeta[];
  activeCanvas: string;
  actions: {
    switchCanvas: (id: string) => void;
    addAgent: (a: AgentId) => void;
    addNote: () => void;
    addText: () => void;
    addBrowser: () => void;
    setTheme: (id: string) => void;
    toggleRoutines: () => void;
    toggleFloors: () => void;
    toggleOmbro: () => void;
  };
}

function titleOf(n: Node | undefined): string {
  return ((n?.data as { title?: string } | undefined)?.title ?? n?.id ?? "") as string;
}

/** Ordem espacial (linha a linha) para escolher entre vizinhos de forma estável. */
function bySpace(a: Node, b: Node) {
  return a.position.y - b.position.y || a.position.x - b.position.x;
}

export function useCanvasControls(p: Params) {
  const { nodes, edges, setEdges } = p;
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const edgesRef = useRef(edges);
  edgesRef.current = edges;

  const camera = useCamera();
  const history = useHistory({
    nodes,
    edges,
    strokes: p.strokes,
    setNodes: p.setNodes,
    setEdges: p.setEdges,
    setStrokes: p.setStrokes,
  });

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [connectSource, setConnectSource] = useState<string | null>(null);
  // Último nó para onde navegamos (fallback de "nó atual" quando nada está selecionado).
  const lastNode = useRef<string | null>(null);
  // Memória do Alt+←/→ para ciclar entre irmãos ao chegar num nó sem saída.
  const walkMem = useRef<{ from: string; at: string; siblings: string[]; idx: number } | null>(
    null,
  );

  // `focusNode` precisa do markSeen das notificações e vice-versa (clique no toast).
  const markSeenRef = useRef<(id: string) => void>(() => {});
  const focusNode = useCallback(
    (id: string) => {
      if (!nodesRef.current.some((n) => n.id === id)) return;
      lastNode.current = id;
      camera.glideTo(id);
      markSeenRef.current(id);
    },
    [camera],
  );
  const notif = useNotifications({ nodes, focusNode });
  markSeenRef.current = notif.markSeen;

  /** Nó "atual": selecionado → o que tem o foco → o último navegado. */
  const currentNode = (): string | null => {
    const ns = nodesRef.current;
    const sel = ns.find((n) => n.selected);
    if (sel) return sel.id;
    const focused = nodeIdOfActiveElement();
    if (focused) return focused;
    if (lastNode.current && ns.some((n) => n.id === lastNode.current)) return lastNode.current;
    return null;
  };

  const terminals = () => nodesRef.current.filter((n) => n.type === "terminal");

  const connect = useCallback(
    (source: string, target: string) => {
      if (source === target) return;
      const ns0 = nodesRef.current;
      if (
        !kindsCompatible(
          ns0.find((n) => n.id === source),
          ns0.find((n) => n.id === target),
        )
      ) {
        toast.warning("Esses tipos de nó não se conectam");
        return;
      }
      const exists = edgesRef.current.some(
        (e) =>
          (e.source === source && e.target === target) ||
          (e.source === target && e.target === source),
      );
      if (exists) {
        toast.info("Esses nós já estão conectados");
        return;
      }
      setEdges((eds) =>
        addEdge({ id: `e-${source}-${target}`, source, target, animated: true }, eds),
      );
      const ns = nodesRef.current;
      toast.success(
        `Conectado: ${titleOf(ns.find((n) => n.id === source))} → ${titleOf(
          ns.find((n) => n.id === target),
        )}`,
      );
    },
    [setEdges],
  );

  const nextAttention = useCallback((): boolean => {
    const ids = notif.attentionIds;
    if (!ids.length) {
      toast.info("Nenhum agente em atenção");
      return false;
    }
    const cur = currentNode();
    const i = cur ? ids.indexOf(cur) : -1;
    focusNode(ids[(i + 1) % ids.length]);
    return true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notif.attentionIds, focusNode]);

  const walkConnected = (dir: 1 | -1) => {
    const cur = currentNode();
    if (!cur) return;
    const ns = nodesRef.current;
    const es = edgesRef.current;
    const byId = new Map(ns.map((n) => [n.id, n]));
    const sortIds = (ids: string[]) =>
      [...new Set(ids)]
        .map((id) => byId.get(id))
        .filter((n): n is Node => !!n)
        .sort(bySpace)
        .map((n) => n.id);
    // → segue as arestas de saída (cur é a origem); ← volta pelas de entrada.
    const forward = sortIds(
      es.filter((e) => (dir === 1 ? e.source === cur : e.target === cur)).map((e) =>
        dir === 1 ? e.target : e.source,
      ),
    );
    const mem = walkMem.current;
    let next: string | undefined;
    let siblings = forward;
    if (forward.length) {
      next = forward[0];
    } else if (mem && mem.at === cur && mem.siblings.length > 1) {
      // Fim da linha: passa para o próximo irmão do nó de onde viemos.
      const idx = (mem.idx + dir + mem.siblings.length) % mem.siblings.length;
      walkMem.current = { ...mem, at: mem.siblings[idx], idx };
      focusNode(mem.siblings[idx]);
      return;
    } else {
      // Sem aresta na direção pedida: qualquer vizinho (exceto de onde viemos).
      const any = sortIds(
        es
          .filter((e) => e.source === cur || e.target === cur)
          .map((e) => (e.source === cur ? e.target : e.source)),
      ).filter((id) => !(mem && mem.at === cur && id === mem.from));
      siblings = any;
      next = any[0];
    }
    if (!next) {
      toast.info(`${titleOf(byId.get(cur))} não tem conexões`);
      return;
    }
    walkMem.current = { from: cur, at: next, siblings, idx: siblings.indexOf(next) };
    focusNode(next);
  };

  useShortcuts({
    palette: () => setPaletteOpen((v) => !v),
    nextAttention,
    hasAttention: () => notif.attentionIds.length > 0,
    focusTerminalN: (n) => {
      const t = terminals()[n - 1];
      if (t) focusNode(t.id);
    },
    cycleTerminal: (dir) => {
      const ts = terminals();
      if (!ts.length) return;
      const cur = currentNode();
      const i = ts.findIndex((t) => t.id === cur);
      const next = i < 0 ? (dir === 1 ? 0 : ts.length - 1) : (i + dir + ts.length) % ts.length;
      focusNode(ts[next].id);
    },
    walkConnected,
    connectMode: () => {
      const sel = nodesRef.current.filter((n) => n.selected);
      if (sel.length !== 1) return false;
      setConnectSource(sel[0].id);
      return true;
    },
    undo: () => {
      if (!history.undo()) toast.info("Nada para desfazer");
    },
    redo: () => {
      if (!history.redo()) toast.info("Nada para refazer");
    },
    frameSelection: camera.frameSelection,
    help: () => setHelpOpen(true),
    escape: () => {
      if (paletteOpen) return false; // a palette trata o próprio Esc
      if (helpOpen) {
        setHelpOpen(false);
        return true;
      }
      if (connectSource) {
        setConnectSource(null);
        return true;
      }
      return false;
    },
    modalOpen: () => paletteOpen || helpOpen,
  });

  // Clique num nó: conclui o modo connect; também marca o agente como visto.
  const onNodeClick: NodeMouseHandler = useCallback(
    (_e, node) => {
      notif.markSeen(node.id);
      lastNode.current = node.id;
      if (!connectSource) return;
      if (node.id !== connectSource) connect(connectSource, node.id);
      setConnectSource(null);
    },
    [connectSource, connect, notif],
  );
  const onPaneClick = useCallback(() => setConnectSource(null), []);

  const renderNodes = useDecoratedNodes(nodes, connectSource, notif.attentionIds);
  const asks = useAsksInFlight();
  const renderEdges = useDecoratedEdges(edges, nodes, asks);

  const selected = nodes.find((n) => n.selected);
  const paletteActions: PaletteActions = {
    ...p.actions,
    focusNode,
    connect,
    undo: () => history.undo(),
    redo: () => history.redo(),
    frameSelection: camera.frameSelection,
    nextAttention: () => {
      nextAttention();
    },
    showHelp: () => setHelpOpen(true),
    setOsNotifications: notif.setOsEnabled,
  };

  const overlays: ReactNode = (
    <>
      {connectSource && (
        <div className="cl-connect-banner">
          Conectando <b>{titleOf(nodes.find((n) => n.id === connectSource))}</b> — clique no
          nó alvo · Esc cancela
        </div>
      )}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        nodes={nodes}
        canvases={p.canvases}
        activeCanvas={p.activeCanvas}
        selectedId={selected?.id ?? null}
        activity={notif.activity}
        attentionIds={notif.attentionIds}
        osNotifications={notif.osEnabled}
        canUndo={history.canUndo}
        canRedo={history.canRedo}
        actions={paletteActions}
      />
      <ShortcutsHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
      <ThemedToaster />
    </>
  );

  return {
    camera,
    history,
    notifications: notif,
    focusNode,
    /** Nós/arestas decorados (atenção, modo connect, asks em voo) para o <ReactFlow>. */
    nodes: renderNodes,
    edges: renderEdges,
    onNodeClick,
    onPaneClick,
    onMoveEnd: camera.onMoveEnd,
    /** Classe para o container do canvas (cursor do modo connect). */
    canvasClassName: connectSource ? "connect-mode" : "",
    overlays,
  };
}
