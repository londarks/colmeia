// Undo/redo do canvas: pilha de snapshots de nós/arestas/desenhos.
//
// - Coalescência: só "fecha" um passo depois de ~450 ms sem mudanças (arrastar um
//   nó, digitar numa nota ou desenhar um traço viram 1 passo).
// - Campos voláteis (seleção, medidas, status de aprovação, comandos do browser,
//   destaque de aresta) ficam fora do snapshot.
// - Segurança com processos: desfazer NUNCA mata um terminal vivo (um terminal que
//   sumiria é mantido no canvas) e nunca troca a pasta de um terminal existente
//   (isso reiniciaria o agente). Desfazer a exclusão de um terminal recria o nó,
//   o que sobe um processo NOVO — o toast avisa.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Edge, Node } from "@xyflow/react";
import { toast } from "sonner";
import type { Stroke } from "../components/DrawLayer";

const LIMIT = 100;
const COALESCE_MS = 450;

/** Campos de `data` que não entram no histórico (estado vivo, não edição). */
const VOLATILE_NODE_DATA = ["waiting", "command"] as const;
const VOLATILE_EDGE_DATA = ["active"] as const;
/** Campos de `data` de terminal que, se mudarem, reiniciam o processo. */
const PROCESS_DATA = ["cwd", "agent"] as const;

interface Snapshot {
  nodes: Node[];
  edges: Edge[];
  strokes: Stroke[];
  /** Serialização para comparar snapshots barato. */
  key: string;
}

function omit<T extends Record<string, unknown>>(
  obj: T | undefined,
  keys: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(obj ?? {}) };
  for (const k of keys) delete out[k];
  return out;
}

function snapshot(nodes: Node[], edges: Edge[], strokes: Stroke[]): Snapshot {
  const ns = nodes.map(
    (n) =>
      ({
        id: n.id,
        type: n.type,
        position: { x: n.position.x, y: n.position.y },
        data: omit(n.data, VOLATILE_NODE_DATA),
        style: n.style,
        parentId: n.parentId,
        width: n.width,
        height: n.height,
      }) as Node,
  );
  const es = edges.map(
    (e) =>
      ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle,
        targetHandle: e.targetHandle,
        animated: e.animated,
        data: omit(e.data, VOLATILE_EDGE_DATA),
      }) as Edge,
  );
  const ss = strokes;
  return { nodes: ns, edges: es, strokes: ss, key: JSON.stringify([ns, es, ss]) };
}

function titleOf(n: Node): string {
  return ((n.data as { title?: string }).title ?? n.id) as string;
}

interface Params {
  nodes: Node[];
  edges: Edge[];
  strokes: Stroke[];
  setNodes: (nodes: Node[]) => void;
  setEdges: (edges: Edge[]) => void;
  setStrokes: (strokes: Stroke[]) => void;
}

