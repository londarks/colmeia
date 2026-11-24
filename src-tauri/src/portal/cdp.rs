// Cliente CDP síncrono (tungstenite, sem tokio) de UM portal.
//
// Modelo de threads:
// - uma thread "bomba" por portal é a única dona do WebSocket: tira comandos de
//   uma fila (mpsc), envia, e lê respostas/eventos com timeout curto de leitura;
// - quem chama (`Session::call`) bloqueia num canal de resposta próprio, então
//   as ações de alto nível (navegar, clicar…) rodam na thread de quem pediu
//   (requisição HTTP da CLI ou comando Tauri) sem travar a bomba;
// - eventos: `Page.screencastFrame` vai ao frontend pelo `Channel` (com o ack
//   atrasado para limitar o fps), navegação/carregamento atualizam `PageState`
//   e acordam quem espera no `Condvar`.

use std::collections::HashMap;
use std::io::ErrorKind;
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::Child;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tungstenite::{Message, WebSocket};

/// Mensagem do backend para o nó do portal no canvas.
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum PortalEvent {
    /// Quadro JPEG (base64) do screencast, no tamanho do viewport (px CSS).
    Frame { b64: String, width: u32, height: u32 },
    /// A página principal navegou (ou o título mudou).
    Nav { url: String, title: String },
    /// Estado transitório para mostrar no nó ("abrindo navegador…").
    Status { text: String },
    /// Erro que impede o portal de funcionar.
    Error { message: String },
    /// A sessão terminou (navegador fechou/caiu).
    Closed { reason: String },
}

pub type CallResult = Result<Value, String>;

enum Cmd {
    Call {
        method: String,
        params: Value,
        reply: Option<Sender<CallResult>>,
    },
    Shutdown,
}

/// Quem espera a resposta de um id enviado.
enum Pending {
    Caller(Sender<CallResult>),
    /// Resposta interna: `document.title` depois de um load.
    Title,
}

/// Estado da página principal, atualizado pelos eventos.
#[derive(Default)]
pub struct PageState {
    pub url: String,
    pub title: String,
    pub main_frame: String,
    /// Incrementa a cada `Page.loadEventFired`.
    pub load_seq: u64,
    /// O frame principal está carregando (entre frameStartedLoading e Stopped).
    pub loading: bool,
    /// Último diálogo JS (alert/confirm/prompt) aceito automaticamente.
    pub dialog: Option<String>,
}

pub struct Session {
    tx: Mutex<Sender<Cmd>>,
    pub state: Mutex<PageState>,
    cv: Condvar,
    alive: AtomicBool,
    /// (chave do attach, canal) do nó montado no canvas.
    channel: Mutex<Option<(String, Channel<PortalEvent>)>>,
    screencast: AtomicBool,
    /// Até quando o screencast roda em fps alto (logo depois de uma ação).
    active_until: Mutex<Instant>,
    pub viewport: Mutex<(u32, u32)>,
    child: Mutex<Option<Child>>,
    /// Serializa as ações de alto nível (dois agentes não intercalam cliques).
    pub action_lock: Mutex<()>,
    pub profile_dir: PathBuf,
}

const READ_TIMEOUT: Duration = Duration::from_millis(15);
const FAST_FRAME: Duration = Duration::from_millis(90);
const IDLE_FRAME: Duration = Duration::from_millis(600);

