import { useState } from "react";
import { Eye, X, Sparkle } from "lucide-react";
import { ombroAnalyze } from "../lib/pty";

const MODEL_KEY = "colmeia:ombro-model";

export function OmbroPanel({ onClose }: { onClose: () => void }) {
  const [model, setModel] = useState(
    () => localStorage.getItem(MODEL_KEY) ?? "llama3.2",
  );
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const analyze = async () => {
    setError("");
    setLoading(true);
    localStorage.setItem(MODEL_KEY, model);
    try {
      setResult(await ombroAnalyze(model));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="routines-panel ombro-panel">
      <div className="panel-header">
        <b>
          <Eye size={15} strokeWidth={1.9} /> Ombro
        </b>
        <button className="panel-close" onClick={onClose} title="Fechar">
          <X size={14} strokeWidth={2} />
        </button>
      </div>

      <div className="panel-form">
        <div className="form-row">
          <input
            className="command-input"
            placeholder="modelo do Ollama (ex: llama3.2)"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
          <button className="panel-add" onClick={analyze} disabled={loading}>
            <Sparkle size={13} strokeWidth={2.2} />
            {loading ? "Analisando…" : "Analisar"}
          </button>
        </div>
        <div className="panel-hint">
          Supervisor local: lê a saída recente dos agentes e sugere o próximo passo.
          Requer o Ollama rodando (<code>ollama serve</code>).
        </div>
        {error && <div className="panel-error">{error}</div>}
      </div>

      <div className="panel-list">
        {result ? (
          <div className="ombro-result">{result}</div>
        ) : (
          !error && (
            <div className="panel-empty">
              Clique em “Analisar” para o Ombro observar a equipe.
            </div>
          )
        )}
      </div>
    </div>
  );
}
