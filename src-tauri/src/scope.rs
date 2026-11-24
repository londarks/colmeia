// Escopo e visibilidade (F6): quem um nó enxerga no canvas.
//
// Regras (aplicadas pelo servidor em TODAS as rotas):
// - As arestas são não-direcionadas. O alcance de um nó são os vizinhos diretos
//   (terminais, notas, navegadores) mais a CADEIA de notas: uma nota ligada a
//   você e a outra nota torna a segunda (e as seguintes) alcançáveis.
//   Notas não servem de ponte entre terminais.
// - O alcance de EQUIPE (usado por quem é maestro/orquestrador) soma ao seu
//   alcance o alcance de cada terminal vizinho direto (a "árvore do time").
// - Nomes são comparados sem diferenciar maiúsculas; o id do nó também vale.
// - Dois nós com o mesmo nome dentro do alcance = erro explícito (nunca o
//   "primeiro que achar").
// - Bands (F17): um nó `group` com `band: true`. Todo membro da band (qualquer
//   descendente via `parent`) alcança os outros membros e tudo o que está ligado
//   à band; uma aresta ligando um nó à band alcança todos os membros. Quem entra
//   na band depois herda essas conexões. O nó-grupo em si nunca entra no alcance.

use std::collections::{HashSet, VecDeque};

use crate::pty::{EdgeInfo, NodeInfo};

#[derive(Debug, PartialEq, Eq)]
pub enum ScopeError {
    NotFound(String),
    NotConnected(String),
    Ambiguous(String, usize),
    SelfTarget,
}

impl ScopeError {
    pub fn status(&self) -> u16 {
        match self {
            ScopeError::NotFound(_) => 404,
            ScopeError::NotConnected(_) => 403,
            ScopeError::Ambiguous(_, _) => 409,
            ScopeError::SelfTarget => 400,
        }
    }

    pub fn message(&self) -> String {
        match self {
            ScopeError::NotFound(n) => format!(
                "Nada chamado \"{n}\" no canvas. Rode `colmeia list` para ver os nomes exatos."
            ),
            ScopeError::NotConnected(n) => {
                format!("Sem conexão com \"{n}\". Rode `colmeia list`.")
            }
            ScopeError::Ambiguous(n, count) => format!(
                "Há {count} nós chamados \"{n}\" ao seu alcance. Peça ao usuário para renomear um deles."
            ),
            ScopeError::SelfTarget => "Esse nome é você mesmo. Rode `colmeia list` para ver os outros.".into(),
        }
    }
}

pub fn same_name(a: &str, b: &str) -> bool {
    a.trim().to_lowercase() == b.trim().to_lowercase()
}

/// Vizinhos diretos de `id` (arestas não-direcionadas).
pub fn neighbors(edges: &[EdgeInfo], id: &str) -> Vec<String> {
    edges
        .iter()
        .filter_map(|e| {
            if e.source == id {
                Some(e.target.clone())
            } else if e.target == id {
                Some(e.source.clone())
            } else {
                None
            }
        })
        .collect()
}

fn kind_of<'a>(nodes: &'a [NodeInfo], id: &str) -> Option<&'a str> {
    nodes.iter().find(|n| n.id == id).map(|n| n.kind.as_str())
}

/// Limite de profundidade ao subir/descer a hierarquia de grupos (dados ruins).
const MAX_DEPTH: usize = 32;

/// `id` é um nó-grupo marcado como band?
pub fn is_band(nodes: &[NodeInfo], id: &str) -> bool {
    nodes
        .iter()
        .any(|n| n.id == id && n.kind == "group" && n.band)
}