impl Session {
    /// Conecta no alvo `target_id` do navegador em 127.0.0.1:`port` e sobe a bomba.
    pub fn connect(
        id: &str,
        port: u16,
        target_id: &str,
        profile_dir: PathBuf,
        viewport: (u32, u32),
    ) -> Result<Arc<Session>, String> {
        let stream = TcpStream::connect(("127.0.0.1", port))
            .map_err(|e| format!("não consegui conectar no DevTools: {e}"))?;
        let _ = stream.set_nodelay(true);
        let url = format!("ws://127.0.0.1:{port}/devtools/page/{target_id}");
        let (ws, _resp) = tungstenite::client(url.as_str(), stream)
            .map_err(|e| format!("handshake do DevTools falhou: {e}"))?;
        ws.get_ref()
            .set_read_timeout(Some(READ_TIMEOUT))
            .map_err(|e| format!("socket do DevTools: {e}"))?;

        let (tx, rx) = mpsc::channel::<Cmd>();
        let session = Arc::new(Session {
            tx: Mutex::new(tx),
            state: Mutex::new(PageState::default()),
            cv: Condvar::new(),
            alive: AtomicBool::new(true),
            channel: Mutex::new(None),
            screencast: AtomicBool::new(false),
            active_until: Mutex::new(Instant::now()),
            viewport: Mutex::new(viewport),
            child: Mutex::new(None),
            action_lock: Mutex::new(()),
            profile_dir,
        });
        let s = Arc::clone(&session);
        std::thread::Builder::new()
            .name(format!("portal-{id}"))
            .spawn(move || pump(ws, rx, s))
            .map_err(|e| format!("não consegui criar a thread do portal: {e}"))?;
        Ok(session)
    }

    /// Guarda o processo do navegador (morto no `shutdown`).
    pub fn set_child(&self, child: Child) {
        *self.child.lock().unwrap() = Some(child);
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    fn enqueue(&self, cmd: Cmd) -> Result<(), String> {
        self.tx
            .lock()
            .unwrap()
            .send(cmd)
            .map_err(|_| "o portal foi fechado.".to_string())
    }

    /// Chamada CDP bloqueante (resposta ou erro do protocolo).
    pub fn call(&self, method: &str, params: Value, timeout: Duration) -> CallResult {
        if !self.is_alive() {
            return Err("o navegador deste portal foi fechado.".into());
        }
        let (rtx, rrx) = mpsc::channel();
        self.enqueue(Cmd::Call {
            method: method.to_string(),
            params,
            reply: Some(rtx),
        })?;
        match rrx.recv_timeout(timeout) {
            Ok(r) => r,
            Err(mpsc::RecvTimeoutError::Timeout) => Err(format!(
                "o navegador não respondeu a {method} em {} s.",
                timeout.as_secs()
            )),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                Err("o navegador deste portal foi fechado.".into())
            }
        }
    }

    /// Chamada CDP sem esperar resposta (entrada do usuário, ajustes).
    pub fn send(&self, method: &str, params: Value) {
        let _ = self.enqueue(Cmd::Call {
            method: method.to_string(),
            params,
            reply: None,
        });
    }

    /// `Runtime.evaluate` devolvendo o valor (JSON) ou o erro do JS.
    pub fn eval(&self, expression: &str, timeout: Duration) -> CallResult {
        let r = self.call(
            "Runtime.evaluate",
            json!({
                "expression": expression,
                "returnByValue": true,
                "awaitPromise": true,
                "userGesture": true,
            }),
            timeout,
        )?;
        if let Some(ex) = r.get("exceptionDetails") {
            let msg = ex
                .get("exception")
                .and_then(|e| e.get("description"))
                .and_then(Value::as_str)
                .or_else(|| ex.get("text").and_then(Value::as_str))
                .unwrap_or("exceção sem descrição");
            return Err(format!("erro no JavaScript da página: {msg}"));
        }
        Ok(r.get("result")
            .and_then(|x| x.get("value"))
            .cloned()
            .unwrap_or(Value::Null))
    }

    pub fn load_seq(&self) -> u64 {
        self.state.lock().unwrap().load_seq
    }

    /// Espera um load depois de `seq`. true = carregou.
    pub fn wait_load_after(&self, seq: u64, timeout: Duration) -> bool {
        let guard = self.state.lock().unwrap();
        let (g, _) = self
            .cv
            .wait_timeout_while(guard, timeout, |st| st.load_seq <= seq && self.is_alive())
            .unwrap();
        g.load_seq > seq
    }

