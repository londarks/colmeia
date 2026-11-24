// Gerenciador de PTY (pseudo-terminais) — o núcleo do orquestrador.
// Cada agente/terminal do canvas vira uma sessão de PTY aqui no backend Rust.
// Guarda também o grafo (nós + arestas), um modelo de tela headless por sessão
// (screen.rs), a identidade de cada terminal (token por nó) e o estado de
// atividade, usados pelo servidor loopback (orchestrator.rs).
//
// Outras partes do `impl Shared` ficam em módulos irmãos:
// - delivery.rs  → entrega robusta de prompt (fila, bracketed paste, Enter confirmado)
// - activity.rs  → estado working/idle/attention (hooks + heurística de tela)
// - asks.rs      → `ask` bloqueante, ask-back e quebra de deadlock

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize};
use rand::distributions::Alphanumeric;
use rand::Rng;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, State};

use crate::activity::Activity;
use crate::asks::PendingAsk;
use crate::roles::RoleDef;
use crate::scope::{self, ScopeError};
use crate::screen::ScreenModel;

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
#[derive(Clone, Deserialize, Default, Debug)]
pub struct NodeInfo {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub title: String,
    /// Rótulo do papel (ex.: "Engenheiro"), para exibir.
    #[serde(default)]
    pub role: String,
    /// Id do papel (ex.: "engineer"), para lógica.
    #[serde(default, rename = "roleId")]
    pub role_id: String,
    /// Tipo de agente do terminal (claude/codex/ollama/shell).
    #[serde(default)]
    pub agent: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub cwd: String,
    #[serde(default, rename = "autoApproveInCwd")]
    pub auto_approve_in_cwd: bool,
    /// Modo Maestro ligado no nó (pode recrutar/dispensar/conectar fora do alcance).
    #[serde(default)]
    pub maestro: bool,
    /// Nota travada: agentes podem ler, mas não escrever.
    #[serde(default)]
    pub locked: bool,
    /// Id do grupo pai no canvas (`parentId` do React Flow), vazio se for de topo.
    #[serde(default)]
    pub parent: String,
    /// Grupo marcado como band (todos-com-todos; ver scope.rs).
    #[serde(default)]
    pub band: bool,
}

/// Info de uma aresta (conexão) do canvas.
#[derive(Clone, Deserialize, Default, Debug)]
pub struct EdgeInfo {
    pub source: String,
    pub target: String,
}

/// Um tipo de agente do catálogo (`AGENTS` em src/lib/agents.ts), espelhado
/// pelo frontend para o `colmeia preset list` / `recruit --agent`.
#[derive(Clone, Deserialize, Serialize, Debug)]
pub struct PresetInfo {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub command: String,
}

/// Estado de E/S de uma sessão, compartilhado com a thread leitora, o ticker
/// de atividade e as entregas. Fica num `Arc` para ser usado sem segurar o
/// lock do mapa de sessões.
pub struct SessionIo {
    pub screen: Mutex<ScreenModel>,
    pub last_output: Mutex<Instant>,
    pub bytes_total: AtomicU64,
    /// Última vez que o HUMANO digitou neste terminal (via xterm do canvas).
    pub last_human_input: Mutex<Option<Instant>>,
    /// Fila de entregas: um prompt por vez por terminal.
    pub deliver_lock: Mutex<()>,
    pub started: Instant,
    /// Muda a cada spawn — detecta "reiniciou durante o ask".
    pub generation: u64,
    pub exited: AtomicBool,
}

/// Uma sessão de PTY viva.
struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    io: Arc<SessionIo>,
    /// Job Object (Windows) com a árvore do agente; dropar mata os filhos também.
    tree: Option<crate::proctree::ProcessTree>,
}

