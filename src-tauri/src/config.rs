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

/// Default multiview prompt template. `{subject}` is replaced by the asset's
/// description (or its name as fallback), `{style}` by the project's free-text
/// style. Editable in the settings (`multiview_prompt_template`); a blank
/// stored value falls back to this default.
/// Keep in sync with `MULTIVIEW_TEMPLATES.character` in src/lib/constants.ts.
pub const DEFAULT_MULTIVIEW_TEMPLATE: &str = "Create one production-ready 2x2 orthographic character turnaround sheet for multi-view image-to-3D reconstruction.
CHARACTER: {subject}.
{style}
PANEL ORDER: top-left exact front view; top-right exact back view; bottom-left exact left profile; bottom-right exact right profile.
CONSISTENCY: depict the exact same single character in all four panels. Lock identical body proportions, colors, matte materials, accessories and neutral relaxed A-pose. Front and back must match. Left and right profiles must be true mirrored orthographic profiles, not three-quarter views.
FRAMING: show the complete character from highest point to soles in every panel. The character must occupy only about 60 percent of each panel height, centered horizontally and vertically, with at least 15 percent empty background above, below, left and right. Keep a clearly visible gap below the feet. Nothing may touch or cross a panel edge or the sheet midpoint.
STYLE: appealing original stylized game character, simple polished low-poly 3D render, broad readable volumes, a few large flat color regions, very simple matte textures, no tiny details. Keep arms, legs and accessories clearly separated from the torso.
BACKGROUND: perfectly uniform solid light gray in all panels. No floor, horizon, cast shadow, ambient shadow, reflection, gradient, scenery or props.
STRICTLY AVOID: cropping, labels, letters, text, panel borders, extra objects, extra characters, perspective view, three-quarter view, dynamic pose or inconsistent design.";

/// Render the multiview prompt from the configured template. `{subject}` gets
/// the asset description (or name), `{style}` the project style (possibly
/// empty). A blank template falls back to the built-in default.
pub fn render_multiview_prompt(cfg: &Value, name: &str, description: &str, style: &str) -> String {
    let template = cfg
        .get("multiview_prompt_template")
        .and_then(|x| x.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(DEFAULT_MULTIVIEW_TEMPLATE);
    render_subject_style(template, name, description, style)
}

/// Default seamless-texture prompt template (`kind == "texture"` assets).
/// Editable in the settings (`texture_prompt_template`); a blank stored value
/// falls back to this default.
/// Keep in sync with `TEXTURE_TEMPLATE` in src/lib/constants.ts.
pub const DEFAULT_TEXTURE_TEMPLATE: &str = "Create a perfectly seamless, tileable texture of {subject}.
{style}
TILING: the pattern must tile seamlessly on both axes — no visible seams, borders or repetition artifacts at the edges. Left edge continues the right edge exactly; top edge continues the bottom edge exactly.
LIGHTING: flat, even, diffuse lighting across the whole image. No vignetting, no lighting gradient, no directional shadow, no specular hotspot.
VIEW: strictly top-down orthogonal view of a flat surface. The pattern fills the entire frame edge to edge.
STYLE: clean stylized game texture, readable shapes, simple matte materials suitable for a low-poly game.
STRICTLY AVOID: text, labels, letters, watermark, frame, border, perspective, horizon, objects casting shadows, photographic noise.";

/// Render the texture prompt from the configured template (same placeholders
/// as the multiview template: `{subject}` and `{style}`).
pub fn render_texture_prompt(cfg: &Value, name: &str, description: &str, style: &str) -> String {
    let template = cfg
        .get("texture_prompt_template")
        .and_then(|x| x.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(DEFAULT_TEXTURE_TEMPLATE);
    render_subject_style(template, name, description, style)
}

fn render_subject_style(template: &str, name: &str, description: &str, style: &str) -> String {
    let subject = if !description.trim().is_empty() {
        description.trim()
    } else if !name.trim().is_empty() {
        name.trim()
    } else {
        "an original stylized game asset"
    };
    template
        .replace("{subject}", subject)
        .replace("{style}", style.trim())
}

/// Plain caption for native text-to-3D (HunyuanDiT t2i, mv2 backend). Unlike the
/// multiview template this is a bare "subject. style" sentence — no turnaround
/// sheet scaffolding (the t2i model wants a single clean prompt).
pub fn render_text3d_caption(name: &str, description: &str, style: &str) -> String {
    let subject = if !description.trim().is_empty() {
        description.trim()
    } else if !name.trim().is_empty() {
        name.trim()
    } else {
        "an original stylized game asset"
    };
    let style = style.trim();
    if style.is_empty() {
        subject.to_string()
    } else {
        format!("{subject}. {style}")
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
        "multiview_prompt_template": DEFAULT_MULTIVIEW_TEMPLATE,
        "texture_prompt_template": DEFAULT_TEXTURE_TEMPLATE,
        "openai_api_key": "",
        "openai_admin_api_key": "",
        "openai_model": "gpt-image-2",
        "openai_quality": "medium",
        "openai_timeout": 300,
        "openai_max_retries": 2,
        "openai_text_model": "gpt-4.1-mini",
        "estimated_cost_per_text": 0.005,
        "budget_usd": 5.0,
        "estimated_cost_per_image": 0.063,
        "default_backend": "v21",
        "elevenlabs_api_key": "",
        // USD per 1M tokens, by model (prefix-matched against the API model
        // name). Used to compute the REAL cost from the `usage` block of each
        // OpenAI response; unknown model → fall back to the flat estimates.
        "pricing": {
            "text": {
                "gpt-4.1-mini": {"input_per_m": 0.40, "output_per_m": 1.60},
                "gpt-4.1-nano": {"input_per_m": 0.10, "output_per_m": 0.40},
                "gpt-4.1": {"input_per_m": 2.00, "output_per_m": 8.00}
            },
            "image": {
                "gpt-image-2": {"text_input_per_m": 5.0, "image_input_per_m": 8.0, "output_per_m": 30.0},
                "gpt-image-1": {"text_input_per_m": 5.0, "image_input_per_m": 10.0, "output_per_m": 40.0}
            }
        },
        "audio": {
            "tts_model": "eleven_multilingual_v2",
            "ttv_model": "eleven_multilingual_ttv_v2",
            "sfx_model": "eleven_text_to_sound_v2",
            "music_model": "music_v1",
            "output_format": "mp3_44100_128"
        },
        // steps_mv2=20 / octree=192: quality-verified fast defaults (mv2 mesh
        // quality cliffs below ~15 steps; 20 is visually identical to 50 after
        // decimation while cutting shape diffusion 2.5x).
        "gen3d": {
            "target_face_num": 20000,
            "octree_resolution": 192,
            "num_chunks": 200000,
            "guidance_scale": 7.5,
            "texture": true,
            "steps_v21": 30,
            "steps_mv2": 20,
            "face_count_v21": 40000
        },
        "decimate": {
            "target_face_num": 20000,
            "mode": "auto",
            "quality_thr": 1.0,
            "boundary_weight": 3.0,
            "preserve_boundary": true,
            "preserve_normal": true,
            "optimal_placement": true,
            "planar_quadric": false,
            "bake_normal_map": true,
            "normal_map_resolution": 1024
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
                "extra_args": ["--low_vram_mode", "--enable_flashvdm"],
                // Native text-to-3D opt-in. Set true by the optional install_text3d
                // step (downloads HunyuanDiT); makes the supervisor launch the mv2
                // server with --enable_t23d.
                "text3d_enabled": false
            }
        }
    })
}

