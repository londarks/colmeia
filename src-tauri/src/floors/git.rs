// Helpers finos sobre o binário `git` usados pelos floors. Tudo roda com
// prompts de credencial desligados e sem abrir janela de console no Windows.

use std::path::{Path, PathBuf};
use std::process::Command;

/// Saída crua de um `git`.
pub struct GitOut {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Roda `git -C <dir> <args>` e devolve código + saídas (não falha por código != 0).
pub fn run(dir: &Path, args: &[&str]) -> Result<GitOut, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "never");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: não pisca console a cada chamada.
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd
        .output()
        .map_err(|e| format!("git não encontrado/falhou: {e}"))?;
    Ok(GitOut {
        code: out.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
    })
}

/// Roda e exige sucesso; o erro é o stderr do git.
pub fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let o = run(dir, args)?;
    if o.code == 0 {
        Ok(o.stdout)
    } else if o.stderr.is_empty() {
        Err(format!("git {} falhou (código {})", args.join(" "), o.code))
    } else {
        Err(o.stderr)
    }
}

/// `true` se o comando terminou com código 0.
pub fn ok(dir: &Path, args: &[&str]) -> bool {
    run(dir, args).map(|o| o.code == 0).unwrap_or(false)
}

fn first_line(s: &str) -> String {
    s.lines().next().unwrap_or("").trim().to_string()
}

/// Raiz do working tree que contém `dir`.
pub fn toplevel(dir: &Path) -> Result<PathBuf, String> {
    let out = git(dir, &["rev-parse", "--show-toplevel"])
        .map_err(|_| format!("'{}' não é um repositório git.", dir.display()))?;
    Ok(PathBuf::from(first_line(&out)))
}

/// `--git-common-dir` absoluto (o `.git` compartilhado por todos os worktrees).
pub fn common_dir(dir: &Path) -> Result<PathBuf, String> {
    let out = git(
        dir,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )?;
    Ok(PathBuf::from(first_line(&out)))
}

/// `--git-dir` absoluto (por worktree; onde ficam MERGE_HEAD etc.).
pub fn git_dir(dir: &Path) -> Result<PathBuf, String> {
    let out = git(dir, &["rev-parse", "--path-format=absolute", "--git-dir"])?;
    Ok(PathBuf::from(first_line(&out)))
}

/// O repositório tem pelo menos um commit?
pub fn has_commits(dir: &Path) -> bool {
    ok(dir, &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])
}

/// Oid de uma revisão.
pub fn rev_parse(dir: &Path, rev: &str) -> Result<String, String> {
    let spec = format!("{rev}^{{commit}}");
    Ok(first_line(&git(
        dir,
        &["rev-parse", "--verify", "--quiet", &spec],
    )?))
}

/// Branch atualmente em checkout (None se HEAD destacado).
pub fn current_branch(dir: &Path) -> Option<String> {
    let o = run(dir, &["symbolic-ref", "--quiet", "--short", "HEAD"]).ok()?;
    if o.code == 0 {
        let b = first_line(&o.stdout);
        (!b.is_empty()).then_some(b)
    } else {
        None
    }
}

pub fn branch_exists(dir: &Path, branch: &str) -> bool {
    let r = format!("refs/heads/{branch}");
    ok(dir, &["show-ref", "--verify", "--quiet", &r])
}

/// Nome de branch válido (regras do `git check-ref-format --branch`)?
pub fn valid_branch_name(dir: &Path, branch: &str) -> bool {
    !branch.is_empty()
        && !branch.starts_with('-')
        && branch.len() <= 255
        && ok(dir, &["check-ref-format", "--branch", branch])
}

/// Uma entrada de `git worktree list --porcelain -z`.
#[derive(Clone, Debug)]
pub struct Worktree {
    pub path: PathBuf,
    pub branch: Option<String>,
}

/// Lista os worktrees do repositório (o primeiro é o principal).
pub fn worktrees(dir: &Path) -> Result<Vec<Worktree>, String> {
    let out = git(dir, &["worktree", "list", "--porcelain", "-z"])?;
    Ok(parse_worktrees(&out))
}

pub fn parse_worktrees(out: &str) -> Vec<Worktree> {
    let mut list = Vec::new();
    let mut cur: Option<Worktree> = None;
    for field in out.split('\0') {
        if field.is_empty() {
            if let Some(w) = cur.take() {
                list.push(w);
            }
            continue;
        }
        if let Some(p) = field.strip_prefix("worktree ") {
            if let Some(w) = cur.take() {
                list.push(w);
            }
            cur = Some(Worktree {
                path: PathBuf::from(p),
                branch: None,
            });
        } else if let Some(b) = field.strip_prefix("branch ") {
            if let Some(w) = cur.as_mut() {
                w.branch = Some(b.trim_start_matches("refs/heads/").to_string());
            }
        }
    }
    if let Some(w) = cur.take() {
        list.push(w);
    }
    list
}