/// Estado compartilhado entre os comandos Tauri e o servidor loopback.
pub struct Shared {
    sessions: Mutex<HashMap<String, PtySession>>,
    pub(crate) nodes: Mutex<Vec<NodeInfo>>,
    pub(crate) edges: Mutex<Vec<EdgeInfo>>,
    /// Aprovações pendentes: id -> (nó que pediu, canal para entregar a decisão).
    /// O nó é guardado para o `wait`/`ask` saberem que um agente está BLOQUEADO
    /// esperando aprovação (silêncio ≠ terminou).
    pending_approvals: Mutex<HashMap<String, (String, Sender<bool>)>>,
    /// Regras de auto-aprovação da sessão: chave "node\u{1f}tool" -> permitir sem perguntar.
    auto_allow: Mutex<HashSet<String>>,
    /// Identidade: token -> id do nó. Um token por terminal, gerado no spawn e
    /// invalidado no kill. O servidor deriva o chamador SÓ daqui (F7).
    tokens: Mutex<HashMap<String, String>>,
    /// Estado de atividade por nó (activity.rs).
    pub(crate) activity: Mutex<HashMap<String, Activity>>,
    /// Asks bloqueantes em voo (asks.rs).
    pub(crate) asks: Mutex<Vec<PendingAsk>>,
    pub(crate) ask_seq: AtomicU64,
    generation: AtomicU64,
    /// Catálogo de agentes enviado pelo frontend.
    pub(crate) presets: Mutex<Vec<PresetInfo>>,
    /// Handle do app, para emitir eventos ao frontend (definido no setup).
    app: OnceLock<AppHandle>,
    /// `app_data_dir` (papéis persistidos etc.), definido no setup.
    pub(crate) data_dir: OnceLock<PathBuf>,
    /// Porta do servidor loopback (definida no start).
    pub port: Mutex<u16>,
}

fn random_token(len: usize) -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(len)
        .map(char::from)
        .collect()
}

impl Shared {
    fn new() -> Self {
        Shared {
            sessions: Mutex::new(HashMap::new()),
            nodes: Mutex::new(Vec::new()),
            edges: Mutex::new(Vec::new()),
            pending_approvals: Mutex::new(HashMap::new()),
            auto_allow: Mutex::new(HashSet::new()),
            tokens: Mutex::new(HashMap::new()),
            activity: Mutex::new(HashMap::new()),
            asks: Mutex::new(Vec::new()),
            ask_seq: AtomicU64::new(0),
            generation: AtomicU64::new(0),
            presets: Mutex::new(Vec::new()),
            app: OnceLock::new(),
            data_dir: OnceLock::new(),
            port: Mutex::new(0),
        }
    }

    pub fn set_app(&self, app: AppHandle) {
        let _ = self.app.set(app);
    }

    pub fn set_data_dir(&self, dir: PathBuf) {
        let _ = self.data_dir.set(dir);
    }

    /// Emite um evento Tauri ao frontend (no-op antes do setup / em testes).
    pub fn emit<S: Serialize + Clone>(&self, event: &str, payload: S) {
        if let Some(app) = self.app.get() {
            let _ = app.emit(event, payload);
        }
    }

    // ── Identidade ──────────────────────────────────────────────────────

    /// Nó dono do token (None = token inválido ou terminal encerrado).
    pub fn node_for_token(&self, token: &str) -> Option<String> {
        if token.is_empty() {
            return None;
        }
        self.tokens.lock().unwrap().get(token).cloned()
    }

    fn issue_token(&self, node_id: &str) -> String {
        let token = random_token(40);
        let mut tokens = self.tokens.lock().unwrap();
        tokens.retain(|_, n| n != node_id);
        tokens.insert(token.clone(), node_id.to_string());
        token
    }

    fn revoke_tokens(&self, node_id: &str) {
        self.tokens.lock().unwrap().retain(|_, n| n != node_id);
    }

    // ── Aprovações ──────────────────────────────────────────────────────

    fn auto_key(node: &str, tool: &str) -> String {
        format!("{node}\u{1f}{tool}")
    }
    /// Já existe regra de auto-aprovação para (node, tool)?
    pub fn is_auto_allowed(&self, node: &str, tool: &str) -> bool {
        self.auto_allow
            .lock()
            .unwrap()
            .contains(&Self::auto_key(node, tool))
    }
    /// Adiciona uma regra de auto-aprovação para a sessão.
    pub fn add_auto_allow(&self, node: &str, tool: &str) {
        self.auto_allow
            .lock()
            .unwrap()
            .insert(Self::auto_key(node, tool));
    }

    /// Registra uma aprovação pendente (o `/approve` bloqueia até a decisão).
    pub fn add_pending(&self, id: String, node: String, tx: Sender<bool>) {
        self.pending_approvals
            .lock()
            .unwrap()
            .insert(id, (node, tx));
    }