    /// Espera o frame principal parar de carregar. true = parou.
    pub fn wait_not_loading(&self, timeout: Duration) -> bool {
        let guard = self.state.lock().unwrap();
        let (g, _) = self
            .cv
            .wait_timeout_while(guard, timeout, |st| st.loading && self.is_alive())
            .unwrap();
        !g.loading
    }

    pub fn is_loading(&self) -> bool {
        self.state.lock().unwrap().loading
    }

    pub fn url(&self) -> String {
        self.state.lock().unwrap().url.clone()
    }

    pub fn title(&self) -> String {
        self.state.lock().unwrap().title.clone()
    }

    pub fn take_dialog(&self) -> Option<String> {
        self.state.lock().unwrap().dialog.take()
    }

    /// Sobe o fps do screencast por alguns segundos (ação em andamento).
    pub fn mark_active(&self) {
        *self.active_until.lock().unwrap() = Instant::now() + Duration::from_secs(3);
    }

    fn frame_interval(&self) -> Duration {
        if Instant::now() < *self.active_until.lock().unwrap() {
            FAST_FRAME
        } else {
            IDLE_FRAME
        }
    }

    /// Liga o nó do canvas (substitui o anterior).
    pub fn set_channel(&self, key: String, ch: Channel<PortalEvent>) {
        *self.channel.lock().unwrap() = Some((key, ch));
    }

    /// Desliga o nó do canvas se a chave for a atual. true = desligou.
    pub fn clear_channel(&self, key: &str) -> bool {
        let mut c = self.channel.lock().unwrap();
        if c.as_ref().map(|(k, _)| k == key).unwrap_or(false) {
            *c = None;
            true
        } else {
            false
        }
    }

    pub fn emit(&self, ev: PortalEvent) {
        let mut c = self.channel.lock().unwrap();
        let failed = match c.as_ref() {
            Some((_, ch)) => ch.send(ev).is_err(),
            None => false,
        };
        if failed {
            *c = None;
        }
    }

    pub fn emit_nav(&self) {
        let (url, title) = {
            let st = self.state.lock().unwrap();
            (st.url.clone(), st.title.clone())
        };
        self.emit(PortalEvent::Nav { url, title });
    }

    pub fn start_screencast(&self) {
        if self.screencast.swap(true, Ordering::SeqCst) {
            return;
        }
        self.send(
            "Page.startScreencast",
            json!({ "format": "jpeg", "quality": 70, "maxWidth": 4096, "maxHeight": 4096, "everyNthFrame": 1 }),
        );
    }

    pub fn stop_screencast(&self) {
        if self.screencast.swap(false, Ordering::SeqCst) {
            self.send("Page.stopScreencast", json!({}));
        }
    }

    /// Ajusta o viewport (px CSS) ao tamanho do quadro no canvas.
    pub fn resize(&self, width: u32, height: u32) {
        let w = width.clamp(200, 3840);
        let h = height.clamp(150, 2160);
        *self.viewport.lock().unwrap() = (w, h);
        self.send(
            "Emulation.setDeviceMetricsOverride",
            json!({ "width": w, "height": h, "deviceScaleFactor": 1, "mobile": false }),
        );
        self.mark_active();
    }

    /// Um quadro imediato (o screencast só emite quando algo repinta).
    pub fn push_still_frame(&self) {
        if let Ok(r) = self.call(
            "Page.captureScreenshot",
            json!({ "format": "jpeg", "quality": 70 }),
            Duration::from_secs(5),
        ) {
            if let Some(b64) = r.get("data").and_then(Value::as_str) {
                let (w, h) = *self.viewport.lock().unwrap();
                self.emit(PortalEvent::Frame {
                    b64: b64.to_string(),
                    width: w,
                    height: h,
                });
            }
        }
    }

    /// Encerra a bomba e mata o processo do navegador.
    pub fn shutdown(&self) {
        self.alive.store(false, Ordering::SeqCst);
        let _ = self.enqueue(Cmd::Shutdown);
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.cv.notify_all();
    }
}

