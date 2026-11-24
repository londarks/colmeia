// Floors: checkouts isolados de um repositório via `git worktree`, ao lado do
// projeto em `<pai>/.colmeia-floors/<repo>--<slug>` (branch `floor/<slug>`).
//
// Regras de segurança:
// - Todo floor é registrado (registry.rs) ANTES de mexer no git; falhas fazem rollback.
// - Só apagamos worktree/branch que o colmeia criou (prova de posse).
// - Remover recusa se houver mudanças pendentes ou commits que só existem na branch,
//   a menos que venha `force` com a "impressão digital" da perda que o usuário viu.
// - Land recusa com floor/ground sujos ou operação git em andamento, e mostra os
//   conflitos (via `git merge-tree --write-tree`) antes de tocar em qualquer coisa.

pub mod git;
pub mod registry;
pub mod seed;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::pty::Shared;
use git::CommitInfo;
use registry::{FloorRecord, FloorState, FloorStatus};
use seed::DepsMode;

/// Pasta oculta (ao lado do projeto) onde os floors vivem.
pub const FLOORS_DIR: &str = ".colmeia-floors";
/// Faixa de portas: floor N recebe `PORT_BASE_START + N * PORT_STRIDE` (100 portas cada).
pub const PORT_BASE_START: u32 = 41000;
pub const PORT_STRIDE: u32 = 100;
const STATUS_MAX_CHARS: usize = 120;
const VALID_STATES: [&str; 4] = ["working", "blocked", "review", "done"];

// ============================================================================
// Tipos expostos ao frontend
// ============================================================================

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FloorView {
    /// Id no registro (None para o ground e worktrees externos).
    pub id: Option<String>,
    pub name: String,
    pub branch: String,
    pub path: String,
    pub is_main: bool,
    /// Criado/adotado pelo colmeia (pode ser removido/landed por ele).
    pub managed: bool,
    pub legacy: bool,
    /// pending | ready | deleting | orphaned | external | ground
    pub state: String,
    pub status: Option<FloorStatus>,
    pub index: u32,
    pub port_base: Option<u32>,
    /// Quantidade de mudanças pendentes (sem contar arquivos semeados intactos).
    pub dirty: u32,
    pub deps_mode: String,
    pub note: String,
}

/// O que seria perdido ao remover um floor.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LossReport {
    pub floor: String,
    pub branch: String,
    /// Mudanças não commitadas (`XY caminho`).
    pub dirty: Vec<String>,
    /// Commits que só existem na branch do floor (perdidos se a branch for apagada).
    pub unique_commits: Vec<CommitInfo>,
    pub unique_commit_count: u32,
    pub branch_will_be_deleted: bool,
    pub operation: Option<String>,
    /// Hash do que está acima; `force` precisa trazê-lo de volta.
    pub fingerprint: String,
}

