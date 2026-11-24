// Decorações visuais derivadas (não persistidas, fora do undo):
// - arestas com um `colmeia ask` em voo (evento `colmeia://asks-in-flight`);
// - nó de origem do modo connect e nós em atenção.
// São aplicadas como `className` numa cópia dos nós/arestas passada ao <ReactFlow>,
// sem tocar no estado salvo.

import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { Edge, Node } from "@xyflow/react";

interface AskPair {
  from: string;
  to: string;
}

/** Pares (origem → destino) de asks em voo, como enviados pelo backend. */
export function useAsksInFlight(): AskPair[] {
  const [asks, setAsks] = useState<AskPair[]>([]);
  useEffect(() => {
    const p = listen<{ asks?: AskPair[] }>("colmeia://asks-in-flight", (e) =>
      setAsks(Array.isArray(e.payload?.asks) ? e.payload.asks : []),
    );
    return () => {
      p.then((un) => un()).catch(() => {});
    };
  }, []);
  return asks;
}

/** Classes que só este módulo aplica (nunca fazem parte do estado salvo). */
const OWN_CLASSES = new Set(["edge-inflight", "node-connect-source", "node-attention"]);

/**
 * Remove as nossas classes de um className. Necessário porque `updateNodeData` /
 * `updateEdgeData` do React Flow copiam o objeto renderizado (já decorado) de volta
 * para o estado; sem limpar, uma decoração antiga ficaria grudada.
 */
function baseClass(cls: string | undefined): string | undefined {
  if (!cls) return cls;
  const kept = cls.split(/\s+/).filter((c) => c && !OWN_CLASSES.has(c));
  return kept.length ? kept.join(" ") : undefined;
}

function addClass(base: string | undefined, cls: string): string {
  return base ? `${base} ${cls}` : cls;
}

/** Arestas com a classe `edge-inflight` enquanto houver ask em voo entre as pontas. */
export function useDecoratedEdges(edges: Edge[], nodes: Node[], asks: AskPair[]): Edge[] {
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  return useMemo(() => {
    if (!asks.length && !edges.some((e) => e.className)) return edges;
    // Aceita id ou título nas pontas (o backend pode mandar qualquer um).
    const resolve = (ref: string) => {
      const ns = nodesRef.current;
      if (ns.some((n) => n.id === ref)) return ref;
      const low = ref.toLowerCase();
      return (
        ns.find(
          (n) => String((n.data as { title?: string }).title ?? "").toLowerCase() === low,
        )?.id ?? ref
      );
    };
    const keys = new Set<string>();
    for (const a of asks) {
      const f = resolve(a.from);
      const t = resolve(a.to);
      keys.add(`${f}\u0000${t}`);
      keys.add(`${t}\u0000${f}`);
    }
    return edges.map((e) => {
      const base = baseClass(e.className);
      const cls = keys.has(`${e.source}\u0000${e.target}`)
        ? addClass(base, "edge-inflight")
        : base;
      return cls === e.className ? e : { ...e, className: cls };
    });
  }, [edges, asks]);
}

/** Nós com classes do modo connect / atenção. Mantém a identidade dos que não mudam. */
export function useDecoratedNodes(
  nodes: Node[],
  connectSource: string | null,
  attentionIds: string[],
): Node[] {
  const attKey = attentionIds.join("\u0000");
  return useMemo(() => {
    const att = new Set(attentionIds);
    if (!connectSource && !att.size && !nodes.some((n) => n.className)) return nodes;
    return nodes.map((n) => {
      let cls = baseClass(n.className);
      if (n.id === connectSource) cls = addClass(cls, "node-connect-source");
      if (att.has(n.id)) cls = addClass(cls, "node-attention");
      return cls === n.className ? n : { ...n, className: cls };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, connectSource, attKey]);
}
