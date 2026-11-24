// Estado do agente (F4): working / idle / attention.
//
// Fontes, da mais confiável para a menos:
// 1. Aprovação pendente no painel central → attention.
// 2. Hooks do Claude Code (colmeia-event.js): UserPromptSubmit → working,
//    Stop → idle (fim de turno), Notification de permissão → attention.
//    Guarda contra hook "preso": se o hook diz working mas a tela não muda
//    há HOOK_STALE (ex.: o usuário interrompeu com Esc e o Stop não veio), vira idle.
// 3. Heurística de tela para os demais agentes: houve mudança significativa
//    (hash da tela mudou E passou um limiar de bytes no intervalo) nos
//    últimos QUIET → working; senão idle. Spinner e relógio não contam.
//
// Cada transição para idle incrementa `turn_seq` — é assim que `ask`/`wait`
// sabem que "o turno que começou depois da entrega terminou".
// Toda mudança de estado publicado emite `colmeia://activity`.

use std::sync::atomic::Ordering;
use std::sync::mpsc::Receiver;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::asks::AskSignal;
use crate::pty::{SessionIo, Shared};

const TICK: Duration = Duration::from_millis(250);
const QUIET: Duration = Duration::from_millis(3000);
const HOOK_STALE: Duration = Duration::from_secs(20);
/// Bytes mínimos num tick para uma mudança de tela contar como atividade.
const BYTE_THRESHOLD: u64 = 32;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AgentState {
    Working,
    Idle,
    Attention,
}

impl AgentState {
    pub fn as_str(self) -> &'static str {
        match self {
            AgentState::Working => "working",
            AgentState::Idle => "idle",
            AgentState::Attention => "attention",
        }
    }
}

pub struct Activity {
    pub state: AgentState,
    pub reason: String,
    pub turn_seq: u64,
    hook_state: Option<AgentState>,
    hook_reason: String,
    hook_at: Instant,
    last_hash: u64,
    last_tick_bytes: u64,
    last_change: Instant,
}

impl Activity {
    fn new() -> Self {
        let past = Instant::now()
            .checked_sub(QUIET)
            .unwrap_or_else(Instant::now);
        Activity {
            state: AgentState::Idle,
            reason: String::new(),
            turn_seq: 0,
            hook_state: None,
            hook_reason: String::new(),
            hook_at: past,
            last_hash: 0,
            last_tick_bytes: 0,
            last_change: past,
        }
    }
}

#[derive(Clone, Serialize)]
struct ActivityPayload {
    id: String,
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

/// Como terminou a espera por um turno.
pub enum TurnEnd {
    /// O turno terminou. `saw_work` = vimos o agente trabalhar.
    Done {
        saw_work: bool,
    },
    /// Parou pedindo atenção (menu/permissão na própria TUI).
    Attention(String),
    Exited,
    Restarted,
    Timeout,
    /// O ask foi resolvido por fora (ask-back ou quebra de deadlock).
    Signal(AskSignal),
}

/// Retrato do estado de um nó.
pub struct Snapshot {
    pub state: AgentState,
    pub turn_seq: u64,
    pub reason: String,
}

impl Shared {
    pub(crate) fn reset_activity(&self, id: &str) {
        self.activity
            .lock()
            .unwrap()
            .insert(id.to_string(), Activity::new());
    }

    pub(crate) fn clear_activity(&self, id: &str) {
        self.activity.lock().unwrap().remove(id);
    }

    pub fn activity_snapshot(&self, id: &str) -> Snapshot {
        let map = self.activity.lock().unwrap();
        match map.get(id) {
            Some(a) => Snapshot {
                state: a.state,
                turn_seq: a.turn_seq,
                reason: a.reason.clone(),
            },
            None => Snapshot {
                state: AgentState::Idle,
                turn_seq: 0,
                reason: String::new(),
            },
        }
    }

    /// Thread única que amostra a tela de todas as sessões a cada TICK.
    pub fn start_activity_ticker(self: &Arc<Self>) {
        let shared = Arc::clone(self);
        std::thread::spawn(move || loop {
            std::thread::sleep(TICK);
            for (id, io) in shared.session_list() {
                shared.recompute_activity(&id, &io, true);
            }
        });
    }

