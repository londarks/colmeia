// Geometria pura do canvas: alinhar, distribuir, arrumar (tidy em camadas) e as
// guias magnéticas do arraste. Tudo em coordenadas ABSOLUTAS do canvas; quem chama
// converte de/para posições relativas ao grupo pai (ver hooks/useLayout.ts).
//
// Implementação própria (não usa nem copia os exemplos "Pro" do React Flow).

export interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Pos {
  x: number;
  y: number;
}

export type AlignMode = "left" | "center" | "right" | "top" | "middle" | "bottom";
export type Axis = "h" | "v";

export const ALIGN_LABELS: Record<AlignMode, string> = {
  left: "Esquerda",
  center: "Centro (horizontal)",
  right: "Direita",
  top: "Topo",
  middle: "Meio (vertical)",
  bottom: "Base",
};

// ---------------------------------------------------------------------------
// Alinhar / distribuir

/** Alinha as caixas pela borda/centro do retângulo que envolve todas. */
export function alignBoxes(boxes: Box[], mode: AlignMode): Map<string, Pos> {
  const out = new Map<string, Pos>();
  if (boxes.length < 2) return out;
  const minX = Math.min(...boxes.map((b) => b.x));
  const maxX = Math.max(...boxes.map((b) => b.x + b.w));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxY = Math.max(...boxes.map((b) => b.y + b.h));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  for (const b of boxes) {
    let { x, y } = b;
    switch (mode) {
      case "left":
        x = minX;
        break;
      case "center":
        x = cx - b.w / 2;
        break;
      case "right":
        x = maxX - b.w;
        break;
      case "top":
        y = minY;
        break;
      case "middle":
        y = cy - b.h / 2;
        break;
      case "bottom":
        y = maxY - b.h;
        break;
    }
    out.set(b.id, { x: Math.round(x), y: Math.round(y) });
  }
  return out;
}

/**
 * Distribui com espaçamento igual entre as caixas (as das pontas ficam onde estão).
 * Se não couber (sobreposição), usa um vão mínimo e empurra a partir da primeira.
 */