/// Membros de uma band: todos os descendentes (via `parent`) que não são grupos.
/// Subgrupos dentro da band são atravessados (os filhos deles também são membros).
pub fn band_members(nodes: &[NodeInfo], band: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut queue = VecDeque::new();
    seen.insert(band.to_string());
    queue.push_back((band.to_string(), 0usize));
    while let Some((cur, depth)) = queue.pop_front() {
        if depth >= MAX_DEPTH {
            continue;
        }
        for n in nodes.iter().filter(|n| n.parent == cur) {
            if !seen.insert(n.id.clone()) {
                continue;
            }
            if n.kind == "group" {
                queue.push_back((n.id.clone(), depth + 1));
            } else {
                out.push(n.id.clone());
            }
        }
    }
    out
}

/// Bands que contêm `id` (todas as ancestrais marcadas como band).
pub fn bands_of(nodes: &[NodeInfo], id: &str) -> Vec<String> {
    let parent_of = |x: &str| {
        nodes
            .iter()
            .find(|n| n.id == x)
            .map(|n| n.parent.clone())
            .unwrap_or_default()
    };
    let mut out = Vec::new();
    let mut cur = parent_of(id);
    let mut guard = 0;
    while !cur.is_empty() && guard < MAX_DEPTH {
        if is_band(nodes, &cur) && !out.contains(&cur) {
            out.push(cur.clone());
        }
        cur = parent_of(&cur);
        guard += 1;
    }
    out
}

/// Ligações efetivas de `id`: os vizinhos diretos pelas arestas, expandidos
/// pelas regras de band (membros da própria band, o que está ligado a ela e
/// os membros de qualquer band ligada). Nunca inclui `id` nem nós-band.
pub fn linked(nodes: &[NodeInfo], edges: &[EdgeInfo], id: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    seen.insert(id.to_string());
    let mut direct = neighbors(edges, id);
    for band in bands_of(nodes, id) {
        for m in band_members(nodes, &band) {
            if seen.insert(m.clone()) {
                out.push(m);
            }
        }
        direct.extend(neighbors(edges, &band));
    }
    for n in direct {
        if is_band(nodes, &n) {
            for m in band_members(nodes, &n) {
                if seen.insert(m.clone()) {
                    out.push(m);
                }
            }
        } else if seen.insert(n.clone()) {
            out.push(n);
        }
    }
    out
}

/// Uma band vista por `source` (para o `colmeia list`).
#[derive(Debug, PartialEq, Eq)]
pub struct BandView {
    pub id: String,
    pub title: String,
    /// `source` é membro (senão, a band está ligada a ele por aresta).
    pub member: bool,
    /// Ids dos membros (sem o próprio `source`).
    pub members: Vec<String>,
}

/// Bands relevantes para `source`: as que ele integra e as ligadas a ele
/// (diretamente ou pela band de que ele faz parte).
pub fn bands_for(nodes: &[NodeInfo], edges: &[EdgeInfo], source: &str) -> Vec<BandView> {
    let mine = bands_of(nodes, source);
    let mut ids: Vec<(String, bool)> = mine.iter().map(|b| (b.clone(), true)).collect();
    let mut touch = neighbors(edges, source);
    for b in &mine {
        touch.extend(neighbors(edges, b));
    }
    for n in touch {
        if is_band(nodes, &n) && !ids.iter().any(|(b, _)| b == &n) {
            ids.push((n, false));
        }
    }
    ids.into_iter()
        .map(|(id, member)| BandView {
            title: nodes
                .iter()
                .find(|n| n.id == id)
                .map(|n| n.title.clone())
                .unwrap_or_else(|| id.clone()),
            members: band_members(nodes, &id)
                .into_iter()
                .filter(|m| m != source)
                .collect(),
            id,
            member,
        })
        .collect()
}

/// Alcance de `source`: ligações efetivas (arestas + bands) + cadeia de notas.
pub fn reach(nodes: &[NodeInfo], edges: &[EdgeInfo], source: &str) -> HashSet<String> {
    let mut out = HashSet::new();
    let mut queue = VecDeque::new();
    for n in linked(nodes, edges, source) {
        if n != source && out.insert(n.clone()) && kind_of(nodes, &n) == Some("note") {
            queue.push_back(n);
        }
    }
    while let Some(note) = queue.pop_front() {
        for n in neighbors(edges, &note) {
            if n == source {
                continue;
            }
            if kind_of(nodes, &n) == Some("note") && out.insert(n.clone()) {
                queue.push_back(n);
            }
        }
    }
    out
}

