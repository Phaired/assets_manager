//! Bridge DTOs (camelCase over the Tauri boundary) plus mapping to/from the
//! snake_case on-disk JSON. On-disk shapes (project.json / state.json / config.json)
//! are kept verbatim for backward compatibility; only the bridge payloads are
//! camelCase.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const STAGES: [&str; 3] = ["multiview", "model3d", "export"];
/// Stages of a `kind == "texture"` asset (single OpenAI image, no 3D).
pub const TEXTURE_STAGES: [&str; 1] = ["texture"];
pub const VIEW_FILES: [&str; 4] = ["front.png", "back.png", "left.png", "right.png"];

// --- Asset --------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub id: String,
    pub name: String,
    pub description: String,
    pub tags: Vec<String>,
    /// "model" (image → multiview → 3D → export) or "texture" (single
    /// seamless tileable image). Defaults to "model" on legacy assets.
    pub kind: String,
    pub backend: String,
    pub source: String,
    pub created_at: String,
    /// Per-asset 3D generation override (partial gen3d, camelCase). Absent when
    /// the asset uses the global defaults. Merged over config `gen3d` at run time.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gen3d: Option<Value>,
    /// Per-asset 3D seed override. Absent → derived from the asset id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seed: Option<i64>,
    /// Per-asset multiview prompt override. Absent → uses the global template.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_override: Option<String>,
}

impl Asset {
    /// Build from the snake_case on-disk JSON object.
    pub fn from_disk(v: &Value) -> Self {
        Asset {
            id: str_field(v, "id"),
            name: str_field(v, "name"),
            description: str_field(v, "description"),
            tags: v
                .get("tags")
                .and_then(|t| t.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|x| x.as_str().map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default(),
            kind: v
                .get("kind")
                .and_then(|x| x.as_str())
                .unwrap_or("model")
                .to_string(),
            backend: v
                .get("backend")
                .and_then(|x| x.as_str())
                .unwrap_or("auto")
                .to_string(),
            source: v
                .get("source")
                .and_then(|x| x.as_str())
                .unwrap_or("openai")
                .to_string(),
            created_at: str_field(v, "created_at"),
            // On disk gen3d is stored snake_case; expose it to the bridge as the
            // camelCase the UI uses.
            gen3d: v.get("gen3d").map(gen3d_disk_to_camel),
            seed: v.get("seed").and_then(|x| x.as_i64()),
            prompt_override: v
                .get("prompt_override")
                .and_then(|x| x.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string()),
        }
    }
}

// --- StageState ---------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageState {
    pub status: String,
    pub updated_at: Option<String>,
    pub error: Option<String>,
    pub meta: Value,
}

impl StageState {
    pub fn from_disk(v: &Value) -> Self {
        StageState {
            status: v
                .get("status")
                .and_then(|x| x.as_str())
                .unwrap_or("pending")
                .to_string(),
            updated_at: v
                .get("updated_at")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string()),
            error: v
                .get("error")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string()),
            meta: v.get("meta").cloned().unwrap_or_else(|| Value::Object(Default::default())),
        }
    }
}

// --- Project ------------------------------------------------------------

/// Project identity sheet ("DNA") injected into every generation pipeline
/// (image prompts, SFX/music context, texture prompts). Stored snake_case in
/// project.json under "dna"; absent on legacy projects (style fallback applies).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDna {
    /// What the game / experience is about (used by the LLM director).
    pub game_description: String,
    /// Visual style (e.g. "low-poly, flat colors").
    pub art_style: String,
    /// Color palette (e.g. "vives, saturées, pastel").
    pub palette: String,
    /// Visual mood / ambiance (e.g. "cartoon joyeux").
    pub ambiance: String,
    /// Audio tone (e.g. "léger, comique").
    pub audio_tone: String,
    /// Instrumentation (e.g. "8-bit, percussions douces").
    pub audio_instrumentation: String,
    /// Audio mood (e.g. "énergique, fun").
    pub audio_mood: String,
}