export function distributeBoxes(boxes: Box[], axis: Axis, minGap = 24): Map<string, Pos> {
  const out = new Map<string, Pos>();
  if (boxes.length < 3) return out;
  const horiz = axis === "h";
  const sorted = [...boxes].sort((a, b) => (horiz ? a.x - b.x : a.y - b.y));
  const start = horiz ? sorted[0].x : sorted[0].y;
  const last = sorted[sorted.length - 1];
  const end = horiz ? last.x + last.w : last.y + last.h;
  const total = sorted.reduce((s, b) => s + (horiz ? b.w : b.h), 0);
  const gap = Math.max(minGap, (end - start - total) / (sorted.length - 1));
  let cur = start;
  for (const b of sorted) {
    out.set(b.id, horiz ? { x: Math.round(cur), y: b.y } : { x: b.x, y: Math.round(cur) });
    cur += (horiz ? b.w : b.h) + gap;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tidy: layout em camadas seguindo as arestas

export interface TidyOptions {
  /** Ids de líderes (maestro/orquestrador): ficam na primeira coluna. */
  leaders?: Set<string>;
  gapX?: number;
  gapY?: number;
  /** Vão entre componentes desconexos (blocos empilhados). */
  gapBlock?: number;
  /** Canto superior esquerdo do resultado (padrão: o das caixas atuais). */
  origin?: Pos;
}

interface DirEdge {
  source: string;
  target: string;
}

/**
 * Organiza as caixas em colunas por camada: líder (ou quem não tem aresta de
 * entrada) à esquerda, quem ele alcança na coluna seguinte, e assim por diante.
 * Cada componente conexo vira um bloco; os blocos são empilhados. Nós sem
 * nenhuma aresta no conjunto vão para uma grade embaixo.
 */
export function tidyLayered(boxes: Box[], edges: DirEdge[], opts: TidyOptions = {}): Map<string, Pos> {
  const out = new Map<string, Pos>();
  if (boxes.length === 0) return out;
  const gapX = opts.gapX ?? 90;
  const gapY = opts.gapY ?? 40;
  const gapBlock = opts.gapBlock ?? 90;
  const leaders = opts.leaders ?? new Set<string>();
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const es = edges.filter((e) => byId.has(e.source) && byId.has(e.target) && e.source !== e.target);

  const adj = new Map<string, Set<string>>();
  const indeg = new Map<string, number>();
  const outdeg = new Map<string, number>();
  for (const b of boxes) {
    adj.set(b.id, new Set());
    indeg.set(b.id, 0);
    outdeg.set(b.id, 0);
  }
  for (const e of es) {
    adj.get(e.source)!.add(e.target);
    adj.get(e.target)!.add(e.source);
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
    outdeg.set(e.source, (outdeg.get(e.source) ?? 0) + 1);
  }

  const minX = opts.origin?.x ?? Math.min(...boxes.map((b) => b.x));
  const minY = opts.origin?.y ?? Math.min(...boxes.map((b) => b.y));
  const byCurrentY = (a: string, b: string) =>
    byId.get(a)!.y - byId.get(b)!.y || byId.get(a)!.x - byId.get(b)!.x;

  // Componentes conexos (só de quem tem aresta).
  const seen = new Set<string>();
  const components: string[][] = [];
  const isolated: string[] = [];
  for (const b of [...boxes].sort((p, q) => byCurrentY(p.id, q.id))) {
    if (seen.has(b.id)) continue;
    if (adj.get(b.id)!.size === 0) {
      seen.add(b.id);
      isolated.push(b.id);
      continue;
    }
    const comp: string[] = [];
    const stack = [b.id];
    seen.add(b.id);
    while (stack.length) {
      const cur = stack.pop()!;
      comp.push(cur);
      for (const n of adj.get(cur)!) {
        if (!seen.has(n)) {
          seen.add(n);
          stack.push(n);
        }
      }
    }
    components.push(comp);
  }

  let cursorY = minY;
  let blockMaxW = 0;
  for (const comp of components) {
    // Raízes: líderes > sem aresta de entrada > maior grau de saída.
    let roots = comp.filter((id) => leaders.has(id));
    if (!roots.length) roots = comp.filter((id) => (indeg.get(id) ?? 0) === 0);
    if (!roots.length) {
      roots = [
        [...comp].sort(
          (a, b) => (outdeg.get(b) ?? 0) - (outdeg.get(a) ?? 0) || byCurrentY(a, b),
        )[0],
      ];
    }
    // Camada = distância (não-direcionada) até a raiz mais próxima.
    const layer = new Map<string, number>();
    const queue = [...roots].sort(byCurrentY);
    queue.forEach((r) => layer.set(r, 0));
    for (let i = 0; i < queue.length; i++) {
      const cur = queue[i];
      for (const n of adj.get(cur)!) {
        if (!layer.has(n)) {
          layer.set(n, layer.get(cur)! + 1);
          queue.push(n);
        }
      }
    }
    const depth = Math.max(...comp.map((id) => layer.get(id) ?? 0));
    const cols: string[][] = Array.from({ length: depth + 1 }, () => []);
    comp.forEach((id) => cols[layer.get(id) ?? 0].push(id));
    // Ordem: 1ª coluna pela posição atual; as seguintes pelo baricentro dos vizinhos à esquerda.
    cols[0].sort(byCurrentY);
    for (let c = 1; c < cols.length; c++) {
      const prev = new Map(cols[c - 1].map((id, i) => [id, i]));
      const bary = (id: string) => {
        const ps = [...adj.get(id)!].filter((n) => prev.has(n)).map((n) => prev.get(n)!);
        return ps.length ? ps.reduce((s, v) => s + v, 0) / ps.length : Number.MAX_SAFE_INTEGER;
      };
      cols[c].sort((a, b) => bary(a) - bary(b) || byCurrentY(a, b));
    }
    // Dimensões das colunas.
    const colW = cols.map((col) => Math.max(...col.map((id) => byId.get(id)!.w)));
    const colH = cols.map(
      (col) => col.reduce((s, id) => s + byId.get(id)!.h, 0) + gapY * Math.max(0, col.length - 1),
    );
    const blockH = Math.max(...colH);
    let x = minX;
    cols.forEach((col, c) => {
      let y = cursorY + (blockH - colH[c]) / 2;
      for (const id of col) {
        const b = byId.get(id)!;
        // Centraliza na largura da coluna.
        out.set(id, { x: Math.round(x + (colW[c] - b.w) / 2), y: Math.round(y) });
        y += b.h + gapY;
      }
      x += colW[c] + gapX;
    });
    blockMaxW = Math.max(blockMaxW, x - gapX - minX);
    cursorY += blockH + gapBlock;
  }

  // Isolados: grade na proporção da tela, abaixo dos blocos.
  if (isolated.length) {
    const aspect = 16 / 9;
    const ncols = Math.max(1, Math.ceil(Math.sqrt(isolated.length * aspect)));
    const cellW = Math.max(...isolated.map((id) => byId.get(id)!.w));
    let rowY = cursorY;
    for (let i = 0; i < isolated.length; i += ncols) {
      const row = isolated.slice(i, i + ncols);
      const rowH = Math.max(...row.map((id) => byId.get(id)!.h));
      row.forEach((id, j) => {
        out.set(id, { x: Math.round(minX + j * (cellW + gapX)), y: Math.round(rowY) });
      });
      rowY += rowH + gapY;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Guias magnéticas

export interface Guide {
  /** "v" = linha vertical (alinha x); "h" = horizontal (alinha y). */
  dir: "v" | "h";
  /** x (se "v") ou y (se "h") da linha. */
  pos: number;
  /** Extensão da linha no outro eixo. */
  from: number;
  to: number;
}

export interface SnapResult {
  dx: number;
  dy: number;
  guides: Guide[];
}

type Line = { kind: "start" | "mid" | "end"; v: number };

function linesOf(b: Box, axis: "x" | "y"): Line[] {
  const s = axis === "x" ? b.x : b.y;
  const len = axis === "x" ? b.w : b.h;
  return [
    { kind: "start", v: s },
    { kind: "mid", v: s + len / 2 },
    { kind: "end", v: s + len },
  ];
}

/** Pares que fazem sentido: borda↔borda (inclusive encostar) e centro↔centro. */
function compatible(a: Line["kind"], b: Line["kind"]): boolean {
  return a === "mid" ? b === "mid" : b !== "mid";
}

function bestDelta(d: Box, others: Box[], axis: "x" | "y", threshold: number): number | null {
  let best: number | null = null;
  const mine = linesOf(d, axis);
  for (const o of others) {
    for (const ol of linesOf(o, axis)) {
      for (const ml of mine) {
        if (!compatible(ml.kind, ol.kind)) continue;
        const diff = ol.v - ml.v;
        if (Math.abs(diff) <= threshold && (best === null || Math.abs(diff) < Math.abs(best))) {
          best = diff;
        }
      }
    }
  }
  return best;
}

function guidesFor(d: Box, others: Box[], axis: "x" | "y"): Guide[] {
  const byPos = new Map<number, Guide>();
  const mine = linesOf(d, axis);
  for (const o of others) {
    for (const ol of linesOf(o, axis)) {
      for (const ml of mine) {
        if (!compatible(ml.kind, ol.kind) || Math.abs(ol.v - ml.v) > 0.5) continue;
        const pos = Math.round(ml.v * 2) / 2;
        const from = axis === "x" ? Math.min(d.y, o.y) : Math.min(d.x, o.x);
        const to = axis === "x" ? Math.max(d.y + d.h, o.y + o.h) : Math.max(d.x + d.w, o.x + o.w);
        const g = byPos.get(pos);
        if (g) {
          g.from = Math.min(g.from, from);
          g.to = Math.max(g.to, to);
        } else {
          byPos.set(pos, { dir: axis === "x" ? "v" : "h", pos, from, to });
        }
      }
    }
  }
  return [...byPos.values()];
}

/**
 * Quanto mover `d` para encostar/alinhar nas caixas vizinhas (dentro de `threshold`)
 * e quais linhas-guia desenhar depois do ajuste. `range` limita a "vizinhança".
 */
export function computeSnap(d: Box, others: Box[], threshold: number, range = 2400): SnapResult {
  const near = others.filter(
    (o) =>
      Math.abs(o.x + o.w / 2 - (d.x + d.w / 2)) < range &&
      Math.abs(o.y + o.h / 2 - (d.y + d.h / 2)) < range,
  );
  const dx = bestDelta(d, near, "x", threshold) ?? 0;
  const dy = bestDelta(d, near, "y", threshold) ?? 0;
  const moved = { ...d, x: d.x + dx, y: d.y + dy };
  return {
    dx,
    dy,
    guides: [...guidesFor(moved, near, "x"), ...guidesFor(moved, near, "y")],
  };
}

/** Centro de uma caixa dentro de outra? (para soltar um nó dentro de um grupo) */
export function centerInside(inner: Box, outer: Box): boolean {
  const cx = inner.x + inner.w / 2;
  const cy = inner.y + inner.h / 2;
  return cx >= outer.x && cx <= outer.x + outer.w && cy >= outer.y && cy <= outer.y + outer.h;
}
