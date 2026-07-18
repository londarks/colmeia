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

const EMPTY_META: WsMeta = { folders: [], ws: {} };
const META_KEY = "colmeia.ws-meta";
const DND_TYPE = "text/colmeia-ws"; // carrega o id do workspace arrastado.

// ponytail: metadados de pasta/cor ficam em localStorage; sem comando de
// backend dedicado. Se um dia precisar sincronizar entre máquinas, trocar
// por um par workspace_meta_load/save no Rust.
function loadMeta(): WsMeta {
  try {
    const raw = localStorage.getItem(META_KEY);
    if (!raw) return EMPTY_META;
    const v = JSON.parse(raw) as WsMeta;
    if (v && Array.isArray(v.folders) && v.ws) return v;
  } catch {
    /* ignora */
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
}

export function WorkspacePanel({
  items,
  active,
  onSwitch,
  onCreate,
  onRename,
  onDelete,
}: Props) {
  const [meta, setMeta] = useState<WsMeta>(loadMeta);
  const [editing, setEditing] = useState<{ kind: "ws" | "folder"; id: string } | null>(null);
  const [editText, setEditText] = useState("");
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null); // folder id ou "root"
  const [menu, setMenu] = useState<{ x: number; y: number; workspace?: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);

  // Persiste os metadados (debounced) a cada mudança.
  useEffect(() => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      try {
        localStorage.setItem(META_KEY, JSON.stringify(meta));
      } catch {
        /* ignora */
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
    if (id && items.some((w) => w.id === id)) setWsMeta(id, { folder });
  };

  const allowDrop = (zone: string) => (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes(DND_TYPE)) {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(zone);
    }
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
          className={`ws-item${ws.id === active ? " is-current" : ""}`}
          draggable={!isEditing}
          onDragStart={(e) => {
            e.dataTransfer.setData(DND_TYPE, ws.id);
            e.dataTransfer.effectAllowed = "move";
          }}
          onClick={() => onSwitch(ws.id)}
          onDoubleClick={() => startEdit("ws", ws.id, ws.name)}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
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
    <div
      className="ws-tree"
      onDragOver={allowDrop("root")}
      onDrop={onDropTo(null)}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <div className="side-label">Workspaces</div>

      <button className="ws-add" onClick={onCreate}>
        <Plus size={17} strokeWidth={2} />
        <span>Novo workspace</span>
      </button>
      <button className="ws-add" onClick={addFolder}>
        <FolderPlus size={17} strokeWidth={1.9} />
        <span>Nova pasta</span>
      </button>

      <div className="ws-sep" />

      {meta.folders.map((f) => {
        const inside = items.filter((w) => metaOf(w.id).folder === f.id);
        const isEditing = editing?.kind === "folder" && editing.id === f.id;
        return (
          <div key={f.id} className="ws-folder">
            <div
              className={`ws-folder-head${dragOver === f.id ? " is-dragover" : ""}`}
              onClick={() => toggleFolder(f.id)}
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
          {menu.workspace && items.length > 1 && (
            <button
              className="ws-menu-item ws-menu-danger"
              onClick={() => {
                setPendingDelete(menu.workspace!);
                setMenu(null);
              }}
            >
              <span>Remover workspace</span>
            </button>
          )}
        </div>
      )}

      {pendingDelete && (
        <div className="ws-dialog-backdrop" onClick={() => setPendingDelete(null)}>
          <div
            className="ws-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ws-delete-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="ws-delete-title">Remover workspace?</h2>
            <p>
              Isto apaga permanentemente{" "}
              <b>{items.find((w) => w.id === pendingDelete)?.name ?? "este workspace"}</b>{" "}
              e todo o seu conteúdo.
            </p>
            <div className="ws-dialog-actions">
              <button className="ws-dialog-cancel" onClick={() => setPendingDelete(null)}>
                Cancelar
              </button>
              <button
                className="ws-dialog-confirm"
                onClick={async () => {
                  const id = pendingDelete;
                  setPendingDelete(null);
                  // Limpa os metadados locais do workspace removido.
                  setMeta((m) => {
                    const { [id]: _gone, ...rest } = m.ws;
                    return { ...m, ws: rest };
                  });
                  await onDelete(id);
                }}
              >
                Remover
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