impl LossReport {
    pub fn has_loss(&self) -> bool {
        !self.dirty.is_empty()
            || self.operation.is_some()
            || (self.branch_will_be_deleted && self.unique_commit_count > 0)
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RemoveResult {
    pub removed: bool,
    pub branch_deleted: bool,
    pub loss: Option<LossReport>,
    pub message: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LandPreview {
    pub floor: String,
    pub branch: String,
    pub target: String,
    /// Commits do floor que ainda não estão no alvo.
    pub ahead: u32,
    /// Commits do alvo que o floor não tem.
    pub behind: u32,
    /// `diff --name-status alvo...floor`.
    pub files: Vec<String>,
    pub conflicts: Vec<String>,
    /// Motivos que impedem o land (sujeira, operação em andamento...).
    pub blockers: Vec<String>,
    pub merge_tree_supported: bool,
    /// Branches locais que podem ser alvo.
    pub targets: Vec<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LandResult {
    pub landed: bool,
    pub target: String,
    pub merge_commit: Option<String>,
    pub conflicts: Vec<String>,
    pub blockers: Vec<String>,
    pub floor_removed: bool,
    pub branch_deleted: bool,
    pub message: String,
}

// ============================================================================
// Utilidades
// ============================================================================

/// Slug seguro para pasta/branch: minúsculas, `[a-z0-9-]`, acentos transliterados.
pub fn slugify(s: &str) -> String {
    let mut out = String::new();
    for c in s.trim().chars().flat_map(|c| c.to_lowercase()) {
        let mapped = match c {
            'á' | 'à' | 'â' | 'ã' | 'ä' => 'a',
            'é' | 'è' | 'ê' | 'ë' => 'e',
            'í' | 'ì' | 'î' | 'ï' => 'i',
            'ó' | 'ò' | 'ô' | 'õ' | 'ö' => 'o',
            'ú' | 'ù' | 'û' | 'ü' => 'u',
            'ç' => 'c',
            'ñ' => 'n',
            c if c.is_ascii_alphanumeric() => c,
            _ => '-',
        };
        if mapped == '-' && (out.is_empty() || out.ends_with('-')) {
            continue;
        }
        out.push(mapped);
    }
    while out.ends_with('-') {
        out.pop();
    }
    out.chars()
        .take(48)
        .collect::<String>()
        .trim_end_matches('-')
        .to_string()
}

fn fnv(s: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

fn truncate_chars(s: &str, max: usize) -> String {
    let t = s.trim();
    if t.chars().count() <= max {
        t.to_string()
    } else {
        let mut cut: String = t.chars().take(max.saturating_sub(1)).collect();
        cut.push('…');
        cut
    }
}

pub fn port_base(index: u32) -> u32 {
    PORT_BASE_START + index * PORT_STRIDE
}

fn file_name_of(p: &Path) -> String {
    p.file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "repo".to_string())
}

/// Ground (raiz do worktree principal) de qualquer pasta dentro do repositório,
/// inclusive de dentro de um floor.
pub fn ground_root(dir: &Path) -> Result<PathBuf, String> {
    let top = git::toplevel(dir)?;
    let list = git::worktrees(&top)?;
    Ok(list.first().map(|w| w.path.clone()).unwrap_or(top))
}

fn same_repo(rec: &FloorRecord, common: &Path) -> bool {
    git::norm(Path::new(&rec.common_dir)) == git::norm(common)
}

/// Registros deste repositório.
fn records_of(common: &Path) -> Vec<FloorRecord> {
    registry::all()
        .into_iter()
        .filter(|r| same_repo(r, common))
        .collect()
}

/// Pasta de floors gerenciada para um ground.
fn managed_root(ground: &Path) -> Option<PathBuf> {
    ground.parent().map(|p| p.join(FLOORS_DIR))
}

/// Floor no formato antigo? (`<pai>/<repo>-floor-<nome>`, branch `colmeia/<nome>`)
fn legacy_name(ground: &Path, wt: &git::Worktree) -> Option<String> {
    let base = file_name_of(ground);
    let dir = file_name_of(&wt.path);
    let name = dir.strip_prefix(&format!("{base}-floor-"))?.to_string();
    let same_parent = match (wt.path.parent(), ground.parent()) {
        (Some(a), Some(b)) => git::norm(a) == git::norm(b),
        _ => false,
    };
    let branch_ok = wt
        .branch
        .as_deref()
        .map(|b| b.starts_with("colmeia/"))
        .unwrap_or(false);
    (same_parent && branch_ok && !name.is_empty()).then_some(name)
}

/// Mudanças pendentes do floor, ignorando arquivos semeados intactos e links nossos.
fn floor_dirty(rec: &FloorRecord) -> Result<Vec<String>, String> {
    let path = PathBuf::from(&rec.path);
    let entries = git::status_entries(&path)?;
    Ok(entries
        .into_iter()
        .filter(|(xy, p)| {
            if rec.linked.iter().any(|l| l == p.trim_end_matches('/')) {
                return false;
            }
            if xy == "??" {
                if let Some(s) = rec.seeded_untracked.iter().find(|s| &s.path == p) {
                    return seed::file_hash(&path.join(p)).as_deref() != Some(s.hash.as_str());
                }
            }
            true
        })
        .map(|(xy, p)| format!("{xy} {p}"))
        .collect())
}

fn ground_dirty(ground: &Path) -> Result<Vec<String>, String> {
    Ok(git::status_entries(ground)?
        .into_iter()
        .map(|(xy, p)| format!("{xy} {p}"))
        .collect())
}

fn view_of(rec: &FloorRecord) -> FloorView {
    let exists = Path::new(&rec.path).exists();
    let dirty = if exists && rec.state == FloorState::Ready {
        floor_dirty(rec).map(|d| d.len() as u32).unwrap_or(0)
    } else {
        0
    };
    let state = match rec.state {
        FloorState::Pending => "pending",
        FloorState::Ready => "ready",
        FloorState::Deleting => "deleting",
        FloorState::Orphaned => "orphaned",
    };
    FloorView {
        id: Some(rec.id.clone()),
        name: rec.name.clone(),
        branch: rec.branch.clone(),
        path: rec.path.clone(),
        is_main: false,
        managed: true,
        legacy: rec.legacy,
        state: state.to_string(),
        status: rec.status.clone(),
        index: rec.index,
        port_base: Some(port_base(rec.index)),
        dirty,
        deps_mode: rec.deps_mode.clone(),
        note: rec.note.clone(),
    }
}

// ============================================================================
// Inicialização / recuperação
// ============================================================================

/// Chamado no `setup()`: aponta o registro para o `app_data_dir` e marca como
/// `orphaned` o que ficou no meio do caminho (app fechado durante criar/apagar).
pub fn init(app: &AppHandle) {
    if let Ok(dir) = app.path().app_data_dir() {
        registry::init_dir(dir);
    }
    let _ = registry::mutate(|floors| {
        for f in floors.iter_mut() {
            if matches!(f.state, FloorState::Pending | FloorState::Deleting) {
                f.state = FloorState::Orphaned;
                f.note = "Operação interrompida (o app fechou no meio). Remova para limpar.".into();
            }
        }
    });
}

// ============================================================================
// Listagem (com adoção dos floors antigos)
// ============================================================================

pub fn list(repo: &Path) -> Result<Vec<FloorView>, String> {
    let ground = ground_root(repo)?;
    let common = git::common_dir(&ground)?;
    let worktrees = git::worktrees(&ground)?;

    // Adota floors no formato antigo para entrarem no fluxo seguro.
    let known = records_of(&common);
    for wt in worktrees.iter().skip(1) {
        let wt_norm = git::norm(&wt.path);
        if known
            .iter()
            .any(|r| git::norm(Path::new(&r.path)) == wt_norm)
        {
            continue;
        }
        if let Some(name) = legacy_name(&ground, wt) {
            let rec_name = name.clone();
            let _ = registry::mutate(|floors| {
                let index = registry::free_index(floors);
                floors.push(FloorRecord {
                    id: registry::gen_id(),
                    slug: slugify(&rec_name),
                    name: rec_name,
                    repo_root: ground.to_string_lossy().to_string(),
                    common_dir: common.to_string_lossy().to_string(),
                    path: wt.path.to_string_lossy().to_string(),
                    branch: wt.branch.clone().unwrap_or_default(),
                    // Não dá para provar quem criou a branch antiga: nunca a apagamos.
                    branch_created: false,
                    base_oid: String::new(),
                    created_at: registry::now_ms(),
                    state: FloorState::Ready,
                    index,
                    legacy: true,
                    status: None,
                    linked: Vec::new(),
                    seeded_untracked: Vec::new(),
                    deps_mode: String::new(),
                    note: String::new(),
                });
            });
        }
    }

    // Registros "ready" cuja pasta sumiu viram órfãos (para o usuário limpar).
    let listed: Vec<String> = worktrees.iter().map(|w| git::norm(&w.path)).collect();
    let _ = registry::mutate(|floors| {
        for f in floors.iter_mut().filter(|f| same_repo(f, &common)) {
            let p = Path::new(&f.path);
            if f.state == FloorState::Ready && (!p.exists() || !listed.contains(&git::norm(p))) {
                f.state = FloorState::Orphaned;
                f.note =
                    "A pasta do floor sumiu ou não é mais um worktree deste repositório.".into();
            }
        }
    });

    let records = records_of(&common);
    let mut views = Vec::new();
    views.push(FloorView {
        id: None,
        name: "Ground".into(),
        branch: git::current_branch(&ground).unwrap_or_else(|| "(HEAD destacado)".into()),
        path: ground.to_string_lossy().to_string(),
        is_main: true,
        managed: false,
        legacy: false,
        state: "ground".into(),
        status: None,
        index: 0,
        port_base: None,
        dirty: ground_dirty(&ground).map(|d| d.len() as u32).unwrap_or(0),
        deps_mode: String::new(),
        note: String::new(),
    });
    for rec in &records {
        views.push(view_of(rec));
    }
    // Worktrees que o colmeia não criou: só exibidos, nunca apagados por aqui.
    for wt in worktrees.iter().skip(1) {
        let n = git::norm(&wt.path);
        if records.iter().any(|r| git::norm(Path::new(&r.path)) == n) {
            continue;
        }
        views.push(FloorView {
            id: None,
            name: file_name_of(&wt.path),
            branch: wt.branch.clone().unwrap_or_default(),
            path: wt.path.to_string_lossy().to_string(),
            is_main: false,
            managed: false,
            legacy: false,
            state: "external".into(),
            status: None,
            index: 0,
            port_base: None,
            dirty: 0,
            deps_mode: String::new(),
            note: "Worktree criado fora do colmeia (somente leitura aqui).".into(),
        });
    }
    Ok(views)
}

// ============================================================================
// Criação
// ============================================================================

pub struct CreateOpts {
    pub name: String,
    pub branch: Option<String>,
    pub existing_branch: bool,
    pub deps: DepsMode,
}

/// Cria um floor pronto para uso. `progress(arquivos, bytes)` acompanha o seeding.
pub fn create(
    repo: &Path,
    opts: CreateOpts,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<(FloorRecord, seed::SeedReport), String> {
    let ground = ground_root(repo)?;
    if !git::has_commits(&ground) {
        return Err(
            "O repositório ainda não tem commits. Faça o primeiro commit antes de criar um floor."
                .into(),
        );
    }
    let common = git::common_dir(&ground)?;
    let name = opts.name.trim().to_string();
    let slug = slugify(&name);
    if slug.is_empty() {
        return Err("Nome do floor inválido (use letras/números).".into());
    }
    let branch = opts
        .branch
        .as_deref()
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("floor/{slug}"));
    if !git::valid_branch_name(&ground, &branch) {
        return Err(format!("Nome de branch inválido: '{branch}'."));
    }
    if records_of(&common)
        .iter()
        .any(|r| r.name.eq_ignore_ascii_case(&name) || r.slug == slug)
    {
        return Err(format!(
            "Já existe um floor chamado '{name}' neste repositório. Escolha outro nome."
        ));
    }
    let exists = git::branch_exists(&ground, &branch);
    if opts.existing_branch {
        if !exists {
            return Err(format!("A branch '{branch}' não existe."));
        }
        if let Some(w) = git::worktrees(&ground)?
            .into_iter()
            .find(|w| w.branch.as_deref() == Some(branch.as_str()))
        {
            return Err(format!(
                "A branch '{branch}' já está em uso no worktree {}.",
                w.path.display()
            ));
        }
    } else if exists {
        return Err(format!(
            "A branch '{branch}' já existe. Use outro nome/branch ou a opção de usar branch existente."
        ));
    }

    // Reserva atômica da pasta: create_dir NÃO recursivo falha se já existir.
    let root = managed_root(&ground).ok_or("repositório sem pasta pai")?;
    std::fs::create_dir_all(&root).map_err(|e| format!("mkdir {}: {e}", root.display()))?;
    let repo_slug = {
        let s = slugify(&file_name_of(&ground));
        if s.is_empty() {
            "repo".to_string()
        } else {
            s
        }
    };
    let mut path: Option<PathBuf> = None;
    for i in 1..=50 {
        let dir = if i == 1 {
            format!("{repo_slug}--{slug}")
        } else {
            format!("{repo_slug}--{slug}-{i}")
        };
        let candidate = root.join(dir);
        match std::fs::create_dir(&candidate) {
            Ok(()) => {
                path = Some(candidate);
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("não consegui reservar a pasta do floor: {e}")),
        }
    }
    let path = path.ok_or("não achei pasta livre para o floor (50 tentativas)")?;

    let base_oid = if opts.existing_branch {
        git::rev_parse(&ground, &format!("refs/heads/{branch}"))?
    } else {
        git::rev_parse(&ground, "HEAD")?
    };

    // Registro ANTES do git (pending): permite rollback e prova de posse.
    let mut rec = FloorRecord {
        id: registry::gen_id(),
        name: name.clone(),
        slug,
        repo_root: ground.to_string_lossy().to_string(),
        common_dir: common.to_string_lossy().to_string(),
        path: path.to_string_lossy().to_string(),
        branch: branch.clone(),
        branch_created: !opts.existing_branch,
        base_oid: base_oid.clone(),
        created_at: registry::now_ms(),
        state: FloorState::Pending,
        index: 0,
        legacy: false,
        status: None,
        linked: Vec::new(),
        seeded_untracked: Vec::new(),
        deps_mode: opts.deps.as_str().to_string(),
        note: String::new(),
    };
    {
        let r = rec.clone();
        let index = registry::mutate(move |floors| {
            let index = registry::free_index(floors);
            let mut r = r;
            r.index = index;
            floors.push(r);
            index
        });
        match index {
            Ok(i) => rec.index = i,
            Err(e) => {
                let _ = std::fs::remove_dir(&path);
                return Err(e);
            }
        }
    }

    let path_s = rec.path.clone();
    let added = if opts.existing_branch {
        git::git(&ground, &["worktree", "add", &path_s, &branch])
    } else {
        git::git(
            &ground,
            &["worktree", "add", "-b", &branch, &path_s, &base_oid],
        )
    };
    if let Err(e) = added {
        rollback(&ground, &rec);
        return Err(format!("git worktree add falhou: {e}"));
    }

    let report = seed::seed(&ground, &path, opts.deps, progress);
    rec.linked = report.linked.clone();
    rec.seeded_untracked = report.seeded_untracked.clone();
    rec.state = FloorState::Ready;
    if let Err(e) = registry::upsert(&rec) {
        rollback(&ground, &rec);
        return Err(e);
    }
    Ok((rec, report))
}

/// Desfaz uma criação que falhou. Se não conseguir limpar tudo, marca `orphaned`.
fn rollback(ground: &Path, rec: &FloorRecord) {
    let path = PathBuf::from(&rec.path);
    let _ = seed::unlink_all(&path, &rec.linked);
    let _ = git::git(ground, &["worktree", "remove", "--force", &rec.path]);
    if path.exists() {
        let _ = std::fs::remove_dir_all(&path);
    }
    let _ = git::git(ground, &["worktree", "prune"]);
    if rec.branch_created && git::branch_exists(ground, &rec.branch) {
        // Branch recém-criada a partir do HEAD: não contém trabalho de ninguém.
        let _ = git::git(ground, &["branch", "-D", &rec.branch]);
    }
    if path.exists() {
        let mut r = rec.clone();
        r.state = FloorState::Orphaned;
        r.note = "Falha ao criar e a pasta não pôde ser removida.".into();
        let _ = registry::upsert(&r);
    } else {
        let _ = registry::remove(&rec.id);
        if let Some(root) = managed_root(ground) {
            let _ = std::fs::remove_dir(root); // só sai se vazia
        }
    }
}

// ============================================================================
// Remoção segura
// ============================================================================

/// Prova que o floor é do colmeia e deste repositório.
fn prove_owned(rec: &FloorRecord) -> Result<(), String> {
    let ground = PathBuf::from(&rec.repo_root);
    let path = PathBuf::from(&rec.path);
    let in_managed = managed_root(&ground)
        .map(|root| git::is_inside(&path, &root) && git::norm(&path) != git::norm(&root))
        .unwrap_or(false);
    if !in_managed && !rec.legacy {
        return Err(format!(
            "'{}' está fora da pasta gerenciada ({FLOORS_DIR}); não apago.",
            rec.path
        ));
    }
    if !path.exists() {
        return Ok(()); // nada no disco para provar; só o registro/worktree a limpar
    }
    let listed = git::worktrees(&ground)?
        .iter()
        .any(|w| git::norm(&w.path) == git::norm(&path));
    if !listed {
        return Err(format!(
            "'{}' existe mas não é um worktree deste repositório; não apago.",
            rec.path
        ));
    }
    let common = git::common_dir(&path)?;
    if git::norm(&common) != git::norm(Path::new(&rec.common_dir)) {
        return Err("O floor pertence a outro repositório; não apago.".into());
    }
    Ok(())
}

/// O que seria perdido removendo o floor (e, se `delete_branch`, a branch).
pub fn inspect(rec: &FloorRecord, delete_branch: bool) -> LossReport {
    let path = PathBuf::from(&rec.path);
    let ground = PathBuf::from(&rec.repo_root);
    let exists = path.exists();
    let dirty = if exists {
        floor_dirty(rec).unwrap_or_else(|e| vec![format!("(não consegui ler o status: {e})")])
    } else {
        Vec::new()
    };
    let operation = if exists {
        git::operation_in_progress(&path)
    } else {
        None
    };
    let (count, commits) = if git::branch_exists(&ground, &rec.branch) {
        git::unique_commits(&ground, &rec.branch, 20)
    } else {
        (0, Vec::new())
    };
    let mut fp = String::new();
    fp.push_str(&rec.id);
    for d in &dirty {
        fp.push('\n');
        fp.push_str(d);
    }
    fp.push_str(&format!("\n#{count}\n{delete_branch}\n"));
    for c in &commits {
        fp.push_str(&c.oid);
    }
    if let Some(op) = &operation {
        fp.push_str(op);
    }
    LossReport {
        floor: rec.name.clone(),
        branch: rec.branch.clone(),
        dirty,
        unique_commits: commits,
        unique_commit_count: count,
        branch_will_be_deleted: delete_branch,
        operation,
        fingerprint: fnv(&fp),
    }
}

/// Remove um floor. Sem `force`, recusa se algo seria perdido (devolve o relatório).
/// Com `force`, só prossegue se a impressão digital bater com a perda atual.
pub fn remove(id: &str, force: Option<&str>, keep_branch: bool) -> Result<RemoveResult, String> {
    let rec = registry::get(id)
        .ok_or("Floor não encontrado no registro do colmeia (só removo floors criados por ele).")?;
    prove_owned(&rec)?;
    let ground = PathBuf::from(&rec.repo_root);
    let path = PathBuf::from(&rec.path);
    let delete_branch = rec.branch_created && !keep_branch;
    let loss = inspect(&rec, delete_branch);

    if loss.has_loss() {
        match force {
            Some(fp) if fp == loss.fingerprint => {}
            Some(_) => {
                return Ok(RemoveResult {
                    removed: false,
                    branch_deleted: false,
                    message: "O floor mudou desde a confirmação. Revise o que será perdido e confirme de novo.".into(),
                    loss: Some(loss),
                })
            }
            None => {
                return Ok(RemoveResult {
                    removed: false,
                    branch_deleted: false,
                    message: format!(
                        "Recusado: remover '{}' perderia trabalho. Commite/salve antes, ou confirme a perda.",
                        rec.name
                    ),
                    loss: Some(loss),
                })
            }
        }
    }

    let mut working = rec.clone();
    working.state = FloorState::Deleting;
    registry::upsert(&working)?;

    if path.exists() {
        // 1) Links primeiro: `git worktree remove` atravessa junctions no Windows.
        if let Err(e) = seed::unlink_all(&path, &rec.linked) {
            let mut back = rec.clone();
            back.state = FloorState::Ready;
            let _ = registry::upsert(&back);
            return Err(e);
        }
        // 2) Worktree. `--force` aqui é seguro: a perda já foi checada/confirmada acima
        //    (sem ele, os arquivos semeados ignorados/não rastreados bloqueariam).
        if let Err(e) = git::git(&ground, &["worktree", "remove", "--force", &rec.path]) {
            if path.exists()
                && git::worktrees(&ground)
                    .map(|l| l.iter().any(|w| git::norm(&w.path) == git::norm(&path)))
                    .unwrap_or(true)
            {
                let mut back = rec.clone();
                back.state = FloorState::Ready;
                back.note = format!("Remoção falhou: {e}");
                let _ = registry::upsert(&back);
                return Err(format!(
                    "Não consegui remover o floor (nada foi apagado): {e}"
                ));
            }
        }
        if path.exists() {
            // Sem links (removidos acima) e remove_dir_all não segue links.
            let _ = std::fs::remove_dir_all(&path);
        }
    }
    let _ = git::git(&ground, &["worktree", "prune"]);
    if path.exists() {
        let mut orphan = rec.clone();
        orphan.state = FloorState::Orphaned;
        orphan.note = "A pasta não pôde ser apagada por completo (arquivo em uso?).".into();
        let _ = registry::upsert(&orphan);
        return Err(format!(
            "O worktree foi desregistrado, mas a pasta '{}' não pôde ser apagada por completo. Feche programas usando-a e remova de novo.",
            rec.path
        ));
    }

    let mut branch_deleted = false;
    if delete_branch && git::branch_exists(&ground, &rec.branch) {
        // A perda de commits únicos já foi checada (ou confirmada via force).
        branch_deleted = git::git(&ground, &["branch", "-D", &rec.branch]).is_ok();
    }
    registry::remove(&rec.id)?;
    if let Some(root) = managed_root(&ground) {
        let _ = std::fs::remove_dir(root);
    }
    Ok(RemoveResult {
        removed: true,
        branch_deleted,
        loss: None,
        message: if branch_deleted {
            format!(
                "Floor '{}' removido (branch {} apagada).",
                rec.name, rec.branch
            )
        } else {
            format!(
                "Floor '{}' removido (branch {} mantida).",
                rec.name, rec.branch
            )
        },
    })
}

// ============================================================================
// Land (trazer o trabalho do floor para uma branch)
// ============================================================================

fn local_branches(ground: &Path) -> Vec<String> {
    git::git(
        ground,
        &["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    )
    .map(|o| {
        o.lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect()
    })
    .unwrap_or_default()
}

fn count(ground: &Path, range: &str) -> u32 {
    git::git(ground, &["rev-list", "--count", range])
        .ok()
        .and_then(|o| o.trim().parse().ok())
        .unwrap_or(0)
}

/// Conflitos previstos por `merge-tree --write-tree` (sem tocar no disco).
/// Ok((tree, conflitos)).
fn merge_tree(ground: &Path, target: &str, branch: &str) -> Result<(String, Vec<String>), String> {
    let o = git::run(
        ground,
        &[
            "merge-tree",
            "--write-tree",
            "--name-only",
            "--no-messages",
            target,
            branch,
        ],
    )?;
    let mut lines = o.stdout.lines().map(|l| l.trim().to_string());
    let tree = lines.next().unwrap_or_default();
    match o.code {
        0 => Ok((tree, Vec::new())),
        1 => Ok((tree, lines.filter(|l| !l.is_empty()).collect())),
        _ => Err(if o.stderr.is_empty() {
            "git merge-tree falhou".into()
        } else {
            o.stderr
        }),
    }
}

pub fn land_preview(id: &str, into: Option<&str>) -> Result<LandPreview, String> {
    let rec = registry::get(id).ok_or("Floor não encontrado.")?;
    let ground = PathBuf::from(&rec.repo_root);
    let path = PathBuf::from(&rec.path);
    let mut blockers = Vec::new();
    let ground_branch = git::current_branch(&ground);
    let target = into
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| ground_branch.clone())
        .unwrap_or_default();
    let supported = git::supports_merge_tree();

    if rec.state != FloorState::Ready {
        blockers.push(format!("O floor está em estado '{:?}'.", rec.state).to_lowercase());
    }
    if target.is_empty() {
        blockers.push("O ground está com HEAD destacado: escolha a branch de destino.".into());
    } else if !git::branch_exists(&ground, &target) {
        blockers.push(format!("A branch de destino '{target}' não existe."));
    } else if target == rec.branch {
        blockers.push("O destino é a própria branch do floor.".into());
    } else {
        let wts = git::worktrees(&ground).unwrap_or_default();
        if let Some(w) = wts
            .iter()
            .skip(1)
            .find(|w| w.branch.as_deref() == Some(target.as_str()))
        {
            blockers.push(format!(
                "A branch '{target}' está em checkout em outro worktree ({}).",
                w.path.display()
            ));
        }
    }
    if !git::branch_exists(&ground, &rec.branch) {
        blockers.push(format!(
            "A branch do floor '{}' não existe mais.",
            rec.branch
        ));
    }

    if path.exists() {
        match floor_dirty(&rec) {
            Ok(d) if !d.is_empty() => blockers.push(format!(
                "O floor tem {} mudança(s) não commitada(s): {}{}",
                d.len(),
                d.iter().take(5).cloned().collect::<Vec<_>>().join(", "),
                if d.len() > 5 { ", …" } else { "" }
            )),
            Err(e) => blockers.push(format!("Não consegui ler o status do floor: {e}")),
            _ => {}
        }
        if let Some(op) = git::operation_in_progress(&path) {
            blockers.push(format!("O floor está no meio de {op}."));
        }
    }
    if let Some(op) = git::operation_in_progress(&ground) {
        blockers.push(format!("O ground está no meio de {op}."));
    }

    let (mut ahead, mut behind, mut files, mut conflicts) = (0, 0, Vec::new(), Vec::new());
    let mut changed_paths: Vec<String> = Vec::new();
    let refs_ok = !target.is_empty()
        && git::branch_exists(&ground, &target)
        && git::branch_exists(&ground, &rec.branch);
    if refs_ok {
        ahead = count(&ground, &format!("{target}..{}", rec.branch));
        behind = count(&ground, &format!("{}..{target}", rec.branch));
        files = git::git(
            &ground,
            &[
                "diff",
                "--name-status",
                &format!("{target}...{}", rec.branch),
            ],
        )
        .map(|o| o.lines().map(|l| l.replace('\t', " ")).collect())
        .unwrap_or_default();
        changed_paths = git::git(
            &ground,
            &["diff", "--name-only", &format!("{target}...{}", rec.branch)],
        )
        .map(|o| o.lines().map(|l| l.trim().to_string()).collect())
        .unwrap_or_default();
    }

    // Ground: mudanças em arquivos rastreados bloqueiam; não rastreados só se o
    // merge fosse sobrescrevê-los (um `.env.local` solto não impede o land).
    match git::status_entries(&ground) {
        Ok(entries) => {
            let d: Vec<String> = entries
                .into_iter()
                .filter(|(xy, p)| xy != "??" || changed_paths.iter().any(|c| c == p))
                .map(|(xy, p)| format!("{xy} {p}"))
                .collect();
            if !d.is_empty() {
                blockers.push(format!(
                    "O ground tem {} mudança(s) não commitada(s): {}{}",
                    d.len(),
                    d.iter().take(5).cloned().collect::<Vec<_>>().join(", "),
                    if d.len() > 5 { ", …" } else { "" }
                ));
            }
        }
        Err(e) => blockers.push(format!("Não consegui ler o status do ground: {e}")),
    }

    if refs_ok {
        if supported && ahead > 0 && behind > 0 {
            match merge_tree(&ground, &target, &rec.branch) {
                Ok((_, c)) => conflicts = c,
                Err(e) => blockers.push(format!("Prévia de conflitos falhou: {e}")),
            }
        }
    }

    Ok(LandPreview {
        floor: rec.name.clone(),
        branch: rec.branch.clone(),
        target,
        ahead,
        behind,
        files,
        conflicts,
        blockers,
        merge_tree_supported: supported,
        targets: local_branches(&ground)
            .into_iter()
            .filter(|b| b != &rec.branch)
            .collect(),
    })
}

/// Faz o land: merge da branch do floor no destino (padrão: a branch do ground).
/// Recusa sem mexer em nada se houver bloqueios ou conflitos.
pub fn land(
    id: &str,
    into: Option<&str>,
    delete_branch: bool,
    keep_floor: bool,
) -> Result<LandResult, String> {
    let rec = registry::get(id).ok_or("Floor não encontrado.")?;
    let ground = PathBuf::from(&rec.repo_root);
    let preview = land_preview(id, into)?;
    let target = preview.target.clone();
    let mut result = LandResult {
        landed: false,
        target: target.clone(),
        merge_commit: None,
        conflicts: preview.conflicts.clone(),
        blockers: preview.blockers.clone(),
        floor_removed: false,
        branch_deleted: false,
        message: String::new(),
    };
    if !preview.blockers.is_empty() {
        result.message = "Land recusado: resolva os bloqueios e tente de novo.".into();
        return Ok(result);
    }
    if !preview.conflicts.is_empty() {
        result.message = format!(
            "Land recusado: o merge em '{target}' teria conflito em {} arquivo(s). Resolva no floor (ex.: merge de '{target}' lá) e tente de novo.",
            preview.conflicts.len()
        );
        return Ok(result);
    }

    let msg = format!(
        "Merge floor '{}' ({}) into {}",
        rec.name, rec.branch, target
    );
    if preview.ahead > 0 {
        let target_is_ground = git::current_branch(&ground).as_deref() == Some(target.as_str());
        if target_is_ground {
            if let Err(e) = git::git(&ground, &["merge", "--no-edit", "-m", &msg, &rec.branch]) {
                let conflicts: Vec<String> =
                    git::git(&ground, &["diff", "--name-only", "--diff-filter=U"])
                        .map(|o| o.lines().map(str::to_string).collect())
                        .unwrap_or_default();
                if let Ok(gd) = git::git_dir(&ground) {
                    if gd.join("MERGE_HEAD").exists() {
                        let _ = git::git(&ground, &["merge", "--abort"]);
                    }
                }
                result.conflicts = conflicts;
                result.message = format!("Merge falhou e foi desfeito (nada mudou): {e}");
                return Ok(result);
            }
        } else {
            // Destino fora de checkout: merge por "plumbing", sem working tree.
            let old = git::rev_parse(&ground, &format!("refs/heads/{target}"))?;
            let tip = git::rev_parse(&ground, &format!("refs/heads/{}", rec.branch))?;
            let new_oid = if git::is_ancestor(&ground, &old, &tip) {
                tip.clone() // fast-forward
            } else {
                if !git::supports_merge_tree() {
                    result.message = "Merge numa branch fora de checkout exige git >= 2.38. Faça checkout dela no ground ou atualize o git.".into();
                    return Ok(result);
                }
                let (tree, conflicts) = merge_tree(&ground, &old, &tip)?;
                if !conflicts.is_empty() {
                    result.conflicts = conflicts;
                    result.message = "Land recusado: conflitos.".into();
                    return Ok(result);
                }
                git::git(
                    &ground,
                    &["commit-tree", &tree, "-p", &old, "-p", &tip, "-m", &msg],
                )?
                .trim()
                .to_string()
            };
            // Compare-and-swap: só atualiza se o destino ainda estiver em `old`.
            git::git(
                &ground,
                &[
                    "update-ref",
                    "-m",
                    &msg,
                    &format!("refs/heads/{target}"),
                    &new_oid,
                    &old,
                ],
            )?;
        }
    }
    result.landed = true;
    result.merge_commit = git::rev_parse(&ground, &format!("refs/heads/{target}")).ok();

    let merged = git::is_ancestor(
        &ground,
        &format!("refs/heads/{}", rec.branch),
        &format!("refs/heads/{target}"),
    );
    let mut notes = vec![if preview.ahead > 0 {
        format!("'{}' mergeado em '{target}'.", rec.name)
    } else {
        format!("Nada a trazer: '{target}' já contém '{}'.", rec.branch)
    }];

    if !keep_floor {
        match remove(&rec.id, None, true) {
            Ok(r) if r.removed => {
                result.floor_removed = true;
                notes.push("Floor removido.".into());
            }
            Ok(r) => notes.push(format!("Floor mantido: {}", r.message)),
            Err(e) => notes.push(format!("Floor mantido: {e}")),
        }
    }
    if delete_branch {
        if !rec.branch_created {
            notes.push(format!(
                "Branch {} mantida (não foi criada pelo colmeia).",
                rec.branch
            ));
        } else if !merged {
            notes.push(format!(
                "Branch {} mantida (não está toda mergeada em {target}).",
                rec.branch
            ));
        } else if !result.floor_removed {
            notes.push(format!(
                "Branch {} mantida (ainda em uso pelo floor).",
                rec.branch
            ));
        } else {
            result.branch_deleted = git::git(&ground, &["branch", "-D", &rec.branch]).is_ok();
            if result.branch_deleted {
                notes.push(format!("Branch {} apagada.", rec.branch));
            }
        }
    }
    result.message = notes.join(" ");
    Ok(result)
}

// ============================================================================
// Status
// ============================================================================

/// Atualiza a linha de status. Devolve o registro e se houve transição que pede o humano.
pub fn set_status(
    id: &str,
    state: Option<&str>,
    text: &str,
    clear: bool,
) -> Result<(FloorRecord, bool), String> {
    let state = state
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty());
    if let Some(s) = &state {
        if !VALID_STATES.contains(&s.as_str()) {
            return Err(format!(
                "Estado inválido '{s}' (use working|blocked|review|done)."
            ));
        }
    }
    let text = truncate_chars(text, STATUS_MAX_CHARS);
    let id = id.to_string();
    let out = registry::mutate(
        move |floors: &mut Vec<FloorRecord>| -> Option<(FloorRecord, bool)> {
            let rec = floors.iter_mut().find(|f| f.id == id)?;
            let prev = rec.status.as_ref().map(|s| s.state.clone());
            if clear {
                rec.status = None;
                return Some((rec.clone(), false));
            }
            let new_state = state
                .or_else(|| prev.clone())
                .unwrap_or_else(|| "working".to_string());
            let new_text = if text.is_empty() {
                rec.status
                    .as_ref()
                    .map(|s| s.text.clone())
                    .unwrap_or_default()
            } else {
                text
            };
            let notify = prev.as_deref() != Some(new_state.as_str())
                && matches!(new_state.as_str(), "blocked" | "review" | "done");
            rec.status = Some(FloorStatus {
                state: new_state,
                text: new_text,
                updated_at: registry::now_ms(),
            });
            Some((rec.clone(), notify))
        },
    )?;
    out.ok_or_else(|| "Floor não encontrado.".to_string())
}

fn state_label(s: &str) -> &'static str {
    match s {
        "blocked" => "bloqueado",
        "review" => "pronto para revisão",
        "done" => "concluído",
        _ => "trabalhando",
    }
}

/// Emite `colmeia://notify` para uma transição de status.
fn notify_status(app: &AppHandle, rec: &FloorRecord) {
    if let Some(s) = &rec.status {
        let _ = app.emit(
            "colmeia://notify",
            serde_json::json!({
                "id": rec.id,
                "title": format!("Floor {}: {}", rec.name, state_label(&s.state)),
                "body": s.text,
            }),
        );
    }
}

fn emit_changed(app: &AppHandle) {
    let _ = app.emit("colmeia://floors-changed", ());
}

// ============================================================================
// Ambiente por floor (para o spawn de PTY)
// ============================================================================

/// Registro do floor que contém `cwd` (o mais específico), se houver.
pub fn floor_for_cwd(cwd: &str) -> Option<FloorRecord> {
    if cwd.trim().is_empty() {
        return None;
    }
    let p = Path::new(cwd);
    registry::all()
        .into_iter()
        .filter(|r| r.state == FloorState::Ready && git::is_inside(p, Path::new(&r.path)))
        .max_by_key(|r| r.path.len())
}

/// Variáveis de ambiente para um processo cujo cwd está num floor. Vazio se não está.
/// O integrador chama isto no `pty_spawn` e faz `cmd.env(k, v)` para cada par.
///
/// - `COLMEIA_FLOOR` / `COLMEIA_FLOOR_ID` / `COLMEIA_BRANCH` / `COLMEIA_FLOOR_PATH` / `COLMEIA_ROOT_PATH`
/// - `COLMEIA_FLOOR_INDEX` e `COLMEIA_PORT_BASE` (41000 + 100*índice; 100 portas por floor)
/// - `COMPOSE_PROJECT_NAME` = `<repo>-<slug>` (isola containers/volumes do docker compose)
pub fn floor_env_for_cwd(cwd: &str) -> Vec<(String, String)> {
    let Some(rec) = floor_for_cwd(cwd) else {
        return Vec::new();
    };
    let repo_slug = slugify(&file_name_of(Path::new(&rec.repo_root)));
    let compose: String = format!("{repo_slug}-{}", rec.slug)
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect::<String>()
        .trim_start_matches(|c: char| !c.is_ascii_alphanumeric())
        .to_string();
    vec![
        ("COLMEIA_FLOOR".into(), rec.name.clone()),
        ("COLMEIA_FLOOR_ID".into(), rec.id.clone()),
        ("COLMEIA_BRANCH".into(), rec.branch.clone()),
        ("COLMEIA_FLOOR_PATH".into(), rec.path.clone()),
        ("COLMEIA_ROOT_PATH".into(), rec.repo_root.clone()),
        ("COLMEIA_FLOOR_INDEX".into(), rec.index.to_string()),
        ("COLMEIA_PORT_BASE".into(), port_base(rec.index).to_string()),
        ("COMPOSE_PROJECT_NAME".into(), compose),
    ]
}

// ============================================================================
// Comandos Tauri
// ============================================================================

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("tarefa falhou: {e}"))?
}

/// Lista Ground + floors (com status, sujeira e portas) de um repositório.
#[tauri::command]
pub async fn floor_list(repo: String) -> Result<Vec<FloorView>, String> {
    blocking(move || list(Path::new(&repo))).await
}

/// Cria um floor. `deps`: "copy" (padrão) | "link" | "skip".
#[tauri::command]
pub async fn floor_create(
    app: AppHandle,
    repo: String,
    name: String,
    branch: Option<String>,
    existing_branch: Option<bool>,
    deps: Option<String>,
) -> Result<FloorView, String> {
    let app2 = app.clone();
    let view = blocking(move || {
        let progress_name = name.clone();
        let mut progress = |files: u64, bytes: u64| {
            let _ = app2.emit(
                "colmeia://floor-progress",
                serde_json::json!({ "name": progress_name, "files": files, "bytes": bytes }),
            );
        };
        let (rec, _report) = create(
            Path::new(&repo),
            CreateOpts {
                name,
                branch,
                existing_branch: existing_branch.unwrap_or(false),
                deps: DepsMode::parse(deps.as_deref().unwrap_or("copy")),
            },
            &mut progress,
        )?;
        Ok(view_of(&rec))
    })
    .await?;
    emit_changed(&app);
    Ok(view)
}

/// O que seria perdido ao remover (para a confirmação na UI).
#[tauri::command]
pub async fn floor_inspect(id: String, keep_branch: Option<bool>) -> Result<LossReport, String> {
    blocking(move || {
        let rec = registry::get(&id).ok_or("Floor não encontrado.")?;
        Ok(inspect(
            &rec,
            rec.branch_created && !keep_branch.unwrap_or(false),
        ))
    })
    .await
}

/// Remove um floor. `force` = `fingerprint` do `LossReport` confirmado pelo usuário.
#[tauri::command]
pub async fn floor_remove(
    app: AppHandle,
    id: String,
    force: Option<String>,
    keep_branch: Option<bool>,
) -> Result<RemoveResult, String> {
    let r = blocking(move || remove(&id, force.as_deref(), keep_branch.unwrap_or(false))).await;
    emit_changed(&app);
    r
}

#[tauri::command]
pub async fn floor_land_preview(id: String, into: Option<String>) -> Result<LandPreview, String> {
    blocking(move || land_preview(&id, into.as_deref())).await
}

#[tauri::command]
pub async fn floor_land(
    app: AppHandle,
    id: String,
    into: Option<String>,
    delete_branch: Option<bool>,
    keep_floor: Option<bool>,
) -> Result<LandResult, String> {
    let r = blocking(move || {
        land(
            &id,
            into.as_deref(),
            delete_branch.unwrap_or(false),
            keep_floor.unwrap_or(false),
        )
    })
    .await;
    emit_changed(&app);
    r
}

/// Define o status do floor. `state`: working|blocked|review|done.
#[tauri::command]
pub fn floor_set_status(
    app: AppHandle,
    id: String,
    state: Option<String>,
    text: Option<String>,
    clear: Option<bool>,
) -> Result<FloorView, String> {
    let (rec, notify) = set_status(
        &id,
        state.as_deref(),
        text.as_deref().unwrap_or(""),
        clear.unwrap_or(false),
    )?;
    if notify {
        notify_status(&app, &rec);
    }
    emit_changed(&app);
    Ok(view_of(&rec))
}

/// Env que um terminal com este cwd receberia (útil para depurar na UI).
#[tauri::command]
pub fn floor_env(cwd: String) -> Vec<(String, String)> {
    floor_env_for_cwd(&cwd)
}

// ============================================================================
// CLI: `colmeia floor ...` (o integrador liga isto a uma rota do orchestrator)
// ============================================================================

fn arg_str(args: &serde_json::Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|k| args.get(*k))
        .and_then(|v| match v {
            serde_json::Value::String(s) => Some(s.trim().to_string()),
            serde_json::Value::Number(n) => Some(n.to_string()),
            _ => None,
        })
        .filter(|s| !s.is_empty())
}

