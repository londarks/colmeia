import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { Layers, X, FolderGit2, Plus, GitMerge, Trash2, RefreshCw } from "lucide-react";
import {
  floorList,
  floorCreate,
  floorRemove,
  floorInspect,
  floorLandPreview,
  floorLand,
  floorSetStatus,
  floorClearStatus,
  type FloorInfo,
  type FloorStatusState,
  type LossReport,
  type LandPreview,
  type LandResult,
  type DepsMode,
} from "../lib/floors";

interface Props {
  selectedTitle: string;
  onAssign: (path: string) => void;
  onClose: () => void;
}

const REPO_KEY = "colmeia.floors.repo";

const STATE_LABEL: Record<FloorStatusState, string> = {
  working: "trabalhando",
  blocked: "bloqueado",
  review: "revisão",
  done: "concluído",
};

function readRepo(): string {
  try {
    return localStorage.getItem(REPO_KEY) ?? "";
  } catch {
    return "";
  }
}
function saveRepo(repo: string) {
  try {
    localStorage.setItem(REPO_KEY, repo);
  } catch {
    /* sem storage: só não lembra */
  }
}

const shortPath = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

export function FloorsPanel({ selectedTitle, onAssign, onClose }: Props) {
  const [repo, setRepo] = useState(readRepo);
  const [floors, setFloors] = useState<FloorInfo[]>([]);
  const [name, setName] = useState("");
  const [deps, setDeps] = useState<DepsMode>("copy");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");

  const load = async (r: string) => {
    if (!r) return;
    try {
      setFloors(await floorList(r));
      setError("");
    } catch (e) {
      setError(String(e));
      setFloors([]);
    }
  };

  useEffect(() => {
    load(repo);
    const unChanged = listen("colmeia://floors-changed", () => load(repo));
    const unProgress = listen<{ name: string; files: number; bytes: number }>(
      "colmeia://floor-progress",
      (e) =>
        setProgress(
          `Copiando para "${e.payload.name}": ${e.payload.files} arquivo(s), ${(
            e.payload.bytes /
            (1024 * 1024)
          ).toFixed(1)} MB`,
        ),
    );
    return () => {
      unChanged.then((u) => u());
      unProgress.then((u) => u());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo]);

  const pickRepo = async () => {
    const dir = await open({ directory: true });
    if (typeof dir === "string") {
      setRepo(dir);
      saveRepo(dir);
    }
  };

  const create = async () => {
    if (!repo || !name.trim()) {
      setError("Escolha o repositório e um nome para o floor.");
      return;
    }
    setError("");
    setBusy(true);
    setProgress("Criando worktree…");
    try {
      await floorCreate(repo, name.trim(), { deps });
      setName("");
      await load(repo);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      setProgress("");
    }
  };

  return (
    <div className="routines-panel">
      <div className="panel-header">
        <b>
          <Layers size={15} strokeWidth={1.9} /> Floors
        </b>
        <div className="floor-header-actions">
          {repo && (
            <button className="panel-close" onClick={() => load(repo)} title="Atualizar">
              <RefreshCw size={13} strokeWidth={2} />
            </button>
          )}
          <button className="panel-close" onClick={onClose} title="Fechar">
            <X size={14} strokeWidth={2} />
          </button>
        </div>
      </div>

      <div className="panel-form">
        <button className="repo-pick" onClick={pickRepo} title={repo}>
          <FolderGit2 size={14} strokeWidth={2} />
          {repo ? shortPath(repo) : "Escolher repositório (git)…"}
        </button>
        {repo && (
          <>
            <div className="form-row">
              <input
                className="command-input"
                placeholder="nome do floor (ex: refatorar auth)"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !busy && create()}
              />
              <button className="panel-add" onClick={create} disabled={busy}>
                <Plus size={13} strokeWidth={2.4} /> Criar
              </button>
            </div>
            <div className="form-row">
              <span className="unit">dependências</span>
              <select
                className="command-input"
                value={deps}
                onChange={(e) => setDeps(e.target.value as DepsMode)}
                title="Como levar node_modules/.venv para o floor"
              >
                <option value="copy">copiar (isolado)</option>
                <option value="link">junction/link (rápido, compartilhado)</option>
                <option value="skip">não levar (instalar no floor)</option>
              </select>
            </div>
            <div className="panel-hint">
              Worktree em <code>.colmeia-floors/</code> ao lado do projeto, branch{" "}
              <code>floor/&lt;nome&gt;</code>. Leva <code>.env*</code> e arquivos ignorados úteis
              (sem <code>dist</code>/<code>target</code>). Cada floor tem sua faixa de portas em{" "}
              <code>COLMEIA_PORT_BASE</code>.
              {deps === "link" && (
                <> Com link, instalar pacotes no floor altera o <code>node_modules</code> do ground.</>
              )}
            </div>
            {progress && <div className="panel-hint">{progress}</div>}
          </>
        )}
        {error && <div className="panel-error">{error}</div>}
      </div>

      <div className="panel-list">
        {repo && floors.length <= 1 && !error && (
          <div className="panel-empty">Nenhum floor ainda.</div>
        )}
        {floors.map((f) => (
          <FloorItem
            key={f.path}
            floor={f}
            selectedTitle={selectedTitle}
            onAssign={onAssign}
            onChanged={() => load(repo)}
          />
        ))}
      </div>
    </div>
  );
}