export function useHistory({
  nodes,
  edges,
  strokes,
  setNodes,
  setEdges,
  setStrokes,
}: Params) {
  const undoStack = useRef<Snapshot[]>([]);
  const redoStack = useRef<Snapshot[]>([]);
  const committed = useRef<Snapshot | null>(null);
  // Quando true, o próximo estado observado vira a base sem gerar passo
  // (carregamento de canvas, aplicação de undo/redo).
  const adoptNext = useRef(true);
  const timer = useRef<number | undefined>(undefined);
  const live = useRef({ nodes, edges, strokes });
  live.current = { nodes, edges, strokes };
  const [, force] = useState(0);
  const bump = () => force((v) => v + 1);

  /** Fecha o passo pendente (se o estado atual difere do último commit). */
  const commit = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    const { nodes, edges, strokes } = live.current;
    // Enquanto arrasta, espera soltar (arrastar inteiro = 1 passo).
    if (nodes.some((n) => n.dragging)) {
      timer.current = window.setTimeout(commit, COALESCE_MS);
      return;
    }
    const snap = snapshot(nodes, edges, strokes);
    if (adoptNext.current || !committed.current) {
      adoptNext.current = false;
      committed.current = snap;
      return;
    }
    if (snap.key === committed.current.key) return;
    undoStack.current.push(committed.current);
    if (undoStack.current.length > LIMIT) undoStack.current.shift();
    redoStack.current = [];
    committed.current = snap;
    bump();
  }, []);

  // Observa as mudanças e agenda o fechamento do passo (debounce = coalescência).
  useEffect(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(commit, adoptNext.current ? 0 : COALESCE_MS);
  }, [nodes, edges, strokes, commit]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  /** Aplica um snapshot preservando o que não pode ser desfeito com segurança. */
  const apply = useCallback(
    (target: Snapshot, verb: "Desfeito" | "Refeito") => {
      const cur = live.current;
      const curById = new Map(cur.nodes.map((n) => [n.id, n]));
      const targetIds = new Set(target.nodes.map((n) => n.id));

      const recreated: string[] = [];
      const nextNodes: Node[] = target.nodes.map((t) => {
        const c = curById.get(t.id);
        if (!c) {
          if (t.type === "terminal") recreated.push(titleOf(t));
          return { ...t, selected: false };
        }
        // Mantém o estado vivo do nó atual (seleção, medidas, status).
        const data: Record<string, unknown> = { ...t.data };
        for (const k of VOLATILE_NODE_DATA) {
          if (k in c.data) data[k] = c.data[k];
          else delete data[k];
        }
        if (c.type === "terminal") {
          for (const k of PROCESS_DATA) {
            if (k in c.data) data[k] = c.data[k];
            else delete data[k];
          }
        }
        return {
          ...c,
          position: t.position,
          style: t.style,
          width: t.width,
          height: t.height,
          data,
        };
      });

      // Terminais vivos que o snapshot apagaria: mantidos (não mata o processo).
      const kept = cur.nodes.filter((n) => n.type === "terminal" && !targetIds.has(n.id));
      nextNodes.push(...kept);
      const finalIds = new Set(nextNodes.map((n) => n.id));

      const curEdges = new Map(cur.edges.map((e) => [e.id, e]));
      const nextEdges = target.edges
        .filter((e) => finalIds.has(e.source) && finalIds.has(e.target))
        .map((e) => {
          const c = curEdges.get(e.id);
          return c ? { ...c, ...e, data: { ...e.data, active: c.data?.active } } : e;
        });

      adoptNext.current = true;
      setNodes(nextNodes);
      setEdges(nextEdges);
      setStrokes(target.strokes);

      if (recreated.length) {
        toast.warning(`${verb}: terminal recriado`, {
          description: `${recreated.join(", ")} — é um processo NOVO; a sessão anterior do agente não volta.`,
        });
      }
      if (kept.length) {
        toast.info(`${verb} sem fechar terminais`, {
          description: `${kept.map(titleOf).join(", ")} continua aberto para não matar o processo. Feche manualmente se quiser.`,
        });
      }
    },
    [setNodes, setEdges, setStrokes],
  );

  const undo = useCallback(() => {
    // Mudanças ainda não fechadas viram um passo antes de desfazer.
    if (timer.current !== undefined) commit();
    const prev = undoStack.current.pop();
    if (!prev || !committed.current) return false;
    redoStack.current.push(committed.current);
    committed.current = prev;
    apply(prev, "Desfeito");
    bump();
    return true;
  }, [apply, commit]);

  const redo = useCallback(() => {
    if (timer.current !== undefined) commit();
    const next = redoStack.current.pop();
    if (!next || !committed.current) return false;
    undoStack.current.push(committed.current);
    committed.current = next;
    apply(next, "Refeito");
    bump();
    return true;
  }, [apply, commit]);

  /** Zera o histórico (ao carregar/trocar de canvas). */
  const reset = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    undoStack.current = [];
    redoStack.current = [];
    committed.current = null;
    adoptNext.current = true;
    bump();
  }, []);

  return {
    undo,
    redo,
    reset,
    canUndo: undoStack.current.length > 0,
    canRedo: redoStack.current.length > 0,
  };
}

export type History = ReturnType<typeof useHistory>;
