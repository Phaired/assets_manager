//! JSON persistence on disk: projects, assets and pipeline state.
//!
//! Port of `app/store.py`. Atomic writes (tmp + rename) guarded by a global
//! re-entrant lock (single-user app). project.json / state.json keep their
//! snake_case keys on disk.

use std::path::PathBuf;

use chrono::Utc;
use deunicode::deunicode;
use parking_lot::ReentrantMutex;
use serde_json::{json, Value};

use crate::config::Config;
use crate::error::{AppError, AppResult};
use crate::types::{AudioItem, Voice, STAGES, VIEW_FILES};

/// Re-entrant global lock matching the Python `_LOCK` (RLock).
static LOCK: ReentrantMutex<()> = ReentrantMutex::new(());

pub fn now() -> String {
    // ISO-8601 with offset, matching datetime.now(timezone.utc).isoformat().
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Micros, false)
}

/// Slugify: transliterate to ASCII (deunicode), collapse non-alphanumerics to
/// '-', strip leading/trailing '-', lowercase. Empty -> "item".
pub fn slugify(text: &str) -> String {
    let ascii = deunicode(text);
    let mut out = String::with_capacity(ascii.len());
    let mut prev_dash = false;
    for ch in ascii.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    let trimmed = out.trim_matches('-').to_lowercase();
    if trimmed.is_empty() {
        "item".to_string()
    } else {
        trimmed
    }
}

pub struct Store {
    config: std::sync::Arc<Config>,
}

impl Store {
    pub fn new(config: std::sync::Arc<Config>) -> Self {
        Self { config }
    }

    // --- paths -----------------------------------------------------------

    pub fn workspace_dir(&self) -> AppResult<PathBuf> {
        self.config.workspace_dir()
    }

    pub fn project_dir(&self, name: &str) -> AppResult<PathBuf> {
        Ok(self.workspace_dir()?.join(name))
    }

    pub fn asset_dir(&self, project: &str, asset_id: &str) -> AppResult<PathBuf> {
        Ok(self.project_dir(project)?.join(asset_id))
    }

    pub fn multiview_dir(&self, project: &str, asset_id: &str) -> AppResult<PathBuf> {
        Ok(self.asset_dir(project, asset_id)?.join("multiview"))
    }

    pub fn model_path(&self, project: &str, asset_id: &str) -> AppResult<PathBuf> {
        Ok(self.asset_dir(project, asset_id)?.join("model.glb"))
    }

    pub fn source_image_path(&self, project: &str, asset_id: &str) -> AppResult<PathBuf> {
        Ok(self.asset_dir(project, asset_id)?.join("source.png"))
    }

    pub fn obj_path(&self, project: &str, asset_id: &str) -> AppResult<PathBuf> {
        Ok(self
            .asset_dir(project, asset_id)?
            .join("obj")
            .join(format!("{asset_id}.obj")))
    }

    // --- audio paths -----------------------------------------------------

    /// Absolute path of the generated mp3 for an audio item.
    pub fn audio_file_path(&self, project: &str, kind: &str, id: &str) -> AppResult<PathBuf> {
        Ok(self
            .project_dir(project)?
            .join("audio")
            .join(kind)
            .join(format!("{id}.mp3")))
    }

    /// Project-relative path of the generated mp3 (stored in audio.json / used by
    /// the frontend via `convertFileSrc(project_file_src(...))`).
    pub fn audio_file_rel(kind: &str, id: &str) -> String {
        format!("audio/{kind}/{id}.mp3")
    }

    fn audio_manifest_path(&self, project: &str) -> AppResult<PathBuf> {
        Ok(self.project_dir(project)?.join("audio.json"))
    }

    /// Global designed-voice catalog (reusable across projects).
    fn voices_path(&self) -> PathBuf {
        crate::config::data_root().join("voices.json")
    }

    // --- atomic io -------------------------------------------------------

    fn read_json(path: &PathBuf, default: Value) -> Value {
        if path.is_file() {
            match std::fs::read_to_string(path) {
                Ok(text) => serde_json::from_str(&text).unwrap_or(default),
                Err(_) => default,
            }
        } else {
            default
        }
    }

