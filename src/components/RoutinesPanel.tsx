import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Timer, X } from "lucide-react";
import {
  routinesList,
  routineCreate,
  routineDelete,
  type RoutineInfo,
} from "../lib/pty";

interface Props {
  terminals: { id: string; title: string }[];
  defaultTarget: string;
  onClose: () => void;
}

export function RoutinesPanel({ terminals, defaultTarget, onClose }: Props) {
  const [routines, setRoutines] = useState<RoutineInfo[]>([]);
  const [target, setTarget] = useState(defaultTarget);
  const [interval, setIntervalSecs] = useState("30");
  const [command, setCommand] = useState("");
  const [error, setError] = useState("");

  const refresh = () => routinesList().then(setRoutines).catch(() => {});

  useEffect(() => {
    refresh();
    const un = listen("colmeia://routines-changed", refresh);
    return () => {
      un.then((u) => u());
    };
  }, []);

  // Alvo segue o terminal selecionado no canvas.
  useEffect(() => {
    if (defaultTarget) setTarget(defaultTarget);
  }, [defaultTarget]);

  const create = async () => {
    setError("");
    const secs = Number(interval);
    if (!target) {
      setError("Selecione um terminal (clique nele no canvas ou escolha na lista).");
      return;
    }
    if (!secs || !command.trim()) {
      setError("Preencha o intervalo e o comando.");
      return;
    }
    try {
      setRoutines(await routineCreate(target, secs, command.trim()));
      setCommand("");
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="routines-panel">
      <div className="panel-header">
        <b>
          <Timer size={15} strokeWidth={1.9} /> Rotinas
        </b>
        <button className="panel-close" onClick={onClose} title="Fechar">
          <X size={14} strokeWidth={2} />
        </button>
      </div>

      <div className="panel-form">
        <select value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">
            {terminals.length ? "Selecione o terminal…" : "(nenhum terminal)"}
          </option>
          {terminals.map((t) => (
            <option key={t.id} value={t.title}>
              {t.title}
            </option>
          ))}
        </select>
        <div className="panel-hint">
          Dica: clique num terminal no canvas para mirar nele automaticamente.
        </div>
        <div className="form-row">
          <input
            className="interval-input"
            type="number"
            min={1}
            value={interval}
            onChange={(e) => setIntervalSecs(e.target.value)}
            title="Intervalo em segundos"
          />
          <span className="unit">seg</span>
          <input
            className="command-input"
            placeholder='comando (ex: colmeia check "Shell 2")'
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && create()}
          />
        </div>
        <button className="panel-add" onClick={create}>
          + Agendar
        </button>
        {error && <div className="panel-error">{error}</div>}
      </div>

      <div className="panel-list">
        {routines.length === 0 && (
          <div className="panel-empty">Nenhuma rotina ativa.</div>
        )}
        {routines.map((r) => (
          <div key={r.id} className="routine-item">
            <div className="routine-meta">
              <span className="routine-target">{r.target}</span>
              <span className="routine-interval">a cada {r.interval}s</span>
            </div>
            <code className="routine-cmd">{r.command}</code>
            <button
              className="routine-del"
              title="Remover"
              onClick={() => routineDelete(r.id).then(setRoutines)}
            >
              <X size={14} strokeWidth={2} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
