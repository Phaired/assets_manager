//! Python worker sidecar: spawn `<.venv python> -m uvicorn worker.main:app
//! --host 127.0.0.1 --port <free port>`, wait for GET /health, supervise it, and
//! expose blocking HTTP calls (multiview / gen3d / export) with long timeouts.

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
use crate::types::Gen3d;

#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

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
struct MultiviewReq<'a> {
    name: &'a str,
    description: &'a str,
    output_dir: String,
    api_key: &'a str,
    model: &'a str,
    quality: &'a str,
    timeout: i64,
    /// Per-image cost from config. The worker echoes this back as `cost` so Rust's
    /// budget accounting (`add_spend`) gets the real value; the original Python
    /// `generate_multiview` returned `est_cost` as `cost`.
    estimated_cost_per_image: f64,
}

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
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportReq {
    glb: String,
    dest: String,
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

    fn venv_python() -> PathBuf {
        config::ROOT
            .join(".venv")
            .join("Scripts")
            .join("python.exe")
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

        let python = Self::venv_python();
        let mut cmd = Command::new(python);
        cmd.arg("-m")
            .arg("uvicorn")
            .arg("worker.main:app")
            .arg("--host")
            .arg("127.0.0.1")
            .arg("--port")
            .arg(port.to_string())
            .current_dir(&*config::ROOT)
            .stdout(std::process::Stdio::from(log_file))
            .stderr(std::process::Stdio::from(log_err));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(CREATE_NEW_PROCESS_GROUP);
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

    /// POST /multiview (~300s). Budget is checked in Rust before calling.
    #[allow(clippy::too_many_arguments)]
    pub fn multiview(
        &self,
        name: &str,
        description: &str,
        output_dir: &str,
        api_key: &str,
        model: &str,
        quality: &str,
        timeout: i64,
        estimated_cost_per_image: f64,
    ) -> AppResult<Value> {
        let body = MultiviewReq {
            name,
            description,
            output_dir: output_dir.to_string(),
            api_key,
            model,
            quality,
            timeout,
            estimated_cost_per_image,
        };
        self.post_json(&self.long, "/multiview", &body, Duration::from_secs(300))
    }

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
    ) -> AppResult<Value> {
        let body = Gen3dReq {
            backend,
            base_url,
            seed,
            gen3d,
            dest: dest.to_string(),
            image_path: image_path.map(|s| s.to_string()),
            view_dir: view_dir.map(|s| s.to_string()),
        };
        self.post_json(&self.long, "/gen3d", &body, Duration::from_secs(3600))
    }

    /// POST /export.
    pub fn export(&self, glb: &str, dest: &str) -> AppResult<Value> {
        let body = ExportReq {
            glb: glb.to_string(),
            dest: dest.to_string(),
        };
        self.post_json(&self.long, "/export", &body, Duration::from_secs(600))
    }

    /// Kill the sidecar (called on app exit).
    pub fn stop(&self) {
        let mut guard = self.inner.lock();
        if let Some(mut child) = guard.proc.take() {
            if matches!(child.try_wait(), Ok(None)) {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        *self.base_url.lock() = None;
    }
}

