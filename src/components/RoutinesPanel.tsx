import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Timer, X, Play, Pencil, History } from "lucide-react";
import {
  routinesList,
  routineCreate,
  routineEdit,
  routineDelete,
  routineSetEnabled,
  routineRun,
  routinePreview,
  type RoutineInfo,
  type RoutineSchedule,
} from "../lib/pty";

interface Props {
  terminals: { id: string; title: string }[];
  /** Id do terminal selecionado no canvas (alvo padrão). */
  defaultTarget: string;
  onClose: () => void;
}

type Kind = "interval" | "daily" | "weekly" | "once";

const DAYS = [
  { key: "mon", label: "seg" },
  { key: "tue", label: "ter" },
  { key: "wed", label: "qua" },
  { key: "thu", label: "qui" },
  { key: "fri", label: "sex" },
  { key: "sat", label: "sáb" },
  { key: "sun", label: "dom" },
];

const OUTCOME: Record<string, string> = {
  sent: "enviado",
  reminder: "lembrete",
  skippedBusy: "pulado (alvo ocupado)",
  targetMissing: "alvo fora do ar",
};

const pad = (n: number) => String(n).padStart(2, "0");

function fmtWhen(ms: number | null): string {
  if (ms == null) return "—";
  return new Date(ms).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "YYYY-MM-DDTHH:MM" local (valor de <input type="datetime-local">). */
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

interface FormState {
  name: string;
  kind: Kind;
  every: string;
  time: string;
  days: string[];
  when: string;
  target: string; // id do nó; "" = lembrete
  text: string;
  skipIfBusy: boolean;
  notify: boolean;
}

const emptyForm = (target: string): FormState => ({
  name: "",
  kind: "interval",
  every: "30m",
  time: "09:00",
  days: ["mon", "fri"],
  when: toLocalInput(Date.now() + 60 * 60 * 1000),
  target,
  text: "",
  skipIfBusy: true,
  notify: false,
});

function specOf(f: FormState): string {
  switch (f.kind) {
    case "interval":
      return `interval ${f.every.trim()}`;
    case "daily":
      return `daily ${f.time}`;
    case "weekly":
      return `weekly ${f.days.join(",")}@${f.time}`;
    case "once":
      return `once ${f.when.replace("T", " ")}`;
  }
}

function formOf(r: RoutineInfo): FormState {
  const base = emptyForm(r.targetId);
  const s: RoutineSchedule = r.schedule;
  const common = {
    ...base,
    name: r.name,
    target: r.targetId,
    text: r.text,
    skipIfBusy: r.skipIfBusy,
    notify: r.notify,
  };
  switch (s.kind) {
    case "interval":
      return { ...common, kind: "interval", every: r.spec.replace(/^interval\s+/, "") };
    case "daily":
      return { ...common, kind: "daily", time: `${pad(s.hour)}:${pad(s.minute)}` };
    case "weekly":
      return {
        ...common,
        kind: "weekly",
        time: `${pad(s.hour)}:${pad(s.minute)}`,
        days: s.days.map((d) => DAYS[d % 7].key),
      };
    case "once":
      return { ...common, kind: "once", when: toLocalInput(s.at) };
  }
}

export function RoutinesPanel({ terminals, defaultTarget, onClose }: Props) {
  const [routines, setRoutines] = useState<RoutineInfo[]>([]);
  const [form, setForm] = useState<FormState>(() => emptyForm(defaultTarget));
  const [editing, setEditing] = useState<RoutineInfo | null>(null);
  const [preview, setPreview] = useState("");
  const [error, setError] = useState("");
  const [openHistory, setOpenHistory] = useState<string | null>(null);

  const refresh = () => routinesList().then(setRoutines).catch(() => {});

  useEffect(() => {
    refresh();
    const un = listen("colmeia://routines-changed", refresh);
    // Atualiza "próxima execução" relativa de tempos em tempos.
    const t = window.setInterval(refresh, 30_000);
    return () => {
      un.then((u) => u());
      window.clearInterval(t);
    };
  }, []);

  // Alvo segue o terminal selecionado no canvas (só ao criar).
  useEffect(() => {
    if (defaultTarget && !editing) setForm((f) => ({ ...f, target: defaultTarget }));
  }, [defaultTarget, editing]);

  // Prévia da agenda (valida no backend e mostra a próxima execução).
  const spec = specOf(form);
  useEffect(() => {
    let alive = true;
    const h = window.setTimeout(() => {
      routinePreview(spec)
        .then((p) => alive && setPreview(`${p.describe} · próxima ${fmtWhen(p.nextRun)}`))
        .catch((e) => alive && setPreview(`⚠ ${String(e)}`));
    }, 250);
    return () => {
      alive = false;
      window.clearTimeout(h);
    };
  }, [spec]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const toggleDay = (key: string) =>
    setForm((f) => ({
      ...f,
      days: f.days.includes(key)
        ? f.days.filter((d) => d !== key)
        : DAYS.map((d) => d.key).filter((d) => d === key || f.days.includes(d)),
    }));

  const submit = async () => {
    setError("");
    if (!form.text.trim()) {
      setError(form.target ? "Preencha o comando/prompt." : "Preencha o texto do lembrete.");
      return;
    }
    try {
      if (editing) {
        const scheduleChanged = spec !== editing.spec;
        setRoutines(
          await routineEdit(editing.id, {
            name: form.name.trim() || undefined,
            schedule: scheduleChanged ? spec : undefined,
            // Só manda o alvo se mudou (o antigo pode estar fora do canvas atual).
            target: form.target !== editing.targetId ? form.target : undefined,
            text: form.text.trim(),
            skipIfBusy: form.skipIfBusy,
            notify: form.notify,
          }),
        );
        setEditing(null);
      } else {
        setRoutines(
          await routineCreate({
            name: form.name.trim() || undefined,
            schedule: spec,
            target: form.target || undefined,
            text: form.text.trim(),
            skipIfBusy: form.skipIfBusy,
            notify: form.notify,
          }),
        );
      }
      setForm(emptyForm(defaultTarget));
    } catch (e) {
      setError(String(e));
    }
  };

  const startEdit = (r: RoutineInfo) => {
    setEditing(r);
    setForm(formOf(r));
    setError("");
  };
  const cancelEdit = () => {
    setEditing(null);
    setForm(emptyForm(defaultTarget));
    setError("");
  };

  const act = (p: Promise<RoutineInfo[]>) =>
    p.then(setRoutines).catch((e) => setError(String(e)));

  const targetMissing = form.target && !terminals.some((t) => t.id === form.target);

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
        <input
          placeholder="nome (opcional)"
          value={form.name}
          onChange={(e) => set("name", e.target.value)}
        />
        <div className="form-row">
          <select value={form.kind} onChange={(e) => set("kind", e.target.value as Kind)}>
            <option value="interval">a cada</option>
            <option value="daily">todo dia</option>
            <option value="weekly">semanal</option>
            <option value="once">uma vez</option>
          </select>
          {form.kind === "interval" && (
            <input
              className="command-input"
              placeholder="30s, 5m, 2h, 1h30m"
              value={form.every}
              onChange={(e) => set("every", e.target.value)}
            />
          )}
          {(form.kind === "daily" || form.kind === "weekly") && (
            <input
              className="command-input"
              type="time"
              value={form.time}
              onChange={(e) => set("time", e.target.value)}
            />
          )}
          {form.kind === "once" && (
            <input
              className="command-input"
              type="datetime-local"
              value={form.when}
              onChange={(e) => set("when", e.target.value)}
            />
          )}
        </div>
        {form.kind === "weekly" && (
          <div className="routine-days">
            {DAYS.map((d) => (
              <button
                key={d.key}
                className={`routine-day ${form.days.includes(d.key) ? "on" : ""}`}
                onClick={() => toggleDay(d.key)}
              >
                {d.label}
              </button>
            ))}
          </div>
        )}
        {preview && <div className="panel-hint">{preview}</div>}

        <select value={form.target} onChange={(e) => set("target", e.target.value)}>
          <option value="">Lembrete (só notificação, sem terminal)</option>
          {targetMissing && (
            <option value={form.target}>
              {editing?.targetTitle || form.target} (fora do canvas atual)
            </option>
          )}
          {terminals.map((t) => (
            <option key={t.id} value={t.id}>
              → {t.title}
            </option>
          ))}
        </select>
        <input
          className="command-input"
          placeholder={
            form.target
              ? 'comando ou prompt (ex: colmeia check "Shell 2")'
              : "texto do lembrete"
          }
          value={form.text}
          onChange={(e) => set("text", e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        {form.target && (
          <div className="routine-opts">
            <label className="floor-check">
              <input
                type="checkbox"
                checked={form.skipIfBusy}
                onChange={(e) => set("skipIfBusy", e.target.checked)}
              />
              pular se o terminal estiver ocupado
            </label>
            <label className="floor-check">
              <input
                type="checkbox"
                checked={form.notify}
                onChange={(e) => set("notify", e.target.checked)}
              />
              notificar ao disparar
            </label>
          </div>
        )}
        <div className="form-row">
          <button className="panel-add" onClick={submit}>
            {editing ? "Salvar alterações" : "+ Agendar"}
          </button>
          {editing && (
            <button className="floor-btn" onClick={cancelEdit}>
              cancelar
            </button>
          )}
        </div>
        <div className="panel-hint">
          Dica: clique num terminal no canvas para mirar nele. Disparos perdidos com o app fechado
          viram um só ao reabrir.
        </div>
        {error && <div className="panel-error">{error}</div>}
      </div>

      <div className="panel-list">
        {routines.length === 0 && <div className="panel-empty">Nenhuma rotina.</div>}
        {routines.map((r) => (
          <div
            key={r.id}
            className={`routine-item routine-card ${r.enabled && !r.completed ? "" : "off"}`}
          >
            <div className="routine-meta">
              <span className="routine-target">{r.name}</span>
              <span className="routine-interval">{r.describe}</span>
            </div>
            <div className="panel-hint">
              {r.targetId ? `→ ${r.targetTitle || r.targetId}` : "lembrete"} ·{" "}
              {r.completed
                ? "concluída"
                : !r.enabled
                  ? "desligada"
                  : r.waitingBusy
                    ? "esperando o terminal ficar livre"
                    : `próxima ${fmtWhen(r.nextRun)}`}
              {r.fireCount > 0 && ` · ${r.fireCount} disparo(s)`}
            </div>
            <code className="routine-cmd" title={r.text}>
              {r.text}
            </code>
            <div className="floor-actions">
              <label className="floor-check" title="Ligar/desligar">
                <input
                  type="checkbox"
                  checked={r.enabled}
                  disabled={r.completed}
                  onChange={(e) => act(routineSetEnabled(r.id, e.target.checked))}
                />
                ligada
              </label>
              <button className="floor-btn" title="Rodar agora" onClick={() => act(routineRun(r.id))}>
                <Play size={12} strokeWidth={2} /> agora
              </button>
              <button className="floor-btn" title="Editar" onClick={() => startEdit(r)}>
                <Pencil size={12} strokeWidth={2} />
              </button>
              <button
                className="floor-btn"
                title="Histórico"
                onClick={() => setOpenHistory(openHistory === r.id ? null : r.id)}
              >
                <History size={12} strokeWidth={2} /> {r.history.length}
              </button>
              <button
                className="routine-del floor-del"
                title="Remover"
                onClick={() => act(routineDelete(r.id))}
              >
                <X size={14} strokeWidth={2} />
              </button>
            </div>
            {openHistory === r.id && (
              <ul className="floor-list-mini">
                {r.history.length === 0 && <li>Nenhuma execução ainda.</li>}
                {r.history.map((h, i) => (
                  <li key={`${h.at}-${i}`}>
                    {fmtWhen(h.at)} · {OUTCOME[h.outcome] ?? h.outcome}
                    {h.manual && " (manual)"}
                    {h.detail && ` — ${h.detail}`}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
