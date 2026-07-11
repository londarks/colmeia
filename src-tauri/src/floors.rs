// Floors: clones isolados de um repositório via `git worktree`. Cada agente pode
// trabalhar no seu próprio floor (branch/worktree), evitando conflito em paralelo.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

#[derive(Serialize, Clone)]
pub struct FloorInfo {
    pub branch: String,
    pub path: String,
    #[serde(rename = "isMain")]
    pub is_main: bool,
}

/// Roda `git -C <repo> <args>`, devolvendo stdout ou o stderr como erro.
fn git(repo: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .map_err(|e| format!("git não encontrado/falhou: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Lista os worktrees (floors) de um repositório. O primeiro é o principal.
#[tauri::command]
pub fn floor_list(repo: String) -> Result<Vec<FloorInfo>, String> {
    let out = git(&repo, &["worktree", "list", "--porcelain"])?;
    let mut floors: Vec<FloorInfo> = Vec::new();
    let mut path = String::new();
    let mut branch = String::new();

    let flush = |floors: &mut Vec<FloorInfo>, path: &mut String, branch: &mut String| {
        if !path.is_empty() {
            let is_main = floors.is_empty();
            floors.push(FloorInfo {
                branch: std::mem::take(branch),
                path: std::mem::take(path),
                is_main,
            });
        }
    };

    for line in out.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            flush(&mut floors, &mut path, &mut branch);
            path = p.to_string();
        } else if let Some(b) = line.strip_prefix("branch ") {
            branch = b.trim_start_matches("refs/heads/").to_string();
        }
    }
    flush(&mut floors, &mut path, &mut branch);
    Ok(floors)
}

/// Cria um floor: um novo worktree em `colmeia/<name>`, ao lado do repo.
#[tauri::command]
pub fn floor_create(repo: String, name: String) -> Result<FloorInfo, String> {
    let repo_path = Path::new(&repo);
    let parent = repo_path
        .parent()
        .ok_or_else(|| "repositório sem pasta pai".to_string())?;
    let base = repo_path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "repo".to_string());
    let safe: String = name
        .trim()
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    if safe.is_empty() {
        return Err("nome do floor inválido".into());
    }
    let wt: PathBuf = parent.join(format!("{base}-floor-{safe}"));
    let wt_str = wt.to_string_lossy().to_string();
    let branch = format!("colmeia/{safe}");

    // Tenta criar um novo branch; se já existir, usa o branch existente.
    if let Err(e) = git(&repo, &["worktree", "add", &wt_str, "-b", &branch]) {
        git(&repo, &["worktree", "add", &wt_str, &branch]).map_err(|_| e)?;
    }
    Ok(FloorInfo {
        branch,
        path: wt_str,
        is_main: false,
    })
}

/// Remove um floor (worktree). O branch é mantido para não perder o trabalho.
#[tauri::command]
pub fn floor_remove(repo: String, path: String) -> Result<Vec<FloorInfo>, String> {
    git(&repo, &["worktree", "remove", "--force", &path])?;
    floor_list(repo)
}
