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
    Asset, AudioBundle, AudioItem, ConfigPatch, ConfigPublic, DecimateParams, DecimatePatch,
    Gen3dPatch, InstallProgress, JobCurrent, Project, ProjectBundle, ProjectDna, ProjectState,
    ServerStatus, Voice, VoicePreview,
};
use crate::worker::WorkerClient;

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

/// Persist the project's DNA (identity sheet injected into every pipeline).
#[tauri::command]
pub fn set_project_dna(
    app: tauri::AppHandle,
    store: State<'_, Arc<Store>>,
    project: String,
    dna: ProjectDna,
) -> CmdResult<()> {
    store.set_project_dna(&project, &dna)?;
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
    kind: Option<String>,
    source: Option<String>,
) -> CmdResult<Asset> {
    let kind = kind.unwrap_or_else(|| "model".to_string());
    if kind != "model" && kind != "texture" {
        return Err(format!("type d'asset invalide: {kind}"));
    }
    let source = source.unwrap_or_else(|| "openai".to_string());
    if source != "openai" && source != "manual" && source != "text" {
        return Err(format!("source d'asset invalide: {source}"));
    }
    // Native text-to-3D is a model asset on the mv2 backend (HunyuanDiT t2i).
    let (kind, backend) = if source == "text" {
        ("model".to_string(), "mv2".to_string())
    } else {
        (kind, backend)
    };
    let asset_v = store.add_asset(&project, &name, &description, tags, &backend, &kind, &source)?;
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

/// Rename an asset's display name (the id/slug and disk paths are unchanged).
#[tauri::command]
pub fn rename_asset(
    app: tauri::AppHandle,
    store: State<'_, Arc<Store>>,
    project: String,
    asset_id: String,
    name: String,
) -> CmdResult<()> {
    if name.trim().is_empty() {
        return Err("le nom est vide".into());
    }
    store.set_asset_name(&project, &asset_id, name.trim())?;
    events::emit_project_changed(&app, &project);
    Ok(())
}

/// Replace an asset's tags.
#[tauri::command]
pub fn set_asset_tags(
    app: tauri::AppHandle,
    store: State<'_, Arc<Store>>,
    project: String,
    asset_id: String,
    tags: Vec<String>,
) -> CmdResult<()> {
    let tags: Vec<String> = tags
        .into_iter()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect();
    store.set_asset_tags(&project, &asset_id, tags)?;
    events::emit_project_changed(&app, &project);
    Ok(())
}

/// Set (or clear, when `seed` is null) the per-asset 3D seed override.
#[tauri::command]
pub fn set_asset_seed(
    app: tauri::AppHandle,
    store: State<'_, Arc<Store>>,
    project: String,
    asset_id: String,
    seed: Option<i64>,
) -> CmdResult<()> {
    store.set_asset_seed(&project, &asset_id, seed)?;
    events::emit_project_changed(&app, &project);
    Ok(())
}

/// Set (or clear, when empty) the per-asset multiview prompt override.
#[tauri::command]
pub fn set_asset_prompt(
    app: tauri::AppHandle,
    store: State<'_, Arc<Store>>,
    project: String,
    asset_id: String,
    prompt: String,
) -> CmdResult<()> {
    store.set_asset_prompt(&project, &asset_id, &prompt)?;
    events::emit_project_changed(&app, &project);
    Ok(())
}

/// Duplicate an asset's configuration into a new asset (no generated files copied).
#[tauri::command]
pub fn duplicate_asset(
    app: tauri::AppHandle,
    store: State<'_, Arc<Store>>,
    project: String,
    asset_id: String,
) -> CmdResult<Asset> {
    let new = store.duplicate_asset(&project, &asset_id)?;
    events::emit_project_changed(&app, &project);
    Ok(Asset::from_disk(&new))
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

/// Set or clear the per-asset decimation override. An empty patch clears the
/// override and reverts to global defaults.
#[tauri::command]
pub fn set_asset_decimate(
    app: tauri::AppHandle,
    store: State<'_, Arc<Store>>,
    project: String,
    asset_id: String,
    decimate: DecimatePatch,
) -> CmdResult<()> {
    let _ = store.get_asset(&project, &asset_id)?;
    let over = serde_json::Value::Object(decimate.to_snake_object());
    store.set_asset_decimate(&project, &asset_id, over)?;
    events::emit_project_changed(&app, &project);
    Ok(())
}

/// At most one decimation per (project, asset) at a time — guards the
/// "Appliquer" button against double-clicks (the worker itself can serve
/// /decimate concurrently with a running gen3d).
#[derive(Default)]
pub struct DecimateLocks(parking_lot::Mutex<std::collections::HashSet<String>>);

struct DecimateLockGuard {
    locks: Arc<DecimateLocks>,
    key: String,
}

impl DecimateLocks {
    fn acquire(self: &Arc<Self>, project: &str, asset_id: &str) -> CmdResult<DecimateLockGuard> {
        let key = format!("{project}/{asset_id}");
        if !self.0.lock().insert(key.clone()) {
            return Err("une réduction est déjà en cours pour cet asset".into());
        }
        Ok(DecimateLockGuard {
            locks: Arc::clone(self),
            key,
        })
    }
}

impl Drop for DecimateLockGuard {
    fn drop(&mut self) {
        self.locks.0.lock().remove(&self.key);
    }
}

/// Re-decimate the persisted raw mesh (model_raw.glb -> model.glb) with the
/// effective params (config defaults <- per-asset override <- one-shot patch).
/// Runs as a direct command, NOT a queue job: the job queue is serial and a
/// gen3d can hold it for ~30 min, which would kill the interactive
/// tweak-polycount workflow. Progress persists in the "decimate" stage key
/// (not part of STAGES — no pipeline card, but it survives restarts).
#[tauri::command]
pub async fn decimate_model(
    app: tauri::AppHandle,
    config: State<'_, Arc<Config>>,
    store: State<'_, Arc<Store>>,
    worker: State<'_, Arc<WorkerClient>>,
    locks: State<'_, Arc<DecimateLocks>>,
    project: String,
    asset_id: String,
    params: Option<DecimatePatch>,
) -> CmdResult<serde_json::Value> {
    let asset = store.get_asset(&project, &asset_id)?;
    let raw = store.model_raw_path(&project, &asset_id)?;
    if !raw.is_file() {
        return Err(
            "maillage brut absent — relance l'étape 3D pour le générer (les modèles \
             créés avant cette version n'ont pas conservé leur maillage brut)"
                .into(),
        );
    }

    // Refuse while the asset's pipeline stages are queued/running (the gen3d
    // would overwrite model.glb under us).
    let state = store.load_state(&project)?;
    if let Some(stages) = state.get("assets").and_then(|a| a.get(&asset_id)) {
        for key in ["model3d", "export", "decimate"] {
            let status = stages
                .get(key)
                .and_then(|s| s.get("status"))
                .and_then(|x| x.as_str())
                .unwrap_or("");
            if status == "running" || status == "queued" {
                return Err(format!("étape {key} en cours — réessaie quand elle est finie"));
            }
        }
    }
    let guard = locks.inner().acquire(&project, &asset_id)?;

    // Effective params: global defaults <- per-asset override <- call patch
    // (everything snake_case, like the gen3d merge in stage_model3d).
    let cfg = config.load();
    let mut merged = cfg.get("decimate").cloned().unwrap_or(serde_json::Value::Null);
    if let Some(over) = asset.get("decimate") {
        merged = crate::config::deep_merge(&merged, over);
    }
    if let Some(patch) = &params {
        merged = crate::config::deep_merge(
            &merged,
            &serde_json::Value::Object(patch.to_snake_object()),
        );
    }
    let effective = DecimateParams::from_config(&merged);
    let dest = store.model_path(&project, &asset_id)?;

    store.update_stage(&project, &asset_id, "decimate", "running", None, None)?;
    events::emit_project_changed(&app, &project);

    let worker = Arc::clone(worker.inner());
    let raw_s = raw.to_string_lossy().to_string();
    let dest_s = dest.to_string_lossy().to_string();
    let result = tauri::async_runtime::spawn_blocking(move || {
        worker.decimate(&raw_s, &dest_s, &effective)
    })
    .await
    .map_err(|e| format!("tâche de réduction interrompue: {e}"));
    drop(guard);

    match result.and_then(|r| r.map_err(|e| e.to_string())) {
        Ok(meta) => {
            store.update_stage(
                &project,
                &asset_id,
                "decimate",
                "done",
                None,
                Some(meta.clone()),
            )?;
            // The OBJ export was made from the previous model.glb — mark it stale.
            store.update_stage(&project, &asset_id, "export", "pending", None, None)?;
            // Decimate re-reads the UNtextured raw mesh — any prior paint is gone,
            // so the model is untextured again: re-offer the Texturer button.
            store.update_stage(&project, &asset_id, "paint3d", "pending", None, None)?;
            events::emit_project_changed(&app, &project);
            Ok(meta)
        }
        Err(message) => {
            let _ = store.update_stage(
                &project,
                &asset_id,
                "decimate",
                "error",
                Some(&message),
                None,
            );
            events::emit_project_changed(&app, &project);
            Err(message)
        }
    }
}

/// At most one paint pass per (project, asset) at a time (the pass holds the
/// exclusive GPU; this guards the "Texturer" button against double-clicks).
#[derive(Default)]
pub struct Paint3dLocks(parking_lot::Mutex<std::collections::HashSet<String>>);

struct Paint3dLockGuard {
    locks: Arc<Paint3dLocks>,
    key: String,
}

impl Paint3dLocks {
    fn acquire(self: &Arc<Self>, project: &str, asset_id: &str) -> CmdResult<Paint3dLockGuard> {
        let key = format!("{project}/{asset_id}");
        if !self.0.lock().insert(key.clone()) {
            return Err("un texturing est déjà en cours pour cet asset".into());
        }
        Ok(Paint3dLockGuard {
            locks: Arc::clone(self),
            key,
        })
    }
}

impl Drop for Paint3dLockGuard {
    fn drop(&mut self) {
        self.locks.0.lock().remove(&self.key);
    }
}

/// Texture an untextured model.glb via the standalone Hunyuan paint pass. Frees
/// the GPU (stops the gradio server + verifies it's down), holds the supervisor's
/// exclusive-GPU gate so no queued model3d job restarts gradio mid-paint, runs the
/// mv2-venv python on paint_mesh.py, then overwrites model.glb in place. Non-queued
/// (mirrors /decimate). Progress in the "paint3d" stage key.
#[tauri::command]
pub async fn paint_model(
    app: tauri::AppHandle,
    config: State<'_, Arc<Config>>,
    store: State<'_, Arc<Store>>,
    supervisor: State<'_, Arc<Supervisor>>,
    locks: State<'_, Arc<Paint3dLocks>>,
    project: String,
    asset_id: String,
) -> CmdResult<serde_json::Value> {
    let _asset = store.get_asset(&project, &asset_id)?;
    let model = store.model_path(&project, &asset_id)?;
    if !model.is_file() {
        return Err("modèle 3D absent — génère d'abord le modèle (sans texture).".into());
    }
    // Reference: ref.png (rembg'd by the patched gradio) -> source.png -> front view.
    let reference = {
        let r = store.paint_ref_path(&project, &asset_id)?;
        let s = store.source_image_path(&project, &asset_id)?;
        let f = store.multiview_dir(&project, &asset_id)?.join("front.png");
        [r, s, f]
            .into_iter()
            .find(|p| p.is_file())
            .ok_or_else(|| {
                "aucune image de référence (ref.png / source.png / multivue) — \
                 impossible de texturer."
                    .to_string()
            })?
    };

    // Refuse while a pipeline stage that touches model.glb runs for THIS asset.
    let state = store.load_state(&project)?;
    if let Some(stages) = state.get("assets").and_then(|a| a.get(&asset_id)) {
        for key in ["model3d", "export", "decimate", "paint3d"] {
            let status = stages
                .get(key)
                .and_then(|s| s.get("status"))
                .and_then(|x| x.as_str())
                .unwrap_or("");
            if status == "running" || status == "queued" {
                return Err(format!("étape {key} en cours — réessaie quand elle est finie"));
            }
        }
    }
    let guard = locks.inner().acquire(&project, &asset_id)?;

    store.update_stage(&project, &asset_id, "paint3d", "running", None, None)?;
    events::emit_project_changed(&app, &project);

    let cfg = config.load();
    let model_s = model.to_string_lossy().to_string();
    let ref_s = reference.to_string_lossy().to_string();
    let untextured = store.model_untextured_path(&project, &asset_id)?;
    let _ = std::fs::copy(&model, &untextured); // keep the pre-paint mesh for revert
    let dest_s = model_s.clone(); // overwrite model.glb in place

    let supervisor = Arc::clone(supervisor.inner());
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        // Hold the exclusive-GPU gate for the whole pass; the job runner's ensure()
        // blocks on it so gradio is never restarted mid-paint.
        let _gpu = supervisor.acquire_gpu();
        // Stop the managed child AND confirm no adopted server is still up.
        supervisor.ensure_gpu_free(15).map_err(|e| e.to_string())?;
        crate::worker::paint_mesh(&cfg, &model_s, &ref_s, &dest_s).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("tâche de texturing interrompue: {e}"));
    drop(guard);

    match result.and_then(|r| r) {
        Ok(()) => {
            let meta = serde_json::json!({ "painted": true });
            store.update_stage(&project, &asset_id, "paint3d", "done", None, Some(meta.clone()))?;
            // The OBJ export was made from the untextured model — mark it stale.
            store.update_stage(&project, &asset_id, "export", "pending", None, None)?;
            events::emit_project_changed(&app, &project);
            Ok(meta)
        }
        Err(message) => {
            let _ = std::fs::copy(&untextured, &model); // restore on failure
            let _ = store.update_stage(&project, &asset_id, "paint3d", "error", Some(&message), None);
            events::emit_project_changed(&app, &project);
            Err(message)
        }
    }
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

/// Outcome of one `/v1/images/edits` call routed through [`run_openai_edit`]:
/// the edited PNG bytes plus the metadata the callers fold into their stage
/// records / spend accounting.
struct EditOutcome {
    edited: Vec<u8>,
    usage: Option<serde_json::Value>,
    model: String,
    quality: String,
    cost: f64,
    /// `Some` when the cost came from the API usage block, `None` when it fell
    /// back to the flat estimate (surfaced as `cost_source` in stage meta).
    real_cost: Option<f64>,
    /// Project spend total after debiting this edit.
    spent: f64,
}

/// Shared OpenAI image-edit machinery behind the in-place source edit, the
/// in-place multiview edit and the derive-to-variant flow: key + budget gate,
/// optional inpainting mask, style-coherent prompt, the API call and the
/// real-cost spend accounting. The caller resolves `base` (which image to send)
/// and decides where the returned bytes land.
fn run_openai_edit(
    cfg: &serde_json::Value,
    store: &Store,
    project: &str,
    asset_id: &str,
    base: &std::path::Path,
    prompt: &str,
    mask_bytes: Option<Vec<u8>>,
) -> CmdResult<EditOutcome> {
    let api_key = crate::config::openai_key(cfg);
    if api_key.is_empty() {
        return Err("OPENAI_API_KEY absent (Réglages ou .env)".into());
    }

    // Budget gate (same accounting as the multiview stage).
    let state = store.load_state(project)?;
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
        let p = store.asset_dir(project, asset_id)?.join(".edit_mask.png");
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

    // Keep edits coherent with the project DNA / style.
    let style_block = store.project_style_block(project).unwrap_or_default();
    let full_prompt = if style_block.is_empty() {
        prompt.trim().to_string()
    } else {
        format!("{}\nStyle: {}", prompt.trim(), style_block)
    };

    // Pure-Rust OpenAI edit call (the Python worker is not involved).
    let result = crate::openai::edit_image(
        &api_key,
        base,
        &full_prompt,
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
    let (edited, usage) = result?;

    // Account the REAL spend from the API usage block when the model is priced
    // (fallback: flat estimate).
    let real_cost = usage
        .as_ref()
        .and_then(|u| crate::config::image_cost_from_usage(cfg, model, u));
    let cost = real_cost.unwrap_or(est_cost);
    let spent = store.add_spend(project, cost)?;

    Ok(EditOutcome {
        edited,
        usage,
        model: model.to_string(),
        quality: quality.to_string(),
        cost,
        real_cost,
        spent,
    })
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

    let cfg = config.load();
    let out = run_openai_edit(&cfg, &store, &project, &asset_id, &base, &prompt, mask_bytes)?;

    // Overwrite source.png with the edited image.
    if let Some(parent) = source.parent() {
        std::fs::create_dir_all(parent).map_err(AppError::from)?;
    }
    std::fs::write(&source, &out.edited)
        .map_err(|e| AppError::msg(format!("écriture de l'image éditée: {e}")))?;

    // Flip to a manual source and invalidate downstream.
    store.set_asset_source(&project, &asset_id, "manual")?;
    store.update_stage(&project, &asset_id, "model3d", "pending", None, None)?;
    store.update_stage(&project, &asset_id, "export", "pending", None, None)?;

    events::emit_project_changed(&app, &project);
    Ok(UploadResult {
        source: "manual".to_string(),
    })
}

/// Edit the asset's multiview sheet in place via OpenAI (prompt + optional mask),
/// re-split it over the 4 existing views and reset the model3d/export stages.
/// Unlike `derive_asset` (which forks a variant), this overwrites the SAME
/// asset's sheet so the 4 views change uniformly and the user can rebuild a
/// coherent model. Requires the sheet on disk.
#[tauri::command]
pub fn edit_multiview(
    app: tauri::AppHandle,
    config: State<'_, Arc<Config>>,
    store: State<'_, Arc<Store>>,
    project: String,
    asset_id: String,
    prompt: String,
    mask_bytes: Option<Vec<u8>>,
) -> CmdResult<()> {
    let _ = store.get_asset(&project, &asset_id)?;
    if prompt.trim().is_empty() {
        return Err("le prompt d'édition est vide".into());
    }

    let mv_dir = store.multiview_dir(&project, &asset_id)?;
    let sheet = mv_dir.join("sheet.png");
    if !sheet.is_file() {
        return Err("génère d'abord la planche multivue".into());
    }

    let cfg = config.load();
    let out = run_openai_edit(&cfg, &store, &project, &asset_id, &sheet, &prompt, mask_bytes)?;

    // Re-split the edited sheet over the existing views (overwrites sheet + 4 views).
    crate::openai::split_sheet(&out.edited, &mv_dir)?;

    // Re-stamp multiview `done` (a fresh updatedAt busts the thumbnail cache) and
    // reset the 3D stages so the user rebuilds from the edited sheet.
    let mut meta = serde_json::json!({
        "model": out.model,
        "quality": out.quality,
        "files": ["sheet.png", "front.png", "back.png", "left.png", "right.png"],
        "cost": out.cost,
        "cost_source": if out.real_cost.is_some() { "api" } else { "estimate" },
        "estimated_spend_usd": out.spent,
        "edit_prompt": prompt.trim(),
    });
    if let (Some(obj), Some(u)) = (meta.as_object_mut(), out.usage) {
        obj.insert("usage".into(), u);
    }
    // Flip to a manual source so the "Tout générer" CTA short-circuits the
    // multiview stage (stage_multiview keeps the edited sheet instead of
    // regenerating it from the prompt) — same protection as edit_image.
    store.set_asset_source(&project, &asset_id, "manual")?;
    store.update_stage(&project, &asset_id, "multiview", "done", None, Some(meta))?;
    store.update_stage(&project, &asset_id, "model3d", "pending", None, None)?;
    store.update_stage(&project, &asset_id, "export", "pending", None, None)?;

    events::emit_project_changed(&app, &project);
    Ok(())
}

/// Derive a variant asset: edit the parent's multiview sheet via OpenAI
/// (prompt + optional mask), write the result into a NEW linked asset, split it
/// into the 4 views and mark its multiview stage done. 3D is NOT auto-run —
/// the user reviews the edited sheet then triggers `generate` themselves.
#[tauri::command]
pub fn derive_asset(
    app: tauri::AppHandle,
    config: State<'_, Arc<Config>>,
    store: State<'_, Arc<Store>>,
    project: String,
    asset_id: String,
    prompt: String,
    mask_bytes: Option<Vec<u8>>,
) -> CmdResult<Asset> {
    let parent = store.get_asset(&project, &asset_id)?;
    if prompt.trim().is_empty() {
        return Err("le prompt de dérivation est vide".into());
    }
    if parent.get("kind").and_then(|x| x.as_str()) == Some("texture") {
        return Err("dériver une texture n'est pas encore supporté".into());
    }

    // The derivation edits the parent's full 2x2 sheet so the 4 views stay
    // coherent and the variant can go straight to the 3D stage.
    let sheet = store.multiview_dir(&project, &asset_id)?.join("sheet.png");
    if !sheet.is_file() {
        return Err("génère d'abord la planche multivue du parent".into());
    }

    let cfg = config.load();
    let out = run_openai_edit(&cfg, &store, &project, &asset_id, &sheet, &prompt, mask_bytes)?;

    // Only create the variant once the OpenAI call has succeeded, so a failed
    // edit never leaves an orphan asset behind.
    let new = store.derive_asset_record(&project, &asset_id)?;
    let new_id = new
        .get("id")
        .and_then(|x| x.as_str())
        .ok_or("asset dérivé sans id")?
        .to_string();

    let out_dir = store.multiview_dir(&project, &new_id)?;
    crate::openai::split_sheet(&out.edited, &out_dir)?;

    // Mark the variant's multiview done (spend already debited by run_openai_edit).
    let mut meta = serde_json::json!({
        "model": out.model,
        "quality": out.quality,
        "files": ["sheet.png", "front.png", "back.png", "left.png", "right.png"],
        "cost": out.cost,
        "cost_source": if out.real_cost.is_some() { "api" } else { "estimate" },
        "estimated_spend_usd": out.spent,
        "derived_from": asset_id,
        "edit_prompt": prompt.trim(),
    });
    if let (Some(obj), Some(u)) = (meta.as_object_mut(), out.usage) {
        obj.insert("usage".into(), u);
    }
    store.update_stage(&project, &new_id, "multiview", "done", None, Some(meta))?;

    events::emit_project_changed(&app, &project);
    let new = store.get_asset(&project, &new_id)?;
    Ok(Asset::from_disk(&new))
}

// --- creative director (OpenAI text) --------------------------------------

/// Suggested sound for a pack asset (LLM ideation output).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackSoundIdea {
    pub name: String,
    pub prompt: String,
}

/// One asset proposed by the pack ideation (LLM output, user-checkable).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackAssetIdea {
    pub name: String,
    pub description: String,
    pub tags: Vec<String>,
    /// "model" | "texture"
    pub kind: String,
    pub sounds: Vec<PackSoundIdea>,
}

/// Budget gate + system prompt shared by the two director commands. Returns
/// (api_key, model, est_cost, system_prompt).
fn director_context(
    cfg: &serde_json::Value,
    store: &Store,
    project: &str,
) -> Result<(String, String, f64, String), String> {
    let api_key = crate::config::openai_key(cfg);
    if api_key.is_empty() {
        return Err("OPENAI_API_KEY absent (Réglages ou .env)".into());
    }
    let model = cfg
        .get("openai_text_model")
        .and_then(|x| x.as_str())
        .unwrap_or("gpt-4.1-mini")
        .to_string();
    let est_cost = cfg
        .get("estimated_cost_per_text")
        .and_then(|x| x.as_f64())
        .unwrap_or(0.005);
    let budget = cfg.get("budget_usd").and_then(|x| x.as_f64()).unwrap_or(5.0);
    let state = store.load_state(project).map_err(String::from)?;
    let spend = state
        .get("estimated_spend_usd")
        .and_then(|x| x.as_f64())
        .unwrap_or(0.0);
    if spend + est_cost > budget + 1e-9 {
        return Err(format!(
            "budget atteint: projeté ${:.3} > ${:.2}",
            spend + est_cost,
            budget
        ));
    }

    let dna = store.project_dna(project).map_err(String::from)?;
    let style_block = store.project_style_block(project).unwrap_or_default();
    let audio_ctx = store.project_audio_context(project).unwrap_or_default();
    let mut system = String::from(
        "You are the creative director of a Roblox asset-generation studio. \
         You write generation prompts that keep every asset (images, 3D models, \
         textures, sounds, music) coherent with the project identity below.\n",
    );
    if let Some(d) = &dna {
        if !d.game_description.trim().is_empty() {
            system.push_str(&format!("GAME: {}\n", d.game_description.trim()));
        }
    }
    if !style_block.is_empty() {
        system.push_str(&format!("VISUAL STYLE: {style_block}\n"));
    }
    if !audio_ctx.is_empty() {
        system.push_str(&format!("AUDIO STYLE: {audio_ctx}\n"));
    }
    Ok((api_key, model, est_cost, system))
}

/// Suggest 3 optimized generation prompts for one modality, coherent with the
/// project DNA (and the asset's name/description when provided).
#[tauri::command]
pub fn suggest_prompts(
    app: tauri::AppHandle,
    config: State<'_, Arc<Config>>,
    store: State<'_, Arc<Store>>,
    project: String,
    asset_id: Option<String>,
    target: String,
) -> CmdResult<Vec<String>> {
    let target_desc = match target.as_str() {
        "multiview" => {
            "the SUBJECT line of a 2x2 orthographic multi-view character/object \
             sheet for image-to-3D reconstruction. Return concise English noun \
             phrases describing the subject (creature/object + colors/materials/\
             accessories), WITHOUT style words like low-poly (the template adds them)"
        }
        "texture" => {
            "the SUBJECT of a seamless tileable game texture. Return concise \
             English noun phrases (material, pattern, colors)"
        }
        "sfx" => {
            "an ElevenLabs sound-effect generation prompt. Return short English \
             descriptions of the sound (source, character, duration feel)"
        }
        "music" => {
            "an ElevenLabs music generation prompt. Return short English \
             descriptions (genre, instrumentation, tempo, mood)"
        }
        other => return Err(format!("cible invalide: {other}")),
    };

    let cfg = config.load();
    let (api_key, model, est_cost, system) = director_context(&cfg, &store, &project)?;
    let timeout = cfg.get("openai_timeout").and_then(|x| x.as_i64()).unwrap_or(300);

    let mut user = format!("Write 3 alternative prompts for {target_desc}.");
    if let Some(aid) = asset_id.as_deref().filter(|s| !s.is_empty()) {
        let asset = store.get_asset(&project, aid)?;
        let name = asset.get("name").and_then(|x| x.as_str()).unwrap_or("");
        let description = asset.get("description").and_then(|x| x.as_str()).unwrap_or("");
        user.push_str(&format!("\nASSET: {name}"));
        if !description.trim().is_empty() {
            user.push_str(&format!(" — {description}"));
        }
    }

    let schema = serde_json::json!({
        "type": "object",
        "properties": {
            "prompts": {
                "type": "array",
                "items": {"type": "string"}
            }
        },
        "required": ["prompts"],
        "additionalProperties": false
    });
    let (out, usage) = crate::openai_text::chat_json(
        &api_key, &model, &system, &user, "prompt_suggestions", &schema, timeout,
    )?;
    let prompts: Vec<String> = out
        .get("prompts")
        .and_then(|p| p.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .filter(|s| !s.trim().is_empty())
                .collect()
        })
        .unwrap_or_default();
    if prompts.is_empty() {
        return Err("le modèle n'a renvoyé aucune suggestion".into());
    }
    let cost = usage
        .as_ref()
        .and_then(|u| crate::config::text_cost_from_usage(&cfg, &model, u))
        .unwrap_or(est_cost);
    let _ = store.add_spend(&project, cost)?;
    events::emit_project_changed(&app, &project);
    Ok(prompts)
}

