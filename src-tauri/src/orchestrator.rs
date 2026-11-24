// Servidor HTTP loopback (127.0.0.1) que a CLI `colmeia` consome.
// É como os agentes conectados se veem e conversam.
//
// Endurecimento (não afrouxar):
// - bind só em 127.0.0.1, sem CORS, e o header Host precisa ser o loopback;
// - toda rota (menos `/health`) exige o token do TERMINAL no header
//   `X-Colmeia-Token`. O chamador (`source`) é derivado do token — nunca da
//   query/corpo — então um agente não consegue se passar por outro (F7);
// - todo nome é resolvido com escopo pelas arestas do canvas (scope.rs, F6);
// - comandos estruturais exigem modo Maestro ou papel Orquestrador (F15).
//
// Contrato de resposta (F23): 2xx = sucesso (CLI sai 0); 2xx com o header
// `X-Colmeia-Warning: 1` = terminou mas pede atenção, texto começa com
// "aviso:" (CLI sai 2); 4xx/5xx = erro com o próximo passo no texto (CLI sai 1).

use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use rand::distributions::Alphanumeric;
use rand::Rng;
use serde::Serialize;
use serde_json::{json, Value};
use tiny_http::{Header, Method, Request, Response, Server};

use crate::activity::{AgentState, TurnEnd};
use crate::asks::{AskOptions, AskReply};
use crate::delivery::decode_escapes;
use crate::pty::Shared;
use crate::roles::{self, RoleDef};
use crate::scope::{self, same_name, ScopeError};

/// Sobe o servidor, guarda a porta em `shared.port` e devolve a porta.
pub fn start(shared: Arc<Shared>) -> u16 {
    let server = match Server::http("127.0.0.1:0") {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[orchestrator] falha ao subir loopback: {e}");
            return 0;
        }
    };
    let port = server.server_addr().to_ip().map(|a| a.port()).unwrap_or(0);
    *shared.port.lock().unwrap() = port;

    // Uma thread por requisição: um ask/aprovação bloqueado não trava as demais.
    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            let shared = Arc::clone(&shared);
            std::thread::spawn(move || handle(&shared, request));
        }
    });

    println!("[orchestrator] loopback em http://127.0.0.1:{port}");
    port
}

/// Resposta de uma rota.
struct Reply {
    code: u16,
    body: String,
    warn: bool,
}

impl Reply {
    fn ok(body: impl Into<String>) -> Self {
        Reply {
            code: 200,
            body: body.into(),
            warn: false,
        }
    }
    fn warn(body: impl Into<String>) -> Self {
        Reply {
            code: 200,
            body: body.into(),
            warn: true,
        }
    }
    fn err(code: u16, body: impl Into<String>) -> Self {
        Reply {
            code,
            body: body.into(),
            warn: false,
        }
    }
}

impl From<AskReply> for Reply {
    fn from(r: AskReply) -> Self {
        Reply {
            code: r.code,
            body: r.body,
            warn: r.warn,
        }
    }
}

impl From<ScopeError> for Reply {
    fn from(e: ScopeError) -> Self {
        Reply::err(e.status(), e.message())
    }
}

fn header<'a>(request: &'a Request, name: &'static str) -> Option<&'a str> {
    request
        .headers()
        .iter()
        .find(|h| h.field.equiv(name))
        .map(|h| h.value.as_str())
}

fn path_only(url: &str) -> &str {
    url.split('?').next().unwrap_or(url)
}

fn handle(shared: &Arc<Shared>, mut request: Request) {
    let path = path_only(request.url()).to_string();
    let method = request.method().clone();
    let port = *shared.port.lock().unwrap();

    // Anti DNS-rebinding: só aceita Host de loopback.
    let host_ok = match header(&request, "Host") {
        Some(h) => h == format!("127.0.0.1:{port}") || h == format!("localhost:{port}"),
        None => true,
    };
    let token = header(&request, "X-Colmeia-Token")
        .unwrap_or("")
        .to_string();

    let mut body = String::new();
    if method == Method::Post {
        let _ = request.as_reader().read_to_string(&mut body);
    }

    let reply = if !host_ok {
        Reply::err(403, "Host inválido.")
    } else if method == Method::Get && path == "/health" {
        Reply::ok(
            json!({ "ok": true, "app": "colmeia", "version": env!("CARGO_PKG_VERSION") })
                .to_string(),
        )
    } else {
        match shared.node_for_token(&token) {
            None => Reply::err(
                403,
                "Token inválido ou de um terminal já encerrado. Rode `colmeia debug`; se o app foi \
reiniciado, reabra este terminal pelo colmeia.",
            ),
            Some(source) => {
                let v: Value = if body.trim().is_empty() {
                    json!({})
                } else {
                    match serde_json::from_str(&body) {
                        Ok(v) => v,
                        Err(_) => {
                            respond(request, Reply::err(400, "Corpo inválido (esperado JSON)."));
                            return;
                        }
                    }
                };
                if method != Method::Post {
                    Reply::err(405, "Use POST.")
                } else {
                    route(shared, &path, &source, &v)
                }
            }
        }
    };
    respond(request, reply);
}

fn respond(request: Request, reply: Reply) {
    let mut resp = Response::from_string(reply.body).with_status_code(reply.code);
    if reply.warn {
        if let Ok(h) = Header::from_bytes(&b"X-Colmeia-Warning"[..], &b"1"[..]) {
            resp = resp.with_header(h);
        }
    }
    let _ = request.respond(resp);
}

// ── Helpers de corpo ─────────────────────────────────────────────────────

fn s(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}
fn b(v: &Value, key: &str) -> Option<bool> {
    v.get(key).and_then(Value::as_bool)
}
fn u(v: &Value, key: &str) -> Option<u64> {
    v.get(key).and_then(|x| {
        x.as_u64()
            .or_else(|| x.as_str().and_then(|s| s.parse().ok()))
    })
}

fn require_maestro(shared: &Shared, source: &str, what: &str) -> Option<Reply> {
    if shared.is_maestro(source) {
        None
    } else {
        Some(Reply::err(
            403,
            format!(
                "Só o orquestrador pode {what}. Este terminal não está em modo Maestro nem tem o papel \
Orquestrador — peça ao usuário para ligar o Maestro neste nó."
            ),
        ))
    }
}

