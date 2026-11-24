// "Seeding": deixa o floor pronto para trabalhar copiando do ground o que o git
// não versiona mas o projeto precisa (`.env*`, `node_modules`, configs locais),
// sem levar saídas de build. Também contém a limpeza segura de links antes de
// apagar um floor.
//
// ATENÇÃO (Windows): `git worktree remove --force` SEGUE junctions e apaga o
// conteúdo do alvo (testado com git 2.45). Por isso todo link criado aqui é
// registrado e `unlink_all` é chamado antes de qualquer remoção.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use super::git;
use super::registry::SeededFile;

/// Pastas de saída de build / caches: nunca copiadas.
pub const BUILD_DIRS: &[&str] = &[
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".turbo",
    ".parcel-cache",
    ".cache",
    "target",
    "obj",
    "bin",
    ".gradle",
    ".build",
    "DerivedData",
    "__pycache__",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".dart_tool",
    "coverage",
    ".nyc_output",
    "artifacts",
    ".colmeia-floors",
    ".git",
];

/// Pastas de dependências: tratadas conforme o `DepsMode`.
pub const DEPS_DIRS: &[&str] = &["node_modules", ".venv", "venv"];

/// Teto de bytes copiados (fora dependências linkadas), para não travar em pastas gigantes.
const MAX_COPY_BYTES: u64 = 8 * 1024 * 1024 * 1024;

/// Como levar as pastas de dependências para o floor.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DepsMode {
    /// Cópia real (isolada; mais lenta em NTFS). Padrão.
    Copy,
    /// Junction (Windows) / symlink (Unix): instantâneo, mas COMPARTILHADO com o ground.
    Link,
    /// Não leva; o agente roda `bun install`/`npm i` no floor.
    Skip,
}

impl DepsMode {
    pub fn parse(s: &str) -> DepsMode {
        match s.trim().to_ascii_lowercase().as_str() {
            "link" | "junction" | "symlink" => DepsMode::Link,
            "skip" | "none" | "skip-deps" => DepsMode::Skip,
            _ => DepsMode::Copy,
        }
    }
    pub fn as_str(&self) -> &'static str {
        match self {
            DepsMode::Copy => "copy",
            DepsMode::Link => "link",
            DepsMode::Skip => "skip",
        }
    }
}

#[derive(Default, Debug)]
pub struct SeedReport {
    pub files: u64,
    pub bytes: u64,
    pub linked: Vec<String>,
    pub seeded_untracked: Vec<SeededFile>,
    /// Entradas puladas (build, repositório aninhado, links internos...).
    pub skipped: Vec<String>,
    pub truncated: bool,
    pub errors: Vec<String>,
}

fn is_build_dir(name: &str) -> bool {
    BUILD_DIRS.iter().any(|b| b.eq_ignore_ascii_case(name))
}
fn is_deps_dir(name: &str) -> bool {
    DEPS_DIRS.iter().any(|b| b.eq_ignore_ascii_case(name))
}

/// Arquivo não rastreado (não ignorado) que vale levar: `.env`, `.env.local`...
fn is_useful_untracked(rel: &str) -> bool {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    name == ".env" || name.starts_with(".env.")
}

/// Hash FNV-1a 64 do conteúdo (suficiente para "mudou ou não").
pub fn file_hash(path: &Path) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    let mut h: u64 = 0xcbf29ce484222325;
    for b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    Some(format!("{h:016x}"))
}

/// O caminho é um symlink ou junction (sem seguir)?
pub fn is_link(p: &Path) -> bool {
    fs::symlink_metadata(p)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
}

/// Remove o LINK em si (nunca o alvo).
pub fn remove_link(p: &Path) -> std::io::Result<()> {
    // Junction/symlink de diretório no Windows sai com remove_dir; no Unix, remove_file.
    fs::remove_dir(p).or_else(|_| fs::remove_file(p))
}

