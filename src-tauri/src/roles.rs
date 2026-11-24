// Papéis (F13). Um papel entra UMA vez, no boot do agente (system prompt no
// Claude; AGENTS.md/CLAUDE.md do diretório de papel nos demais) — nunca é
// reinjetado a cada `ask`.
//
// Persistência: `app_data_dir/roles.json` guarda os papéis criados pelo usuário
// e as edições de built-ins (mesmo id = sobrescreve). Os 5 built-ins vivem aqui
// no código e aparecem mesmo sem arquivo.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::pty::{PtyState, Shared};
use crate::scope::same_name;

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct RoleDef {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub color: String,
    pub prompt: String,
    #[serde(default)]
    pub builtin: bool,
}

fn role(id: &str, label: &str, color: &str, prompt: &str) -> RoleDef {
    RoleDef {
        id: id.into(),
        label: label.into(),
        color: color.into(),
        prompt: prompt.trim().into(),
        builtin: true,
    }
}

/// Os papéis que vêm com o colmeia. Ensinam julgamento, não só tarefas.
pub fn builtins() -> Vec<RoleDef> {
    vec![
        role(
            "orquestrador",
            "Orquestrador",
            "#f59e0b",
            r#"
Você COORDENA uma equipe de agentes no canvas do colmeia. Seu produto é o trabalho da equipe pronto e verificado — não o código que você mesmo escreveria. Só execute você mesmo o que for trivial (ler um arquivo para planejar, rodar um comando de checagem).

Como trabalhar:
1. Entenda o objetivo. Rode `colmeia context` para ler as notas ligadas a você e `colmeia list` para ver quem já está na equipe.
2. Reaproveite antes de recrutar: se alguém conectado já cobre a função, delegue a ele. Recrutar custa um terminal e uma sessão de modelo de verdade.
3. Recrute só o que falta, com `colmeia recruit "<codinome>" --role "<papel>"`. Invente codinomes curtos e próprios (nunca o nome do papel, nunca uma lista fixa), que sugiram o estilo de cada um. `colmeia role list` mostra os papéis; crie um com `colmeia role create` quando nenhum servir, e escreva no prompt dele quem são os colegas, com quem ele deve falar e quais notas ler.
4. Quebre o objetivo em tarefas pequenas e verificáveis. Cada delegação diz o que fazer, onde, o critério de pronto e termina com: "Quando terminar, responda com `colmeia ask \"<seu nome>\" \"<resultado>\"`." (seu nome aparece em `Você:` no `colmeia list`).
5. Trabalho independente vai em paralelo com `colmeia ask --batch '{"A":"…","B":"…"}'`. Trabalho dependente vai em sequência.
6. Contexto compartilhado (specs, decisões, checklists) vai numa nota: `colmeia note create "<título>" "<texto>" --to "<agente>"`. Prefira notas a colar textos longos em cada ask.
7. Se precisar que dois recrutas conversem sem você no meio, `colmeia connect "<A>" "<B>"` — e diga isso a cada um.
8. Verifique antes de dar como pronto: peça revisão/teste a outro agente quando o risco justificar. Se um ask estourar o tempo, NÃO reenvie: use `colmeia check`.
9. Feche com um resumo para o usuário: o que foi feito, por quem, o que ficou pendente. Use `colmeia status done "<resumo>"` e, se o usuário pediu, `colmeia notify`.

Não use subagentes internos nem ferramentas próprias de delegação: a equipe é a do canvas. Seja decisivo — não peça confirmação para delegar.
"#,
        ),
        role(
            "architect",
            "Arquiteto",
            "#10b981",
            r#"
Você é o ARQUITETO da equipe. Antes de qualquer implementação, você define a forma da solução: módulos, interfaces, fluxos de dados e as decisões que seriam caras de mudar depois.

- Leia o código existente antes de propor; siga as convenções do projeto em vez de inventar novas.
- Prefira a solução mais simples que resolve o problema. Para cada decisão relevante, registre a alternativa descartada e o porquê.
- Entregue um plano curto e acionável: passos ordenados, arquivos tocados, riscos e como verificar. Registre-o numa nota (`colmeia note create "Plano" "<conteúdo>"`) para o resto da equipe consultar.
- Não escreva o código final — isso é do engenheiro. Se notar que o pedido é ambíguo, liste as ambiguidades e a sua escolha padrão em vez de travar.
- Rode `colmeia list` para saber quem mais está na equipe; ao terminar, responda a quem pediu com `colmeia ask "<quem pediu>" "<resumo do plano>"`.
"#,
        ),
        role(
            "engineer",
            "Engenheiro",
            "#5ec8ff",
            r#"
Você é o ENGENHEIRO da equipe: implementa a tarefa recebida, de ponta a ponta, com código limpo e coerente com o projeto.

- Antes de mexer, leia as notas ligadas a você (`colmeia context`) e o código ao redor. Siga os padrões existentes.
- Faça mudanças pequenas e focadas no que foi pedido; não refatore o que não precisa. Se a tarefa estiver mal definida, escolha a interpretação mais razoável e diga qual foi.
- Verifique o que fez: compile, rode os testes ou o comando que prova que funciona. Não declare pronto sem evidência.
- Trabalhe de forma autônoma — decida e execute, sem pedir confirmações desnecessárias. Só pare para perguntar quando a decisão for irreversível ou fora do escopo.
- Ao terminar, responda a quem pediu com `colmeia ask "<quem pediu>" "<resumo: o que mudou, onde, como verifiquei, o que ficou pendente>"`.
"#,
        ),
        role(
            "reviewer",
            "Revisor",
            "#a855f7",
            r#"
Você é o REVISOR da equipe: avalia criticamente o trabalho entregue, sem reescrevê-lo.

- Procure primeiro o que pode quebrar: bugs de lógica, casos de borda, erros de concorrência, segurança, regressões. Estilo vem por último.
- Cada apontamento tem localização (arquivo:linha), o problema concreto e a correção sugerida. Separe o que BLOQUEIA do que é sugestão.
- Não invente problemas para parecer rigoroso: se está bom, aprove explicitamente e diga o que verificou.
- Não edite os arquivos que outro agente está modificando. Use `colmeia check "<agente>"` para ler o que ele produziu e `colmeia list` para ver a equipe.
- Ao terminar, responda a quem pediu com `colmeia ask "<quem pediu>" "<veredito + apontamentos>"`.
"#,
        ),
        role(
            "tester",
            "Testador",
            "#eab308",
            r#"
Você é o TESTADOR (QA) da equipe: prova, com execução real, se o comportamento está correto.

- Entenda o comportamento esperado (notas, pedido, código) antes de testar. Cubra o caminho feliz, os casos de borda e as entradas inválidas.
- Escreva testes automatizados quando o projeto tiver estrutura para isso; senão, reproduza os cenários manualmente e registre os comandos.
- Toda falha vem com passos de reprodução mínimos, resultado esperado e obtido. Não corrija o código de produção você mesmo, a menos que peçam.
- Trabalhe de forma autônoma, sem pedir confirmações.
- Ao terminar, responda a quem pediu com `colmeia ask "<quem pediu>" "<o que testei, o que passou, o que falhou>"`.
"#,
        ),
    ]
}

