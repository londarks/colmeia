// Persistência do canvas: salva/carrega workspaces (nós + arestas) em JSON.
// Cada workspace é um arquivo em
// `/home/{user}/.local/share/com.athus.colmeia/workspaces/<nome>.json`
// o nome do workspace ativo fica em
// `/home/{user}/.local/share/com.athus.colmeia/current_workspace`

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("sem diretório de dados: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir falhou: {e}"))?;
    Ok(dir)
}

fn ws_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = data_dir(app)?.join("workspaces");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir falhou: {e}"))?;
    Ok(dir)
}

/// Valida o nome do arquivo do workspace
fn validate_name(name: &str) -> Result<(), String> {
    let ok = !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | ' '));
    if ok {
        Ok(())
    } else {
        Err(format!("nome de workspace inválido: {name:?}"))
    }
}

fn current_name(app: &AppHandle) -> Result<String, String> {
    let path = data_dir(app)?.join("current_workspace");
    let name = std::fs::read_to_string(&path).unwrap_or_default();
    let name = name.trim().to_string();
    if name.is_empty() || validate_name(&name).is_err() {
        Ok("default".into())
    } else {
        Ok(name)
    }
}

fn workspace_path(app: &AppHandle) -> Result<PathBuf, String> {
    let name = current_name(app)?;
    let path = ws_dir(app)?.join(format!("{name}.json"));
    // Migração: workspace.json antigo (raiz) vira workspaces/default.json.
    if name == "default" && !path.exists() {
        let legacy = data_dir(app)?.join("workspace.json");
        if legacy.exists() {
            let _ = std::fs::rename(&legacy, &path);
        }
    }
    Ok(path)
}

/// Salva o workspace ativo (JSON arbitrário vindo do frontend).
#[tauri::command]
pub fn workspace_save(app: AppHandle, data: serde_json::Value) -> Result<(), String> {
    let path = workspace_path(&app)?;
    let text =
        serde_json::to_string_pretty(&data).map_err(|e| format!("serialize falhou: {e}"))?;
    std::fs::write(&path, text).map_err(|e| format!("write falhou: {e}"))?;
    Ok(())
}

/// Carrega o workspace ativo, ou `null` se não existir.
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

/// Lista os workspaces existentes + o ativo.
#[tauri::command]
pub fn workspace_list(app: AppHandle) -> Result<serde_json::Value, String> {
    let current = current_name(&app)?;
    let mut names: Vec<String> = std::fs::read_dir(ws_dir(&app)?)
        .map_err(|e| format!("read_dir falhou: {e}"))?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            e.file_name()
                .to_string_lossy()
                .strip_suffix(".json")
                .map(str::to_string)
        })
        .collect();
    if !names.contains(&current) {
        names.push(current.clone());
    }
    names.sort();
    Ok(serde_json::json!({ "current": current, "names": names }))
}

/// Troca (ou cria) o workspace ativo. O arquivo nasce no primeiro save.
#[tauri::command]
pub fn workspace_switch(app: AppHandle, name: String) -> Result<(), String> {
    let name = name.trim();
    validate_name(name)?;
    // Escreve em current_workspace o nome do workspace ativo
    let path = data_dir(&app)?.join("current_workspace");
    std::fs::write(&path, name).map_err(|e| format!("write falhou: {e}"))?;
    Ok(())
}

/// Renomeia um workspace (arquivo + ponteiro ativo, se for o caso).
#[tauri::command]
pub fn workspace_rename(app: AppHandle, old_name: String, new_name: String) -> Result<(), String> {
    let (old_name, new_name) = (old_name.trim(), new_name.trim());
    validate_name(old_name)?;
    validate_name(new_name)?;
    let dir = ws_dir(&app)?;
    let to = dir.join(format!("{new_name}.json"));
    if to.exists() {
        return Err(format!("já existe workspace {new_name:?}"));
    }
    let from = dir.join(format!("{old_name}.json"));
    if from.exists() {
        std::fs::rename(&from, &to).map_err(|e| format!("rename falhou: {e}"))?;
    }
    if current_name(&app)? == old_name {
        std::fs::write(data_dir(&app)?.join("current_workspace"), new_name)
            .map_err(|e| format!("write falhou: {e}"))?;
    }
    Ok(())
}

/// Remove um workspace. O frontend troca o ativo antes desta chamada.
#[tauri::command]
pub fn workspace_delete(app: AppHandle, name: String) -> Result<(), String> {
    let name = name.trim();
    validate_name(name)?;
    let path = ws_dir(&app)?.join(format!("{name}.json"));
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("remove falhou: {e}"))?;
    }
    Ok(())
}

/// Metadados da árvore de workspaces (pastas, cores) — JSON arbitrário do frontend.
#[tauri::command]
pub fn workspace_meta_save(app: AppHandle, data: serde_json::Value) -> Result<(), String> {
    let path = data_dir(&app)?.join("workspaces_meta.json");
    let text =
        serde_json::to_string_pretty(&data).map_err(|e| format!("serialize falhou: {e}"))?;
    std::fs::write(&path, text).map_err(|e| format!("write falhou: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn workspace_meta_load(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    let path = data_dir(&app)?.join("workspaces_meta.json");
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&path).map_err(|e| format!("read falhou: {e}"))?;
    let value = serde_json::from_str(&text).map_err(|e| format!("parse falhou: {e}"))?;
    Ok(Some(value))
}
