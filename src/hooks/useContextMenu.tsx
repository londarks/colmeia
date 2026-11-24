// Menu de contexto (clique direito) em nó, seleção, aresta e fundo do canvas, e o
// popover de renomear (F2). Os itens chamam as ações de useNodeActions / useLayout /
// useGrouping / useDock — este hook só monta os menus.

import { useCallback, useState, type ReactNode } from "react";
import { useReactFlow, type Edge, type Node, type XYPosition } from "@xyflow/react";
import { AGENT_LIST } from "../lib/agents";
import { liftTerminal } from "../lib/terminalRegistry";
import { EDGE_PATHS, alreadyConnected, kindsCompatible, type EdgePath } from "../lib/connections";
import { ALIGN_LABELS, type AlignMode } from "../lib/layout";
import { absolutePosition, type CanvasApi } from "../lib/canvas";
import { ContextMenu, type MenuEntry, type MenuItem } from "../components/ContextMenu";
import type { NodeActions } from "./useNodeActions";
import type { LayoutApi } from "./useLayout";
import type { DockApi } from "./useDock";

type MenuState =
  | { kind: "node"; x: number; y: number; ids: string[]; nodeId: string }
  | { kind: "edge"; x: number; y: number; edgeId: string }
  | { kind: "pane"; x: number; y: number; at: XYPosition }
  | null;

interface RenameState {
  id: string;
  x: number;
  y: number;
  value: string;
}

export interface ContextMenuDeps {
  api: CanvasApi;
  actions: NodeActions;
  layout: LayoutApi;
  grouping: { groupSelection: () => string | null; ungroup: (ids: string[]) => void };
  dock: DockApi;
  snap: {
    gridOn: boolean;
    setGridOn: (v: boolean | ((p: boolean) => boolean)) => void;
    guidesOn: boolean;
    setGuidesOn: (v: boolean | ((p: boolean) => boolean)) => void;
  };
  focusNode: (id: string) => void;
  openComposer: (mentionIds?: string[]) => void;
}

const titleOf = (n: Node | undefined) =>
  String((n?.data as { title?: string } | undefined)?.title ?? n?.id ?? "");
const RENAMABLE = new Set(["terminal", "note", "browser", "group", "image"]);
const MAX_TARGETS = 40;

