// Portal: navegador de verdade no canvas, controlado por CDP.
//
// - Cada nó "browser" do canvas tem (sob demanda) um Chromium headless próprio
//   (`browser.rs`), com perfil isolado em `app_data_dir/portal-profile/<id>` e
//   DevTools só em 127.0.0.1 (porta aleatória).
// - `cdp.rs` fala o protocolo por WebSocket síncrono (uma thread por portal) e
//   manda o screencast ao nó por um `Channel`; `actions.rs` tem as ações.
// - O agente controla o portal pela CLI (`colmeia portal …`, rota `/portal`),
//   sempre com escopo pelas arestas do canvas; o usuário, pelo próprio quadro.
//
// Segurança: agentes nunca preenchem campos de senha; `eval` só para maestro;
// nada escuta fora do loopback; o perfil não é o do navegador do usuário.

mod actions;
mod browser;
mod cdp;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use rand::distributions::Alphanumeric;
use rand::Rng;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager};

use crate::pty::Shared;
use actions::{Fail, Target, WaitFor};
use cdp::{PortalEvent, Session};

const NO_BROWSER: &str = "Não achei um navegador Chromium (Edge, Chrome, Chromium ou Brave) nesta \
máquina. Instale um deles ou aponte a variável COLMEIA_BROWSER para o executável.";

const DEFAULT_VIEWPORT: (u32, u32) = (1280, 800);

// ── Registro de sessões ──────────────────────────────────────────────────

/// Um slot por id de nó; o Mutex do slot serializa a criação da sessão.
type Slot = Arc<Mutex<Option<Arc<Session>>>>;

fn registry() -> &'static Mutex<HashMap<String, Slot>> {
    static R: OnceLock<Mutex<HashMap<String, Slot>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Chave do attach mais recente de cada nó (descarta attach/detach atrasados).
fn attach_keys() -> &'static Mutex<HashMap<String, String>> {
    static K: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    K.get_or_init(|| Mutex::new(HashMap::new()))
}

fn slot(id: &str) -> Slot {
    registry()
        .lock()
        .unwrap()
        .entry(id.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(None)))
        .clone()
}

/// Sessão viva do nó, sem esperar uma criação em andamento.
fn live(id: &str) -> Option<Arc<Session>> {
    let slot = registry().lock().unwrap().get(id).cloned()?;
    let found = match slot.try_lock() {
        Ok(guard) => guard.as_ref().filter(|s| s.is_alive()).cloned(),
        Err(_) => None,
    };
    found
}

fn safe_id(id: &str) -> String {
    id.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .take(80)
        .collect()
}

/// Sessão do nó `id`, criando (lançando o navegador) se preciso.
/// Devolve (sessão, criada_agora).
fn ensure(id: &str, data_dir: &Path) -> Result<(Arc<Session>, bool), String> {
    let slot = slot(id);
    let mut guard = slot.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(s) = guard.as_ref() {
        if s.is_alive() {
            return Ok((Arc::clone(s), false));
        }
        s.shutdown();
    }
    *guard = None;

    let exe = browser::find_browser().ok_or_else(|| NO_BROWSER.to_string())?;
    let profile = data_dir.join("portal-profile").join(safe_id(id));
    let (w, h) = DEFAULT_VIEWPORT;
    let launched = browser::launch(&exe, &profile, w, h)?;
    let port = launched.port;
    let mut child = launched.child;
    let target = match browser::page_target(port) {
        Ok(t) => t,
        Err(e) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(e);
        }
    };
    let ua = browser::user_agent(port);
    let session = match Session::connect(id, port, &target, profile, (w, h)) {
        Ok(s) => s,
        Err(e) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(e);
        }
    };
    session.set_child(child);
    if let Err(e) = actions::setup(&session, ua) {
        session.shutdown();
        return Err(e);
    }
    *guard = Some(Arc::clone(&session));
    Ok((session, true))
}

/// Fecha a sessão do nó (mata o navegador); opcionalmente apaga o perfil.
fn close(id: &str, delete_profile: bool) {
    let slot = registry().lock().unwrap().remove(id);
    let Some(slot) = slot else { return };
    let taken = slot.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(s) = taken {
        s.shutdown();
        if delete_profile {
            let dir = s.profile_dir.clone();
            // O Chromium pode segurar arquivos por um instante depois de morrer.
            for _ in 0..10 {
                if !dir.exists() || std::fs::remove_dir_all(&dir).is_ok() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(500));
            }
        }
    }
}

