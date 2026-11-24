// Ações sobre nós/arestas usadas pelo menu de contexto e pelos atalhos de UX:
// duplicar, copiar, colar num ponto, travar posição, ordem (z), renomear, band,
// conectar/desconectar, traçado de aresta e criar nós numa posição.

import { useCallback, useEffect } from "react";
import { addEdge, useReactFlow, type Edge, type Node, type XYPosition } from "@xyflow/react";
import { toast } from "sonner";
import { AGENTS, type AgentId } from "../lib/agents";
import { boundsOf, newEdgeId, newNodeId, type CanvasApi } from "../lib/canvas";
import { alreadyConnected, kindsCompatible, type EdgePath } from "../lib/connections";
import { makeNoteNode } from "../lib/nodeFactory";
import { BAND_TOGGLE_EVENT } from "../nodes/GroupNode";
import { buildPayload, insertClipPayload, parsePayload } from "./useClipboard";


const titleOf = (n: Node | undefined) =>
  String((n?.data as { title?: string } | undefined)?.title ?? n?.id ?? "");

export function useNodeActions(api: CanvasApi) {
  const rf = useReactFlow();

  const patchData = useCallback(
    (ids: string[], patch: (n: Node) => Record<string, unknown> | null) => {
      const set = new Set(ids);
      api.setNodes((nds) =>
        nds.map((n) => {
          if (!set.has(n.id)) return n;
          const p = patch(n);
          return p ? { ...n, data: { ...n.data, ...p } } : n;
        }),
      );
    },
    [api],
  );

  /** Seleciona exatamente estes nós (para os atalhos/menus agirem sobre eles). */
  const selectOnly = useCallback(
    (ids: string[]) => {
      const set = new Set(ids);
      api.setNodes((nds) =>
        nds.map((n) => (!!n.selected === set.has(n.id) ? n : { ...n, selected: set.has(n.id) })),
      );
    },
    [api],
  );

  const payloadFor = (ids: string[]) => {
    const set = new Set(ids);
    return buildPayload(
      api.nodesRef.current.map((n) => ({ ...n, selected: set.has(n.id) })),
      api.edgesRef.current,
    );
  };

  const copy = useCallback(
    (ids: string[]) => {
      const p = payloadFor(ids);
      if (!p) return;
      navigator.clipboard
        .writeText(JSON.stringify(p))
        .then(() => toast.success(ids.length === 1 ? "Nó copiado" : `${ids.length} nós copiados`))
        .catch(() => toast.error("Não foi possível copiar (use Ctrl+C)"));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api],
  );

  const duplicate = useCallback(
    (ids: string[]) => {
      const p = payloadFor(ids);
      if (!p) return [];
      return insertClipPayload(api, p, 40, 40);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api],
  );

  /** Cola do clipboard do sistema com o canto superior esquerdo em `at` (canvas). */
  const pasteAt = useCallback(
    async (at: XYPosition) => {
      let text = "";
      try {
        text = await navigator.clipboard.readText();
      } catch {
        toast.error("Sem acesso ao clipboard — use Ctrl+V");
        return;
      }
      const p = parsePayload(text);
      if (!p) {
        toast.info("O clipboard não tem nós do colmeia — use Ctrl+V para imagem/URL");
        return;
      }
      const tops = p.nodes.filter((n) => !n.parentId);
      if (!tops.length) return;
      const minX = Math.min(...tops.map((n) => n.position.x));
      const minY = Math.min(...tops.map((n) => n.position.y));
      insertClipPayload(api, p, at.x - minX, at.y - minY);
    },
    [api],
  );

  const togglePin = useCallback(
    (ids: string[]) => {
      const all = api.nodesRef.current.filter((n) => ids.includes(n.id));
      const pin = !all.every((n) => (n.data as { pinned?: boolean }).pinned);
      patchData(ids, () => ({ pinned: pin || undefined }));
    },
    [api, patchData],
  );

  const bringToFront = useCallback(
    (ids: string[]) => {
      const zs = api.nodesRef.current.map((n) => Number((n.data as { z?: number }).z ?? 0));
      const top = Math.max(0, ...zs) + 1;
      patchData(ids, () => ({ z: top }));
    },
    [api, patchData],
  );

  const sendToBack = useCallback(
    (ids: string[]) => {
      const zs = api.nodesRef.current.map((n) => Number((n.data as { z?: number }).z ?? 0));
      const bottom = Math.min(0, ...zs) - 1;
      patchData(ids, () => ({ z: bottom }));
    },
    [api, patchData],
  );

  const rename = useCallback(
    (id: string, title: string) => {
      const t = title.trim();
      const n = api.nodesRef.current.find((m) => m.id === id);
      if (!n || !t || t === titleOf(n)) return;
      if (n.type === "terminal") {
        const clash = api.nodesRef.current.some(
          (m) => m.id !== id && m.type === "terminal" && titleOf(m).toLowerCase() === t.toLowerCase(),
        );
        if (clash) toast.warning(`Já existe um agente chamado "${t}" — os agentes podem se confundir`);
      }
      patchData([id], () => ({ title: t }));
    },
    [api, patchData],
  );

  /** Liga/desliga a band. Ao desligar, remove as arestas do grupo (ele perde as alças). */
  const toggleBand = useCallback(
    (id: string) => {
      const g = api.nodesRef.current.find((n) => n.id === id && n.type === "group");
      if (!g) return;
      const on = !(g.data as { band?: boolean }).band;
      patchData([id], () => ({ band: on || undefined }));
      if (!on) {
        const touching = api.edgesRef.current.filter((e) => e.source === id || e.target === id);
        if (touching.length) {
          api.setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id));
          toast.info(`Band desligada: ${touching.length} conexão(ões) do grupo removida(s)`);
        }
      } else {
        toast.success("Band ligada: os membros se enxergam e herdam as conexões do grupo");
      }
    },
    [api, patchData],
  );

  const connect = useCallback(
    (source: string, target: string) => {
      const ns = api.nodesRef.current;
      const a = ns.find((n) => n.id === source);
      const b = ns.find((n) => n.id === target);
      if (!kindsCompatible(a, b)) {
        toast.warning("Esses tipos de nó não se conectam");
        return;
      }
      if (alreadyConnected(api.edgesRef.current, source, target)) {
        toast.info("Esses nós já estão conectados");
        return;
      }
      api.setEdges((eds) =>
        addEdge({ id: newEdgeId(source, target), source, target, animated: true }, eds),
      );
      toast.success(`Conectado: ${titleOf(a)} → ${titleOf(b)}`);
    },
    [api],
  );

  const disconnect = useCallback(
    (a: string, b: string) =>
      api.setEdges((eds) =>
        eds.filter(
          (e) => !((e.source === a && e.target === b) || (e.source === b && e.target === a)),
        ),
      ),
    [api],
  );

  const setEdgeData = useCallback(
    (id: string, patch: Record<string, unknown>) =>
      api.setEdges((eds) =>
        eds.map((e): Edge => (e.id === id ? { ...e, data: { ...e.data, ...patch } } : e)),
      ),
    [api],
  );

  const setEdgePath = useCallback(
    (id: string, path: EdgePath) => setEdgeData(id, { path: path === "bezier" ? undefined : path }),
    [setEdgeData],
  );

  const remove = useCallback(
    (ids: string[]) => void rf.deleteElements({ nodes: ids.map((id) => ({ id })) }),
    [rf],
  );

  const removeEdge = useCallback(
    (id: string) => void rf.deleteElements({ edges: [{ id }] }),
    [rf],
  );

  // ---- Criar nós numa posição (menu do fundo) -------------------------------

  const addAgentAt = useCallback(
    (agent: AgentId, at: XYPosition) => {
      const same = api.nodesRef.current.filter(
        (n) => (n.data as { agent?: AgentId }).agent === agent,
      ).length;
      const node: Node = {
        id: newNodeId(agent),
        type: "terminal",
        position: { x: at.x, y: at.y },
        data: { agent, title: `${AGENTS[agent].label} ${same + 1}` },
        style: { width: 500, height: 340 },
      };
      api.setNodes((nds) => nds.concat(node));
      return node.id;
    },
    [api],
  );

  const addNoteAt = useCallback(
    (at: XYPosition) => {
      const n = makeNoteNode("Nota", "", { x: at.x + 160, y: at.y + 120 });
      api.setNodes((nds) => nds.concat(n));
      return n.id;
    },
    [api],
  );

  const addTextAt = useCallback(
    (at: XYPosition) => {
      const node: Node = {
        id: newNodeId("text"),
        type: "text",
        position: { x: at.x, y: at.y },
        data: { text: "", color: "#e6e9ef", fontSize: 22 },
        style: { width: 220, height: 60 },
      };
      api.setNodes((nds) => nds.concat(node));
      return node.id;
    },
    [api],
  );

  const fitAll = useCallback(
    () => rf.fitView({ padding: 0.15, maxZoom: 1, duration: 350 }),
    [rf],
  );

  /** Caixa (absoluta) de um conjunto de nós — usada para posicionar popovers. */
  const boundsFor = useCallback(
    (ids: string[]) => {
      const all = api.nodesRef.current;
      return boundsOf(
        all.filter((n) => ids.includes(n.id)),
        all,
      );
    },
    [api],
  );

  // Botão "band" do cabeçalho do grupo.
  useEffect(() => {
    const on = (e: Event) => {
      const id = (e as CustomEvent<{ id: string }>).detail?.id;
      if (id) toggleBand(id);
    };
    window.addEventListener(BAND_TOGGLE_EVENT, on);
    return () => window.removeEventListener(BAND_TOGGLE_EVENT, on);
  }, [toggleBand]);

  return {
    selectOnly,
    copy,
    duplicate,
    pasteAt,
    togglePin,
    bringToFront,
    sendToBack,
    rename,
    toggleBand,
    connect,
    disconnect,
    setEdgeData,
    setEdgePath,
    remove,
    removeEdge,
    addAgentAt,
    addNoteAt,
    addTextAt,
    fitAll,
    boundsFor,
  };
}

export type NodeActions = ReturnType<typeof useNodeActions>;