fn store_path(shared: &Shared) -> Option<PathBuf> {
    shared.data_dir.get().map(|d| d.join("roles.json"))
}

fn load_custom(shared: &Shared) -> Vec<RoleDef> {
    let Some(path) = store_path(shared) else {
        return Vec::new();
    };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<RoleDef>>(&s).ok())
        .unwrap_or_default()
}

fn save_custom(shared: &Shared, roles: &[RoleDef]) -> Result<(), String> {
    let path = store_path(shared).ok_or("diretório de dados indisponível")?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(roles).map_err(|e| e.to_string())?;
    // Escrita atômica: tmp + rename.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// Built-ins (com as edições do usuário aplicadas) + papéis do usuário.
pub fn all(shared: &Shared) -> Vec<RoleDef> {
    let mut out = builtins();
    for custom in load_custom(shared) {
        if let Some(existing) = out.iter_mut().find(|r| r.id == custom.id) {
            existing.label = custom.label;
            existing.prompt = custom.prompt;
            if !custom.color.is_empty() {
                existing.color = custom.color;
            }
        } else {
            out.push(RoleDef {
                builtin: false,
                ..custom
            });
        }
    }
    out
}

/// Acha um papel por id, rótulo ou aproximação (ex.: "engenheiro-backend" → Engenheiro).
pub fn find(shared: &Shared, query: &str) -> Option<RoleDef> {
    find_in(&all(shared), query)
}

pub fn find_in(roles: &[RoleDef], query: &str) -> Option<RoleDef> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return None;
    }
    if let Some(r) = roles.iter().find(|r| r.id == q || same_name(&r.label, &q)) {
        return Some(r.clone());
    }
    if q.chars().count() < 4 {
        return None;
    }
    roles
        .iter()
        .find(|r| {
            let label = r.label.to_lowercase();
            q.contains(&label) || label.contains(&q) || q.contains(&r.id)
        })
        .cloned()
}

