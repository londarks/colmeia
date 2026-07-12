// Persistência multi-canvas: cada canvas (nós + arestas + desenho) é um JSON
// próprio em `app_data_dir/workspaces/<id>.json`, e um `index.json` guarda a
// lista de canvases + qual está ativo. Migra o `workspace.json` antigo.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Clone)]
pub struct WorkspaceMeta {
    pub id: String,
    pub name: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct WorkspaceIndex {
    pub active: String,
    pub items: Vec<WorkspaceMeta>,
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("sem diretório de dados: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir falhou: {e}"))?;
    Ok(dir)
}

fn workspaces_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = data_dir(app)?.join("workspaces");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir falhou: {e}"))?;
    Ok(dir)
}

fn canvas_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    Ok(workspaces_dir(app)?.join(format!("{id}.json")))
}

fn index_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(workspaces_dir(app)?.join("index.json"))
}

/// Id curto baseado no tempo (evita puxar uma dependência de uuid).
fn gen_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("c{nanos:x}")
}

fn empty_canvas() -> serde_json::Value {
    serde_json::json!({ "nodes": [], "edges": [], "strokes": [] })
}

fn write_index(app: &AppHandle, index: &WorkspaceIndex) -> Result<(), String> {
    let text =
        serde_json::to_string_pretty(index).map_err(|e| format!("serialize falhou: {e}"))?;
    std::fs::write(index_path(app)?, text).map_err(|e| format!("write falhou: {e}"))?;
    Ok(())
}

/// Lê o índice, criando-o (com migração do formato antigo) se necessário.
fn read_index(app: &AppHandle) -> Result<WorkspaceIndex, String> {
    let path = index_path(app)?;
    if path.exists() {
        let text = std::fs::read_to_string(&path).map_err(|e| format!("read falhou: {e}"))?;
        let mut index: WorkspaceIndex =
            serde_json::from_str(&text).map_err(|e| format!("parse falhou: {e}"))?;
        if index.items.is_empty() {
            index = bootstrap(app)?;
        } else if !index.items.iter().any(|m| m.id == index.active) {
            index.active = index.items[0].id.clone();
            write_index(app, &index)?;
        }
        return Ok(index);
    }
    bootstrap(app)
}

/// Cria o índice inicial: migra `workspace.json` legado para "Canvas 1",
/// ou começa com um canvas vazio.
fn bootstrap(app: &AppHandle) -> Result<WorkspaceIndex, String> {
    let id = gen_id();
    let legacy = data_dir(app)?.join("workspace.json");
    let data = if legacy.exists() {
        std::fs::read_to_string(&legacy)
            .ok()
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
            .unwrap_or_else(empty_canvas)
    } else {
        empty_canvas()
    };
    let text =
        serde_json::to_string_pretty(&data).map_err(|e| format!("serialize falhou: {e}"))?;
    std::fs::write(canvas_path(app, &id)?, text).map_err(|e| format!("write falhou: {e}"))?;

    // Renomeia o arquivo legado para não migrar de novo.
    if legacy.exists() {
        let _ = std::fs::rename(&legacy, legacy.with_extension("json.bak"));
    }

    let index = WorkspaceIndex {
        active: id.clone(),
        items: vec![WorkspaceMeta {
            id,
            name: "Canvas 1".into(),
        }],
    };
    write_index(app, &index)?;
    Ok(index)
}

/// Lista os canvases + qual está ativo.
#[tauri::command]
pub fn workspaces_list(app: AppHandle) -> Result<WorkspaceIndex, String> {
    read_index(&app)
}

/// Salva os dados de um canvas específico.
#[tauri::command]
pub fn workspace_save(app: AppHandle, id: String, data: serde_json::Value) -> Result<(), String> {
    let text =
        serde_json::to_string_pretty(&data).map_err(|e| format!("serialize falhou: {e}"))?;
    std::fs::write(canvas_path(&app, &id)?, text).map_err(|e| format!("write falhou: {e}"))?;
    Ok(())
}

/// Carrega os dados de um canvas (vazio se ainda não existe o arquivo).
#[tauri::command]
pub fn workspace_load(app: AppHandle, id: String) -> Result<serde_json::Value, String> {
    let path = canvas_path(&app, &id)?;
    if !path.exists() {
        return Ok(empty_canvas());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| format!("read falhou: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("parse falhou: {e}"))
}

/// Cria um novo canvas vazio e o torna ativo. Retorna o índice atualizado.
#[tauri::command]
pub fn workspace_create(app: AppHandle, name: String) -> Result<WorkspaceIndex, String> {
    let mut index = read_index(&app)?;
    let id = gen_id();
    let name = if name.trim().is_empty() {
        format!("Canvas {}", index.items.len() + 1)
    } else {
        name.trim().to_string()
    };
    let text = serde_json::to_string_pretty(&empty_canvas())
        .map_err(|e| format!("serialize falhou: {e}"))?;
    std::fs::write(canvas_path(&app, &id)?, text).map_err(|e| format!("write falhou: {e}"))?;
    index.items.push(WorkspaceMeta {
        id: id.clone(),
        name,
    });
    index.active = id;
    write_index(&app, &index)?;
    Ok(index)
}

/// Renomeia um canvas.
#[tauri::command]
pub fn workspace_rename(
    app: AppHandle,
    id: String,
    name: String,
) -> Result<WorkspaceIndex, String> {
    let mut index = read_index(&app)?;
    if let Some(item) = index.items.iter_mut().find(|m| m.id == id) {
        let trimmed = name.trim();
        if !trimmed.is_empty() {
            item.name = trimmed.to_string();
        }
    }
    write_index(&app, &index)?;
    Ok(index)
}

/// Exclui um canvas (mantém sempre ao menos um).
#[tauri::command]
pub fn workspace_delete(app: AppHandle, id: String) -> Result<WorkspaceIndex, String> {
    let mut index = read_index(&app)?;
    if index.items.len() <= 1 {
        return Ok(index); // não deixa ficar sem nenhum
    }
    index.items.retain(|m| m.id != id);
    let _ = std::fs::remove_file(canvas_path(&app, &id)?);
    if index.active == id {
        index.active = index.items[0].id.clone();
    }
    write_index(&app, &index)?;
    Ok(index)
}

/// Marca qual canvas está ativo (persistido para reabrir no mesmo).
#[tauri::command]
pub fn workspace_set_active(app: AppHandle, id: String) -> Result<(), String> {
    let mut index = read_index(&app)?;
    if index.items.iter().any(|m| m.id == id) {
        index.active = id;
        write_index(&app, &index)?;
    }
    Ok(())
}