interface ItemProps {
  floor: FloorInfo;
  selectedTitle: string;
  onAssign: (path: string) => void;
  onChanged: () => void;
}

type Mode = "idle" | "status" | "land" | "remove";

function FloorItem({ floor: f, selectedTitle, onAssign, onChanged }: ItemProps) {
  const [mode, setMode] = useState<Mode>("idle");
  const [err, setErr] = useState("");
  const [working, setWorking] = useState(false);
  // Status
  const [stState, setStState] = useState<FloorStatusState>(f.status?.state ?? "working");
  const [stText, setStText] = useState(f.status?.text ?? "");
  // Land
  const [preview, setPreview] = useState<LandPreview | null>(null);
  const [into, setInto] = useState("");
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [landResult, setLandResult] = useState<LandResult | null>(null);
  // Remoção
  const [loss, setLoss] = useState<LossReport | null>(null);
  const [keepBranch, setKeepBranch] = useState(false);
  const [removeMsg, setRemoveMsg] = useState("");

  const id = f.id;
  const ready = f.state === "ready";

  const reset = () => {
    setMode("idle");
    setErr("");
    setPreview(null);
    setLandResult(null);
    setLoss(null);
    setRemoveMsg("");
  };

  const run = async (fn: () => Promise<void>) => {
    setErr("");
    setWorking(true);
    try {
      await fn();
    } catch (e) {
      setErr(String(e));
    } finally {
      setWorking(false);
    }
  };

  const openLand = (target?: string) =>
    id &&
    run(async () => {
      setMode("land");
      setLandResult(null);
      const p = await floorLandPreview(id, target);
      setPreview(p);
      setInto(p.target);
    });

  const doLand = () =>
    id &&
    run(async () => {
      const r = await floorLand(id, { into: into || undefined, deleteBranch });
      setLandResult(r);
      if (r.landed) onChanged();
    });

  // Primeira tentativa SEM force: o backend recusa e devolve o que seria perdido.
  const tryRemove = () =>
    id &&
    run(async () => {
      setMode("remove");
      const r = await floorRemove(id, undefined, keepBranch);
      if (r.removed) {
        onChanged();
        return;
      }
      setLoss(r.loss);
      setRemoveMsg(r.message);
    });

  const toggleKeepBranch = (keep: boolean) =>
    id &&
    run(async () => {
      setKeepBranch(keep);
      setLoss(await floorInspect(id, keep));
    });

  const confirmRemove = () =>
    id &&
    loss &&
    run(async () => {
      const r = await floorRemove(id, loss.fingerprint, keepBranch);
      if (r.removed) {
        onChanged();
        return;
      }
      setLoss(r.loss);
      setRemoveMsg(r.message);
    });

  const saveStatus = () =>
    id &&
    run(async () => {
      await floorSetStatus(id, stState, stText);
      setMode("idle");
      onChanged();
    });

  const clearStatus = () =>
    id &&
    run(async () => {
      await floorClearStatus(id);
      setStText("");
      setMode("idle");
      onChanged();
    });

  const hasLoss =
    !!loss &&
    (loss.dirty.length > 0 ||
      !!loss.operation ||
      (loss.branchWillBeDeleted && loss.uniqueCommitCount > 0));

  return (
    <div className="routine-item floor-item">
      <div className="routine-meta">
        <span className="routine-target">{f.isMain ? "Ground" : f.name}</span>
        <span className="routine-interval" title="branch">
          {f.branch || "—"}
        </span>
        {f.isMain && <span className="floor-main">principal</span>}
        {f.state === "external" && <span className="floor-main">externo</span>}
        {f.legacy && <span className="floor-main">antigo</span>}
        {f.state === "orphaned" && <span className="floor-main floor-bad">órfão</span>}
        {f.state === "pending" && <span className="floor-main">criando…</span>}
        {f.dirty > 0 && (
          <span className="floor-main floor-warn" title="mudanças não commitadas">
            {f.dirty} pendente{f.dirty > 1 ? "s" : ""}
          </span>
        )}
      </div>

      <code className="routine-cmd" title={f.path}>
        {f.path}
      </code>

      {f.portBase != null && (
        <div className="panel-hint">
          portas {f.portBase}–{f.portBase + 99} · <code>COLMEIA_PORT_BASE={f.portBase}</code>
        </div>
      )}
      {f.note && <div className="panel-hint">{f.note}</div>}

      {f.status && mode !== "status" && (
        <div className="floor-status" data-state={f.status.state}>
          <span className="floor-dot" />
          <b>{STATE_LABEL[f.status.state] ?? f.status.state}</b>
          {f.status.text && <span className="floor-status-text">{f.status.text}</span>}
        </div>
      )}

      {/* Ações */}
      {!f.isMain && f.managed && mode === "idle" && (
        <div className="floor-actions">
          {ready && (
            <button
              className="floor-assign"
              disabled={!selectedTitle}
              title={
                selectedTitle ? `Atribuir a "${selectedTitle}"` : "Selecione um terminal no canvas"
              }
              onClick={() => onAssign(f.path)}
            >
              → {selectedTitle || "selecione um nó"}
            </button>
          )}
          {ready && (
            <button className="floor-btn" title="Status do floor" onClick={() => setMode("status")}>
              status
            </button>
          )}
          {ready && (
            <button
              className="floor-btn"
              title="Trazer o trabalho do floor (merge)"
              onClick={() => openLand()}
              disabled={working}
            >
              <GitMerge size={12} strokeWidth={2} /> land
            </button>
          )}
          <button
            className="routine-del floor-del"
            title={f.state === "orphaned" ? "Limpar floor órfão" : "Remover floor"}
            onClick={tryRemove}
            disabled={working}
          >
            <Trash2 size={13} strokeWidth={2} />
          </button>
        </div>
      )}

      {/* Status */}
      {mode === "status" && (
        <div className="floor-detail">
          <div className="form-row">
            <select
              value={stState}
              onChange={(e) => setStState(e.target.value as FloorStatusState)}
            >
              {(Object.keys(STATE_LABEL) as FloorStatusState[]).map((s) => (
                <option key={s} value={s}>
                  {STATE_LABEL[s]}
                </option>
              ))}
            </select>
            <input
              className="command-input"
              maxLength={120}
              placeholder="uma linha: onde o trabalho está"
              value={stText}
              onChange={(e) => setStText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && saveStatus()}
            />
          </div>
          <div className="floor-actions">
            <button className="panel-add" onClick={saveStatus} disabled={working}>
              Salvar
            </button>
            {f.status && (
              <button className="floor-btn" onClick={clearStatus} disabled={working}>
                limpar
              </button>
            )}
            <button className="floor-btn" onClick={reset}>
              cancelar
            </button>
          </div>
        </div>
      )}

      {/* Land */}
      {mode === "land" && (
        <div className="floor-detail">
          {!preview && <div className="panel-hint">Calculando prévia…</div>}
          {preview && !landResult && (
            <>
              <div className="form-row">
                <span className="unit">destino</span>
                <select
                  className="command-input"
                  value={into}
                  onChange={(e) => openLand(e.target.value)}
                >
                  {!preview.targets.includes(into) && into && <option value={into}>{into}</option>}
                  {preview.targets.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
              <div className="panel-hint">
                {preview.ahead} commit(s) a trazer · {preview.behind} commit(s) novos no destino
                {!preview.mergeTreeSupported &&
                  " · git < 2.38: sem prévia de conflitos (o merge é desfeito se conflitar)"}
              </div>
              {preview.files.length > 0 && (
                <ul className="floor-list-mini">
                  {preview.files.slice(0, 12).map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                  {preview.files.length > 12 && <li>… +{preview.files.length - 12}</li>}
                </ul>
              )}
              {preview.blockers.length > 0 && (
                <ul className="floor-list-mini floor-bad">
                  {preview.blockers.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              )}
              {preview.conflicts.length > 0 && (
                <>
                  <div className="panel-error">Conflitos previstos:</div>
                  <ul className="floor-list-mini floor-bad">
                    {preview.conflicts.map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                </>
              )}
              <label className="floor-check">
                <input
                  type="checkbox"
                  checked={deleteBranch}
                  onChange={(e) => setDeleteBranch(e.target.checked)}
                />
                apagar a branch depois (só se mergeada e criada pelo colmeia)
              </label>
              <div className="floor-actions">
                <button
                  className="panel-add"
                  onClick={doLand}
                  disabled={
                    working || preview.blockers.length > 0 || preview.conflicts.length > 0
                  }
                >
                  {preview.ahead > 0 ? `Merge em ${into}` : "Remover floor (nada a trazer)"}
                </button>
                <button className="floor-btn" onClick={reset}>
                  cancelar
                </button>
              </div>
            </>
          )}
          {landResult && (
            <>
              <div className={landResult.landed ? "panel-hint" : "panel-error"}>
                {landResult.message}
              </div>
              {landResult.blockers.length > 0 && (
                <ul className="floor-list-mini floor-bad">
                  {landResult.blockers.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              )}
              {landResult.conflicts.length > 0 && (
                <ul className="floor-list-mini floor-bad">
                  {landResult.conflicts.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              )}
              <div className="floor-actions">
                <button className="floor-btn" onClick={reset}>
                  ok
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Remoção: confirmação mostrando o que será perdido */}
      {mode === "remove" && (
        <div className="floor-detail">
          {!loss && !removeMsg && <div className="panel-hint">Verificando…</div>}
          {removeMsg && <div className="panel-error">{removeMsg}</div>}
          {loss && (
            <>
              {loss.operation && (
                <div className="panel-error">Operação git em andamento: {loss.operation}</div>
              )}
              {loss.dirty.length > 0 && (
                <>
                  <div className="panel-hint">Mudanças não commitadas que serão APAGADAS:</div>
                  <ul className="floor-list-mini floor-bad">
                    {loss.dirty.slice(0, 20).map((d) => (
                      <li key={d}>{d}</li>
                    ))}
                    {loss.dirty.length > 20 && <li>… +{loss.dirty.length - 20}</li>}
                  </ul>
                </>
              )}
              {loss.branchWillBeDeleted && loss.uniqueCommitCount > 0 && (
                <>
                  <div className="panel-hint">
                    {loss.uniqueCommitCount} commit(s) só existem em <code>{loss.branch}</code> e
                    serão perdidos com a branch:
                  </div>
                  <ul className="floor-list-mini floor-bad">
                    {loss.uniqueCommits.map((c) => (
                      <li key={c.oid}>
                        <code>{c.oid.slice(0, 8)}</code> {c.subject}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <label className="floor-check">
                <input
                  type="checkbox"
                  checked={keepBranch}
                  onChange={(e) => toggleKeepBranch(e.target.checked)}
                />
                manter a branch <code>{loss.branch}</code>
              </label>
            </>
          )}
          <div className="floor-actions">
            {loss && hasLoss && (
              <button className="floor-btn floor-danger" onClick={confirmRemove} disabled={working}>
                Apagar mesmo assim
              </button>
            )}
            {loss && !hasLoss && (
              <button className="panel-add" onClick={tryRemove} disabled={working}>
                Remover
              </button>
            )}
            <button className="floor-btn" onClick={reset}>
              cancelar
            </button>
          </div>
        </div>
      )}

      {err && <div className="panel-error">{err}</div>}
    </div>
  );
}