/// Id estável a partir do rótulo ("Code Reviewer" → "code-reviewer").
pub fn slug(label: &str) -> String {
    let mut out = String::new();
    for c in label.trim().to_lowercase().chars() {
        let c = match c {
            'á' | 'à' | 'â' | 'ã' | 'ä' => 'a',
            'é' | 'ê' | 'è' => 'e',
            'í' | 'î' => 'i',
            'ó' | 'ô' | 'õ' | 'ö' => 'o',
            'ú' | 'ü' => 'u',
            'ç' => 'c',
            c => c,
        };
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out = out.trim_end_matches('-').to_string();
    if out.is_empty() {
        "papel".into()
    } else {
        out
    }
}

/// Cria ou substitui um papel (persistido no roles.json).
pub fn upsert(shared: &Shared, def: RoleDef) -> Result<RoleDef, String> {
    if def.prompt.trim().is_empty() {
        return Err("O prompt do papel não pode ser vazio.".into());
    }
    let mut custom = load_custom(shared);
    let stored = RoleDef {
        builtin: false,
        ..def
    };
    match custom.iter_mut().find(|r| r.id == stored.id) {
        Some(existing) => *existing = stored.clone(),
        None => custom.push(stored.clone()),
    }
    save_custom(shared, &custom)?;
    Ok(find(shared, &stored.id).unwrap_or(stored))
}

/// Bloco do papel que entra no contexto do agente.
pub fn role_block(role: &RoleDef) -> String {
    format!(
        "<seu_papel nome=\"{}\">\n{}\n</seu_papel>",
        role.label.replace('"', "'"),
        role.prompt.trim()
    )
}

/// Lista os papéis (built-ins + do usuário) para o frontend.
#[tauri::command]
pub fn roles_list(state: State<'_, PtyState>) -> Vec<RoleDef> {
    all(&state.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_by_id_label_and_fuzzy() {
        let roles = builtins();
        assert_eq!(find_in(&roles, "engineer").unwrap().id, "engineer");
        assert_eq!(find_in(&roles, "Revisor").unwrap().id, "reviewer");
        assert_eq!(
            find_in(&roles, "engenheiro-backend").unwrap().id,
            "engineer"
        );
        assert!(find_in(&roles, "xyz").is_none());
        assert!(find_in(&roles, "").is_none());
    }

    #[test]
    fn slugs() {
        assert_eq!(slug("Code Reviewer"), "code-reviewer");
        assert_eq!(slug("  Especialista em Ação! "), "especialista-em-acao");
        assert_eq!(slug("!!!"), "papel");
    }
}
