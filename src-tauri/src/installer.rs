//! Guided in-app installer for the heavy Hunyuan3D backend(s).
//!
//! Goal: make the local 3D generation backend usable by a NON-technical user
//! with a single click — no terminal, no git, no system Python, no compiler.
//! The ONLY user prerequisite is an NVIDIA GPU + a recent driver (the CUDA
//! runtime ships inside the PyTorch wheels — no CUDA Toolkit needed).
//!
//! Strategy (hybrid). Almost everything is pulled from public indexes at install
//! time, so we self-host next to nothing:
//!   - Python       → downloaded/managed by the bundled `uv` (resource `uv/uv.exe`).
//!   - torch + CUDA → official wheels (`download.pytorch.org/whl/cu124`).
//!   - PyPI deps    → the Hunyuan repo's own `requirements.txt`.
//!   - Hunyuan code → a pinned GitHub zipball (no `git` needed).
//!   - model weights→ HuggingFace (snapshot_download into the HF cache).
//!   - CUDA exts    → the ONLY self-hosted artifacts: 2 tiny prebuilt wheels
//!                    (`custom_rasterizer`, `differentiable_renderer`) — see
//!                    `Recipe::ext_wheels` (fill the URLs once you publish them).
//!
//! Determinism: a single pinned tuple (Python 3.10 + torch + cu124 + win-amd64)
//! keeps pip resolution reproducible and lets the 2 prebuilt wheels match.
//!
//! The pipeline runs on a background thread, streams `install-progress` events,
//! is idempotent (per-step sentinels under `<dir>/.assets_gen_install/`) and
//! cancellable. On success it writes the backend paths into the config (exactly
//! the shape `supervisor::command_for` expects) and starts the server.

use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::AppHandle;

use crate::config::{self, Config};
use crate::error::{AppError, AppResult};
use crate::events;
use crate::supervisor::Supervisor;
use crate::types::InstallProgress;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// ===========================================================================
// Recipe — the pinned, per-backend install description.
//
// The orchestration below is generic; everything backend/version specific lives
// here. Values flagged `FILL` must be set once before shipping a real installer
// (after you publish the prebuilt extension wheels and pick a repo commit). The
// installer still runs with placeholders — it will fail at the relevant step
// with a clear message pointing back here, never silently.
// ===========================================================================

struct Wheel {
    url: &'static str,
    /// Optional sha256 (lowercase hex). Empty = skip verification.
    sha256: &'static str,
}

struct Weights {
    repo_id: &'static str,
    /// Restrict the download to these glob patterns (HF `allow_patterns`). Empty
    /// slice = whole repo.
    allow_patterns: &'static [&'static str],
}

struct Recipe {
    backend: &'static str,
    /// Python version uv provisions for the backend venv.
    python_version: &'static str,
    /// GitHub zipball of a PINNED commit/tag (codeload archive URL).
    repo_zip_url: &'static str,
    /// Optional sha256 of the zipball. Empty = skip verification.
    repo_zip_sha256: &'static str,
    /// PyTorch wheel index for the pinned CUDA build.
    torch_index_url: &'static str,
    /// torch/torchvision pins installed from `torch_index_url`.
    torch_packages: &'static [&'static str],
    /// The 2 prebuilt CUDA-extension wheels (self-hosted). Empty until published.
    ext_wheels: &'static [Wheel],
    /// Model weights to pre-fetch into the HF cache (so the first generation does
    /// not silently hang on a multi-GB download).
    weights: &'static [Weights],

    // --- final config fields (mirror `config::defaults` for this backend) ----
    script: &'static str,
    host: &'static str,
    port: i64,
    model_path: &'static str,
    subfolder: &'static str,
    texgen_model_path: &'static str,
    extra_args: &'static [&'static str],
}