/// Mata todos os navegadores (saída do app).
pub fn shutdown_all() {
    let slots: Vec<Slot> = registry().lock().unwrap().drain().map(|(_, s)| s).collect();
    for slot in slots {
        let taken = match slot.try_lock() {
            Ok(mut g) => g.take(),
            Err(_) => None,
        };
        if let Some(s) = taken {
            s.shutdown();
        }
    }
}

// ── Comandos Tauri (o nó do canvas) ──────────────────────────────────────

fn app_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

/// O nó montou: garante a sessão, liga o screencast ao canal e ajusta o viewport.
/// Roda numa thread (lançar o navegador leva segundos); erros vão pelo canal.
#[tauri::command]
pub fn portal_attach(
    app: AppHandle,
    id: String,
    key: String,
    url: Option<String>,
    channel: Channel<PortalEvent>,
    width: u32,
    height: u32,
) -> Result<(), String> {
    let dir = app_dir(&app)?;
    attach_keys()
        .lock()
        .unwrap()
        .insert(id.clone(), key.clone());
    std::thread::spawn(move || {
        let _ = channel.send(PortalEvent::Status {
            text: "abrindo o navegador…".into(),
        });
        match ensure(&id, &dir) {
            Ok((s, created)) => {
                let current = attach_keys().lock().unwrap().get(&id).cloned();
                if current.as_deref() != Some(key.as_str()) {
                    return; // o nó desmontou enquanto o navegador abria
                }
                s.set_channel(key, channel.clone());
                s.resize(width, height);
                s.start_screencast();
                let _ = channel.send(PortalEvent::Status { text: String::new() });
                if created {
                    if let Some(u) = url.as_deref().and_then(actions::normalize_url) {
                        let _g = s.action_lock.lock().unwrap_or_else(|e| e.into_inner());
                        if let Err(e) = actions::navigate(&s, &u) {
                            let _ = channel.send(PortalEvent::Status {
                                text: format!("erro: {e}"),
                            });
                        }
                    }
                }
                s.push_still_frame();
                s.emit_nav();
            }
            Err(e) => {
                let _ = channel.send(PortalEvent::Error { message: e });
            }
        }
    });
    Ok(())
}

/// O nó desmontou (troca de workspace etc.): para o screencast, mantém o navegador.
#[tauri::command]
pub fn portal_detach(id: String, key: String) {
    {
        let mut keys = attach_keys().lock().unwrap();
        if keys.get(&id).map(|k| k == &key).unwrap_or(false) {
            keys.remove(&id);
        }
    }
    if let Some(s) = live(&id) {
        if s.clear_channel(&key) {
            s.stop_screencast();
        }
    }
}

/// O nó foi deletado: mata o navegador e apaga o perfil do portal.
#[tauri::command]
pub fn portal_close(id: String) {
    attach_keys().lock().unwrap().remove(&id);
    std::thread::spawn(move || close(&id, true));
}

/// O quadro do nó mudou de tamanho (px CSS, independente do zoom do canvas).
#[tauri::command]
pub fn portal_resize(id: String, width: u32, height: u32) {
    if let Some(s) = live(&id) {
        s.resize(width, height);
    }
}

/// Entrada do usuário no quadro: `{kind: "mouse"|"key", params}` (parâmetros
/// CDP já montados pelo frontend) ou `{kind: "text", text}`.
#[tauri::command]
pub fn portal_input(id: String, event: Value) {
    let Some(s) = live(&id) else { return };
    let params = event.get("params").cloned().unwrap_or_else(|| json!({}));
    match event.get("kind").and_then(Value::as_str) {
        Some("mouse") => s.send("Input.dispatchMouseEvent", params),
        Some("key") => s.send("Input.dispatchKeyEvent", params),
        Some("text") => {
            let text = event.get("text").and_then(Value::as_str).unwrap_or("");
            if !text.is_empty() {
                s.send("Input.insertText", json!({ "text": text }));
            }
        }
        _ => return,
    }
    s.mark_active();
}

/// Barra de endereço do nó.
#[tauri::command]
pub fn portal_navigate(app: AppHandle, id: String, url: String) -> Result<(), String> {
    let dir = app_dir(&app)?;
    let Some(u) = actions::normalize_url(&url) else {
        return Err("URL inválida (use http:// ou https://).".into());
    };
    std::thread::spawn(move || {
        if let Ok((s, _)) = ensure(&id, &dir) {
            let _g = s.action_lock.lock().unwrap_or_else(|e| e.into_inner());
            if let Err(e) = actions::navigate(&s, &u) {
                s.emit(PortalEvent::Status {
                    text: format!("erro: {e}"),
                });
            }
        }
    });
    Ok(())
}

