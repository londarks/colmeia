// Keep-awake: impede o PC de dormir enquanto algum agente está trabalhando.
//
// O bloqueio vive numa thread dedicada (dona do `KeepAwake`), controlada por um
// canal. Assim não dependemos de o handle ser Send/Sync e, no Windows, o
// `SetThreadExecutionState` fica preso a uma thread que vive o app inteiro
// (os comandos do Tauri podem rodar em threads diferentes a cada chamada).

use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;

pub struct PowerState {
    tx: Mutex<Sender<bool>>,
}

impl PowerState {
    pub fn new() -> Self {
        let (tx, rx) = channel::<bool>();
        std::thread::Builder::new()
            .name("colmeia-keep-awake".into())
            .spawn(move || {
                let mut guard: Option<keepawake::KeepAwake> = None;
                // Termina sozinha quando o Sender é derrubado (app fechando);
                // derrubar o guard solta o bloqueio.
                while let Ok(on) = rx.recv() {
                    if on && guard.is_none() {
                        match keepawake::Builder::default()
                            .idle(true)
                            .reason("Agentes do colmeia trabalhando")
                            .app_name("colmeia")
                            .app_reverse_domain("app.colmeia")
                            .create()
                        {
                            Ok(g) => guard = Some(g),
                            Err(e) => eprintln!("[colmeia] keep-awake falhou: {e:?}"),
                        }
                    } else if !on {
                        guard = None;
                    }
                }
            })
            .expect("falha ao criar a thread de keep-awake");
        Self { tx: Mutex::new(tx) }
    }
}

/// Liga/desliga o bloqueio de suspensão do sistema.
#[tauri::command]
pub fn keep_awake(state: tauri::State<'_, PowerState>, on: bool) -> Result<(), String> {
    state
        .tx
        .lock()
        .map_err(|e| e.to_string())?
        .send(on)
        .map_err(|e| e.to_string())
}
