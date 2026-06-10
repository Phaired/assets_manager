//! Hunyuan server lifecycle (spawn / monitor / stop). Port of
//! `app/pipeline/server_manager.py`.
//!
//! Single GPU => one backend at a time: starting one stops the other. Health
//! probe distinguishes the two:
//! - v21: GET /health -> 200
//! - mv2 : GET /gradio_api/info -> 200 AND "/generation_all" in named_endpoints.

use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde_json::Value;

use crate::config::{self, Config};
use crate::error::{AppError, AppResult};
use crate::types::ServerStatus;

#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

fn base_url(backend: &str, cfg: &Value) -> Option<String> {
    let h = cfg.get("hunyuan")?.get(backend)?;
    let host = h.get("host").and_then(|x| x.as_str())?;
    let port = h.get("port").and_then(|x| x.as_i64())?;
    Some(format!("http://{host}:{port}"))
}

/// Probe a backend's health endpoint. Returns true if healthy.
pub fn probe(backend: &str, cfg: &Value, timeout_secs: u64) -> bool {
    let base = match base_url(backend, cfg) {
        Some(b) => b,
        None => return false,
    };
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    if backend == "v21" {
        match client.get(format!("{base}/health")).send() {
            Ok(r) => r.status().is_success(),
            Err(_) => false,
        }
    } else {
        match client.get(format!("{base}/gradio_api/info")).send() {
            Ok(r) => {
                if !r.status().is_success() {
                    return false;
                }
                match r.json::<Value>() {
                    Ok(body) => body
                        .get("named_endpoints")
                        .and_then(|n| n.as_object())
                        .map(|m| m.contains_key("/generation_all"))
                        .unwrap_or(false),
                    Err(_) => false,
                }
            }
            Err(_) => false,
        }
    }
}

fn command_for(backend: &str, cfg: &Value) -> AppResult<(Command, PathBuf)> {
    let h = cfg
        .get("hunyuan")
        .and_then(|x| x.get(backend))
        .ok_or_else(|| AppError::msg(format!("config hunyuan[{backend}] manquante")))?;
    let get = |k: &str| h.get(k).and_then(|x| x.as_str()).unwrap_or("");
    let python = get("python");
    let script = get("script");

    // Clear, actionable errors instead of an opaque OS spawn failure when the
    // Hunyuan install has not been configured (Settings) or has moved.
    if python.trim().is_empty() || get("dir").trim().is_empty() {
        return Err(AppError::msg(format!(
            "Hunyuan {backend} non configuré : renseigne le dossier et le python du serveur dans Réglages."
        )));
    }
    if !PathBuf::from(python).is_file() {
        return Err(AppError::msg(format!(
            "Hunyuan {backend} introuvable : python « {python} » n'existe pas (vérifie le chemin dans Réglages)."
        )));
    }
    if !PathBuf::from(get("dir")).is_dir() {
        return Err(AppError::msg(format!(
            "Hunyuan {backend} introuvable : dossier « {} » inexistant (vérifie le chemin dans Réglages).",
            get("dir")
        )));
    }
    let host = h
        .get("host")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .unwrap_or_default();
    let port = h
        .get("port")
        .and_then(|x| x.as_i64())
        .map(|p| p.to_string())
        .unwrap_or_default();
    let dir = PathBuf::from(get("dir"));

    let mut cmd = Command::new(python);
    cmd.arg(script)
        .arg("--host")
        .arg(host)
        .arg("--port")
        .arg(port)
        .arg("--model_path")
        .arg(get("model_path"))
        .arg("--subfolder")
        .arg(get("subfolder"));
    let texgen = get("texgen_model_path");
    if !texgen.is_empty() {
        cmd.arg("--texgen_model_path").arg(texgen);
    }
    if let Some(extra) = h.get("extra_args").and_then(|x| x.as_array()) {
        for a in extra {
            if let Some(s) = a.as_str() {
                cmd.arg(s);
            }
        }
    }
    // Point the server at the centralised HuggingFace cache the guided installer
    // filled, so weights are read from the same single folder (not ~/.cache).
    if let Some(hf) = h.get("hf_home").and_then(|x| x.as_str()).filter(|s| !s.is_empty()) {
        cmd.env("HF_HOME", hf);
    }
    cmd.current_dir(&dir);
    Ok((cmd, dir))
}

struct Inner {
    proc: Option<Child>,
    backend: Option<String>,
    status: String, // stopped | starting | healthy | error
    log_path: Option<PathBuf>,
    error: Option<String>,
}

pub struct Supervisor {
    config: Arc<Config>,
    inner: Mutex<Inner>,
}

impl Supervisor {
    pub fn new(config: Arc<Config>) -> Self {
        Supervisor {
            config,
            inner: Mutex::new(Inner {
                proc: None,
                backend: None,
                status: "stopped".into(),
                log_path: None,
                error: None,
            }),
        }
    }

    fn tail(&self, log_path: &Option<PathBuf>, lines: usize) -> String {
        let path = match log_path {
            Some(p) if p.is_file() => p,
            _ => return String::new(),
        };
        let text = match std::fs::read(path) {
            Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
            Err(_) => return String::new(),
        };
        let all: Vec<&str> = text.lines().collect();
        let start = all.len().saturating_sub(lines);
        all[start..].join("\n")
    }

