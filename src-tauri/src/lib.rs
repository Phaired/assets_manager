//! assets_gen — Tauri core. Owns all state + orchestration:
//! config, store (projects/assets/state JSON), job queue, Hunyuan supervisor and
//! the Python worker sidecar. Frontend talks to it via `invoke` / `listen`.

mod commands;
mod config;
mod error;
mod events;
mod jobs;
mod store;
mod supervisor;
mod types;
mod worker;

use std::sync::Arc;
use std::time::Duration;

use crate::config::Config;
use crate::jobs::JobManager;
use crate::store::Store;
use crate::supervisor::Supervisor;
use crate::worker::WorkerClient;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // --- build shared state ---------------------------------------------
    let config = Arc::new(Config::new());
    let store = Arc::new(Store::new(Arc::clone(&config)));
    let supervisor = Arc::new(Supervisor::new(Arc::clone(&config)));
    let worker = Arc::new(
        WorkerClient::new(Arc::clone(&config)).expect("failed to build worker HTTP client"),
    );
    let jobs = JobManager::new(
        Arc::clone(&store),
        Arc::clone(&config),
        Arc::clone(&supervisor),
        Arc::clone(&worker),
    );

    // At startup: stale running/queued stages cannot survive a restart.
    if let Err(e) = store.reset_stale_stages() {
        eprintln!("reset_stale_stages: {e}");
    }

    // Clones moved into setup / exit handlers.
    let worker_for_setup = Arc::clone(&worker);
    let supervisor_for_tick = Arc::clone(&supervisor);
    let jobs_for_setup = Arc::clone(&jobs);

    let worker_for_exit = Arc::clone(&worker);
    let supervisor_for_exit = Arc::clone(&supervisor);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::clone(&config))
        .manage(Arc::clone(&store))
        .manage(Arc::clone(&supervisor))
        .manage(Arc::clone(&worker))
        .manage(Arc::clone(&jobs))
        .setup(move |app| {
            let handle = app.handle().clone();
            // Wire AppHandle into the job manager so it can emit events.
            jobs_for_setup.set_app(handle.clone());

            // Spawn the Python worker sidecar at startup (non-blocking).
            let worker_setup = Arc::clone(&worker_for_setup);
            std::thread::spawn(move || {
                if let Err(e) = worker_setup.ensure_started() {
                    eprintln!("worker sidecar: {e}");
                }
            });

            // Low-frequency server-status tick so external Hunyuan starts are
            // noticed by the frontend.
            let tick_supervisor = Arc::clone(&supervisor_for_tick);
            let tick_handle = handle.clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(5));
                let status = tick_supervisor.status();
                events::emit_server_status(&tick_handle, &status);
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_projects,
            commands::create_project,
            commands::get_project,
            commands::create_asset,
            commands::delete_asset,
            commands::upload_source,
            commands::reset_asset,
            commands::generate,
            commands::get_config,
            commands::update_config,
            commands::server_status,
            commands::server_start,
            commands::server_stop,
            commands::asset_file_src,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(move |_app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                // Stop child processes (worker + Hunyuan) on exit.
                worker_for_exit.stop();
                supervisor_for_exit.stop();
            }
        });
}
