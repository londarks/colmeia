// `ask` bloqueante (F2), ask-back e quebra de deadlock (F5), `--raw` (F11).
//
// Fluxo de um `ask` A→B:
// 1. Ask-back: se B está esperando uma resposta de A (ask B→A pendente), esta
//    mensagem É a resposta. O ask de B é resolvido com um aviso e a mensagem
//    chega inteira no terminal de B como um novo prompt. O `ask` de A volta na hora.
// 2. Deadlock: se B espera (direta ou indiretamente) por A, o ask da cadeia
//    que espera por A é liberado com um aviso, e o ask de A segue normalmente.
// 3. Normal: registra o ask em voo, entrega pela fila (delivery.rs), espera o
//    turno de B terminar (activity.rs) e devolve SÓ o texto produzido desde a
//    entrega (recortado e limitado).
// Toda mudança na lista emite `colmeia://asks-in-flight`.

use std::collections::HashSet;
use std::sync::atomic::Ordering;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;

use crate::activity::{AgentState, TurnEnd};
use crate::pty::Shared;
use crate::screen;

/// Como um ask pendente foi resolvido por fora.
pub enum AskSignal {
    /// O alvo respondeu com um `ask` de volta (título de quem respondeu).
    AnsweredBy(String),
    /// Liberado para evitar deadlock (título de quem está mandando mensagem).
    Released(String),
}

pub struct PendingAsk {
    pub id: u64,
    pub from: String,
    pub to: String,
    tx: Sender<AskSignal>,
}

#[derive(Clone, Serialize)]
struct AskPair {
    from: String,
    to: String,
}

#[derive(Clone, Serialize)]
struct AsksInFlight {
    asks: Vec<AskPair>,
}

/// Resultado de um ask: `warn` = terminou de um jeito que pede atenção
/// (a CLI sai com código 2); `code` ≥ 400 = erro (CLI sai com 1).
pub struct AskReply {
    pub code: u16,
    pub body: String,
    pub warn: bool,
}

impl AskReply {
    fn ok(body: String) -> Self {
        AskReply {
            code: 200,
            body,
            warn: false,
        }
    }
    fn warn(body: String) -> Self {
        AskReply {
            code: 200,
            body,
            warn: true,
        }
    }
    fn err(code: u16, body: String) -> Self {
        AskReply {
            code,
            body,
            warn: false,
        }
    }
}

pub struct AskOptions {
    pub timeout: Duration,
    pub max_bytes: usize,
}

impl Default for AskOptions {
    fn default() -> Self {
        AskOptions {
            timeout: Duration::from_secs(30 * 60),
            max_bytes: 16_000,
        }
    }
}

/// Encontra o ask a liberar para quebrar um ciclo: existe uma cadeia de asks
/// pendentes de `target` até `source`? Devolve o id do ask da cadeia que
/// espera por `source`. (Funções puras para teste.)
pub fn cycle_breaker(pending: &[(u64, String, String)], source: &str, target: &str) -> Option<u64> {
    let mut reach: HashSet<String> = HashSet::new();
    reach.insert(target.to_string());
    let mut grew = true;
    while grew {
        grew = false;
        for (_, from, to) in pending {
            if reach.contains(from) && !reach.contains(to) && to != source {
                reach.insert(to.clone());
                grew = true;
            }
        }
    }
    pending
        .iter()
        .find(|(_, from, to)| to == source && reach.contains(from))
        .map(|(id, _, _)| *id)
}

/// Monta o texto devolvido pelo ask a partir do trecho da tela desde a entrega.
pub fn build_reply(since: &str, prompt: &str, max_bytes: usize) -> String {
    let cut = screen::cut_after_prompt(since, prompt);
    let clean = screen::strip_input_chrome(&cut);
    screen::tail_bytes(clean.trim(), max_bytes)
}

impl Shared {
    fn emit_asks(&self) {
        let asks: Vec<AskPair> = self
            .asks
            .lock()
            .unwrap()
            .iter()
            .map(|a| AskPair {
                from: a.from.clone(),
                to: a.to.clone(),
            })
            .collect();
        self.emit("colmeia://asks-in-flight", AsksInFlight { asks });
    }

    fn register_ask(&self, from: &str, to: &str) -> (u64, Receiver<AskSignal>) {
        let id = self.ask_seq.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = mpsc::channel();
        self.asks.lock().unwrap().push(PendingAsk {
            id,
            from: from.to_string(),
            to: to.to_string(),
            tx,
        });
        self.emit_asks();
        (id, rx)
    }

    fn unregister_ask(&self, id: u64) {
        self.asks.lock().unwrap().retain(|a| a.id != id);
        self.emit_asks();
    }