fn is_timeout(e: &std::io::Error) -> bool {
    matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut)
}

/// Laço da thread dona do WebSocket.
fn pump(mut ws: WebSocket<TcpStream>, rx: Receiver<Cmd>, s: Arc<Session>) {
    let mut next_id: u64 = 0;
    let mut pending: HashMap<u64, Pending> = HashMap::new();
    // (sessionId do quadro, quando mandar o ack)
    let mut ack: Option<(Value, Instant)> = None;

    let reason: String = 'outer: loop {
        // 1) Comandos enfileirados.
        loop {
            match rx.try_recv() {
                Ok(Cmd::Call {
                    method,
                    params,
                    reply,
                }) => {
                    next_id += 1;
                    let msg = json!({ "id": next_id, "method": method, "params": params });
                    if let Err(e) = ws.send(Message::text(msg.to_string())) {
                        if let Some(r) = reply {
                            let _ = r.send(Err(format!("conexão com o navegador caiu: {e}")));
                        }
                        break 'outer format!("conexão com o navegador caiu: {e}");
                    }
                    if let Some(r) = reply {
                        pending.insert(next_id, Pending::Caller(r));
                    }
                }
                Ok(Cmd::Shutdown) => break 'outer "portal fechado".to_string(),
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => break 'outer "portal fechado".to_string(),
            }
        }

        // 2) Ack do screencast vencido → libera o próximo quadro.
        if let Some((sid, due)) = ack.as_ref() {
            if Instant::now() >= *due {
                next_id += 1;
                let msg = json!({ "id": next_id, "method": "Page.screencastFrameAck", "params": { "sessionId": sid } });
                ack = None;
                if let Err(e) = ws.send(Message::text(msg.to_string())) {
                    break 'outer format!("conexão com o navegador caiu: {e}");
                }
            }
        }

        // 3) Lê o que chegou (até alguns por volta, para não atrasar a fila).
        for _ in 0..32 {
            match ws.read() {
                Ok(Message::Text(t)) => {
                    let text = t.to_string();
                    let out = match handle_message(&s, &text, &mut pending, &mut ack) {
                        Ok(out) => out,
                        Err(reason) => break 'outer reason,
                    };
                    for (method, params, p) in out {
                        next_id += 1;
                        let msg = json!({ "id": next_id, "method": method, "params": params });
                        if let Err(e) = ws.send(Message::text(msg.to_string())) {
                            break 'outer format!("conexão com o navegador caiu: {e}");
                        }
                        if let Some(p) = p {
                            pending.insert(next_id, p);
                        }
                    }
                }
                Ok(Message::Close(_)) => break 'outer "o navegador fechou a conexão".to_string(),
                Ok(_) => {}
                Err(tungstenite::Error::Io(e)) if is_timeout(&e) => break,
                Err(e) => break 'outer format!("conexão com o navegador caiu: {e}"),
            }
        }
    };

    s.alive.store(false, Ordering::SeqCst);
    for (_, p) in pending.drain() {
        if let Pending::Caller(tx) = p {
            let _ = tx.send(Err(format!("o portal parou: {reason}")));
        }
    }
    {
        let mut st = s.state.lock().unwrap();
        st.loading = false;
    }
    s.cv.notify_all();
    let _ = ws.close(None);
    s.emit(PortalEvent::Closed { reason });
}

type Outgoing = Vec<(String, Value, Option<Pending>)>;