    /// Retira o canal de uma aprovação (idempotente).
    pub fn take_pending(&self, id: &str) -> Option<Sender<bool>> {
        self.pending_approvals
            .lock()
            .unwrap()
            .remove(id)
            .map(|(_, tx)| tx)
    }

    /// Há alguma aprovação pendente para este nó? (agente bloqueado, não ocioso).
    pub fn has_pending_approval(&self, node: &str) -> bool {
        self.pending_approvals
            .lock()
            .unwrap()
            .values()
            .any(|(n, _)| n == node)
    }

    /// Auto-aprova escritas (Write/Edit/...) dentro da pasta do agente, se ligado no nó.
    pub fn should_auto_approve_write(&self, node_id: &str, tool: &str, path: &str) -> bool {
        const WRITE_TOOLS: [&str; 4] = ["Write", "Edit", "MultiEdit", "NotebookEdit"];
        if !WRITE_TOOLS.contains(&tool) || path.is_empty() {
            return false;
        }
        let norm = |s: &str| s.replace('\\', "/").to_lowercase();
        self.nodes
            .lock()
            .unwrap()
            .iter()
            .find(|n| n.id == node_id)
            .map(|n| {
                n.auto_approve_in_cwd && !n.cwd.is_empty() && norm(path).starts_with(&norm(&n.cwd))
            })
            .unwrap_or(false)
    }

    // ── Grafo e escopo ──────────────────────────────────────────────────

    /// Cópia de um nó do grafo.
    pub fn node(&self, id: &str) -> Option<NodeInfo> {
        self.nodes
            .lock()
            .unwrap()
            .iter()
            .find(|n| n.id == id)
            .cloned()
    }

    /// Título de um nó pelo id (cai no próprio id se não achar).
    pub fn title_of(&self, id: &str) -> String {
        self.node(id)
            .map(|n| n.title)
            .unwrap_or_else(|| id.to_string())
    }

    pub fn graph_snapshot(&self) -> (Vec<NodeInfo>, Vec<EdgeInfo>) {
        let nodes = self.nodes.lock().unwrap().clone();
        let edges = self.edges.lock().unwrap().clone();
        (nodes, edges)
    }

    /// Resolve um nome dentro do alcance de `source` (ver scope.rs).
    pub fn resolve_scoped(
        &self,
        source: &str,
        name: &str,
        kinds: &[&str],
        team: bool,
    ) -> Result<String, ScopeError> {
        let (nodes, edges) = self.graph_snapshot();
        scope::resolve(&nodes, &edges, source, name, kinds, team)
    }

    /// Ids ao alcance de `source` (vizinhos + cadeia de notas).
    pub fn reach_of(&self, source: &str) -> HashSet<String> {
        let (nodes, edges) = self.graph_snapshot();
        scope::reach(&nodes, &edges, source)
    }

    /// Este nó tem privilégio de orquestrador? Regra (F15): o modo Maestro
    /// ligado no nó OU o papel "orquestrador" atribuído a ele.
    pub fn is_maestro(&self, id: &str) -> bool {
        self.node(id)
            .map(|n| n.maestro || n.role_id == "orquestrador")
            .unwrap_or(false)
    }

    /// Notas ao alcance de `source` (título, conteúdo), inclusive a cadeia.
    pub fn connected_notes(&self, source: &str) -> Vec<(String, String)> {
        let (nodes, edges) = self.graph_snapshot();
        scope::note_depths(&nodes, &edges, source)
            .into_iter()
            .filter_map(|(id, _)| nodes.iter().find(|n| n.id == id))
            .map(|n| (n.title.clone(), n.content.clone()))
            .collect()
    }

    /// Atualiza o conteúdo de uma nota no espelho local (o frontend confirma
    /// depois via `set_graph`), para que um `note read` logo em seguida já veja.
    pub fn apply_note_content(&self, id: &str, content: &str) {
        if let Some(n) = self.nodes.lock().unwrap().iter_mut().find(|n| n.id == id) {
            n.content = content.to_string();
        }
    }

