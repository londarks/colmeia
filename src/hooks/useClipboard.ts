// Copiar/colar nós do canvas (Ctrl+C / Ctrl+V) pelo clipboard do sistema, só
// quando o foco não está num terminal ou campo de texto. Copia os nós
// selecionados + as arestas internas; cola deslocado, com ids novos (terminais
// colados sobem processos novos). Colar imagem → ImageNode; colar URL → browser.

import { useEffect, useRef } from "react";
import { useReactFlow, type Edge, type Node } from "@xyflow/react";
import { AGENTS } from "../lib/agents";
import {
  absolutePosition,
  isEditableTarget,
  newEdgeId,
  newNodeId,
  nodeSize,
  sortParentsFirst,
  viewportCenterClient,
  type CanvasApi,
} from "../lib/canvas";
import { blobToDataUrl } from "../lib/images";
import { isHttpUrl, makeBrowserNode, makeImageNode } from "../lib/nodeFactory";

export const MARKER = "colmeia/nodes@1";
const PASTE_STEP = 40;
const KNOWN_TYPES = new Set(["terminal", "note", "text", "browser", "image", "group"]);
// Campos transitórios ou de privilégio que não viajam no clipboard.
const DROP_FIELDS = ["waiting", "command", "autoApproveInCwd", "docked"];

interface ClipNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  parentId?: string;
  data: Record<string, unknown>;
  style: { width: number; height: number };
}
export interface ClipPayload {
  colmeia: typeof MARKER;
  nodes: ClipNode[];
  edges: { source: string; target: string }[];
}

function cleanData(data: unknown): Record<string, unknown> {
  const out = { ...((data ?? {}) as Record<string, unknown>) };
  for (const f of DROP_FIELDS) delete out[f];
  return out;
}

/** Payload de clipboard dos nós selecionados (também usado pelo menu de contexto). */
export function buildPayload(all: Node[], edges: Edge[]): ClipPayload | null {
  const ids = new Set(all.filter((n) => n.selected).map((n) => n.id));
  if (ids.size === 0) return null;
  // Grupo copiado leva os filhos.
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
  const chosen = sortParentsFirst(all.filter((n) => ids.has(n.id) && KNOWN_TYPES.has(n.type ?? "")));
  const nodes: ClipNode[] = chosen.map((n) => {
    const keepParent = !!n.parentId && ids.has(n.parentId);
    return {
      id: n.id,
      type: n.type!,
      position: keepParent ? { ...n.position } : absolutePosition(n, all),
      ...(keepParent ? { parentId: n.parentId } : {}),
      data: cleanData(n.data),
      style: nodeSize(n),
    };
  });
  return {
    colmeia: MARKER,
    nodes,
    edges: edges
      .filter((e) => ids.has(e.source) && ids.has(e.target))
      .map((e) => ({ source: e.source, target: e.target })),
  };
}

export function parsePayload(text: string): ClipPayload | null {
  if (!text || !text.includes(MARKER)) return null;
  try {
    const p = JSON.parse(text) as ClipPayload;
    return p && p.colmeia === MARKER && Array.isArray(p.nodes) ? p : null;
  } catch {
    return null;
  }
}

