//! Bridge DTOs (camelCase over the Tauri boundary) plus mapping to/from the
//! snake_case on-disk JSON. On-disk shapes (project.json / state.json / config.json)
//! are kept verbatim for backward compatibility; only the bridge payloads are
//! camelCase.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const STAGES: [&str; 3] = ["multiview", "model3d", "export"];
pub const VIEW_FILES: [&str; 4] = ["front.png", "back.png", "left.png", "right.png"];

// --- Asset --------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub id: String,
    pub name: String,
    pub description: String,
    pub tags: Vec<String>,
    pub backend: String,
    pub source: String,
    pub created_at: String,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub name: String,
    pub created_at: String,
    pub assets: Vec<Asset>,
}

impl Project {
    pub fn from_disk(v: &Value) -> Self {
        Project {
            name: str_field(v, "name"),
            created_at: str_field(v, "created_at"),
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigPublic {
    pub openai_model: String,
    pub openai_quality: String,
    pub openai_timeout: i64,
    pub estimated_cost_per_image: f64,
    pub budget_usd: f64,
    pub default_backend: String,
    pub workspace_dir: String,
    pub openai_key_set: bool,
    pub gen3d: Gen3d,
    pub hunyuan: HunyuanPublic,
}

impl ConfigPublic {
    pub fn from_config(cfg: &Value, key_set: bool) -> Self {
        let gen3d_v = cfg.get("gen3d").cloned().unwrap_or(Value::Null);
        let hun = cfg.get("hunyuan").cloned().unwrap_or(Value::Null);
        ConfigPublic {
            openai_model: str_field(cfg, "openai_model"),
            openai_quality: str_field(cfg, "openai_quality"),
            openai_timeout: int_field(cfg, "openai_timeout", 300),
            estimated_cost_per_image: cfg
                .get("estimated_cost_per_image")
                .and_then(|x| x.as_f64())
                .unwrap_or(0.063),
            budget_usd: cfg.get("budget_usd").and_then(|x| x.as_f64()).unwrap_or(5.0),
            default_backend: cfg
                .get("default_backend")
                .and_then(|x| x.as_str())
                .unwrap_or("v21")
                .to_string(),
            workspace_dir: str_field(cfg, "workspace_dir"),
            openai_key_set: key_set,
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

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConfigPatch {
    pub openai_api_key: Option<String>,
    pub openai_model: Option<String>,
    pub openai_quality: Option<String>,
    pub openai_timeout: Option<i64>,
    pub estimated_cost_per_image: Option<f64>,
    pub budget_usd: Option<f64>,
    pub default_backend: Option<String>,
    pub workspace_dir: Option<String>,
    pub gen3d: Option<Gen3dPatch>,
}

impl ConfigPatch {
    /// Translate the camelCase patch into a snake_case override JSON object
    /// suitable for deep-merging into the on-disk config.
    pub fn to_disk_override(&self) -> Value {
        let mut obj = serde_json::Map::new();
        if let Some(v) = &self.openai_api_key {
            obj.insert("openai_api_key".into(), Value::String(v.clone()));
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
        if let Some(v) = self.estimated_cost_per_image {
            obj.insert("estimated_cost_per_image".into(), Value::from(v));
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
        if let Some(g) = &self.gen3d {
            let mut go = serde_json::Map::new();
            if let Some(x) = g.target_face_num {
                go.insert("target_face_num".into(), Value::from(x));
            }
            if let Some(x) = g.octree_resolution {
                go.insert("octree_resolution".into(), Value::from(x));
            }
            if let Some(x) = g.num_chunks {
                go.insert("num_chunks".into(), Value::from(x));
            }
            if let Some(x) = g.guidance_scale {
                go.insert("guidance_scale".into(), Value::from(x));
            }
            if let Some(x) = g.texture {
                go.insert("texture".into(), Value::from(x));
            }
            if let Some(x) = g.steps_v21 {
                go.insert("steps_v21".into(), Value::from(x));
            }
            if let Some(x) = g.steps_mv2 {
                go.insert("steps_mv2".into(), Value::from(x));
            }
            if let Some(x) = g.face_count_v21 {
                go.insert("face_count_v21".into(), Value::from(x));
            }
            obj.insert("gen3d".into(), Value::Object(go));
        }
        Value::Object(obj)
    }
}

// --- small helpers ------------------------------------------------------

fn str_field(v: &Value, key: &str) -> String {
    v.get(key)
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string()
}

fn int_field(v: &Value, key: &str, default: i64) -> i64 {
    v.get(key).and_then(|x| x.as_i64()).unwrap_or(default)
}