/// Hunyuan3D-2mv (4-view, Gradio :8080) — the app's primary path.
const RECIPE_MV2: Recipe = Recipe {
    backend: "mv2",
    python_version: "3.10",
    // Pinned Tencent/Hunyuan3D-2 commit (same one the wheels were built against).
    // GitHub archive bytes are not guaranteed stable, so we skip the zip sha256.
    repo_zip_url:
        "https://codeload.github.com/Tencent/Hunyuan3D-2/zip/f8db63096c8282cb27354314d896feba5ba6ff8a",
    repo_zip_sha256: "",
    torch_index_url: "https://download.pytorch.org/whl/cu124",
    torch_packages: &["torch==2.5.1", "torchvision==0.20.1"],
    // Prebuilt CUDA/C++ extension wheels for the pinned tuple
    // (py3.10 + torch 2.5.1 + cu124 + win_amd64), self-hosted on the app's GitHub
    // Releases. Rebuild via scripts/build-extension-wheels.ps1 if the tuple changes.
    ext_wheels: &[
        Wheel {
            url: "https://github.com/Phaired/assets_manager/releases/download/hunyuan-mv2-cu124-py310-v1/custom_rasterizer-0.1-cp310-cp310-win_amd64.whl",
            sha256: "ab2057989d0d8929902ebd35c2c422ce8dd83d88222941c5e1f116df7e799679",
        },
        Wheel {
            url: "https://github.com/Phaired/assets_manager/releases/download/hunyuan-mv2-cu124-py310-v1/mesh_processor-0.0.0-cp310-cp310-win_amd64.whl",
            sha256: "cd17fc85b716e83738be6d22799720e21ffae863abcff91826f569e9523a12a4",
        },
    ],
    weights: &[
        // Shape model (multi-view DiT). The 2mv repo has no VAE dir — it comes
        // from the base repo below.
        Weights {
            repo_id: "tencent/Hunyuan3D-2mv",
            allow_patterns: &["hunyuan3d-dit-v2-mv/*"],
        },
        // Base repo: texture paint + delight, plus the shape VAE the mv2 DiT needs.
        Weights {
            repo_id: "tencent/Hunyuan3D-2",
            allow_patterns: &[
                "hunyuan3d-paint-v2-0/*",
                "hunyuan3d-delight-v2-0/*",
                "hunyuan3d-vae-v2-0/*",
            ],
        },
    ],
    script: "gradio_app.py",
    host: "127.0.0.1",
    port: 8080,
    model_path: "tencent/Hunyuan3D-2mv",
    subfolder: "hunyuan3d-dit-v2-mv",
    texgen_model_path: "tencent/Hunyuan3D-2",
    extra_args: &["--low_vram_mode", "--enable_flashvdm"],
};

fn recipe_for(backend: &str) -> AppResult<&'static Recipe> {
    match backend {
        "mv2" => Ok(&RECIPE_MV2),
        // v21 will be added here with its own Recipe (FastAPI :8081).
        other => Err(AppError::msg(format!(
            "installeur indisponible pour le backend « {other} » (mv2 uniquement pour l'instant)"
        ))),
    }
}

// ===========================================================================
// Installer state + public API
// ===========================================================================

struct Inner {
    running: bool,
    cancel: bool,
    backend: Option<String>,
    phase: String,
    pct: u8,
    message: String,
    done: bool,
    error: Option<String>,
    /// Currently running child (for cancellation). Steps register here.
    child: Option<Child>,
    /// Path of the current install log (tailed for the progress message).
    log_path: Option<PathBuf>,
    /// Centralised runtime root: every step's env (uv Python, uv cache, HF cache)
    /// points under here so the whole 3D stack lives in ONE deletable folder.
    root: Option<PathBuf>,
}

pub struct Installer {
    config: Arc<Config>,
    inner: Mutex<Inner>,
}

impl Installer {
    pub fn new(config: Arc<Config>) -> Self {
        Installer {
            config,
            inner: Mutex::new(Inner {
                running: false,
                cancel: false,
                backend: None,
                phase: "idle".into(),
                pct: 0,
                message: String::new(),
                done: false,
                error: None,
                child: None,
                log_path: None,
                root: None,
            }),
        }
    }

