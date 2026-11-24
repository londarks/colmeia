// Scrollback persistido dos terminais: o frontend serializa as últimas ~2000
// linhas de cada xterm (addon-serialize) e grava aqui, em
// `app_data_dir/scrollback/<canvas>/<node>.txt`. Ao reabrir o app, o texto é
// reescrito no terminal antes de subir o processo novo.

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Teto de segurança por arquivo (o frontend já corta em ~2000 linhas).
const MAX_BYTES: usize = 4 * 1024 * 1024;

/// Aceita só ids "seguros" para virar nome de arquivo/pasta (sem `..`, `/`, `\`).
fn safe_segment(s: &str) -> Result<&str, String> {
    let ok = !s.is_empty()
        && s.len() <= 128
        && s
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        && !s.starts_with('.');
    if ok {
        Ok(s)
    } else {
        Err(format!("id inválido: '{s}'"))
    }
}

fn root_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("sem diretório de dados: {e}"))?
        .join("scrollback");
    Ok(dir)
}

fn canvas_dir(app: &AppHandle, canvas: &str) -> Result<PathBuf, String> {
    Ok(root_dir(app)?.join(safe_segment(canvas)?))
}

fn node_path(app: &AppHandle, canvas: &str, node: &str) -> Result<PathBuf, String> {
    Ok(canvas_dir(app, canvas)?.join(format!("{}.txt", safe_segment(node)?)))
}

/// Grava (substitui) o scrollback de um nó.
#[tauri::command]
pub fn scrollback_save(
    app: AppHandle,
    canvas: String,
    node: String,
    text: String,
) -> Result<(), String> {
    let path = node_path(&app, &canvas, &node)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("mkdir falhou: {e}"))?;
    }
    // Se passar do teto, mantém só o final (o mais recente), num limite de char.
    let text = if text.len() > MAX_BYTES {
        let mut cut = text.len() - MAX_BYTES;
        while !text.is_char_boundary(cut) {
            cut += 1;
        }
        &text[cut..]
    } else {
        &text[..]
    };
    // Escreve num temporário e renomeia: não deixa arquivo pela metade se cair.
    let tmp = path.with_extension("txt.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("write falhou: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename falhou: {e}"))?;
    Ok(())
}

/// Lê o scrollback de um nó (`None` se não existir).
#[tauri::command]
pub fn scrollback_load(
    app: AppHandle,
    canvas: String,
    node: String,
) -> Result<Option<String>, String> {
    let path = node_path(&app, &canvas, &node)?;
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read falhou: {e}")),
    }
}

/// Apaga o scrollback de um nó ou, sem `node`, a pasta inteira do canvas.
#[tauri::command]
pub fn scrollback_delete(
    app: AppHandle,
    canvas: String,
    node: Option<String>,
) -> Result<(), String> {
    match node {
        Some(node) => {
            let path = node_path(&app, &canvas, &node)?;
            match std::fs::remove_file(&path) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(format!("remove falhou: {e}")),
            }
        }
        None => {
            let dir = canvas_dir(&app, &canvas)?;
            match std::fs::remove_dir_all(&dir) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(format!("remove falhou: {e}")),
            }
        }
    }
}
