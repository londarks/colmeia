// Partituras: templates de equipe (agentes + papéis + notas + textos + arestas)
// que podem ser salvos a partir do canvas, exportados/importados e reinseridos.
//
// Regra de segurança: uma partitura NUNCA carrega cwd, comando, args, caminho
// absoluto ou flags de privilégio (ex.: autoApproveInCwd). Os terminais guardam
// só o id do agente do catálogo (`AGENTS`), então o comando que roda é sempre o
// do catálogo local — e a revisão de import mostra exatamente qual é.

import { invoke } from "@tauri-apps/api/core";
import type { Edge, Node, XYPosition } from "@xyflow/react";
import { AGENTS, type AgentId } from "./agents";
import { ROLE_MAP } from "./roles";
import { isNoteColor, noteColorValue } from "./noteColors";
import { absolutePosition, newEdgeId, newNodeId, nodeSize } from "./canvas";

export const PARTITURA_KIND = "colmeia-partitura";
export const PARTITURA_VERSION = 1;
export const PARTITURA_EXT = "colmeia-partitura.json";

export type PartituraNodeType = "terminal" | "note" | "text" | "browser" | "group";
const NODE_TYPES: PartituraNodeType[] = ["terminal", "note", "text", "browser", "group"];

export interface PartituraNode {
  /** Chave local da peça (as arestas e `parent` referenciam isso). */
  key: string;
  type: PartituraNodeType;
  /** Relativa ao canto superior esquerdo do layout — ou ao grupo pai. */
  position: XYPosition;
  size: { width: number; height: number };
  /** Chave do grupo que contém esta peça. */
  parent?: string;
  data: Record<string, unknown>;
}

export interface PartituraEdge {
  source: string;
  target: string;
}

export interface Partitura {
  kind: typeof PARTITURA_KIND;
  formatVersion: typeof PARTITURA_VERSION;
  id: string;
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
  /** Partitura embutida no app (não pode ser excluída). Nunca é persistida. */
  builtin?: boolean;
  nodes: PartituraNode[];
  edges: PartituraEdge[];
}

// ---------------------------------------------------------------- sanitização

const MAX_NODES = 200;
const MAX_TEXT = 200_000;

const str = (v: unknown, max = 200): string =>
  typeof v === "string" ? v.slice(0, max) : "";
