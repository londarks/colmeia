// Regras de conexão entre nós do canvas (quem pode ligar com quem) e estilos de aresta.
//
// Pares permitidos (arestas não-direcionadas): terminal↔terminal, terminal↔nota,
// nota↔nota, terminal↔portal, portal↔portal, e band↔(terminal|nota|portal|band).
// Proibidos: nota↔portal, imagem/texto com qualquer um, grupo comum (não-band),
// ligar um nó à própria band (ele já é membro) e arestas repetidas.

import type { Connection, Edge, Node } from "@xyflow/react";

export type ConnKind = "terminal" | "note" | "browser" | "band" | "other";

export function connKind(n: Node | undefined): ConnKind {
  if (!n) return "other";
  switch (n.type) {
    case "terminal":
      return "terminal";
    case "note":
      return "note";
    case "browser":
      return "browser";
    case "group":
      return (n.data as { band?: boolean }).band ? "band" : "other";
    default:
      return "other";
  }
}

const ALLOWED = new Set([
  "terminal|terminal",
  "note|terminal",
  "note|note",
  "browser|terminal",
  "browser|browser",
  "band|terminal",
  "band|note",
  "band|browser",
  "band|band",
]);

function pairKey(a: ConnKind, b: ConnKind): string {
  return [a, b].sort().join("|");
}

/** Os tipos dos dois nós podem ser ligados? (ignora arestas existentes) */
export function kindsCompatible(a: Node | undefined, b: Node | undefined): boolean {
  if (!a || !b || a.id === b.id) return false;
  if (!ALLOWED.has(pairKey(connKind(a), connKind(b)))) return false;
  // Um membro não se liga à própria band (já está nela), nem a band a um membro.
  if (isAncestor(a.id, b) || isAncestor(b.id, a)) return false;
  return true;
}

function isAncestor(ancestorId: string, n: Node, all?: Node[]): boolean {
  // Só olha o pai direto quando não temos a lista (caso comum: band → membro direto).
  if (n.parentId === ancestorId) return true;
  if (!all) return false;
  let p = n.parentId;
  let guard = 0;
  while (p && guard < 32) {
    if (p === ancestorId) return true;
    p = all.find((m) => m.id === p)?.parentId;
    guard += 1;
  }
  return false;
}

export function alreadyConnected(edges: Edge[], a: string, b: string): boolean {
  return edges.some(
    (e) => (e.source === a && e.target === b) || (e.source === b && e.target === a),
  );
}

/** Validação completa (tipos + ancestrais + duplicata), para o `isValidConnection`. */
export function canConnect(
  nodes: Node[],
  edges: Edge[],
  c: Connection | Edge,
): boolean {
  const a = nodes.find((n) => n.id === c.source);
  const b = nodes.find((n) => n.id === c.target);
  if (!kindsCompatible(a, b)) return false;
  if (isAncestor(a!.id, b!, nodes) || isAncestor(b!.id, a!, nodes)) return false;
  return !alreadyConnected(edges, a!.id, b!.id);
}

/** Estilo do traçado de uma aresta (`edge.data.path`). */
export type EdgePath = "bezier" | "straight" | "step";

export const EDGE_PATHS: { id: EdgePath; label: string }[] = [
  { id: "bezier", label: "Curva" },
  { id: "straight", label: "Reta" },
  { id: "step", label: "Degrau" },
];
