// Ombro: supervisor local. Junta a saída recente dos agentes e pede a um LLM
// local (Ollama) uma análise + próximo passo. Roda on-device, sem nuvem.

use std::time::Duration;

use serde_json::json;
use tauri::State;

use crate::pty::PtyState;

/// Analisa os agentes via Ollama e devolve a sugestão do Ombro.
#[tauri::command]
pub fn ombro_analyze(
    state: State<'_, PtyState>,
    model: Option<String>,
) -> Result<String, String> {
    let ctx = state.0.agents_context(1500);
    if ctx.trim().is_empty() {
        return Err("Nenhum agente ativo para analisar.".into());
    }
    let model = model
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| "llama3.2".to_string());

    let prompt = format!(
        "Você é o OMBRO, um supervisor que observa uma equipe de agentes de IA trabalhando num canvas. \
Abaixo está a saída recente de cada agente. Analise de forma CONCISA e em português, em tópicos curtos: \
(1) o que está acontecendo; (2) se algum agente está travado, em erro ou aguardando; \
(3) qual o PRÓXIMO PASSO recomendado. Não invente; baseie-se só na saída.\n\n\
=== SAÍDA DOS AGENTES ===\n{ctx}"
    );

    let resp = ureq::post("http://127.0.0.1:11434/api/generate")
        .timeout(Duration::from_secs(180))
        .send_json(json!({ "model": model, "prompt": prompt, "stream": false }))
        .map_err(|e| {
            format!("Ollama indisponível (rode `ollama serve` e `ollama pull {model}`): {e}")
        })?;

    let body: serde_json::Value = resp
        .into_json()
        .map_err(|e| format!("resposta inválida do Ollama: {e}"))?;
    let text = body
        .get("response")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    if text.is_empty() {
        Err("O Ollama não retornou análise.".into())
    } else {
        Ok(text)
    }
}