/// Trata uma mensagem do navegador. Err = encerrar a sessão.
fn handle_message(
    s: &Session,
    text: &str,
    pending: &mut HashMap<u64, Pending>,
    ack: &mut Option<(Value, Instant)>,
) -> Result<Outgoing, String> {
    let mut out: Outgoing = Vec::new();
    let v: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return Ok(out),
    };

    // Resposta a um comando nosso.
    if let Some(id) = v.get("id").and_then(Value::as_u64) {
        match pending.remove(&id) {
            Some(Pending::Caller(tx)) => {
                let r = match v.get("error") {
                    Some(err) => Err(err
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("erro do protocolo")
                        .to_string()),
                    None => Ok(v.get("result").cloned().unwrap_or(Value::Null)),
                };
                let _ = tx.send(r);
            }
            Some(Pending::Title) => {
                if let Some(t) = v
                    .pointer("/result/result/value")
                    .and_then(Value::as_str)
                {
                    s.state.lock().unwrap().title = t.to_string();
                    s.emit_nav();
                }
            }
            None => {}
        }
        return Ok(out);
    }

    let method = v.get("method").and_then(Value::as_str).unwrap_or("");
    let params = v.get("params").cloned().unwrap_or(Value::Null);
    match method {
        "Page.screencastFrame" => {
            if let Some(b64) = params.get("data").and_then(Value::as_str) {
                let w = params
                    .pointer("/metadata/deviceWidth")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0) as u32;
                let h = params
                    .pointer("/metadata/deviceHeight")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0) as u32;
                let (vw, vh) = *s.viewport.lock().unwrap();
                s.emit(PortalEvent::Frame {
                    b64: b64.to_string(),
                    width: if w > 0 { w } else { vw },
                    height: if h > 0 { h } else { vh },
                });
            }
            if let Some(sid) = params.get("sessionId") {
                *ack = Some((sid.clone(), Instant::now() + s.frame_interval()));
            }
        }
        "Page.frameNavigated" => {
            let frame = params.get("frame").cloned().unwrap_or(Value::Null);
            if frame.get("parentId").is_none() {
                {
                    let mut st = s.state.lock().unwrap();
                    st.url = frame
                        .get("url")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    if let Some(fid) = frame.get("id").and_then(Value::as_str) {
                        st.main_frame = fid.to_string();
                    }
                }
                s.emit_nav();
            }
        }
        "Page.navigatedWithinDocument" => {
            let fid = params.get("frameId").and_then(Value::as_str).unwrap_or("");
            let is_main = {
                let st = s.state.lock().unwrap();
                st.main_frame.is_empty() || st.main_frame == fid
            };
            if is_main {
                if let Some(u) = params.get("url").and_then(Value::as_str) {
                    s.state.lock().unwrap().url = u.to_string();
                    s.emit_nav();
                }
            }
        }
        "Page.frameStartedLoading" | "Page.frameStoppedLoading" => {
            let fid = params.get("frameId").and_then(Value::as_str).unwrap_or("");
            let mut st = s.state.lock().unwrap();
            if st.main_frame.is_empty() || st.main_frame == fid {
                st.loading = method == "Page.frameStartedLoading";
                drop(st);
                s.cv.notify_all();
            }
        }
        "Page.loadEventFired" => {
            {
                let mut st = s.state.lock().unwrap();
                st.load_seq += 1;
            }
            s.cv.notify_all();
            out.push((
                "Runtime.evaluate".into(),
                json!({ "expression": "document.title", "returnByValue": true }),
                Some(Pending::Title),
            ));
        }
        "Page.javascriptDialogOpening" => {
            // Um diálogo aberto trava a página (e qualquer Runtime.evaluate):
            // aceita sozinho e conta ao agente no próximo snapshot.
            let kind = params.get("type").and_then(Value::as_str).unwrap_or("alert");
            let msg = params.get("message").and_then(Value::as_str).unwrap_or("");
            s.state.lock().unwrap().dialog = Some(format!("{kind}: \"{msg}\""));
            out.push((
                "Page.handleJavaScriptDialog".into(),
                json!({ "accept": true }),
                None,
            ));
        }
        "Inspector.detached" => return Err("o DevTools foi desconectado".into()),
        "Inspector.targetCrashed" => return Err("a aba do portal travou (crash)".into()),
        _ => {}
    }
    Ok(out)
}