/// Pricing entry for `model` in `cfg.pricing.<section>`: exact key match, else
/// the LONGEST key the model name starts with (API responses return versioned
/// names like "gpt-image-2-2026-01-15").
fn pricing_entry<'a>(cfg: &'a Value, section: &str, model: &str) -> Option<&'a Value> {
    let table = cfg.get("pricing")?.get(section)?.as_object()?;
    if let Some(e) = table.get(model) {
        return Some(e);
    }
    table
        .iter()
        .filter(|(k, _)| model.starts_with(k.as_str()))
        .max_by_key(|(k, _)| k.len())
        .map(|(_, v)| v)
}

fn per_m(entry: &Value, key: &str) -> f64 {
    entry.get(key).and_then(|x| x.as_f64()).unwrap_or(0.0)
}

/// Real USD cost of a chat completion from its `usage` block
/// (`{prompt_tokens, completion_tokens}`). None when the model is not priced.
pub fn text_cost_from_usage(cfg: &Value, model: &str, usage: &Value) -> Option<f64> {
    let entry = pricing_entry(cfg, "text", model)?;
    let input = usage.get("prompt_tokens").and_then(|x| x.as_f64())?;
    let output = usage
        .get("completion_tokens")
        .and_then(|x| x.as_f64())
        .unwrap_or(0.0);
    Some((input * per_m(entry, "input_per_m") + output * per_m(entry, "output_per_m")) / 1e6)
}

/// Real USD cost of an images call from its `usage` block
/// (`{input_tokens, output_tokens, input_tokens_details:{text_tokens, image_tokens}}`).
/// None when the model is not priced or the usage block is unusable.
pub fn image_cost_from_usage(cfg: &Value, model: &str, usage: &Value) -> Option<f64> {
    let entry = pricing_entry(cfg, "image", model)?;
    let input = usage.get("input_tokens").and_then(|x| x.as_f64())?;
    let output = usage
        .get("output_tokens")
        .and_then(|x| x.as_f64())
        .unwrap_or(0.0);
    let details = usage.get("input_tokens_details");
    // Without the details split, count the whole input as text tokens.
    let image_in = details
        .and_then(|d| d.get("image_tokens"))
        .and_then(|x| x.as_f64())
        .unwrap_or(0.0);
    let text_in = details
        .and_then(|d| d.get("text_tokens"))
        .and_then(|x| x.as_f64())
        .unwrap_or(input - image_in);
    Some(
        (text_in * per_m(entry, "text_input_per_m")
            + image_in * per_m(entry, "image_input_per_m")
            + output * per_m(entry, "output_per_m"))
            / 1e6,
    )
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

/// OpenAI ADMIN key (`sk-admin-…`, organization endpoints: real billed costs).
/// Config key or `$OPENAI_ADMIN_API_KEY`.
pub fn openai_admin_key(config: &Value) -> String {
    let from_cfg = config
        .get("openai_admin_api_key")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if !from_cfg.is_empty() {
        return from_cfg;
    }
    std::env::var("OPENAI_ADMIN_API_KEY")
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
