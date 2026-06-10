//! Tauri commands. Each returns `Result<T, String>` (the string is a human
//! message). Shared managers are accessed via `tauri::State`.

use std::io::Cursor;
use std::sync::Arc;

use image::ImageReader;
use tauri::State;

use crate::audio_jobs::AudioJobManager;
use crate::config::Config;
use crate::elevenlabs::ElevenLabs;
use crate::error::AppError;
use crate::events;
use crate::installer::Installer;
use crate::jobs::JobManager;
use crate::store::Store;
use crate::supervisor::Supervisor;
use crate::types::{
    Asset, AudioBundle, AudioItem, ConfigPatch, ConfigPublic, Gen3dPatch, InstallProgress,
    JobCurrent, Project, ProjectBundle, ProjectState, ServerStatus, Voice, VoicePreview,
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

#[tauri::command]
pub fn set_project_style(
    app: tauri::AppHandle,
    store: State<'_, Arc<Store>>,
    project: String,
    style: String,
) -> CmdResult<()> {
    store.set_project_style(&project, &style)?;
    events::emit_project_changed(&app, &project);
    Ok(())
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

/// Update mutable asset fields after creation. Currently the 3D backend, so the
/// user can switch mono (v21) / multi (mv2) / auto without recreating the asset.
#[tauri::command]
pub fn update_asset(
    app: tauri::AppHandle,
    store: State<'_, Arc<Store>>,
    project: String,
    asset_id: String,
    backend: String,
) -> CmdResult<()> {
    if backend != "auto" && backend != "v21" && backend != "mv2" {
        return Err(format!("backend invalide: {backend}"));
    }
    store.set_asset_backend(&project, &asset_id, &backend)?;
    events::emit_project_changed(&app, &project);
    Ok(())
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

/// Set or clear the per-asset 3D generation override (polygon count, steps,
/// texture…). An empty patch clears the override and reverts to global defaults.
#[tauri::command]
pub fn set_asset_gen3d(
    app: tauri::AppHandle,
    store: State<'_, Arc<Store>>,
    project: String,
    asset_id: String,
    gen3d: Gen3dPatch,
) -> CmdResult<()> {
    // Ensure the asset exists, then persist the snake_case override.
    let _ = store.get_asset(&project, &asset_id)?;
    let over = serde_json::Value::Object(gen3d.to_snake_object());
    store.set_asset_gen3d(&project, &asset_id, over)?;
    events::emit_project_changed(&app, &project);
    Ok(())
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

/// Edit the asset's source image via OpenAI (prompt + optional mask) and
/// overwrite source.png. Marks the source `manual` and resets the model3d/export
/// stages to `pending` so the user can rebuild the 3D from the edited image.
#[tauri::command]
pub fn edit_image(
    app: tauri::AppHandle,
    config: State<'_, Arc<Config>>,
    store: State<'_, Arc<Store>>,
    project: String,
    asset_id: String,
    prompt: String,
    mask_bytes: Option<Vec<u8>>,
) -> CmdResult<UploadResult> {
    let _ = store.get_asset(&project, &asset_id)?;
    if prompt.trim().is_empty() {
        return Err("le prompt d'édition est vide".into());
    }

    let cfg = config.load();
    let api_key = crate::config::openai_key(&cfg);
    if api_key.is_empty() {
        return Err("OPENAI_API_KEY absent (Réglages ou .env)".into());
    }

    // Resolve the image to edit: source.png if present, else the multiview front.
    let source = store.source_image_path(&project, &asset_id)?;
    let base = if source.is_file() {
        source.clone()
    } else {
        let front = store
            .multiview_dir(&project, &asset_id)?
            .join("front.png");
        if front.is_file() {
            front
        } else {
            return Err("aucune image à éditer : génère d'abord l'image source".into());
        }
    };

    // Budget gate (same accounting as the multiview stage).
    let state = store.load_state(&project)?;
    let current_spend = state
        .get("estimated_spend_usd")
        .and_then(|x| x.as_f64())
        .unwrap_or(0.0);
    let est_cost = cfg
        .get("estimated_cost_per_image")
        .and_then(|x| x.as_f64())
        .unwrap_or(0.063);
    let budget = cfg.get("budget_usd").and_then(|x| x.as_f64()).unwrap_or(5.0);
    if current_spend + est_cost > budget + 1e-9 {
        return Err(format!(
            "budget atteint: projeté ${:.3} > ${:.2}",
            current_spend + est_cost,
            budget
        ));
    }

    // Persist the optional mask to a temp file alongside the asset.
    let mask_path = if let Some(bytes) = mask_bytes.filter(|b| !b.is_empty()) {
        let p = store.asset_dir(&project, &asset_id)?.join(".edit_mask.png");
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).map_err(AppError::from)?;
        }
        std::fs::write(&p, &bytes)
            .map_err(|e| AppError::msg(format!("écriture du masque: {e}")))?;
        Some(p)
    } else {
        None
    };

    let model = cfg.get("openai_model").and_then(|x| x.as_str()).unwrap_or("");
    let quality = cfg
        .get("openai_quality")
        .and_then(|x| x.as_str())
        .unwrap_or("medium");
    let timeout = cfg.get("openai_timeout").and_then(|x| x.as_i64()).unwrap_or(300);

    // Pure-Rust OpenAI edit call (the Python worker is not involved).
    let result = crate::openai::edit_image(
        &api_key,
        &base,
        prompt.trim(),
        model,
        "", // size omitted for edits (API matches the input image; "auto" is invalid here)
        quality,
        timeout,
        mask_path.as_deref(),
    );

    // Always clean up the temp mask.
    if let Some(p) = &mask_path {
        let _ = std::fs::remove_file(p);
    }
    let edited = result?;

    // Overwrite source.png with the edited image.
    if let Some(parent) = source.parent() {
        std::fs::create_dir_all(parent).map_err(AppError::from)?;
    }
    std::fs::write(&source, &edited)
        .map_err(|e| AppError::msg(format!("écriture de l'image éditée: {e}")))?;

    // Account spend, flip to a manual source, invalidate downstream stages.
    let _ = store.add_spend(&project, est_cost)?;
    store.set_asset_source(&project, &asset_id, "manual")?;
    store.update_stage(&project, &asset_id, "model3d", "pending", None, None)?;
    store.update_stage(&project, &asset_id, "export", "pending", None, None)?;

    events::emit_project_changed(&app, &project);
    Ok(UploadResult {
        source: "manual".to_string(),
    })
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
    let el_set = !crate::config::elevenlabs_key(&cfg).is_empty();
    Ok(ConfigPublic::from_config(&cfg, key_set, el_set))
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
    let el_set = !crate::config::elevenlabs_key(&saved).is_empty();
    Ok(ConfigPublic::from_config(&saved, key_set, el_set))
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

// --- hunyuan guided installer -------------------------------------------

/// Start the guided install of a heavy Hunyuan backend (currently `mv2`). Runs on
/// a background thread; progress streams via the `install-progress` event.
#[tauri::command]
pub fn install_backend(
    app: tauri::AppHandle,
    installer: State<'_, Arc<Installer>>,
    supervisor: State<'_, Arc<Supervisor>>,
    backend: String,
) -> CmdResult<InstallProgress> {
    if backend != "v21" && backend != "mv2" {
        return Err(format!("backend invalide: {backend}"));
    }
    let progress = installer
        .inner()
        .start(app, Arc::clone(supervisor.inner()), &backend)?;
    Ok(progress)
}

#[tauri::command]
pub fn install_status(installer: State<'_, Arc<Installer>>) -> CmdResult<InstallProgress> {
    Ok(installer.status())
}

#[tauri::command]
pub fn cancel_install(installer: State<'_, Arc<Installer>>) -> CmdResult<InstallProgress> {
    installer.cancel();
    Ok(installer.status())
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

// --- audio: voices (global catalog) -------------------------------------

/// Voice Design: returns preview voices (base64 mp3 + a `generatedVoiceId`). The
/// UI plays the previews and picks one to save via `create_voice`.
#[tauri::command]
pub fn design_voice(
    config: State<'_, Arc<Config>>,
    eleven: State<'_, Arc<ElevenLabs>>,
    description: String,
    preview_text: String,
    seed: Option<i64>,
    guidance_scale: Option<f64>,
) -> CmdResult<Vec<VoicePreview>> {
    let cfg = config.load();
    let api_key = crate::config::elevenlabs_key(&cfg);
    if api_key.is_empty() {
        return Err("ELEVENLABS_API_KEY absent (Réglages ou .env)".into());
    }
    if description.trim().is_empty() {
        return Err("la description de la voix est vide".into());
    }
    let model = cfg
        .get("audio")
        .and_then(|a| a.get("ttv_model"))
        .and_then(|x| x.as_str())
        .unwrap_or("eleven_multilingual_ttv_v2");
    eleven
        .voice_design(
            &api_key,
            description.trim(),
            preview_text.trim(),
            model,
            seed.unwrap_or(42),
            guidance_scale.unwrap_or(5.0),
        )
        .map_err(Into::into)
}

/// Save a chosen design preview as a reusable voice in the global catalog.
#[tauri::command]
pub fn create_voice(
    config: State<'_, Arc<Config>>,
    eleven: State<'_, Arc<ElevenLabs>>,
    store: State<'_, Arc<Store>>,
    name: String,
    description: String,
    generated_voice_id: String,
    voice_settings: Option<serde_json::Value>,
) -> CmdResult<Voice> {
    let cfg = config.load();
    let api_key = crate::config::elevenlabs_key(&cfg);
    if api_key.is_empty() {
        return Err("ELEVENLABS_API_KEY absent (Réglages ou .env)".into());
    }
    if name.trim().is_empty() {
        return Err("le nom de la voix est vide".into());
    }
    let voice_id = eleven.voice_create(&api_key, name.trim(), description.trim(), &generated_voice_id)?;
    let settings = voice_settings.unwrap_or_else(|| {
        serde_json::json!({ "stability": 0.5, "similarity_boost": 0.75 })
    });
    let voice = Voice {
        voice_id,
        name: name.trim().to_string(),
        description: description.trim().to_string(),
        voice_settings: settings,
        created_at: crate::store::now(),
    };
    store.add_voice(&voice)?;
    Ok(voice)
}

#[tauri::command]
pub fn list_voices(store: State<'_, Arc<Store>>) -> CmdResult<Vec<Voice>> {
    store.list_voices().map_err(Into::into)
}

#[tauri::command]
pub fn delete_voice(store: State<'_, Arc<Store>>, voice_id: String) -> CmdResult<()> {
    store.delete_voice(&voice_id).map_err(Into::into)
}

// --- audio: items (per project) -----------------------------------------

#[tauri::command]
pub fn list_audio(
    store: State<'_, Arc<Store>>,
    audio_jobs: State<'_, Arc<AudioJobManager>>,
    project: String,
) -> CmdResult<AudioBundle> {
    let items = store.list_audio_items(&project)?;
    Ok(AudioBundle {
        items,
        jobs: audio_jobs.snapshot(),
    })
}

#[tauri::command]
pub fn create_audio_item(
    app: tauri::AppHandle,
    store: State<'_, Arc<Store>>,
    project: String,
    kind: String,
    name: String,
    text: String,
    voice_id: Option<String>,
    params: Option<serde_json::Value>,
) -> CmdResult<AudioItem> {
    if kind != "voice" && kind != "sfx" && kind != "music" {
        return Err(format!("type audio invalide: {kind}"));
    }
    if name.trim().is_empty() {
        return Err("le nom est vide".into());
    }
    if text.trim().is_empty() {
        return Err("le texte / prompt est vide".into());
    }
    if kind == "voice" && voice_id.as_deref().unwrap_or("").is_empty() {
        return Err("sélectionne une voix pour un clip de voix".into());
    }
    let params = params.unwrap_or_else(|| serde_json::json!({}));
    let item = store.add_audio_item(
        &project,
        &kind,
        name.trim(),
        text.trim(),
        voice_id.as_deref().filter(|s| !s.is_empty()),
        params,
    )?;
    events::emit_project_changed(&app, &project);
    Ok(item)
}

#[tauri::command]
pub fn generate_audio_item(
    app: tauri::AppHandle,
    store: State<'_, Arc<Store>>,
    audio_jobs: State<'_, Arc<AudioJobManager>>,
    project: String,
    item_id: String,
) -> CmdResult<()> {
    // Validate it exists, mark queued for instant feedback, then enqueue.
    let _ = store.get_audio_item(&project, &item_id)?;
    store.update_audio_status(&project, &item_id, "queued", None, None)?;
    events::emit_project_changed(&app, &project);
    audio_jobs.enqueue(&project, &item_id)?;
    Ok(())
}

#[tauri::command]
pub fn delete_audio_item(
    app: tauri::AppHandle,
    store: State<'_, Arc<Store>>,
    project: String,
    item_id: String,
) -> CmdResult<()> {
    store.delete_audio_item(&project, &item_id)?;
    events::emit_project_changed(&app, &project);
    Ok(())
}

// --- project-relative file source (for audio playback / download) -------

#[tauri::command]
pub fn project_file_src(
    config: State<'_, Arc<Config>>,
    store: State<'_, Arc<Store>>,
    project: String,
    rel: String,
) -> CmdResult<String> {
    let candidate = confined_project_path(&config, &store, &project, &rel)?;
    Ok(candidate.to_string_lossy().to_string())
}

#[tauri::command]
pub fn save_project_file(
    config: State<'_, Arc<Config>>,
    store: State<'_, Arc<Store>>,
    project: String,
    rel: String,
    dest: String,
) -> CmdResult<()> {
    let src = confined_project_path(&config, &store, &project, &rel)?;
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

/// Resolve `rel` under the project dir and confine it to the workspace (no escape).
fn confined_project_path(
    config: &Config,
    store: &Store,
    project: &str,
    rel: &str,
) -> Result<std::path::PathBuf, AppError> {
    let project_dir = store.project_dir(project)?;
    let candidate = project_dir.join(rel);
    let workspace = config.workspace_dir()?;
    let inside =
        candidate.starts_with(&project_dir) || crate::config::under(&workspace, &candidate);
    if !inside {
        return Err(AppError::msg(format!("chemin hors workspace: {rel}")));
    }
    Ok(candidate)
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