const num = (v: unknown, def: number, min: number, max: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def;
const isHexColor = (v: unknown): v is string =>
  typeof v === "string" && /^#[0-9a-f]{3,8}$/i.test(v);
const noteColor = (v: unknown): string | undefined => (isNoteColor(v) ? v : undefined);

export function newPartituraId(): string {
  return `p-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Whitelist dos campos de `data` por tipo de nó. Tudo que não está aqui (cwd,
 * command, args, autoApproveInCwd, waiting, caminhos...) é descartado.
 * Retorna `null` se a peça não puder ser representada (ex.: agente desconhecido).
 */
export function sanitizeNodeData(
  type: PartituraNodeType,
  raw: Record<string, unknown>,
  opts: { includeNoteContent?: boolean; warnings?: string[] } = {},
): Record<string, unknown> | null {
  const warn = (m: string) => opts.warnings?.push(m);
  switch (type) {
    case "terminal": {
      const agent = raw.agent;
      if (typeof agent !== "string" || !(agent in AGENTS)) {
        warn(`Agente desconhecido "${String(agent)}" ignorado.`);
        return null;
      }
      const out: Record<string, unknown> = {
        agent,
        title: str(raw.title, 80) || AGENTS[agent as AgentId].label,
      };
      if (typeof raw.role === "string" && raw.role) {
        if (raw.role in ROLE_MAP) out.role = raw.role;
        else warn(`Papel desconhecido "${raw.role}" removido de "${out.title}".`);
      }
      if (raw.maestro === true) out.maestro = true;
      return out;
    }
    case "note": {
      const out: Record<string, unknown> = {
        title: str(raw.title, 120) || "Nota",
        content: opts.includeNoteContent === false ? "" : str(raw.content, MAX_TEXT),
      };
      const c = noteColor(raw.color);
      if (c) out.color = c;
      if (raw.locked === true) out.locked = true;
      return out;
    }
    case "text":
      return {
        text: str(raw.text, 2000),
        color: isHexColor(raw.color) ? raw.color : "#e6e9ef",
        fontSize: num(raw.fontSize, 22, 8, 160),
      };
    case "browser": {
      const url = str(raw.url, 2000);
      return {
        title: str(raw.title, 80) || "Browser",
        ...(/^https?:\/\//i.test(url) ? { url } : {}),
      };
    }
    case "group": {
      const out: Record<string, unknown> = { title: str(raw.title, 120) || "Grupo" };
      const c = noteColor(raw.color);
      if (c) out.color = c;
      return out;
    }
  }
}

/**
 * Valida e limpa uma partitura vinda de fora (arquivo importado, disco, drop).
 * Lança erro se não for uma partitura; acumula avisos do que foi descartado.
 */
export function sanitizePartitura(
  raw: unknown,
  opts: { builtin?: boolean } = {},
): { partitura: Partitura; warnings: string[] } {
  if (!raw || typeof raw !== "object") throw new Error("arquivo não é um objeto JSON");
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.nodes)) throw new Error("partitura sem lista de nós");
  if (r.kind !== undefined && r.kind !== PARTITURA_KIND)
    throw new Error(`tipo de arquivo desconhecido: ${String(r.kind)}`);
  const warnings: string[] = [];

  const rawNodes = (r.nodes as unknown[]).slice(0, MAX_NODES);
  if ((r.nodes as unknown[]).length > MAX_NODES)
    warnings.push(`Só os primeiros ${MAX_NODES} nós foram mantidos.`);

  const nodes: PartituraNode[] = [];
  const keys = new Set<string>();
  for (const rn of rawNodes) {
    if (!rn || typeof rn !== "object") continue;
    const n = rn as Record<string, unknown>;
    const type = n.type as PartituraNodeType;
    if (!NODE_TYPES.includes(type)) {
      warnings.push(`Peça do tipo "${String(n.type)}" ignorada.`);
      continue;
    }
    const key = str(n.key, 64);
    if (!key || keys.has(key)) continue;
    const data = sanitizeNodeData(
      type,
      (n.data && typeof n.data === "object" ? n.data : {}) as Record<string, unknown>,
      { warnings },
    );
    if (!data) continue;
    const pos = (n.position ?? {}) as Record<string, unknown>;
    const size = (n.size ?? {}) as Record<string, unknown>;
    keys.add(key);
    nodes.push({
      key,
      type,
      position: { x: num(pos.x, 0, -50_000, 50_000), y: num(pos.y, 0, -50_000, 50_000) },
      size: {
        width: num(size.width, defaultSize(type).width, 40, 4000),
        height: num(size.height, defaultSize(type).height, 30, 4000),
      },
      parent: typeof n.parent === "string" ? n.parent : undefined,
      data,
    });
  }
  // `parent` só vale se apontar para um grupo incluído.
  const groups = new Set(nodes.filter((n) => n.type === "group").map((n) => n.key));
  for (const n of nodes) {
    if (n.parent && (!groups.has(n.parent) || n.parent === n.key)) delete n.parent;
    if (n.type === "group") delete n.parent; // sem grupos aninhados
  }

  const edges: PartituraEdge[] = [];
  const seen = new Set<string>();
  for (const re of Array.isArray(r.edges) ? (r.edges as unknown[]) : []) {
    if (!re || typeof re !== "object") continue;
    const e = re as Record<string, unknown>;
    const s = str(e.source, 64);
    const t = str(e.target, 64);
    if (!keys.has(s) || !keys.has(t) || s === t) continue;
    const k = `${s}>${t}`;
    if (seen.has(k)) continue;
    seen.add(k);
    edges.push({ source: s, target: t });
  }

  const now = Date.now();
  const id = typeof r.id === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(r.id) ? r.id : newPartituraId();
  return {
    partitura: {
      kind: PARTITURA_KIND,
      formatVersion: PARTITURA_VERSION,
      id,
      name: str(r.name, 120) || "Partitura sem nome",
      description: str(r.description, 2000),
      createdAt: num(r.createdAt, now, 0, 1e15),
      updatedAt: num(r.updatedAt, now, 0, 1e15),
      ...(opts.builtin ? { builtin: true } : {}),
      nodes,
      edges,
    },
    warnings,
  };
}

function defaultSize(type: PartituraNodeType): { width: number; height: number } {
  switch (type) {
    case "terminal":
      return { width: 500, height: 340 };
    case "note":
      return { width: 280, height: 200 };
    case "text":
      return { width: 220, height: 60 };
    case "browser":
      return { width: 560, height: 420 };
    case "group":
      return { width: 600, height: 400 };
  }
}

// ---------------------------------------------------------------- canvas → partitura

export interface SnapshotOptions {
  name: string;
  description?: string;
  includeNoteContent?: boolean;
}

/**
 * Monta uma partitura a partir de nós do canvas. `pick` são os nós escolhidos
 * (seleção); grupos levam os filhos junto. Tipos não suportados (imagem etc.)
 * ficam de fora.
 */
export function snapshotPartitura(
  pick: Node[],
  all: Node[],
  allEdges: Edge[],
  opts: SnapshotOptions,
): Partitura {
  const ids = new Set(pick.map((n) => n.id));
  // Inclui descendentes de grupos escolhidos.
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of all) {
      if (n.parentId && ids.has(n.parentId) && !ids.has(n.id)) {
        ids.add(n.id);
        grew = true;
      }
    }
  }
  const chosen = all.filter(
    (n) => ids.has(n.id) && NODE_TYPES.includes(n.type as PartituraNodeType),
  );
  const chosenIds = new Set(chosen.map((n) => n.id));
  const keyOf = new Map(chosen.map((n, i) => [n.id, `n${i + 1}`]));

  // Origem do layout: canto da caixa dos nós de topo (filhos ficam relativos ao grupo).
  const isTop = (n: Node) => !n.parentId || !chosenIds.has(n.parentId);
  let minX = Infinity;
  let minY = Infinity;
  for (const n of chosen.filter(isTop)) {
    const p = absolutePosition(n, all);
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
  }
  if (!Number.isFinite(minX)) minX = minY = 0;

  const nodes: PartituraNode[] = [];
  for (const n of chosen) {
    const type = n.type as PartituraNodeType;
    const data = sanitizeNodeData(type, (n.data ?? {}) as Record<string, unknown>, {
      includeNoteContent: opts.includeNoteContent !== false,
    });
    if (!data) continue;
    const top = isTop(n);
    const abs = absolutePosition(n, all);
    const size = nodeSize(n);
    nodes.push({
      key: keyOf.get(n.id)!,
      type,
      position: top
        ? { x: Math.round(abs.x - minX), y: Math.round(abs.y - minY) }
        : { x: Math.round(n.position.x), y: Math.round(n.position.y) },
      size: { width: Math.round(size.width), height: Math.round(size.height) },
      ...(top || type === "group" ? {} : { parent: keyOf.get(n.parentId!)! }),
      data,
    });
  }
  const edges = allEdges
    .filter((e) => chosenIds.has(e.source) && chosenIds.has(e.target))
    .map((e) => ({ source: keyOf.get(e.source)!, target: keyOf.get(e.target)! }));

  const now = Date.now();
  // Passa pela sanitização para garantir o mesmo formato de um import.
  return sanitizePartitura({
    kind: PARTITURA_KIND,
    formatVersion: PARTITURA_VERSION,
    id: newPartituraId(),
    name: opts.name,
    description: opts.description ?? "",
    createdAt: now,
    updatedAt: now,
    nodes,
    edges,
  }).partitura;
}

// ---------------------------------------------------------------- partitura → canvas

/** Tamanho total do layout (só peças de topo). */
export function layoutSize(p: Partitura): { width: number; height: number } {
  let w = 0;
  let h = 0;
  for (const n of p.nodes) {
    if (n.parent) continue;
    w = Math.max(w, n.position.x + n.size.width);
    h = Math.max(h, n.position.y + n.size.height);
  }
  return { width: w, height: h };
}

export interface InstantiateOptions {
  /** Canto superior esquerdo do layout no canvas. */
  origin: XYPosition;
  /** Pasta de trabalho herdada pelos terminais (ex.: do terminal selecionado). */
  cwd?: string;
  /** Títulos já usados no canvas (para não duplicar — o roteamento usa o título). */
  takenTitles?: Set<string>;
  /** `false` insere as notas em branco. */
  includeNoteContent?: boolean;
}

export function instantiatePartitura(
  p: Partitura,
  opts: InstantiateOptions,
): { nodes: Node[]; edges: Edge[]; idMap: Record<string, string> } {
  const taken = new Set([...(opts.takenTitles ?? [])].map((t) => t.toLowerCase()));
  const uniqueTitle = (t: string) => {
    let title = t;
    let i = 2;
    while (taken.has(title.toLowerCase())) title = `${t} ${i++}`;
    taken.add(title.toLowerCase());
    return title;
  };
  const idMap: Record<string, string> = {};
  for (const n of p.nodes) {
    const prefix = n.type === "terminal" ? String(n.data.agent) : n.type;
    idMap[n.key] = newNodeId(prefix);
  }
  const nodes: Node[] = p.nodes.map((n) => {
    let data: Record<string, unknown> = { ...n.data };
    if (n.type === "terminal") {
      data.title = uniqueTitle(String(data.title ?? "Agente"));
      if (opts.cwd) data.cwd = opts.cwd;
    }
    if (n.type === "note" && opts.includeNoteContent === false) data = { ...data, content: "" };
    const parentId = n.parent ? idMap[n.parent] : undefined;
    return {
      id: idMap[n.key],
      type: n.type,
      position: parentId
        ? { ...n.position }
        : { x: opts.origin.x + n.position.x, y: opts.origin.y + n.position.y },
      data,
      style: { width: n.size.width, height: n.size.height },
      selected: true,
      ...(parentId ? { parentId } : {}),
    } as Node;
  });
  const edges: Edge[] = p.edges.map((e) => ({
    id: newEdgeId(idMap[e.source], idMap[e.target]),
    source: idMap[e.source],
    target: idMap[e.target],
    animated: true,
  }));
  // Pais antes dos filhos.
  nodes.sort((a, b) => (a.type === "group" ? 0 : 1) - (b.type === "group" ? 0 : 1));
  return { nodes, edges, idMap };
}

// ---------------------------------------------------------------- revisão / prévia

export interface PartituraSummary {
  terminals: {
    title: string;
    agent: string;
    agentLabel: string;
    command: string;
    args: string[];
    role?: string;
    maestro: boolean;
  }[];
  notes: { title: string; hasContent: boolean }[];
  texts: number;
  browsers: string[];
  groups: string[];
  edges: number;
}

export function summarizePartitura(p: Partitura): PartituraSummary {
  const s: PartituraSummary = {
    terminals: [],
    notes: [],
    texts: 0,
    browsers: [],
    groups: [],
    edges: p.edges.length,
  };
  for (const n of p.nodes) {
    const d = n.data;
    if (n.type === "terminal") {
      const def = AGENTS[d.agent as AgentId];
      const { command, args } = def.resolve();
      s.terminals.push({
        title: String(d.title ?? def.label),
        agent: def.id,
        agentLabel: def.label,
        command,
        args,
        role: d.role ? ROLE_MAP[String(d.role)]?.label : undefined,
        maestro: d.maestro === true,
      });
    } else if (n.type === "note") {
      s.notes.push({ title: String(d.title ?? "Nota"), hasContent: !!String(d.content ?? "").trim() });
    } else if (n.type === "text") s.texts += 1;
    else if (n.type === "browser") s.browsers.push(String(d.url ?? "(sem URL)"));
    else if (n.type === "group") s.groups.push(String(d.title ?? "Grupo"));
  }
  return s;
}

/** Retângulos absolutos das peças, para a miniatura no painel. */
export function previewRects(
  p: Partitura,
): { x: number; y: number; w: number; h: number; type: PartituraNodeType; color: string }[] {
  const byKey = new Map(p.nodes.map((n) => [n.key, n]));
  return p.nodes.map((n) => {
    const parent = n.parent ? byKey.get(n.parent) : undefined;
    const x = n.position.x + (parent?.position.x ?? 0);
    const y = n.position.y + (parent?.position.y ?? 0);
    let color = "var(--text-muted)";
    if (n.type === "terminal") {
      const role = n.data.role ? ROLE_MAP[String(n.data.role)] : undefined;
      color = role?.color ?? AGENTS[n.data.agent as AgentId]?.color ?? color;
    } else if (n.type === "note") {
      color = noteColorValue(n.data.color);
    } else if (n.type === "browser") color = "var(--info)";
    else if (n.type === "group") color = "var(--accent)";
    return { x, y, w: n.size.width, h: n.size.height, type: n.type, color };
  });
}

// ---------------------------------------------------------------- embutidas

function builtin(
  id: string,
  name: string,
  description: string,
  nodes: Omit<PartituraNode, "size">[],
  edges: PartituraEdge[],
): Partitura {
  return sanitizePartitura(
    {
      kind: PARTITURA_KIND,
      formatVersion: PARTITURA_VERSION,
      id,
      name,
      description,
      createdAt: 0,
      updatedAt: 0,
      nodes: nodes.map((n) => ({ ...n, size: defaultSize(n.type) })),
      edges,
    },
    { builtin: true },
  ).partitura;
}

const term = (key: string, x: number, y: number, title: string, role: string, extra = {}) => ({
  key,
  type: "terminal" as const,
  position: { x, y },
  data: { agent: "claude", title, role, ...extra },
});

export const BUILTIN_PARTITURAS: Partitura[] = [
  builtin(
    "builtin-dupla",
    "Dupla: Engenheiro + Revisor",
    "Um engenheiro implementa e um revisor avalia o resultado.",
    [term("eng", 0, 0, "Engenheiro", "engineer"), term("rev", 560, 0, "Revisor", "reviewer")],
    [{ source: "eng", target: "rev" }],
  ),
  builtin(
    "builtin-squad",
    "Squad: Orquestrador + Arquiteto + Engenheiro + Testador",
    "O orquestrador lê o objetivo na nota, delega ao arquiteto, ao engenheiro e ao testador e consolida.",
    [
      {
        key: "goal",
        type: "note",
        position: { x: 110, y: 120 },
        data: {
          title: "Objetivo",
          content:
            "## Objetivo\n\nDescreva aqui o que a equipe deve entregar.\n\n- [ ] Critério de aceite 1\n- [ ] Critério de aceite 2\n",
          color: "amber",
        },
      },
      term("orq", 0, 380, "Orquestrador", "orquestrador", { maestro: true }),
      term("arq", 580, 0, "Arquiteto", "architect"),
      term("eng", 580, 380, "Engenheiro", "engineer"),
      term("qa", 580, 760, "Testador", "tester"),
    ],
    [
      { source: "orq", target: "goal" },
      { source: "orq", target: "arq" },
      { source: "orq", target: "eng" },
      { source: "orq", target: "qa" },
      { source: "arq", target: "eng" },
    ],
  ),
  builtin(
    "builtin-plano",
    "Plano + Execução: Arquiteto + Engenheiro",
    "O arquiteto escreve o plano numa nota compartilhada e o engenheiro executa.",
    [
      term("arq", 0, 0, "Arquiteto", "architect"),
      {
        key: "plan",
        type: "note",
        position: { x: 560, y: 0 },
        data: { title: "Plano", content: "", color: "blue" },
      },
      term("eng", 900, 0, "Engenheiro", "engineer"),
    ],
    [
      { source: "arq", target: "plan" },
      { source: "eng", target: "plan" },
      { source: "arq", target: "eng" },
    ],
  ),
];

// ---------------------------------------------------------------- backend

export async function partiturasList(): Promise<Partitura[]> {
  const raw = await invoke<unknown[]>("partituras_list");
  const out: Partitura[] = [];
  for (const r of raw) {
    try {
      out.push(sanitizePartitura(r).partitura);
    } catch {
      /* arquivo inválido no disco: ignora */
    }
  }
  return out;
}

const stripBuiltin = (p: Partitura): Partitura => {
  const { builtin: _b, ...rest } = p;
  return rest as Partitura;
};

export function partiturasSave(p: Partitura): Promise<unknown[]> {
  return invoke("partituras_save", { partitura: stripBuiltin(p) });
}
export function partiturasDelete(id: string): Promise<unknown[]> {
  return invoke("partituras_delete", { id });
}
export function partiturasExport(path: string, p: Partitura): Promise<void> {
  return invoke("partituras_export", { path, partitura: stripBuiltin(p) });
}
export function partiturasImport(path: string): Promise<unknown> {
  return invoke("partituras_import", { path });
}
