// Modelo de tela headless por sessão de PTY (F1).
//
// A thread leitora de cada PTY alimenta um parser `vt100` (MIT) com os mesmos
// bytes que vão para o xterm.js do frontend. Assim o backend sabe o que está
// *renderizado* na tela (sem ANSI), onde está o cursor, se o app ligou o modo
// bracketed paste e se o conteúdo visível mudou de verdade (hash que ignora
// spinners). É a base de `check`, da ociosidade, da confirmação de Enter e do
// recorte da resposta do `ask`.

use std::num::NonZeroU16;

use vt100::capture::RowContents;

/// Linhas de scrollback guardadas por sessão.
pub const SCROLLBACK_LINES: usize = 2000;

/// Conta as linhas que saíram do topo do scrollback (descartadas). Com isso
/// cada linha física ganha um índice absoluto monotônico, o que permite marcar
/// "a partir daqui" no instante da entrega de um prompt.
#[derive(Default)]
pub struct Evictions {
    count: u64,
}

impl vt100::Callbacks for Evictions {
    fn on_scroll(&mut self, _contents: RowContents<'_>, alternate_screen: bool) {
        if !alternate_screen {
            self.count += 1;
        }
    }
}

fn nz(v: u16) -> NonZeroU16 {
    NonZeroU16::new(v.max(1)).unwrap_or(NonZeroU16::MIN)
}

pub struct ScreenModel {
    parser: vt100::Parser<Evictions>,
}

impl ScreenModel {
    pub fn new(rows: u16, cols: u16) -> Self {
        ScreenModel {
            parser: vt100::Parser::new_with_callbacks(
                nz(rows),
                nz(cols),
                SCROLLBACK_LINES,
                Evictions::default(),
            ),
        }
    }

    pub fn process(&mut self, bytes: &[u8]) {
        self.parser.process(bytes);
    }

    pub fn resize(&mut self, rows: u16, cols: u16) {
        self.parser.set_size(nz(rows), nz(cols));
    }

    /// O app dentro do PTY ligou o modo bracketed paste (DECSET 2004)?
    pub fn bracketed_paste(&self) -> bool {
        self.parser.screen().bracketed_paste()
    }

    pub fn alternate_screen(&self) -> bool {
        self.parser.screen().alternate_screen()
    }

    fn evicted(&self) -> u64 {
        self.parser.callbacks().count
    }

    /// Índice absoluto da linha onde o cursor está agora. Guardado no instante
    /// da entrega de um prompt para recortar "só o que veio depois".
    pub fn mark(&self) -> u64 {
        let screen = self.parser.screen();
        let (row, _) = screen.cursor_position();
        self.evicted() + screen.scrollback_len() as u64 + u64::from(row)
    }

    /// Todas as linhas físicas (scrollback + tela), com a flag de quebra
    /// automática. Restaura a visão para a tela ao vivo no fim.
    fn physical_rows(&mut self) -> Vec<(String, bool)> {
        let screen = self.parser.screen_mut();
        let (rows, cols) = screen.size();
        let (rows, cols) = (usize::from(rows.get()), cols.get());
        let sb = screen.scrollback_len();
        let mut out = Vec::with_capacity(sb + rows);
        let mut taken = 0usize;
        while taken < sb {
            // Com offset k, as linhas visíveis começam em scrollback[len - k].
            screen.set_scrollback(sb - taken);
            let n = rows.min(sb - taken);
            let texts: Vec<String> = screen.rows(0, cols).take(n).collect();
            for (i, t) in texts.into_iter().enumerate() {
                let wrapped = screen.row_wrapped(i as u16);
                out.push((t, wrapped));
            }
            taken += n;
        }
        screen.set_scrollback(0);
        let texts: Vec<String> = screen.rows(0, cols).collect();
        for (i, t) in texts.into_iter().enumerate() {
            let wrapped = screen.row_wrapped(i as u16);
            out.push((t, wrapped));
        }
        out
    }

    /// Texto limpo (scrollback + tela), cortado nos últimos `max_bytes`.
    pub fn screen_text(&mut self, max_bytes: usize) -> String {
        let rows = self.physical_rows();
        tail_bytes(join_rows(&rows).trim_start_matches('\n'), max_bytes)
    }

    /// Só a tela visível agora (sem scrollback).
    pub fn visible_text(&self) -> String {
        let screen = self.parser.screen();
        let (_, cols) = screen.size();
        let texts: Vec<String> = screen.rows(0, cols.get()).collect();
        let rows: Vec<(String, bool)> = texts
            .into_iter()
            .enumerate()
            .map(|(i, t)| {
                let wrapped = screen.row_wrapped(i as u16);
                (t, wrapped)
            })
            .collect();
        join_rows(&rows).trim_start_matches('\n').to_string()
    }

