//! Lightweight audio job executor — INDEPENDENT of the GPU job queue (`jobs.rs`).
//!
//! Audio generation is just fast HTTP to ElevenLabs, so it must never wait behind
//! a multi-minute 3D job. A single serial worker thread consumes `(project,
//! item_id)` requests, calls the `ElevenLabs` client per item kind, writes the
//! status + generated file into `audio.json`, and emits `project-changed` so the
//! UI refetches via TanStack Query.

use std::collections::VecDeque;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::Value;
use tauri::AppHandle;

use crate::config::Config;
use crate::elevenlabs::ElevenLabs;
use crate::error::{AppError, AppResult};
use crate::events;
use crate::store::Store;
use crate::types::{AudioJobCurrent, AudioJobSnapshot};

struct AudioJob {
    project: String,
    item_id: String,
}

struct State {
    current: Option<AudioJobCurrent>,
    /// Items enqueued and not yet finished (includes the running one).
    pending: VecDeque<()>,
}

pub struct AudioJobManager {
    tx: Sender<AudioJob>,
    state: Arc<Mutex<State>>,
    app: Arc<Mutex<Option<AppHandle>>>,
}

impl AudioJobManager {
    pub fn new(store: Arc<Store>, config: Arc<Config>, eleven: Arc<ElevenLabs>) -> Arc<Self> {
        let (tx, rx): (Sender<AudioJob>, Receiver<AudioJob>) = mpsc::channel();
        let state = Arc::new(Mutex::new(State {
            current: None,
            pending: VecDeque::new(),
        }));
        let app: Arc<Mutex<Option<AppHandle>>> = Arc::new(Mutex::new(None));

        let manager = Arc::new(AudioJobManager {
            tx,
            state: Arc::clone(&state),
            app: Arc::clone(&app),
        });

        let runner = Runner {
            store,
            config,
            eleven,
            state: Arc::clone(&state),
            app: Arc::clone(&app),
        };
        std::thread::spawn(move || runner.run(rx));

        manager
    }

    pub fn set_app(&self, app: AppHandle) {
        *self.app.lock() = Some(app);
    }

    /// Enqueue an item. The caller has already marked it `queued` in the store and
    /// emitted `project-changed`.
    pub fn enqueue(&self, project: &str, item_id: &str) -> AppResult<()> {
        {
            let mut st = self.state.lock();
            st.pending.push_back(());
        }
        self.tx
            .send(AudioJob {
                project: project.to_string(),
                item_id: item_id.to_string(),
            })
            .map_err(|e| AppError::msg(format!("file audio fermée: {e}")))
    }

    pub fn snapshot(&self) -> AudioJobSnapshot {
        let st = self.state.lock();
        AudioJobSnapshot {
            current: st.current.clone(),
            queue_size: st
                .pending
                .len()
                .saturating_sub(if st.current.is_some() { 1 } else { 0 }),
        }
    }
}

struct Runner {
    store: Arc<Store>,
    config: Arc<Config>,
    eleven: Arc<ElevenLabs>,
    state: Arc<Mutex<State>>,
    app: Arc<Mutex<Option<AppHandle>>>,
}

impl Runner {
    fn emit_project(&self, project: &str) {
        if let Some(app) = self.app.lock().as_ref() {
            events::emit_project_changed(app, project);
        }
    }

    fn run(self, rx: Receiver<AudioJob>) {
        while let Ok(job) = rx.recv() {
            {
                let mut st = self.state.lock();
                st.current = Some(AudioJobCurrent {
                    project: job.project.clone(),
                    item_id: job.item_id.clone(),
                });
            }
            let _ = self
                .store
                .update_audio_status(&job.project, &job.item_id, "running", None, None);
            self.emit_project(&job.project);

            match self.run_one(&job) {
                Ok(rel) => {
                    let _ = self.store.update_audio_status(
                        &job.project,
                        &job.item_id,
                        "done",
                        None,
                        Some(&rel),
                    );
                }
                Err(e) => {
                    let _ = self.store.update_audio_status(
                        &job.project,
                        &job.item_id,
                        "error",
                        Some(&e.to_string()),
                        None,
                    );
                }
            }

            {
                let mut st = self.state.lock();
                st.current = None;
                st.pending.pop_front();
            }
            self.emit_project(&job.project);
        }
    }

    /// Generate one item; returns the project-relative mp3 path on success.
    fn run_one(&self, job: &AudioJob) -> AppResult<String> {
        let cfg = self.config.load();
        let api_key = crate::config::elevenlabs_key(&cfg);
        if api_key.is_empty() {
            return Err(AppError::msg("ELEVENLABS_API_KEY absent (Réglages ou .env)"));
        }
        let item = self.store.get_audio_item(&job.project, &job.item_id)?;
        let audio = cfg.get("audio").cloned().unwrap_or(Value::Null);
        let output_format = audio
            .get("output_format")
            .and_then(|x| x.as_str())
            .unwrap_or("mp3_44100_128");
        let dest = self
            .store
            .audio_file_path(&job.project, &item.kind, &item.id)?;
        let rel = Store::audio_file_rel(&item.kind, &item.id);

        match item.kind.as_str() {
            "voice" => {
                let voice_id = item
                    .voice_id
                    .as_deref()
                    .ok_or_else(|| AppError::msg("aucune voix sélectionnée pour ce clip"))?;
                let model = audio
                    .get("tts_model")
                    .and_then(|x| x.as_str())
                    .unwrap_or("eleven_multilingual_v2");
                // voice_settings: per-item override else the saved voice's settings.
                let settings = item
                    .params
                    .get("voiceSettings")
                    .cloned()
                    .or_else(|| self.store.get_voice(voice_id).ok().map(|v| v.voice_settings))
                    .unwrap_or(Value::Null);
                self.eleven.tts(
                    &api_key,
                    voice_id,
                    &item.text,
                    model,
                    output_format,
                    &settings,
                    &dest,
                )?;
            }
            "sfx" => {
                let model = audio
                    .get("sfx_model")
                    .and_then(|x| x.as_str())
                    .unwrap_or("eleven_text_to_sound_v2");
                let dur = item.params.get("durationSeconds").and_then(|x| x.as_f64());
                let infl = item.params.get("promptInfluence").and_then(|x| x.as_f64());
                let looped = item
                    .params
                    .get("loop")
                    .and_then(|x| x.as_bool())
                    .unwrap_or(false);
                self.eleven
                    .sfx(&api_key, &item.text, model, output_format, dur, infl, looped, &dest)?;
            }
            "music" => {
                let model = audio
                    .get("music_model")
                    .and_then(|x| x.as_str())
                    .unwrap_or("music_v1");
                let ms = item.params.get("musicLengthMs").and_then(|x| x.as_i64());
                self.eleven
                    .music(&api_key, &item.text, model, output_format, ms, &dest)?;
            }
            other => return Err(AppError::msg(format!("type audio inconnu: {other}"))),
        }
        Ok(rel)
    }
}