/// Entradas de `git status --porcelain=v1 -z --untracked-files=all`: (XY, caminho).
pub fn status_entries(dir: &Path) -> Result<Vec<(String, String)>, String> {
    let out = git(
        dir,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?;
    let mut entries = Vec::new();
    let mut fields = out.split('\0');
    while let Some(f) = fields.next() {
        if f.len() < 4 {
            continue;
        }
        let xy = f[..2].to_string();
        let path = f[3..].to_string();
        // Renomeação/cópia: o campo seguinte é o caminho antigo.
        if xy.starts_with('R') || xy.starts_with('C') {
            fields.next();
        }
        entries.push((xy, path));
    }
    Ok(entries)
}

/// Há uma operação do git em andamento (merge/rebase/cherry-pick/...) neste worktree?
pub fn operation_in_progress(dir: &Path) -> Option<String> {
    if let Ok(gd) = git_dir(dir) {
        let markers = [
            ("MERGE_HEAD", "um merge"),
            ("REBASE_HEAD", "um rebase"),
            ("rebase-merge", "um rebase"),
            ("rebase-apply", "um rebase/am"),
            ("CHERRY_PICK_HEAD", "um cherry-pick"),
            ("REVERT_HEAD", "um revert"),
            ("sequencer", "uma sequência de cherry-pick/revert"),
            ("BISECT_LOG", "um bisect"),
        ];
        for (file, label) in markers {
            if gd.join(file).exists() {
                return Some(label.to_string());
            }
        }
    }
    if let Ok(out) = git(dir, &["diff", "--name-only", "--diff-filter=U"]) {
        if !out.trim().is_empty() {
            return Some("arquivos em conflito não resolvidos".to_string());
        }
    }
    None
}

/// Versão do git (major, minor).
pub fn version() -> Option<(u32, u32)> {
    let o = run(Path::new("."), &["version"]).ok()?;
    parse_version(&o.stdout)
}

pub fn parse_version(s: &str) -> Option<(u32, u32)> {
    let v = s.trim().strip_prefix("git version ")?;
    let mut it = v.split('.');
    let major = it.next()?.parse().ok()?;
    let minor = it
        .next()?
        .trim_end_matches(|c: char| !c.is_ascii_digit())
        .parse()
        .ok()?;
    Some((major, minor))
}

/// `git merge-tree --write-tree` existe a partir do git 2.38.
pub fn supports_merge_tree() -> bool {
    version().map(|v| v >= (2, 38)).unwrap_or(false)
}

/// Commit resumido.
#[derive(Clone, serde::Serialize)]
pub struct CommitInfo {
    pub oid: String,
    pub subject: String,
}

/// Commits que SÓ existem nesta branch (nenhuma outra branch local os contém):
/// é o que se perde de verdade se a branch for apagada.
pub fn unique_commits(dir: &Path, branch: &str, limit: usize) -> (u32, Vec<CommitInfo>) {
    let head = format!("refs/heads/{branch}");
    let exclude = format!("--exclude={branch}");
    let count = run(
        dir,
        &[
            "rev-list",
            "--count",
            &head,
            "--not",
            &exclude,
            "--branches",
        ],
    )
    .ok()
    .filter(|o| o.code == 0)
    .and_then(|o| first_line(&o.stdout).parse::<u32>().ok())
    .unwrap_or(0);
    if count == 0 {
        return (0, Vec::new());
    }
    let n = format!("-n{limit}");
    let commits = git(
        dir,
        &[
            "log",
            &n,
            "--format=%H%x09%s",
            &head,
            "--not",
            &exclude,
            "--branches",
        ],
    )
    .map(|out| {
        out.lines()
            .filter_map(|l| {
                let (oid, subject) = l.split_once('\t')?;
                Some(CommitInfo {
                    oid: oid.to_string(),
                    subject: subject.to_string(),
                })
            })
            .collect()
    })
    .unwrap_or_default();
    (count, commits)
}

/// `a` é ancestral de `b`?
pub fn is_ancestor(dir: &Path, a: &str, b: &str) -> bool {
    ok(dir, &["merge-base", "--is-ancestor", a, b])
}

/// Lista NUL-separada de `git ls-files --others [--ignored] --exclude-standard --directory`.
pub fn others(dir: &Path, ignored: bool) -> Vec<String> {
    let mut args = vec![
        "ls-files",
        "--others",
        "--exclude-standard",
        "--directory",
        "-z",
    ];
    if ignored {
        args.push("--ignored");
    }
    git(dir, &args)
        .map(|out| {
            out.split('\0')
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default()
}

/// Normaliza um caminho para comparação: resolve se existir, tira `\\?\`,
/// usa `/` e (no Windows) caixa baixa.
pub fn norm(p: &Path) -> String {
    let resolved = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let mut s = resolved.to_string_lossy().replace('\\', "/");
    for prefix in ["//?/UNC/", "//?/"] {
        if let Some(rest) = s.strip_prefix(prefix) {
            s = if prefix.contains("UNC") {
                format!("//{rest}")
            } else {
                rest.to_string()
            };
            break;
        }
    }
    while s.len() > 1 && s.ends_with('/') {
        s.pop();
    }
    if cfg!(windows) {
        s = s.to_lowercase();
    }
    s
}

/// `child` está dentro de (ou é igual a) `parent`?
pub fn is_inside(child: &Path, parent: &Path) -> bool {
    let c = norm(child);
    let p = norm(parent);
    c == p || c.starts_with(&format!("{p}/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_version() {
        assert_eq!(
            parse_version("git version 2.45.2.windows.1\n"),
            Some((2, 45))
        );
        assert_eq!(parse_version("git version 2.38.0"), Some((2, 38)));
        assert_eq!(parse_version("nada"), None);
    }

    #[test]
    fn parses_worktree_list() {
        let raw = "worktree C:/r/proj\0HEAD abc\0branch refs/heads/main\0\0worktree C:/r/.colmeia-floors/proj--x\0HEAD def\0branch refs/heads/floor/x\0\0worktree C:/r/det\0HEAD 123\0detached\0\0";
        let w = parse_worktrees(raw);
        assert_eq!(w.len(), 3);
        assert_eq!(w[0].branch.as_deref(), Some("main"));
        assert_eq!(w[1].branch.as_deref(), Some("floor/x"));
        assert!(w[2].branch.is_none());
    }
}
