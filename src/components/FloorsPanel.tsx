import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Layers, X, FolderGit2, Plus } from "lucide-react";
import { floorList, floorCreate, floorRemove, type FloorInfo } from "../lib/floors";

interface Props {
  selectedTitle: string;
  onAssign: (path: string) => void;
  onClose: () => void;
}

export function FloorsPanel({ selectedTitle, onAssign, onClose }: Props) {
  const [repo, setRepo] = useState("");
  const [floors, setFloors] = useState<FloorInfo[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async (r: string) => {
    setError("");
    try {
      setFloors(await floorList(r));
    } catch (e) {
      setError(String(e));
      setFloors([]);
    }
  };

  const pickRepo = async () => {
    const dir = await open({ directory: true });
    if (typeof dir === "string") {
      setRepo(dir);
      load(dir);
    }
  };

  const create = async () => {
    if (!repo || !name.trim()) {
      setError("Escolha o repositório e um nome para o floor.");
      return;
    }
    setError("");
    setBusy(true);
    try {
      await floorCreate(repo, name.trim());
      setName("");
      await load(repo);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (path: string) => {
    try {
      setFloors(await floorRemove(repo, path));
    } catch (e) {
      setError(String(e));
    }
  };

  const shortPath = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

  return (
    <div className="routines-panel">
      <div className="panel-header">
        <b>
          <Layers size={15} strokeWidth={1.9} /> Floors
        </b>
        <button className="panel-close" onClick={onClose} title="Fechar">
          <X size={14} strokeWidth={2} />
        </button>
      </div>

      <div className="panel-form">
        <button className="repo-pick" onClick={pickRepo}>
          <FolderGit2 size={14} strokeWidth={2} />
          {repo ? shortPath(repo) : "Escolher repositório (git)…"}
        </button>
        {repo && (
          <>
            <div className="form-row">
              <input
                className="command-input"
                placeholder="nome do floor (ex: engenheiro)"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && create()}
              />
              <button className="panel-add" onClick={create} disabled={busy}>
                <Plus size={13} strokeWidth={2.4} /> Criar
              </button>
            </div>
            <div className="panel-hint">
              Cada floor é um worktree isolado (branch <code>colmeia/&lt;nome&gt;</code>). Atribua um
              a cada agente para trabalharem em paralelo sem conflito.
            </div>
          </>
        )}
        {error && <div className="panel-error">{error}</div>}
      </div>

      <div className="panel-list">
        {repo && floors.length === 0 && (
          <div className="panel-empty">Nenhum floor ainda.</div>
        )}
        {floors.map((f) => (
          <div key={f.path} className="routine-item floor-item">
            <div className="routine-meta">
              <span className="routine-target">{f.branch || shortPath(f.path)}</span>
              {f.isMain && <span className="floor-main">principal</span>}
            </div>
            <code className="routine-cmd" title={f.path}>
              {f.path}
            </code>
            {!f.isMain && (
              <div className="floor-actions">
                <button
                  className="floor-assign"
                  disabled={!selectedTitle}
                  title={
                    selectedTitle
                      ? `Atribuir a "${selectedTitle}"`
                      : "Selecione um terminal no canvas"
                  }
                  onClick={() => onAssign(f.path)}
                >
                  → {selectedTitle || "selecione um nó"}
                </button>
                <button
                  className="routine-del"
                  title="Remover floor"
                  onClick={() => remove(f.path)}
                >
                  <X size={14} strokeWidth={2} />
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
