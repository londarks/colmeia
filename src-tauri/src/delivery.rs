// Entrega robusta de prompt (F3).
//
// - Uma fila (mutex) por terminal: entregas concorrentes nunca se intercalam.
// - Se o app ligou o modo bracketed paste (lido do modelo de tela), o corpo vai
//   entre ESC[200~ … ESC[201~ — prompts multilinha não submetem no 1º "\n".
//   Sem o modo, as linhas vão uma a uma.
// - Depois do Enter, confere pela tela se o prompt ainda está parado na caixa
//   de input; se estiver, manda outro Enter (até 3 tentativas).
// - Se o humano digitou nesse terminal durante a entrega, aborta os Enters de
//   confirmação (não brigamos com quem está no teclado).

use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::pty::{SessionIo, Shared};

const PASTE_START: &str = "\x1b[200~";
const PASTE_END: &str = "\x1b[201~";

impl Shared {
    /// Registra que o humano digitou (vindo do xterm do canvas). Respostas
    /// automáticas do terminal a consultas (posição do cursor, atributos,
    /// foco, OSC) não contam como digitação.
    pub fn note_human_input(&self, id: &str, data: &str) {
        if is_terminal_reply(data) {
            return;
        }
        if let Some(io) = self.session_io(id) {
            *io.last_human_input.lock().unwrap() = Some(Instant::now());
        }
    }

    /// Entrega `text` como um prompt no terminal `id` e devolve a marca de
    /// tela (linha absoluta do cursor) do instante da entrega — usada pelo
    /// `ask` para recortar só o que veio depois.
    pub fn deliver(&self, id: &str, text: &str) -> Result<u64, String> {
        let io = self
            .session_io(id)
            .ok_or_else(|| "A sessão desse terminal não está ativa.".to_string())?;
        let _queue = io.deliver_lock.lock().unwrap_or_else(|p| p.into_inner());
        let started = Instant::now();
        let (mark, paste) = {
            let screen = io.screen.lock().unwrap();
            (screen.mark(), screen.bracketed_paste())
        };
        let body = normalize_newlines(text);

        if paste {
            if !self.write_to(id, &format!("{PASTE_START}{body}{PASTE_END}")) {
                return Err("A sessão encerrou durante a entrega.".into());
            }
        } else {
            for (i, line) in body.split('\n').enumerate() {
                if i > 0 {
                    self.write_to(id, "\r");
                    std::thread::sleep(Duration::from_millis(60));
                }
                if !self.write_to(id, line) {
                    return Err("A sessão encerrou durante a entrega.".into());
                }
            }
        }

        // Enter SEPARADO: TUIs tratam texto+Enter juntos como colagem.
        std::thread::sleep(Duration::from_millis(120));
        self.write_to(id, "\r");

        for _ in 0..3 {
            std::thread::sleep(Duration::from_millis(350));
            if human_typed_since(&io, started) {
                break;
            }
            let pending = io.screen.lock().unwrap().input_still_has(&body);
            if !pending {
                break;
            }
            self.write_to(id, "\r");
        }
        Ok(mark)
    }

    /// Escreve bytes crus (teclas) sem Enter automático, respeitando a fila.
    pub fn deliver_raw(&self, id: &str, bytes: &[u8]) -> Result<(), String> {
        let io = self
            .session_io(id)
            .ok_or_else(|| "A sessão desse terminal não está ativa.".to_string())?;
        let _queue = io.deliver_lock.lock().unwrap_or_else(|p| p.into_inner());
        if self.write_bytes(id, bytes) {
            Ok(())
        } else {
            Err("A sessão encerrou durante a entrega.".into())
        }
    }

    /// Espera a tela ficar estável por `quiet` (máx. `max`) — usado depois de
    /// teclas cruas para devolver a tela resultante.
    pub fn wait_screen_stable(&self, id: &str, quiet: Duration, max: Duration) {
        let Some(io) = self.session_io(id) else {
            return;
        };
        let start = Instant::now();
        let mut last = io.screen.lock().unwrap().screen_hash();
        let mut stable_since = Instant::now();
        while start.elapsed() < max {
            std::thread::sleep(Duration::from_millis(100));
            let h = io.screen.lock().unwrap().screen_hash();
            if h != last {
                last = h;
                stable_since = Instant::now();
            } else if stable_since.elapsed() >= quiet {
                return;
            }
        }
    }

