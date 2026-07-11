// Persistência do canvas: salva/carrega o workspace (nós + arestas) em JSON,
// no diretório de dados do app.

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

fn workspace_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("sem diretório de dados: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir falhou: {e}"))?;
    Ok(dir.join("workspace.json"))
}

/// Salva o workspace (JSON arbitrário vindo do frontend).
#[tauri::command]
pub fn workspace_save(app: AppHandle, data: serde_json::Value) -> Result<(), String> {
    let path = workspace_path(&app)?;
    let text =
        serde_json::to_string_pretty(&data).map_err(|e| format!("serialize falhou: {e}"))?;
    std::fs::write(&path, text).map_err(|e| format!("write falhou: {e}"))?;
    Ok(())
}

/// Carrega o workspace salvo, ou `null` se não existir.
#[tauri::command]
pub fn workspace_load(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    let path = workspace_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&path).map_err(|e| format!("read falhou: {e}"))?;
    let value = serde_json::from_str(&text).map_err(|e| format!("parse falhou: {e}"))?;
    Ok(Some(value))
}