/// Profundidade de cada nota na cadeia (1 = ligada direto a `source`).
pub fn note_depths(nodes: &[NodeInfo], edges: &[EdgeInfo], source: &str) -> Vec<(String, usize)> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    let mut queue = VecDeque::new();
    for n in linked(nodes, edges, source) {
        if kind_of(nodes, &n) == Some("note") && seen.insert(n.clone()) {
            queue.push_back((n, 1usize));
        }
    }
    while let Some((note, depth)) = queue.pop_front() {
        out.push((note.clone(), depth));
        for n in neighbors(edges, &note) {
            if n != source && kind_of(nodes, &n) == Some("note") && seen.insert(n.clone()) {
                queue.push_back((n, depth + 1));
            }
        }
    }
    out
}

/// Alcance de equipe: o seu alcance + o alcance de cada terminal vizinho.
pub fn team_reach(nodes: &[NodeInfo], edges: &[EdgeInfo], source: &str) -> HashSet<String> {
    let mut out = reach(nodes, edges, source);
    let direct: Vec<String> = out
        .iter()
        .filter(|id| kind_of(nodes, id) == Some("terminal"))
        .cloned()
        .collect();
    for t in direct {
        for x in reach(nodes, edges, &t) {
            if x != source {
                out.insert(x);
            }
        }
    }
    out
}

