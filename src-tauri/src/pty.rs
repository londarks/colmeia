// Gerenciador de PTY (pseudo-terminais) — o núcleo do orquestrador.
// Cada agente/terminal do canvas vira uma sessão de PTY aqui no backend Rust.
// Guarda também o grafo (nós + arestas) e um buffer rolante por sessão, usados
// pelo servidor loopback (orchestrator.rs) para a comunicação entre agentes.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize};
use rand::distributions::Alphanumeric;
use rand::Rng;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::State;

const BUFFER_CAP: usize = 16_000;

/// Mensagem enviada do backend para o frontend por sessão de PTY.
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum PtyOutput {
    /// Pedaço de saída do terminal, em base64 (bytes crus, evita quebrar UTF-8).
    Data { b64: String },
    /// O processo terminou.
    Exit { code: Option<i32> },
}

/// Info de um nó do canvas, espelhada do frontend via `set_graph`.
#[derive(Clone, Deserialize)]
pub struct NodeInfo {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub title: String,
}

/// Info de uma aresta (conexão) do canvas.
#[derive(Clone, Deserialize)]
pub struct EdgeInfo {
    pub source: String,
    pub target: String,
}

/// Uma rotina agendada: roda um comando num terminal a cada N segundos.
struct RoutineHandle {
    stop: Arc<AtomicBool>,
    target_title: String,
    interval: u64,
    command: String,
}

/// Info de rotina exposta ao frontend / CLI.
#[derive(Clone, Serialize)]
pub struct RoutineInfo {
    pub id: String,
    pub target: String,
    pub interval: u64,
    pub command: String,
}

/// Uma sessão de PTY viva.
struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    /// Últimos ~16k bytes de saída, para o `colmeia check` ler.
    buffer: Arc<Mutex<Vec<u8>>>,
}

/// Estado compartilhado entre os comandos Tauri e o servidor loopback.
pub struct Shared {
    sessions: Mutex<HashMap<String, PtySession>>,
    nodes: Mutex<Vec<NodeInfo>>,
    edges: Mutex<Vec<EdgeInfo>>,
    routines: Mutex<HashMap<String, RoutineHandle>>,
    /// Token exigido em toda chamada ao servidor loopback.
    pub token: String,
    /// Porta do servidor loopback (definida no start).
    pub port: Mutex<u16>,
}

impl Shared {
    fn new() -> Self {
        let token: String = rand::thread_rng()
            .sample_iter(&Alphanumeric)
            .take(32)
            .map(char::from)
            .collect();
        Shared {
            sessions: Mutex::new(HashMap::new()),
            nodes: Mutex::new(Vec::new()),
            edges: Mutex::new(Vec::new()),
            routines: Mutex::new(HashMap::new()),
            token,
            port: Mutex::new(0),
        }
    }