    /// Snapshot the current progress for the `install_status` command.
    pub fn status(&self) -> InstallProgress {
        let g = self.inner.lock();
        InstallProgress {
            backend: g.backend.clone(),
            running: g.running,
            phase: g.phase.clone(),
            pct: g.pct,
            message: g.message.clone(),
            log_tail: tail_file(&g.log_path, 40),
            done: g.done,
            error: g.error.clone(),
        }
    }

    /// Request cancellation of a running install. Kills the current child so the
    /// step loop unwinds promptly.
    pub fn cancel(&self) {
        let mut g = self.inner.lock();
        g.cancel = true;
        if let Some(child) = g.child.as_mut() {
            let _ = child.kill();
        }
    }

    /// Kick off the install on a background thread. Returns the initial snapshot.
    /// Rejects if an install is already running.
    pub fn start(
        self: &Arc<Self>,
        app: AppHandle,
        supervisor: Arc<Supervisor>,
        backend: &str,
    ) -> AppResult<InstallProgress> {
        // Validate the backend up front (clear error before we spawn anything).
        let _ = recipe_for(backend)?;
        {
            let mut g = self.inner.lock();
            if g.running {
                return Err(AppError::msg(
                    "une installation est déjà en cours — patiente ou annule-la d'abord.",
                ));
            }
            g.running = true;
            g.cancel = false;
            g.done = false;
            g.error = None;
            g.backend = Some(backend.to_string());
            g.phase = "preflight".into();
            g.pct = 0;
            g.message = "Préparation…".into();
            g.child = None;
            g.log_path = None;
        }

        let me = Arc::clone(self);
        let backend_owned = backend.to_string();
        std::thread::spawn(move || {
            let result = me.run_pipeline(&app, &supervisor, &backend_owned);
            let mut g = me.inner.lock();
            g.running = false;
            g.child = None;
            match result {
                Ok(()) => {
                    g.done = true;
                    g.phase = "done".into();
                    g.pct = 100;
                    g.message = "Installation terminée — serveur prêt.".into();
                    g.error = None;
                }
                Err(e) => {
                    g.done = false;
                    g.error = Some(e.to_string());
                    g.message = e.to_string();
                }
            }
            let snapshot = InstallProgress {
                backend: g.backend.clone(),
                running: false,
                phase: g.phase.clone(),
                pct: g.pct,
                message: g.message.clone(),
                log_tail: tail_file(&g.log_path, 40),
                done: g.done,
                error: g.error.clone(),
            };
            drop(g);
            events::emit_install_progress(&app, &snapshot);
        });

        Ok(self.status())
    }

    // --- pipeline ---------------------------------------------------------

