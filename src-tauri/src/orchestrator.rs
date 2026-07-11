// Servidor HTTP loopback (127.0.0.1) que a CLI `colmeia` consome.
// É como os agentes conectados se veem e conversam. Toda chamada exige o token
// da sessão (bloqueia páginas web maliciosas), e NÃO expõe CORS.

use std::collections::HashMap;
use std::sync::Arc;

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

    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            handle(&shared, &app, request);
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
            for (id, title) in terminals {
                lines.push(format!("  - \"{title}\" (id: {id})"));
            }
            (200, lines.join("\n"))
        }
        (Method::Get, "/check") => {
            let agent = query.get("agent").cloned().unwrap_or_default();
            if agent.is_empty() {
                return (400, "Uso: colmeia check \"<agente>\"".into());
            }
            match shared.find_terminal_by_title(&agent) {
                Some(id) => match shared.buffer_text(&id) {
                    Some(text) => (200, text),
                    None => (200, "(agente sem saída ainda)".into()),
                },
                None => (404, format!("Agente \"{agent}\" não encontrado.")),
            }
        }
        (Method::Post, "/ask") => match serde_json::from_str::<AskBody>(body) {
            Ok(b) => match shared.find_terminal_by_title(&b.agent) {
                Some(id) => {
                    if shared.write_to(&id, &(b.prompt.clone() + "\r")) {
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
        _ => (404, "Rota não encontrada.".into()),
    }
}