fn arg_bool(args: &serde_json::Value, keys: &[&str]) -> bool {
    keys.iter().any(|k| match args.get(*k) {
        Some(serde_json::Value::Bool(b)) => *b,
        Some(serde_json::Value::String(s)) => s == "true" || s == "1",
        _ => false,
    })
}

/// Acha um floor deste repositório por id, nome, slug ou branch.
fn find_floor(common: &Path, key: &str) -> Result<FloorRecord, String> {
    let recs = records_of(common);
    let k = key.trim();
    let slug = slugify(k);
    let found: Vec<&FloorRecord> = recs
        .iter()
        .filter(|r| r.id == k || r.name.eq_ignore_ascii_case(k) || r.slug == slug || r.branch == k)
        .collect();
    match found.len() {
        1 => Ok(found[0].clone()),
        0 => Err(format!(
            "Floor \"{k}\" não encontrado. Floors: {}",
            if recs.is_empty() {
                "(nenhum)".to_string()
            } else {
                recs.iter()
                    .map(|r| format!("\"{}\"", r.name))
                    .collect::<Vec<_>>()
                    .join(", ")
            }
        )),
        _ => Err(format!(
            "\"{k}\" é ambíguo: {}. Use o id.",
            found
                .iter()
                .map(|r| format!("{} ({})", r.name, r.id))
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

/// `colmeia floor list|create|land|delete|status`.
///
/// `args` (JSON): `{ "action": "...", ... }` — veja a documentação de cada ação no
/// relatório de integração. Devolve (status HTTP, texto para o agente).
#[allow(dead_code)] // ligado a uma rota do orchestrator pelo integrador
pub fn cli_floor(
    shared: &Arc<Shared>,
    app: &AppHandle,
    source: &str,
    args: &serde_json::Value,
) -> (u16, String) {
    let action = arg_str(args, &["action"]).unwrap_or_else(|| "list".into());
    let source_cwd = shared.node_cwd(source).unwrap_or_default();
    let source_floor = floor_for_cwd(&source_cwd);

    // Repositório: --repo explícito, senão a pasta do terminal que chamou.
    let repo_dir = arg_str(args, &["repo"]).unwrap_or_else(|| source_cwd.clone());
    if repo_dir.is_empty() {
        return (
            400,
            "Não sei qual repositório usar: rode de um terminal cuja pasta está num repositório git, ou passe --repo <pasta>.".into(),
        );
    }
    let ground = match ground_root(Path::new(&repo_dir)) {
        Ok(g) => g,
        Err(e) => return (400, e),
    };
    let common = match git::common_dir(&ground) {
        Ok(c) => c,
        Err(e) => return (400, e),
    };
    let target_name = arg_str(args, &["name", "floor", "id"]);

    match action.as_str() {
        "list" => match list(&ground) {
            Ok(views) => {
                let lines: Vec<String> = views
                    .iter()
                    .map(|v| {
                        let mut l = format!("- {} [{}]", v.name, v.branch);
                        if v.is_main {
                            l.push_str(" (ground)");
                        } else if !v.managed {
                            l.push_str(" (externo)");
                        } else if v.state != "ready" {
                            l.push_str(&format!(" ({})", v.state));
                        }
                        if let Some(p) = v.port_base {
                            l.push_str(&format!(" portas {}-{}", p, p + PORT_STRIDE - 1));
                        }
                        if v.dirty > 0 {
                            l.push_str(&format!(" · {} mudança(s) pendente(s)", v.dirty));
                        }
                        if let Some(s) = &v.status {
                            l.push_str(&format!(" · {}: {}", s.state, s.text));
                        }
                        l.push_str(&format!("\n    {}", v.path));
                        l
                    })
                    .collect();
                (
                    200,
                    format!("Floors de {}:\n{}", ground.display(), lines.join("\n")),
                )
            }
            Err(e) => (500, e),
        },
        "create" => {
            let Some(name) = target_name else {
                return (400, "Uso: colmeia floor create \"<nome>\" [--branch B] [--existing-branch] [--deps copy|link|skip]".into());
            };
            let mut progress = |_f: u64, _b: u64| {};
            match create(
                &ground,
                CreateOpts {
                    name,
                    branch: arg_str(args, &["branch"]),
                    existing_branch: arg_bool(args, &["existingBranch", "existing_branch"]),
                    deps: DepsMode::parse(&arg_str(args, &["deps"]).unwrap_or_default()),
                },
                &mut progress,
            ) {
                Ok((rec, report)) => {
                    emit_changed(app);
                    let pb = port_base(rec.index);
                    let mut msg = format!(
                        "Floor \"{}\" criado na branch {}.\n  pasta: {}\n  portas: {}-{} (COLMEIA_PORT_BASE={})\n  semeados: {} arquivo(s)",
                        rec.name, rec.branch, rec.path, pb, pb + PORT_STRIDE - 1, pb, report.files
                    );
                    if !report.linked.is_empty() {
                        msg.push_str(&format!(", links: {}", report.linked.join(", ")));
                    }
                    if report.truncated {
                        msg.push_str(" (cópia parcial: limite de tamanho)");
                    }
                    (200, msg)
                }
                Err(e) => (409, e),
            }
        }
        "status" => {
            let rec = match (&target_name, &source_floor) {
                (Some(n), _) => match find_floor(&common, n) {
                    Ok(r) => r,
                    Err(e) => return (404, e),
                },
                (None, Some(r)) => r.clone(),
                (None, None) => {
                    return (
                        400,
                        "Este terminal não está num floor. Use --floor \"<nome>\".".into(),
                    )
                }
            };
            // Agente num floor só posta no próprio floor.
            if let Some(own) = &source_floor {
                if own.id != rec.id {
                    return (
                        403,
                        format!(
                            "Você está no floor \"{}\"; só pode postar status nele.",
                            own.name
                        ),
                    );
                }
            }
            let text = arg_str(args, &["text"]).unwrap_or_default();
            let state = arg_str(args, &["state"]);
            let clear = arg_bool(args, &["clear"]);
            if text.is_empty() && state.is_none() && !clear {
                return match &rec.status {
                    Some(s) => (200, format!("{} — {}: {}", rec.name, s.state, s.text)),
                    None => (200, format!("{} — sem status.", rec.name)),
                };
            }
            match set_status(&rec.id, state.as_deref(), &text, clear) {
                Ok((rec, notify)) => {
                    if notify {
                        notify_status(app, &rec);
                    }
                    emit_changed(app);
                    match &rec.status {
                        Some(s) => (
                            200,
                            format!("Status de \"{}\": {} — {}", rec.name, s.state, s.text),
                        ),
                        None => (200, format!("Status de \"{}\" limpo.", rec.name)),
                    }
                }
                Err(e) => (400, e),
            }
        }
        "land" | "delete" => {
            if let Some(own) = &source_floor {
                return (
                    403,
                    format!(
                        "Rode isto de um terminal no Ground (você está no floor \"{}\").",
                        own.name
                    ),
                );
            }
            let Some(name) = target_name else {
                return (400, format!("Uso: colmeia floor {action} \"<nome>\""));
            };
            let rec = match find_floor(&common, &name) {
                Ok(r) => r,
                Err(e) => return (404, e),
            };
            if action == "land" {
                let into = arg_str(args, &["into"]);
                match land(
                    &rec.id,
                    into.as_deref(),
                    arg_bool(args, &["deleteBranch", "delete_branch"]),
                    arg_bool(args, &["keepFloor", "keep_floor"]),
                ) {
                    Ok(r) => {
                        emit_changed(app);
                        if r.landed {
                            (200, r.message)
                        } else {
                            let mut msg = r.message.clone();
                            for b in &r.blockers {
                                msg.push_str(&format!("\n  - {b}"));
                            }
                            if !r.conflicts.is_empty() {
                                msg.push_str("\n  Conflitos:");
                                for c in &r.conflicts {
                                    msg.push_str(&format!("\n    {c}"));
                                }
                            }
                            (409, msg)
                        }
                    }
                    Err(e) => (500, e),
                }
            } else {
                let force = arg_str(args, &["force"]);
                let keep_branch = arg_bool(args, &["keepBranch", "keep_branch"]);
                match remove(&rec.id, force.as_deref(), keep_branch) {
                    Ok(r) if r.removed => {
                        emit_changed(app);
                        (200, r.message)
                    }
                    Ok(r) => {
                        let mut msg = r.message.clone();
                        if let Some(l) = &r.loss {
                            if let Some(op) = &l.operation {
                                msg.push_str(&format!("\n  Operação git em andamento: {op}"));
                            }
                            if !l.dirty.is_empty() {
                                msg.push_str("\n  Mudanças não commitadas:");
                                for d in l.dirty.iter().take(30) {
                                    msg.push_str(&format!("\n    {d}"));
                                }
                            }
                            if l.branch_will_be_deleted && l.unique_commit_count > 0 {
                                msg.push_str(&format!(
                                    "\n  {} commit(s) só existem em {} e seriam perdidos:",
                                    l.unique_commit_count, l.branch
                                ));
                                for c in &l.unique_commits {
                                    msg.push_str(&format!(
                                        "\n    {} {}",
                                        &c.oid[..c.oid.len().min(8)],
                                        c.subject
                                    ));
                                }
                                msg.push_str("\n  (use --keep-branch para manter a branch)");
                            }
                            msg.push_str(&format!(
                                "\n  Só com pedido explícito do usuário: colmeia floor delete \"{}\" --force {}",
                                rec.name, l.fingerprint
                            ));
                        }
                        (409, msg)
                    }
                    Err(e) => (409, e),
                }
            }
        }
        other => (
            400,
            format!("Ação de floor inválida '{other}' (list|create|land|delete|status)."),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_names() {
        assert_eq!(slugify("Refactor Auth"), "refactor-auth");
        assert_eq!(slugify("  Ação  rápida!! "), "acao-rapida");
        assert_eq!(slugify("---"), "");
        assert_eq!(slugify("a/b\\c"), "a-b-c");
    }

    #[test]
    fn truncates_status() {
        let long = "x".repeat(200);
        assert_eq!(truncate_chars(&long, 120).chars().count(), 120);
        assert_eq!(truncate_chars(" curto ", 120), "curto");
    }

    #[test]
    fn port_ranges_dont_overlap() {
        assert_eq!(port_base(1), 41100);
        assert_eq!(port_base(2) - port_base(1), PORT_STRIDE);
    }
}