/// Ideate a whole asset pack from the project DNA + a free-text brief. The
/// frontend lets the user check ideas and creates assets/sounds itself.
#[tauri::command]
pub fn ideate_pack(
    app: tauri::AppHandle,
    config: State<'_, Arc<Config>>,
    store: State<'_, Arc<Store>>,
    project: String,
    brief: String,
) -> CmdResult<Vec<PackAssetIdea>> {
    if brief.trim().is_empty() {
        return Err("la consigne est vide".into());
    }
    let cfg = config.load();
    let (api_key, model, est_cost, system) = director_context(&cfg, &store, &project)?;
    let timeout = cfg.get("openai_timeout").and_then(|x| x.as_i64()).unwrap_or(300);

    let user = format!(
        "Propose a coherent pack of game assets for this brief: \"{}\".\n\
         For each asset return:\n\
         - name: short French display name\n\
         - description: concise English noun phrase describing the subject \
           (creature/object/material + colors/materials/accessories), WITHOUT \
           style words like low-poly (the generation template adds them)\n\
         - tags: 1-3 short French tags\n\
         - kind: \"model\" for a 3D model, \"texture\" for a seamless tileable texture\n\
         - sounds: 0-2 suggested sound effects (name: short French name, prompt: \
           short English SFX description)\n\
         Follow any asset count requested in the brief (default ~8).",
        brief.trim()
    );

    let schema = serde_json::json!({
        "type": "object",
        "properties": {
            "assets": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "description": {"type": "string"},
                        "tags": {"type": "array", "items": {"type": "string"}},
                        "kind": {"type": "string", "enum": ["model", "texture"]},
                        "sounds": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "name": {"type": "string"},
                                    "prompt": {"type": "string"}
                                },
                                "required": ["name", "prompt"],
                                "additionalProperties": false
                            }
                        }
                    },
                    "required": ["name", "description", "tags", "kind", "sounds"],
                    "additionalProperties": false
                }
            }
        },
        "required": ["assets"],
        "additionalProperties": false
    });
    let (out, usage) = crate::openai_text::chat_json(
        &api_key, &model, &system, &user, "pack_ideas", &schema, timeout,
    )?;
    let ideas: Vec<PackAssetIdea> = serde_json::from_value(
        out.get("assets").cloned().unwrap_or(serde_json::json!([])),
    )
    .map_err(|e| format!("réponse du modèle invalide: {e}"))?;
    if ideas.is_empty() {
        return Err("le modèle n'a proposé aucun asset".into());
    }
    let cost = usage
        .as_ref()
        .and_then(|u| crate::config::text_cost_from_usage(&cfg, &model, u))
        .unwrap_or(est_cost);
    let _ = store.add_spend(&project, cost)?;
    events::emit_project_changed(&app, &project);
    Ok(ideas)
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

