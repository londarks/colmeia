mod floors;
mod ombro;
mod orchestrator;
mod pty;
mod workspace;

use pty::PtyState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
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
            pty::pty_submit,
            pty::pty_resize,
            pty::pty_kill,
            pty::set_graph,
            pty::routines_list,
            pty::routine_create,
            pty::routine_delete,
            pty::approval_resolve,
            workspace::workspaces_list,
            workspace::workspace_save,
            workspace::workspace_load,
            workspace::workspace_create,
            workspace::workspace_rename,
            workspace::workspace_delete,
            workspace::workspace_set_active,
            floors::floor_list,
            floors::floor_create,
            floors::floor_remove,
            ombro::ombro_analyze,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
