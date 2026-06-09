//! Background job worker: runs pipeline stages for an asset.
//!
//! Port of `app/jobs.py`. A single worker thread (serial GPU) consumes a channel.
//! Each job = (project, asset_id, [stages]). State is persisted to state.json on
//! every transition and `project-changed` / `job-changed` events are emitted.

use std::collections::VecDeque;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::config::Config;
use crate::error::{AppError, AppResult};
use crate::events;
use crate::store::Store;
use crate::supervisor::Supervisor;
use crate::types::{Gen3d, JobCurrent, JobSnapshot};
use crate::worker::{self, WorkerClient};

#[derive(Clone)]
struct Job {
    id: u64,
    project: String,
    asset_id: String,
    stages: Vec<String>,
}

struct State {
    current: Option<JobCurrent>,
    counter: u64,
    /// Mirror of the queue size for snapshots (the real items live in the mpsc
    /// channel; we track a parallel deque length).
    pending: VecDeque<u64>,
}

pub struct JobManager {
    tx: Sender<Job>,
    state: Arc<Mutex<State>>,
    app: Arc<Mutex<Option<AppHandle>>>,
}

impl JobManager {
    pub fn new(
        store: Arc<Store>,
        config: Arc<Config>,
        supervisor: Arc<Supervisor>,
        worker: Arc<WorkerClient>,
    ) -> Arc<Self> {
        let (tx, rx): (Sender<Job>, Receiver<Job>) = mpsc::channel();
        let state = Arc::new(Mutex::new(State {
            current: None,
            counter: 0,
            pending: VecDeque::new(),
        }));
        let app: Arc<Mutex<Option<AppHandle>>> = Arc::new(Mutex::new(None));

        let manager = Arc::new(JobManager {
            tx,
            state: Arc::clone(&state),
            app: Arc::clone(&app),
        });

        // Worker thread.
        let runner = Runner {
            store,
            config,
            supervisor,
            worker,
            state: Arc::clone(&state),
            app: Arc::clone(&app),
        };
        std::thread::spawn(move || runner.run(rx));

        manager
    }

    /// Wire up the AppHandle once the Tauri app is built (for event emission).
    pub fn set_app(&self, app: AppHandle) {
        *self.app.lock() = Some(app);
    }

    fn emit_job(&self) {
        if let Some(app) = self.app.lock().as_ref() {
            events::emit_job_changed(app, &self.snapshot());
        }
    }

    fn emit_project(&self, project: &str) {
        if let Some(app) = self.app.lock().as_ref() {
            events::emit_project_changed(app, project);
        }
    }

    /// Enqueue a job; mark requested stages as `queued` immediately for instant
    /// UI feedback. Returns the just-enqueued job as a `JobCurrent` with state
    /// `"queued"` — this mirrors the original Python `jobs.enqueue`, which returns
    /// the new job dict (not `snapshot()["current"]`).
    pub fn enqueue(
        &self,
        store: &Store,
        project: &str,
        asset_id: &str,
        stages: Vec<String>,
    ) -> AppResult<Option<JobCurrent>> {
        let job = {
            let mut st = self.state.lock();
            st.counter += 1;
            let id = st.counter;
            st.pending.push_back(id);
            Job {
                id,
                project: project.to_string(),
                asset_id: asset_id.to_string(),
                stages: stages.clone(),
            }
        };
        // mark queued
        for stage in &stages {
            store.update_stage(project, asset_id, stage, "queued", None, None)?;
        }
        self.emit_project(project);

        // The JobCurrent we report back for this enqueue (state "queued").
        let reported = JobCurrent {
            id: job.id,
            project: job.project.clone(),
            asset_id: job.asset_id.clone(),
            stages: job.stages.clone(),
            state: "queued".to_string(),
        };

        self.tx
            .send(job)
            .map_err(|e| AppError::msg(format!("file de jobs fermee: {e}")))?;
        self.emit_job();

        // Mirror Python `jobs.enqueue`: return the just-enqueued job (state
        // "queued"), regardless of what is currently running.
        Ok(Some(reported))
    }

    pub fn snapshot(&self) -> JobSnapshot {
        let st = self.state.lock();
        JobSnapshot {
            current: st.current.clone(),
            // queue_size = pending minus the one currently running.
            queue_size: st
                .pending
                .len()
                .saturating_sub(if st.current.is_some() { 1 } else { 0 }),
        }
    }
}