    /// Resolve um terminal por id OU título (global — usado só pelo painel de
    /// rotinas do próprio usuário, nunca pelos agentes).
    pub fn resolve_terminal(&self, target: &str) -> Option<(String, String)> {
        self.nodes
            .lock()
            .unwrap()
            .iter()
            .find(|n| {
                n.kind == "terminal" && (n.id == target || scope::same_name(&n.title, target))
            })
            .map(|n| (n.id.clone(), n.title.clone()))
    }

    // ── Sessões ─────────────────────────────────────────────────────────

    pub fn session_io(&self, id: &str) -> Option<Arc<SessionIo>> {
        self.sessions.lock().unwrap().get(id).map(|s| s.io.clone())
    }

    pub(crate) fn session_list(&self) -> Vec<(String, Arc<SessionIo>)> {
        self.sessions
            .lock()
            .unwrap()
            .iter()
            .map(|(k, s)| (k.clone(), s.io.clone()))
            .collect()
    }

    /// Texto limpo (scrollback + tela) de uma sessão, últimos `max` bytes.
    pub fn screen_text(&self, id: &str, max: usize) -> Option<String> {
        let io = self.session_io(id)?;
        let mut screen = io.screen.lock().unwrap();
        Some(screen.screen_text(max))
    }

    /// Só a tela visível de uma sessão.
    pub fn visible_text(&self, id: &str) -> Option<String> {
        let io = self.session_io(id)?;
        let screen = io.screen.lock().unwrap();
        Some(screen.visible_text())
    }

    /// Junta a saída recente de todos os terminais (texto renderizado), para o Ombro.
    pub fn agents_context(&self, max_per: usize) -> String {
        let nodes = self.nodes.lock().unwrap().clone();
        let mut parts = Vec::new();
        for n in nodes.iter().filter(|n| n.kind == "terminal") {
            if let Some(text) = self.screen_text(&n.id, max_per) {
                let role = if n.role.is_empty() {
                    String::new()
                } else {
                    format!(" [{}]", n.role)
                };
                parts.push(format!("## {}{}\n{}", n.title, role, text.trim()));
            }
        }
        parts.join("\n\n")
    }

    /// Escreve bytes crus na entrada de uma sessão.
    pub fn write_bytes(&self, id: &str, data: &[u8]) -> bool {
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(session) = sessions.get_mut(id) {
            let _ = session.writer.write_all(data);
            let _ = session.writer.flush();
            true
        } else {
            false
        }
    }

    /// Escreve texto na entrada de uma sessão.
    pub fn write_to(&self, id: &str, data: &str) -> bool {
        self.write_bytes(id, data.as_bytes())
    }

    /// Entrega `data` como prompt (pela fila robusta de delivery.rs) numa
    /// thread à parte. Mantido para rotinas e o `pty_submit` do frontend.
    pub fn submit_line(self: &Arc<Self>, id: String, data: String) -> bool {
        if self.session_io(&id).is_none() {
            return false;
        }
        let shared = Arc::clone(self);
        std::thread::spawn(move || {
            if let Err(e) = shared.deliver(&id, &data) {
                eprintln!("[pty] entrega para {id} falhou: {e}");
            }
        });
        true
    }

    /// Pasta (cwd) de um nó, como o frontend espelhou no `set_graph`.
    /// Usado pelo `floors::cli_floor` para saber em que repositório/floor o agente está.
    pub fn node_cwd(&self, id: &str) -> Option<String> {
        self.nodes
            .lock()
            .unwrap()
            .iter()
            .find(|n| n.id == id)
            .map(|n| n.cwd.clone())
            .filter(|c| !c.is_empty())
    }