    /// Texto produzido a partir da linha absoluta `mark` (ver [`Self::mark`]).
    /// Na tela alternativa (TUIs em tela cheia) não há histórico: devolve a
    /// tela visível.
    pub fn lines_since(&mut self, mark: u64) -> String {
        if self.alternate_screen() {
            return self.visible_text();
        }
        let first_abs = self.evicted();
        let rows = self.physical_rows();
        let skip = mark.saturating_sub(first_abs) as usize;
        if skip >= rows.len() {
            return String::new();
        }
        join_rows(&rows[skip..])
            .trim_start_matches('\n')
            .to_string()
    }

    /// (linhas acima do cursor, prefixo da linha do cursor até a coluna dele).
    /// Pega até 2 linhas acima, para prompts que quebraram dentro da caixa.
    fn before_cursor_parts(&self) -> (String, String) {
        let screen = self.parser.screen();
        let (row, col) = screen.cursor_position();
        let (_, cols) = screen.size();
        let start = row.saturating_sub(2);
        let mut above = String::new();
        let mut current = String::new();
        for (i, t) in screen
            .rows(0, cols.get())
            .enumerate()
            .skip(usize::from(start))
            .take(usize::from(row - start) + 1)
        {
            if i == usize::from(row) {
                current = t.chars().take(usize::from(col)).collect();
            } else {
                above.push_str(t.trim_end());
                above.push('\n');
            }
        }
        (above, current)
    }

    /// Texto imediatamente antes do cursor (linha atual + até 2 acima).
    #[cfg(test)]
    pub fn text_before_cursor(&self) -> String {
        let (above, current) = self.before_cursor_parts();
        format!("{above}{current}")
    }

    /// O prompt entregue ainda está parado na caixa de input? Usado para
    /// decidir se vale mandar mais um Enter.
    pub fn input_still_has(&self, prompt: &str) -> bool {
        let (above, current) = self.before_cursor_parts();
        let cur_sq = squash(&current);
        // Claude Code mostra colagens longas como "[Pasted text #1 +N lines]".
        if cur_sq.contains("[Pastedtext") {
            return true;
        }
        let last_line = prompt
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("");
        let tail = last_chars(&squash(last_line), 16);
        if tail.chars().count() < 3 {
            return false;
        }
        let before = format!("{}{}", squash(&above), cur_sq);
        before.ends_with(&tail)
    }

    /// Hash FNV-1a das linhas visíveis, ignorando glifos de spinner e espaços
    /// finais (e as 3 primeiras linhas quando a tela tem ≥12, onde costumam
    /// ficar barras de status). Animação não conta como conteúdo novo.
    pub fn screen_hash(&self) -> u64 {
        let screen = self.parser.screen();
        let (rows, cols) = screen.size();
        let skip = if rows.get() >= 12 { 3 } else { 0 };
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        let mut feed = |b: u8| {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x0100_0000_01b3);
        };
        for line in screen.rows(0, cols.get()).skip(skip) {
            for ch in line.trim_end().chars().filter(|c| !is_spinner(*c)) {
                let mut buf = [0u8; 4];
                for b in ch.encode_utf8(&mut buf).as_bytes() {
                    feed(*b);
                }
            }
            feed(b'\n');
        }
        h
    }
}

/// Glifos usados por spinners de TUIs (braille e os "asteriscos" do Claude Code).
fn is_spinner(c: char) -> bool {
    matches!(c, '\u{2800}'..='\u{28FF}')
        || matches!(
            c,
            '✻' | '✽'
                | '✶'
                | '✳'
                | '✢'
                | '·'
                | '◐'
                | '◓'
                | '◑'
                | '◒'
                | '◴'
                | '◷'
                | '◶'
                | '◵'
        )
}

/// Remove todo espaço em branco (para comparar texto que a TUI quebrou/indentou).
fn squash(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}

fn last_chars(s: &str, n: usize) -> String {
    let v: Vec<char> = s.chars().collect();
    v[v.len().saturating_sub(n)..].iter().collect()
}

/// Junta linhas físicas em texto: linhas com quebra automática continuam na
/// mesma linha lógica; as demais perdem os espaços finais.
pub fn join_rows(rows: &[(String, bool)]) -> String {
    let mut out = String::new();
    for (text, wrapped) in rows {
        if *wrapped {
            out.push_str(text);
        } else {
            out.push_str(text.trim_end());
            out.push('\n');
        }
    }
    out.trim_end().to_string()
}

/// Últimos `max` bytes de `s`, começando numa fronteira de linha quando possível.
pub fn tail_bytes(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut cut = s.len() - max;
    while cut < s.len() && !s.is_char_boundary(cut) {
        cut += 1;
    }
    // Prefere começar numa linha inteira, se houver uma quebra logo adiante.
    if let Some(nl) = s[cut..].find('\n') {
        if nl < 400 {
            cut += nl + 1;
        }
    }
    format!("…(início cortado)\n{}", &s[cut..])
}

