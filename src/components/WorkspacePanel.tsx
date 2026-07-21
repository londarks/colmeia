// Árvore de workspaces na sidebar: pastas colapsáveis, drag & drop de
// workspaces para dentro/fora de pastas, renomear (duplo clique), cor,
// botões estilo "New Tab" e menu de contexto (botão direito).
//
// Esta camada é puramente de UI: ela consome os comandos id-based que já
// existem (workspaces_list / create / rename / delete / set_active / load /
// save), expostos pelo App via os callbacks abaixo. A identidade de cada
// workspace é o `id`; o `name` é só rótulo. Pastas e cores são metadados
// locais, guardados por id.

import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  FolderPlus,
  Plus,
} from "lucide-react";
import type { WorkspaceMeta } from "../lib/pty";

// 10 cores simples para os workspaces.
export const WS_COLORS = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#14b8a6",
  "#3b82f6",
  "#6366f1",
  "#a855f7",
  "#ec4899",
  "#9ca3af",
];

interface WsFolder {
  id: string;
  name: string;
  open: boolean;
}
interface WsMeta {
  folders: WsFolder[];
  // chaveado pelo id do workspace (estável entre renomeações).
  ws: Record<string, { folder: string | null; color: string }>;
}
interface MenuData {
  x: number;
  y: number;
  workspace?: string;
  folder?: string
}
interface EditInfo {
  kind: "ws" | "folder";
  id: string
}
// Alvo de uma remoção pendente (workspaces soltos + pastas em cascata).
interface DeleteTarget {
  wsIds: string[]; // workspaces removidos diretamente
  folderIds: string[]; // pastas removidas (cascata: leva os workspaces dentro)
}

const EMPTY_META: WsMeta = { folders: [], ws: {} };
const META_KEY = "colmeia.ws-meta";
const DND_TYPE = "text/colmeia-ws"; // carrega o id do workspace arrastado.

// metadados de pasta/cor ficam em localStorage; sem comando de
// backend dedicado. Se um dia precisar sincronizar entre máquinas,
// implementar um par workspace_meta_load/save no Rust.
function loadMeta(): WsMeta {
  try {
    const raw = localStorage.getItem(META_KEY);
    if (!raw) return EMPTY_META;
    const v = JSON.parse(raw) as WsMeta;
    if (v && Array.isArray(v.folders) && v.ws) return v;
  } catch {
    console.error("Erro ao carregar metadados dos workspaces!");
  }
  return EMPTY_META;
}

interface Props {
  items: WorkspaceMeta[];
  active: string; // id do workspace ativo
  onSwitch: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string, name: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onDeleteMany: (ids: string[]) => Promise<void>;
}