    /// Espera o agente terminar de subir: já desenhou algo e ficou quieto um
    /// instante (ou `max` estourou). Evita digitar num TUI que ainda está bootando.
    pub fn wait_booted(&self, id: &str, max: Duration) {
        let start = Instant::now();
        while start.elapsed() < max {
            let Some(io) = self.session_io(id) else {
                return;
            };
            let drew = io.bytes_total.load(std::sync::atomic::Ordering::Relaxed) > 0;
            let quiet = io.last_output.lock().unwrap().elapsed() >= Duration::from_millis(800);
            if drew && quiet && io.started.elapsed() >= Duration::from_millis(1500) {
                return;
            }
            std::thread::sleep(Duration::from_millis(150));
        }
    }
}

fn human_typed_since(io: &Arc<SessionIo>, since: Instant) -> bool {
    io.last_human_input
        .lock()
        .unwrap()
        .map(|t| t > since)
        .unwrap_or(false)
}

fn normalize_newlines(text: &str) -> String {
    text.replace("\r\n", "\n")
        .replace('\r', "\n")
        .trim_end_matches('\n')
        .to_string()
}

/// Respostas automáticas do terminal (não são digitação humana):
/// CPR `ESC[12;5R`, DA `ESC[?1;2c`, DSR `ESC[0n`, foco `ESC[I`/`ESC[O`, OSC `ESC]…`.
fn is_terminal_reply(data: &str) -> bool {
    if data.starts_with("\x1b]") || data.starts_with("\x1bP") {
        return true;
    }
    if let Some(rest) = data.strip_prefix("\x1b[") {
        if let Some(last) = rest.chars().last() {
            let body = &rest[..rest.len() - last.len_utf8()];
            let params_ok = body
                .chars()
                .all(|c| c.is_ascii_digit() || matches!(c, ';' | '?' | '>' | '='));
            return params_ok && matches!(last, 'R' | 'c' | 'n' | 'I' | 'O');
        }
    }
    false
}

/// Decodifica os escapes do `ask --raw` em bytes:
/// `\n`/`\r` Enter, `\t` Tab, `\e` ESC, `\xNN` byte, `\\` barra, `\0` NUL.
/// Qualquer outro `\c` fica literal.
pub fn decode_escapes(s: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b != b'\\' || i + 1 >= bytes.len() {
            out.push(b);
            i += 1;
            continue;
        }
        let next = bytes[i + 1];
        match next {
            b'n' | b'r' => {
                out.push(b'\r');
                i += 2;
            }
            b't' => {
                out.push(b'\t');
                i += 2;
            }
            b'e' => {
                out.push(0x1b);
                i += 2;
            }
            b'0' => {
                out.push(0);
                i += 2;
            }
            b'\\' => {
                out.push(b'\\');
                i += 2;
            }
            b'x' => {
                let hex = s
                    .get(i + 2..i + 4)
                    .and_then(|h| u8::from_str_radix(h, 16).ok());
                match hex {
                    Some(v) => {
                        out.push(v);
                        i += 4;
                    }
                    None => {
                        out.push(b'\\');
                        i += 1;
                    }
                }
            }
            _ => {
                out.push(b'\\');
                i += 1;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_escapes() {
        assert_eq!(decode_escapes("2\\n"), b"2\r".to_vec());
        assert_eq!(decode_escapes("\\e[A\\e[Z"), b"\x1b[A\x1b[Z".to_vec());
        assert_eq!(decode_escapes("\\x03"), vec![3u8]);
        assert_eq!(decode_escapes("a\\tb"), b"a\tb".to_vec());
        assert_eq!(decode_escapes("C:\\\\dir"), b"C:\\dir".to_vec());
        // Escape desconhecido / incompleto fica literal.
        assert_eq!(decode_escapes("\\q"), b"\\q".to_vec());
        assert_eq!(decode_escapes("\\xZZ"), b"\\xZZ".to_vec());
        assert_eq!(decode_escapes("fim\\"), b"fim\\".to_vec());
        assert_eq!(decode_escapes("ação"), "ação".as_bytes().to_vec());
    }

    #[test]
    fn terminal_replies_are_not_human() {
        assert!(is_terminal_reply("\x1b[12;5R"));
        assert!(is_terminal_reply("\x1b[?1;2c"));
        assert!(is_terminal_reply("\x1b[I"));
        assert!(is_terminal_reply("\x1b]11;rgb:0000/0000/0000\x1b\\"));
        assert!(!is_terminal_reply("a"));
        assert!(!is_terminal_reply("\x1b[A")); // seta pra cima = humano
        assert!(!is_terminal_reply("\r"));
    }

    #[test]
    fn newlines_normalized() {
        assert_eq!(normalize_newlines("a\r\nb\rc\n\n"), "a\nb\nc");
    }
}