    /// Retira os asks pendentes que satisfazem `pred`.
    fn take_asks(&self, pred: impl Fn(&PendingAsk) -> bool) -> Vec<PendingAsk> {
        let mut asks = self.asks.lock().unwrap();
        let mut taken = Vec::new();
        let mut i = 0;
        while i < asks.len() {
            if pred(&asks[i]) {
                taken.push(asks.remove(i));
            } else {
                i += 1;
            }
        }
        taken
    }

    /// Mensagem framed: o alvo sabe quem pediu (para responder com ask-back).
    /// Num shell puro o prefixo quebraria o comando, então vai o texto cru.
    fn frame(&self, target: &str, from_title: &str, prompt: &str) -> String {
        let is_shell = self
            .node(target)
            .map(|n| n.agent == "shell")
            .unwrap_or(false);
        if is_shell {
            prompt.to_string()
        } else {
            format!("[colmeia · de \"{from_title}\"] {prompt}")
        }
    }

    /// `ask` completo de `source` para `target` (ids já resolvidos com escopo).
    pub fn ask_blocking(
        self: &Arc<Self>,
        source: &str,
        target: &str,
        prompt: &str,
        opts: &AskOptions,
    ) -> AskReply {
        let src_title = self.title_of(source);
        let tgt_title = self.title_of(target);

        // 1) Ask-back: o alvo está esperando por mim → isto é a resposta.
        let backs = self.take_asks(|a| a.from == target && a.to == source);
        if !backs.is_empty() {
            for a in &backs {
                let _ = a.tx.send(AskSignal::AnsweredBy(src_title.clone()));
            }
            self.emit_asks();
            let msg = format!("[colmeia · resposta de \"{src_title}\"]\n{prompt}");
            return match self.deliver(target, &msg) {
                Ok(_) => AskReply::ok(format!(
                    "Entregue a \"{tgt_title}\" como resposta ao ask que ele fez a você. \
Ele recebe a mensagem inteira como um novo prompt."
                )),
                Err(e) => {
                    AskReply::err(409, format!("Não consegui entregar a \"{tgt_title}\": {e}"))
                }
            };
        }

        // 2) Deadlock: o alvo espera (em cadeia) por mim → libera quem espera por mim.
        let pending: Vec<(u64, String, String)> = self
            .asks
            .lock()
            .unwrap()
            .iter()
            .map(|a| (a.id, a.from.clone(), a.to.clone()))
            .collect();
        let released = cycle_breaker(&pending, source, target);
        if let Some(release) = released {
            for a in self.take_asks(|a| a.id == release) {
                let _ = a.tx.send(AskSignal::Released(src_title.clone()));
            }
            self.emit_asks();
        }

        // 3) Normal.
        let Some(io) = self.session_io(target) else {
            return AskReply::err(
                409,
                format!("\"{tgt_title}\" não tem um processo rodando. Peça ao usuário para reabrir o terminal."),
            );
        };
        self.wait_booted(target, Duration::from_secs(20));

        // Se o alvo está no meio de um turno, espera ele terminar antes de entregar
        // (senão o fim do turno ATUAL seria confundido com a resposta). Depois de
        // liberar um deadlock, não espera: o alvo está justamente aguardando esta mensagem.
        if released.is_none() && self.activity_snapshot(target).state == AgentState::Working {
            let seq = self.activity_snapshot(target).turn_seq;
            if let TurnEnd::Timeout =
                self.wait_turn(target, seq, io.generation, opts.timeout / 2, None)
            {
                return AskReply::warn(format!(
                    "aviso: \"{tgt_title}\" continua ocupado com outra tarefa; não entreguei o prompt. \
Use `colmeia check \"{tgt_title}\"` e tente depois."
                ));
            }
        }

        let (ask_id, rx) = self.register_ask(source, target);
        let seq0 = self.activity_snapshot(target).turn_seq;
        let mark = match self.deliver(target, &self.frame(target, &src_title, prompt)) {
            Ok(m) => m,
            Err(e) => {
                self.unregister_ask(ask_id);
                return AskReply::err(409, format!("Não consegui entregar a \"{tgt_title}\": {e}"));
            }
        };
        let outcome = self.wait_turn(target, seq0, io.generation, opts.timeout, Some(&rx));
        self.unregister_ask(ask_id);

        let since = || io.screen.lock().unwrap().lines_since(mark);
        match outcome {
            TurnEnd::Done { saw_work } => {
                let text = build_reply(&since(), prompt, opts.max_bytes);
                if saw_work {
                    if text.is_empty() {
                        AskReply::ok(format!("(\"{tgt_title}\" terminou sem produzir texto novo)"))
                    } else {
                        AskReply::ok(text)
                    }
                } else {
                    AskReply::warn(format!(
                        "aviso: não vi \"{tgt_title}\" trabalhar depois da entrega — talvez o prompt não tenha sido processado. \
Confira com `colmeia check \"{tgt_title}\"` antes de reenviar.\n\n{text}"
                    ))
                }
            }
            TurnEnd::Attention(reason) => {
                let screen_now = self.visible_text(target).unwrap_or_default();
                let why = if reason.is_empty() { String::new() } else { format!(" ({reason})") };
                AskReply::warn(format!(
                    "aviso: \"{tgt_title}\" parou pedindo atenção{why}. Tela atual:\n{}\n\n\
Se for um menu, responda com `colmeia ask \"{tgt_title}\" --raw \"1\\n\"` — ou avise o usuário.",
                    screen::tail_bytes(&screen_now, 4000)
                ))
            }
            TurnEnd::Exited => {
                let last = since();
                AskReply::warn(format!(
                    "aviso: \"{tgt_title}\" encerrou. Última tela:\n{}",
                    screen::tail_bytes(last.trim(), opts.max_bytes)
                ))
            }
            TurnEnd::Restarted => AskReply::err(
                409,
                format!("\"{tgt_title}\" reiniciou durante o ask, então a mensagem se perdeu. Mande de novo se ainda fizer sentido."),
            ),
            TurnEnd::Timeout => AskReply::warn(format!(
                "aviso: \"{tgt_title}\" ainda está trabalhando depois de {}s. NÃO reenvie o prompt: \
acompanhe com `colmeia check \"{tgt_title}\"` ou espere com `colmeia wait \"{tgt_title}\"`.",
                opts.timeout.as_secs()
            )),
            TurnEnd::Signal(AskSignal::AnsweredBy(who)) => AskReply::ok(format!(
                "\"{who}\" respondeu com uma mensagem direta (ask-back). Ela chega inteira no seu terminal \
como um novo prompt — trate-a como a resposta deste ask."
            )),
            TurnEnd::Signal(AskSignal::Released(who)) => AskReply::warn(format!(
                "aviso: liberando este ask para evitar deadlock — \"{who}\" está mandando mensagem para você \
e AINDA NÃO terminou a tarefa. Responda a ele; o resultado vem depois."
            )),
        }
    }