impl ProjectDna {
    pub fn from_disk(v: &Value) -> Self {
        ProjectDna {
            game_description: str_field(v, "game_description"),
            art_style: str_field(v, "art_style"),
            palette: str_field(v, "palette"),
            ambiance: str_field(v, "ambiance"),
            audio_tone: str_field(v, "audio_tone"),
            audio_instrumentation: str_field(v, "audio_instrumentation"),
            audio_mood: str_field(v, "audio_mood"),
        }
    }

    /// Snake_case JSON for project.json.
    pub fn to_disk(&self) -> Value {
        serde_json::json!({
            "game_description": self.game_description,
            "art_style": self.art_style,
            "palette": self.palette,
            "ambiance": self.ambiance,
            "audio_tone": self.audio_tone,
            "audio_instrumentation": self.audio_instrumentation,
            "audio_mood": self.audio_mood,
        })
    }

    /// Composed visual style block injected into the `{style}` placeholder of
    /// image prompt templates. Empty fields are omitted.
    pub fn style_block(&self) -> String {
        let mut parts = Vec::new();
        if !self.art_style.trim().is_empty() {
            parts.push(format!("Art direction: {}.", self.art_style.trim()));
        }
        if !self.palette.trim().is_empty() {
            parts.push(format!("Color palette: {}.", self.palette.trim()));
        }
        if !self.ambiance.trim().is_empty() {
            parts.push(format!("Mood: {}.", self.ambiance.trim()));
        }
        parts.join(" ")
    }

    /// Composed audio context appended to SFX/music prompts. Empty fields omitted.
    pub fn audio_context(&self) -> String {
        let mut parts = Vec::new();
        if !self.audio_tone.trim().is_empty() {
            parts.push(format!("Tone: {}.", self.audio_tone.trim()));
        }
        if !self.audio_instrumentation.trim().is_empty() {
            parts.push(format!("Instrumentation: {}.", self.audio_instrumentation.trim()));
        }
        if !self.audio_mood.trim().is_empty() {
            parts.push(format!("Mood: {}.", self.audio_mood.trim()));
        }
        parts.join(" ")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub name: String,
    pub created_at: String,
    /// Free-text style applied to every asset's image prompt (e.g. "low-poly,
    /// flat colors"). Empty by default. Persisted in project.json. Kept as a
    /// legacy fallback / mirror of `dna.art_style` for old builds.
    pub style: String,
    /// Rich project identity (absent on legacy projects).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dna: Option<ProjectDna>,
    pub assets: Vec<Asset>,
}

impl Project {
    pub fn from_disk(v: &Value) -> Self {
        Project {
            name: str_field(v, "name"),
            created_at: str_field(v, "created_at"),
            style: str_field(v, "style"),
            dna: v
                .get("dna")
                .filter(|d| d.is_object())
                .map(ProjectDna::from_disk),
            assets: v
                .get("assets")
                .and_then(|a| a.as_array())
                .map(|arr| arr.iter().map(Asset::from_disk).collect())
                .unwrap_or_default(),
        }
    }
}

// --- ProjectState -------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectState {
    pub version: i64,
    pub estimated_spend_usd: f64,
    /// asset_id -> { stageKey -> StageState }
    pub assets: std::collections::BTreeMap<String, std::collections::BTreeMap<String, StageState>>,
}

impl ProjectState {
    pub fn from_disk(v: &Value) -> Self {
        let mut assets = std::collections::BTreeMap::new();
        if let Some(obj) = v.get("assets").and_then(|a| a.as_object()) {
            for (asset_id, stages_v) in obj {
                let mut stages = std::collections::BTreeMap::new();
                if let Some(sobj) = stages_v.as_object() {
                    for (stage, st) in sobj {
                        stages.insert(stage.clone(), StageState::from_disk(st));
                    }
                }
                assets.insert(asset_id.clone(), stages);
            }
        }
        ProjectState {
            version: v.get("version").and_then(|x| x.as_i64()).unwrap_or(1),
            estimated_spend_usd: v
                .get("estimated_spend_usd")
                .and_then(|x| x.as_f64())
                .unwrap_or(0.0),
            assets,
        }
    }
}