/// Resolve `name` (título ou id) para um id dentro do alcance de `source`.
/// `kinds` vazio = qualquer tipo de nó. `team` = usa o alcance de equipe.
pub fn resolve(
    nodes: &[NodeInfo],
    edges: &[EdgeInfo],
    source: &str,
    name: &str,
    kinds: &[&str],
    team: bool,
) -> Result<String, ScopeError> {
    let wanted = name.trim();
    let matches: Vec<&NodeInfo> = nodes
        .iter()
        .filter(|n| kinds.is_empty() || kinds.contains(&n.kind.as_str()))
        .filter(|n| n.id == wanted || same_name(&n.title, wanted))
        .collect();
    if matches.is_empty() {
        return Err(ScopeError::NotFound(wanted.to_string()));
    }
    let others: Vec<&&NodeInfo> = matches.iter().filter(|n| n.id != source).collect();
    if others.is_empty() {
        return Err(ScopeError::SelfTarget);
    }
    let scope = if team {
        team_reach(nodes, edges, source)
    } else {
        reach(nodes, edges, source)
    };
    let ok: Vec<&&&NodeInfo> = others.iter().filter(|n| scope.contains(&n.id)).collect();
    match ok.len() {
        0 => Err(ScopeError::NotConnected(wanted.to_string())),
        1 => Ok(ok[0].id.clone()),
        n => Err(ScopeError::Ambiguous(wanted.to_string(), n)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: &str, kind: &str, title: &str) -> NodeInfo {
        NodeInfo {
            id: id.into(),
            kind: kind.into(),
            title: title.into(),
            ..Default::default()
        }
    }
    fn edge(a: &str, b: &str) -> EdgeInfo {
        EdgeInfo {
            source: a.into(),
            target: b.into(),
        }
    }

    fn graph() -> (Vec<NodeInfo>, Vec<EdgeInfo>) {
        let nodes = vec![
            node("a", "terminal", "Alfa"),
            node("b", "terminal", "Beta"),
            node("c", "terminal", "Gama"),
            node("d", "terminal", "Beta"),
            node("n1", "note", "Plano"),
            node("n2", "note", "Rascunho"),
        ];
        // a — b — c ; a — n1 — n2 ; n1 — c (nota não faz ponte entre terminais)
        let edges = vec![
            edge("a", "b"),
            edge("b", "c"),
            edge("a", "n1"),
            edge("n1", "n2"),
            edge("n1", "c"),
        ];
        (nodes, edges)
    }

    #[test]
    fn resolves_connected_case_insensitive() {
        let (n, e) = graph();
        assert_eq!(
            resolve(&n, &e, "a", "beta", &["terminal"], false),
            Ok("b".into())
        );
    }

    #[test]
    fn not_connected_and_not_found() {
        let (n, e) = graph();
        assert_eq!(
            resolve(&n, &e, "a", "Gama", &["terminal"], false),
            Err(ScopeError::NotConnected("Gama".into()))
        );
        assert_eq!(
            resolve(&n, &e, "a", "Zeta", &[], false),
            Err(ScopeError::NotFound("Zeta".into()))
        );
    }

    #[test]
    fn note_chain_is_reachable() {
        let (n, e) = graph();
        assert_eq!(
            resolve(&n, &e, "a", "Rascunho", &["note"], false),
            Ok("n2".into())
        );
        let depths = note_depths(&n, &e, "a");
        assert!(depths.contains(&("n1".to_string(), 1)));
        assert!(depths.contains(&("n2".to_string(), 2)));
    }

    #[test]
    fn team_reach_sees_recruits_neighbors() {
        let (n, e) = graph();
        assert_eq!(
            resolve(&n, &e, "a", "Gama", &["terminal"], true),
            Ok("c".into())
        );
    }

    // ── Bands ──────────────────────────────────────────────────────────

    fn child(id: &str, kind: &str, title: &str, parent: &str) -> NodeInfo {
        NodeInfo {
            parent: parent.into(),
            ..node(id, kind, title)
        }
    }
    fn band(id: &str, title: &str) -> NodeInfo {
        NodeInfo {
            band: true,
            ..node(id, "group", title)
        }
    }

    /// Band "Squad" (g) com m1, m2 e a nota mn; x ligado à band; m1 ligado a y;
    /// a band ligada à nota bn; o grupo comum h (não é band) com h1 e h2.
    fn band_graph() -> (Vec<NodeInfo>, Vec<EdgeInfo>) {
        let nodes = vec![
            band("g", "Squad"),
            child("m1", "terminal", "Um", "g"),
            child("m2", "terminal", "Dois", "g"),
            child("mn", "note", "Quadro", "g"),
            node("x", "terminal", "Fora"),
            node("y", "terminal", "Vizinho"),
            node("bn", "note", "Briefing"),
            node("h", "group", "Comum"),
            child("h1", "terminal", "Solto", "h"),
            child("h2", "terminal", "Solto2", "h"),
        ];
        let edges = vec![edge("x", "g"), edge("m1", "y"), edge("g", "bn")];
        (nodes, edges)
    }

    #[test]
    fn band_members_reach_each_other() {
        let (n, e) = band_graph();
        let r = reach(&n, &e, "m1");
        assert!(r.contains("m2"));
        assert!(r.contains("mn"));
        // Membro vê o que está ligado à band e o próprio vizinho direto.
        assert!(r.contains("x"));
        assert!(r.contains("bn"));
        assert!(r.contains("y"));
        // O nó-grupo nunca entra no alcance; ninguém se vê.
        assert!(!r.contains("g"));
        assert!(!r.contains("m1"));
    }

    #[test]
    fn edge_to_band_reaches_all_members() {
        let (n, e) = band_graph();
        let r = reach(&n, &e, "x");
        assert!(r.contains("m1"));
        assert!(r.contains("m2"));
        assert!(r.contains("mn"));
        assert!(!r.contains("g"));
        // Estar ligado à band não dá o que a band enxerga.
        assert!(!r.contains("bn"));
        assert!(!r.contains("y"));
        assert_eq!(
            resolve(&n, &e, "x", "dois", &["terminal"], false),
            Ok("m2".into())
        );
    }

    #[test]
    fn member_neighbor_is_not_shared_with_band() {
        let (n, e) = band_graph();
        // y está ligado só a m1, não à band: m2 não o enxerga.
        assert!(!reach(&n, &e, "m2").contains("y"));
        let ry = reach(&n, &e, "y");
        assert!(ry.contains("m1"));
        assert!(!ry.contains("m2"));
        assert_eq!(
            resolve(&n, &e, "m2", "Vizinho", &["terminal"], false),
            Err(ScopeError::NotConnected("Vizinho".into()))
        );
    }

    #[test]
    fn plain_group_is_not_a_band() {
        let (n, e) = band_graph();
        assert!(!is_band(&n, "h"));
        assert!(!reach(&n, &e, "h1").contains("h2"));
        assert_eq!(band_members(&n, "h").len(), 2);
    }

    #[test]
    fn late_joiner_inherits_band_links() {
        let (mut n, e) = band_graph();
        n.push(child("m3", "terminal", "Novato", "g"));
        let r = reach(&n, &e, "m3");
        assert!(r.contains("m1") && r.contains("m2") && r.contains("x") && r.contains("bn"));
        assert!(reach(&n, &e, "x").contains("m3"));
    }

    #[test]
    fn nested_groups_inside_band_are_members() {
        let (mut n, e) = band_graph();
        n.push(child("sub", "group", "Sub", "g"));
        n.push(child("s1", "terminal", "Fundo", "sub"));
        assert!(band_members(&n, "g").contains(&"s1".to_string()));
        assert!(!band_members(&n, "g").contains(&"sub".to_string()));
        assert!(reach(&n, &e, "s1").contains("m1"));
        assert_eq!(bands_of(&n, "s1"), vec!["g".to_string()]);
    }

    #[test]
    fn band_to_band_edge_links_members() {
        let (mut n, mut e) = band_graph();
        n.push(band("k", "Outra"));
        n.push(child("k1", "terminal", "Kappa", "k"));
        e.push(edge("g", "k"));
        assert!(reach(&n, &e, "m1").contains("k1"));
        assert!(reach(&n, &e, "k1").contains("m2"));
    }

    #[test]
    fn band_notes_and_chain() {
        let (mut n, mut e) = band_graph();
        n.push(node("bn2", "note", "Anexo"));
        e.push(edge("bn", "bn2"));
        let depths = note_depths(&n, &e, "m2");
        assert!(depths.contains(&("mn".to_string(), 1)));
        assert!(depths.contains(&("bn".to_string(), 1)));
        assert!(depths.contains(&("bn2".to_string(), 2)));
    }

    #[test]
    fn team_reach_through_band() {
        let (n, e) = band_graph();
        // x (como orquestrador) enxerga, pela equipe, o vizinho y de m1.
        assert!(team_reach(&n, &e, "x").contains("y"));
        assert!(!reach(&n, &e, "x").contains("y"));
    }

    #[test]
    fn bands_for_lists_membership_and_links() {
        let (n, e) = band_graph();
        let mine = bands_for(&n, &e, "m1");
        assert_eq!(mine.len(), 1);
        assert!(mine[0].member);
        assert_eq!(mine[0].title, "Squad");
        assert!(mine[0].members.contains(&"m2".to_string()));
        assert!(!mine[0].members.contains(&"m1".to_string()));
        let outside = bands_for(&n, &e, "x");
        assert_eq!(outside.len(), 1);
        assert!(!outside[0].member);
        assert_eq!(outside[0].members.len(), 3);
        assert!(bands_for(&n, &e, "y").is_empty());
    }

    #[test]
    fn ambiguous_and_self() {
        let (n, mut e) = graph();
        e.push(edge("a", "d"));
        assert_eq!(
            resolve(&n, &e, "a", "Beta", &["terminal"], false),
            Err(ScopeError::Ambiguous("Beta".into(), 2))
        );
        assert_eq!(
            resolve(&n, &e, "a", "Alfa", &["terminal"], false),
            Err(ScopeError::SelfTarget)
        );
    }
}