    /// Ids conectados a `source` por qualquer aresta.
    fn connected_ids(&self, source: &str) -> Vec<String> {
        self.edges
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| {
                if e.source == source {
                    Some(e.target.clone())
                } else if e.target == source {
                    Some(e.source.clone())
                } else {
                    None
                }
            })
            .collect()
    }

    /// Terminais conectados a `source` (id, título). Se `source` vazio, todos.
    pub fn connected_terminals(&self, source: &str) -> Vec<(String, String)> {
        let nodes = self.nodes.lock().unwrap();
        let scoped: Option<Vec<String>> = if source.is_empty() {
            None
        } else {
            Some(self.connected_ids(source))
        };
        nodes
            .iter()
            .filter(|n| n.kind == "terminal")
            .filter(|n| scoped.as_ref().map_or(true, |ids| ids.contains(&n.id)))
            .map(|n| (n.id.clone(), n.title.clone()))
            .collect()
    }

    /// Resolve um nó terminal pelo título (case-insensitive).
    pub fn find_terminal_by_title(&self, title: &str) -> Option<String> {
        self.nodes
            .lock()
            .unwrap()
            .iter()
            .find(|n| n.kind == "terminal" && n.title.eq_ignore_ascii_case(title))
            .map(|n| n.id.clone())
    }

    /// Resolve um terminal por id OU título; devolve (id, título).
    pub fn resolve_terminal(&self, target: &str) -> Option<(String, String)> {
        self.nodes
            .lock()
            .unwrap()
            .iter()
            .find(|n| {
                n.kind == "terminal"
                    && (n.id == target || n.title.eq_ignore_ascii_case(target))
            })
            .map(|n| (n.id.clone(), n.title.clone()))
    }

    /// Snapshot do buffer de saída de uma sessão, como texto.
    pub fn buffer_text(&self, id: &str) -> Option<String> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions.get(id)?;
        let bytes = session.buffer.lock().unwrap();
        Some(String::from_utf8_lossy(&bytes).to_string())
    }

    /// Escreve dados na entrada de uma sessão (usado pelo `colmeia ask`).
    pub fn write_to(&self, id: &str, data: &str) -> bool {
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(session) = sessions.get_mut(id) {
            let _ = session.writer.write_all(data.as_bytes());
            let _ = session.writer.flush();
            true
        } else {
            false
        }
    }

    /// Cria uma rotina: roda `command` no terminal `target_id` a cada `interval` segundos.
    /// `self` é `&Arc<Self>` para poder clonar o Arc dentro da thread do timer.
    pub fn create_routine(
        self: &Arc<Self>,
        target_id: String,
        target_title: String,
        interval: u64,
        command: String,
    ) -> String {
        let id: String = format!(
            "routine-{}",
            rand::thread_rng()
                .sample_iter(&Alphanumeric)
                .take(5)
                .map(char::from)
                .collect::<String>()
        );
        let stop = Arc::new(AtomicBool::new(false));

        let shared = Arc::clone(self);
        let stop_thread = stop.clone();
        let tid = target_id.clone();
        let cmd = command.clone();
        let secs = interval.max(1);
        std::thread::spawn(move || loop {
            // Espera em passos de 1s para poder parar rápido.
            for _ in 0..secs {
                if stop_thread.load(Ordering::Relaxed) {
                    return;
                }
                std::thread::sleep(Duration::from_secs(1));
            }
            if stop_thread.load(Ordering::Relaxed) {
                return;
            }
            shared.write_to(&tid, &(cmd.clone() + "\r"));
        });

        let _ = target_id;
        self.routines.lock().unwrap().insert(
            id.clone(),
            RoutineHandle {
                stop,
                target_title,
                interval,
                command,
            },
        );
        id
    }

    pub fn list_routines(&self) -> Vec<RoutineInfo> {
        self.routines
            .lock()
            .unwrap()
            .iter()
            .map(|(id, r)| RoutineInfo {
                id: id.clone(),
                target: r.target_title.clone(),
                interval: r.interval,
                command: r.command.clone(),
            })
            .collect()
    }

    pub fn delete_routine(&self, id: &str) -> bool {
        if let Some(h) = self.routines.lock().unwrap().remove(id) {
            h.stop.store(true, Ordering::Relaxed);
            true
        } else {
            false
        }
    }
}

/// Estado gerenciado pelo Tauri. Um `Arc` para compartilhar com o servidor.
pub struct PtyState(pub Arc<Shared>);

impl PtyState {
    pub fn new() -> Self {
        PtyState(Arc::new(Shared::new()))
    }
    pub fn shared(&self) -> Arc<Shared> {
        self.0.clone()
    }
}

/// Diretório onde geramos os scripts da CLI `colmeia`.
fn cli_bin_dir() -> PathBuf {
    std::env::temp_dir().join("colmeia").join("bin")
}

/// Gera os scripts da CLI `colmeia` no bin (idempotente).
fn ensure_cli_scripts() -> std::io::Result<PathBuf> {
    let bin = cli_bin_dir();
    std::fs::create_dir_all(&bin)?;

    let js = bin.join("colmeia.js");
    std::fs::write(&js, include_str!("cli/colmeia.js"))?;

    // Windows: colmeia.cmd chama node.
    let cmd = format!("@echo off\r\nnode \"{}\" %*\r\n", js.display());
    std::fs::write(bin.join("colmeia.cmd"), cmd)?;

    // Unix: shell script.
    let sh = format!("#!/bin/sh\nnode \"{}\" \"$@\"\n", js.display().to_string().replace('\\', "/"));
    let sh_path = bin.join("colmeia");
    std::fs::write(&sh_path, sh)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&sh_path, std::fs::Permissions::from_mode(0o755));
    }

    Ok(bin)
}