    fn run_pipeline(
        self: &Arc<Self>,
        app: &AppHandle,
        supervisor: &Arc<Supervisor>,
        backend: &str,
    ) -> AppResult<()> {
        let recipe = recipe_for(backend)?;
        // Everything (uv-managed Python, uv cache, HF weights cache, the venv +
        // Hunyuan code) lives under ONE centralised root, so it sits on the local
        // (non-roaming) drive and uninstalls by deleting a single folder.
        let root = runtime_root();
        std::fs::create_dir_all(&root)?;
        self.inner.lock().root = Some(root.clone());
        let install_dir = root.join("backends").join(format!("hunyuan_{backend}"));
        std::fs::create_dir_all(&install_dir)?;
        let markers = install_dir.join(".assets_gen_install");
        std::fs::create_dir_all(&markers)?;

        // Fresh log per run.
        let log_path = config::logs_dir()?.join(format!("install_{backend}.log"));
        let _ = std::fs::write(&log_path, b"");
        self.inner.lock().log_path = Some(log_path.clone());

        let uv = uv_exe();
        let venv_python = install_dir.join(".venv").join("Scripts").join("python.exe");

        // 1. Preflight ------------------------------------------------------
        self.phase(app, "preflight", 1, "Vérification du GPU NVIDIA…");
        self.preflight(app, &log_path)?;
        self.check_cancel()?;

        // 2. Python ---------------------------------------------------------
        self.phase(app, "python", 4, "Téléchargement de Python (géré par uv)…");
        if !is_done(&markers, "python") {
            let mut c = Command::new(&uv);
            c.arg("python").arg("install").arg(recipe.python_version);
            self.run(app, c, &log_path)?;
            mark_done(&markers, "python")?;
        }
        self.check_cancel()?;

        // 3. Code (pinned zipball) -----------------------------------------
        self.phase(app, "code", 12, "Téléchargement du code Hunyuan3D…");
        if !is_done(&markers, "code") {
            let zip_path = install_dir.join("_repo.zip");
            self.download(app, recipe.repo_zip_url, &zip_path, recipe.repo_zip_sha256, 12, 18)?;
            self.phase(app, "code", 18, "Extraction du code…");
            extract_zip_strip_top(&zip_path, &install_dir)?;
            let _ = std::fs::remove_file(&zip_path);
            mark_done(&markers, "code")?;
        }
        self.check_cancel()?;

        // 4. venv -----------------------------------------------------------
        self.phase(app, "venv", 20, "Création de l'environnement Python…");
        if !venv_python.is_file() {
            let mut c = Command::new(&uv);
            c.arg("venv")
                .arg("--python")
                .arg(recipe.python_version)
                .arg(install_dir.join(".venv"));
            self.run(app, c, &log_path)?;
        }
        self.check_cancel()?;

        // 5. torch (CUDA wheels) -------------------------------------------
        self.phase(app, "torch", 25, "Installation de PyTorch (CUDA)…");
        if !is_done(&markers, "torch") {
            let mut c = Command::new(&uv);
            c.arg("pip")
                .arg("install")
                .arg("--python")
                .arg(&venv_python)
                .arg("--index-url")
                .arg(recipe.torch_index_url);
            for p in recipe.torch_packages {
                c.arg(p);
            }
            self.run(app, c, &log_path)?;
            mark_done(&markers, "torch")?;
        }
        self.check_cancel()?;

        // 6. deps (repo requirements + huggingface_hub) --------------------
        self.phase(app, "deps", 50, "Installation des dépendances Python…");
        if !is_done(&markers, "deps") {
            let req = install_dir.join("requirements.txt");
            if req.is_file() {
                let mut c = Command::new(&uv);
                c.arg("pip")
                    .arg("install")
                    .arg("--python")
                    .arg(&venv_python)
                    .arg("-r")
                    .arg(&req);
                self.run(app, c, &log_path)?;
            } else {
                self.log_line(&log_path, "requirements.txt absent du repo — étape deps ignorée.");
            }
            // huggingface_hub is needed for the weights pre-fetch (and usually a
            // transitive dep already; install explicitly to be safe).
            let mut c = Command::new(&uv);
            c.arg("pip")
                .arg("install")
                .arg("--python")
                .arg(&venv_python)
                .arg("huggingface_hub");
            self.run(app, c, &log_path)?;
            mark_done(&markers, "deps")?;
        }
        self.check_cancel()?;

        // 7. CUDA extension wheels (self-hosted) ---------------------------
        self.phase(app, "extensions", 65, "Installation des extensions CUDA…");
        if !is_done(&markers, "extensions") {
            if recipe.ext_wheels.is_empty() {
                self.log_line(
                    &log_path,
                    "ATTENTION: aucune wheel d'extension configurée (Recipe::ext_wheels). \
                     La génération de texture restera indisponible tant que custom_rasterizer \
                     et differentiable_renderer ne sont pas installés.",
                );
            } else {
                for (i, w) in recipe.ext_wheels.iter().enumerate() {
                    let dest = install_dir.join(format!("_ext_{i}.whl"));
                    self.download(app, w.url, &dest, w.sha256, 65, 70)?;
                    let mut c = Command::new(&uv);
                    c.arg("pip")
                        .arg("install")
                        .arg("--python")
                        .arg(&venv_python)
                        .arg(&dest);
                    self.run(app, c, &log_path)?;
                    let _ = std::fs::remove_file(&dest);
                }
                mark_done(&markers, "extensions")?;
            }
        }
        self.check_cancel()?;

        // 8. weights (pre-fetch into the HF cache) -------------------------
        self.phase(app, "weights", 72, "Téléchargement des poids du modèle (plusieurs Go)…");
        if !is_done(&markers, "weights") {
            self.download_weights(app, &venv_python, recipe, &log_path)?;
            mark_done(&markers, "weights")?;
        }
        self.check_cancel()?;

        // 9. config ---------------------------------------------------------
        self.phase(app, "config", 96, "Enregistrement de la configuration…");
        self.write_config(recipe, &install_dir, &venv_python)?;
        self.check_cancel()?;

        // 10. start the server ---------------------------------------------
        self.phase(app, "start", 97, "Démarrage du serveur Hunyuan…");
        supervisor.start(backend)?;
        // Wait for healthy (model load can take a few minutes).
        let deadline = std::time::Instant::now() + Duration::from_secs(900);
        loop {
            self.check_cancel()?;
            let st = supervisor.status();
            if st.status == "healthy" {
                break;
            }
            if st.status == "error" {
                return Err(AppError::msg(
                    st.error.unwrap_or_else(|| "le serveur n'a pas démarré".into()),
                ));
            }
            if std::time::Instant::now() >= deadline {
                return Err(AppError::msg("délai dépassé en attendant le serveur Hunyuan."));
            }
            self.phase(app, "start", 98, "Chargement du modèle sur le GPU…");
            std::thread::sleep(Duration::from_secs(3));
        }

        Ok(())
    }