/// Stop the in-flight generation WITHOUT unloading the models: flag the job for
/// cancellation (the runner resets its stages to `pending`) and POST `/interrupt`
/// to the inference server so it aborts the current GPU run between diffusion
/// steps (models stay resident — unlike stopping the server). Returns whether the
/// server acknowledged the interrupt; the job flag is set regardless.
#[tauri::command]
pub fn cancel_generation(
    jobs: State<'_, Arc<JobManager>>,
    supervisor: State<'_, Arc<Supervisor>>,
) -> CmdResult<bool> {
    // Set the flag first so the interrupt-induced stage error is read as a cancel.
    jobs.request_cancel();
    Ok(supervisor.interrupt())
}

/// Drop all queued (not-yet-started) jobs and reset their stages to `pending`.
/// The running job keeps going — use `cancel_generation` to stop that one.
#[tauri::command]
pub fn clear_queue(
    store: State<'_, Arc<Store>>,
    jobs: State<'_, Arc<JobManager>>,
) -> CmdResult<()> {
    jobs.clear_queue(store.inner().as_ref())?;
    Ok(())
}

/// Remove a single queued job by id and reset its stages to `pending`. No-op for
/// the job currently running (the queue head) — cancel it instead.
#[tauri::command]
pub fn remove_queued(
    store: State<'_, Arc<Store>>,
    jobs: State<'_, Arc<JobManager>>,
    job_id: u64,
) -> CmdResult<()> {
    jobs.remove_queued(store.inner().as_ref(), job_id)?;
    Ok(())
}

