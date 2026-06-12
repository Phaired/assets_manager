//! Python worker sidecar: spawn `<.venv python> -m uvicorn worker.main:app
//! --host 127.0.0.1 --port <free port>`, wait for GET /health, supervise it, and
//! expose blocking HTTP calls (gen3d / export) with long timeouts. The OpenAI
//! image stages (multiview, edit) are pure Rust — see `openai.rs`.

use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::config;
use crate::error::{AppError, AppResult};
use crate::types::{DecimateParams, Gen3d};

#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
/// Suppress the console window of console-subsystem children (worker.exe /
/// uvicorn) — without it every spawn pops a terminal in the packaged app.
/// Stops use child.kill(), not console Ctrl events, so no console is needed.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// sha256(asset_id) -> first 8 hex chars -> u64 -> % 10_000_000.
pub fn seed_from_id(asset_id: &str) -> u64 {
    let mut hasher = Sha256::new();
    hasher.update(asset_id.as_bytes());
    let digest = hasher.finalize();
    let hex = hex::encode(digest);
    let first8 = &hex[..8];
    let value = u64::from_str_radix(first8, 16).unwrap_or(0);
    value % 10_000_000
}

/// Pick a free 127.0.0.1 TCP port by binding to :0 and reading back the port.
fn pick_free_port() -> AppResult<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| AppError::msg(format!("impossible de reserver un port: {e}")))?;
    let port = listener
        .local_addr()
        .map_err(|e| AppError::msg(format!("port introuvable: {e}")))?
        .port();
    Ok(port)
}

// --- request bodies (camelCase per the worker API) ----------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Gen3dReq<'a> {
    backend: &'a str,
    base_url: &'a str,
    seed: u64,
    gen3d: &'a Gen3d,
    dest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    image_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    view_dir: Option<String>,
    /// Where the worker persists the untouched raw GLB (for /decimate).
    #[serde(skip_serializing_if = "Option::is_none")]
    raw_dest: Option<String>,
    /// Native text-to-3D prompt (mv2 + --enable_t23d). Mutually exclusive with
    /// image_path/view_dir.
    #[serde(skip_serializing_if = "Option::is_none")]
    caption: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportReq {
    glb: String,
    dest: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DecimateReq<'a> {
    raw: String,
    dest: String,
    params: &'a DecimateParams,
}

struct Inner {
    proc: Option<Child>,
}

pub struct WorkerClient {
    inner: Mutex<Inner>,
    base_url: Mutex<Option<String>>,
    /// Short client for /health, long client for ML ops.
    short: reqwest::blocking::Client,
    long: reqwest::blocking::Client,
}

