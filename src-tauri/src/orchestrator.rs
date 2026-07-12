// Servidor HTTP loopback (127.0.0.1) que a CLI `colmeia` consome.
// É como os agentes conectados se veem e conversam. Toda chamada exige o token
// da sessão (bloqueia páginas web maliciosas), e NÃO expõe CORS.

use std::collections::HashMap;
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use rand::distributions::Alphanumeric;
use rand::Rng;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tiny_http::{Method, Request, Response, Server};

use crate::pty::Shared;

/// Sobe o servidor, guarda a porta em `shared.port` e devolve a porta.
pub fn start(shared: Arc<Shared>, app: AppHandle) -> u16 {
    let server = match Server::http("127.0.0.1:0") {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[orchestrator] falha ao subir loopback: {e}");
            return 0;
        }
    };
    let port = server.server_addr().to_ip().map(|a| a.port()).unwrap_or(0);
    *shared.port.lock().unwrap() = port;

    // Uma thread por requisição: uma aprovação bloqueada não trava as demais.
    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            let shared = Arc::clone(&shared);
            let app = app.clone();
            std::thread::spawn(move || handle(&shared, &app, request));
        }
    });

    println!("[orchestrator] loopback em http://127.0.0.1:{port}");
    port
}

fn parse_query(url: &str) -> (String, HashMap<String, String>) {
    let mut map = HashMap::new();
    let (path, query) = match url.split_once('?') {
        Some((p, q)) => (p.to_string(), q),
        None => (url.to_string(), ""),
    };
    for pair in query.split('&').filter(|s| !s.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        let key = urlencoding::decode(k).map(|c| c.into_owned()).unwrap_or_default();
        let val = urlencoding::decode(v).map(|c| c.into_owned()).unwrap_or_default();
        map.insert(key, val);
    }
    (path, map)
}

#[derive(Deserialize)]
struct AskBody {
    agent: String,
    prompt: String,
}

#[derive(Deserialize)]
struct NoteBody {
    title: String,
    #[serde(default)]
    content: String,
}

#[derive(Deserialize)]
struct ConnectBody {
    source: String,
    target: String,
}

#[derive(Deserialize)]
struct RecruitBody {
    agent: String,
    #[serde(default)]
    role: String,
}
#[derive(Deserialize)]
struct DismissBody {
    title: String,
}
#[derive(Clone, Serialize)]
struct RecruitPayload {
    agent: String,
    role: String,
    source: String,
}
#[derive(Clone, Serialize)]
struct DismissPayload {
    title: String,
}

#[derive(Deserialize)]
struct BrowseBody {
    url: String,
}
#[derive(Clone, Serialize)]
struct BrowsePayload {
    url: String,
    source: String,
}
#[derive(Deserialize)]
struct WebActionBody {
    selector: String,
    #[serde(default)]
    text: String,
}
#[derive(Clone, Serialize)]
struct WebActionPayload {
    action: String,
    selector: String,
    text: String,
    source: String,
}