    /// Handle do app (para módulos que emitem eventos por conta própria).
    pub fn app_handle(&self) -> Option<AppHandle> {
        self.app.get().cloned()
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

// ── CLI e hooks gerados em runtime ─────────────────────────────────────

/// Diretório onde geramos os scripts da CLI `colmeia`.
pub fn cli_bin_dir() -> PathBuf {
    std::env::temp_dir().join("colmeia").join("bin")
}

/// Serializa a geração dos arquivos (vários spawns ao mesmo tempo no boot).
static CLI_LOCK: Mutex<()> = Mutex::new(());

/// Escreve só se o conteúdo mudou (evita "arquivo em uso" no Windows quando um
/// terminal está executando o script naquele instante).
pub fn write_if_changed(path: &Path, content: &str) -> std::io::Result<()> {
    if let Ok(current) = std::fs::read_to_string(path) {
        if current == content {
            return Ok(());
        }
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, content)
}

/// Gera os scripts da CLI `colmeia`, os hooks do Claude Code e o plugin de
/// skills no bin (idempotente).
fn ensure_cli_scripts() -> std::io::Result<PathBuf> {
    let _guard = CLI_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let bin = cli_bin_dir();
    std::fs::create_dir_all(&bin)?;

    let js = bin.join("colmeia.js");
    write_if_changed(&js, include_str!("cli/colmeia.js"))?;

    // Windows: colmeia.cmd chama node.
    let cmd = format!("@echo off\r\nnode \"{}\" %*\r\n", js.display());
    write_if_changed(&bin.join("colmeia.cmd"), &cmd)?;

    // Unix: shell script.
    let sh = format!(
        "#!/bin/sh\nexec node \"{}\" \"$@\"\n",
        js.display().to_string().replace('\\', "/")
    );
    let sh_path = bin.join("colmeia");
    write_if_changed(&sh_path, &sh)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&sh_path, std::fs::Permissions::from_mode(0o755));
    }

    // Hook PreToolUse do Claude Code: pausa o agente e pede aprovação ao painel.
    let approve = bin.join("colmeia-approve.js");
    write_if_changed(&approve, include_str!("cli/colmeia-approve.js"))?;
    // Hooks de estado (F4): UserPromptSubmit → working, Stop → idle,
    // Notification → attention. Nunca bloqueiam o agente.
    let event = bin.join("colmeia-event.js");
    write_if_changed(&event, include_str!("cli/colmeia-event.js"))?;

    let approve_cmd = format!("node \"{}\"", approve.display());
    let event_cmd = |name: &str| format!("node \"{}\" {name}", event.display());
    let state_hook = |name: &str| {
        serde_json::json!([{
            "hooks": [{ "type": "command", "command": event_cmd(name), "timeout": 10 }]
        }])
    };
    let hooks = serde_json::json!({
        "hooks": {
            "PreToolUse": [{
                "matcher": "Bash|Write|Edit|MultiEdit|NotebookEdit",
                "hooks": [{ "type": "command", "command": approve_cmd, "timeout": 600 }]
            }],
            "UserPromptSubmit": state_hook("UserPromptSubmit"),
            "Stop": state_hook("Stop"),
            "Notification": state_hook("Notification")
        }
    });
    write_if_changed(
        &bin.join("colmeia-hooks.json"),
        &serde_json::to_string_pretty(&hooks).unwrap_or_default(),
    )?;

    // Plugin de skills do Claude Code (F14), isolado no bin — nunca em ~/.claude.
    crate::skills::ensure_plugin(&bin)?;

    Ok(bin)
}

/// Caminho do arquivo de settings (hooks) do Claude, dentro do bin.
fn claude_settings_path() -> PathBuf {
    cli_bin_dir().join("colmeia-hooks.json")
}

/// Nome do programa sem diretório/extensão ("C:\x\claude.cmd" → "claude").
fn program_name(command: &str) -> String {
    let base = command.rsplit(['/', '\\']).next().unwrap_or(command);
    let lower = base.to_lowercase();
    for ext in [".exe", ".cmd", ".bat", ".ps1"] {
        if let Some(stripped) = lower.strip_suffix(ext) {
            return stripped.to_string();
        }
    }
    lower
}

