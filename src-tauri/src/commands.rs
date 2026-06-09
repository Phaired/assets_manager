//! Tauri commands. Each returns `Result<T, String>` (the string is a human
//! message). Shared managers are accessed via `tauri::State`.

use std::io::Cursor;
use std::sync::Arc;

use image::ImageReader;
use tauri::State;

use crate::config::Config;
use crate::error::AppError;
use crate::events;
use crate::jobs::JobManager;
use crate::store::Store;
use crate::supervisor::Supervisor;
use crate::types::{
    Asset, ConfigPatch, ConfigPublic, JobCurrent, Project, ProjectBundle, ProjectState,
    ServerStatus,
};

type CmdResult<T> = Result<T, String>;

// --- projects -----------------------------------------------------------

#[tauri::command]
pub fn list_projects(store: State<'_, Arc<Store>>) -> CmdResult<Vec<String>> {
    store.list_projects().map_err(Into::into)
}

#[tauri::command]
pub fn create_project(
    app: tauri::AppHandle,
    store: State<'_, Arc<Store>>,
    name: String,
) -> CmdResult<Project> {
    let data = store.create_project(&name)?;
    let project = Project::from_disk(&data);
    events::emit_project_changed(&app, &project.name);
    Ok(project)
}

#[tauri::command]
pub fn get_project(
    store: State<'_, Arc<Store>>,
    jobs: State<'_, Arc<JobManager>>,
    name: String,
) -> CmdResult<ProjectBundle> {
    let project_v = store.get_project(&name)?;
    let state_v = store.load_state(&name)?;
    Ok(ProjectBundle {
        project: Project::from_disk(&project_v),
        state: ProjectState::from_disk(&state_v),
        jobs: jobs.snapshot(),
    })
}

// --- assets -------------------------------------------------------------

#[tauri::command]
pub fn create_asset(
    app: tauri::AppHandle,
    store: State<'_, Arc<Store>>,
    project: String,
    name: String,
    description: String,
    tags: Vec<String>,
    backend: String,
) -> CmdResult<Asset> {
    let asset_v = store.add_asset(&project, &name, &description, tags, &backend)?;
    events::emit_project_changed(&app, &project);
    Ok(Asset::from_disk(&asset_v))
}

