// Skills do colmeia (F14) e contexto de boot dos agentes.
//
// - Claude Code: geramos em runtime um PLUGIN isolado em `<bin>/colmeia-plugin/`
//   (`.claude-plugin/plugin.json` + `skills/<nome>/SKILL.md`) e passamos
//   `--plugin-dir` ao spawnar `claude`. Nada é escrito em `~/.claude`.
//   O system prompt ganha só um onboarding curto (aponta as skills) + o papel.
// - Codex e outros que leem AGENTS.md/CLAUDE.md: o mesmo conteúdo das skills,
//   mais o papel, vai num diretório de papel usado como cwd do agente
//   (`<projeto>/.colmeia/roles/<papel>/`), com uma nota apontando o projeto real.
//
// Para adicionar uma skill (floors, rotinas, navegador…): crie
// `src/skills/<nome>/SKILL.md` e acrescente uma linha em `SKILLS`.

use std::path::{Path, PathBuf};

use crate::pty::write_if_changed;
use crate::roles::{role_block, RoleDef};

/// (nome, conteúdo do SKILL.md com frontmatter).
pub const SKILLS: &[(&str, &str)] = &[
    ("colmeia", include_str!("skills/colmeia/SKILL.md")),
    (
        "colmeia-equipe",
        include_str!("skills/colmeia-equipe/SKILL.md"),
    ),
    (
        "colmeia-floors",
        include_str!("skills/colmeia-floors/SKILL.md"),
    ),
    (
        "colmeia-rotinas",
        include_str!("skills/colmeia-rotinas/SKILL.md"),
    ),
    (
        "colmeia-navegador",
        include_str!("skills/colmeia-navegador/SKILL.md"),
    ),
];

const PLUGIN_JSON: &str = r#"{
  "name": "colmeia",
  "version": "0.1.0",
  "description": "Skills do colmeia: comunicação entre agentes, notas compartilhadas e coordenação de equipe no canvas.",
  "author": { "name": "colmeia" }
}
"#;

pub fn plugin_dir(bin: &Path) -> PathBuf {
    bin.join("colmeia-plugin")
}

/// Gera (idempotente) o plugin de skills do Claude Code dentro do bin.
pub fn ensure_plugin(bin: &Path) -> std::io::Result<PathBuf> {
    let root = plugin_dir(bin);
    write_if_changed(
        &root.join(".claude-plugin").join("plugin.json"),
        PLUGIN_JSON,
    )?;
    for (name, body) in SKILLS {
        write_if_changed(&root.join("skills").join(name).join("SKILL.md"), body)?;
    }
    Ok(root)
}

/// Corpo de um SKILL.md sem o frontmatter YAML.
pub fn strip_frontmatter(md: &str) -> &str {
    let Some(rest) = md.strip_prefix("---") else {
        return md;
    };
    match rest.find("\n---") {
        Some(end) => {
            let after = &rest[end + 4..];
            after.trim_start_matches(['\r', '\n'])
        }
        None => md,
    }
}

/// Onboarding curto no system prompt do Claude: aponta as skills e o papel.
pub fn onboarding(node_id: &str, role: Option<&RoleDef>) -> String {
    let mut s = format!(
        "Você está rodando DENTRO do colmeia, um orquestrador de agentes de IA em canvas (seu id de nó: \"{node_id}\"). \
A CLI `colmeia` está no PATH: são comandos de SHELL que você roda com a ferramenta Bash — não são slash-commands nem subagentes. \
Mensagens que chegam como `[colmeia · de \"X\"] …` vieram do agente X. \
Antes de falar com outro agente, usar notas ou avisar o usuário, carregue a skill `colmeia`; para recrutar e coordenar uma equipe, a skill `colmeia-equipe` (ambas do plugin colmeia). \
Para começar: `colmeia list`. Ao coordenar, use sempre os agentes do canvas, nunca seus subagentes internos."
    );
    if let Some(r) = role {
        s.push_str("\n\n");
        s.push_str(&role_block(r));
    }
    s
}