/// The worker-thread side: owns the shared managers and runs stages.
struct Runner {
    store: Arc<Store>,
    config: Arc<Config>,
    supervisor: Arc<Supervisor>,
    worker: Arc<WorkerClient>,
    state: Arc<Mutex<State>>,
    app: Arc<Mutex<Option<AppHandle>>>,
}

impl Runner {
    fn emit_job(&self) {
        if let Some(app) = self.app.lock().as_ref() {
            let snap = {
                let st = self.state.lock();
                JobSnapshot {
                    current: st.current.clone(),
                    queue_size: st
                        .pending
                        .len()
                        .saturating_sub(if st.current.is_some() { 1 } else { 0 }),
                }
            };
            events::emit_job_changed(app, &snap);
        }
    }

    fn emit_project(&self, project: &str) {
        if let Some(app) = self.app.lock().as_ref() {
            events::emit_project_changed(app, project);
        }
    }

    fn run(self, rx: Receiver<Job>) {
        while let Ok(job) = rx.recv() {
            {
                let mut st = self.state.lock();
                st.current = Some(JobCurrent {
                    id: job.id,
                    project: job.project.clone(),
                    asset_id: job.asset_id.clone(),
                    stages: job.stages.clone(),
                    state: "running".to_string(),
                });
            }
            self.emit_job();

            self.run_job(&job);

            {
                let mut st = self.state.lock();
                st.current = None;
                // remove this job id from the pending mirror
                if let Some(pos) = st.pending.iter().position(|&x| x == job.id) {
                    st.pending.remove(pos);
                }
            }
            self.emit_job();
        }
    }

    fn run_job(&self, job: &Job) {
        for stage in &job.stages {
            match self.run_stage(&job.project, &job.asset_id, stage) {
                Ok(()) => {}
                Err(e) => {
                    let _ = self.store.update_stage(
                        &job.project,
                        &job.asset_id,
                        stage,
                        "error",
                        Some(&e.to_string()),
                        None,
                    );
                    self.emit_project(&job.project);
                    // A failed stage blocks the remaining ones (they depend on it).
                    break;
                }
            }
        }
    }

    fn run_stage(&self, project: &str, asset_id: &str, stage: &str) -> AppResult<()> {
        let cfg = self.config.load();
        let asset = self.store.get_asset(project, asset_id)?;
        self.store
            .update_stage(project, asset_id, stage, "running", None, None)?;
        self.emit_project(project);

        let result = match stage {
            "multiview" => self.stage_multiview(&cfg, project, &asset),
            "model3d" => self.stage_model3d(&cfg, project, &asset),
            "export" => self.stage_export(project, asset_id),
            other => Err(AppError::msg(format!("etape inconnue: {other}"))),
        };
        if result.is_ok() {
            self.emit_project(project);
        }
        result
    }

    // --- stages ----------------------------------------------------------

    fn stage_multiview(&self, cfg: &Value, project: &str, asset: &Value) -> AppResult<()> {
        let asset_id = asset.get("id").and_then(|x| x.as_str()).unwrap_or("");
        let source = asset.get("source").and_then(|x| x.as_str()).unwrap_or("");
        let source_path = self.store.source_image_path(project, asset_id)?;

        if source == "manual" && source_path.is_file() {
            self.store.update_stage(
                project,
                asset_id,
                "multiview",
                "done",
                None,
                Some(json!({"source": "manual"})),
            )?;
            return Ok(());
        }

        let api_key = crate::config::openai_key(cfg);
        if api_key.is_empty() {
            return Err(AppError::msg("OPENAI_API_KEY absent (Reglages ou .env)"));
        }

        // Budget gate (in Rust, before calling the worker).
        let state = self.store.load_state(project)?;
        let current_spend = state
            .get("estimated_spend_usd")
            .and_then(|x| x.as_f64())
            .unwrap_or(0.0);
        let est_cost = cfg
            .get("estimated_cost_per_image")
            .and_then(|x| x.as_f64())
            .unwrap_or(0.063);
        let budget = cfg.get("budget_usd").and_then(|x| x.as_f64()).unwrap_or(5.0);
        let projected = current_spend + est_cost;
        if projected > budget + 1e-9 {
            return Err(AppError::msg(format!(
                "budget atteint: projete ${projected:.3} > ${budget:.2}"
            )));
        }

        let name = asset.get("name").and_then(|x| x.as_str()).unwrap_or("");
        let description = asset.get("description").and_then(|x| x.as_str()).unwrap_or("");
        let model = cfg.get("openai_model").and_then(|x| x.as_str()).unwrap_or("");
        let quality = cfg
            .get("openai_quality")
            .and_then(|x| x.as_str())
            .unwrap_or("medium");
        let timeout = cfg.get("openai_timeout").and_then(|x| x.as_i64()).unwrap_or(300);
        let output_dir = self.store.multiview_dir(project, asset_id)?;

        let meta = self.worker.multiview(
            name,
            description,
            &output_dir.to_string_lossy(),
            &api_key,
            model,
            quality,
            timeout,
            est_cost,
        )?;

        let cost = meta.get("cost").and_then(|x| x.as_f64()).unwrap_or(est_cost);
        let spent = self.store.add_spend(project, cost)?;

        let mut meta_obj = meta.as_object().cloned().unwrap_or_default();
        meta_obj.insert("estimated_spend_usd".into(), json!(spent));

        self.store.update_stage(
            project,
            asset_id,
            "multiview",
            "done",
            None,
            Some(Value::Object(meta_obj)),
        )?;
        Ok(())
    }

