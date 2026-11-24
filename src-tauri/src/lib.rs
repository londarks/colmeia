mod activity;
mod asks;
mod delivery;
mod dropfiles;
mod floors;
mod ombro;
mod orchestrator;
mod partituras;
mod portal;
mod power;
mod proctree;
mod pty;
mod roles;
mod routines;
mod scope;
mod screen;
mod scrollback;
mod skills;
mod workspace;

use pty::PtyState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(PtyState::new())
        .manage(power::PowerState::new())
        .setup(|app| {
            let shared = app.state::<PtyState>().shared();
            // Handle para emitir eventos ao frontend (criar nota, conectar nós,
            // atividade, asks em voo…) e diretório de dados (papéis).
            shared.set_app(app.handle().clone());
            if let Ok(dir) = app.path().app_data_dir() {
                let _ = std::fs::create_dir_all(&dir);
                shared.set_data_dir(dir);
            }
            // Registro de floors (app_data_dir) + recuperação de operações interrompidas.
            floors::init(app.handle());
            // Scheduler único de rotinas (persistidas em app_data_dir/routines.json).
            routines::init(shared.clone(), app.handle().clone());
            // Servidor loopback da CLI + amostragem de atividade dos terminais.
            orchestrator::start(shared.clone());
            shared.start_activity_ticker();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_submit,
            pty::pty_resize,
            pty::pty_kill,
            pty::set_graph,
            pty::set_presets,
            pty::approval_resolve,
            roles::roles_list,
            routines::routines_list,
            routines::routine_create,
            routines::routine_edit,
            routines::routine_delete,
            routines::routine_set_enabled,
            routines::routine_run,
            routines::routine_preview,
            workspace::workspaces_list,
            workspace::workspace_save,
            workspace::workspace_load,
            workspace::workspace_create,
            workspace::workspace_rename,
            workspace::workspace_delete,
            workspace::workspace_set_active,
            floors::floor_list,
            floors::floor_create,
            floors::floor_inspect,
            floors::floor_remove,
            floors::floor_land_preview,
            floors::floor_land,
            floors::floor_set_status,
            floors::floor_env,
            ombro::ombro_analyze,
            scrollback::scrollback_save,
            scrollback::scrollback_load,
            scrollback::scrollback_delete,
            power::keep_awake,
            partituras::partituras_list,
            partituras::partituras_save,
            partituras::partituras_delete,
            partituras::partituras_export,
            partituras::partituras_import,
            partituras::partituras_set_catalog,
            partituras::partitura_insert_done,
            dropfiles::dropped_file_read,
            portal::portal_attach,
            portal::portal_detach,
            portal::portal_close,
            portal::portal_resize,
            portal::portal_input,
            portal::portal_navigate,
            portal::portal_history,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app, event| {
            // Fechou o app: mata os navegadores headless dos portais.
            if let tauri::RunEvent::Exit = event {
                portal::shutdown_all();
            }
        });
}