/// Botões voltar/avançar/recarregar do nó.
#[tauri::command]
pub fn portal_history(id: String, action: String) {
    std::thread::spawn(move || {
        let Some(s) = live(&id) else { return };
        let _g = s.action_lock.lock().unwrap_or_else(|e| e.into_inner());
        let _ = match action.as_str() {
            "back" => actions::history(&s, -1),
            "forward" => actions::history(&s, 1),
            _ => actions::reload(&s),
        };
    });
}

// ── CLI (`colmeia portal …`, rota /portal e atalhos antigos) ─────────────

#[derive(Clone, Serialize)]
struct PortalOpenPayload {
    id: String,
    url: String,
    source: String,
    title: String,
}

#[derive(Clone, Serialize)]
struct PortalReattach {
    id: String,
}

fn sv(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}
fn bv(v: &Value, key: &str) -> bool {
    v.get(key).and_then(Value::as_bool).unwrap_or(false)
}
fn fv(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(|x| {
        x.as_f64()
            .or_else(|| x.as_str().and_then(|s| s.trim().parse().ok()))
    })
}

/// Portais (id, título) ao alcance direto de `source`.
fn connected_portals(shared: &Shared, source: &str) -> Vec<(String, String)> {
    let reach = shared.reach_of(source);
    let (nodes, _) = shared.graph_snapshot();
    nodes
        .into_iter()
        .filter(|n| n.kind == "browser" && reach.contains(&n.id))
        .map(|n| (n.id, n.title))
        .collect()
}