/// Cria uma nova sessão de PTY e começa a transmitir a saída pelo `channel`.
///
/// `role` (id do papel) entra UMA vez, no boot: no Claude via
/// `--append-system-prompt`; nos demais agentes via diretório de papel com
/// `AGENTS.md`/`CLAUDE.md` usado como cwd (ver skills.rs). Nunca é reinjetado
/// a cada `ask`.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn pty_spawn(
    state: State<'_, PtyState>,
    id: String,
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    role: Option<String>,
    agent: Option<String>,
    session_key: Option<String>,
    channel: Channel<PtyOutput>,
) -> Result<(), String> {
    let shared = state.0.clone();
    let pty_system = portable_pty::native_pty_system();

    // Respawn com o mesmo id: encerra a sessão anterior antes.
    if let Some(mut old) = shared.sessions.lock().unwrap().remove(&id) {
        let _ = old.child.kill();
    }

    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty falhou: {e}"))?;

    let bin_dir = ensure_cli_scripts()
        .map_err(|e| eprintln!("[pty] falha ao gerar a CLI colmeia: {e}"))
        .ok();
    let program = program_name(&command);
    let agent_kind = agent
        .filter(|a| !a.is_empty())
        .unwrap_or_else(|| program.clone());
    let role_def: Option<RoleDef> = role
        .as_deref()
        .filter(|r| !r.is_empty())
        .and_then(|r| crate::roles::find(&shared, r));
    let mut cwd_eff: Option<String> = cwd.filter(|d| !d.is_empty());
    // Variáveis do floor (porta base, COMPOSE_PROJECT_NAME…) quando a pasta é um floor.
    let floor_env = cwd_eff
        .as_deref()
        .map(crate::floors::floor_env_for_cwd)
        .unwrap_or_default();
    // Papel para o Ollama: não lê arquivos de contexto, então vai como 1º prompt.
    let mut deliver_role_after_boot: Option<String> = None;

    // Monta o comando com o ambiente do processo atual (garante PATH, etc.).
    // Injeta a CLI `colmeia` no PATH usando a MESMA chave original (no Windows é
    // "Path", case-insensitive) para não criar chave duplicada que o SO ignora.
    let sep = if cfg!(windows) { ";" } else { ":" };
    let mut cmd = CommandBuilder::new(&command);
    cmd.args(&args);
    if program == "claude" {
        // Retomar a conversa: cada nó tem uma sessão fixa (derivada de canvas+nó+
        // pasta+restartKey). Se ela já existe em disco, `--resume`; senão nasce
        // com esse id. Não interfere se o usuário já passou flags de sessão.
        let has_session_flag = args.iter().any(|a| {
            matches!(
                a.as_str(),
                "--resume" | "-r" | "--continue" | "-c" | "--session-id" | "-p" | "--print"
            )
        });
        if let Some(key) = session_key.as_deref().filter(|k| !k.is_empty()) {
            if !has_session_flag {
                let sid = session_uuid(key);
                if claude_session_exists(&sid) {
                    cmd.arg("--resume");
                } else {
                    cmd.arg("--session-id");
                }
                cmd.arg(&sid);
            }
        }
        if let Some(ref bin) = bin_dir {
            // Hooks (aprovação + estado) via --settings, skills via --plugin-dir
            // e um onboarding curto + o papel no system prompt.
            cmd.arg("--settings");
            cmd.arg(claude_settings_path().to_string_lossy().to_string());
            cmd.arg("--plugin-dir");
            cmd.arg(crate::skills::plugin_dir(bin).to_string_lossy().to_string());
        }
        cmd.arg("--append-system-prompt");
        cmd.arg(crate::skills::onboarding(&id, role_def.as_ref()));
    } else if agent_kind == "ollama" {
        if let Some(ref r) = role_def {
            deliver_role_after_boot = Some(crate::roles::role_block(r));
        }
    } else if agent_kind != "shell" && (agent_kind == "codex" || role_def.is_some()) {
        // Codex (e outros agentes com papel) leem AGENTS.md/CLAUDE.md: diretório
        // de papel como cwd, com as skills e uma nota apontando o projeto real.
        let base = shared
            .data_dir
            .get()
            .cloned()
            .unwrap_or_else(|| std::env::temp_dir().join("colmeia"));
        match crate::skills::prepare_agent_dir(cwd_eff.as_deref(), role_def.as_ref(), &base) {
            Ok(dir) => cwd_eff = Some(dir.to_string_lossy().to_string()),
            Err(e) => eprintln!("[pty] falha ao preparar o diretório do papel: {e}"),
        }
    }

    for (k, v) in std::env::vars() {
        if k.eq_ignore_ascii_case("path") {
            if let Some(ref bin) = bin_dir {
                cmd.env(&k, format!("{}{}{}", bin.display(), sep, v));
                continue;
            }
        }
        cmd.env(k, v);
    }
    let token = shared.issue_token(&id);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("COLMEIA_NODE_ID", &id);
    cmd.env("COLMEIA_TOKEN", &token);
    cmd.env("COLMEIA_PORT", shared.port.lock().unwrap().to_string());
    for (k, v) in &floor_env {
        cmd.env(k, v);
    }
    if let Some(ref bin) = bin_dir {
        let cli = if cfg!(windows) {
            bin.join("colmeia.cmd")
        } else {
            bin.join("colmeia")
        };
        cmd.env("COLMEIA_CLI", cli.to_string_lossy().to_string());
    }

    if let Some(ref dir) = cwd_eff {
        cmd.cwd(dir);
    }

    let child = match pair.slave.spawn_command(cmd) {
        Ok(c) => c,
        Err(e) => {
            shared.revoke_tokens(&id);
            return Err(format!("spawn falhou: {e}"));
        }
    };
    drop(pair.slave);
    // Prende o agente (e o que ele criar) num job: matar a sessão derruba a árvore.
    let tree = child
        .process_id()
        .and_then(crate::proctree::ProcessTree::attach);

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take_writer falhou: {e}"))?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone_reader falhou: {e}"))?;

    let generation = shared.generation.fetch_add(1, Ordering::Relaxed) + 1;
    let io = Arc::new(SessionIo {
        screen: Mutex::new(ScreenModel::new(rows, cols)),
        last_output: Mutex::new(Instant::now()),
        bytes_total: AtomicU64::new(0),
        last_human_input: Mutex::new(None),
        deliver_lock: Mutex::new(()),
        started: Instant::now(),
        generation,
        exited: AtomicBool::new(false),
    });
    shared.reset_activity(&id);

    // Thread que lê a saída do PTY: envia pelo canal e alimenta o modelo de tela.
    let out_channel = channel.clone();
    let io_thread = io.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    io_thread.screen.lock().unwrap().process(&buf[..n]);
                    io_thread.bytes_total.fetch_add(n as u64, Ordering::Relaxed);
                    *io_thread.last_output.lock().unwrap() = Instant::now();
                    let b64 = B64.encode(&buf[..n]);
                    if out_channel.send(PtyOutput::Data { b64 }).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        io_thread.exited.store(true, Ordering::Relaxed);
        let _ = out_channel.send(PtyOutput::Exit { code: None });
    });

    shared.sessions.lock().unwrap().insert(
        id.clone(),
        PtySession {
            writer,
            master: pair.master,
            child,
            io,
            tree,
        },
    );

    if let Some(text) = deliver_role_after_boot {
        let shared = shared.clone();
        std::thread::spawn(move || {
            shared.wait_booted(&id, Duration::from_secs(20));
            let _ = shared.deliver(&id, &text);
        });
    }

    Ok(())
}

