//! assets_gen — Tauri core. Owns all state + orchestration:
//! config, store (projects/assets/state JSON), job queue, Hunyuan supervisor and
//! the Python worker sidecar. Frontend talks to it via `invoke` / `listen`.

mod audio_jobs;
mod commands;
mod config;
mod elevenlabs;
mod error;
mod events;
mod installer;
mod jobs;
mod openai;
mod openai_admin;
mod openai_text;
mod proc;
mod store;
mod supervisor;
mod types;
mod worker;

use std::sync::Arc;
use std::time::Duration;

use tauri::Manager;

use crate::audio_jobs::AudioJobManager;
use crate::config::Config;
use crate::elevenlabs::ElevenLabs;
use crate::installer::Installer;
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
    let installer = Arc::new(Installer::new(Arc::clone(&config)));
    let worker = Arc::new(
        WorkerClient::new(Arc::clone(&config)).expect("failed to build worker HTTP client"),
    );
    let jobs = JobManager::new(
        Arc::clone(&store),
        Arc::clone(&config),
        Arc::clone(&supervisor),
        Arc::clone(&worker),
    );
    let elevenlabs = Arc::new(
        ElevenLabs::new().expect("failed to build ElevenLabs HTTP client"),
    );
    let audio_jobs = AudioJobManager::new(
        Arc::clone(&store),
        Arc::clone(&config),
        Arc::clone(&elevenlabs),
    );

    // Clones moved into setup / exit handlers.
    let worker_for_setup = Arc::clone(&worker);
    let supervisor_for_tick = Arc::clone(&supervisor);
    let jobs_for_setup = Arc::clone(&jobs);
    let audio_jobs_for_setup = Arc::clone(&audio_jobs);
    let store_for_setup = Arc::clone(&store);

    let worker_for_exit = Arc::clone(&worker);
    let supervisor_for_exit = Arc::clone(&supervisor);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(Arc::clone(&config))
        .manage(Arc::clone(&store))
        .manage(Arc::clone(&supervisor))
        .manage(Arc::clone(&installer))
        .manage(Arc::clone(&worker))
        .manage(Arc::clone(&jobs))
        .manage(Arc::clone(&elevenlabs))
        .manage(Arc::clone(&audio_jobs))
        .manage(Arc::new(commands::DecimateLocks::default()))
        .manage(Arc::new(commands::Paint3dLocks::default()))
        .setup(move |app| {
            let handle = app.handle().clone();

            // Resolve runtime roots BEFORE anything touches config/workspace/logs.
            // - dev: keep the project root so existing config.json/workspace work.
            // - packaged: writable data in the per-user app-data dir, bundled
            //   resources (frozen worker) in Tauri's resource dir.
            let resource = app
                .path()
                .resource_dir()
                .unwrap_or_else(|_| config::repo_root());
            let data = if cfg!(debug_assertions) {
                config::repo_root()
            } else {
                app.path()
                    .app_data_dir()
                    .unwrap_or_else(|_| config::repo_root())
            };
            if let Err(e) = std::fs::create_dir_all(&data) {
                eprintln!("create data dir {}: {e}", data.display());
            }
            config::init_paths(data, resource);

            // Install the AppHandle so config persistence can reach the plugin
            // store, then one-shot migrate any legacy config.json into it.
            config::set_app(handle.clone());
            config::migrate_legacy_if_needed();

            // Stale running/queued stages cannot survive a restart (now that the
            // workspace path is resolved).
            if let Err(e) = store_for_setup.reset_stale_stages() {
                eprintln!("reset_stale_stages: {e}");
            }
            if let Err(e) = store_for_setup.reset_stale_audio() {
                eprintln!("reset_stale_audio: {e}");
            }

            // Wire AppHandle into the job managers so they can emit events.
            jobs_for_setup.set_app(handle.clone());
            audio_jobs_for_setup.set_app(handle.clone());

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
            commands::set_project_style,
            commands::set_project_dna,
            commands::create_asset,
            commands::update_asset,
            commands::rename_asset,
            commands::set_asset_tags,
            commands::set_asset_seed,
            commands::set_asset_prompt,
            commands::duplicate_asset,
            commands::delete_asset,
            commands::set_asset_gen3d,
            commands::set_asset_decimate,
            commands::decimate_model,
            commands::paint_model,
            commands::upload_source,
            commands::reset_asset,
            commands::edit_image,
            commands::generate,
            commands::suggest_prompts,
            commands::ideate_pack,
            commands::save_render,
            commands::get_config,
            commands::update_config,
            commands::openai_costs,
            commands::server_status,
            commands::server_start,
            commands::server_stop,
            commands::install_backend,
            commands::install_text3d,
            commands::install_status,
            commands::cancel_install,
            commands::asset_file_src,
            commands::save_asset_file,
            commands::design_voice,
            commands::create_voice,
            commands::list_voices,
            commands::delete_voice,
            commands::list_audio,
            commands::create_audio_item,
            commands::set_audio_item_asset,
            commands::generate_audio_item,
            commands::delete_audio_item,
            commands::project_file_src,
            commands::save_project_file,
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
