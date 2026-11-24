// Barra de status no rodapé — nos moldes da StatusBar do app "markdown":
// 24px, texto de 11px, itens separados por "|" e o seletor de tema à direita.
// Só leitura: canvas atual, agentes (trabalhando / em atenção), aprovações
// pendentes e rotinas ativas.

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { LayoutGrid, Palette, ShieldAlert, Terminal, Timer } from "lucide-react";
import { getActivity, subscribe } from "../lib/activity";
import { routinesList } from "../lib/pty";
import { THEMES } from "../lib/theme";

interface Props {
  canvasName: string;
  /** Ids dos terminais do canvas atual. */
  terminalIds: string[];
  approvals: number;
  theme: string;
  onTheme: (id: string) => void;
}

/** Conta quantos terminais estão trabalhando / pedindo atenção (store de atividade). */
function useActivityCounts(ids: string[]) {
  const key = ids.join("|");
  const snapshot = useCallback(() => {
    let working = 0;
    let attention = 0;
    for (const id of ids) {
      const a = getActivity(id);
      if (a.state === "working") working += 1;
      else if (a.state === "attention" || a.unseen) attention += 1;
    }
    // String: useSyncExternalStore compara por valor.
    return `${working}:${attention}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const [working, attention] = useSyncExternalStore(subscribe, snapshot)
    .split(":")
    .map(Number);
  return { working, attention };
}

/** Nº de rotinas ligadas e não concluídas (atualiza com `colmeia://routines-changed`). */
function useActiveRoutines() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const refresh = () =>
      routinesList()
        .then((list) => setCount(list.filter((r) => r.enabled && !r.completed).length))
        .catch(() => {});
    refresh();
    const un = listen("colmeia://routines-changed", refresh);
    return () => {
      un.then((f) => f()).catch(() => {});
    };
  }, []);
  return count;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function StatusBar({ canvasName, terminalIds, approvals, theme, onTheme }: Props) {
  const { working, attention } = useActivityCounts(terminalIds);
  const routines = useActiveRoutines();
  const agents = terminalIds.length;

  return (
    <footer className="statusbar" role="status">
      <div className="statusbar-group">
        <span
          className="statusbar-item statusbar-canvas"
          data-tip="Canvas atual"
          data-tip-align="start"
        >
          <LayoutGrid strokeWidth={1.8} />
          <span>{canvasName || "—"}</span>
        </span>
        <span className="statusbar-sep">|</span>
        <span className="statusbar-item" data-tip="Terminais neste canvas">
          <Terminal strokeWidth={1.8} />
          <span>
            <b>{agents}</b> {agents === 1 ? "agente" : "agentes"}
          </span>
        </span>
        {working > 0 && (
          <span className="statusbar-item is-success" data-tip="Agentes trabalhando agora">
            <span className="ui-dot is-success is-pulse" />
            <span>
              <b>{working}</b> trabalhando
            </span>
          </span>
        )}
        {attention > 0 && (
          <span
            className="statusbar-item is-warning"
            data-tip="Terminaram ou pedem atenção (Ctrl+Shift+A)"
          >
            <span className="ui-dot is-warning" />
            <span>
              <b>{attention}</b> em atenção
            </span>
          </span>
        )}
        {approvals > 0 && (
          <>
            <span className="statusbar-sep">|</span>
            <span className="statusbar-item is-error" data-tip="Aprovações pendentes">
              <ShieldAlert strokeWidth={1.9} />
              <span>{plural(approvals, "aprovação", "aprovações")}</span>
            </span>
          </>
        )}
      </div>

      <div className="statusbar-group">
        <span className="statusbar-item" data-tip="Rotinas ligadas" data-tip-align="end">
          <Timer strokeWidth={1.8} />
          <span>{routines > 0 ? plural(routines, "rotina ativa", "rotinas ativas") : "sem rotinas"}</span>
        </span>
        <span className="statusbar-sep">|</span>
        <label className="statusbar-theme" title="Tema">
          <Palette strokeWidth={1.8} />
          <span className="statusbar-swatch" />
          <select value={theme} onChange={(e) => onTheme(e.target.value)} aria-label="Tema">
            {THEMES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      </div>
    </footer>
  );
}
