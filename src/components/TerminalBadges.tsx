import { useActivity } from "../lib/activity";

const STATUS_LABEL: Record<string, string> = {
  working: "trabalhando",
  blocked: "bloqueado",
  review: "em revisão",
  done: "pronto",
};

/**
 * Indicador de atividade do terminal (cabeçalho do nó / painel de Lift):
 * - aguardando aprovação (`waiting`, vindo do App) → ponto laranja pulsando;
 * - attention → ponto de atenção; working → anel girando;
 * - terminou sem ser visto → ponto discreto até o usuário focar o nó; idle → nada.
 */
export function ActivityIndicator({ id, waiting }: { id: string; waiting?: boolean }) {
  const a = useActivity(id);
  if (waiting) {
    return <span className="act act-waiting" title="Aguardando aprovação" />;
  }
  if (a.state === "attention") {
    return (
      <span
        className="act act-attention"
        title={a.reason ? `Pede atenção: ${a.reason}` : "Pede atenção"}
      />
    );
  }
  if (a.state === "working") {
    return <span className="act act-working" title={a.reason || "Trabalhando"} />;
  }
  if (a.unseen) {
    return <span className="act act-unseen" title="Terminou — ainda não visto" />;
  }
  return null;
}

/** Pílula com o status textual posto pelo agente (`colmeia://status`). */
export function StatusPill({ id }: { id: string }) {
  const { status } = useActivity(id);
  if (!status || (!status.text && !status.state)) return null;
  const text = status.text || STATUS_LABEL[status.state] || status.state;
  return (
    <span
      className={`status-pill status-pill-${status.state || "none"}`}
      title={status.text || text}
    >
      {text}
    </span>
  );
}