impl WorkerClient {
    /// `_config` is accepted for symmetry with the other managers (the worker is
    /// stateless and receives every parameter explicitly, so it is not retained).
    pub fn new(_config: Arc<config::Config>) -> AppResult<Self> {
        let short = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()?;
        // Per-request timeouts override this; keep a generous ceiling.
        let long = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(3600))
            .build()?;
        Ok(WorkerClient {
            inner: Mutex::new(Inner { proc: None }),
            base_url: Mutex::new(None),
            short,
            long,
        })
    }

    pub fn base_url(&self) -> Option<String> {
        self.base_url.lock().clone()
    }

    /// Path to the bundled frozen worker exe (packaged builds). The PyInstaller
    /// one-folder bundle lands under `<resource_dir>/worker/worker.exe`.
    fn frozen_worker() -> PathBuf {
        config::resource_root()
            .join("worker")
            .join("worker.exe")
    }

    /// Dev fallback: the project `.venv` interpreter.
    fn venv_python() -> PathBuf {
        config::repo_root()
            .join(".venv")
            .join("Scripts")
            .join("python.exe")
    }

    /// Build the spawn command for the worker on `port`. Prefers the bundled
    /// frozen exe (no Python needed on the target); falls back to the dev venv
    /// running uvicorn from the repo root.
    fn worker_command(port: u16) -> Command {
        let port_s = port.to_string();
        let frozen = Self::frozen_worker();
        if frozen.is_file() {
            let mut cmd = Command::new(frozen);
            cmd.arg("--host").arg("127.0.0.1").arg("--port").arg(port_s);
            cmd
        } else {
            let mut cmd = Command::new(Self::venv_python());
            cmd.arg("-m")
                .arg("uvicorn")
                .arg("worker.main:app")
                .arg("--host")
                .arg("127.0.0.1")
                .arg("--port")
                .arg(port_s)
                .current_dir(config::repo_root());
            cmd
        }
    }

    /// Spawn the sidecar (non-blocking spawn; then wait for /health up to ~60s).
    /// Safe to call repeatedly — a live child is reused.
    pub fn ensure_started(&self) -> AppResult<String> {
        {
            let mut guard = self.inner.lock();
            if let Some(child) = guard.proc.as_mut() {
                if matches!(child.try_wait(), Ok(None)) {
                    if let Some(url) = self.base_url() {
                        return Ok(url);
                    }
                }
            }
        }
        let port = pick_free_port()?;
        let base = format!("http://127.0.0.1:{port}");
        let log_path = config::logs_dir()?.join("worker.log");
        let log_file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)?;
        let log_err = log_file.try_clone()?;

        let mut cmd = Self::worker_command(port);
        cmd.stdout(std::process::Stdio::from(log_file))
            .stderr(std::process::Stdio::from(log_err));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
        }
        let child = cmd
            .spawn()
            .map_err(|e| AppError::msg(format!("echec lancement worker: {e}")))?;

        {
            let mut guard = self.inner.lock();
            guard.proc = Some(child);
        }
        *self.base_url.lock() = Some(base.clone());

        self.wait_healthy(&base, 60)?;
        Ok(base)
    }

    fn wait_healthy(&self, base: &str, timeout_secs: u64) -> AppResult<()> {
        let deadline = Instant::now() + Duration::from_secs(timeout_secs);
        while Instant::now() < deadline {
            // bail early if the process died
            {
                let mut guard = self.inner.lock();
                if let Some(child) = guard.proc.as_mut() {
                    if let Ok(Some(code)) = child.try_wait() {
                        return Err(AppError::msg(format!(
                            "le worker s'est arrete au demarrage (code {:?})",
                            code.code()
                        )));
                    }
                }
            }
            if let Ok(r) = self.short.get(format!("{base}/health")).send() {
                if r.status().is_success() {
                    return Ok(());
                }
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        Err(AppError::msg("worker /health non pret (timeout)"))
    }

    /// Ensure healthy and return the base_url, spawning if needed.
    fn require_base(&self) -> AppResult<String> {
        if let Some(url) = self.base_url() {
            // quick liveness check
            let alive = {
                let mut guard = self.inner.lock();
                match guard.proc.as_mut() {
                    Some(child) => matches!(child.try_wait(), Ok(None)),
                    None => false,
                }
            };
            if alive {
                return Ok(url);
            }
        }
        self.ensure_started()
    }

    fn extract_detail(body: &str) -> String {
        serde_json::from_str::<Value>(body)
            .ok()
            .and_then(|v| {
                v.get("detail")
                    .and_then(|d| d.as_str())
                    .map(|s| s.to_string())
            })
            .unwrap_or_else(|| body.to_string())
    }

    fn post_json(
        &self,
        client: &reqwest::blocking::Client,
        path: &str,
        body: &impl Serialize,
        timeout: Duration,
    ) -> AppResult<Value> {
        let base = self.require_base()?;
        let resp = client
            .post(format!("{base}{path}"))
            .timeout(timeout)
            .json(body)
            .send()?;
        let status = resp.status();
        let text = resp.text().unwrap_or_default();
        if !status.is_success() {
            return Err(AppError::msg(Self::extract_detail(&text)));
        }
        let value: Value = serde_json::from_str(&text)
            .map_err(|e| AppError::msg(format!("reponse worker invalide ({path}): {e}")))?;
        Ok(value)
    }

    // --- worker operations ----------------------------------------------

    /// POST /gen3d (~3600s).
    #[allow(clippy::too_many_arguments)]
    pub fn gen3d(
        &self,
        backend: &str,
        base_url: &str,
        seed: u64,
        gen3d: &Gen3d,
        dest: &str,
        image_path: Option<&str>,
        view_dir: Option<&str>,
        raw_dest: Option<&str>,
        caption: Option<&str>,
    ) -> AppResult<Value> {
        let body = Gen3dReq {
            backend,
            base_url,
            seed,
            gen3d,
            dest: dest.to_string(),
            image_path: image_path.map(|s| s.to_string()),
            view_dir: view_dir.map(|s| s.to_string()),
            raw_dest: raw_dest.map(|s| s.to_string()),
            caption: caption.map(|s| s.to_string()),
        };
        self.post_json(&self.long, "/gen3d", &body, Duration::from_secs(3600))
    }

    /// POST /decimate (re-reduce model_raw.glb with tunable params, ~900s).
    pub fn decimate(&self, raw: &str, dest: &str, params: &DecimateParams) -> AppResult<Value> {
        let body = DecimateReq {
            raw: raw.to_string(),
            dest: dest.to_string(),
            params,
        };
        self.post_json(&self.long, "/decimate", &body, Duration::from_secs(900))
    }

    /// POST /export.
    pub fn export(&self, glb: &str, dest: &str) -> AppResult<Value> {
        let body = ExportReq {
            glb: glb.to_string(),
            dest: dest.to_string(),
        };
        self.post_json(&self.long, "/export", &body, Duration::from_secs(600))
    }

    /// Kill the sidecar and its whole process tree (called on app exit).
    pub fn stop(&self) {
        let mut guard = self.inner.lock();
        if let Some(mut child) = guard.proc.take() {
            crate::proc::kill_child_tree(&mut child);
        }
        *self.base_url.lock() = None;
    }
}

/// The standalone texture-paint script, embedded at compile time (single source
/// of truth with the worker). Written into the mv2 backend dir at run time so it
/// imports hy3dgen exactly like gradio.
const PAINT_SCRIPT: &str = include_str!("../../worker/paint_mesh.py");

/// Run the standalone Hunyuan paint pass: the mv2 venv python on `paint_mesh.py`,
/// painting an untextured mesh from a reference image into `out`. Loads only the
/// texture pipeline (no HunyuanDiT / shapegen), so the caller MUST free the GPU
/// first (`supervisor.ensure_gpu_free`). Blocking; takes minutes. Config-only —
/// not a method on WorkerClient (this does not go through the worker sidecar).
pub fn paint_mesh(cfg: &Value, mesh: &str, image: &str, out: &str) -> AppResult<()> {
    let h = cfg
        .get("hunyuan")
        .and_then(|x| x.get("mv2"))
        .ok_or_else(|| AppError::msg("config hunyuan.mv2 manquante"))?;
    let get = |k: &str| h.get(k).and_then(|x| x.as_str()).unwrap_or("");
    let python = get("python");
    let dir = get("dir");
    if python.trim().is_empty() || dir.trim().is_empty() {
        return Err(AppError::msg(
            "Hunyuan mv2 non configuré : renseigne le dossier et le python dans Réglages.",
        ));
    }
    let backend_dir = PathBuf::from(dir);
    if !PathBuf::from(python).is_file() || !backend_dir.is_dir() {
        return Err(AppError::msg(
            "Hunyuan mv2 introuvable : vérifie les chemins dans Réglages.",
        ));
    }
    // Ship the current script into the backend dir so `import hy3dgen` and the
    // hunyuanpaint custom_pipeline resolve exactly like gradio.
    let script_path = backend_dir.join("paint_mesh.py");
    std::fs::write(&script_path, PAINT_SCRIPT)
        .map_err(|e| AppError::msg(format!("écriture paint_mesh.py: {e}")))?;

    let texgen = {
        let t = get("texgen_model_path");
        if t.is_empty() {
            "tencent/Hunyuan3D-2".to_string()
        } else {
            t.to_string()
        }
    };
    let log_path = config::logs_dir()?.join("paint3d.log");
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)?;
    let log_err = log.try_clone()?;

    let mut cmd = Command::new(python);
    cmd.arg(&script_path)
        .arg("--mesh")
        .arg(mesh)
        .arg("--image")
        .arg(image)
        .arg("--out")
        .arg(out)
        .arg("--texgen-model")
        .arg(&texgen)
        .arg("--backend-dir")
        .arg(&backend_dir)
        .current_dir(&backend_dir)
        .stdout(std::process::Stdio::from(log))
        .stderr(std::process::Stdio::from(log_err))
        .stdin(std::process::Stdio::null());
    if let Some(hf) = h.get("hf_home").and_then(|x| x.as_str()).filter(|s| !s.is_empty()) {
        cmd.env("HF_HOME", hf);
    }
    // Resolve weights from the centralised cache, never the network.
    cmd.env("HF_HUB_DISABLE_TELEMETRY", "1")
        .env("HF_HUB_OFFLINE", "1")
        .env("TRANSFORMERS_OFFLINE", "1");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }
    let status = cmd
        .status()
        .map_err(|e| AppError::msg(format!("échec lancement paint: {e}")))?;
    if !status.success() {
        let tail = std::fs::read_to_string(&log_path)
            .ok()
            .map(|s| {
                let lines: Vec<&str> = s.lines().collect();
                let start = lines.len().saturating_sub(25);
                lines[start..].join("\n")
            })
            .unwrap_or_default();
        return Err(AppError::msg(format!(
            "le pass de texturing a échoué (code {:?}).\n{tail}",
            status.code()
        )));
    }
    Ok(())
}

