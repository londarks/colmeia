// Leitura de arquivos soltos no canvas (drag-drop nativo do Tauri entrega só
// os caminhos). Só aceita tipos que o canvas sabe mostrar e com limite de
// tamanho: imagem → data URL; .md/.txt/.json → texto.

use std::path::Path;

use base64::Engine;
use serde::Serialize;

const MAX_IMAGE_BYTES: u64 = 15 * 1024 * 1024;
const MAX_TEXT_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DroppedFile {
    /// "image" | "text" | "json"
    pub kind: String,
    /// Nome do arquivo (sem a pasta).
    pub name: String,
    pub text: Option<String>,
    pub data_url: Option<String>,
}

fn image_mime(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        _ => return None,
    })
}

#[tauri::command]
pub fn dropped_file_read(path: String) -> Result<DroppedFile, String> {
    let p = Path::new(&path);
    let meta = std::fs::metadata(p).map_err(|e| format!("arquivo inacessível: {e}"))?;
    if !meta.is_file() {
        return Err("não é um arquivo".into());
    }
    let name = p
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("arquivo")
        .to_string();
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    if let Some(mime) = image_mime(&ext) {
        if meta.len() > MAX_IMAGE_BYTES {
            return Err("imagem grande demais".into());
        }
        let bytes = std::fs::read(p).map_err(|e| format!("read falhou: {e}"))?;
        let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
        return Ok(DroppedFile {
            kind: "image".into(),
            name,
            text: None,
            data_url: Some(format!("data:{mime};base64,{b64}")),
        });
    }

    let kind = match ext.as_str() {
        "md" | "markdown" | "txt" => "text",
        "json" => "json",
        _ => return Err(format!("tipo de arquivo não suportado: .{ext}")),
    };
    if meta.len() > MAX_TEXT_BYTES {
        return Err("arquivo de texto grande demais".into());
    }
    let text = std::fs::read_to_string(p).map_err(|e| format!("read falhou: {e}"))?;
    Ok(DroppedFile {
        kind: kind.into(),
        name,
        text: Some(text),
        data_url: None,
    })
}