/// Nome de pasta seguro para o papel.
fn safe_dir_name(id: &str) -> String {
    let s: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    if s.trim_matches('-').is_empty() {
        "agente".into()
    } else {
        s
    }
}

/// Conteúdo do AGENTS.md/CLAUDE.md de um diretório de papel.
pub fn agent_context_file(project: Option<&str>, role: Option<&RoleDef>) -> String {
    let mut s = String::from(
        "<!-- Gerado pelo colmeia a cada início do agente. Edições aqui são sobrescritas. -->\n\n",
    );
    s.push_str("<diretorio_de_trabalho>\n");
    match project {
        Some(p) => s.push_str(&format!(
            "O projeto em que você trabalha está em `{p}`. Faça o trabalho LÁ (use caminhos absolutos \
ou entre nessa pasta); esta pasta guarda só o seu contexto de papel e não deve ser editada.\n"
        )),
        None => s.push_str(
            "Nenhuma pasta de projeto foi definida para este terminal. Pergunte ao usuário ou a quem te \
delegou onde trabalhar; esta pasta guarda só o seu contexto.\n",
        ),
    }
    s.push_str("</diretorio_de_trabalho>\n\n");
    if let Some(r) = role {
        s.push_str(&role_block(r));
        s.push_str("\n\n");
    }
    for (_, body) in SKILLS {
        s.push_str(strip_frontmatter(body).trim());
        s.push_str("\n\n");
    }
    s
}

/// Prepara o diretório de contexto de um agente não-Claude e devolve o caminho
/// (usado como cwd). Com projeto: `<projeto>/.colmeia/roles/<papel>/`, e um
/// `.colmeia/.gitignore` que ignora tudo. Sem projeto: dentro de `base`.
pub fn prepare_agent_dir(
    project: Option<&str>,
    role: Option<&RoleDef>,
    base: &Path,
) -> std::io::Result<PathBuf> {
    let name = safe_dir_name(role.map(|r| r.id.as_str()).unwrap_or("agente"));
    let dir = match project {
        Some(p) => {
            let colmeia = Path::new(p).join(".colmeia");
            write_if_changed(&colmeia.join(".gitignore"), "*\n")?;
            colmeia.join("roles").join(&name)
        }
        None => base.join("roles-run").join(&name),
    };
    std::fs::create_dir_all(&dir)?;
    let content = agent_context_file(project, role);
    write_if_changed(&dir.join("AGENTS.md"), &content)?;
    write_if_changed(&dir.join("CLAUDE.md"), &content)?;
    if let Some(r) = role {
        let meta = serde_json::json!({ "id": r.id, "label": r.label, "project": project });
        write_if_changed(
            &dir.join("role.json"),
            &serde_json::to_string_pretty(&meta).unwrap_or_default(),
        )?;
    }
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontmatter_is_stripped() {
        let md = "---\nname: x\ndescription: y\n---\n\n# Título\ncorpo";
        assert_eq!(strip_frontmatter(md), "# Título\ncorpo");
        assert_eq!(strip_frontmatter("# sem"), "# sem");
    }

    #[test]
    fn skills_have_frontmatter_with_description() {
        for (name, body) in SKILLS {
            assert!(
                body.starts_with("---\n") || body.starts_with("---\r\n"),
                "{name}"
            );
            assert!(body.contains(&format!("name: {name}")), "{name}");
            assert!(body.contains("description:"), "{name}");
        }
    }

    #[test]
    fn onboarding_includes_role_once() {
        let r = RoleDef {
            id: "engineer".into(),
            label: "Engenheiro".into(),
            color: String::new(),
            prompt: "Implemente.".into(),
            builtin: true,
        };
        let s = onboarding("n1", Some(&r));
        assert_eq!(s.matches("<seu_papel nome=\"Engenheiro\">").count(), 1);
        assert!(s.contains("colmeia-equipe"));
    }
}