export function useClipboard(api: CanvasApi) {
  const { screenToFlowPosition } = useReactFlow();
  const pasteCount = useRef(0);
  const lastCopied = useRef("");

  useEffect(() => {
    const blocked = (e: Event) =>
      isEditableTarget(e.target) || isEditableTarget(document.activeElement);

    const onCopy = (e: ClipboardEvent) => {
      if (blocked(e)) return;
      // Texto selecionado (ex.: numa nota renderizada) copia normalmente.
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().trim()) return;
      const payload = buildPayload(api.nodesRef.current, api.edgesRef.current);
      if (!payload || !e.clipboardData) return;
      const text = JSON.stringify(payload);
      e.clipboardData.setData("text/plain", text);
      e.preventDefault();
      lastCopied.current = text;
      pasteCount.current = 0;
    };

    const pasteNodes = (p: ClipPayload, text: string) => {
      if (text !== lastCopied.current) {
        lastCopied.current = text;
        pasteCount.current = 0;
      }
      pasteCount.current += 1;
      const off = PASTE_STEP * pasteCount.current;
      insertClipPayload(api, p, off, off);
    };

    const onPaste = (e: ClipboardEvent) => {
      if (blocked(e) || !e.clipboardData) return;
      const dt = e.clipboardData;
      const text = dt.getData("text/plain");
      const payload = parsePayload(text);
      if (payload) {
        e.preventDefault();
        pasteNodes(payload, text);
        return;
      }
      const at = screenToFlowPosition(viewportCenterClient());
      const image = Array.from(dt.files).find((f) => f.type.startsWith("image/"));
      if (image) {
        e.preventDefault();
        blobToDataUrl(image)
          .then((url) => makeImageNode(url, at, image.name))
          .then((node) => api.setNodes((nds) => nds.concat(node)))
          .catch(() => {});
        return;
      }
      if (isHttpUrl(text)) {
        e.preventDefault();
        api.setNodes((nds) => nds.concat(makeBrowserNode(text.trim(), at)));
      }
    };

    document.addEventListener("copy", onCopy);
    document.addEventListener("paste", onPaste);
    return () => {
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("paste", onPaste);
    };
  }, [api, screenToFlowPosition]);
}

/**
 * Insere os nós de um payload com ids novos (terminais sobem processos novos e
 * ganham título único), deslocando os nós de topo por (dx, dy). Os colados ficam
 * selecionados. Devolve os ids novos dos nós de topo.
 */
export function insertClipPayload(api: CanvasApi, p: ClipPayload, dx: number, dy: number): string[] {
  const taken = new Set(
    api.nodesRef.current
      .filter((n) => n.type === "terminal")
      .map((n) => String((n.data as { title?: string }).title ?? n.id).toLowerCase()),
  );
  const uniqueTitle = (t: string) => {
    let title = t;
    let i = 2;
    while (taken.has(title.toLowerCase())) title = `${t} ${i++}`;
    taken.add(title.toLowerCase());
    return title;
  };

  const valid = p.nodes.filter(
    (n) =>
      n &&
      KNOWN_TYPES.has(n.type) &&
      (n.type !== "terminal" || String(n.data?.agent) in AGENTS),
  );
  const idMap = new Map<string, string>();
  for (const n of valid) {
    const prefix = n.type === "terminal" ? String(n.data.agent) : n.type;
    idMap.set(n.id, newNodeId(prefix));
  }
  const created: Node[] = valid.map((n) => {
    const parentId = n.parentId ? idMap.get(n.parentId) : undefined;
    const data = cleanData(n.data);
    if (n.type === "terminal") data.title = uniqueTitle(String(data.title ?? "Agente"));
    return {
      id: idMap.get(n.id)!,
      type: n.type,
      position: parentId ? { ...n.position } : { x: n.position.x + dx, y: n.position.y + dy },
      data,
      style: { width: n.style?.width ?? 240, height: n.style?.height ?? 160 },
      selected: !parentId,
      ...(parentId ? { parentId } : {}),
    } as Node;
  });
  const newEdges: Edge[] = (p.edges ?? [])
    .filter((e) => idMap.has(e.source) && idMap.has(e.target))
    .map((e) => {
      const s = idMap.get(e.source)!;
      const t = idMap.get(e.target)!;
      return { id: newEdgeId(s, t), source: s, target: t, animated: true };
    });
  api.setNodes((nds) =>
    nds
      .map((n): Node => (n.selected ? { ...n, selected: false } : n))
      .concat(sortParentsFirst(created)),
  );
  if (newEdges.length) api.setEdges((eds) => eds.concat(newEdges));
  return created.filter((n) => !n.parentId).map((n) => n.id);
}