/// Recorta a saída do `ask`: descarta tudo até o eco do fim do prompt (a TUI
/// costuma repetir o prompt no histórico) e o resto daquela linha.
/// Compara sem espaços, porque a TUI quebra e indenta o eco.
pub fn cut_after_prompt(text: &str, prompt: &str) -> String {
    let key = last_chars(&squash(prompt), 24);
    if key.chars().count() < 4 {
        return text.to_string();
    }
    let mut squashed = String::with_capacity(text.len());
    // Para cada byte de `squashed`, o offset em `text` logo após aquele char.
    let mut end_of: Vec<usize> = Vec::with_capacity(text.len());
    for (i, c) in text.char_indices() {
        if !c.is_whitespace() {
            squashed.push(c);
            for _ in 0..c.len_utf8() {
                end_of.push(i + c.len_utf8());
            }
        }
    }
    let Some(pos) = squashed.find(&key) else {
        return text.to_string();
    };
    let last_byte = pos + key.len() - 1;
    let Some(&after) = end_of.get(last_byte) else {
        return text.to_string();
    };
    let rest = &text[after..];
    let rest = match rest.find('\n') {
        Some(nl) => &rest[nl + 1..],
        None => "",
    };
    rest.trim_start_matches('\n').to_string()
}

/// Remove a "moldura" da caixa de input que TUIs como o Claude Code desenham
/// no rodapé (borda `╭─…` ou linha só de `─`) — não faz parte da resposta.
pub fn strip_input_chrome(text: &str) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let start = lines.len().saturating_sub(12);
    let is_border = |l: &str| {
        let t = l.trim();
        t.starts_with('╭') || (t.chars().count() >= 10 && t.chars().all(|c| c == '─' || c == '━'))
    };
    let cut = (start..lines.len()).find(|&i| is_border(lines[i]));
    match cut {
        Some(i) => lines[..i].join("\n").trim_end().to_string(),
        None => text.trim_end().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_text_and_cursor() {
        let mut s = ScreenModel::new(5, 20);
        s.process(b"ola\r\nmundo");
        assert_eq!(s.visible_text(), "ola\nmundo");
        assert_eq!(s.text_before_cursor(), "ola\nmundo");
    }

    #[test]
    fn strips_ansi() {
        let mut s = ScreenModel::new(5, 30);
        s.process(b"\x1b[31mvermelho\x1b[0m \x1b[1mnegrito\x1b[0m");
        assert_eq!(s.visible_text(), "vermelho negrito");
    }

    #[test]
    fn bracketed_paste_mode() {
        let mut s = ScreenModel::new(5, 20);
        assert!(!s.bracketed_paste());
        s.process(b"\x1b[?2004h");
        assert!(s.bracketed_paste());
        s.process(b"\x1b[?2004l");
        assert!(!s.bracketed_paste());
    }

    #[test]
    fn lines_since_mark_with_scroll() {
        let mut s = ScreenModel::new(3, 20);
        s.process(b"a\r\nb\r\nc\r\n");
        let mark = s.mark();
        s.process(b"d\r\ne\r\nf\r\ng");
        let since = s.lines_since(mark);
        assert_eq!(since, "d\ne\nf\ng");
        let all = s.screen_text(10_000);
        assert_eq!(all, "a\nb\nc\nd\ne\nf\ng");
    }

    #[test]
    fn hash_ignores_spinner() {
        let mut a = ScreenModel::new(4, 30);
        let mut b = ScreenModel::new(4, 30);
        a.process("✻ Pensando".as_bytes());
        b.process("✽ Pensando".as_bytes());
        assert_eq!(a.screen_hash(), b.screen_hash());
        b.process(b" mais");
        assert_ne!(a.screen_hash(), b.screen_hash());
    }

    #[test]
    fn input_still_has_prompt() {
        let mut s = ScreenModel::new(5, 40);
        s.process(b"> faca o teste agora");
        assert!(s.input_still_has("faca o teste agora"));
        s.process(b"\r\n> ");
        assert!(!s.input_still_has("faca o teste agora"));
    }

    #[test]
    fn cut_after_prompt_echo() {
        let prompt = "implemente a funcao soma e rode os testes";
        let out = "> implemente a funcao soma e\n  rode os testes\n\nFeito: criei soma() e os testes passaram.";
        assert_eq!(
            cut_after_prompt(out, prompt),
            "Feito: criei soma() e os testes passaram."
        );
        // Sem eco: devolve tudo.
        assert_eq!(cut_after_prompt("resposta", prompt), "resposta");
    }

    #[test]
    fn strip_chrome() {
        let text =
            "resposta final\n\n────────────────────\n> \n────────────────────\n  ? for shortcuts";
        assert_eq!(strip_input_chrome(text), "resposta final");
        assert_eq!(strip_input_chrome("sem moldura"), "sem moldura");
    }

    #[test]
    fn tail_cuts_at_line() {
        let s = "linha1\nlinha2\nlinha3";
        let t = tail_bytes(s, 10);
        assert!(t.ends_with("linha3"));
        assert!(t.starts_with("…"));
    }
}
