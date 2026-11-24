// Registro de posse dos floors: `app_data_dir/floors/registry.json`.
// Cada floor é gravado aqui ANTES de qualquer comando git (estado `pending`),
// o que permite desfazer falhas e provar, na hora de apagar, que foi o colmeia
// que criou aquele worktree/branch.

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum FloorState {
    /// Reservado; o git ainda está criando/semeando.
    Pending,
    /// Pronto para uso.
    Ready,
    /// Remoção em andamento.
    Deleting,
    /// Algo falhou no meio do caminho; precisa de limpeza manual/forçada.
    Orphaned,
}

/// Linha de status do floor (o que o agente/humano vê no painel).
#[derive(Serialize, Deserialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FloorStatus {
    /// working | blocked | review | done
    pub state: String,
    pub text: String,
    pub updated_at: i64,
}

/// Arquivo não rastreado copiado do ground (ex.: `.env.local`) + hash do conteúdo,
/// para não contá-lo como "mudança pendente" enquanto continuar igual.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SeededFile {
    pub path: String,
    pub hash: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FloorRecord {
    pub id: String,
    pub name: String,
    pub slug: String,
    /// Raiz do ground (working tree principal).
    pub repo_root: String,
    /// `--git-common-dir` absoluto, para provar que é o mesmo repositório.
    pub common_dir: String,
    /// Pasta do worktree do floor.
    pub path: String,
    pub branch: String,
    /// A branch foi criada pelo colmeia? (só então pode ser apagada por ele)
    pub branch_created: bool,
    #[serde(default)]
    pub base_oid: String,
    pub created_at: i64,
    pub state: FloorState,
    /// Índice do floor (1, 2, ...) — define a faixa de portas.
    #[serde(default)]
    pub index: u32,
    /// Adotado do formato antigo (`<repo>-floor-<nome>`, branch `colmeia/<nome>`).
    #[serde(default)]
    pub legacy: bool,
    #[serde(default)]
    pub status: Option<FloorStatus>,
    /// Links (junction/symlink) criados no seeding, relativos ao floor.
    #[serde(default)]
    pub linked: Vec<String>,
    #[serde(default)]
    pub seeded_untracked: Vec<SeededFile>,
    #[serde(default)]
    pub deps_mode: String,
    /// Último erro relevante (ex.: motivo de ter virado `orphaned`).
    #[serde(default)]
    pub note: String,
}

#[derive(Serialize, Deserialize, Default)]
struct RegistryFile {
    version: u32,
    floors: Vec<FloorRecord>,
}

static DATA_DIR: OnceLock<PathBuf> = OnceLock::new();
static LOCK: Mutex<()> = Mutex::new(());

/// Define onde o registro vive (chamado no `setup()` com o `app_data_dir`).
pub fn init_dir(dir: PathBuf) {
    let _ = DATA_DIR.set(dir);
}

fn registry_path() -> Result<PathBuf, String> {
    let base = DATA_DIR
        .get()
        .cloned()
        .ok_or_else(|| "registro de floors não inicializado".to_string())?;
    let dir = base.join("floors");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir falhou: {e}"))?;
    Ok(dir.join("registry.json"))
}

fn read_file() -> Result<Vec<FloorRecord>, String> {
    let path = registry_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| format!("read falhou: {e}"))?;
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    let file: RegistryFile =
        serde_json::from_str(&text).map_err(|e| format!("registry.json inválido: {e}"))?;
    Ok(file.floors)
}

fn write_file(floors: &[FloorRecord]) -> Result<(), String> {
    let path = registry_path()?;
    let file = RegistryFile {
        version: 1,
        floors: floors.to_vec(),
    };
    let text = serde_json::to_string_pretty(&file).map_err(|e| format!("serialize: {e}"))?;
    // Escrita atômica: arquivo temporário + rename.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("write falhou: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename falhou: {e}"))?;
    Ok(())
}

/// Lê todos os registros.
pub fn all() -> Vec<FloorRecord> {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    read_file().unwrap_or_default()
}

/// Aplica `f` ao registro inteiro e grava (sob lock).
pub fn mutate<R>(f: impl FnOnce(&mut Vec<FloorRecord>) -> R) -> Result<R, String> {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut floors = read_file()?;
    let r = f(&mut floors);
    write_file(&floors)?;
    Ok(r)
}

/// Insere ou substitui pelo id.
pub fn upsert(rec: &FloorRecord) -> Result<(), String> {
    mutate(|floors| {
        if let Some(slot) = floors.iter_mut().find(|f| f.id == rec.id) {
            *slot = rec.clone();
        } else {
            floors.push(rec.clone());
        }
    })
}

pub fn remove(id: &str) -> Result<(), String> {
    mutate(|floors| floors.retain(|f| f.id != id))
}

pub fn get(id: &str) -> Option<FloorRecord> {
    all().into_iter().find(|f| f.id == id)
}

/// Menor índice livre (>= 1) entre os floors registrados.
pub fn free_index(floors: &[FloorRecord]) -> u32 {
    let mut i = 1;
    while floors.iter().any(|f| f.index == i) {
        i += 1;
    }
    i
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Id curto e único o bastante (tempo + aleatório).
pub fn gen_id() -> String {
    use rand::distributions::Alphanumeric;
    use rand::Rng;
    let rnd: String = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(4)
        .map(char::from)
        .collect();
    format!("f{:x}{}", now_ms(), rnd.to_lowercase())
}