// --- JobSnapshot --------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobCurrent {
    pub id: u64,
    pub project: String,
    pub asset_id: String,
    pub stages: Vec<String>,
    pub state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSnapshot {
    pub current: Option<JobCurrent>,
    pub queue_size: usize,
}

// --- ProjectBundle ------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectBundle {
    pub project: Project,
    pub state: ProjectState,
    pub jobs: JobSnapshot,
}

// --- ServerStatus -------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub backend: Option<String>,
    pub status: String,
    pub base_url: Option<String>,
    pub error: Option<String>,
    pub log_tail: String,
    pub managed: bool,
}

// --- InstallProgress ----------------------------------------------------

/// Progress snapshot of the guided Hunyuan backend installer. Pushed to the UI
/// via the `install-progress` event and returned by the `install_status` command.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgress {
    /// Backend being installed (e.g. "mv2"), or None when idle.
    pub backend: Option<String>,
    /// True while a pipeline is running.
    pub running: bool,
    /// Current phase key (preflight, python, code, venv, torch, deps,
    /// extensions, weights, config, start, done).
    pub phase: String,
    /// Overall progress 0..100.
    pub pct: u8,
    /// Human-readable status line for the current phase.
    pub message: String,
    /// Tail of the install log (last lines).
    pub log_tail: String,
    /// True once the install finished successfully.
    pub done: bool,
    /// User-facing error message when the install failed or was cancelled.
    pub error: Option<String>,
}

// --- Gen3d --------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Gen3d {
    pub target_face_num: i64,
    pub octree_resolution: i64,
    pub num_chunks: i64,
    pub guidance_scale: f64,
    pub texture: bool,
    pub steps_v21: i64,
    pub steps_mv2: i64,
    pub face_count_v21: i64,
}

impl Gen3d {
    /// Build from the snake_case `gen3d` config sub-object.
    pub fn from_config(v: &Value) -> Self {
        Gen3d {
            target_face_num: int_field(v, "target_face_num", 20000),
            octree_resolution: int_field(v, "octree_resolution", 256),
            num_chunks: int_field(v, "num_chunks", 200000),
            guidance_scale: v
                .get("guidance_scale")
                .and_then(|x| x.as_f64())
                .unwrap_or(7.5),
            texture: v.get("texture").and_then(|x| x.as_bool()).unwrap_or(true),
            steps_v21: int_field(v, "steps_v21", 30),
            steps_mv2: int_field(v, "steps_mv2", 50),
            face_count_v21: int_field(v, "face_count_v21", 40000),
        }
    }
}

// --- Hunyuan public sub-config -----------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HunyuanEntryPublic {
    pub dir: String,
    pub python: String,
    pub port: i64,
    pub model_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HunyuanPublic {
    pub v21: HunyuanEntryPublic,
    pub mv2: HunyuanEntryPublic,
}

// --- ConfigPublic -------------------------------------------------------

/// Audio (ElevenLabs) defaults surfaced to the UI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioConfigPublic {
    pub tts_model: String,
    pub ttv_model: String,
    pub sfx_model: String,
    pub music_model: String,
    pub output_format: String,
}

