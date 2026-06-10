//! Configuration: defaults + config.json + $OPENAI_API_KEY.
//!
//! Port of `app/config.py`. The config lives in `config.json` at the project root
//! and is deep-merged over the defaults below. The OpenAI key may come from config
//! OR from the environment. config.json keys stay snake_case on disk.

use std::path::{Path, PathBuf};

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::{json, Value};
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

use crate::error::{AppError, AppResult};

/// tauri-plugin-store file + key holding the whole settings object (merged over
/// defaults). All settings — including the OpenAI API key — now live here.
const STORE_FILE: &str = "settings.json";
const CONFIG_KEY: &str = "config";

/// AppHandle, installed in the Tauri `setup` hook (see `set_app`). Required to
/// reach the plugin store. Before it is set (unit tests / pre-setup) the config
/// falls back to defaults only — nothing reads persisted overrides that early.
static APP: Lazy<once_cell::sync::OnceCell<AppHandle>> =
    Lazy::new(once_cell::sync::OnceCell::new);

/// Install the AppHandle so config persistence can reach the plugin store.
/// Idempotent: only the first call wins.
pub fn set_app(app: AppHandle) {
    let _ = APP.set(app);
}

/// Runtime paths, resolved ONCE at startup (see `init_paths`, called from the
/// Tauri `setup` hook). We split two roots that used to be the single compile-time
/// `ROOT`:
///   - `data`     : writable — config.json, workspace/, logs/. In a packaged build
///                  this is the per-user app-data dir (e.g. %APPDATA%\<id>); in dev
///                  it is the project root so the existing files keep working.
///   - `resource` : read-only, bundled — the frozen Python worker. In a packaged
///                  build this is Tauri's resource dir; in dev it is the project root.
///
/// Before `init_paths` runs (unit tests, any pre-setup call) we fall back to the
/// project root derived from the compile-time manifest dir — identical to the old
/// behaviour, so dev/test paths are unchanged.
struct Paths {
    data: PathBuf,
    resource: PathBuf,
}

static PATHS: Lazy<once_cell::sync::OnceCell<Paths>> =
    Lazy::new(once_cell::sync::OnceCell::new);

/// Project root = parent of the cargo `src-tauri/` dir (compile-time manifest).
/// Used as the dev/test fallback and for the dev `.venv` worker.
pub fn repo_root() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or(manifest)
}

/// Install the runtime roots. Idempotent: only the first call wins.
pub fn init_paths(data: PathBuf, resource: PathBuf) {
    let _ = PATHS.set(Paths { data, resource });
}

/// Writable root (config.json, workspace, logs). Falls back to the repo root.
pub fn data_root() -> PathBuf {
    PATHS.get().map(|p| p.data.clone()).unwrap_or_else(repo_root)
}

/// Read-only bundled-resource root (frozen worker). Falls back to the repo root.
pub fn resource_root() -> PathBuf {
    PATHS
        .get()
        .map(|p| p.resource.clone())
        .unwrap_or_else(repo_root)
}

pub fn config_path() -> PathBuf {
    data_root().join("config.json")
}

/// In dev we keep the original Hunyuan paths (this machine). In a packaged build
/// they default to empty so the app invites the user to configure them in Settings
/// (the supervisor surfaces a clear error) instead of pointing at a dev-only path.
fn hunyuan_default(dir: &str, python: &str) -> (String, String) {
    if cfg!(debug_assertions) {
        (dir.to_string(), python.to_string())
    } else {
        (String::new(), String::new())
    }
}

/// Identical to the original Python `DEFAULTS` (workspace/Hunyuan paths resolved
/// at runtime — see `data_root` and `hunyuan_default`).
pub fn defaults() -> Value {
    let (v21_dir, v21_py) =
        hunyuan_default("C:\\dev\\3dmodel\\Hunyuan3D-2.1", "C:\\dev\\3dmodel\\Hunyuan3D-2.1\\.venv\\Scripts\\python.exe");
    let (mv2_dir, mv2_py) =
        hunyuan_default("C:\\dev\\3dmodel\\Hunyuan3D-2", "C:\\dev\\3dmodel\\Hunyuan3D-2\\.venv\\Scripts\\python.exe");
    json!({
        "workspace_dir": data_root().join("workspace").to_string_lossy(),
        "openai_api_key": "",
        "openai_model": "gpt-image-2",
        "openai_quality": "medium",
        "openai_timeout": 300,
        "openai_max_retries": 2,
        "budget_usd": 5.0,
        "estimated_cost_per_image": 0.063,
        "default_backend": "v21",
        "elevenlabs_api_key": "",
        "audio": {
            "tts_model": "eleven_multilingual_v2",
            "ttv_model": "eleven_multilingual_ttv_v2",
            "sfx_model": "eleven_text_to_sound_v2",
            "music_model": "music_v1",
            "output_format": "mp3_44100_128"
        },
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
                "dir": v21_dir,
                "python": v21_py,
                "script": "api_server.py",
                "host": "127.0.0.1",
                "port": 8081,
                "model_path": "tencent/Hunyuan3D-2.1",
                "subfolder": "hunyuan3d-dit-v2-1",
                "extra_args": ["--low_vram_mode", "--enable_flashvdm"]
            },
            "mv2": {
                "dir": mv2_dir,
                "python": mv2_py,
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

/// Read the legacy `config.json` (pre-store-plugin) — used once for migration.
fn read_legacy_file() -> Value {
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

/// Read the persisted settings object from the plugin store. Returns `{}` when
/// the store is unavailable (pre-setup) or empty.
fn read_store() -> Value {
    if let Some(app) = APP.get() {
        if let Ok(store) = app.store(STORE_FILE) {
            if let Some(v) = store.get(CONFIG_KEY) {
                return v;
            }
        }
    }
    json!({})
}

/// `load_config` = deep-merge the stored settings over defaults.
pub fn load_config() -> Value {
    deep_merge(&defaults(), &read_store())
}

/// Save the full merge (defaults <- config) into the plugin store. Returns the
/// merged value. Persistence is a no-op before the AppHandle is installed.
pub fn save_config(config: &Value) -> AppResult<Value> {
    let merged = deep_merge(&defaults(), config);
    if let Some(app) = APP.get() {
        let store = app
            .store(STORE_FILE)
            .map_err(|e| AppError::msg(format!("store indisponible: {e}")))?;
        store.set(CONFIG_KEY, merged.clone());
        store
            .save()
            .map_err(|e| AppError::msg(format!("écriture du store: {e}")))?;
    }
    Ok(merged)
}

/// One-shot migration: if the store has no settings yet, seed it from the legacy
/// `config.json` (preserving the API key + all settings) merged over defaults.
/// Safe to call on every startup — it only acts once.
pub fn migrate_legacy_if_needed() {
    let Some(app) = APP.get() else { return };
    let Ok(store) = app.store(STORE_FILE) else {
        return;
    };
    if store.has(CONFIG_KEY) {
        return;
    }
    let seed = deep_merge(&defaults(), &read_legacy_file());
    store.set(CONFIG_KEY, seed);
    let _ = store.save();
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

/// ElevenLabs key = config key (trimmed) or `$ELEVENLABS_API_KEY` (trimmed).
pub fn elevenlabs_key(config: &Value) -> String {
    let from_cfg = config
        .get("elevenlabs_api_key")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if !from_cfg.is_empty() {
        return from_cfg;
    }
    std::env::var("ELEVENLABS_API_KEY")
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

/// Logs directory under the writable data root, ensured to exist.
pub fn logs_dir() -> AppResult<PathBuf> {
    let path = data_root().join("logs");
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