/// Resolve o portal alvo: pelo nome, ou o único ligado a você.
fn pick_portal(shared: &Shared, source: &str, name: &str) -> Result<String, Fail> {
    if !name.trim().is_empty() {
        return shared
            .resolve_scoped(source, name, &["browser"], false)
            .map_err(|e| Fail::new(e.status(), e.message()));
    }
    let mine = connected_portals(shared, source);
    match mine.len() {
        0 => Err(Fail::new(
            404,
            "Nenhum portal (navegador) ligado a você. Abra um com `colmeia portal open \"<url>\"`.",
        )),
        1 => Ok(mine[0].0.clone()),
        _ => Err(Fail::new(
            409,
            format!(
                "Há {} portais ligados a você ({}). Diga qual com --portal \"<nome>\".",
                mine.len(),
                mine.iter()
                    .map(|(_, t)| format!("\"{t}\""))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        )),
    }
}

fn unique_title(shared: &Shared) -> String {
    let (nodes, _) = shared.graph_snapshot();
    let taken = |t: &str| {
        nodes
            .iter()
            .any(|n| n.kind == "browser" && crate::scope::same_name(&n.title, t))
    };
    if !taken("Portal") {
        return "Portal".into();
    }
    (2..1000)
        .map(|i| format!("Portal {i}"))
        .find(|t| !taken(t.as_str()))
        .unwrap_or_else(|| "Portal".into())
}

fn new_portal_id() -> String {
    let suffix: String = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(10)
        .map(char::from)
        .collect::<String>()
        .to_lowercase();
    format!("browser-p{suffix}")
}

/// Sessão do portal `id` para uma ação da CLI. Se foi preciso (re)abrir o
/// navegador, volta à URL salva no nó e avisa o nó para religar o quadro.
fn session_for(shared: &Shared, id: &str, dir: &Path) -> Result<Arc<Session>, Fail> {
    let (s, created) = ensure(id, dir).map_err(|e| Fail::new(502, e))?;
    if created {
        let saved = shared.node(id).map(|n| n.content).unwrap_or_default();
        if let Some(u) = actions::normalize_url(&saved) {
            let _g = s.action_lock.lock().unwrap_or_else(|e| e.into_inner());
            let _ = actions::navigate(&s, &u);
        }
        shared.emit("colmeia://portal-reattach", PortalReattach { id: id.to_string() });
    }
    Ok(s)
}

fn reply(r: Result<String, Fail>) -> (u16, String) {
    match r {
        Ok(body) => (200, body),
        Err(f) => (f.code, f.msg),
    }
}

/// Ponto de entrada da rota `/portal` (e de `/browse`, `/click`, `/type`).
/// Resposta: (status, corpo) — corpo começando com "aviso:" vira aviso.
pub fn cli(shared: &Arc<Shared>, source: &str, path: &str, v: &Value) -> (u16, String) {
    let Some(dir) = shared.data_dir.get().cloned() else {
        return (500, "O app ainda não terminou de iniciar. Tente de novo.".into());
    };
    let action = match path {
        "/browse" => "browse".to_string(),
        "/click" => "click".to_string(),
        "/type" => "fill".to_string(),
        _ => sv(v, "action"),
    };
    let name = sv(v, "portal");

    match action.as_str() {
        "" | "help" => (
            400,
            "Uso: colmeia portal open|snapshot|click|fill|type|press|scroll|back|forward|reload|\
screenshot|wait|list|eval — rode `colmeia help portal`."
                .into(),
        ),
        "list" => (200, list(shared, source)),
        "open" | "browse" => reply(open(shared, source, v, &dir, action == "browse")),
        _ => {
            if action == "eval" && !shared.is_maestro(source) {
                return (
                    403,
                    "Só o orquestrador pode rodar JavaScript num portal (`eval`). Use snapshot/click/fill, \
ou peça ao usuário para ligar o Maestro neste nó."
                        .into(),
                );
            }
            let known = [
                "snapshot", "click", "fill", "type", "press", "scroll", "back", "forward",
                "reload", "screenshot", "wait", "eval",
            ];
            if !known.contains(&action.as_str()) {
                return (
                    400,
                    format!("Ação desconhecida: \"{action}\". Rode `colmeia help portal`."),
                );
            }
            let id = match pick_portal(shared, source, &name) {
                Ok(id) => id,
                Err(f) => return (f.code, f.msg),
            };
            let s = match session_for(shared, &id, &dir) {
                Ok(s) => s,
                Err(f) => return (f.code, f.msg),
            };
            let title = shared.title_of(&id);
            let _g = s.action_lock.lock().unwrap_or_else(|e| e.into_inner());
            let r = act(&s, &title, &action, v);
            if action != "snapshot" && action != "screenshot" && action != "wait" {
                emit_interaction(shared, source, &id);
            }
            reply(r)
        }
    }
}

/// Acende a aresta agente→portal no canvas (mesmo evento das outras rotas).
fn emit_interaction(shared: &Shared, source: &str, target: &str) {
    #[derive(Clone, Serialize)]
    struct Interaction {
        source: String,
        target: String,
    }
    shared.emit(
        "colmeia://interaction",
        Interaction {
            source: source.to_string(),
            target: target.to_string(),
        },
    );
}

fn target_arg(v: &Value) -> Result<Target, Fail> {
    // "target" (CLI nova) ou "selector" (atalhos antigos click/type).
    let raw = {
        let t = sv(v, "target");
        if t.is_empty() {
            sv(v, "selector")
        } else {
            t
        }
    };
    Target::parse(&raw).ok_or_else(|| {
        Fail::new(
            400,
            "Diga o alvo: um ref do snapshot (@e3), um ponto (x,y) ou um seletor CSS.",
        )
    })
}

fn act(s: &Session, title: &str, action: &str, v: &Value) -> Result<String, Fail> {
    match action {
        "snapshot" => {
            let max = fv(v, "chars").map(|n| n as usize).unwrap_or(4000).clamp(0, 30000);
            actions::snapshot(s, title, max)
        }
        "click" => actions::click(s, &target_arg(v)?),
        "fill" => actions::fill(s, &target_arg(v)?, &sv(v, "text")),
        "type" => actions::type_text(s, &sv(v, "text")),
        "press" => actions::press(s, &sv(v, "key")),
        "scroll" => actions::scroll(s, &sv(v, "target"), fv(v, "px")),
        "back" => actions::history(s, -1),
        "forward" => actions::history(s, 1),
        "reload" => actions::reload(s),
        "screenshot" => actions::screenshot(s, title, bv(v, "full"), bv(v, "png")),
        "wait" => {
            let secs = fv(v, "timeout").unwrap_or(10.0).clamp(0.5, 120.0);
            let raw = sv(v, "target");
            if raw.trim().is_empty() {
                return Err(Fail::new(
                    400,
                    "Uso: colmeia portal wait \"<texto>\" | @eN | --selector \"<css>\" [--timeout s] [--gone]",
                ));
            }
            let what = if bv(v, "selector") {
                WaitFor::Element(Target::Css(raw))
            } else {
                match Target::parse(&raw) {
                    Some(t @ Target::Ref(_)) => WaitFor::Element(t),
                    _ => WaitFor::Text(raw),
                }
            };
            actions::wait_for(s, &what, Duration::from_secs_f64(secs), bv(v, "gone"))
        }
        "eval" => actions::eval_js(s, &sv(v, "code")),
        _ => Err(Fail::new(400, "Ação desconhecida.")),
    }
}

fn list(shared: &Shared, source: &str) -> String {
    let mine = connected_portals(shared, source);
    if mine.is_empty() {
        return "Nenhum portal ligado a você. Abra um com `colmeia portal open \"<url>\"`.".into();
    }
    let mut out = vec!["Portais ligados a você:".to_string()];
    for (id, title) in mine {
        let line = match live(&id) {
            Some(s) => {
                let page = s.title();
                let url = s.url();
                if page.is_empty() {
                    format!("- \"{title}\" — {url}")
                } else {
                    format!("- \"{title}\" — {page} — {url}")
                }
            }
            None => {
                let saved = shared.node(&id).map(|n| n.content).unwrap_or_default();
                if saved.is_empty() {
                    format!("- \"{title}\" (navegador fechado; abre na próxima ação)")
                } else {
                    format!("- \"{title}\" — {saved} (navegador fechado; abre na próxima ação)")
                }
            }
        };
        out.push(line);
    }
    out.join("\n")
}

/// `portal open` / `browse`: navega no portal ligado a você, criando um se não houver.
fn open(shared: &Shared, source: &str, v: &Value, dir: &Path, with_snapshot: bool) -> Result<String, Fail> {
    let url = actions::normalize_url(&sv(v, "url")).ok_or_else(|| {
        Fail::new(400, "Uso: colmeia portal open \"<url>\" (http:// ou https://)")
    })?;
    let name = sv(v, "portal");
    let existing = if !name.trim().is_empty() {
        Some(pick_portal(shared, source, &name)?)
    } else {
        let mine = connected_portals(shared, source);
        match mine.len() {
            0 => None,
            1 => Some(mine[0].0.clone()),
            _ => return Err(pick_portal(shared, source, "").unwrap_err()),
        }
    };

    let (id, title, fresh) = match existing {
        Some(id) => {
            let t = shared.title_of(&id);
            (id, t, false)
        }
        None => (new_portal_id(), unique_title(shared), true),
    };

    let s = if fresh {
        let (s, _) = ensure(&id, dir).map_err(|e| Fail::new(502, e))?;
        // Cria o nó no canvas (ligado a você) já com a sessão pronta: o attach
        // do nó só pluga o quadro, sem navegar de novo.
        shared.emit(
            "colmeia://browse",
            PortalOpenPayload {
                id: id.clone(),
                url: url.clone(),
                source: source.to_string(),
                title: title.clone(),
            },
        );
        s
    } else {
        session_for(shared, &id, dir)?
    };

    let _g = s.action_lock.lock().unwrap_or_else(|e| e.into_inner());
    let loaded = actions::navigate(&s, &url).map_err(|e| Fail::new(502, e))?;
    emit_interaction(shared, source, &id);

    let mut notes = Vec::new();
    if fresh {
        // Espera o canvas espelhar o nó + aresta (set_graph) para as próximas
        // ações resolverem o portal pelo escopo.
        let deadline = Instant::now() + Duration::from_secs(5);
        while !shared.reach_of(source).contains(&id) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(100));
        }
        if !shared.reach_of(source).contains(&id) {
            notes.push(
                "aviso: o navegador abriu, mas o nó do portal ainda não apareceu ligado a você no canvas."
                    .to_string(),
            );
        }
    }
    if !loaded {
        notes.push("aviso: a página ainda está carregando depois de 25 s.".to_string());
    }

    let mut out = notes;
    out.push(format!(
        "Portal \"{title}\" {} em {}",
        if fresh { "aberto" } else { "navegou" },
        s.url()
    ));
    let page_title = s.title();
    if !page_title.is_empty() {
        out.push(format!("Título: {page_title}"));
    }
    if with_snapshot {
        out.push(String::new());
        out.push(actions::snapshot(&s, &title, 12000)?);
    } else {
        out.push(
            "Próximo passo: `colmeia portal snapshot` para ver os elementos (@eN) e o texto.".into(),
        );
    }
    Ok(out.join("\n"))
}