/// Cria um link de diretório `dst` -> `src`.
#[cfg(windows)]
fn make_dir_link(src: &Path, dst: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    // Junction não exige admin nem modo desenvolvedor (symlink exige).
    let src_s = src.to_string_lossy().replace('/', "\\");
    let dst_s = dst.to_string_lossy().replace('/', "\\");
    let out = std::process::Command::new("cmd")
        .raw_arg(format!("/D /C mklink /J \"{dst_s}\" \"{src_s}\""))
        .creation_flags(0x0800_0000)
        .output()
        .map_err(|e| format!("mklink falhou: {e}"))?;
    if out.status.success() && is_link(dst) {
        Ok(())
    } else {
        Err(format!(
            "mklink /J falhou: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
}

#[cfg(unix)]
fn make_dir_link(src: &Path, dst: &Path) -> Result<(), String> {
    std::os::unix::fs::symlink(src, dst).map_err(|e| format!("symlink falhou: {e}"))
}

#[cfg(not(any(windows, unix)))]
fn make_dir_link(_src: &Path, _dst: &Path) -> Result<(), String> {
    Err("links não suportados nesta plataforma".into())
}

struct Copier<'a, 'p> {
    report: &'a mut SeedReport,
    progress: &'a mut (dyn FnMut(u64, u64) + 'p),
    last_reported: u64,
}

impl Copier<'_, '_> {
    fn tick(&mut self) {
        if self.report.files - self.last_reported >= 200 {
            self.last_reported = self.report.files;
            (self.progress)(self.report.files, self.report.bytes);
        }
    }

    fn copy_file(&mut self, src: &Path, dst: &Path) {
        if dst.exists() {
            return;
        }
        if self.report.bytes >= MAX_COPY_BYTES {
            self.report.truncated = true;
            return;
        }
        if let Some(parent) = dst.parent() {
            let _ = fs::create_dir_all(parent);
        }
        match fs::copy(src, dst) {
            Ok(n) => {
                self.report.files += 1;
                self.report.bytes += n;
                self.tick();
            }
            Err(e) => {
                if self.report.errors.len() < 20 {
                    self.report.errors.push(format!("{}: {e}", src.display()));
                }
            }
        }
    }

    /// Copia uma árvore sem seguir links. `filter_build` pula pastas de build
    /// (desligado dentro de `node_modules`, onde `dist/`/`bin/` são conteúdo do pacote).
    fn copy_tree(&mut self, src: &Path, dst: &Path, filter_build: bool, rel: &str) {
        let mut stack: Vec<(PathBuf, PathBuf, String)> =
            vec![(src.to_path_buf(), dst.to_path_buf(), rel.to_string())];
        while let Some((s, d, r)) = stack.pop() {
            if self.report.truncated {
                return;
            }
            let entries = match fs::read_dir(&s) {
                Ok(e) => e,
                Err(e) => {
                    if self.report.errors.len() < 20 {
                        self.report.errors.push(format!("{}: {e}", s.display()));
                    }
                    continue;
                }
            };
            let _ = fs::create_dir_all(&d);
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                let sp = entry.path();
                let dp = d.join(&name);
                let child_rel = format!("{r}/{name}");
                let ft = match fs::symlink_metadata(&sp) {
                    Ok(m) => m.file_type(),
                    Err(_) => continue,
                };
                if ft.is_symlink() {
                    // Não segue nem recria links internos (ex.: pnpm): avisa.
                    if self.report.skipped.len() < 50 {
                        self.report.skipped.push(format!("{child_rel} (link)"));
                    }
                    continue;
                }
                if ft.is_dir() {
                    if filter_build && is_build_dir(&name) {
                        continue;
                    }
                    // Repositório/worktree aninhado: não é nosso para copiar.
                    if sp.join(".git").exists() {
                        if self.report.skipped.len() < 50 {
                            self.report
                                .skipped
                                .push(format!("{child_rel} (repositório aninhado)"));
                        }
                        continue;
                    }
                    stack.push((sp, dp, child_rel));
                } else if ft.is_file() {
                    self.copy_file(&sp, &dp);
                }
            }
        }
    }
}

/// Semeia `floor` a partir de `ground`. Nunca falha por inteiro: erros vão no relatório.
pub fn seed(
    ground: &Path,
    floor: &Path,
    mode: DepsMode,
    progress: &mut dyn FnMut(u64, u64),
) -> SeedReport {
    let mut report = SeedReport::default();
    let ignored = git::others(ground, true);
    let untracked = git::others(ground, false);
    let ignored_set: HashSet<&String> = ignored.iter().collect();

    let mut copier = Copier {
        report: &mut report,
        progress,
        last_reported: 0,
    };

    // 1) Ignorados (o grosso: .env, node_modules, configs locais), menos build.
    for entry in &ignored {
        let rel = entry.trim_end_matches('/');
        if rel.is_empty() {
            continue;
        }
        let parts: Vec<&str> = rel.split('/').collect();
        let last = *parts.last().unwrap_or(&rel);
        let in_deps = parts[..parts.len().saturating_sub(1)]
            .iter()
            .any(|p| is_deps_dir(p));
        if parts.iter().any(|p| is_build_dir(p)) && !in_deps {
            continue;
        }
        let src = ground.join(rel);
        let dst = floor.join(rel);
        let is_dir = fs::symlink_metadata(&src)
            .map(|m| m.file_type().is_dir())
            .unwrap_or(false);
        if is_link(&src) {
            if copier.report.skipped.len() < 50 {
                copier.report.skipped.push(format!("{rel} (link)"));
            }
            continue;
        }

        if is_dir && is_deps_dir(last) && !in_deps {
            match mode {
                DepsMode::Skip => {
                    copier
                        .report
                        .skipped
                        .push(format!("{rel} (dependências puladas)"));
                }
                DepsMode::Link => {
                    if dst.exists() {
                        continue;
                    }
                    if let Some(parent) = dst.parent() {
                        let _ = fs::create_dir_all(parent);
                    }
                    match make_dir_link(&src, &dst) {
                        Ok(()) => copier.report.linked.push(rel.to_string()),
                        Err(e) => copier.report.errors.push(format!("{rel}: {e}")),
                    }
                }
                DepsMode::Copy => copier.copy_tree(&src, &dst, false, rel),
            }
            continue;
        }

        if is_dir {
            if src.join(".git").exists() {
                copier
                    .report
                    .skipped
                    .push(format!("{rel} (repositório aninhado)"));
                continue;
            }
            copier.copy_tree(&src, &dst, !in_deps, rel);
        } else {
            copier.copy_file(&src, &dst);
        }
        if copier.report.truncated {
            break;
        }
    }

    // 2) Não rastreados e não ignorados: só os úteis (.env*). O resto é trabalho
    //    em andamento do ground e não deve vazar para o floor.
    for entry in &untracked {
        if entry.ends_with('/') || ignored_set.contains(entry) || !is_useful_untracked(entry) {
            continue;
        }
        let src = ground.join(entry);
        let dst = floor.join(entry);
        if dst.exists() || is_link(&src) {
            continue;
        }
        copier.copy_file(&src, &dst);
        if let Some(hash) = file_hash(&dst) {
            copier.report.seeded_untracked.push(SeededFile {
                path: entry.clone(),
                hash,
            });
        }
    }

    let (files, bytes) = (copier.report.files, copier.report.bytes);
    (copier.progress)(files, bytes);
    report
}

/// Remove TODOS os links (symlinks/junctions) dentro do floor, sem segui-los.
/// Precisa rodar antes de `git worktree remove`, que no Windows atravessa junctions.
/// Devolve quantos links foram removidos; erro se algum não pôde ser removido.
pub fn unlink_all(floor: &Path, recorded: &[String]) -> Result<usize, String> {
    let mut removed = 0;
    let mut failed = Vec::new();
    for rel in recorded {
        let p = floor.join(rel);
        if is_link(&p) {
            match remove_link(&p) {
                Ok(()) => removed += 1,
                Err(e) => failed.push(format!("{}: {e}", p.display())),
            }
        }
    }
    // Varredura completa (sem seguir links): pega links criados pelo usuário/agentes.
    let mut stack = vec![floor.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let p = entry.path();
            let Ok(meta) = fs::symlink_metadata(&p) else {
                continue;
            };
            let ft = meta.file_type();
            if ft.is_symlink() {
                match remove_link(&p) {
                    Ok(()) => removed += 1,
                    Err(e) => failed.push(format!("{}: {e}", p.display())),
                }
            } else if ft.is_dir() && entry.file_name().to_string_lossy() != ".git" {
                stack.push(p);
            }
        }
    }
    if failed.is_empty() {
        Ok(removed)
    } else {
        Err(format!(
            "não consegui remover links antes de apagar o floor (nada foi apagado): {}",
            failed.join("; ")
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deps_mode_parse() {
        assert_eq!(DepsMode::parse("link"), DepsMode::Link);
        assert_eq!(DepsMode::parse("junction"), DepsMode::Link);
        assert_eq!(DepsMode::parse("skip"), DepsMode::Skip);
        assert_eq!(DepsMode::parse(""), DepsMode::Copy);
    }

    #[test]
    fn useful_untracked() {
        assert!(is_useful_untracked(".env"));
        assert!(is_useful_untracked("apps/web/.env.local"));
        assert!(!is_useful_untracked("notes.txt"));
        assert!(!is_useful_untracked(".envrc"));
    }
}
