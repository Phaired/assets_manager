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
    /// pip constraints applied to the (unpinned) repo `requirements.txt`. The
    /// Hunyuan repos pin NOTHING, so without these uv resolves the LATEST of
    /// transformers/diffusers/numpy/etc — which require a newer torch than our
    /// pinned build (e.g. transformers 5.x dereferences `torch.float8_e8m0fnu`,
    /// added only in torch 2.7, and crashes on import against torch 2.5.1).
    /// These keep the dependency resolution compatible with the pinned tuple.
    constraints: &'static [&'static str],

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
    // Pinned to the canonical Hunyuan3D-2 set that is ABI/API-compatible with
    // torch 2.5.1 + cu124. Bump only together with `torch_packages` (and rebuild
    // the ext_wheels). numpy<2 also matches the prebuilt extension wheels' ABI.
    constraints: &[
        "transformers==4.46.2",
        "tokenizers==0.20.3",
        // transformers 4.46 hard-requires huggingface_hub<1.0; this is the lever
        // that also caps gradio (see below). 0.36.2 is the newest <1.0 release.
        "huggingface_hub==0.36.2",
        "diffusers==0.30.0",
        "numpy==1.26.4",
        // gradio is used purely as an API server here (worker calls /generation_all
        // via gradio_client; supervisor probes /gradio_api/info) — the web UI is
        // never shown. So pick by API compatibility, not UI: gradio 6 requires
        // huggingface_hub>=1.0, which conflicts with transformers above, so gradio
        // 5.x is the ceiling. 5.50.0 is the newest gradio 5; it exposes the
        // /gradio_api/ routes the supervisor + the worker's gradio_client expect
        // (gradio 4 lacks that prefix → 404 on the health probe).
        "gradio==5.50.0",
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

    /// Optional add-on: download the native text-to-image model (HunyuanDiT) into
    /// the centralised HF cache and flip `hunyuan.mv2.text3d_enabled`, so the mv2
    /// server launches with `--enable_t23d` (native offline text-to-3D). The mv2
    /// backend must already be installed (we reuse its venv python). Background
    /// thread, same progress/cancel plumbing as `start`.
    pub fn install_text3d(
        self: &Arc<Self>,
        app: AppHandle,
        supervisor: Arc<Supervisor>,
    ) -> AppResult<InstallProgress> {
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
            g.backend = Some("text3d".to_string());
            g.phase = "weights".into();
            g.pct = 0;
            g.message = "Préparation du text-to-3D…".into();
            g.child = None;
            g.log_path = None;
        }
        let me = Arc::clone(self);
        std::thread::spawn(move || {
            let result = me.run_text3d(&app, &supervisor);
            let mut g = me.inner.lock();
            g.running = false;
            g.child = None;
            match result {
                Ok(()) => {
                    g.done = true;
                    g.phase = "done".into();
                    g.pct = 100;
                    g.message = "Text-to-3D activé — relance une génération.".into();
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

    fn run_text3d(self: &Arc<Self>, app: &AppHandle, supervisor: &Arc<Supervisor>) -> AppResult<()> {
        // The download must land in the SAME centralised HF cache the mv2 server
        // reads from (run() sets HF_HOME from inner.root).
        let root = runtime_root();
        std::fs::create_dir_all(&root)?;
        self.inner.lock().root = Some(root.clone());
        let log_path = config::logs_dir()?.join("install_text3d.log");
        self.inner.lock().log_path = Some(log_path.clone());

        // Reuse the mv2 backend's venv python (it has huggingface_hub installed).
        let cfg = self.config.load();
        let python = cfg
            .get("hunyuan")
            .and_then(|h| h.get("mv2"))
            .and_then(|m| m.get("python"))
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        if python.trim().is_empty() || !PathBuf::from(&python).is_file() {
            return Err(AppError::msg(
                "Installe d'abord le backend 3D (mv2) avant d'activer le text-to-3D.",
            ));
        }

        // HunyuanDiT's T5 text encoder needs sentencepiece (+ protobuf); neither
        // is in the base Hunyuan requirements, so the server would crash on launch
        // with --enable_t23d ("T5Tokenizer requires the SentencePiece library").
        self.phase(app, "deps", 4, "Installation des dépendances text-to-3D…");
        let uv = uv_exe();
        let mut c = Command::new(&uv);
        c.arg("pip")
            .arg("install")
            .arg("--python")
            .arg(&python)
            .arg("sentencepiece")
            .arg("protobuf");
        self.run(app, c, &log_path)?;

        self.phase(
            app,
            "weights",
            10,
            "Téléchargement du modèle text-to-image (HunyuanDiT, ~8 Go)…",
        );
        let code = "from huggingface_hub import snapshot_download; \
             snapshot_download(repo_id='Tencent-Hunyuan/HunyuanDiT-v1.1-Diffusers-Distilled', \
             max_workers=4); print('OK text2image')";
        let mut c = Command::new(&python);
        c.arg("-c").arg(code);
        self.run(app, c, &log_path)?;

        // Flip the opt-in flag so the supervisor adds --enable_t23d on next launch.
        self.phase(app, "config", 92, "Activation du text-to-3D…");
        let over = json!({ "hunyuan": { "mv2": { "text3d_enabled": true } } });
        let merged = config::deep_merge(&self.config.load(), &over);
        self.config.save(&merged)?;

        // Patch the multiview gradio so a caption with no views synthesizes one
        // front view via HunyuanDiT — without this the MV model rejects caption-
        // only requests ("Please provide at least one view image").
        if let Some(dir) = cfg
            .get("hunyuan")
            .and_then(|h| h.get("mv2"))
            .and_then(|m| m.get("dir"))
            .and_then(|x| x.as_str())
            .filter(|s| !s.is_empty())
        {
            // Refresh the bundled overlay first (no-op for custom dirs), then the
            // idempotent string patches as fallback. The t2i VRAM-offload patch
            // matters most right here: without it the freshly enabled
            // --enable_t23d keeps HunyuanDiT resident in VRAM and slows EVERY
            // image→3D generation ~3x (paging on 16 GB cards).
            if let Err(e) = apply_overlay("mv2", &PathBuf::from(dir)) {
                self.log_line(&log_path, &format!("overlay Python ignoré: {e}"));
            }
            let gradio = PathBuf::from(dir).join("gradio_app.py");
            if let Err(e) = patch_gradio_t23d(&gradio) {
                self.log_line(&log_path, &format!("patch gradio t23d ignoré: {e}"));
            }
            if let Err(e) = patch_mv2_perf(&PathBuf::from(dir)) {
                self.log_line(&log_path, &format!("patchs perf mv2 ignorés: {e}"));
            }
        }

        // Stop the mv2 server (if running) so the next generation relaunches it
        // WITH --enable_t23d — start() would otherwise reuse the healthy old one.
        self.phase(app, "start", 95, "Application du flag (redémarrage requis)…");
        supervisor.stop();
        Ok(())
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
        // Bundled overlay + performance patches — outside the marker guard and
        // idempotent, so a resumed or repaired install (re)applies them too. The
        // overlay copies the exact pre-patched scripts shipped with the app; the
        // string patches stay as fallback when an overlay file is absent.
        if backend == "mv2" {
            match apply_overlay(backend, &install_dir) {
                Ok(n) if n > 0 => {
                    self.log_line(&log_path, &format!("overlay Python appliqué ({n} fichiers)"));
                }
                Ok(_) => {}
                Err(e) => self.log_line(&log_path, &format!("overlay Python ignoré: {e}")),
            }
            if let Err(e) = patch_mv2_perf(&install_dir) {
                self.log_line(&log_path, &format!("patchs perf mv2 ignorés: {e}"));
            }
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
            // Write the version pins as a pip constraints file, applied to BOTH
            // installs below so the repo's unpinned requirements can't pull a
            // transformers/numpy/etc that is incompatible with the pinned torch.
            let constraints_path = install_dir.join("_constraints.txt");
            std::fs::write(&constraints_path, recipe.constraints.join("\n"))?;

            let req = install_dir.join("requirements.txt");
            if req.is_file() {
                let mut c = Command::new(&uv);
                c.arg("pip")
                    .arg("install")
                    .arg("--python")
                    .arg(&venv_python)
                    .arg("--constraint")
                    .arg(&constraints_path)
                    .arg("-r")
                    .arg(&req);
                self.run(app, c, &log_path)?;
            } else {
                self.log_line(&log_path, "requirements.txt absent du repo — étape deps ignorée.");
            }
            // huggingface_hub is needed for the weights pre-fetch (and usually a
            // transitive dep already; install explicitly to be safe). Same
            // constraints so it can't drift to an incompatible 1.x.
            let mut c = Command::new(&uv);
            c.arg("pip")
                .arg("install")
                .arg("--python")
                .arg(&venv_python)
                .arg("--constraint")
                .arg(&constraints_path)
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
                    // Keep the real wheel filename from the URL — pip/uv reject a
                    // name that isn't `{name}-{version}-…whl`.
                    let fname = w
                        .url
                        .rsplit('/')
                        .next()
                        .filter(|s| s.ends_with(".whl"))
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| format!("ext_{i}.whl"));
                    let dest = install_dir.join(&fname);
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

/// Best-effort, idempotent patch of the Hunyuan3D-2mv gradio so a text caption
/// with no view images synthesizes a single front view via HunyuanDiT (text-to-3D).
/// The multiview model otherwise rejects caption-only requests. Silently no-ops if
/// already patched or if the upstream block moved.
fn patch_gradio_t23d(gradio: &Path) -> std::io::Result<()> {
    let mut src = std::fs::read_to_string(gradio)?;

    // --- Patch 1: caption (no views) -> single front view via HunyuanDiT -------
    const NEEDLE: &str = r#"    if MV_MODE:
        if mv_image_front is None and mv_image_back is None and mv_image_left is None and mv_image_right is None:
            raise gr.Error("Please provide at least one view image.")
        image = {}
        if mv_image_front:
            image['front'] = mv_image_front
        if mv_image_back:
            image['back'] = mv_image_back
        if mv_image_left:
            image['left'] = mv_image_left
        if mv_image_right:
            image['right'] = mv_image_right"#;
    const REPLACEMENT: &str = r#"    if MV_MODE:
        if mv_image_front is None and mv_image_back is None and mv_image_left is None and mv_image_right is None:
            # assets_gen patch: native offline text-to-3D. The multiview model
            # normally requires view images, but if a caption is given with no
            # views, synthesize a single front view with HunyuanDiT (--enable_t23d)
            # and feed it as the only view. Additive — does not affect the normal
            # multiview path.
            if caption and ('t2i_worker' in globals()) and (t2i_worker is not None):
                image = {'front': t2i_worker(caption)}
            else:
                raise gr.Error("Please provide at least one view image.")
        else:
            image = {}
            if mv_image_front:
                image['front'] = mv_image_front
            if mv_image_back:
                image['back'] = mv_image_back
            if mv_image_left:
                image['left'] = mv_image_left
            if mv_image_right:
                image['right'] = mv_image_right"#;
    if !src.contains("assets_gen patch: native offline text-to-3D") && src.contains(NEEDLE) {
        src = src.replacen(NEEDLE, REPLACEMENT, 1);
        std::fs::write(gradio, &src)?;
    }

    // --- Patch 2: persist the rembg'd reference (main_image) to a fixed path ----
    // The reference image (t2i image for text, front view otherwise) is never
    // returned to the gradio_client, so we save it to a stable file in the backend
    // dir. Generation is serial (single GPU), so a fixed path is race-free; Rust
    // copies it to the asset's ref.png right after the gen. Enables the standalone
    // paint pass (texture later without HunyuanDiT in VRAM).
    const REF_NEEDLE: &str = "    main_image = image if not MV_MODE else image['front']";
    const REF_REPLACEMENT: &str = r#"    main_image = image if not MV_MODE else image['front']
    try:
        # assets_gen patch: persist the rembg'd reference for the later paint pass.
        main_image.save(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'assets_gen_last_ref.png'))
    except Exception:
        pass"#;
    if !src.contains("assets_gen_last_ref.png") && src.contains(REF_NEEDLE) {
        src = src.replacen(REF_NEEDLE, REF_REPLACEMENT, 1);
        std::fs::write(gradio, &src)?;
    }
    Ok(())
}

/// Copy the bundled, pre-patched Python overlay
/// (`<resource_root>/hunyuan_overlay/<backend>/**`) over the installed backend,
/// so the scripts are exactly the ones this app version ships — applied at
/// install AND at every server start (an app update refreshes them without a
/// backend reinstall). The overlay files are derived from the SAME pinned
/// zipball revision as `Recipe::repo_zip_url`; regenerate them if the pin moves
/// (see hunyuan_overlay/README.md). Returns the number of files copied.
///
/// Guard: only applies when `dir` lives under `runtime_root()` (an
/// app-managed install) — a custom `hunyuan.<backend>.dir` (e.g. a dev clone)
/// is never overwritten. The string patches below stay as idempotent fallback
/// for those custom dirs.
pub fn apply_overlay(backend: &str, dir: &Path) -> std::io::Result<usize> {
    let src_root = config::resource_root().join("hunyuan_overlay").join(backend);
    if !src_root.is_dir() || !dir.starts_with(runtime_root()) {
        return Ok(0);
    }
    fn walk(src: &Path, dst: &Path, copied: &mut usize) -> std::io::Result<()> {
        for entry in std::fs::read_dir(src)? {
            let entry = entry?;
            let s = entry.path();
            let d = dst.join(entry.file_name());
            if s.is_dir() {
                std::fs::create_dir_all(&d)?;
                walk(&s, &d, copied)?;
            } else {
                std::fs::copy(&s, &d)?;
                *copied += 1;
            }
        }
        Ok(())
    }
    let mut copied = 0;
    walk(&src_root, dir, &mut copied)?;
    Ok(copied)
}

/// Best-effort, idempotent performance patches for the Hunyuan3D-2mv backend.
/// Quality-verified on the dev rig (RTX 4070 Ti SUPER, 16 GB): together with the
/// fast gen3d defaults (20 steps / octree 192) they bring a multiview generation
/// from minutes back to ~30-40 s. Each patch silently no-ops if already applied
/// or if the upstream block moved.
fn patch_mv2_perf(dir: &Path) -> std::io::Result<()> {
    // --- 1. gradio_app.py: reduce faces BEFORE texturing. The texture bake is
    // CPU-bound and scales with face count; baking the low-poly target mesh is
    // ~2x faster than the upstream 40k default and gives cleaner UVs. ----------
    let gradio = dir.join("gradio_app.py");
    if gradio.is_file() {
        let mut src = std::fs::read_to_string(&gradio)?;
        const NEEDLE: &str = "    mesh = face_reduce_worker(mesh)";
        const REPLACEMENT: &str = r#"    # assets_gen patch: reduce to the target face count BEFORE texturing (not
    # the default 40k). Faster CPU bake, cleaner UVs. HY_FACE_NUM overrides.
    _face_num = int(os.environ.get("HY_FACE_NUM", "8000"))
    mesh = face_reduce_worker(mesh, max_facenum=_face_num)"#;
        if !src.contains("HY_FACE_NUM") && src.contains(NEEDLE) {
            src = src.replacen(NEEDLE, REPLACEMENT, 1);
            std::fs::write(&gradio, &src)?;
        }
    }

    // --- 2. texgen pipelines.py: 1024 render/texture instead of 2048. The bake
    // runs on CPU (Windows TDR workaround) so its cost scales with these sizes;
    // 1024 is ample for low-poly game assets and saves ~5 s per generation. ----
    let pipelines = dir.join("hy3dgen").join("texgen").join("pipelines.py");
    if pipelines.is_file() {
        let mut src = std::fs::read_to_string(&pipelines)?;
        const NEEDLE: &str = "        self.render_size = 2048\n        self.texture_size = 2048";
        const REPLACEMENT: &str = r#"        # assets_gen patch: 1024 instead of 2048 (CPU bake cost scales with
        # these). Env-overridable to restore 2048 when higher-res is needed.
        self.render_size = int(os.environ.get("HY_RENDER_SIZE", "1024"))
        self.texture_size = int(os.environ.get("HY_TEXTURE_SIZE", "1024"))"#;
        if !src.contains("HY_RENDER_SIZE") && src.contains(NEEDLE) {
            src = src.replacen(NEEDLE, REPLACEMENT, 1);
            std::fs::write(&pipelines, &src)?;
        }
    }

    // --- 3. text2image.py: keep the HunyuanDiT t2i pipeline OUT of VRAM until it
    // actually runs. Upstream does a permanent `.to(cuda)`, which leaves several
    // GB resident once --enable_t23d is on and starves the mv2 shape diffusion
    // (~0.9 s/step -> 2-3.5 s/step measured on 16 GB). --------------------------
    let text2image = dir.join("hy3dgen").join("text2image.py");
    if text2image.is_file() {
        let mut src = std::fs::read_to_string(&text2image)?;
        const NEEDLE: &str = r#"            pag_applied_layers=["blocks.(16|17|18|19)"]
        ).to(device)"#;
        const REPLACEMENT: &str = r#"            pag_applied_layers=["blocks.(16|17|18|19)"]
        )
        # assets_gen patch: keep the t2i pipeline OUT of VRAM until it actually
        # runs. A permanent `.to(cuda)` left HunyuanDiT (+mT5) resident and
        # starved the mv2 shape diffusion (0.9 s/step -> 2-3.5 s/step on 16 GB).
        # Offload moves each submodule to the GPU only during its forward pass.
        if str(device).startswith('cuda'):
            self.pipe.enable_model_cpu_offload()
        else:
            self.pipe = self.pipe.to(device)"#;
        if !src.contains("enable_model_cpu_offload") && src.contains(NEEDLE) {
            src = src.replacen(NEEDLE, REPLACEMENT, 1);
            std::fs::write(&text2image, &src)?;
        }
    }

    Ok(())
}

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