    /// `ask --no-wait`: só entrega (modo antigo).
    pub fn ask_no_wait(&self, source: &str, target: &str, prompt: &str) -> AskReply {
        let src_title = self.title_of(source);
        let tgt_title = self.title_of(target);
        match self.deliver(target, &self.frame(target, &src_title, prompt)) {
            Ok(_) => AskReply::ok(format!("Prompt entregue a \"{tgt_title}\".")),
            Err(e) => AskReply::err(409, format!("Não consegui entregar a \"{tgt_title}\": {e}")),
        }
    }

    /// `ask --raw`: teclas cruas (com escapes já decodificados), sem Enter
    /// automático; devolve a tela resultante.
    pub fn ask_raw(&self, target: &str, bytes: &[u8]) -> AskReply {
        let tgt_title = self.title_of(target);
        if let Err(e) = self.deliver_raw(target, bytes) {
            return AskReply::err(409, format!("Não consegui enviar a \"{tgt_title}\": {e}"));
        }
        self.wait_screen_stable(target, Duration::from_millis(500), Duration::from_secs(5));
        let text = self.visible_text(target).unwrap_or_default();
        AskReply::ok(screen::tail_bytes(&text, 8000))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(id: u64, from: &str, to: &str) -> (u64, String, String) {
        (id, from.into(), to.into())
    }

    #[test]
    fn direct_cycle_releases_ask_waiting_on_source() {
        // B espera por A; A agora pergunta a B → libera o ask B→A.
        let pending = vec![p(1, "b", "a")];
        assert_eq!(cycle_breaker(&pending, "a", "b"), Some(1));
    }

    #[test]
    fn indirect_cycle() {
        // B → C → A pendentes; A pergunta a B → libera C→A.
        let pending = vec![p(1, "b", "c"), p(2, "c", "a")];
        assert_eq!(cycle_breaker(&pending, "a", "b"), Some(2));
    }

    #[test]
    fn no_cycle() {
        let pending = vec![p(1, "a", "c"), p(2, "c", "d")];
        assert_eq!(cycle_breaker(&pending, "a", "b"), None);
    }

    #[test]
    fn reply_is_cut_and_cleaned() {
        let prompt = "liste os arquivos alterados";
        let since = "> [colmeia · de \"Chefe\"] liste os arquivos\n  alterados\n\n● src/a.rs\n● src/b.rs\n\n────────────────────\n> \n────────────────────";
        assert_eq!(build_reply(since, prompt, 16_000), "● src/a.rs\n● src/b.rs");
    }
}