/// Escreve dados (teclado do usuário) na entrada do PTY.
#[tauri::command]
pub fn pty_write(state: State<'_, PtyState>, id: String, data: String) -> Result<(), String> {
    state.0.note_human_input(&id, &data);
    if state.0.write_to(&id, &data) {
        Ok(())
    } else {
        Err(format!("sessão '{id}' não encontrada"))
    }
}

/// Envia uma linha como prompt (entrega robusta, ver delivery.rs).
#[tauri::command]
pub fn pty_submit(state: State<'_, PtyState>, id: String, data: String) -> Result<(), String> {
    if state.0.submit_line(id.clone(), data) {
        Ok(())
    } else {
        Err(format!("sessão '{id}' não encontrada"))
    }
}

/// Redimensiona o PTY (quando o nó do canvas muda de tamanho) e o modelo de tela.
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
    session.io.screen.lock().unwrap().resize(rows, cols);
    Ok(())
}

/// Mata a sessão, invalida o token do nó e libera os recursos.
#[tauri::command]
pub fn pty_kill(state: State<'_, PtyState>, id: String) -> Result<(), String> {
    let removed = state.0.sessions.lock().unwrap().remove(&id);
    if let Some(mut session) = removed {
        if let Some(tree) = &session.tree {
            tree.kill();
        }
        let _ = session.child.kill();
    }
    state.0.revoke_tokens(&id);
    state.0.clear_activity(&id);
    Ok(())
}

/// Atualiza o grafo (nós + arestas) que o servidor loopback usa para escopo.
#[tauri::command]
pub fn set_graph(state: State<'_, PtyState>, nodes: Vec<NodeInfo>, edges: Vec<EdgeInfo>) {
    *state.0.nodes.lock().unwrap() = nodes;
    *state.0.edges.lock().unwrap() = edges;
}