    fn stage_model3d(&self, cfg: &Value, project: &str, asset: &Value) -> AppResult<()> {
        let asset_id = asset.get("id").and_then(|x| x.as_str()).unwrap_or("");
        let asset_backend = asset.get("backend").and_then(|x| x.as_str()).unwrap_or("auto");
        let backend = self.supervisor.resolve_backend(asset_backend);
        let seed = worker::seed_from_id(asset_id);
        let gen3d_cfg = cfg.get("gen3d").cloned().unwrap_or(Value::Null);
        let gen3d = Gen3d::from_config(&gen3d_cfg);
        let dest = self.store.model_path(project, asset_id)?;
        let base_url = self.supervisor.ensure(&backend, 900)?;

        let (image_path, view_dir) = if backend == "v21" {
            // single image: manual source if present, else multiview/front.png
            let source = self.store.source_image_path(project, asset_id)?;
            let chosen = if source.is_file() {
                source
            } else {
                self.store.multiview_dir(project, asset_id)?.join("front.png")
            };
            if !chosen.is_file() {
                return Err(AppError::msg(
                    "aucune image d'entree (multivue ou source) pour le backend v21",
                ));
            }
            (Some(chosen.to_string_lossy().to_string()), None)
        } else {
            // mv2: require all 4 view files
            let missing = self.store.missing_views(project, asset_id)?;
            if !missing.is_empty() {
                return Err(AppError::msg(format!(
                    "vues multivue manquantes pour mv2: {missing:?}"
                )));
            }
            let view_dir = self.store.multiview_dir(project, asset_id)?;
            (None, Some(view_dir.to_string_lossy().to_string()))
        };

        let meta = self.worker.gen3d(
            &backend,
            &base_url,
            seed,
            &gen3d,
            &dest.to_string_lossy(),
            image_path.as_deref(),
            view_dir.as_deref(),
        )?;

        // Augment meta with backend/seed/output (worker also returns some of these;
        // we ensure they are present to match the Python contract).
        let mut meta_obj = meta.as_object().cloned().unwrap_or_default();
        meta_obj
            .entry("backend".to_string())
            .or_insert_with(|| json!(backend));
        meta_obj
            .entry("seed".to_string())
            .or_insert_with(|| json!(seed));
        meta_obj.insert("output".into(), json!(dest.to_string_lossy()));

        self.store.update_stage(
            project,
            asset_id,
            "model3d",
            "done",
            None,
            Some(Value::Object(meta_obj)),
        )?;
        Ok(())
    }

    fn stage_export(&self, project: &str, asset_id: &str) -> AppResult<()> {
        let glb = self.store.model_path(project, asset_id)?;
        if !glb.is_file() {
            return Err(AppError::msg(
                "model.glb absent : lancer l'etape 3D d'abord",
            ));
        }
        let dest = self.store.obj_path(project, asset_id)?;
        let meta = self
            .worker
            .export(&glb.to_string_lossy(), &dest.to_string_lossy())?;

        let faces = meta.get("faces").cloned().unwrap_or(Value::Null);
        let textured = meta
            .get("textured")
            .and_then(|x| x.as_bool())
            .unwrap_or(false);

        self.store.update_stage(
            project,
            asset_id,
            "export",
            "done",
            None,
            Some(json!({
                "faces": faces,
                "textured": textured,
                "output": dest.to_string_lossy(),
            })),
        )?;
        Ok(())
    }
}
