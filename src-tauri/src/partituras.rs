// Partituras (templates de equipe): cada partitura é um JSON próprio em
// `app_data_dir/partituras/<id>.json`. O backend só guarda/lê/exporta — a
// sanitização (whitelist de campos, sem cwd/comandos/caminhos) e a revisão de
// import acontecem no frontend antes de qualquer `partituras_save`.

use std::path::{Path, PathBuf};

use serde_json::Value;
use tauri::{AppHandle, Manager};

/// Tamanho máximo aceito para um arquivo de partitura importado.
const MAX_IMPORT_BYTES: u64 = 4 * 1024 * 1024;

fn partituras_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("sem diretório de dados: {e}"))?
        .join("partituras");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir falhou: {e}"))?;
    Ok(dir)
}

/// Id seguro para virar nome de arquivo (sem `..`, barras etc.).
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn id_of(p: &Value) -> Result<String, String> {
    let id = p
        .get("id")
        .and_then(Value::as_str)
        .ok_or("partitura sem id")?;
    if !valid_id(id) {
        return Err(format!("id de partitura inválido: {id}"));
    }
    Ok(id.to_string())
}

fn looks_like_partitura(p: &Value) -> bool {
    p.is_object() && p.get("nodes").map(Value::is_array).unwrap_or(false)
}

fn read_all(app: &AppHandle) -> Result<Vec<Value>, String> {
    let dir = partituras_dir(app)?;
    let mut out = Vec::new();
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("read_dir falhou: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        // Arquivo corrompido não derruba a lista inteira.
        if let Some(v) = std::fs::read_to_string(&path)
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        {
            if looks_like_partitura(&v) {
                out.push(v);
            }
        }
    }
    out.sort_by_key(|v| {
        v.get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_lowercase()
    });
    Ok(out)
}

/// Lista as partituras salvas pelo usuário (as embutidas vivem no frontend).
#[tauri::command]
pub fn partituras_list(app: AppHandle) -> Result<Vec<Value>, String> {
    read_all(&app)
}

/// Salva (cria ou substitui) uma partitura já sanitizada. Retorna a lista nova.
#[tauri::command]
pub fn partituras_save(app: AppHandle, partitura: Value) -> Result<Vec<Value>, String> {
    if !looks_like_partitura(&partitura) {
        return Err("formato de partitura inválido".into());
    }
    let id = id_of(&partitura)?;
    let text = serde_json::to_string_pretty(&partitura)
        .map_err(|e| format!("serialize falhou: {e}"))?;
    std::fs::write(partituras_dir(&app)?.join(format!("{id}.json")), text)
        .map_err(|e| format!("write falhou: {e}"))?;
    read_all(&app)
}

/// Exclui uma partitura salva. Retorna a lista nova.
#[tauri::command]
pub fn partituras_delete(app: AppHandle, id: String) -> Result<Vec<Value>, String> {
    if !valid_id(&id) {
        return Err(format!("id de partitura inválido: {id}"));
    }
    let path = partituras_dir(&app)?.join(format!("{id}.json"));
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("remove falhou: {e}"))?;
    }
    read_all(&app)
}

/// Exporta uma partitura para o caminho escolhido no diálogo de salvar.
#[tauri::command]
pub fn partituras_export(path: String, partitura: Value) -> Result<(), String> {
    if !looks_like_partitura(&partitura) {
        return Err("formato de partitura inválido".into());
    }
    let text = serde_json::to_string_pretty(&partitura)
        .map_err(|e| format!("serialize falhou: {e}"))?;
    std::fs::write(Path::new(&path), text).map_err(|e| format!("write falhou: {e}"))?;
    Ok(())
}

/// Lê um arquivo de partitura escolhido pelo usuário. NÃO salva: o frontend
/// sanitiza, mostra a revisão (agentes/comandos/papéis) e só então salva.
#[tauri::command]
pub fn partituras_import(path: String) -> Result<Value, String> {
    let p = Path::new(&path);
    let meta = std::fs::metadata(p).map_err(|e| format!("arquivo inacessível: {e}"))?;
    if !meta.is_file() {
        return Err("não é um arquivo".into());
    }
    if meta.len() > MAX_IMPORT_BYTES {
        return Err("arquivo grande demais para uma partitura".into());
    }
    let text = std::fs::read_to_string(p).map_err(|e| format!("read falhou: {e}"))?;
    let v: Value = serde_json::from_str(&text).map_err(|e| format!("JSON inválido: {e}"))?;
    if !looks_like_partitura(&v) {
        return Err("o arquivo não parece uma partitura do colmeia".into());
    }
    Ok(v)
}

// ---------------------------------------------------------------------------
// `colmeia partitura list|insert` — a CLI do orquestrador.
//
// As partituras (built-ins + salvas) vivem no frontend, que publica um catálogo
// resumido aqui (`partituras_set_catalog`). O `insert` pede ao frontend para
// inserir (evento `colmeia://partitura-insert`) e espera a resposta com os nomes
// reais dos agentes criados (`partitura_insert_done`), para devolver ao agente.