/// Recebe o catálogo de agentes (AGENTS do frontend).
#[tauri::command]
pub fn set_presets(state: State<'_, PtyState>, presets: Vec<PresetInfo>) {
    *state.0.presets.lock().unwrap() = presets;
}

// Comandos de rotinas: em `routines.rs`.

/// Responde a uma aprovação pendente. Se `always` (e permitindo), registra uma
/// regra de auto-aprovação para (node, tool) pelo resto da sessão.
#[tauri::command]
pub fn approval_resolve(
    state: State<'_, PtyState>,
    id: String,
    allow: bool,
    always: bool,
    node: String,
    tool: String,
) {
    if always && allow && !node.is_empty() && !tool.is_empty() {
        state.0.add_auto_allow(&node, &tool);
    }
    if let Some(tx) = state.0.take_pending(&id) {
        let _ = tx.send(allow);
    }
}

// ── Sessão persistente do Claude ────────────────────────────────────────

/// FNV-1a 64 com semente — determinístico entre execuções e versões do Rust
/// (o `DefaultHasher` não garante isso).
fn fnv1a64(seed: u64, data: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325 ^ seed;
    for b in data {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// UUID (formato v4) estável para uma chave de sessão.
pub(crate) fn session_uuid(key: &str) -> String {
    let a = fnv1a64(0x9e37_79b9_7f4a_7c15, key.as_bytes());
    let b = fnv1a64(0xc2b2_ae3d_27d4_eb4f, key.as_bytes());
    let mut bytes = [0u8; 16];
    bytes[..8].copy_from_slice(&a.to_be_bytes());
    bytes[8..].copy_from_slice(&b.to_be_bytes());
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // versão 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variante RFC 4122
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// Diretório de configuração do Claude Code (`CLAUDE_CONFIG_DIR` ou `~/.claude`).
fn claude_config_dir() -> Option<PathBuf> {
    if let Ok(d) = std::env::var("CLAUDE_CONFIG_DIR") {
        if !d.is_empty() {
            return Some(PathBuf::from(d));
        }
    }
    let home = std::env::var("USERPROFILE")
        .ok()
        .filter(|h| !h.is_empty())
        .or_else(|| std::env::var("HOME").ok())?;
    Some(PathBuf::from(home).join(".claude"))
}

/// A conversa `<sid>` já existe? (o Claude grava `projects/<pasta>/<sid>.jsonl`).
fn claude_session_exists(sid: &str) -> bool {
    let Some(projects) = claude_config_dir().map(|d| d.join("projects")) else {
        return false;
    };
    let Ok(entries) = std::fs::read_dir(&projects) else {
        return false;
    };
    let file = format!("{sid}.jsonl");
    entries
        .flatten()
        .any(|e| e.path().join(&file).is_file())
}

#[cfg(test)]
mod tests {
    #[test]
    fn session_uuid_is_stable_and_well_formed() {
        let a = super::session_uuid("canvas|claude-3|C:/proj|0");
        assert_eq!(a, super::session_uuid("canvas|claude-3|C:/proj|0"));
        assert_ne!(a, super::session_uuid("canvas|claude-3|C:/proj|1"));
        assert_eq!(a.len(), 36);
        assert_eq!(&a[14..15], "4");
    }

    use super::*;

    #[test]
    fn program_name_strips_path_and_ext() {
        assert_eq!(program_name("claude"), "claude");
        assert_eq!(program_name("C:\\tools\\Claude.CMD"), "claude");
        assert_eq!(program_name("/usr/bin/codex"), "codex");
    }

    #[test]
    fn tokens_are_per_node_and_revocable() {
        let s = Shared::new();
        let t1 = s.issue_token("a");
        let t2 = s.issue_token("b");
        assert_ne!(t1, t2);
        assert_eq!(s.node_for_token(&t1).as_deref(), Some("a"));
        // Respawn do mesmo nó invalida o token antigo.
        let t1b = s.issue_token("a");
        assert_eq!(s.node_for_token(&t1), None);
        assert_eq!(s.node_for_token(&t1b).as_deref(), Some("a"));
        s.revoke_tokens("a");
        assert_eq!(s.node_for_token(&t1b), None);
        assert_eq!(s.node_for_token(""), None);
    }
}