    // --- pipeline steps ---------------------------------------------------

    /// NVIDIA GPU preflight via `nvidia-smi`. Blocks with a clear message when no
    /// NVIDIA GPU/driver is present (the wheels' CUDA runtime needs one).
    fn preflight(&self, _app: &AppHandle, log_path: &Path) -> AppResult<()> {
        let mut c = Command::new("nvidia-smi");
        c.arg("--query-gpu=name,driver_version")
            .arg("--format=csv,noheader");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            c.creation_flags(CREATE_NO_WINDOW);
        }
        let out = c.output();
        match out {
            Ok(o) if o.status.success() => {
                let info = String::from_utf8_lossy(&o.stdout);
                let line = info.lines().next().unwrap_or("").trim().to_string();
                self.log_line(log_path, &format!("GPU détecté: {line}"));
                Ok(())
            }
            _ => Err(AppError::msg(
                "Aucun GPU NVIDIA détecté (nvidia-smi introuvable). La génération 3D Hunyuan \
                 nécessite un GPU NVIDIA avec un driver récent. Installe/mets à jour le driver \
                 NVIDIA puis relance l'installation.",
            )),
        }
    }

    /// Pre-fetch model weights into the HF cache by running the venv's
    /// huggingface_hub. Output is tailed for progress.
    fn download_weights(
        &self,
        app: &AppHandle,
        venv_python: &Path,
        recipe: &Recipe,
        log_path: &Path,
    ) -> AppResult<()> {
        for w in recipe.weights {
            self.check_cancel()?;
            let patterns = if w.allow_patterns.is_empty() {
                "None".to_string()
            } else {
                let items: Vec<String> =
                    w.allow_patterns.iter().map(|p| format!("{p:?}")).collect();
                format!("[{}]", items.join(", "))
            };
            let code = format!(
                "from huggingface_hub import snapshot_download; \
                 snapshot_download(repo_id={:?}, allow_patterns={}, \
                 max_workers=4); print('OK {:?}')",
                w.repo_id, patterns, w.repo_id
            );
            let mut c = Command::new(venv_python);
            c.arg("-c").arg(code);
            // Speed up large downloads when hf_transfer is available; harmless if not.
            c.env("HF_HUB_DISABLE_TELEMETRY", "1");
            self.phase(
                app,
                "weights",
                80,
                &format!("Téléchargement des poids: {}…", w.repo_id),
            );
            self.run(app, c, log_path)?;
        }
        Ok(())
    }

    /// Write the backend paths into the config (the exact shape the supervisor
    /// reads), and make this backend the default. Reuses the deep-merge save.
    fn write_config(&self, recipe: &Recipe, install_dir: &Path, venv_python: &Path) -> AppResult<()> {
        let extra: Vec<Value> = recipe
            .extra_args
            .iter()
            .map(|s| Value::String(s.to_string()))
            .collect();
        let mut entry = json!({
            "dir": install_dir.to_string_lossy(),
            "python": venv_python.to_string_lossy(),
            "script": recipe.script,
            "host": recipe.host,
            "port": recipe.port,
            "model_path": recipe.model_path,
            "subfolder": recipe.subfolder,
            "extra_args": extra,
            // So the supervisor launches the server with the SAME centralised HF
            // cache the installer pre-filled (single folder for the whole stack).
            "hf_home": runtime_root().join("hf").to_string_lossy(),
        });
        if !recipe.texgen_model_path.is_empty() {
            entry["texgen_model_path"] = Value::String(recipe.texgen_model_path.to_string());
        }
        let over = json!({
            "default_backend": recipe.backend,
            "hunyuan": { recipe.backend: entry },
        });
        let current = self.config.load();
        let merged = config::deep_merge(&current, &over);
        self.config.save(&merged)?;
        Ok(())
    }

    // --- low-level helpers ------------------------------------------------

    /// Update phase/pct/message and emit a progress event.
    fn phase(&self, app: &AppHandle, phase: &str, pct: u8, message: &str) {
        let snapshot = {
            let mut g = self.inner.lock();
            g.phase = phase.to_string();
            g.pct = pct;
            g.message = message.to_string();
            InstallProgress {
                backend: g.backend.clone(),
                running: g.running,
                phase: g.phase.clone(),
                pct: g.pct,
                message: g.message.clone(),
                log_tail: tail_file(&g.log_path, 40),
                done: g.done,
                error: g.error.clone(),
            }
        };
        events::emit_install_progress(app, &snapshot);
    }

    /// Update pct + message (keeping the current phase) and emit. Used by the
    /// download loop, which must not re-lock `inner` while reading the phase.
    fn progress(&self, app: &AppHandle, pct: u8, message: &str) {
        let snapshot = {
            let mut g = self.inner.lock();
            g.pct = pct;
            g.message = message.to_string();
            InstallProgress {
                backend: g.backend.clone(),
                running: g.running,
                phase: g.phase.clone(),
                pct: g.pct,
                message: g.message.clone(),
                log_tail: tail_file(&g.log_path, 40),
                done: g.done,
                error: g.error.clone(),
            }
        };
        events::emit_install_progress(app, &snapshot);
    }

    /// Emit the current state without changing phase/pct (used while polling a
    /// running child so the log tail keeps flowing to the UI).
    fn emit_tick(&self, app: &AppHandle) {
        let snapshot = {
            let g = self.inner.lock();
            InstallProgress {
                backend: g.backend.clone(),
                running: g.running,
                phase: g.phase.clone(),
                pct: g.pct,
                message: g.message.clone(),
                log_tail: tail_file(&g.log_path, 40),
                done: g.done,
                error: g.error.clone(),
            }
        };
        events::emit_install_progress(app, &snapshot);
    }

    fn check_cancel(&self) -> AppResult<()> {
        if self.inner.lock().cancel {
            Err(AppError::msg("installation annulée."))
        } else {
            Ok(())
        }
    }

    fn log_line(&self, log_path: &Path, line: &str) {
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(log_path) {
            let _ = writeln!(f, "{line}");
        }
    }

    /// Spawn a command (stdout+stderr → install log), register it for
    /// cancellation, and poll until it exits — emitting the log tail as it runs.
    fn run(&self, app: &AppHandle, mut cmd: Command, log_path: &Path) -> AppResult<()> {
        self.check_cancel()?;
        // Centralise every download under the runtime root: uv-managed Python,
        // uv's wheel cache, and the HuggingFace weights cache.
        if let Some(root) = self.inner.lock().root.clone() {
            cmd.env("UV_PYTHON_INSTALL_DIR", root.join("python"));
            cmd.env("UV_CACHE_DIR", root.join("uv-cache"));
            cmd.env("HF_HOME", root.join("hf"));
            cmd.env("HF_HUB_DISABLE_TELEMETRY", "1");
        }
        let log = OpenOptions::new().create(true).append(true).open(log_path)?;
        let log_err = log.try_clone()?;
        cmd.stdout(Stdio::from(log)).stderr(Stdio::from(log_err));
        cmd.stdin(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let child = cmd
            .spawn()
            .map_err(|e| AppError::msg(format!("échec du lancement d'une étape: {e}")))?;
        {
            self.inner.lock().child = Some(child);
        }
        loop {
            // Cancellation: kill + unwind.
            {
                let mut g = self.inner.lock();
                if g.cancel {
                    if let Some(mut c) = g.child.take() {
                        let _ = c.kill();
                        let _ = c.wait();
                    }
                    return Err(AppError::msg("installation annulée."));
                }
                if let Some(c) = g.child.as_mut() {
                    match c.try_wait() {
                        Ok(Some(status)) => {
                            g.child = None;
                            if status.success() {
                                return Ok(());
                            }
                            let code = status
                                .code()
                                .map(|c| c.to_string())
                                .unwrap_or_else(|| "?".into());
                            return Err(AppError::msg(format!(
                                "une étape a échoué (code {code}) — voir le journal d'installation."
                            )));
                        }
                        Ok(None) => {}
                        Err(e) => {
                            g.child = None;
                            return Err(AppError::msg(format!("erreur process: {e}")));
                        }
                    }
                } else {
                    return Ok(());
                }
            }
            self.emit_tick(app);
            std::thread::sleep(Duration::from_millis(700));
        }
    }

    /// Stream a URL to `dest` with progress (pct mapped into `[lo, hi]`),
    /// honouring cancellation, then optionally verify sha256.
    fn download(
        &self,
        app: &AppHandle,
        url: &str,
        dest: &Path,
        sha256: &str,
        lo: u8,
        hi: u8,
    ) -> AppResult<()> {
        self.check_cancel()?;
        if url.trim().is_empty() {
            return Err(AppError::msg(
                "URL de téléchargement non configurée (voir la recette de l'installeur).",
            ));
        }
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(3600))
            .build()?;
        let mut resp = client
            .get(url)
            .send()
            .map_err(|e| AppError::msg(format!("téléchargement impossible ({url}): {e}")))?
            .error_for_status()
            .map_err(|e| AppError::msg(format!("téléchargement refusé ({url}): {e}")))?;
        let total = resp.content_length();
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut file = File::create(dest)?;
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; 1 << 16];
        let mut downloaded: u64 = 0;
        loop {
            self.check_cancel()?;
            let n = resp
                .read(&mut buf)
                .map_err(|e| AppError::msg(format!("erreur de lecture réseau: {e}")))?;
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n])?;
            if !sha256.is_empty() {
                hasher.update(&buf[..n]);
            }
            downloaded += n as u64;
            let pct = match total {
                Some(t) if t > 0 => {
                    let frac = (downloaded as f64 / t as f64).clamp(0.0, 1.0);
                    lo as f64 + frac * (hi.saturating_sub(lo) as f64)
                }
                _ => lo as f64,
            };
            self.progress(
                app,
                pct as u8,
                &format!("Téléchargé {}…", human_bytes(downloaded)),
            );
        }
        file.flush()?;
        drop(file);
        if !sha256.is_empty() {
            let got = hex::encode(hasher.finalize());
            if !got.eq_ignore_ascii_case(sha256) {
                let _ = std::fs::remove_file(dest);
                return Err(AppError::msg(format!(
                    "intégrité invalide pour {url} (sha256 attendu {sha256}, obtenu {got})."
                )));
            }
        }
        Ok(())
    }
}