export function WorkspacePanel({
  items,
  active,
  onSwitch,
  onCreate,
  onRename,
  onDelete,
  onDeleteMany,
}: Props) {
  const [meta, setMeta] = useState<WsMeta>(loadMeta);
  const [editing, setEditing] = useState<EditInfo | null>(null);
  const [editText, setEditText] = useState("");
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null); // folder id ou "root"
  const [menu, setMenu] = useState<MenuData | null>(null);
  const [pendingDelete, setPendingDelete] = useState<DeleteTarget | null>(null);
  // Multi-seleção: ids de workspaces e de pastas selecionados (ctrl/shift+click).
  const [selWs, setSelWs] = useState<Set<string>>(() => new Set());
  const [selFolders, setSelFolders] = useState<Set<string>>(() => new Set());
  const lastClicked = useRef<string | null>(null); // âncora do shift+click
  const saveTimer = useRef<number | undefined>(undefined);

  // Persiste os metadados (debounced) a cada mudança.
  useEffect(() => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      try {
        localStorage.setItem(META_KEY, JSON.stringify(meta));
      } catch {
        console.error("Erro ao salvar metadados dos workspaces!");
      }
    }, 300);
    return () => window.clearTimeout(saveTimer.current);
  }, [meta]);

  // Fecha o menu de contexto em qualquer clique fora.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close, true);
    };
  }, [menu]);

  const metaOf = (id: string) =>
    meta.ws[id] ?? { folder: null, color: WS_COLORS[9] };

  const setWsMeta = (id: string, patch: Partial<{ folder: string | null; color: string }>) =>
    setMeta((m) => ({
      ...m,
      ws: { ...m.ws, [id]: { ...metaOf(id), ...patch } },
    }));

  const addFolder = () => {
    const id = `f-${Date.now()}`;
    const name = `Pasta ${meta.folders.length + 1}`;
    setMeta((m) => ({ ...m, folders: [...m.folders, { id, name, open: true }] }));
    startEdit("folder", id, name);
  };

  const toggleFolder = (id: string) =>
    setMeta((m) => ({
      ...m,
      folders: m.folders.map((f) => (f.id === id ? { ...f, open: !f.open } : f)),
    }));

  const startEdit = (kind: "ws" | "folder", id: string, text: string) => {
    setEditing({ kind, id });
    setEditText(text);
  };

  const commitEdit = async () => {
    if (!editing) return;
    const text = editText.trim();
    const ed = editing;
    setEditing(null);
    if (!text) return;
    if (ed.kind === "folder") {
      setMeta((m) => ({
        ...m,
        folders: m.folders.map((f) => (f.id === ed.id ? { ...f, name: text } : f)),
      }));
      return;
    }
    await onRename(ed.id, text);
  };

  const onDropTo = (folder: string | null) => (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(null);
    const id = e.dataTransfer.getData(DND_TYPE);
    if (!id || !items.some((w) => w.id === id)) return;
    // Se o item arrastado faz parte da seleção, move todos os ws selecionados;
    // senão move só ele (a seleção já foi resetada no dragstart).
    const targets = selWs.has(id) ? Array.from(selWs) : [id];
setMeta((m) => {
  const ws = { ...m.ws };
  for (const t of targets) {
    const prev = m.ws[t] ?? { folder: null, color: WS_COLORS[9] };
    ws[t] = { ...prev, folder };
  }
  return { ...m, ws };
});
    clearSelection();
  };

  const allowDrop = (zone: string) => (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes(DND_TYPE)) {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(zone);
    }
  };

  const clearSelection = () => {
    setSelWs(new Set());
    setSelFolders(new Set());
    lastClicked.current = null;
  };

  // Ordem visual linear de todas as linhas selecionáveis (pastas + seus filhos
  // visíveis, depois os workspaces soltos na raiz). Usada pelo shift+click.
  const visualOrder = (): string[] => {
    const order: string[] = [];
    for (const f of meta.folders) {
      order.push(f.id);
      if (f.open) {
        for (const w of items) if (metaOf(w.id).folder === f.id) order.push(w.id);
      }
    }
    for (const w of items) {
      const fld = metaOf(w.id).folder;
      if (!fld || !meta.folders.some((x) => x.id === fld)) order.push(w.id);
    }
    return order;
  };

  const selectionCount = selWs.size + selFolders.size;

  // Aplica um conjunto de ids selecionados, separando ws de pastas.
  const applySelection = (ids: Iterable<string>) => {
    const ws = new Set<string>();
    const fld = new Set<string>();
    const folderIds = new Set(meta.folders.map((f) => f.id));
    for (const id of ids) (folderIds.has(id) ? fld : ws).add(id);
    setSelWs(ws);
    setSelFolders(fld);
  };

  // Clique com modificadores numa linha (ws ou pasta). Retorna true se tratou
  // como seleção (ctrl/shift) — nesse caso o chamador NÃO troca de workspace.
  const handleSelectClick = (
    id: string,
    kind: "ws" | "folder",
    e: React.MouseEvent,
  ): boolean => {
    if (e.shiftKey && lastClicked.current) {
      const order = visualOrder();
      const a = order.indexOf(lastClicked.current);
      const b = order.indexOf(id);
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        applySelection(order.slice(lo, hi + 1));
        return true;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      const set = kind === "ws" ? new Set(selWs) : new Set(selFolders);
      if (set.has(id)) set.delete(id);
      else set.add(id);
      if (kind === "ws") setSelWs(set);
      else setSelFolders(set);
      lastClicked.current = id;
      return true;
    }
    return false; // clique simples: chamador limpa seleção e age normalmente
  };

  // Confirma remoção. `target` já traz ws diretos + pastas (cascata).
  const runDelete = async (target: DeleteTarget) => {
    const folderSet = new Set(target.folderIds);
    // Workspaces dentro das pastas removidas entram na cascata.
    const cascadeWs = items
      .filter((w) => {
        const f = metaOf(w.id).folder;
        return f !== null && folderSet.has(f);
      })
      .map((w) => w.id);
    const allWs = Array.from(new Set([...target.wsIds, ...cascadeWs]));
    // Remove metadados locais dos ws e das pastas apagadas.
    setMeta((m) => {
      const ws = { ...m.ws };
      for (const id of allWs) delete ws[id];
      return { ...m, ws, folders: m.folders.filter((f) => !folderSet.has(f.id)) };
    });
    clearSelection();
    if (allWs.length === 1 && target.folderIds.length === 0) await onDelete(allWs[0]);
    else if (allWs.length > 0) await onDeleteMany(allWs);
  };

  const editInput = (
    <input
      className="ws-edit"
      value={editText}
      autoFocus
      maxLength={64}
      onChange={(e) => setEditText(e.target.value)}
      onBlur={commitEdit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commitEdit();
        if (e.key === "Escape") setEditing(null);
      }}
      onClick={(e) => e.stopPropagation()}
    />
  );

  const renderWs = (ws: WorkspaceMeta) => {
    const m = metaOf(ws.id);
    const isEditing = editing?.kind === "ws" && editing.id === ws.id;
    return (
      <div key={ws.id} className="ws-row-wrap">
        <div
          className={`ws-item${ws.id === active ? " is-current" : ""}${
            selWs.has(ws.id) ? " is-selected" : ""
          }`}
          draggable={!isEditing}
          onDragStart={(e) => {
            // arrastar item fora da seleção reseta a seleção para só ele.
            if (!selWs.has(ws.id)) {
              setSelWs(new Set([ws.id]));
              setSelFolders(new Set());
              lastClicked.current = ws.id;
            }
            e.dataTransfer.setData(DND_TYPE, ws.id);
            e.dataTransfer.effectAllowed = "move";
          }}
          onClick={(e) => {
            if (handleSelectClick(ws.id, "ws", e)) return; // ctrl/shift: só seleciona
            clearSelection(); // clique simples colapsa a seleção
            onSwitch(ws.id); // e troca de workspace
          }}
          onDoubleClick={() => startEdit("ws", ws.id, ws.name)}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            // Botão direito fora da seleção atual → seleciona só este item.
            if (!selWs.has(ws.id)) {
              setSelWs(new Set([ws.id]));
              setSelFolders(new Set());
            }
            setMenu({ x: e.clientX, y: e.clientY, workspace: ws.id });
          }}
        >
          <button
            className="ws-color"
            style={{ background: m.color }}
            title="Cor"
            onClick={(e) => {
              e.stopPropagation();
              setPickerFor(pickerFor === ws.id ? null : ws.id);
            }}
          />
          {isEditing ? editInput : <span className="ws-name">{ws.name}</span>}
        </div>
        {pickerFor === ws.id && (
          <div className="ws-palette">
            {WS_COLORS.map((c) => (
              <button
                key={c}
                className={`ws-swatch${m.color === c ? " is-active" : ""}`}
                style={{ background: c }}
                onClick={() => {
                  setWsMeta(ws.id, { color: c });
                  setPickerFor(null);
                }}
              />
            ))}
          </div>
        )}
      </div>
    );
  };

  // Workspaces cuja pasta não existe (ou é null) vão para a raiz.
  const rootWs = items.filter((w) => {
    const f = metaOf(w.id).folder;
    return !f || !meta.folders.some((x) => x.id === f);
  });

  return (
    <div className="ws-tree">
      <div className="ws-head">
        <div className="side-label">Workspaces</div>
        <button className="ws-add" onClick={onCreate}>
          <Plus size={17} strokeWidth={2} />
          <span>Novo workspace</span>
        </button>
        <button className="ws-add" onClick={addFolder}>
          <FolderPlus size={17} strokeWidth={1.9} />
          <span>Nova pasta</span>
        </button>
      </div>

      <div
        className="ws-scroll"
        onDragOver={allowDrop("root")}
        onDrop={onDropTo(null)}
        onClick={(e) => {
          // Clique no vazio da lista limpa a seleção.
          if (e.target === e.currentTarget && selectionCount > 0) clearSelection();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        {meta.folders.map((f) => {
          const inside = items.filter((w) => metaOf(w.id).folder === f.id);
          const isEditing = editing?.kind === "folder" && editing.id === f.id;
          return (
            <div key={f.id} className="ws-folder">
              <div
                className={`ws-folder-head${dragOver === f.id ? " is-dragover" : ""}${
                  selFolders.has(f.id) ? " is-selected" : ""
                }`}
                onClick={(e) => {
                  if (handleSelectClick(f.id, "folder", e)) return; // ctrl/shift: seleciona
                  clearSelection();
                  toggleFolder(f.id); // clique simples: abre/fecha
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (!selFolders.has(f.id)) {
                    setSelFolders(new Set([f.id]));
                    setSelWs(new Set());
                  }
                  setMenu({ x: e.clientX, y: e.clientY, folder: f.id });
                }}
                onDoubleClick={() => startEdit("folder", f.id, f.name)}
                onDragOver={allowDrop(f.id)}
                onDragLeave={() => setDragOver(null)}
                onDrop={onDropTo(f.id)}
              >
                {f.open ? (
                  <ChevronDown size={15} strokeWidth={2} className="ws-chevron" />
                ) : (
                  <ChevronRight size={15} strokeWidth={2} className="ws-chevron" />
                )}
                {f.open ? (
                  <FolderOpen size={17} strokeWidth={1.8} />
                ) : (
                  <Folder size={17} strokeWidth={1.8} />
                )}
                {isEditing ? editInput : <span className="ws-name">{f.name}</span>}
              </div>
              {f.open && <div className="ws-folder-body">{inside.map(renderWs)}</div>}
            </div>
          );
        })}

        <div className={`ws-root${dragOver === "root" ? " is-dragover" : ""}`}>
          {rootWs.map(renderWs)}
        </div>
      </div>

      {menu && (
        <div
          className="ws-menu"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button className="ws-menu-item" onClick={onCreate}>
            <Plus size={16} strokeWidth={2} />
            <span>Novo workspace</span>
          </button>
          <button className="ws-menu-item" onClick={addFolder}>
            <FolderPlus size={16} strokeWidth={1.9} />
            <span>Nova pasta</span>
          </button>
          {selectionCount >= 2 ? (
            // seleção múltipla → ação em lote.
            <button
              className="ws-menu-item ws-menu-danger"
              onClick={() => {
                setPendingDelete({
                  wsIds: Array.from(selWs),
                  folderIds: Array.from(selFolders),
                });
                setMenu(null);
              }}
            >
              <span>Remover {selectionCount} selecionados</span>
            </button>
          ) : menu.folder ? (
            // Pasta única
            <button
              className="ws-menu-item ws-menu-danger"
              onClick={() => {
                setPendingDelete({ wsIds: [], folderIds: [menu.folder!] });
                setMenu(null);
              }}
            >
              <span>Remover pasta</span>
            </button>
          ) : (
            menu.workspace &&
            items.length > 1 && (
              <button
                className="ws-menu-item ws-menu-danger"
                onClick={() => {
                  setPendingDelete({ wsIds: [menu.workspace!], folderIds: [] });
                  setMenu(null);
                }}
              >
                <span>Remover workspace</span>
              </button>
            )
          )}
        </div>
      )}

      {pendingDelete &&
        (() => {
          const folderSet = new Set(pendingDelete.folderIds);
          const cascadeWs = items.filter((w) => {
            const f = metaOf(w.id).folder;
            return f !== null && folderSet.has(f);
          });
          const wsTotal = new Set([
            ...pendingDelete.wsIds,
            ...cascadeWs.map((w) => w.id),
          ]).size;
          const folderTotal = pendingDelete.folderIds.length;
          const parts: string[] = [];
          if (wsTotal > 0)
            parts.push(`${wsTotal} workspace${wsTotal > 1 ? "s" : ""}`);
          if (folderTotal > 0)
            parts.push(`${folderTotal} pasta${folderTotal > 1 ? "s" : ""}`);
          const summary = parts.join(" e ");
          return (
            <div className="ws-dialog-backdrop" onClick={() => setPendingDelete(null)}>
              <div
                className="ws-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby="ws-delete-title"
                onClick={(e) => e.stopPropagation()}
              >
                <h2 id="ws-delete-title">Remover {summary}?</h2>
                <p>
                  Isto apaga permanentemente <b>{summary}</b>
                  {folderTotal > 0 && " (incluindo os workspaces dentro das pastas)"} e
                  todo o seu conteúdo. Esta ação não pode ser desfeita.
                </p>
                <div className="ws-dialog-actions">
                  <button className="ws-dialog-cancel" onClick={() => setPendingDelete(null)}>
                    Cancelar
                  </button>
                  <button
                    className="ws-dialog-confirm"
                    onClick={async () => {
                      const target = pendingDelete;
                      setPendingDelete(null);
                      await runDelete(target);
                    }}
                  >
                    Remover
                  </button>
                </div>
              </div>
            </div>
          );
        })()}
    </div>
  );
}