/// Extrai o texto legível de um HTML (remove script/style e tags).
fn html_to_text(html: &str) -> String {
    let chars: Vec<char> = html.chars().collect();
    let n = chars.len();
    let matches = |i: usize, pat: &str| -> bool {
        let p: Vec<char> = pat.chars().collect();
        if i + p.len() > n {
            return false;
        }
        p.iter()
            .enumerate()
            .all(|(k, pc)| chars[i + k].to_ascii_lowercase() == *pc)
    };
    let mut out = String::new();
    let mut i = 0;
    while i < n {
        if chars[i] == '<' {
            if matches(i, "<script") {
                while i < n && !matches(i, "</script>") {
                    i += 1;
                }
                i += 9.min(n - i);
                continue;
            }
            if matches(i, "<style") {
                while i < n && !matches(i, "</style>") {
                    i += 1;
                }
                i += 8.min(n - i);
                continue;
            }
            while i < n && chars[i] != '>' {
                i += 1;
            }
            if i < n {
                i += 1;
            }
            out.push(' ');
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Busca uma página e devolve seu texto (limitado), para o agente ler.
fn fetch_page_text(url: &str) -> Result<String, String> {
    let resp = ureq::get(url)
        .set(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
        )
        .timeout(Duration::from_secs(20))
        .call()
        .map_err(|e| e.to_string())?;
    let html = resp.into_string().map_err(|e| e.to_string())?;
    Ok(html_to_text(&html).chars().take(12000).collect())
}

#[derive(Deserialize)]
struct RoutineBody {
    action: String,
    #[serde(default)]
    target: String,
    #[serde(default)]
    interval: u64,
    #[serde(default)]
    command: String,
    #[serde(default)]
    id: String,
}

/// Eventos emitidos ao frontend (para mutar o canvas a pedido do agente).
#[derive(Clone, Serialize)]
struct AddNotePayload {
    title: String,
    content: String,
}
#[derive(Clone, Serialize)]
struct ConnectPayload {
    source: String,
    target: String,
}
/// Emitido quando um agente interage com outro (ask/check) — para acender a aresta.
#[derive(Clone, Serialize)]
struct InteractionPayload {
    source: String,
    target: String,
}

#[derive(Deserialize)]
struct ApproveBody {
    #[serde(default)]
    tool: String,
    #[serde(default)]
    summary: String,
}
/// Uma solicitação de aprovação pendente, enviada ao painel central.
#[derive(Clone, Serialize)]
struct ApprovalRequest {
    id: String,
    node: String,
    title: String,
    tool: String,
    summary: String,
}
#[derive(Clone, Serialize)]
struct ApprovalResolved {
    id: String,
}

/// Avisa o frontend que `source` interagiu com `target` (acende a aresta).
fn emit_interaction(app: &AppHandle, source: &str, target: &str) {
    if source.is_empty() {
        return;
    }
    let _ = app.emit(
        "colmeia://interaction",
        InteractionPayload {
            source: source.to_string(),
            target: target.to_string(),
        },
    );
}

fn handle(shared: &Arc<Shared>, app: &AppHandle, mut request: Request) {
    let url = request.url().to_string();
    let method = request.method().clone();
    let (path, query) = parse_query(&url);

    // Lê o corpo (POST) antes de responder.
    let mut body = String::new();
    if method == Method::Post {
        let _ = request.as_reader().read_to_string(&mut body);
    }

    let token_ok = query.get("token").map(String::as_str) == Some(shared.token.as_str());
    let source = query.get("source").cloned().unwrap_or_default();

    let (code, out) = route(shared, app, &method, &path, &query, &source, &body, token_ok);
    let _ = request.respond(Response::from_string(out).with_status_code(code));
}

#[allow(clippy::too_many_arguments)]
fn route(
    shared: &Arc<Shared>,
    app: &AppHandle,
    method: &Method,
    path: &str,
    query: &HashMap<String, String>,
    source: &str,
    body: &str,
    token_ok: bool,
) -> (u16, String) {
    if !token_ok {
        return (403, "Token inválido.".into());
    }

    match (method, path) {
        (Method::Get, "/list") => {
            let terminals = shared.connected_terminals(source);
            if terminals.is_empty() {
                return (200, "Nenhum agente conectado a este nó.".into());
            }
            let mut lines = vec!["Agentes conectados:".to_string()];
            for (id, title, role) in terminals {
                if role.is_empty() {
                    lines.push(format!("  - \"{title}\" (id: {id})"));
                } else {
                    lines.push(format!("  - \"{title}\" [{role}] (id: {id})"));
                }
            }
            (200, lines.join("\n"))
        }
        (Method::Get, "/check") => {
            let agent = query.get("agent").cloned().unwrap_or_default();
            if agent.is_empty() {
                return (400, "Uso: colmeia check \"<agente>\"".into());
            }
            match shared.find_terminal_by_title(&agent) {
                Some(id) => {
                    emit_interaction(app, source, &id);
                    match shared.buffer_text(&id) {
                        Some(text) => (200, text),
                        None => (200, "(agente sem saída ainda)".into()),
                    }
                }
                None => (404, format!("Agente \"{agent}\" não encontrado.")),
            }
        }
        (Method::Get, "/wait") => {
            let agent = query.get("agent").cloned().unwrap_or_default();
            if agent.is_empty() {
                return (400, "Uso: colmeia wait \"<agente>\" [segundos_silêncio]".into());
            }
            // `idle`: ms de silêncio para considerar o agente ocioso (padrão 5s).
            // `timeout`: teto de espera em ms (padrão 5min). Ambos vêm da query.
            let idle_ms: u64 = query.get("idle").and_then(|s| s.parse().ok()).unwrap_or(5000);
            let timeout_ms: u64 =
                query.get("timeout").and_then(|s| s.parse().ok()).unwrap_or(300_000);
            match shared.find_terminal_by_title(&agent) {
                Some(id) => {
                    emit_interaction(app, source, &id);
                    let start = Instant::now();
                    // Espera o agente COMEÇAR a produzir saída antes de julgar "ocioso",
                    // para não retornar na hora se ele ainda não reagiu ao prompt.
                    let grace = Duration::from_millis(12_000);
                    let mut saw_active = false;
                    loop {
                        match shared.idle_millis(&id) {
                            None => return (404, format!("Sessão de \"{agent}\" não está ativa.")),
                            Some(idle) => {
                                if idle < idle_ms {
                                    saw_active = true;
                                }
                                if saw_active && idle >= idle_ms {
                                    return (
                                        200,
                                        format!("\"{agent}\" ocioso há {idle}ms — pronto."),
                                    );
                                }
                                let elapsed = start.elapsed();
                                if elapsed.as_millis() as u64 >= timeout_ms {
                                    return (
                                        200,
                                        format!(
                                            "Timeout aguardando \"{agent}\" ({}s). Cheque com colmeia check.",
                                            timeout_ms / 1000
                                        ),
                                    );
                                }
                                if !saw_active && elapsed > grace {
                                    return (200, format!("\"{agent}\" já estava ocioso."));
                                }
                            }
                        }
                        std::thread::sleep(Duration::from_millis(300));
                    }
                }
                None => (404, format!("Agente \"{agent}\" não encontrado.")),
            }
        }
        (Method::Post, "/ask") => match serde_json::from_str::<AskBody>(body) {
            Ok(b) => match shared.find_terminal_by_title(&b.agent) {
                Some(id) => {
                    // Re-injeta o papel do agente a cada delegação (fica sempre firme).
                    let briefing = shared.role_briefing_of(&id);
                    let msg = if briefing.is_empty() {
                        b.prompt.clone()
                    } else {
                        format!("{briefing}\n\nAgora execute: {}", b.prompt)
                    };
                    if shared.submit_line(id.clone(), msg) {
                        emit_interaction(app, source, &id);
                        (200, format!("Prompt enviado para \"{}\".", b.agent))
                    } else {
                        (404, "Sessão do agente não está ativa.".into())
                    }
                }
                None => (404, format!("Agente \"{}\" não encontrado.", b.agent)),
            },
            Err(_) => (400, "Corpo inválido (esperado JSON {agent, prompt}).".into()),
        },
        (Method::Post, "/note") => match serde_json::from_str::<NoteBody>(body) {
            Ok(b) => {
                let _ = app.emit(
                    "colmeia://add-note",
                    AddNotePayload { title: b.title.clone(), content: b.content },
                );
                (200, format!("Nota \"{}\" criada no canvas.", b.title))
            }
            Err(_) => (400, "Corpo inválido (esperado JSON {title, content}).".into()),
        },
        (Method::Get, "/context") => {
            let notes = shared.connected_notes(source);
            if notes.is_empty() {
                return (200, "Nenhuma nota de instrução conectada a este agente.".into());
            }
            let text = notes
                .iter()
                .map(|(title, content)| format!("### NOTA: {title}\n{content}"))
                .collect::<Vec<_>>()
                .join("\n\n");
            (200, text)
        }
        (Method::Post, "/recruit") => match serde_json::from_str::<RecruitBody>(body) {
            Ok(b) => {
                let _ = app.emit(
                    "colmeia://recruit",
                    RecruitPayload {
                        agent: b.agent.clone(),
                        role: b.role.clone(),
                        source: source.to_string(),
                    },
                );
                (200, format!("Recrutando agente \"{}\".", b.agent))
            }
            Err(_) => (400, "Corpo inválido (esperado JSON {agent, role}).".into()),
        },
        (Method::Post, "/dismiss") => match serde_json::from_str::<DismissBody>(body) {
            Ok(b) => {
                let _ = app.emit("colmeia://dismiss", DismissPayload { title: b.title.clone() });
                (200, format!("Dispensando \"{}\".", b.title))
            }
            Err(_) => (400, "Corpo inválido (esperado JSON {title}).".into()),
        },
        (Method::Post, "/browse") => match serde_json::from_str::<BrowseBody>(body) {
            Ok(b) => {
                let mut url = b.url.trim().to_string();
                if !url.starts_with("http://") && !url.starts_with("https://") {
                    url = format!("https://{url}");
                }
                let _ = app.emit(
                    "colmeia://browse",
                    BrowsePayload { url: url.clone(), source: source.to_string() },
                );
                match fetch_page_text(&url) {
                    Ok(text) => (200, format!("[Página aberta no canvas: {url}]\n\n{text}")),
                    Err(e) => (
                        200,
                        format!("[Página aberta no canvas: {url}] (não extraí o texto: {e})"),
                    ),
                }
            }
            Err(_) => (400, "Corpo inválido (esperado JSON {url}).".into()),
        },
        (Method::Post, "/click") | (Method::Post, "/type") => {
            match serde_json::from_str::<WebActionBody>(body) {
                Ok(b) => {
                    let action = if path == "/click" { "click" } else { "type" };
                    let _ = app.emit(
                        "colmeia://webview-action",
                        WebActionPayload {
                            action: action.to_string(),
                            selector: b.selector.clone(),
                            text: b.text.clone(),
                            source: source.to_string(),
                        },
                    );
                    (200, format!("Ação '{action}' enviada para \"{}\".", b.selector))
                }
                Err(_) => (400, "Corpo inválido (esperado JSON {selector, text?}).".into()),
            }
        }
        (Method::Post, "/connect") => match serde_json::from_str::<ConnectBody>(body) {
            Ok(b) => {
                let _ = app.emit(
                    "colmeia://connect",
                    ConnectPayload { source: b.source.clone(), target: b.target.clone() },
                );
                (200, format!("Conectando \"{}\" → \"{}\".", b.source, b.target))
            }
            Err(_) => (400, "Corpo inválido (esperado JSON {source, target}).".into()),
        },
        (Method::Post, "/routine") => match serde_json::from_str::<RoutineBody>(body) {
            Ok(b) => match b.action.as_str() {
                "create" => {
                    if b.target.is_empty() || b.interval == 0 || b.command.is_empty() {
                        return (400, "Uso: colmeia routine create \"<terminal>\" <segundos> \"<comando>\"".into());
                    }
                    match shared.resolve_terminal(&b.target) {
                        Some((id, title)) => {
                            let rid = shared.create_routine(
                                id,
                                title.clone(),
                                b.interval,
                                b.command.clone(),
                            );
                            let _ = app.emit("colmeia://routines-changed", ());
                            (
                                200,
                                format!(
                                    "Rotina {rid} criada: \"{title}\" a cada {}s → {}",
                                    b.interval, b.command
                                ),
                            )
                        }
                        None => (404, format!("Terminal \"{}\" não encontrado.", b.target)),
                    }
                }
                "list" => {
                    let list = shared.list_routines();
                    if list.is_empty() {
                        return (200, "Nenhuma rotina ativa.".into());
                    }
                    let lines: Vec<String> = list
                        .iter()
                        .map(|r| {
                            format!("  - {} | \"{}\" a cada {}s → {}", r.id, r.target, r.interval, r.command)
                        })
                        .collect();
                    (200, format!("Rotinas ativas:\n{}", lines.join("\n")))
                }
                "delete" => {
                    if b.id.is_empty() {
                        return (400, "Uso: colmeia routine delete \"<id>\"".into());
                    }
                    if shared.delete_routine(&b.id) {
                        let _ = app.emit("colmeia://routines-changed", ());
                        (200, format!("Rotina {} removida.", b.id))
                    } else {
                        (404, format!("Rotina {} não encontrada.", b.id))
                    }
                }
                _ => (400, "Ação inválida (create|list|delete).".into()),
            },
            Err(_) => (400, "Corpo inválido para /routine.".into()),
        },
        // Hook de aprovação: bloqueia até o humano decidir no painel central.
        (Method::Post, "/approve") => {
            let b: ApproveBody = serde_json::from_str(body).unwrap_or(ApproveBody {
                tool: String::new(),
                summary: String::new(),
            });
            // Regra de auto-aprovação (por ferramenta) OU escrita dentro da pasta do agente?
            if shared.is_auto_allowed(source, &b.tool)
                || shared.should_auto_approve_write(source, &b.tool, &b.summary)
            {
                return (
                    200,
                    serde_json::json!({"hookSpecificOutput":{
                        "hookEventName":"PreToolUse","permissionDecision":"allow"
                    }})
                    .to_string(),
                );
            }
            let approval_id: String = format!(
                "apv-{}",
                rand::thread_rng()
                    .sample_iter(&Alphanumeric)
                    .take(8)
                    .map(char::from)
                    .collect::<String>()
            );
            let (tx, rx) = mpsc::channel::<bool>();
            shared.add_pending(approval_id.clone(), tx);
            let title = shared.title_of(source);
            let _ = app.emit(
                "colmeia://approval-request",
                ApprovalRequest {
                    id: approval_id.clone(),
                    node: source.to_string(),
                    title,
                    tool: b.tool.clone(),
                    summary: b.summary.clone(),
                },
            );

            let outcome = rx.recv_timeout(Duration::from_secs(540));
            shared.take_pending(&approval_id);
            let _ = app.emit(
                "colmeia://approval-resolved",
                ApprovalResolved { id: approval_id },
            );

            let json = match outcome {
                Ok(false) => serde_json::json!({"hookSpecificOutput":{
                    "hookEventName":"PreToolUse",
                    "permissionDecision":"deny",
                    "permissionDecisionReason":"Recusado no painel do colmeia"
                }}),
                Ok(true) => serde_json::json!({"hookSpecificOutput":{
                    "hookEventName":"PreToolUse","permissionDecision":"allow"
                }}),
                // Timeout: cai no fluxo normal (prompt no terminal do agente).
                Err(_) => serde_json::json!({"hookSpecificOutput":{
                    "hookEventName":"PreToolUse","permissionDecision":"ask"
                }}),
            };
            (200, json.to_string())
        }
        _ => (404, "Rota não encontrada.".into()),
    }
}