impl AudioConfigPublic {
    pub fn from_config(cfg: &Value) -> Self {
        let a = cfg.get("audio").cloned().unwrap_or(Value::Null);
        AudioConfigPublic {
            tts_model: a
                .get("tts_model")
                .and_then(|x| x.as_str())
                .unwrap_or("eleven_multilingual_v2")
                .to_string(),
            ttv_model: a
                .get("ttv_model")
                .and_then(|x| x.as_str())
                .unwrap_or("eleven_multilingual_ttv_v2")
                .to_string(),
            sfx_model: a
                .get("sfx_model")
                .and_then(|x| x.as_str())
                .unwrap_or("eleven_text_to_sound_v2")
                .to_string(),
            music_model: a
                .get("music_model")
                .and_then(|x| x.as_str())
                .unwrap_or("music_v1")
                .to_string(),
            output_format: a
                .get("output_format")
                .and_then(|x| x.as_str())
                .unwrap_or("mp3_44100_128")
                .to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigPublic {
    pub openai_model: String,
    pub openai_quality: String,
    pub openai_timeout: i64,
    pub openai_text_model: String,
    pub estimated_cost_per_image: f64,
    pub estimated_cost_per_text: f64,
    pub budget_usd: f64,
    pub default_backend: String,
    pub workspace_dir: String,
    pub multiview_prompt_template: String,
    pub texture_prompt_template: String,
    pub openai_key_set: bool,
    pub openai_admin_key_set: bool,
    pub elevenlabs_key_set: bool,
    pub audio: AudioConfigPublic,
    pub gen3d: Gen3d,
    pub hunyuan: HunyuanPublic,
}

impl ConfigPublic {
    pub fn from_config(
        cfg: &Value,
        key_set: bool,
        admin_key_set: bool,
        elevenlabs_key_set: bool,
    ) -> Self {
        let gen3d_v = cfg.get("gen3d").cloned().unwrap_or(Value::Null);
        let hun = cfg.get("hunyuan").cloned().unwrap_or(Value::Null);
        ConfigPublic {
            openai_model: str_field(cfg, "openai_model"),
            openai_quality: str_field(cfg, "openai_quality"),
            openai_timeout: int_field(cfg, "openai_timeout", 300),
            openai_text_model: cfg
                .get("openai_text_model")
                .and_then(|x| x.as_str())
                .unwrap_or("gpt-4.1-mini")
                .to_string(),
            estimated_cost_per_image: cfg
                .get("estimated_cost_per_image")
                .and_then(|x| x.as_f64())
                .unwrap_or(0.063),
            estimated_cost_per_text: cfg
                .get("estimated_cost_per_text")
                .and_then(|x| x.as_f64())
                .unwrap_or(0.005),
            budget_usd: cfg.get("budget_usd").and_then(|x| x.as_f64()).unwrap_or(5.0),
            default_backend: cfg
                .get("default_backend")
                .and_then(|x| x.as_str())
                .unwrap_or("v21")
                .to_string(),
            workspace_dir: str_field(cfg, "workspace_dir"),
            multiview_prompt_template: str_field(cfg, "multiview_prompt_template"),
            texture_prompt_template: str_field(cfg, "texture_prompt_template"),
            openai_key_set: key_set,
            openai_admin_key_set: admin_key_set,
            elevenlabs_key_set,
            audio: AudioConfigPublic::from_config(cfg),
            gen3d: Gen3d::from_config(&gen3d_v),
            hunyuan: HunyuanPublic {
                v21: hunyuan_entry(&hun, "v21"),
                mv2: hunyuan_entry(&hun, "mv2"),
            },
        }
    }
}

fn hunyuan_entry(hun: &Value, key: &str) -> HunyuanEntryPublic {
    let e = hun.get(key).cloned().unwrap_or(Value::Null);
    HunyuanEntryPublic {
        dir: str_field(&e, "dir"),
        python: str_field(&e, "python"),
        port: int_field(&e, "port", 0),
        model_path: str_field(&e, "model_path"),
    }
}

// --- ConfigPatch (update_config input) ----------------------------------

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Gen3dPatch {
    pub target_face_num: Option<i64>,
    pub octree_resolution: Option<i64>,
    pub num_chunks: Option<i64>,
    pub guidance_scale: Option<f64>,
    pub texture: Option<bool>,
    pub steps_v21: Option<i64>,
    pub steps_mv2: Option<i64>,
    pub face_count_v21: Option<i64>,
}

impl Gen3dPatch {
    /// The set fields as a snake_case JSON object (the on-disk gen3d shape).
    /// Used both for the config override and the per-asset override.
    pub fn to_snake_object(&self) -> serde_json::Map<String, Value> {
        let mut go = serde_json::Map::new();
        if let Some(x) = self.target_face_num {
            go.insert("target_face_num".into(), Value::from(x));
        }
        if let Some(x) = self.octree_resolution {
            go.insert("octree_resolution".into(), Value::from(x));
        }
        if let Some(x) = self.num_chunks {
            go.insert("num_chunks".into(), Value::from(x));
        }
        if let Some(x) = self.guidance_scale {
            go.insert("guidance_scale".into(), Value::from(x));
        }
        if let Some(x) = self.texture {
            go.insert("texture".into(), Value::from(x));
        }
        if let Some(x) = self.steps_v21 {
            go.insert("steps_v21".into(), Value::from(x));
        }
        if let Some(x) = self.steps_mv2 {
            go.insert("steps_mv2".into(), Value::from(x));
        }
        if let Some(x) = self.face_count_v21 {
            go.insert("face_count_v21".into(), Value::from(x));
        }
        go
    }
}

/// Patch for one Hunyuan backend entry. Every field optional so the UI can save
/// just the paths the user picks. Keys map to the snake_case on-disk config.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HunyuanEntryPatch {
    pub dir: Option<String>,
    pub python: Option<String>,
    pub port: Option<i64>,
    pub model_path: Option<String>,
    pub subfolder: Option<String>,
    pub texgen_model_path: Option<String>,
    pub extra_args: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct HunyuanPatch {
    pub v21: Option<HunyuanEntryPatch>,
    pub mv2: Option<HunyuanEntryPatch>,
}

/// Patch for the audio (ElevenLabs) model defaults. Every field optional.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AudioPatch {
    pub tts_model: Option<String>,
    pub ttv_model: Option<String>,
    pub sfx_model: Option<String>,
    pub music_model: Option<String>,
    pub output_format: Option<String>,
}

impl AudioPatch {
    fn to_snake_object(&self) -> serde_json::Map<String, Value> {
        let mut o = serde_json::Map::new();
        if let Some(v) = &self.tts_model {
            o.insert("tts_model".into(), Value::String(v.clone()));
        }
        if let Some(v) = &self.ttv_model {
            o.insert("ttv_model".into(), Value::String(v.clone()));
        }
        if let Some(v) = &self.sfx_model {
            o.insert("sfx_model".into(), Value::String(v.clone()));
        }
        if let Some(v) = &self.music_model {
            o.insert("music_model".into(), Value::String(v.clone()));
        }
        if let Some(v) = &self.output_format {
            o.insert("output_format".into(), Value::String(v.clone()));
        }
        o
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConfigPatch {
    pub openai_api_key: Option<String>,
    pub openai_admin_api_key: Option<String>,
    pub openai_model: Option<String>,
    pub openai_quality: Option<String>,
    pub openai_timeout: Option<i64>,
    pub openai_text_model: Option<String>,
    pub estimated_cost_per_image: Option<f64>,
    pub estimated_cost_per_text: Option<f64>,
    pub budget_usd: Option<f64>,
    pub default_backend: Option<String>,
    pub workspace_dir: Option<String>,
    pub multiview_prompt_template: Option<String>,
    pub texture_prompt_template: Option<String>,
    pub elevenlabs_api_key: Option<String>,
    pub audio: Option<AudioPatch>,
    pub gen3d: Option<Gen3dPatch>,
    pub hunyuan: Option<HunyuanPatch>,
}

impl ConfigPatch {
    /// Translate the camelCase patch into a snake_case override JSON object
    /// suitable for deep-merging into the on-disk config.
    pub fn to_disk_override(&self) -> Value {
        let mut obj = serde_json::Map::new();
        if let Some(v) = &self.openai_api_key {
            obj.insert("openai_api_key".into(), Value::String(v.clone()));
        }
        if let Some(v) = &self.openai_admin_api_key {
            obj.insert("openai_admin_api_key".into(), Value::String(v.clone()));
        }
        if let Some(v) = &self.openai_model {
            obj.insert("openai_model".into(), Value::String(v.clone()));
        }
        if let Some(v) = &self.openai_quality {
            obj.insert("openai_quality".into(), Value::String(v.clone()));
        }
        if let Some(v) = self.openai_timeout {
            obj.insert("openai_timeout".into(), Value::from(v));
        }
        if let Some(v) = &self.openai_text_model {
            obj.insert("openai_text_model".into(), Value::String(v.clone()));
        }
        if let Some(v) = self.estimated_cost_per_image {
            obj.insert("estimated_cost_per_image".into(), Value::from(v));
        }
        if let Some(v) = self.estimated_cost_per_text {
            obj.insert("estimated_cost_per_text".into(), Value::from(v));
        }
        if let Some(v) = self.budget_usd {
            obj.insert("budget_usd".into(), Value::from(v));
        }
        if let Some(v) = &self.default_backend {
            obj.insert("default_backend".into(), Value::String(v.clone()));
        }
        if let Some(v) = &self.workspace_dir {
            obj.insert("workspace_dir".into(), Value::String(v.clone()));
        }
        if let Some(v) = &self.multiview_prompt_template {
            obj.insert("multiview_prompt_template".into(), Value::String(v.clone()));
        }
        if let Some(v) = &self.texture_prompt_template {
            obj.insert("texture_prompt_template".into(), Value::String(v.clone()));
        }
        if let Some(v) = &self.elevenlabs_api_key {
            obj.insert("elevenlabs_api_key".into(), Value::String(v.clone()));
        }
        if let Some(a) = &self.audio {
            obj.insert("audio".into(), Value::Object(a.to_snake_object()));
        }
        if let Some(g) = &self.gen3d {
            obj.insert("gen3d".into(), Value::Object(g.to_snake_object()));
        }
        if let Some(h) = &self.hunyuan {
            let mut ho = serde_json::Map::new();
            if let Some(e) = &h.v21 {
                ho.insert("v21".into(), hunyuan_entry_override(e));
            }
            if let Some(e) = &h.mv2 {
                ho.insert("mv2".into(), hunyuan_entry_override(e));
            }
            obj.insert("hunyuan".into(), Value::Object(ho));
        }
        Value::Object(obj)
    }
}

/// Snake_case override object for one Hunyuan entry (only the set fields).
fn hunyuan_entry_override(e: &HunyuanEntryPatch) -> Value {
    let mut o = serde_json::Map::new();
    if let Some(v) = &e.dir {
        o.insert("dir".into(), Value::String(v.clone()));
    }
    if let Some(v) = &e.python {
        o.insert("python".into(), Value::String(v.clone()));
    }
    if let Some(v) = e.port {
        o.insert("port".into(), Value::from(v));
    }
    if let Some(v) = &e.model_path {
        o.insert("model_path".into(), Value::String(v.clone()));
    }
    if let Some(v) = &e.subfolder {
        o.insert("subfolder".into(), Value::String(v.clone()));
    }
    if let Some(v) = &e.texgen_model_path {
        o.insert("texgen_model_path".into(), Value::String(v.clone()));
    }
    if let Some(v) = &e.extra_args {
        o.insert(
            "extra_args".into(),
            Value::Array(v.iter().map(|s| Value::String(s.clone())).collect()),
        );
    }
    Value::Object(o)
}

// --- Audio domain (ElevenLabs) ------------------------------------------

/// A reusable designed voice (global catalog, `voices.json`). Stored snake_case
/// on disk; exposed camelCase over the bridge.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Voice {
    pub voice_id: String,
    pub name: String,
    pub description: String,
    /// ElevenLabs voice_settings (stability, similarity_boost, …) as a JSON object.
    pub voice_settings: Value,
    pub created_at: String,
}

impl Voice {
    pub fn from_disk(v: &Value) -> Self {
        Voice {
            voice_id: str_field(v, "voice_id"),
            name: str_field(v, "name"),
            description: str_field(v, "description"),
            voice_settings: v
                .get("voice_settings")
                .cloned()
                .unwrap_or_else(|| Value::Object(Default::default())),
            created_at: str_field(v, "created_at"),
        }
    }

    /// Snake_case JSON for `voices.json`.
    pub fn to_disk(&self) -> Value {
        serde_json::json!({
            "voice_id": self.voice_id,
            "name": self.name,
            "description": self.description,
            "voice_settings": self.voice_settings,
            "created_at": self.created_at,
        })
    }
}

/// One Voice Design preview returned to the UI (played via a base64 data URL).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoicePreview {
    pub generated_voice_id: String,
    pub audio_base_64: String,
}

/// A per-project audio item (one entry of `audio.json`). Stored snake_case on
/// disk; exposed camelCase over the bridge.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioItem {
    pub id: String,
    /// "voice" | "sfx" | "music".
    pub kind: String,
    pub name: String,
    /// TTS text / SFX prompt / music prompt.
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub voice_id: Option<String>,
    /// Id of the 3D/texture asset this item is linked to (absent when standalone).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<String>,
    /// Kind-specific params (durationSeconds, promptInfluence, loop, musicLengthMs…).
    pub params: Value,
    pub status: String,
    pub error: Option<String>,
    /// Project-relative path of the generated mp3 (e.g. "audio/sfx/<id>.mp3").
    pub file: Option<String>,
    pub created_at: String,
    pub updated_at: Option<String>,
}

impl AudioItem {
    pub fn from_disk(v: &Value) -> Self {
        AudioItem {
            id: str_field(v, "id"),
            kind: str_field(v, "kind"),
            name: str_field(v, "name"),
            text: str_field(v, "text"),
            voice_id: v
                .get("voice_id")
                .and_then(|x| x.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string()),
            asset_id: v
                .get("asset_id")
                .and_then(|x| x.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string()),
            params: v
                .get("params")
                .cloned()
                .unwrap_or_else(|| Value::Object(Default::default())),
            status: v
                .get("status")
                .and_then(|x| x.as_str())
                .unwrap_or("pending")
                .to_string(),
            error: v.get("error").and_then(|x| x.as_str()).map(|s| s.to_string()),
            file: v
                .get("file")
                .and_then(|x| x.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string()),
            created_at: str_field(v, "created_at"),
            updated_at: v
                .get("updated_at")
                .and_then(|x| x.as_str())
                .map(|s| s.to_string()),
        }
    }
}

/// Currently-running audio job (single serial executor).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioJobCurrent {
    pub project: String,
    pub item_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioJobSnapshot {
    pub current: Option<AudioJobCurrent>,
    pub queue_size: usize,
}

/// What `list_audio` returns: a project's items + the audio queue snapshot.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioBundle {
    pub items: Vec<AudioItem>,
    pub jobs: AudioJobSnapshot,
}

// --- small helpers ------------------------------------------------------

fn str_field(v: &Value, key: &str) -> String {
    v.get(key)
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string()
}

/// Map the 8 known snake_case `gen3d` keys to their camelCase bridge names so the
/// per-asset override (stored snake_case on disk, like the global config) reaches
/// the UI in the same shape it sends back.
fn gen3d_disk_to_camel(v: &Value) -> Value {
    const KEYS: [(&str, &str); 8] = [
        ("target_face_num", "targetFaceNum"),
        ("octree_resolution", "octreeResolution"),
        ("num_chunks", "numChunks"),
        ("guidance_scale", "guidanceScale"),
        ("texture", "texture"),
        ("steps_v21", "stepsV21"),
        ("steps_mv2", "stepsMv2"),
        ("face_count_v21", "faceCountV21"),
    ];
    let mut out = serde_json::Map::new();
    for (snake, camel) in KEYS {
        if let Some(x) = v.get(snake) {
            out.insert(camel.to_string(), x.clone());
        }
    }
    Value::Object(out)
}

fn int_field(v: &Value, key: &str, default: i64) -> i64 {
    v.get(key).and_then(|x| x.as_i64()).unwrap_or(default)
}