    /// Reconcile with reality and return a ServerStatus.
    pub fn status(&self) -> ServerStatus {
        let cfg = self.config.load();
        let mut guard = self.inner.lock();
        // Reflect a dead managed child.
        let managed = match guard.proc.as_mut() {
            Some(child) => matches!(child.try_wait(), Ok(None)),
            None => false,
        };
        let mut backend = guard.backend.clone();
        let mut status = guard.status.clone();
        if status != "healthy" {
            for b in ["v21", "mv2"] {
                if probe(b, &cfg, 3) {
                    backend = Some(b.to_string());
                    status = "healthy".to_string();
                    break;
                }
            }
        }
        let log_tail = self.tail(&guard.log_path, 40);
        let error = guard.error.clone();
        ServerStatus {
            base_url: backend.as_deref().and_then(|b| base_url(b, &cfg)),
            backend,
            status,
            error,
            log_tail,
            managed,
        }
    }

    fn is_managed_alive(guard: &mut Inner) -> bool {
        match guard.proc.as_mut() {
            Some(child) => matches!(child.try_wait(), Ok(None)),
            None => false,
        }
    }

    /// Start `backend`. Adopts an already-healthy server; otherwise stops the
    /// other backend and spawns this one with a monitor thread.
    pub fn start(self: &Arc<Self>, backend: &str) -> AppResult<()> {
        let cfg = self.config.load();
        {
            let mut guard = self.inner.lock();
            if guard.backend.as_deref() == Some(backend)
                && (guard.status == "starting" || guard.status == "healthy")
                && Self::is_managed_alive(&mut guard)
            {
                return Ok(());
            }
        }
        if probe(backend, &cfg, 3) {
            let mut guard = self.inner.lock();
            guard.backend = Some(backend.to_string());
            guard.status = "healthy".into();
            guard.error = None;
            return Ok(());
        }
        // Free the GPU from the other backend.
        self.stop();

        let log_path = config::logs_dir()?.join(format!("hunyuan_{backend}.log"));
        let log_file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)?;
        let log_err = log_file.try_clone()?;

        let (mut cmd, _dir) = command_for(backend, &cfg)?;
        cmd.stdout(std::process::Stdio::from(log_file))
            .stderr(std::process::Stdio::from(log_err));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(CREATE_NEW_PROCESS_GROUP);
        }
        let child = cmd
            .spawn()
            .map_err(|e| AppError::msg(format!("echec lancement {backend}: {e}")))?;

        {
            let mut guard = self.inner.lock();
            guard.proc = Some(child);
            guard.backend = Some(backend.to_string());
            guard.status = "starting".into();
            guard.error = None;
            guard.log_path = Some(log_path);
        }

        let me = Arc::clone(self);
        let backend_owned = backend.to_string();
        std::thread::spawn(move || me.monitor(&backend_owned, 900));
        Ok(())
    }

    fn monitor(&self, backend: &str, timeout_secs: u64) {
        let cfg = self.config.load();
        let deadline = Instant::now() + Duration::from_secs(timeout_secs);
        while Instant::now() < deadline {
            {
                let mut guard = self.inner.lock();
                let exited = match guard.proc.as_mut() {
                    Some(child) => match child.try_wait() {
                        Ok(Some(code)) => Some(code.code()),
                        Ok(None) => None,
                        Err(_) => Some(None),
                    },
                    None => Some(None),
                };
                if let Some(code) = exited {
                    guard.status = "error".into();
                    let code_s = code
                        .map(|c| c.to_string())
                        .unwrap_or_else(|| "?".to_string());
                    guard.error =
                        Some(format!("le serveur {backend} s'est arrete (code {code_s})"));
                    return;
                }
            }
            if probe(backend, &cfg, 3) {
                let mut guard = self.inner.lock();
                guard.status = "healthy".into();
                guard.error = None;
                return;
            }
            std::thread::sleep(Duration::from_secs(3));
        }
        let mut guard = self.inner.lock();
        guard.status = "error".into();
        guard.error = Some(format!(
            "timeout: {backend} non pret apres {timeout_secs}s"
        ));
    }

    pub fn stop(&self) {
        let mut guard = self.inner.lock();
        if let Some(mut child) = guard.proc.take() {
            if matches!(child.try_wait(), Ok(None)) {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        guard.status = "stopped".into();
        guard.backend = None;
    }

    /// Resolve the asset backend: explicit v21/mv2, else prefer a running server,
    /// else config default_backend.
    pub fn resolve_backend(&self, asset_backend: &str) -> String {
        if asset_backend == "v21" || asset_backend == "mv2" {
            return asset_backend.to_string();
        }
        let cfg = self.config.load();
        for b in ["v21", "mv2"] {
            if probe(b, &cfg, 3) {
                return b.to_string();
            }
        }
        cfg.get("default_backend")
            .and_then(|x| x.as_str())
            .unwrap_or("v21")
            .to_string()
    }

    /// Ensure `backend` is healthy; start if needed. Returns base_url.
    pub fn ensure(self: &Arc<Self>, backend: &str, timeout_secs: u64) -> AppResult<String> {
        let cfg = self.config.load();
        if probe(backend, &cfg, 3) {
            let mut guard = self.inner.lock();
            guard.backend = Some(backend.to_string());
            guard.status = "healthy".into();
            drop(guard);
            return base_url(backend, &cfg)
                .ok_or_else(|| AppError::msg(format!("base_url indisponible pour {backend}")));
        }
        self.start(backend)?;
        let deadline = Instant::now() + Duration::from_secs(timeout_secs);
        while Instant::now() < deadline {
            let (status, error) = {
                let guard = self.inner.lock();
                (guard.status.clone(), guard.error.clone())
            };
            if status == "healthy" {
                return base_url(backend, &cfg).ok_or_else(|| {
                    AppError::msg(format!("base_url indisponible pour {backend}"))
                });
            }
            if status == "error" {
                return Err(AppError::msg(
                    error.unwrap_or_else(|| format!("echec demarrage {backend}")),
                ));
            }
            std::thread::sleep(Duration::from_secs(2));
        }
        Err(AppError::msg(format!("timeout demarrage {backend}")))
    }
}