/// Cria uma nova sessão de PTY e começa a transmitir a saída pelo `channel`.
#[tauri::command]
pub fn pty_spawn(
    state: State<'_, PtyState>,
    id: String,
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    channel: Channel<PtyOutput>,
) -> Result<(), String> {
    let shared = state.0.clone();
    let pty_system = portable_pty::native_pty_system();

    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty falhou: {e}"))?;

    // Monta o comando com o ambiente do processo atual (garante PATH, etc.).
    // Injeta a CLI `colmeia` no PATH usando a MESMA chave original (no Windows é
    // "Path", case-insensitive) para não criar chave duplicada que o SO ignora.
    let bin_dir = ensure_cli_scripts().ok();
    let sep = if cfg!(windows) { ";" } else { ":" };
    let mut cmd = CommandBuilder::new(&command);
    cmd.args(&args);
    for (k, v) in std::env::vars() {
        if k.eq_ignore_ascii_case("path") {
            if let Some(ref bin) = bin_dir {
                cmd.env(&k, format!("{}{}{}", bin.display(), sep, v));
                continue;
            }
        }
        cmd.env(k, v);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLMEIA_NODE_ID", &id);
    cmd.env("COLMEIA_TOKEN", &shared.token);
    cmd.env("COLMEIA_PORT", shared.port.lock().unwrap().to_string());

    if let Some(dir) = cwd {
        if !dir.is_empty() {
            cmd.cwd(dir);
        }
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn falhou: {e}"))?;
    drop(pair.slave);

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take_writer falhou: {e}"))?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone_reader falhou: {e}"))?;

    let buffer = Arc::new(Mutex::new(Vec::<u8>::new()));
    let buffer_thread = buffer.clone();

    // Thread que lê a saída do PTY: envia pelo canal e mantém o buffer rolante.
    let out_channel = channel.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    {
                        let mut b = buffer_thread.lock().unwrap();
                        b.extend_from_slice(&buf[..n]);
                        if b.len() > BUFFER_CAP {
                            let excess = b.len() - BUFFER_CAP;
                            b.drain(0..excess);
                        }
                    }
                    let b64 = B64.encode(&buf[..n]);
                    if out_channel.send(PtyOutput::Data { b64 }).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = out_channel.send(PtyOutput::Exit { code: None });
    });

    shared.sessions.lock().unwrap().insert(
        id,
        PtySession {
            writer,
            master: pair.master,
            child,
            buffer,
        },
    );

    Ok(())
}

/// Escreve dados (teclado do usuário) na entrada do PTY.
#[tauri::command]
pub fn pty_write(state: State<'_, PtyState>, id: String, data: String) -> Result<(), String> {
    if state.0.write_to(&id, &data) {
        Ok(())
    } else {
        Err(format!("sessão '{id}' não encontrada"))
    }
}

/// Redimensiona o PTY (quando o nó do canvas muda de tamanho).
#[tauri::command]
pub fn pty_resize(
    state: State<'_, PtyState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state.0.sessions.lock().unwrap();
    let session = sessions
        .get(&id)
        .ok_or_else(|| format!("sessão '{id}' não encontrada"))?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("resize falhou: {e}"))?;
    Ok(())
}

/// Mata a sessão e libera os recursos.
#[tauri::command]
pub fn pty_kill(state: State<'_, PtyState>, id: String) -> Result<(), String> {
    if let Some(mut session) = state.0.sessions.lock().unwrap().remove(&id) {
        let _ = session.child.kill();
    }
    Ok(())
}

/// Atualiza o grafo (nós + arestas) que o servidor loopback usa para escopo.
#[tauri::command]
pub fn set_graph(state: State<'_, PtyState>, nodes: Vec<NodeInfo>, edges: Vec<EdgeInfo>) {
    *state.0.nodes.lock().unwrap() = nodes;
    *state.0.edges.lock().unwrap() = edges;
}

/// Lista as rotinas ativas.
#[tauri::command]
pub fn routines_list(state: State<'_, PtyState>) -> Vec<RoutineInfo> {
    state.0.list_routines()
}

/// Cria uma rotina e devolve a lista atualizada.
#[tauri::command]
pub fn routine_create(
    state: State<'_, PtyState>,
    target: String,
    interval: u64,
    command: String,
) -> Result<Vec<RoutineInfo>, String> {
    let shared = state.0.clone();
    let (id, title) = shared
        .resolve_terminal(&target)
        .ok_or_else(|| format!("Terminal '{target}' não encontrado."))?;
    shared.create_routine(id, title, interval, command);
    Ok(shared.list_routines())
}

/// Remove uma rotina e devolve a lista atualizada.
#[tauri::command]
pub fn routine_delete(state: State<'_, PtyState>, id: String) -> Vec<RoutineInfo> {
    state.0.delete_routine(&id);
    state.0.list_routines()
}