    fn write_json(path: &PathBuf, data: &Value) -> AppResult<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = path.with_extension("tmp");
        let text = serde_json::to_string_pretty(data)?;
        std::fs::write(&tmp, text)?;
        if path.exists() {
            let _ = std::fs::remove_file(path);
        }
        std::fs::rename(&tmp, path)?;
        Ok(())
    }

    // --- projects --------------------------------------------------------

    pub fn list_projects(&self) -> AppResult<Vec<String>> {
        let root = self.workspace_dir()?;
        let mut names = Vec::new();
        if let Ok(entries) = std::fs::read_dir(&root) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() && path.join("project.json").is_file() {
                    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                        names.push(name.to_string());
                    }
                }
            }
        }
        names.sort();
        Ok(names)
    }

    pub fn create_project(&self, name: &str) -> AppResult<Value> {
        let name = slugify(name);
        let _guard = LOCK.lock();
        let path = self.project_dir(&name)?.join("project.json");
        if path.is_file() {
            return Ok(Self::read_json(&path, json!({})));
        }
        let data = json!({"name": name, "created_at": now(), "style": "", "assets": []});
        Self::write_json(&path, &data)?;
        Self::write_json(
            &self.project_dir(&name)?.join("state.json"),
            &json!({"version": 1, "estimated_spend_usd": 0.0, "assets": {}}),
        )?;
        Ok(data)
    }

    pub fn get_project(&self, name: &str) -> AppResult<Value> {
        let path = self.project_dir(name)?.join("project.json");
        let data = Self::read_json(&path, Value::Null);
        if data.is_null() {
            return Err(AppError::ProjectNotFound(name.to_string()));
        }
        Ok(data)
    }

    fn save_project(&self, name: &str, data: &Value) -> AppResult<()> {
        Self::write_json(&self.project_dir(name)?.join("project.json"), data)
    }

    pub fn get_asset(&self, project: &str, asset_id: &str) -> AppResult<Value> {
        let data = self.get_project(project)?;
        if let Some(assets) = data.get("assets").and_then(|a| a.as_array()) {
            for asset in assets {
                if asset.get("id").and_then(|x| x.as_str()) == Some(asset_id) {
                    return Ok(asset.clone());
                }
            }
        }
        Err(AppError::AssetNotFound {
            project: project.to_string(),
            asset_id: asset_id.to_string(),
        })
    }

    pub fn add_asset(
        &self,
        project: &str,
        name: &str,
        description: &str,
        tags: Vec<String>,
        backend: &str,
    ) -> AppResult<Value> {
        let _guard = LOCK.lock();
        let mut data = self.get_project(project)?;
        let base = slugify(name);
        let existing: std::collections::HashSet<String> = data
            .get("assets")
            .and_then(|a| a.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|a| a.get("id").and_then(|x| x.as_str()).map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        let mut asset_id = base.clone();
        let mut i = 2;
        while existing.contains(&asset_id) {
            asset_id = format!("{base}-{i}");
            i += 1;
        }
        let asset = json!({
            "id": asset_id,
            "name": name,
            "description": description,
            "tags": tags,
            "backend": backend,
            "source": "openai",
            "created_at": now(),
        });
        data.get_mut("assets")
            .and_then(|a| a.as_array_mut())
            .ok_or_else(|| AppError::msg("project.json corrompu: assets manquant"))?
            .push(asset.clone());
        self.save_project(project, &data)?;
        // initialise state
        let mut state = self.load_state(project)?;
        let stages = blank_stages();
        state
            .get_mut("assets")
            .and_then(|a| a.as_object_mut())
            .map(|m| m.insert(asset_id.clone(), stages));
        self.save_state(project, &state)?;
        Ok(asset)
    }

    pub fn delete_asset(&self, project: &str, asset_id: &str) -> AppResult<()> {
        let _guard = LOCK.lock();
        let mut data = self.get_project(project)?;
        if let Some(arr) = data.get_mut("assets").and_then(|a| a.as_array_mut()) {
            arr.retain(|a| a.get("id").and_then(|x| x.as_str()) != Some(asset_id));
        }
        self.save_project(project, &data)?;
        let mut state = self.load_state(project)?;
        if let Some(m) = state.get_mut("assets").and_then(|a| a.as_object_mut()) {
            m.remove(asset_id);
        }
        self.save_state(project, &state)?;
        let adir = self.asset_dir(project, asset_id)?;
        if adir.is_dir() {
            let _ = std::fs::remove_dir_all(&adir);
        }
        Ok(())
    }

    /// Read the project's free-text style (empty if unset).
    pub fn project_style(&self, project: &str) -> AppResult<String> {
        let data = self.get_project(project)?;
        Ok(data
            .get("style")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string())
    }

    /// Persist the project's free-text style into project.json.
    pub fn set_project_style(&self, project: &str, style: &str) -> AppResult<()> {
        let _guard = LOCK.lock();
        let mut data = self.get_project(project)?;
        data.as_object_mut()
            .ok_or_else(|| AppError::msg("project.json corrompu"))?
            .insert("style".into(), Value::String(style.to_string()));
        self.save_project(project, &data)
    }

    /// Set (or clear, when `override_obj` is empty) the per-asset gen3d override
    /// stored on the asset in project.json. Keys are snake_case to merge cleanly
    /// over the global `gen3d` config at run time.
    pub fn set_asset_gen3d(
        &self,
        project: &str,
        asset_id: &str,
        override_obj: Value,
    ) -> AppResult<()> {
        let _guard = LOCK.lock();
        let mut data = self.get_project(project)?;
        let mut found = false;
        if let Some(arr) = data.get_mut("assets").and_then(|a| a.as_array_mut()) {
            for asset in arr.iter_mut() {
                if asset.get("id").and_then(|x| x.as_str()) == Some(asset_id) {
                    if let Some(o) = asset.as_object_mut() {
                        let empty = override_obj
                            .as_object()
                            .map(|m| m.is_empty())
                            .unwrap_or(true);
                        if empty {
                            o.remove("gen3d");
                        } else {
                            o.insert("gen3d".into(), override_obj.clone());
                        }
                    }
                    found = true;
                    break;
                }
            }
        }
        if !found {
            return Err(AppError::AssetNotFound {
                project: project.to_string(),
                asset_id: asset_id.to_string(),
            });
        }
        self.save_project(project, &data)
    }

    /// Change an asset's 3D backend ("auto" | "v21" | "mv2") after creation.
    pub fn set_asset_backend(&self, project: &str, asset_id: &str, backend: &str) -> AppResult<()> {
        let _guard = LOCK.lock();
        let mut data = self.get_project(project)?;
        let mut found = false;
        if let Some(arr) = data.get_mut("assets").and_then(|a| a.as_array_mut()) {
            for asset in arr.iter_mut() {
                if asset.get("id").and_then(|x| x.as_str()) == Some(asset_id) {
                    asset
                        .as_object_mut()
                        .map(|o| o.insert("backend".into(), Value::String(backend.to_string())));
                    found = true;
                    break;
                }
            }
        }
        if !found {
            return Err(AppError::AssetNotFound {
                project: project.to_string(),
                asset_id: asset_id.to_string(),
            });
        }
        self.save_project(project, &data)
    }

    pub fn set_asset_source(&self, project: &str, asset_id: &str, source: &str) -> AppResult<()> {
        let _guard = LOCK.lock();
        let mut data = self.get_project(project)?;
        if let Some(arr) = data.get_mut("assets").and_then(|a| a.as_array_mut()) {
            for asset in arr.iter_mut() {
                if asset.get("id").and_then(|x| x.as_str()) == Some(asset_id) {
                    asset
                        .as_object_mut()
                        .map(|o| o.insert("source".into(), Value::String(source.to_string())));
                    break;
                }
            }
        }
        self.save_project(project, &data)
    }

    // --- state -----------------------------------------------------------

    pub fn load_state(&self, project: &str) -> AppResult<Value> {
        let path = self.project_dir(project)?.join("state.json");
        Ok(Self::read_json(
            &path,
            json!({"version": 1, "estimated_spend_usd": 0.0, "assets": {}}),
        ))
    }

    pub fn save_state(&self, project: &str, state: &Value) -> AppResult<()> {
        Self::write_json(&self.project_dir(project)?.join("state.json"), state)
    }

    pub fn update_stage(
        &self,
        project: &str,
        asset_id: &str,
        stage: &str,
        status: &str,
        error: Option<&str>,
        meta: Option<Value>,
    ) -> AppResult<()> {
        let _guard = LOCK.lock();
        let mut state = self.load_state(project)?;
        let assets = state
            .as_object_mut()
            .unwrap()
            .entry("assets")
            .or_insert_with(|| Value::Object(Default::default()));
        let assets_obj = assets.as_object_mut().unwrap();
        let stages = assets_obj
            .entry(asset_id.to_string())
            .or_insert_with(blank_stages);
        let stages_obj = stages.as_object_mut().unwrap();
        let entry = stages_obj
            .entry(stage.to_string())
            .or_insert_with(blank_stage);
        let entry_obj = entry.as_object_mut().unwrap();
        entry_obj.insert("status".into(), Value::String(status.to_string()));
        entry_obj.insert("updated_at".into(), Value::String(now()));
        entry_obj.insert(
            "error".into(),
            match error {
                Some(e) => Value::String(e.to_string()),
                None => Value::Null,
            },
        );
        if let Some(m) = meta {
            entry_obj.insert("meta".into(), m);
        }
        self.save_state(project, &state)
    }

    /// At startup: a job marked 'running'/'queued' cannot survive a restart
    /// (worker was in memory). Mark them 'error' to unblock the UI.
    pub fn reset_stale_stages(&self) -> AppResult<usize> {
        let _guard = LOCK.lock();
        let mut count = 0usize;
        for project in self.list_projects()? {
            let mut state = self.load_state(&project)?;
            let mut changed = false;
            if let Some(assets) = state.get_mut("assets").and_then(|a| a.as_object_mut()) {
                for (_aid, stages) in assets.iter_mut() {
                    if let Some(sobj) = stages.as_object_mut() {
                        for (_stage, entry) in sobj.iter_mut() {
                            let st = entry
                                .get("status")
                                .and_then(|x| x.as_str())
                                .unwrap_or("");
                            if st == "running" || st == "queued" {
                                if let Some(eo) = entry.as_object_mut() {
                                    eo.insert("status".into(), Value::String("error".into()));
                                    eo.insert("updated_at".into(), Value::String(now()));
                                    eo.insert(
                                        "error".into(),
                                        Value::String(
                                            "interrompu (redemarrage de l'app)".into(),
                                        ),
                                    );
                                }
                                changed = true;
                                count += 1;
                            }
                        }
                    }
                }
            }
            if changed {
                self.save_state(&project, &state)?;
            }
        }
        Ok(count)
    }

    /// Reset blocked stages (running/queued/error) of an asset back to 'pending'.
    pub fn reset_asset(&self, project: &str, asset_id: &str) -> AppResult<()> {
        let _guard = LOCK.lock();
        let mut state = self.load_state(project)?;
        let mut changed = false;
        if let Some(stages) = state
            .get_mut("assets")
            .and_then(|a| a.as_object_mut())
            .and_then(|m| m.get_mut(asset_id))
            .and_then(|s| s.as_object_mut())
        {
            for (_stage, entry) in stages.iter_mut() {
                let st = entry.get("status").and_then(|x| x.as_str()).unwrap_or("");
                if st == "running" || st == "queued" || st == "error" {
                    if let Some(eo) = entry.as_object_mut() {
                        eo.insert("status".into(), Value::String("pending".into()));
                        eo.insert("updated_at".into(), Value::String(now()));
                        eo.insert("error".into(), Value::Null);
                    }
                    changed = true;
                }
            }
        } else {
            return Ok(());
        }
        if changed {
            self.save_state(project, &state)?;
        }
        Ok(())
    }

    pub fn add_spend(&self, project: &str, amount: f64) -> AppResult<f64> {
        let _guard = LOCK.lock();
        let mut state = self.load_state(project)?;
        let current = state
            .get("estimated_spend_usd")
            .and_then(|x| x.as_f64())
            .unwrap_or(0.0);
        // round to 6 decimals like Python `round(..., 6)`.
        let total = ((current + amount) * 1_000_000.0).round() / 1_000_000.0;
        state
            .as_object_mut()
            .unwrap()
            .insert("estimated_spend_usd".into(), json!(total));
        self.save_state(project, &state)?;
        Ok(total)
    }

    /// Helper used by the model3d stage: list missing mv2 view files.
    pub fn missing_views(&self, project: &str, asset_id: &str) -> AppResult<Vec<String>> {
        let dir = self.multiview_dir(project, asset_id)?;
        Ok(VIEW_FILES
            .iter()
            .filter(|v| !dir.join(v).is_file())
            .map(|v| v.to_string())
            .collect())
    }

    // --- audio items (per project, audio.json) ---------------------------

    fn load_audio_raw(&self, project: &str) -> AppResult<Value> {
        let path = self.audio_manifest_path(project)?;
        Ok(Self::read_json(&path, json!({"version": 1, "items": []})))
    }

    fn save_audio_raw(&self, project: &str, data: &Value) -> AppResult<()> {
        Self::write_json(&self.audio_manifest_path(project)?, data)
    }

    pub fn list_audio_items(&self, project: &str) -> AppResult<Vec<AudioItem>> {
        let data = self.load_audio_raw(project)?;
        Ok(data
            .get("items")
            .and_then(|x| x.as_array())
            .map(|a| a.iter().map(AudioItem::from_disk).collect())
            .unwrap_or_default())
    }

    pub fn get_audio_item(&self, project: &str, item_id: &str) -> AppResult<AudioItem> {
        self.list_audio_items(project)?
            .into_iter()
            .find(|it| it.id == item_id)
            .ok_or_else(|| AppError::msg(format!("item audio introuvable: {item_id}")))
    }

    pub fn add_audio_item(
        &self,
        project: &str,
        kind: &str,
        name: &str,
        text: &str,
        voice_id: Option<&str>,
        params: Value,
    ) -> AppResult<AudioItem> {
        let _guard = LOCK.lock();
        // Ensure the project exists.
        let _ = self.get_project(project)?;
        let mut data = self.load_audio_raw(project)?;
        let base = slugify(name);
        let existing: std::collections::HashSet<String> = data
            .get("items")
            .and_then(|x| x.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|it| it.get("id").and_then(|x| x.as_str()).map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        let mut id = base.clone();
        let mut i = 2;
        while existing.contains(&id) {
            id = format!("{base}-{i}");
            i += 1;
        }
        let item = json!({
            "id": id,
            "kind": kind,
            "name": name,
            "text": text,
            "voice_id": voice_id.unwrap_or(""),
            "params": params,
            "status": "pending",
            "error": null,
            "file": null,
            "created_at": now(),
            "updated_at": null,
        });
        data.as_object_mut()
            .unwrap()
            .entry("items")
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .unwrap()
            .push(item.clone());
        self.save_audio_raw(project, &data)?;
        Ok(AudioItem::from_disk(&item))
    }

    pub fn delete_audio_item(&self, project: &str, item_id: &str) -> AppResult<()> {
        let _guard = LOCK.lock();
        let mut data = self.load_audio_raw(project)?;
        let file_rel = data
            .get("items")
            .and_then(|x| x.as_array())
            .and_then(|arr| {
                arr.iter()
                    .find(|it| it.get("id").and_then(|x| x.as_str()) == Some(item_id))
                    .and_then(|it| it.get("file").and_then(|x| x.as_str()))
                    .map(|s| s.to_string())
            });
        if let Some(arr) = data.get_mut("items").and_then(|x| x.as_array_mut()) {
            arr.retain(|it| it.get("id").and_then(|x| x.as_str()) != Some(item_id));
        }
        self.save_audio_raw(project, &data)?;
        if let Some(rel) = file_rel {
            let p = self.project_dir(project)?.join(rel);
            if p.is_file() {
                let _ = std::fs::remove_file(p);
            }
        }
        Ok(())
    }

    /// Update an audio item's status (+ optional error / generated file path).
    pub fn update_audio_status(
        &self,
        project: &str,
        item_id: &str,
        status: &str,
        error: Option<&str>,
        file: Option<&str>,
    ) -> AppResult<()> {
        let _guard = LOCK.lock();
        let mut data = self.load_audio_raw(project)?;
        let mut found = false;
        if let Some(arr) = data.get_mut("items").and_then(|x| x.as_array_mut()) {
            for it in arr.iter_mut() {
                if it.get("id").and_then(|x| x.as_str()) == Some(item_id) {
                    if let Some(o) = it.as_object_mut() {
                        o.insert("status".into(), Value::String(status.to_string()));
                        o.insert("updated_at".into(), Value::String(now()));
                        o.insert(
                            "error".into(),
                            match error {
                                Some(e) => Value::String(e.to_string()),
                                None => Value::Null,
                            },
                        );
                        if let Some(f) = file {
                            o.insert("file".into(), Value::String(f.to_string()));
                        }
                    }
                    found = true;
                    break;
                }
            }
        }
        if !found {
            return Err(AppError::msg(format!("item audio introuvable: {item_id}")));
        }
        self.save_audio_raw(project, &data)
    }

    /// At startup: audio items left `running`/`queued` cannot survive a restart.
    pub fn reset_stale_audio(&self) -> AppResult<usize> {
        let _guard = LOCK.lock();
        let mut count = 0usize;
        for project in self.list_projects()? {
            let mut data = self.load_audio_raw(&project)?;
            let mut changed = false;
            if let Some(arr) = data.get_mut("items").and_then(|x| x.as_array_mut()) {
                for it in arr.iter_mut() {
                    let st = it.get("status").and_then(|x| x.as_str()).unwrap_or("");
                    if st == "running" || st == "queued" {
                        if let Some(o) = it.as_object_mut() {
                            o.insert("status".into(), Value::String("error".into()));
                            o.insert("updated_at".into(), Value::String(now()));
                            o.insert(
                                "error".into(),
                                Value::String("interrompu (redémarrage de l'app)".into()),
                            );
                        }
                        changed = true;
                        count += 1;
                    }
                }
            }
            if changed {
                self.save_audio_raw(&project, &data)?;
            }
        }
        Ok(count)
    }

    // --- voices (global catalog, voices.json) ----------------------------

    pub fn list_voices(&self) -> AppResult<Vec<Voice>> {
        let path = self.voices_path();
        let data = Self::read_json(&path, json!({"version": 1, "voices": []}));
        Ok(data
            .get("voices")
            .and_then(|x| x.as_array())
            .map(|a| a.iter().map(Voice::from_disk).collect())
            .unwrap_or_default())
    }

    pub fn get_voice(&self, voice_id: &str) -> AppResult<Voice> {
        self.list_voices()?
            .into_iter()
            .find(|v| v.voice_id == voice_id)
            .ok_or_else(|| AppError::msg(format!("voix introuvable: {voice_id}")))
    }

    pub fn add_voice(&self, voice: &Voice) -> AppResult<()> {
        let _guard = LOCK.lock();
        let path = self.voices_path();
        let mut data = Self::read_json(&path, json!({"version": 1, "voices": []}));
        data.as_object_mut()
            .unwrap()
            .entry("voices")
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .unwrap()
            .push(voice.to_disk());
        Self::write_json(&path, &data)
    }

    pub fn delete_voice(&self, voice_id: &str) -> AppResult<()> {
        let _guard = LOCK.lock();
        let path = self.voices_path();
        let mut data = Self::read_json(&path, json!({"version": 1, "voices": []}));
        if let Some(arr) = data.get_mut("voices").and_then(|x| x.as_array_mut()) {
            arr.retain(|v| v.get("voice_id").and_then(|x| x.as_str()) != Some(voice_id));
        }
        Self::write_json(&path, &data)
    }
}

/// A blank stage entry (snake_case on disk).
pub fn blank_stage() -> Value {
    json!({"status": "pending", "updated_at": null, "error": null, "meta": {}})
}

/// `{ stage -> blank_stage }` for all STAGES.
pub fn blank_stages() -> Value {
    let mut m = serde_json::Map::new();
    for s in STAGES {
        m.insert(s.to_string(), blank_stage());
    }
    Value::Object(m)
}
