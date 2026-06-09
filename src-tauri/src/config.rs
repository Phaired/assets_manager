//! Configuration: defaults + config.json + $OPENAI_API_KEY.
//!
//! Port of `app/config.py`. The config lives in `config.json` at the project root
//! and is deep-merged over the defaults below. The OpenAI key may come from config
//! OR from the environment. config.json keys stay snake_case on disk.

use std::path::{Path, PathBuf};

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::{json, Value};

use crate::error::{AppError, AppResult};

/// Project root = parent of the cargo `src-tauri/` directory, matching the
/// original Python `ROOT = parent of app/`. We resolve it from the compile-time
/// manifest dir so the workspace/config/logs land in the same place as before.
pub static ROOT: Lazy<PathBuf> = Lazy::new(|| {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or(manifest)
});

pub fn config_path() -> PathBuf {
    ROOT.join("config.json")
}

/// Identical to the original Python `DEFAULTS`.
pub fn defaults() -> Value {
    json!({
        "workspace_dir": ROOT.join("workspace").to_string_lossy(),
        "openai_api_key": "",
        "openai_model": "gpt-image-2",
        "openai_quality": "medium",
        "openai_timeout": 300,
        "openai_max_retries": 2,
        "budget_usd": 5.0,
        "estimated_cost_per_image": 0.063,
        "default_backend": "v21",
        "gen3d": {
            "target_face_num": 20000,
            "octree_resolution": 256,
            "num_chunks": 200000,
            "guidance_scale": 7.5,
            "texture": true,
            "steps_v21": 30,
            "steps_mv2": 50,
            "face_count_v21": 40000
        },
        "hunyuan": {
            "v21": {
                "dir": "C:\\dev\\3dmodel\\Hunyuan3D-2.1",
                "python": "C:\\dev\\3dmodel\\Hunyuan3D-2.1\\.venv\\Scripts\\python.exe",
                "script": "api_server.py",
                "host": "127.0.0.1",
                "port": 8081,
                "model_path": "tencent/Hunyuan3D-2.1",
                "subfolder": "hunyuan3d-dit-v2-1",
                "extra_args": ["--low_vram_mode", "--enable_flashvdm"]
            },
            "mv2": {
                "dir": "C:\\dev\\3dmodel\\Hunyuan3D-2",
                "python": "C:\\dev\\3dmodel\\Hunyuan3D-2\\.venv\\Scripts\\python.exe",
                "script": "gradio_app.py",
                "host": "127.0.0.1",
                "port": 8080,
                "model_path": "tencent/Hunyuan3D-2mv",
                "subfolder": "hunyuan3d-dit-v2-mv",
                "texgen_model_path": "tencent/Hunyuan3D-2",
                "extra_args": ["--low_vram_mode", "--enable_flashvdm"]
            }
        }
    })
}

/// Deep-merge `override` over `base` (override wins; dicts merge recursively).
pub fn deep_merge(base: &Value, over: &Value) -> Value {
    match (base, over) {
        (Value::Object(b), Value::Object(o)) => {
            let mut out = b.clone();
            for (k, v) in o {
                match out.get(k) {
                    Some(existing) if existing.is_object() && v.is_object() => {
                        out.insert(k.clone(), deep_merge(existing, v));
                    }
                    _ => {
                        out.insert(k.clone(), v.clone());
                    }
                }
            }
            Value::Object(out)
        }
        // Non-object override replaces base entirely.
        (_, o) => o.clone(),
    }
}

fn read_disk() -> Value {
    let path = config_path();
    if path.is_file() {
        match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_else(|_| json!({})),
            Err(_) => json!({}),
        }
    } else {
        json!({})
    }
}

/// `load_config` = deep-merge config.json over defaults.
pub fn load_config() -> Value {
    deep_merge(&defaults(), &read_disk())
}

/// Atomically save the full merge (defaults <- config). Returns the merged value.
pub fn save_config(config: &Value) -> AppResult<Value> {
    let merged = deep_merge(&defaults(), config);
    let path = config_path();
    let tmp = path.with_extension("tmp");
    let text = serde_json::to_string_pretty(&merged)?;
    std::fs::write(&tmp, text)?;
    // tmp + rename (atomic on the same filesystem). On Windows `rename` fails if
    // the destination exists, so remove it first.
    if path.exists() {
        let _ = std::fs::remove_file(&path);
    }
    std::fs::rename(&tmp, &path)?;
    Ok(merged)
}

/// OpenAI key = config key (trimmed) or `$OPENAI_API_KEY` (trimmed).
pub fn openai_key(config: &Value) -> String {
    let from_cfg = config
        .get("openai_api_key")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if !from_cfg.is_empty() {
        return from_cfg;
    }
    std::env::var("OPENAI_API_KEY")
        .unwrap_or_default()
        .trim()
        .to_string()
}

/// Workspace directory, ensured to exist.
pub fn workspace_dir(config: &Value) -> AppResult<PathBuf> {
    let raw = config
        .get("workspace_dir")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::msg("workspace_dir manquant dans la config"))?;
    let path = PathBuf::from(raw);
    std::fs::create_dir_all(&path)?;
    Ok(path)
}

/// Logs directory under the project root, ensured to exist.
pub fn logs_dir() -> AppResult<PathBuf> {
    let path = ROOT.join("logs");
    std::fs::create_dir_all(&path)?;
    Ok(path)
}

/// Shared config holder. The config is cheap to re-read from disk, but we keep a
/// process-wide mutex so concurrent saves do not interleave. `Config` itself is a
/// thin handle; reads always reflect the latest on-disk merge.
pub struct Config {
    save_lock: Mutex<()>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            save_lock: Mutex::new(()),
        }
    }
}

impl Config {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn load(&self) -> Value {
        load_config()
    }

    pub fn save(&self, config: &Value) -> AppResult<Value> {
        let _guard = self.save_lock.lock();
        save_config(config)
    }

    #[allow(dead_code)]
    pub fn openai_key(&self) -> String {
        openai_key(&self.load())
    }

    pub fn workspace_dir(&self) -> AppResult<PathBuf> {
        workspace_dir(&self.load())
    }
}

/// Helper: does `path` live under `root` (after normalisation)? Used by the
/// asset-protocol scope checks in commands.
pub fn under(root: &Path, path: &Path) -> bool {
    match (root.canonicalize(), path.canonicalize()) {
        (Ok(r), Ok(p)) => p.starts_with(r),
        _ => false,
    }
}