// ===========================================================================
// free helpers
// ===========================================================================

/// Single centralised root for the whole 3D runtime (uv Python, uv cache, HF
/// weights cache, the venv + Hunyuan code). One folder to back up / delete.
/// - packaged: `%LOCALAPPDATA%\com.assetsgen.app\hunyuan` (local, non-roaming).
/// - dev: `<data_root>/hunyuan` (the repo, easy to find and clean).
fn runtime_root() -> PathBuf {
    if cfg!(debug_assertions) {
        config::data_root().join("hunyuan")
    } else {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .map(|p| p.join("com.assetsgen.app").join("hunyuan"))
            .unwrap_or_else(|| config::data_root().join("hunyuan"))
    }
}

/// Resolve `uv`: the bundled resource (packaged), the vendored copy (dev), or
/// `uv` on PATH as a last resort. Mirrors how the worker resolves its bundled exe.
fn uv_exe() -> PathBuf {
    let bundled = config::resource_root().join("uv").join("uv.exe");
    if bundled.is_file() {
        return bundled;
    }
    let vendored = config::repo_root().join("vendor").join("uv").join("uv.exe");
    if vendored.is_file() {
        return vendored;
    }
    PathBuf::from("uv")
}

fn marker(dir: &Path, name: &str) -> PathBuf {
    dir.join(format!("{name}.done"))
}
fn is_done(dir: &Path, name: &str) -> bool {
    marker(dir, name).is_file()
}
fn mark_done(dir: &Path, name: &str) -> AppResult<()> {
    std::fs::write(marker(dir, name), b"")?;
    Ok(())
}

