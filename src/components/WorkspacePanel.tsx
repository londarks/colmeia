// Árvore de workspaces na sidebar: pastas colapsáveis, drag & drop de
// workspaces para dentro/fora de pastas, renomear (duplo clique), cor,
// botões estilo "New Tab" e menu de contexto (botão direito).

import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  FolderPlus,
  Plus,
} from "lucide-react";
import { workspaceMetaLoad, workspaceMetaSave } from "../lib/pty";

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
  ws: Record<string, { folder: string | null; color: string }>;
}

const EMPTY_META: WsMeta = { folders: [], ws: {} };

interface Props {
  names: string[];
  current: string;
  onSwitch: (name: string) => void;
  onRename: (oldName: string, newName: string) => Promise<boolean>;
  onCreate: (name: string) => void;
  onDelete: (name: string) => Promise<boolean>;
}

export function WorkspacePanel({
  names,
  current,
  onSwitch,
  onRename,
  onCreate,
  onDelete,
}: Props) {
  const [meta, setMeta] = useState<WsMeta>(EMPTY_META);
  const [editing, setEditing] = useState<{ kind: "ws" | "folder"; id: string } | null>(null);
  const [editText, setEditText] = useState("");
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null); // folder id ou "root"
  const [menu, setMenu] = useState<{ x: number; y: number; workspace?: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const readyRef = useRef(false);
  const saveTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    workspaceMetaLoad()
      .then((m) => {
        const v = m as WsMeta | null;
        if (v && Array.isArray(v.folders) && v.ws) setMeta(v);
      })
      .catch(() => {})
      .finally(() => {
        readyRef.current = true;
      });
  }, []);

  useEffect(() => {
    if (!readyRef.current) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      workspaceMetaSave(meta).catch(() => {});
    }, 500);
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

  const metaOf = (name: string) =>
    meta.ws[name] ?? { folder: null, color: WS_COLORS[9] };

  const setWsMeta = (name: string, patch: Partial<{ folder: string | null; color: string }>) =>
    setMeta((m) => ({ ...m, ws: { ...m.ws, [name]: { ...metaOf(name), ...patch } } }));

  const addFolder = () => {
    const id = `f-${Date.now()}`;
    const n = meta.folders.length + 1;
    setMeta((m) => ({
      ...m,
      folders: [...m.folders, { id, name: `Pasta ${n}`, open: true }],
    }));
    setEditing({ kind: "folder", id });
    setEditText(`Pasta ${n}`);
  };

  const addWorkspace = () => {
    let n = names.length + 1;
    let name = `Workspace ${n}`;
    while (names.includes(name)) name = `Workspace ${++n}`;
    onCreate(name);
    setEditing({ kind: "ws", id: name });
    setEditText(name);
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
    if (text === ed.id || names.includes(text)) return;
    if (await onRename(ed.id, text)) {
      // Move os metadados para a nova chave.
      setMeta((m) => {
        const { [ed.id]: old, ...rest } = m.ws;
        return { ...m, ws: { ...rest, [text]: old ?? metaOf(ed.id) } };
      });
    }
  };

  const onDropTo = (folder: string | null) => (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(null);
    const name = e.dataTransfer.getData("text/colmeia-ws");
    if (name && names.includes(name)) setWsMeta(name, { folder });
  };

  const allowDrop = (zone: string) => (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("text/colmeia-ws")) {
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

  const renderWs = (name: string) => {
    const m = metaOf(name);
    const isEditing = editing?.kind === "ws" && editing.id === name;
    return (
      <div key={name} className="ws-row-wrap">
        <div
          className={`ws-item${name === current ? " is-current" : ""}`}
          draggable={!isEditing}
          onDragStart={(e) => {
            e.dataTransfer.setData("text/colmeia-ws", name);
            e.dataTransfer.effectAllowed = "move";
          }}
          onClick={() => onSwitch(name)}
          onDoubleClick={() => startEdit("ws", name, name)}
          title={name}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setMenu({ x: e.clientX, y: e.clientY, workspace: name });
          }}
        >
          <button
            className="ws-color"
            style={{ background: m.color }}
            title="Cor"
            onClick={(e) => {
              e.stopPropagation();
              setPickerFor((p) => (p === name ? null : name));
            }}
          />
          {isEditing ? editInput : <span className="ws-name">{name}</span>}
        </div>
        {pickerFor === name && (
          <div className="ws-palette">
            {WS_COLORS.map((c) => (
              <button
                key={c}
                className={`ws-swatch${m.color === c ? " is-active" : ""}`}
                style={{ background: c }}
                onClick={() => {
                  setWsMeta(name, { color: c });
                  setPickerFor(null);
                }}
              />
            ))}
          </div>
        )}
      </div>
    );
  };

  const rootWs = names.filter((n) => {
    const f = metaOf(n).folder;
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

      <button className="ws-add" onClick={addWorkspace}>
        <Plus size={17} strokeWidth={2} />
        <span>Novo workspace</span>
      </button>
      <button className="ws-add" onClick={addFolder}>
        <FolderPlus size={17} strokeWidth={1.9} />
        <span>Nova pasta</span>
      </button>

      <div className="ws-sep" />

      {meta.folders.map((f) => {
        const inside = names.filter((n) => metaOf(n).folder === f.id);
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
          <button
            className="ws-menu-item"
            onClick={() => {
              setMenu(null);
              addWorkspace();
            }}
          >
            <Plus size={16} strokeWidth={2} />
            Novo workspace
          </button>
          <button
            className="ws-menu-item"
            onClick={() => {
              setMenu(null);
              addFolder();
            }}
          >
            <FolderPlus size={16} strokeWidth={1.9} />
            Nova pasta
          </button>
          {menu.workspace && (
            <button
              className="ws-menu-item ws-menu-danger"
              onClick={() => {
                setPendingDelete(menu.workspace!);
                setMenu(null);
              }}
            >
              Remover workspace
            </button>
          )}
        </div>
      )}

      {pendingDelete && (
        <div className="ws-dialog-backdrop" role="presentation">
          <section
            className="ws-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="ws-delete-title"
          >
            <h2 id="ws-delete-title">Remover workspace?</h2>
            <p>
              <b>{pendingDelete}</b> e todo o seu canvas serão removidos permanentemente.
              {pendingDelete === current && " O próximo workspace será aberto antes da remoção."}
            </p>
            <div className="ws-dialog-actions">
              <button className="ws-dialog-cancel" onClick={() => setPendingDelete(null)}>
                Cancelar
              </button>
              <button
                className="ws-dialog-confirm"
                autoFocus
                onClick={async () => {
                  const name = pendingDelete;
                  setPendingDelete(null);
                  if (await onDelete(name)) {
                    setMeta((m) => {
                      const { [name]: _removed, ...ws } = m.ws;
                      return { ...m, ws };
                    });
                  }
                }}
              >
                Remover workspace
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
