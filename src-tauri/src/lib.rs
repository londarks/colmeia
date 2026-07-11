mod orchestrator;
mod pty;

use pty::PtyState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(PtyState::new())
        .setup(|app| {
            // Sobe o servidor loopback com um AppHandle para poder emitir eventos
            // ao frontend (ex.: criar nota / conectar nós a pedido do agente).
            let shared = app.state::<PtyState>().shared();
            orchestrator::start(shared, app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::set_graph,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
