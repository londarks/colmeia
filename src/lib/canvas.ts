// Utilitários compartilhados pelos hooks de canvas (partituras, clipboard,
// drop de arquivos, grupos). Mantém o App.tsx só com linhas de integração.

import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { Edge, Node, XYPosition } from "@xyflow/react";

/** O que os hooks de canvas precisam do App: refs atualizadas + setters. */
export interface CanvasApi {
  nodesRef: MutableRefObject<Node[]>;
  edgesRef: MutableRefObject<Edge[]>;
  setNodes: Dispatch<SetStateAction<Node[]>>;
  setEdges: Dispatch<SetStateAction<Edge[]>>;
}

let seq = 0;

/** Id novo e único para um nó. O sufixo não é numérico de propósito, para não
 *  interferir no contador monotônico do App (`applyCanvas`). */
export function newNodeId(prefix: string): string {
  seq += 1;
  const rnd = Math.random().toString(36).slice(2, 6);
  return `${prefix}-x${Date.now().toString(36)}${seq.toString(36)}${rnd}`;
}

export function newEdgeId(source: string, target: string): string {
  return `e-${source}-${target}`;
}

/** Tamanho de um nó: medido pelo React Flow, senão o `style`, senão um padrão. */
export function nodeSize(n: Node): { width: number; height: number } {
  const st = (n.style ?? {}) as { width?: number | string; height?: number | string };
  const w = n.measured?.width ?? n.width ?? (typeof st.width === "number" ? st.width : undefined);
  const h =
    n.measured?.height ?? n.height ?? (typeof st.height === "number" ? st.height : undefined);
  return { width: w ?? 240, height: h ?? 160 };
}

/** Posição absoluta (soma as posições dos pais, para filhos de grupo). */
export function absolutePosition(n: Node, all: Node[]): XYPosition {
  let x = n.position.x;
  let y = n.position.y;
  let parentId = n.parentId;
  let guard = 0;
  while (parentId && guard < 32) {
    const p = all.find((m) => m.id === parentId);
    if (!p) break;
    x += p.position.x;
    y += p.position.y;
    parentId = p.parentId;
    guard += 1;
  }
  return { x, y };
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function rectsOverlap(a: Rect, b: Rect, margin = 0): boolean {
  return (
    a.x < b.x + b.width + margin &&
    a.x + a.width + margin > b.x &&
    a.y < b.y + b.height + margin &&
    a.y + a.height + margin > b.y
  );
}

/** Caixa que envolve os nós (posições absolutas). */
export function boundsOf(nodes: Node[], all: Node[]): Rect | null {
  if (nodes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    const p = absolutePosition(n, all);
    const s = nodeSize(n);
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + s.width);
    maxY = Math.max(maxY, p.y + s.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Procura espaço livre para um bloco de `size` perto de `center` (coordenadas
 * do canvas), andando em anéis ao redor até não colidir com nós de topo.
 */
export function findFreeSpot(
  center: XYPosition,
  size: { width: number; height: number },
  all: Node[],
): XYPosition {
  const obstacles: Rect[] = all
    .filter((n) => !n.parentId)
    .map((n) => ({ ...absolutePosition(n, all), ...nodeSize(n) }));
  const start = { x: center.x - size.width / 2, y: center.y - size.height / 2 };
  const free = (p: XYPosition) =>
    !obstacles.some((o) => rectsOverlap({ ...p, ...size }, o, 24));
  if (free(start)) return start;
  const step = 80;
  for (let ring = 1; ring <= 40; ring++) {
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const p = { x: start.x + dx * step, y: start.y + dy * step };
        if (free(p)) return p;
      }
    }
  }
  return start;
}

/** Centro da viewport atual em coordenadas de tela (cliente). */
export function viewportCenterClient(): { x: number; y: number } {
  const el = document.querySelector(".react-flow");
  const r = el?.getBoundingClientRect();
  if (!r) return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** Ordena para que pais venham antes dos filhos (exigência do React Flow). */
export function sortParentsFirst(nodes: Node[]): Node[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: Node[] = [];
  const seen = new Set<string>();
  const visit = (n: Node, depth = 0) => {
    if (seen.has(n.id) || depth > 32) return;
    if (n.parentId && byId.has(n.parentId)) visit(byId.get(n.parentId)!, depth + 1);
    seen.add(n.id);
    out.push(n);
  };
  nodes.forEach((n) => visit(n));
  return out;
}

/** O alvo do evento é um campo editável ou um terminal (não roubar atalhos). */
export function isEditableTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.closest) return false;
  if (el.closest(".xterm")) return true;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return !!el.closest("[contenteditable=''], [contenteditable='true']");
}