// --- config -------------------------------------------------------------

#[tauri::command]
pub fn get_config(config: State<'_, Arc<Config>>) -> CmdResult<ConfigPublic> {
    let cfg = config.load();
    let key_set = !crate::config::openai_key(&cfg).is_empty();
    let admin_set = !crate::config::openai_admin_key(&cfg).is_empty();
    let el_set = !crate::config::elevenlabs_key(&cfg).is_empty();
    Ok(ConfigPublic::from_config(&cfg, key_set, admin_set, el_set))
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
    let admin_set = !crate::config::openai_admin_key(&saved).is_empty();
    let el_set = !crate::config::elevenlabs_key(&saved).is_empty();
    Ok(ConfigPublic::from_config(&saved, key_set, admin_set, el_set))
}

/// Real billed costs of the OpenAI organization (admin key required), daily
/// buckets over the last `days` days (default 30). Straight from OpenAI's
/// books — covers EVERYTHING billed on the org, not just this app.
#[tauri::command]
pub fn openai_costs(
    config: State<'_, Arc<Config>>,
    days: Option<i64>,
) -> CmdResult<crate::openai_admin::CostsSummary> {
    let cfg = config.load();
    let admin_key = crate::config::openai_admin_key(&cfg);
    if admin_key.is_empty() {
        return Err(
            "clé admin OpenAI absente — crée une clé sk-admin… sur \
             platform.openai.com (Organization → Admin keys) et renseigne-la \
             dans les Réglages"
                .into(),
        );
    }
    let days = days.unwrap_or(30).clamp(1, 180);
    let start = chrono::Utc::now().timestamp() - days * 86_400;
    crate::openai_admin::costs(&admin_key, start, 60).map_err(Into::into)
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

/// Optional add-on: download the native text-to-image model (HunyuanDiT) and
/// enable text-to-3D on the mv2 server. Requires mv2 already installed.
#[tauri::command]
pub fn install_text3d(
    app: tauri::AppHandle,
    installer: State<'_, Arc<Installer>>,
    supervisor: State<'_, Arc<Supervisor>>,
) -> CmdResult<InstallProgress> {
    let progress = installer
        .inner()
        .install_text3d(app, Arc::clone(supervisor.inner()))?;
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

/// Write raw bytes (e.g. a viewer screenshot PNG) to a user-chosen absolute path.
/// The destination comes from the native save dialog on the frontend.
#[tauri::command]
pub fn save_render(dest: String, bytes: Vec<u8>) -> CmdResult<()> {
    if bytes.is_empty() {
        return Err("capture vide".into());
    }
    let dest = std::path::PathBuf::from(&dest);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(AppError::from)?;
    }
    std::fs::write(&dest, &bytes)
        .map_err(|e| AppError::msg(format!("échec de l'écriture vers {}: {e}", dest.display())))?;
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
    asset_id: Option<String>,
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
    // A linked asset must exist.
    let asset_id = asset_id.filter(|s| !s.is_empty());
    if let Some(aid) = &asset_id {
        let _ = store.get_asset(&project, aid)?;
    }
    let params = params.unwrap_or_else(|| serde_json::json!({}));
    let item = store.add_audio_item(
        &project,
        &kind,
        name.trim(),
        text.trim(),
        voice_id.as_deref().filter(|s| !s.is_empty()),
        asset_id.as_deref(),
        params,
    )?;
    events::emit_project_changed(&app, &project);
    Ok(item)
}

/// Link (or unlink, when `asset_id` is null/empty) an audio item to an asset.
#[tauri::command]
pub fn set_audio_item_asset(
    app: tauri::AppHandle,
    store: State<'_, Arc<Store>>,
    project: String,
    item_id: String,
    asset_id: Option<String>,
) -> CmdResult<()> {
    let asset_id = asset_id.filter(|s| !s.is_empty());
    if let Some(aid) = &asset_id {
        let _ = store.get_asset(&project, aid)?;
    }
    store.set_audio_item_asset(&project, &item_id, asset_id.as_deref())?;
    events::emit_project_changed(&app, &project);
    Ok(())
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