fn state_label(state: AgentState) -> &'static str {
    match state {
        AgentState::Working => "trabalhando",
        AgentState::Idle => "ocioso",
        AgentState::Attention => "precisa de atenção",
    }
}

// ── Eventos emitidos ao frontend ─────────────────────────────────────────

#[derive(Clone, Serialize)]
struct AddNotePayload {
    title: String,
    content: String,
    /// Nó criador (a nota é ligada a ele quando `target` está vazio).
    source: String,
    /// Id do agente destino (opcional), já resolvido com escopo.
    target: String,
}
#[derive(Clone, Serialize)]
struct NoteUpdatePayload {
    id: String,
    content: String,
}
#[derive(Clone, Serialize)]
struct ConnectPayload {
    /// Ids (já resolvidos com escopo).
    source: String,
    target: String,
}
#[derive(Clone, Serialize)]
struct RecruitPayload {
    name: String,
    agent: String,
    role: String,
    dir: String,
    source: String,
}
#[derive(Clone, Serialize)]
struct DismissPayload {
    id: String,
    title: String,
}
#[derive(Clone, Serialize)]
struct NodeUpdatePayload {
    id: String,
    patch: Value,
    restart: bool,
}
#[derive(Clone, Serialize)]
struct InteractionPayload {
    source: String,
    target: String,
}
#[derive(Clone, Serialize)]
struct NotifyPayload {
    id: String,
    title: String,
    body: String,
}
#[derive(Clone, Serialize)]
struct StatusPayload {
    id: String,
    state: String,
    text: String,
}
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
fn emit_interaction(shared: &Shared, source: &str, target: &str) {
    shared.emit(
        "colmeia://interaction",
        InteractionPayload {
            source: source.to_string(),
            target: target.to_string(),
        },
    );
}

// ── Rotas ────────────────────────────────────────────────────────────────

fn route(shared: &Arc<Shared>, path: &str, source: &str, v: &Value) -> Reply {
    match path {
        "/whoami" => whoami(shared, source),
        "/list" => list(shared, source),
        "/check" => check(shared, source, v),
        "/wait" => wait(shared, source, v),
        "/ask" => ask(shared, source, v),
        "/note" => note(shared, source, v),
        "/context" => context(shared, source),
        "/recruit" => recruit(shared, source, v),
        "/dismiss" => dismiss(shared, source, v),
        "/connect" => connect(shared, source, v),
        "/role" => role(shared, source, v),
        "/preset" => preset(shared),
        "/notify" => notify(shared, source, v),
        "/status" => status(shared, source, v),
        "/event" => {
            shared.hook_event(
                source,
                &s(v, "event"),
                &s(v, "notification_type"),
                &s(v, "message"),
            );
            Reply::ok("")
        }
        "/routine" => routine(shared, source, v),
        "/floor" => floor(shared, source, v),
        "/partitura" => partitura(shared, source, v),
        "/approve" => approve(shared, source, v),
        // Portal (navegador CDP); browse/click/type antigos viram atalhos dele.
        "/portal" | "/browse" | "/click" | "/type" => portal(shared, source, path, v),
        _ => Reply::err(404, "Rota não encontrada. Rode `colmeia help`."),
    }
}

fn whoami(shared: &Shared, source: &str) -> Reply {
    let Some(me) = shared.node(source) else {
        return Reply::ok(format!(
            "Você: (nó {source}, ainda não sincronizado no canvas)"
        ));
    };
    Reply::ok(you_line(shared, &me))
}

fn you_line(shared: &Shared, me: &crate::pty::NodeInfo) -> String {
    let role = if me.role.is_empty() {
        String::new()
    } else {
        format!(" [{}]", me.role)
    };
    let maestro = if shared.is_maestro(&me.id) {
        " · orquestrador (maestro)"
    } else {
        ""
    };
    format!("Você: \"{}\"{role} (id: {}){maestro}", me.title, me.id)
}

fn list(shared: &Shared, source: &str) -> Reply {
    let (nodes, edges) = shared.graph_snapshot();
    let reach = scope::reach(&nodes, &edges, source);
    let mut out = Vec::new();
    match nodes.iter().find(|n| n.id == source) {
        Some(me) => out.push(you_line(shared, me)),
        None => out.push(format!("Você: (nó {source})")),
    }

    let agent_line = |n: &crate::pty::NodeInfo| {
        let role = if n.role.is_empty() {
            String::new()
        } else {
            format!(" [{}]", n.role)
        };
        let kind = if n.agent.is_empty() {
            String::new()
        } else {
            format!(" ({})", n.agent)
        };
        let state = if shared.session_io(&n.id).is_some() {
            state_label(shared.activity_snapshot(&n.id).state)
        } else {
            "sem processo"
        };
        format!("  - \"{}\"{role}{kind} — {state}", n.title)
    };

    let agents: Vec<String> = nodes
        .iter()
        .filter(|n| n.kind == "terminal" && reach.contains(&n.id))
        .map(&agent_line)
        .collect();
    let notes: Vec<String> = scope::note_depths(&nodes, &edges, source)
        .into_iter()
        .filter_map(|(id, depth)| nodes.iter().find(|n| n.id == id).map(|n| (n, depth)))
        .map(|(n, depth)| {
            let lines = if n.content.is_empty() {
                0
            } else {
                n.content.lines().count()
            };
            let locked = if n.locked { " [travada]" } else { "" };
            format!(
                "{}- \"{}\" ({lines} linhas){locked}",
                "  ".repeat(depth),
                n.title
            )
        })
        .collect();
    let browsers: Vec<String> = nodes
        .iter()
        .filter(|n| n.kind == "browser" && reach.contains(&n.id))
        .map(|n| format!("  - \"{}\"", n.title))
        .collect();
    // Bands (F17): as que você integra e as ligadas a você, com os membros.
    let bands: Vec<String> = scope::bands_for(&nodes, &edges, source)
        .into_iter()
        .map(|b| {
            let names: Vec<String> = b
                .members
                .iter()
                .map(|id| format!("\"{}\"", shared.title_of(id)))
                .collect();
            let how = if b.member { "você é membro" } else { "ligada a você" };
            let who = if names.is_empty() {
                "sem outros membros".to_string()
            } else {
                names.join(", ")
            };
            format!("  - \"{}\" ({how}): {who}", b.title)
        })
        .collect();

    let empty =
        agents.is_empty() && notes.is_empty() && browsers.is_empty() && bands.is_empty();
    if !bands.is_empty() {
        out.push("Bands (todos-com-todos):".into());
        out.extend(bands);
    }
    if !agents.is_empty() {
        out.push("Agentes:".into());
        out.extend(agents);
    }
    if !notes.is_empty() {
        out.push("Notas:".into());
        out.extend(notes);
    }
    if !browsers.is_empty() {
        out.push("Navegadores:".into());
        out.extend(browsers);
    }
    if shared.is_maestro(source) {
        let team = scope::team_reach(&nodes, &edges, source);
        let extra: Vec<String> = nodes
            .iter()
            .filter(|n| n.kind == "terminal" && team.contains(&n.id) && !reach.contains(&n.id))
            .map(&agent_line)
            .collect();
        if !extra.is_empty() {
            out.push(
                "Equipe dos seus recrutas (você enxerga como orquestrador; para falar, conecte):"
                    .into(),
            );
            out.extend(extra);
        }
    }
    if empty {
        let hint = if shared.is_maestro(source) {
            " Monte a equipe com `colmeia recruit` (veja a skill colmeia-equipe)."
        } else {
            " Peça ao usuário para ligar seu nó a outros no canvas."
        };
        out.push(format!("Nada conectado a você ainda.{hint}"));
    }
    Reply::ok(out.join("\n"))
}