    /// Recalcula o estado publicado de um nó (e emite o evento se mudou).
    fn recompute_activity(&self, id: &str, io: &SessionIo, sample: bool) {
        let hash = if sample {
            Some(io.screen.lock().unwrap().screen_hash())
        } else {
            None
        };
        let bytes = io.bytes_total.load(Ordering::Relaxed);
        let pending = self.has_pending_approval(id);
        let exited = io.exited.load(Ordering::Relaxed);

        let changed = {
            let mut map = self.activity.lock().unwrap();
            let a = map.entry(id.to_string()).or_insert_with(Activity::new);
            let now = Instant::now();
            if let Some(h) = hash {
                let delta = bytes.saturating_sub(a.last_tick_bytes);
                if h != a.last_hash && delta >= BYTE_THRESHOLD {
                    a.last_change = now;
                }
                a.last_hash = h;
                a.last_tick_bytes = bytes;
            }
            let (next, reason): (AgentState, String) = if exited {
                (AgentState::Idle, "processo encerrado".into())
            } else if pending {
                (AgentState::Attention, "aguardando aprovação".into())
            } else if let Some(hs) = a.hook_state {
                let stale = hs == AgentState::Working
                    && now.duration_since(a.last_change) > HOOK_STALE
                    && now.duration_since(a.hook_at) > HOOK_STALE;
                if stale {
                    (AgentState::Idle, "tela parada".into())
                } else {
                    (hs, a.hook_reason.clone())
                }
            } else if now.duration_since(a.last_change) < QUIET {
                (AgentState::Working, String::new())
            } else {
                (AgentState::Idle, String::new())
            };
            if next != a.state {
                if next == AgentState::Idle {
                    a.turn_seq += 1;
                }
                a.state = next;
                a.reason = reason.clone();
                Some((next, reason))
            } else {
                None
            }
        };

        if let Some((state, reason)) = changed {
            self.emit(
                "colmeia://activity",
                ActivityPayload {
                    id: id.to_string(),
                    state: state.as_str(),
                    reason: if reason.is_empty() {
                        None
                    } else {
                        Some(reason)
                    },
                },
            );
        }
    }

    /// Evento vindo dos hooks do Claude Code (rota `/event`).
    pub fn hook_event(&self, id: &str, event: &str, kind: &str, message: &str) {
        let next = match event {
            "UserPromptSubmit" => Some((AgentState::Working, String::new())),
            "Stop" => Some((AgentState::Idle, String::new())),
            "Notification" => {
                let msg = message.to_lowercase();
                match kind {
                    "permission_prompt" | "elicitation_dialog" => {
                        Some((AgentState::Attention, message.to_string()))
                    }
                    // "esperando seu input" depois de um tempo ocioso: não muda nada.
                    "idle_prompt" | "auth_success" => None,
                    _ if msg.contains("permission") || msg.contains("permiss") => {
                        Some((AgentState::Attention, message.to_string()))
                    }
                    _ => None,
                }
            }
            _ => None,
        };
        let Some((state, reason)) = next else { return };
        {
            let mut map = self.activity.lock().unwrap();
            let a = map.entry(id.to_string()).or_insert_with(Activity::new);
            let now = Instant::now();
            a.hook_state = Some(state);
            a.hook_reason = reason;
            a.hook_at = now;
            if state == AgentState::Working {
                a.last_change = now;
            }
        }
        if let Some(io) = self.session_io(id) {
            self.recompute_activity(id, &io, false);
        }
    }

    /// Espera o turno que começou depois de `since_seq` terminar.
    /// Respeita aprovação pendente (bloqueado ≠ terminou) e pode ser
    /// interrompida por um sinal de ask (ask-back / deadlock).
    pub fn wait_turn(
        &self,
        id: &str,
        since_seq: u64,
        generation: u64,
        timeout: Duration,
        rx: Option<&Receiver<AskSignal>>,
    ) -> TurnEnd {
        let start = Instant::now();
        // Sem nenhum sinal de trabalho nesse prazo, o agente não reagiu.
        let grace = Duration::from_secs(15);
        let mut saw_work = false;
        let mut attention_since: Option<Instant> = None;
        loop {
            match rx {
                Some(rx) => {
                    if let Ok(sig) = rx.recv_timeout(Duration::from_millis(200)) {
                        return TurnEnd::Signal(sig);
                    }
                }
                None => std::thread::sleep(Duration::from_millis(200)),
            }
            let Some(io) = self.session_io(id) else {
                return TurnEnd::Exited;
            };
            if io.generation != generation {
                return TurnEnd::Restarted;
            }
            if io.exited.load(Ordering::Relaxed) {
                return TurnEnd::Exited;
            }
            let snap = self.activity_snapshot(id);
            match snap.state {
                AgentState::Working => {
                    saw_work = true;
                    attention_since = None;
                }
                AgentState::Attention => {
                    saw_work = true;
                    if self.has_pending_approval(id) {
                        // O humano decide no painel; continuamos esperando.
                        attention_since = None;
                    } else {
                        let t = *attention_since.get_or_insert_with(Instant::now);
                        if t.elapsed() >= Duration::from_millis(1500) {
                            return TurnEnd::Attention(snap.reason);
                        }
                    }
                }
                AgentState::Idle => {
                    attention_since = None;
                    if snap.turn_seq > since_seq {
                        return TurnEnd::Done { saw_work: true };
                    }
                    if !saw_work && start.elapsed() > grace {
                        return TurnEnd::Done { saw_work: false };
                    }
                }
            }
            if start.elapsed() >= timeout {
                return TurnEnd::Timeout;
            }
        }
    }
}