/// Tail of a log file, last `lines` lines. Mirrors `Supervisor::tail`.
fn tail_file(log_path: &Option<PathBuf>, lines: usize) -> String {
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

fn human_bytes(n: u64) -> String {
    const U: [&str; 5] = ["o", "Ko", "Mo", "Go", "To"];
    let mut v = n as f64;
    let mut i = 0;
    while v >= 1024.0 && i < U.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{n} o")
    } else {
        format!("{v:.1} {}", U[i])
    }
}

/// Extract a GitHub zipball into `dest`, stripping the single top-level folder
/// (e.g. `Hunyuan3D-2-<sha>/`) so the repo lands directly under `dest`.
fn extract_zip_strip_top(zip_path: &Path, dest: &Path) -> AppResult<()> {
    let file = File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| AppError::msg(format!("archive illisible: {e}")))?;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| AppError::msg(format!("entrée d'archive illisible: {e}")))?;
        let enclosed = match entry.enclosed_name() {
            Some(p) => p,
            None => continue, // skip unsafe paths
        };
        // Strip the first path component (the archive's top folder).
        let mut comps = enclosed.components();
        comps.next();
        let rel: PathBuf = comps.as_path().to_path_buf();
        if rel.as_os_str().is_empty() {
            continue;
        }
        let out_path = dest.join(&rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&out_path)?;
        } else {
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let mut out = File::create(&out_path)?;
            std::io::copy(&mut entry, &mut out)?;
        }
    }
    Ok(())
}