fn check(shared: &Shared, source: &str, v: &Value) -> Reply {
    let agent = s(v, "agent");
    if agent.is_empty() {
        return Reply::err(400, "Uso: colmeia check \"<agente>\" [--bytes N]");
    }
    let team = shared.is_maestro(source);
    let id = match shared.resolve_scoped(source, &agent, &["terminal"], team) {
        Ok(id) => id,
        Err(e) => return e.into(),
    };
    emit_interaction(shared, source, &id);
    let max = u(v, "bytes").unwrap_or(6000).clamp(200, 64_000) as usize;
    match shared.screen_text(&id, max) {
        Some(t) if !t.trim().is_empty() => Reply::ok(t),
        Some(_) => Reply::ok("(agente sem saída ainda)"),
        None => Reply::err(
            409,
            format!(
                "\"{agent}\" não tem um processo rodando. Peça ao usuário para reabrir o terminal."
            ),
        ),
    }
}

fn wait(shared: &Shared, source: &str, v: &Value) -> Reply {
    let agent = s(v, "agent");
    if agent.is_empty() {
        return Reply::err(400, "Uso: colmeia wait \"<agente>\" [--timeout segundos]");
    }
    let id = match shared.resolve_scoped(source, &agent, &["terminal"], false) {
        Ok(id) => id,
        Err(e) => return e.into(),
    };
    let Some(io) = shared.session_io(&id) else {
        return Reply::err(409, format!("\"{agent}\" não tem um processo rodando."));
    };
    emit_interaction(shared, source, &id);
    let timeout = Duration::from_secs(u(v, "timeout").unwrap_or(300).max(1));
    let title = shared.title_of(&id);

    // Ocioso agora? Dá alguns segundos para um prompt recém-entregue começar.
    let start = Instant::now();
    while shared.activity_snapshot(&id).state == AgentState::Idle
        && !shared.has_pending_approval(&id)
    {
        if start.elapsed() > Duration::from_secs(5) {
            return Reply::ok(format!("\"{title}\" já estava ocioso."));
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    let seq = shared.activity_snapshot(&id).turn_seq;
    match shared.wait_turn(&id, seq, io.generation, timeout, None) {
        TurnEnd::Done { .. } | TurnEnd::Signal(_) => Reply::ok(format!(
            "\"{title}\" terminou o turno — pronto. Leia com `colmeia check \"{title}\"`."
        )),
        TurnEnd::Attention(reason) => Reply::warn(format!(
            "aviso: \"{title}\" parou pedindo atenção{}. Veja com `colmeia check \"{title}\"`.",
            if reason.is_empty() {
                String::new()
            } else {
                format!(" ({reason})")
            }
        )),
        TurnEnd::Exited => Reply::warn(format!("aviso: \"{title}\" encerrou.")),
        TurnEnd::Restarted => Reply::warn(format!("aviso: \"{title}\" reiniciou.")),
        TurnEnd::Timeout => Reply::warn(format!(
            "aviso: tempo esgotado esperando \"{title}\" ({}s); ele continua trabalhando. \
Acompanhe com `colmeia check \"{title}\"`.",
            timeout.as_secs()
        )),
    }
}

fn ask(shared: &Arc<Shared>, source: &str, v: &Value) -> Reply {
    let timeout = u(v, "timeout").map(Duration::from_secs);
    let opts = || {
        let mut o = AskOptions::default();
        if let Some(t) = timeout {
            o.timeout = t.max(Duration::from_secs(5));
        }
        o
    };

    // --batch: [{agent, prompt}] em paralelo, resposta JSON na mesma ordem.
    if let Some(items) = v.get("batch").and_then(Value::as_array) {
        if items.is_empty() {
            return Reply::err(
                400,
                "Uso: colmeia ask --batch '{\"A\":\"prompt\",\"B\":\"prompt\"}'",
            );
        }
        let mut seen: Vec<String> = Vec::new();
        let mut jobs: Vec<(String, Result<std::thread::JoinHandle<AskReply>, String>)> = Vec::new();
        for item in items {
            let name = s(item, "agent");
            let prompt = s(item, "prompt");
            if seen.iter().any(|x| same_name(x, &name)) {
                jobs.push((name, Err("nome repetido no --batch".into())));
                continue;
            }
            seen.push(name.clone());
            if prompt.trim().is_empty() {
                jobs.push((name, Err("prompt vazio".into())));
                continue;
            }
            match shared.resolve_scoped(source, &name, &["terminal"], false) {
                Ok(id) => {
                    emit_interaction(shared, source, &id);
                    let shared = Arc::clone(shared);
                    let source = source.to_string();
                    let o = opts();
                    let handle =
                        std::thread::spawn(move || shared.ask_blocking(&source, &id, &prompt, &o));
                    jobs.push((name, Ok(handle)));
                }
                Err(e) => jobs.push((name, Err(e.message()))),
            }
        }
        let mut any_problem = false;
        let results: Vec<Value> = jobs
            .into_iter()
            .map(|(name, job)| match job {
                Ok(handle) => match handle.join() {
                    Ok(r) if r.code < 400 => {
                        any_problem |= r.warn;
                        if r.warn {
                            json!({ "name": name, "output": r.body, "warning": true })
                        } else {
                            json!({ "name": name, "output": r.body })
                        }
                    }
                    Ok(r) => {
                        any_problem = true;
                        json!({ "name": name, "error": r.body })
                    }
                    Err(_) => {
                        any_problem = true;
                        json!({ "name": name, "error": "falha interna no ask" })
                    }
                },
                Err(e) => {
                    any_problem = true;
                    json!({ "name": name, "error": e })
                }
            })
            .collect();
        let text = serde_json::to_string_pretty(&Value::Array(results)).unwrap_or_default();
        return if any_problem {
            Reply::warn(text)
        } else {
            Reply::ok(text)
        };
    }

    let agent = s(v, "agent");
    let prompt = s(v, "prompt");
    if agent.is_empty() || prompt.is_empty() {
        return Reply::err(
            400,
            "Uso: colmeia ask \"<agente>\" \"<prompt>\"  (ou --file, ou - para stdin)",
        );
    }
    let id = match shared.resolve_scoped(source, &agent, &["terminal"], false) {
        Ok(id) => id,
        Err(e) => return e.into(),
    };
    emit_interaction(shared, source, &id);
    if b(v, "raw").unwrap_or(false) {
        return shared.ask_raw(&id, &decode_escapes(&prompt)).into();
    }
    if !b(v, "wait").unwrap_or(true) {
        return shared.ask_no_wait(source, &id, &prompt).into();
    }
    shared.ask_blocking(source, &id, &prompt, &opts()).into()
}

fn context(shared: &Shared, source: &str) -> Reply {
    let notes = shared.connected_notes(source);
    if notes.is_empty() {
        return Reply::ok("Nenhuma nota conectada a você.");
    }
    Reply::ok(
        notes
            .iter()
            .map(|(title, content)| format!("### NOTA: {title}\n{content}"))
            .collect::<Vec<_>>()
            .join("\n\n"),
    )
}

fn note(shared: &Shared, source: &str, v: &Value) -> Reply {
    let action = s(v, "action");
    let team = shared.is_maestro(source);
    let resolve_note = |name: &str| shared.resolve_scoped(source, name, &["note"], team);
    match action.as_str() {
        "" | "create" => {
            let title = s(v, "title");
            if title.trim().is_empty() {
                return Reply::err(
                    400,
                    "Uso: colmeia note create \"<título>\" [\"<texto>\"] [--to \"<agente>\"]",
                );
            }
            let target_name = s(v, "target");
            let mut target_id = String::new();
            if !target_name.is_empty() {
                match shared.resolve_scoped(source, &target_name, &["terminal"], team) {
                    Ok(id) => target_id = id,
                    Err(ScopeError::SelfTarget) => {}
                    Err(e) => return e.into(),
                }
            }
            let dest = if target_id.is_empty() {
                "você".to_string()
            } else {
                format!("\"{}\"", shared.title_of(&target_id))
            };
            shared.emit(
                "colmeia://add-note",
                AddNotePayload {
                    title: title.clone(),
                    content: s(v, "content"),
                    source: source.to_string(),
                    target: target_id,
                },
            );
            Reply::ok(format!("Nota \"{title}\" criada e ligada a {dest}."))
        }
        "list" => {
            let (nodes, edges) = shared.graph_snapshot();
            let mut ids: Vec<(String, usize)> = scope::note_depths(&nodes, &edges, source);
            if team {
                let reach = scope::team_reach(&nodes, &edges, source);
                for n in nodes
                    .iter()
                    .filter(|n| n.kind == "note" && reach.contains(&n.id))
                {
                    if !ids.iter().any(|(id, _)| id == &n.id) {
                        ids.push((n.id.clone(), 1));
                    }
                }
            }
            if ids.is_empty() {
                return Reply::ok(
                    "Nenhuma nota ao seu alcance. Crie uma com `colmeia note create`.",
                );
            }
            let lines: Vec<String> = ids
                .iter()
                .filter_map(|(id, depth)| nodes.iter().find(|n| &n.id == id).map(|n| (n, *depth)))
                .map(|(n, depth)| {
                    let lines = if n.content.is_empty() {
                        0
                    } else {
                        n.content.lines().count()
                    };
                    let locked = if n.locked { " [travada]" } else { "" };
                    format!(
                        "{}- \"{}\" ({lines} linhas){locked}",
                        "  ".repeat(depth),
                        n.title
                    )
                })
                .collect();
            Reply::ok(format!("Notas:\n{}", lines.join("\n")))
        }
        "read" => {
            let name = s(v, "name");
            let id = match resolve_note(&name) {
                Ok(id) => id,
                Err(e) => return e.into(),
            };
            let n = shared.node(&id).unwrap_or_default();
            emit_interaction(shared, source, &id);
            let offset = u(v, "offset").unwrap_or(1).max(1) as usize;
            let limit = u(v, "limit").unwrap_or(2000).max(1) as usize;
            let total = n.content.lines().count();
            if total == 0 {
                return Reply::ok(format!("(nota \"{}\" vazia)", n.title));
            }
            let body: Vec<String> = n
                .content
                .lines()
                .enumerate()
                .skip(offset - 1)
                .take(limit)
                .map(|(i, l)| format!("{:>5}  {l}", i + 1))
                .collect();
            if body.is_empty() {
                return Reply::err(
                    400,
                    format!("A nota \"{}\" tem só {total} linhas.", n.title),
                );
            }
            let shown_end = offset - 1 + body.len();
            let more = if shown_end < total {
                format!("\n… (linhas {offset}–{shown_end} de {total}; continue com `colmeia note read \"{}\" {}`)", n.title, shown_end + 1)
            } else {
                String::new()
            };
            Reply::ok(format!("{}{more}", body.join("\n")))
        }
        "write" | "edit" => {
            let name = s(v, "name");
            let id = match resolve_note(&name) {
                Ok(id) => id,
                Err(e) => return e.into(),
            };
            let n = shared.node(&id).unwrap_or_default();
            if n.locked {
                return Reply::err(
                    423,
                    format!("A nota \"{}\" está travada. Você pode ler, mas só o usuário pode destravar para escrita.", n.title),
                );
            }
            let content = if action == "write" {
                s(v, "content")
            } else {
                let old = s(v, "old");
                let new = s(v, "new");
                if old.is_empty() {
                    return Reply::err(
                        400,
                        "Uso: colmeia note edit \"<nota>\" \"<trecho antigo>\" \"<trecho novo>\"",
                    );
                }
                match n.content.matches(old.as_str()).count() {
                    0 => {
                        return Reply::err(
                            404,
                            format!("Não achei esse trecho em \"{}\". Leia com `colmeia note read` e copie exatamente.", n.title),
                        )
                    }
                    1 => n.content.replacen(old.as_str(), &new, 1),
                    k => {
                        return Reply::err(
                            409,
                            format!("O trecho aparece {k} vezes em \"{}\". Inclua mais contexto para ficar único.", n.title),
                        )
                    }
                }
            };
            shared.apply_note_content(&id, &content);
            shared.emit(
                "colmeia://note-update",
                NoteUpdatePayload {
                    id: id.clone(),
                    content: content.clone(),
                },
            );
            emit_interaction(shared, source, &id);
            Reply::ok(format!(
                "Nota \"{}\" atualizada ({} linhas).",
                n.title,
                content.lines().count()
            ))
        }
        other => Reply::err(
            400,
            format!("Ação de nota desconhecida: {other}. Use create|list|read|write|edit."),
        ),
    }
}

/// Nome de agente válido no catálogo (presets do frontend, ou os 4 padrão).
fn valid_agent(shared: &Shared, agent: &str) -> bool {
    let presets = shared.presets.lock().unwrap();
    if presets.is_empty() {
        ["claude", "codex", "ollama", "shell"].contains(&agent)
    } else {
        presets.iter().any(|p| p.id == agent)
    }
}

fn agent_ids(shared: &Shared) -> String {
    let presets = shared.presets.lock().unwrap();
    if presets.is_empty() {
        "claude, codex, ollama, shell".into()
    } else {
        presets
            .iter()
            .map(|p| p.id.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    }
}

fn role_names(shared: &Shared) -> String {
    roles::all(shared)
        .iter()
        .map(|r| r.label.clone())
        .collect::<Vec<_>>()
        .join(", ")
}

fn recruit(shared: &Shared, source: &str, v: &Value) -> Reply {
    if let Some(r) = require_maestro(shared, source, "recrutar") {
        return r;
    }
    let name = s(v, "name").trim().to_string();
    let replace = s(v, "replace");
    let agent = s(v, "agent").to_lowercase();
    let role_q = s(v, "role");
    let dir = s(v, "dir");

    if !agent.is_empty() && !valid_agent(shared, &agent) {
        return Reply::err(
            400,
            format!(
                "Agente \"{agent}\" desconhecido. Opções: {}. Veja `colmeia preset list`.",
                agent_ids(shared)
            ),
        );
    }
    let role_def: Option<RoleDef> = if role_q.is_empty() {
        None
    } else {
        match roles::find(shared, &role_q) {
            Some(r) => Some(r),
            None => {
                return Reply::err(
                    400,
                    format!(
                    "Papel \"{role_q}\" não existe. Papéis: {}. Crie um com `colmeia role create`.",
                    role_names(shared)
                ),
                )
            }
        }
    };
    if !dir.is_empty() && !std::path::Path::new(&dir).is_dir() {
        return Reply::err(400, format!("A pasta \"{dir}\" não existe."));
    }
    let (nodes, _) = shared.graph_snapshot();

    if !replace.is_empty() {
        let id = match shared.resolve_scoped(source, &replace, &["terminal"], true) {
            Ok(id) => id,
            Err(e) => return e.into(),
        };
        if !name.is_empty()
            && nodes
                .iter()
                .any(|n| n.kind == "terminal" && n.id != id && same_name(&n.title, &name))
        {
            return Reply::err(
                409,
                format!("Já existe um nó chamado \"{name}\". Escolha outro codinome."),
            );
        }
        let mut patch = serde_json::Map::new();
        if !name.is_empty() {
            patch.insert("title".into(), json!(name));
        }
        if !agent.is_empty() {
            patch.insert("agent".into(), json!(agent));
        }
        if let Some(r) = &role_def {
            patch.insert("role".into(), json!(r.id));
        }
        if !dir.is_empty() {
            patch.insert("cwd".into(), json!(dir));
        }
        if patch.is_empty() {
            return Reply::err(
                400,
                "Diga o que trocar: --agent, --role, --dir e/ou um novo nome.",
            );
        }
        let old_title = shared.title_of(&id);
        shared.emit(
            "colmeia://node-update",
            NodeUpdatePayload {
                id,
                patch: Value::Object(patch),
                restart: true,
            },
        );
        return Reply::ok(format!(
            "\"{old_title}\" vai reiniciar com as mudanças; nó e conexões ficam. A conversa anterior se perde — \
mande um `colmeia ask` com o contexto quando ele subir."
        ));
    }

    if name.is_empty() {
        return Reply::err(400, "Uso: colmeia recruit \"<codinome>\" [--agent claude|codex|ollama|shell] [--role \"<papel>\"] [--dir \"<pasta>\"]");
    }
    if nodes
        .iter()
        .any(|n| n.kind == "terminal" && same_name(&n.title, &name))
    {
        return Reply::err(
            409,
            format!(
                "Já existe um nó chamado \"{name}\". Escolha outro codinome (ou use --replace)."
            ),
        );
    }
    // Sem --agent: uma cópia de você (mesmo tipo de agente).
    let agent = if agent.is_empty() {
        nodes
            .iter()
            .find(|n| n.id == source)
            .map(|n| n.agent.clone())
            .filter(|a| !a.is_empty() && valid_agent(shared, a))
            .unwrap_or_else(|| "claude".into())
    } else {
        agent
    };
    shared.emit(
        "colmeia://recruit",
        RecruitPayload {
            name: name.clone(),
            agent: agent.clone(),
            role: role_def.as_ref().map(|r| r.id.clone()).unwrap_or_default(),
            dir,
            source: source.to_string(),
        },
    );
    // Espera o nó aparecer no grafo (o frontend cria e espelha via set_graph).
    let start = Instant::now();
    let mut created = false;
    while start.elapsed() < Duration::from_secs(6) {
        if shared
            .graph_snapshot()
            .0
            .iter()
            .any(|n| n.kind == "terminal" && same_name(&n.title, &name))
        {
            created = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    let role_txt = role_def
        .map(|r| format!(", papel {}", r.label))
        .unwrap_or_else(|| ", sem papel".into());
    if created {
        Reply::ok(format!(
            "Recrutado \"{name}\" ({agent}{role_txt}), ligado a você. Ele ainda está iniciando; o primeiro \
`colmeia ask \"{name}\" …` espera o boot."
        ))
    } else {
        Reply::warn(format!(
            "aviso: pedi ao canvas para criar \"{name}\", mas ele ainda não apareceu. Confira com `colmeia list` daqui a pouco."
        ))
    }
}

fn dismiss(shared: &Shared, source: &str, v: &Value) -> Reply {
    if let Some(r) = require_maestro(shared, source, "dispensar agentes") {
        return r;
    }
    let title = s(v, "title");
    if title.is_empty() {
        return Reply::err(400, "Uso: colmeia dismiss \"<nome>\"");
    }
    match shared.resolve_scoped(source, &title, &["terminal"], false) {
        Ok(id) => {
            let t = shared.title_of(&id);
            shared.emit(
                "colmeia://dismiss",
                DismissPayload {
                    id,
                    title: t.clone(),
                },
            );
            Reply::ok(format!("Dispensando \"{t}\"."))
        }
        Err(e) => e.into(),
    }
}

/// Mesmas regras de tipo do canvas (`src/lib/connections.ts`): terminal↔terminal,
/// terminal↔nota, nota↔nota, terminal↔portal, portal↔portal e band↔(terminal|nota|
/// portal|band). Nota↔portal, imagem/texto e grupo comum não se ligam, nem um membro
/// à própria band.
fn connection_refusal(
    nodes: &[crate::pty::NodeInfo],
    a: &str,
    b: &str,
) -> Option<String> {
    let find = |id: &str| nodes.iter().find(|n| n.id == id);
    let (Some(na), Some(nb)) = (find(a), find(b)) else {
        return None; // ainda não sincronizado: o canvas valida de novo
    };
    let kind = |n: &crate::pty::NodeInfo| -> &'static str {
        match n.kind.as_str() {
            "terminal" => "terminal",
            "note" => "note",
            "browser" => "browser",
            "group" if n.band => "band",
            _ => "other",
        }
    };
    let (ka, kb) = (kind(na), kind(nb));
    let mut pair = [ka, kb];
    pair.sort_unstable();
    let ok = matches!(
        (pair[0], pair[1]),
        ("terminal", "terminal")
            | ("note", "terminal")
            | ("note", "note")
            | ("browser", "terminal")
            | ("browser", "browser")
            | ("band", "terminal")
            | ("band", "note")
            | ("band", "browser")
            | ("band", "band")
    );
    if !ok {
        return Some(format!(
            "\"{}\" ({ka}) e \"{}\" ({kb}) não podem ser ligados. Notas não se ligam a portais; imagens, textos e grupos comuns não se ligam.",
            na.title, nb.title
        ));
    }
    if na.parent == nb.id || nb.parent == na.id {
        return Some("Um membro já faz parte da própria band — não precisa de linha.".into());
    }
    None
}

fn connect(shared: &Shared, source: &str, v: &Value) -> Reply {
    let a = s(v, "source");
    let b_name = s(v, "target");
    if a.is_empty() || b_name.is_empty() {
        return Reply::err(400, "Uso: colmeia connect \"<a>\" \"<b>\"");
    }
    let team = shared.is_maestro(source);
    let my_title = shared.title_of(source);
    let pick = |name: &str| -> Result<String, ScopeError> {
        if name == source || same_name(name, &my_title) {
            return Ok(source.to_string());
        }
        // Orquestrador alcança a árvore do time; os demais, só o próprio alcance.
        shared.resolve_scoped(source, name, &[], team)
    };
    let ida = match pick(&a) {
        Ok(id) => id,
        Err(ScopeError::NotConnected(n)) if !team => {
            return Reply::err(
                403,
                format!("Sem conexão com \"{n}\". Só o orquestrador conecta nós fora do próprio alcance. Rode `colmeia list`."),
            )
        }
        Err(e) => return e.into(),
    };
    let idb = match pick(&b_name) {
        Ok(id) => id,
        Err(ScopeError::NotConnected(n)) if !team => {
            return Reply::err(
                403,
                format!("Sem conexão com \"{n}\". Só o orquestrador conecta nós fora do próprio alcance. Rode `colmeia list`."),
            )
        }
        Err(e) => return e.into(),
    };
    if ida == idb {
        return Reply::err(400, "Os dois lados são o mesmo nó.");
    }
    let (nodes, edges) = shared.graph_snapshot();
    if let Some(why) = connection_refusal(&nodes, &ida, &idb) {
        return Reply::err(400, why);
    }
    let ta = shared.title_of(&ida);
    let tb = shared.title_of(&idb);
    if scope::neighbors(&edges, &ida).contains(&idb) {
        return Reply::ok(format!("\"{ta}\" e \"{tb}\" já estão conectados."));
    }
    shared.emit(
        "colmeia://connect",
        ConnectPayload {
            source: ida,
            target: idb,
        },
    );
    Reply::ok(format!(
        "Conectando \"{ta}\" ↔ \"{tb}\". Avise os dois de que podem falar um com o outro."
    ))
}

fn role(shared: &Shared, source: &str, v: &Value) -> Reply {
    let action = s(v, "action");
    let name = s(v, "name");
    let all = roles::all(shared);
    let exact = |q: &str| {
        all.iter()
            .find(|r| r.id == q.trim().to_lowercase() || same_name(&r.label, q))
            .cloned()
    };
    match action.as_str() {
        "" | "list" => {
            let lines: Vec<String> = all
                .iter()
                .map(|r| {
                    let preview: String = r
                        .prompt
                        .split_whitespace()
                        .collect::<Vec<_>>()
                        .join(" ")
                        .chars()
                        .take(90)
                        .collect();
                    let tag = if r.builtin { " · padrão" } else { "" };
                    format!("  - {} (id: {}){tag}: {preview}…", r.label, r.id)
                })
                .collect();
            Reply::ok(format!(
                "Papéis (`colmeia role show \"<papel>\"` mostra o prompt completo):\n{}",
                lines.join("\n")
            ))
        }
        "show" => match roles::find_in(&all, &name) {
            Some(r) => Reply::ok(format!("# {} (id: {})\n\n{}", r.label, r.id, r.prompt)),
            None => Reply::err(
                404,
                format!(
                    "Papel \"{name}\" não existe. Papéis: {}.",
                    role_names(shared)
                ),
            ),
        },
        "create" => {
            if let Some(r) = require_maestro(shared, source, "criar papéis") {
                return r;
            }
            let prompt = s(v, "prompt");
            if name.trim().is_empty() || prompt.trim().is_empty() {
                return Reply::err(
                    400,
                    "Uso: colmeia role create \"<nome>\" \"<prompt>\"  (ou --file papel.md)",
                );
            }
            if exact(&name).is_some() {
                return Reply::err(
                    409,
                    format!(
                        "O papel \"{name}\" já existe. Use `colmeia role write` ou `role edit`."
                    ),
                );
            }
            let base = roles::slug(&name);
            let mut id = base.clone();
            let mut k = 2;
            while all.iter().any(|r| r.id == id) {
                id = format!("{base}-{k}");
                k += 1;
            }
            let def = RoleDef {
                id,
                label: name.trim().to_string(),
                color: String::new(),
                prompt,
                builtin: false,
            };
            match roles::upsert(shared, def) {
                Ok(r) => {
                    shared.emit("colmeia://roles-changed", ());
                    Reply::ok(format!("Papel \"{}\" criado (id: {}). Use `colmeia recruit \"<codinome>\" --role \"{}\"`.", r.label, r.id, r.label))
                }
                Err(e) => Reply::err(500, format!("Não consegui salvar o papel: {e}")),
            }
        }
        "write" | "edit" => {
            if let Some(r) = require_maestro(shared, source, "editar papéis") {
                return r;
            }
            let Some(current) = roles::find_in(&all, &name) else {
                return Reply::err(
                    404,
                    format!(
                        "Papel \"{name}\" não existe. Papéis: {}.",
                        role_names(shared)
                    ),
                );
            };
            let prompt = if action == "write" {
                s(v, "prompt")
            } else {
                let old = s(v, "old");
                let new = s(v, "new");
                if old.is_empty() {
                    return Reply::err(
                        400,
                        "Uso: colmeia role edit \"<papel>\" \"<trecho antigo>\" \"<trecho novo>\"",
                    );
                }
                match current.prompt.matches(old.as_str()).count() {
                    0 => {
                        return Reply::err(
                            404,
                            format!(
                            "Não achei esse trecho no papel \"{}\". Veja com `colmeia role show`.",
                            current.label
                        ),
                        )
                    }
                    1 => current.prompt.replacen(old.as_str(), &new, 1),
                    k => {
                        return Reply::err(
                            409,
                            format!(
                                "O trecho aparece {k} vezes no papel \"{}\". Inclua mais contexto.",
                                current.label
                            ),
                        )
                    }
                }
            };
            let def = RoleDef { prompt, ..current };
            match roles::upsert(shared, def) {
                Ok(r) => {
                    shared.emit("colmeia://roles-changed", ());
                    Reply::ok(format!(
                        "Papel \"{}\" atualizado. Vale para quem iniciar daqui em diante; para aplicar a um recruta, `colmeia role assign \"<agente>\" \"{}\"`.",
                        r.label, r.label
                    ))
                }
                Err(e) => Reply::err(500, format!("Não consegui salvar o papel: {e}")),
            }
        }
        "assign" => {
            if let Some(r) = require_maestro(shared, source, "atribuir papéis") {
                return r;
            }
            let agent = s(v, "agent");
            if agent.is_empty() {
                return Reply::err(
                    400,
                    "Uso: colmeia role assign \"<agente>\" \"<papel>\"  (ou --none)",
                );
            }
            let id = match shared.resolve_scoped(source, &agent, &["terminal"], true) {
                Ok(id) => id,
                Err(e) => return e.into(),
            };
            let none = b(v, "none").unwrap_or(false);
            let role_id = if none {
                String::new()
            } else {
                match roles::find_in(&all, &name) {
                    Some(r) => r.id,
                    None => {
                        return Reply::err(
                            404,
                            format!(
                                "Papel \"{name}\" não existe. Papéis: {}.",
                                role_names(shared)
                            ),
                        )
                    }
                }
            };
            let title = shared.title_of(&id);
            shared.emit(
                "colmeia://node-update",
                NodeUpdatePayload {
                    id,
                    patch: json!({ "role": role_id }),
                    restart: true,
                },
            );
            Reply::ok(format!(
                "\"{title}\" vai reiniciar {}; nó e conexões ficam. Mande um `colmeia ask` com o contexto quando ele subir.",
                if none { "sem papel".to_string() } else { format!("com o papel {name}") }
            ))
        }
        other => Reply::err(
            400,
            format!("Ação de papel desconhecida: {other}. Use list|show|create|edit|write|assign."),
        ),
    }
}

fn preset(shared: &Shared) -> Reply {
    let presets = shared.presets.lock().unwrap().clone();
    if presets.is_empty() {
        return Reply::ok("Agentes disponíveis (--agent): claude, codex, ollama, shell");
    }
    let lines: Vec<String> = presets
        .iter()
        .map(|p| {
            let cmd = if p.command.is_empty() {
                String::new()
            } else {
                format!(" — `{}`", p.command)
            };
            format!("  - {} ({}){cmd}", p.id, p.label)
        })
        .collect();
    Reply::ok(format!(
        "Agentes disponíveis (use o id em --agent):\n{}",
        lines.join("\n")
    ))
}

fn notify(shared: &Shared, source: &str, v: &Value) -> Reply {
    let mut title = s(v, "title");
    let body: String = s(v, "body").chars().take(500).collect();
    if title.trim().is_empty() && body.trim().is_empty() {
        return Reply::err(400, "Uso: colmeia notify \"<título>\" \"<texto>\"");
    }
    if title.trim().is_empty() {
        title = shared.title_of(source);
    }
    let title: String = title.chars().take(120).collect();
    shared.emit(
        "colmeia://notify",
        NotifyPayload {
            id: source.to_string(),
            title,
            body,
        },
    );
    Reply::ok("Notificação enviada ao usuário.")
}

fn status(shared: &Shared, source: &str, v: &Value) -> Reply {
    let mut state = s(v, "state").to_lowercase();
    if state == "clear" || state == "none" {
        state.clear();
    }
    if !["working", "blocked", "review", "done", ""].contains(&state.as_str()) {
        return Reply::err(
            400,
            "Uso: colmeia status <working|blocked|review|done|clear> \"<texto>\"",
        );
    }
    let text: String = s(v, "text").chars().take(300).collect();
    shared.emit(
        "colmeia://status",
        StatusPayload {
            id: source.to_string(),
            state: state.clone(),
            text,
        },
    );
    Reply::ok(if state.is_empty() {
        "Status limpo.".to_string()
    } else {
        format!("Status: {state}.")
    })
}

/// `colmeia routine …` — delega ao scheduler de `routines.rs`, mas aplica antes
/// o escopo pelas arestas e a regra de Maestro deste servidor:
/// - o alvo (`--terminal`) é resolvido com escopo e repassado como id;
/// - criar/editar/apagar/ligar/rodar exige Maestro, exceto quando o alvo é o
///   próprio terminal que chamou (ou um lembrete sem alvo).
fn routine(shared: &Arc<Shared>, source: &str, v: &Value) -> Reply {
    let action = {
        let a = s(v, "action");
        if a.is_empty() { "list".to_string() } else { a }
    };
    let mut args = v.clone();
    let terminal = {
        let t = s(v, "terminal");
        if t.is_empty() { s(v, "target") } else { t }
    };
    let reminder = v.get("reminder").and_then(Value::as_bool).unwrap_or(false);
    let mut targets_self = !reminder && terminal.is_empty();
    if !terminal.is_empty() {
        let id = if terminal == source || same_name(&terminal, &shared.title_of(source)) {
            source.to_string()
        } else {
            match shared.resolve_scoped(source, &terminal, &["terminal"], true) {
                Ok(id) => id,
                Err(e) => return e.into(),
            }
        };
        targets_self = id == source;
        if let Some(obj) = args.as_object_mut() {
            obj.remove("target");
            obj.insert("terminal".into(), Value::String(id));
        }
    }
    let mutating = !matches!(action.as_str(), "list" | "show");
    let self_service = action == "create" && (targets_self || reminder);
    if mutating && !self_service {
        if let Some(r) = require_maestro(shared, source, "gerenciar rotinas de outros terminais") {
            return r;
        }
    }
    let Some(app) = shared.app_handle() else {
        return Reply::err(503, "App ainda iniciando; tente de novo.");
    };
    let (code, body) = crate::routines::cli_routine(shared, &app, source, &args);
    if (200..300).contains(&code) {
        Reply::ok(body)
    } else {
        Reply::err(code, body)
    }
}

/// `colmeia floor …` — delega a `floors::cli_floor` (que já recusa land/delete
/// de dentro de um floor). Criar, aterrissar e apagar floors exige Maestro;
/// `list` e `status` (do próprio floor) ficam livres.
fn floor(shared: &Arc<Shared>, source: &str, v: &Value) -> Reply {
    let action = {
        let a = s(v, "action");
        if a.is_empty() { "list".to_string() } else { a }
    };
    if matches!(action.as_str(), "create" | "land" | "delete") {
        if let Some(r) = require_maestro(shared, source, "criar, aterrissar ou apagar floors") {
            return r;
        }
    }
    let Some(app) = shared.app_handle() else {
        return Reply::err(503, "App ainda iniciando; tente de novo.");
    };
    let (code, body) = crate::floors::cli_floor(shared, &app, source, v);
    if (200..300).contains(&code) {
        Reply::ok(body)
    } else {
        Reply::err(code, body)
    }
}

/// `colmeia partitura list|insert` — inserir um time salvo exige Maestro.
fn partitura(shared: &Arc<Shared>, source: &str, v: &Value) -> Reply {
    if s(v, "action") == "insert" {
        if let Some(r) = require_maestro(shared, source, "inserir partituras") {
            return r;
        }
    }
    let (code, body) = crate::partituras::cli(shared, source, v);
    if !(200..300).contains(&code) {
        Reply::err(code, body)
    } else if body.starts_with("aviso:") {
        Reply::warn(body)
    } else {
        Reply::ok(body)
    }
}

/// Portal (navegador CDP no canvas): delega ao módulo `portal`. Também atende
/// os atalhos antigos `/browse` (open + snapshot) e `/click`/`/type` (seletor).
fn portal(shared: &Arc<Shared>, source: &str, path: &str, v: &Value) -> Reply {
    let (code, body) = crate::portal::cli(shared, source, path, v);
    if !(200..300).contains(&code) {
        Reply::err(code, body)
    } else if body.starts_with("aviso:") {
        Reply::warn(body)
    } else {
        Reply::ok(body)
    }
}

/// Hook de aprovação: bloqueia até o humano decidir no painel central.
fn approve(shared: &Shared, source: &str, v: &Value) -> Reply {
    let tool = s(v, "tool");
    let summary = s(v, "summary");
    let allow = || {
        json!({"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}})
            .to_string()
    };
    // Regra de auto-aprovação (por ferramenta) OU escrita dentro da pasta do agente?
    if shared.is_auto_allowed(source, &tool)
        || shared.should_auto_approve_write(source, &tool, &summary)
    {
        return Reply::ok(allow());
    }
    let suffix: String = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(8)
        .map(char::from)
        .collect();
    let approval_id = format!("apv-{suffix}");
    let (tx, rx) = mpsc::channel::<bool>();
    shared.add_pending(approval_id.clone(), source.to_string(), tx);
    shared.emit(
        "colmeia://approval-request",
        ApprovalRequest {
            id: approval_id.clone(),
            node: source.to_string(),
            title: shared.title_of(source),
            tool,
            summary,
        },
    );

    let outcome = rx.recv_timeout(Duration::from_secs(540));
    shared.take_pending(&approval_id);
    shared.emit(
        "colmeia://approval-resolved",
        ApprovalResolved { id: approval_id },
    );

    let json = match outcome {
        Ok(false) => json!({"hookSpecificOutput":{
            "hookEventName":"PreToolUse",
            "permissionDecision":"deny",
            "permissionDecisionReason":"Recusado no painel do colmeia"
        }})
        .to_string(),
        Ok(true) => allow(),
        // Timeout: cai no fluxo normal (prompt no terminal do agente).
        Err(_) => {
            json!({"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask"}})
                .to_string()
        }
    };
    Reply::ok(json)
}