export function useContextMenu(deps: ContextMenuDeps) {
  const rf = useReactFlow();
  const [menu, setMenu] = useState<MenuState>(null);
  const [renaming, setRenaming] = useState<RenameState | null>(null);
  const close = useCallback(() => setMenu(null), []);
  const { api, actions } = deps;

  // ---- Abertura -------------------------------------------------------------

  const onNodeContextMenu = useCallback(
    (e: React.MouseEvent, node: Node) => {
      // Campo de texto (nota em edição, título...): deixa o menu nativo (copiar/colar/ortografia).
      const t = e.target as HTMLElement | null;
      if (
        t?.closest?.("input, textarea, [contenteditable=''], [contenteditable='true']") &&
        !t.closest(".xterm")
      ) {
        return;
      }
      e.preventDefault();
      const sel = api.nodesRef.current.filter((n) => n.selected).map((n) => n.id);
      // Clique direito fora da seleção: age só sobre este nó (e o seleciona).
      const ids = node.selected && sel.length ? sel : [node.id];
      if (!node.selected) actions.selectOnly([node.id]);
      setMenu({ kind: "node", x: e.clientX, y: e.clientY, ids, nodeId: node.id });
    },
    [api, actions],
  );

  const onSelectionContextMenu = useCallback((e: React.MouseEvent, nodes: Node[]) => {
    e.preventDefault();
    if (!nodes.length) return;
    setMenu({ kind: "node", x: e.clientX, y: e.clientY, ids: nodes.map((n) => n.id), nodeId: nodes[0].id });
  }, []);

  const onEdgeContextMenu = useCallback((e: React.MouseEvent, edge: Edge) => {
    e.preventDefault();
    setMenu({ kind: "edge", x: e.clientX, y: e.clientY, edgeId: edge.id });
  }, []);

  const onPaneContextMenu = useCallback(
    (e: React.MouseEvent | MouseEvent) => {
      e.preventDefault();
      const at = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      setMenu({ kind: "pane", x: e.clientX, y: e.clientY, at });
    },
    [rf],
  );

  /** Abre o popover de renomear sobre o nó (F2 ou menu). */
  const startRename = useCallback(
    (id: string, at?: { x: number; y: number }) => {
      const n = api.nodesRef.current.find((m) => m.id === id);
      if (!n || !RENAMABLE.has(n.type ?? "")) return;
      let pos = at;
      if (!pos) {
        const b = actions.boundsFor([id]);
        pos = b ? rf.flowToScreenPosition({ x: b.x, y: b.y }) : { x: 200, y: 200 };
      }
      setRenaming({ id, x: pos.x, y: pos.y, value: titleOf(n) });
    },
    [api, actions, rf],
  );

  // ---- Itens ----------------------------------------------------------------

  const nodeEntries = (ids: string[], nodeId: string): MenuEntry[] => {
    const all = api.nodesRef.current;
    const edges = api.edgesRef.current;
    const pick = all.filter((n) => ids.includes(n.id));
    const node = all.find((n) => n.id === nodeId);
    if (!node || !pick.length) return [];
    const single = pick.length === 1;
    const isTerm = node.type === "terminal";
    const isGroup = node.type === "group";
    const d = node.data as { pinned?: boolean; band?: boolean; docked?: boolean };
    const allPinned = pick.every((n) => (n.data as { pinned?: boolean }).pinned);
    const groupable = pick.filter((n) => !n.parentId && n.type !== "group");
    const groups = pick.filter((n) => n.type === "group").map((n) => n.id);
    const inGroup = pick.filter((n) => n.parentId);
    const out: MenuEntry[] = [];

    if (single && RENAMABLE.has(node.type ?? "")) {
      out.push({ label: "Renomear", hint: "F2", onSelect: () => startRename(node.id, { x: menu?.x ?? 0, y: menu?.y ?? 0 }) });
    }
    if (single && isTerm) {
      out.push({ label: "Expandir (Lift)", hint: "F11", onSelect: () => liftTerminal(node.id) });
      out.push(
        d.docked
          ? { label: "Devolver ao canvas", onSelect: () => deps.dock.undock(node.id) }
          : { label: "Estacionar no Dock", onSelect: () => deps.dock.dock([node.id]) },
      );
    } else if (pick.some((n) => n.type === "terminal")) {
      out.push({
        label: "Estacionar terminais no Dock",
        onSelect: () => deps.dock.dock(pick.filter((n) => n.type === "terminal").map((n) => n.id)),
      });
    }
    if (pick.some((n) => n.type === "terminal" || n.type === "note")) {
      out.push({
        label: single && isTerm ? "Escrever para este agente…" : "Perguntar sobre a seleção…",
        hint: "Ctrl+Enter",
        onSelect: () => deps.openComposer(ids),
      });
    }
    if (out.length) out.push("separator");

    out.push({ label: "Duplicar", hint: "Ctrl+D", onSelect: () => actions.duplicate(ids) });
    out.push({ label: "Copiar", hint: "Ctrl+C", onSelect: () => actions.copy(ids) });
    out.push({
      label: allPinned ? "Destravar posição" : "Travar posição",
      hint: "Ctrl+Shift+L",
      checked: allPinned,
      onSelect: () => actions.togglePin(ids),
    });
    out.push({ label: "Trazer para frente", hint: "Ctrl+]", onSelect: () => actions.bringToFront(ids) });
    out.push({ label: "Enviar para trás", hint: "Ctrl+[", onSelect: () => actions.sendToBack(ids) });
    out.push("separator");

    if (groupable.length) {
      out.push({
        label: "Agrupar",
        hint: "Ctrl+G",
        onSelect: () => {
          actions.selectOnly(groupable.map((n) => n.id));
          // O seletor precisa ver a seleção nova: espera o estado aplicar.
          requestAnimationFrame(() => deps.grouping.groupSelection());
        },
      });
    }
    if (groups.length) {
      out.push({ label: "Desagrupar", hint: "Ctrl+Shift+G", onSelect: () => deps.grouping.ungroup(groups) });
    }
    if (single && isGroup) {
      out.push({
        label: "Band (todos-com-todos)",
        checked: !!d.band,
        onSelect: () => actions.toggleBand(node.id),
      });
    }
    if (inGroup.length) {
      out.push({
        label: "Tirar do grupo",
        onSelect: () => {
          // Só estes filhos voltam ao topo, na mesma posição da tela.
          const ids2 = new Set(inGroup.map((n) => n.id));
          api.setNodes((nds) =>
            nds.map((n) => {
              if (!ids2.has(n.id)) return n;
              const abs = absolutePosition(n, nds);
              const { parentId: _p, extent: _e, ...rest } = n;
              return { ...rest, position: abs } as Node;
            }),
          );
        },
      });
    }

    if (single) {
      const targets = all
        .filter((m) => m.id !== node.id && !m.hidden && kindsCompatible(node, m) && !alreadyConnected(edges, node.id, m.id))
        .slice(0, MAX_TARGETS);
      const neighbors = edges
        .filter((e) => e.source === node.id || e.target === node.id)
        .map((e) => (e.source === node.id ? e.target : e.source));
      const conn: MenuItem = {
        label: "Conectar a…",
        disabled: targets.length === 0,
        submenu: targets.map((m) => ({ label: `${titleOf(m)}`, hint: kindLabel(m), onSelect: () => actions.connect(node.id, m.id) })),
      };
      out.push(conn);
      if (neighbors.length) {
        out.push({
          label: "Desconectar de…",
          submenu: [...new Set(neighbors)].map((id) => {
            const m = all.find((x) => x.id === id);
            return { label: titleOf(m) || id, hint: kindLabel(m), onSelect: () => actions.disconnect(node.id, id) };
          }),
        });
      }
    }

    if (pick.length >= 2) {
      out.push("separator");
      out.push({
        label: "Alinhar",
        submenu: (Object.keys(ALIGN_LABELS) as AlignMode[]).map((m) => ({
          label: ALIGN_LABELS[m],
          hint: ALIGN_HINTS[m],
          onSelect: () => deps.layout.align(m, ids),
        })),
      });
      out.push({
        label: "Distribuir",
        disabled: pick.length < 3,
        submenu: [
          { label: "Horizontalmente", hint: "Alt+Shift+H", onSelect: () => deps.layout.distribute("h", ids) },
          { label: "Verticalmente", hint: "Alt+Shift+V", onSelect: () => deps.layout.distribute("v", ids) },
        ],
      });
      out.push({ label: "Arrumar seleção", hint: "Ctrl+Shift+T", onSelect: () => deps.layout.tidy(ids) });
    }

    out.push("separator");
    out.push({
      label: single ? "Excluir" : `Excluir ${pick.length} nós`,
      hint: "Delete",
      danger: true,
      onSelect: () => actions.remove(ids),
    });
    return out;
  };

  const edgeEntries = (edgeId: string): MenuEntry[] => {
    const e = api.edgesRef.current.find((x) => x.id === edgeId);
    if (!e) return [];
    const d = (e.data ?? {}) as { path?: EdgePath; kind?: "data" | "control" };
    const cur = d.path ?? "bezier";
    return [
      ...EDGE_PATHS.map(
        (p): MenuItem => ({
          label: `Traçado: ${p.label}`,
          checked: cur === p.id,
          onSelect: () => actions.setEdgePath(edgeId, p.id),
        }),
      ),
      "separator",
      { label: "Tipo: dados", checked: d.kind !== "control", onSelect: () => actions.setEdgeData(edgeId, { kind: "data" }) },
      { label: "Tipo: controle", checked: d.kind === "control", onSelect: () => actions.setEdgeData(edgeId, { kind: "control" }) },
      "separator",
      { label: "Ir para a origem", onSelect: () => deps.focusNode(e.source) },
      { label: "Ir para o destino", onSelect: () => deps.focusNode(e.target) },
      "separator",
      { label: "Excluir conexão", danger: true, onSelect: () => actions.removeEdge(edgeId) },
    ];
  };

  const paneEntries = (at: XYPosition): MenuEntry[] => [
    {
      label: "Novo agente aqui",
      submenu: AGENT_LIST.map((a) => ({ label: a.label, onSelect: () => actions.addAgentAt(a.id, at) })),
    },
    { label: "Nova nota aqui", onSelect: () => actions.addNoteAt(at) },
    { label: "Novo texto aqui", onSelect: () => actions.addTextAt(at) },
    { label: "Colar aqui", hint: "Ctrl+V", onSelect: () => void actions.pasteAt(at) },
    "separator",
    { label: "Enquadrar tudo", hint: "F", onSelect: actions.fitAll },
    { label: "Arrumar o canvas", hint: "Ctrl+Shift+T", onSelect: () => deps.layout.tidy("all") },
    "separator",
    {
      label: "Encaixar na grade",
      hint: "Alt+G",
      checked: deps.snap.gridOn,
      onSelect: () => deps.snap.setGridOn((v) => !v),
    },
    {
      label: "Guias magnéticas",
      checked: deps.snap.guidesOn,
      onSelect: () => deps.snap.setGuidesOn((v) => !v),
    },
    {
      label: "Mostrar o Dock",
      hint: "Ctrl+Shift+D",
      checked: deps.dock.open,
      onSelect: () => deps.dock.setOpen((v) => !v),
    },
    { label: "Composer", hint: "Ctrl+Enter", onSelect: () => deps.openComposer() },
  ];

  // ---- Render ---------------------------------------------------------------

  let element: ReactNode = null;
  if (menu) {
    const entries =
      menu.kind === "node"
        ? nodeEntries(menu.ids, menu.nodeId)
        : menu.kind === "edge"
          ? edgeEntries(menu.edgeId)
          : paneEntries(menu.at);
    element = <ContextMenu x={menu.x} y={menu.y} entries={entries} onClose={close} />;
  }

  const renameEl = renaming ? (
    <div className="ux-rename" style={{ left: renaming.x, top: renaming.y }}>
      <input
        autoFocus
        value={renaming.value}
        onChange={(e) => setRenaming({ ...renaming, value: e.target.value })}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            actions.rename(renaming.id, renaming.value);
            setRenaming(null);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setRenaming(null);
          }
        }}
        onBlur={() => {
          actions.rename(renaming.id, renaming.value);
          setRenaming(null);
        }}
      />
    </div>
  ) : null;

  return {
    flowProps: { onNodeContextMenu, onSelectionContextMenu, onEdgeContextMenu, onPaneContextMenu },
    startRename,
    element: (
      <>
        {element}
        {renameEl}
      </>
    ),
  };
}

const ALIGN_HINTS: Record<AlignMode, string> = {
  left: "Alt+Shift+←",
  center: "Alt+Shift+C",
  right: "Alt+Shift+→",
  top: "Alt+Shift+↑",
  middle: "Alt+Shift+M",
  bottom: "Alt+Shift+↓",
};

function kindLabel(n: Node | undefined): string {
  switch (n?.type) {
    case "terminal":
      return "agente";
    case "note":
      return "nota";
    case "browser":
      return "portal";
    case "group":
      return "band";
    default:
      return "";
  }
}