use std::collections::HashMap;
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::pty::Shared;

#[derive(Clone, Deserialize)]
pub struct CatalogAgent {
    pub title: String,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub agent: String,
}

#[derive(Clone, Deserialize)]
pub struct CatalogItem {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub agents: Vec<CatalogAgent>,
    #[serde(default)]
    pub builtin: bool,
}

#[derive(Clone, Serialize)]
struct InsertRequest {
    req: String,
    id: String,
    source: String,
}

fn catalog() -> &'static Mutex<Vec<CatalogItem>> {
    static C: OnceLock<Mutex<Vec<CatalogItem>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(Vec::new()))
}

fn pending() -> &'static Mutex<HashMap<String, Sender<(bool, String)>>> {
    static P: OnceLock<Mutex<HashMap<String, Sender<(bool, String)>>>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(HashMap::new()))
}

/// O frontend publica o catálogo sempre que a lista de partituras muda.
#[tauri::command]
pub fn partituras_set_catalog(items: Vec<CatalogItem>) {
    *catalog().lock().unwrap() = items;
}

/// Resposta do frontend a um `colmeia://partitura-insert`.
#[tauri::command]
pub fn partitura_insert_done(req: String, ok: bool, text: String) {
    if let Some(tx) = pending().lock().unwrap().remove(&req) {
        let _ = tx.send((ok, text));
    }
}

/// Mesmo critério do frontend: id, nome exato, prefixo, trecho (3+ letras).
fn find(list: &[CatalogItem], q: &str) -> Option<CatalogItem> {
    let ql = q.trim().to_lowercase();
    list.iter()
        .find(|p| p.id == q)
        .or_else(|| list.iter().find(|p| p.name.to_lowercase() == ql))
        .or_else(|| list.iter().find(|p| p.name.to_lowercase().starts_with(&ql)))
        .or_else(|| {
            (ql.chars().count() >= 3)
                .then(|| list.iter().find(|p| p.name.to_lowercase().contains(&ql)))
                .flatten()
        })
        .cloned()
}

fn describe(p: &CatalogItem) -> String {
    let team = p
        .agents
        .iter()
        .map(|a| {
            if a.role.is_empty() {
                a.title.clone()
            } else {
                format!("{} [{}]", a.title, a.role)
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    let desc = if p.description.is_empty() {
        String::new()
    } else {
        format!(" — {}", p.description)
    };
    format!("  - \"{}\"{desc}\n      time: {team}", p.name)
}

pub fn cli(shared: &Arc<Shared>, source: &str, v: &Value) -> (u16, String) {
    let action = v.get("action").and_then(Value::as_str).unwrap_or("list");
    let list = catalog().lock().unwrap().clone();
    match action {
        "list" => {
            if list.is_empty() {
                return (200, "Nenhuma partitura disponível (o canvas ainda não publicou o catálogo).".into());
            }
            let lines = list.iter().map(describe).collect::<Vec<_>>().join("\n");
            (
                200,
                format!(
                    "Partituras (times salvos pelo usuário):\n{lines}\n\nInsira com `colmeia partitura insert \"<nome>\"` — prefira isso a recrutar o mesmo time à mão."
                ),
            )
        }
        "insert" => {
            let q = v.get("name").and_then(Value::as_str).unwrap_or("").trim().to_string();
            if q.is_empty() {
                return (400, "Uso: colmeia partitura insert \"<nome>\"".into());
            }
            let Some(p) = find(&list, &q) else {
                let names = list
                    .iter()
                    .map(|p| format!("\"{}\"", p.name))
                    .collect::<Vec<_>>()
                    .join(", ");
                return (
                    404,
                    format!("Partitura \"{q}\" não encontrada. Disponíveis: {names}. Veja `colmeia partitura list`."),
                );
            };
            let req = format!(
                "pt-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            );
            let (tx, rx) = mpsc::channel();
            pending().lock().unwrap().insert(req.clone(), tx);
            shared.emit(
                "colmeia://partitura-insert",
                InsertRequest {
                    req: req.clone(),
                    id: p.id.clone(),
                    source: source.to_string(),
                },
            );
            match rx.recv_timeout(Duration::from_secs(15)) {
                Ok((true, text)) => (200, text),
                Ok((false, text)) => (409, text),
                Err(_) => {
                    pending().lock().unwrap().remove(&req);
                    (
                        200,
                        format!(
                            "aviso: pedi para inserir \"{}\", mas o canvas não confirmou a tempo. Rode `colmeia list` antes de repetir.",
                            p.name
                        ),
                    )
                }
            }
        }
        _ => (400, "Uso: colmeia partitura list | insert \"<nome>\"".into()),
    }
}