#[tauri::command]
pub fn delete_asset(
    app: tauri::AppHandle,
    store: State<'_, Arc<Store>>,
    project: String,
    asset_id: String,
) -> CmdResult<()> {
    store.delete_asset(&project, &asset_id)?;
    events::emit_project_changed(&app, &project);
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadResult {
    pub source: String,
}

#[tauri::command]
pub fn upload_source(
    app: tauri::AppHandle,
    store: State<'_, Arc<Store>>,
    project: String,
    asset_id: String,
    bytes: Vec<u8>,
) -> CmdResult<UploadResult> {
    // Ensure the asset exists.
    let _ = store.get_asset(&project, &asset_id)?;

    // Decode -> normalise to RGBA -> write source.png.
    let reader = ImageReader::new(Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(|e| AppError::msg(format!("image illisible: {e}")))?;
    let img = reader
        .decode()
        .map_err(|e| AppError::msg(format!("image invalide: {e}")))?;
    let rgba = img.to_rgba8();

    let dest = store.source_image_path(&project, &asset_id)?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(AppError::from)?;
    }
    rgba.save(&dest)
        .map_err(|e| AppError::msg(format!("ecriture source.png: {e}")))?;

    store.set_asset_source(&project, &asset_id, "manual")?;
    events::emit_project_changed(&app, &project);
    Ok(UploadResult {
        source: "manual".to_string(),
    })
}

#[tauri::command]
pub fn reset_asset(
    app: tauri::AppHandle,
    store: State<'_, Arc<Store>>,
    project: String,
    asset_id: String,
) -> CmdResult<()> {
    store.reset_asset(&project, &asset_id)?;
    events::emit_project_changed(&app, &project);
    Ok(())
}

// --- generation ---------------------------------------------------------

#[tauri::command]
pub fn generate(
    store: State<'_, Arc<Store>>,
    jobs: State<'_, Arc<JobManager>>,
    project: String,
    asset_id: String,
    stages: Vec<String>,
) -> CmdResult<Option<JobCurrent>> {
    // Validate the asset exists before enqueueing.
    let _ = store.get_asset(&project, &asset_id)?;
    let current = jobs.enqueue(store.inner().as_ref(), &project, &asset_id, stages)?;
    Ok(current)
}

// --- config -------------------------------------------------------------

#[tauri::command]
pub fn get_config(config: State<'_, Arc<Config>>) -> CmdResult<ConfigPublic> {
    let cfg = config.load();
    let key_set = !crate::config::openai_key(&cfg).is_empty();
    Ok(ConfigPublic::from_config(&cfg, key_set))
}

#[tauri::command]
pub fn update_config(
    config: State<'_, Arc<Config>>,
    patch: ConfigPatch,
) -> CmdResult<ConfigPublic> {
    let current = config.load();
    let over = patch.to_disk_override();
    // Deep-merge the patch over the current config, then save (which re-merges
    // over defaults). gen3d merges deeply because deep_merge recurses.
    let merged = crate::config::deep_merge(&current, &over);
    let saved = config.save(&merged)?;
    let key_set = !crate::config::openai_key(&saved).is_empty();
    Ok(ConfigPublic::from_config(&saved, key_set))
}

// --- hunyuan supervisor -------------------------------------------------

#[tauri::command]
pub fn server_status(supervisor: State<'_, Arc<Supervisor>>) -> CmdResult<ServerStatus> {
    Ok(supervisor.status())
}

#[tauri::command]
pub fn server_start(
    app: tauri::AppHandle,
    supervisor: State<'_, Arc<Supervisor>>,
    backend: String,
) -> CmdResult<ServerStatus> {
    if backend != "v21" && backend != "mv2" {
        return Err(format!("backend invalide: {backend}"));
    }
    supervisor.inner().start(&backend)?;
    let status = supervisor.status();
    events::emit_server_status(&app, &status);
    Ok(status)
}

#[tauri::command]
pub fn server_stop(
    app: tauri::AppHandle,
    supervisor: State<'_, Arc<Supervisor>>,
) -> CmdResult<ServerStatus> {
    supervisor.stop();
    let status = supervisor.status();
    events::emit_server_status(&app, &status);
    Ok(status)
}

// --- asset file source --------------------------------------------------

#[tauri::command]
pub fn asset_file_src(
    config: State<'_, Arc<Config>>,
    store: State<'_, Arc<Store>>,
    project: String,
    asset_id: String,
    rel: String,
) -> CmdResult<String> {
    let candidate = confined_asset_path(&config, &store, &project, &asset_id, &rel)?;
    Ok(candidate.to_string_lossy().to_string())
}

/// Copy a workspace-relative asset file (e.g. `model.glb`) to an absolute `dest`
/// chosen by the user via the native save dialog. The webview cannot write files
/// itself, and an `<a download>` to the asset protocol does not trigger a real
/// "Save As" in WebView2 (it navigates / hands the file to the shell instead —
/// which is why a .glb was opening in Notepad). So we copy on the Rust side.
#[tauri::command]
pub fn save_asset_file(
    config: State<'_, Arc<Config>>,
    store: State<'_, Arc<Store>>,
    project: String,
    asset_id: String,
    rel: String,
    dest: String,
) -> CmdResult<()> {
    let src = confined_asset_path(&config, &store, &project, &asset_id, &rel)?;
    if !src.is_file() {
        return Err(format!("fichier introuvable: {rel}"));
    }
    let dest = std::path::PathBuf::from(&dest);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(AppError::from)?;
    }
    std::fs::copy(&src, &dest)
        .map_err(|e| AppError::msg(format!("échec de la copie vers {}: {e}", dest.display())))?;
    Ok(())
}

/// Resolve `rel` under the asset dir and confine it to the workspace (no escape).
fn confined_asset_path(
    config: &Config,
    store: &Store,
    project: &str,
    asset_id: &str,
    rel: &str,
) -> Result<std::path::PathBuf, AppError> {
    let asset_dir = store.asset_dir(project, asset_id)?;
    let candidate = asset_dir.join(rel);
    let workspace = config.workspace_dir()?;
    let inside = candidate.starts_with(&asset_dir) || crate::config::under(&workspace, &candidate);
    if !inside {
        return Err(AppError::msg(format!("chemin hors workspace: {rel}")));
    }
    Ok(candidate)
}
