//! ElevenLabs HTTP client — audio generation (voices / SFX / music).
//!
//! Pure HTTP + mp3 file writes (no Python worker). Ported from the proven CLI at
//! `C:\dev\roblox\audio_pipeline` (`request_api` retry/backoff, Voice Design,
//! TTS, SFX) plus the Music API. Calls go straight to `api.elevenlabs.io` with a
//! blocking reqwest client; the API key is passed in per call (owned by Rust
//! config, never persisted here).

use std::path::Path;
use std::time::Duration;

use serde_json::{json, Value};

use crate::error::{AppError, AppResult};
use crate::types::VoicePreview;

const API_BASE: &str = "https://api.elevenlabs.io/v1";
const MAX_RETRIES: u32 = 3;

pub struct ElevenLabs {
    client: reqwest::blocking::Client,
}

impl ElevenLabs {
    pub fn new() -> AppResult<Self> {
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(600))
            .build()?;
        Ok(Self { client })
    }

    /// POST with `xi-api-key` + retry/backoff on 429 / 5xx (exponential, capped at
    /// 30s — port of audio_pipeline `request_api`). Returns the raw response bytes.
    fn post(
        &self,
        api_key: &str,
        path: &str,
        body: &Value,
        accept: &str,
        timeout: Duration,
    ) -> AppResult<Vec<u8>> {
        let url = format!("{API_BASE}{path}");
        let mut attempt = 0u32;
        loop {
            let resp = self
                .client
                .post(&url)
                .header("xi-api-key", api_key)
                .header("Accept", accept)
                .timeout(timeout)
                .json(body)
                .send();
            match resp {
                Ok(r) => {
                    let status = r.status();
                    if status.is_success() {
                        return r.bytes().map(|b| b.to_vec()).map_err(AppError::from);
                    }
                    let code = status.as_u16();
                    let retryable = code == 429 || (500..600).contains(&code);
                    let detail = extract_detail(&r.text().unwrap_or_default());
                    if !retryable || attempt >= MAX_RETRIES {
                        return Err(AppError::msg(format!("ElevenLabs HTTP {code}: {detail}")));
                    }
                }
                Err(e) => {
                    if attempt >= MAX_RETRIES {
                        return Err(AppError::msg(format!("requête ElevenLabs échouée: {e}")));
                    }
                }
            }
            let delay = std::cmp::min(30u64, 1u64 << attempt);
            std::thread::sleep(Duration::from_secs(delay));
            attempt += 1;
        }
    }

    // --- voice design (sur-mesure) --------------------------------------

    /// Voice Design: returns preview voices (each with a base64 mp3 the UI plays
    /// via a `data:` URL and a `generated_voice_id` to later save).
    pub fn voice_design(
        &self,
        api_key: &str,
        description: &str,
        preview_text: &str,
        model_id: &str,
        seed: i64,
        guidance_scale: f64,
    ) -> AppResult<Vec<VoicePreview>> {
        let body = json!({
            "voice_description": description,
            "text": preview_text,
            "model_id": model_id,
            "seed": seed,
            "guidance_scale": guidance_scale,
        });
        let raw = self.post(
            api_key,
            "/text-to-voice/design?output_format=mp3_44100_128",
            &body,
            "application/json",
            Duration::from_secs(120),
        )?;
        let v: Value = serde_json::from_slice(&raw)
            .map_err(|e| AppError::msg(format!("réponse Voice Design invalide: {e}")))?;
        let previews = v
            .get("previews")
            .and_then(|p| p.as_array())
            .ok_or_else(|| AppError::msg("Voice Design n'a renvoyé aucun aperçu"))?;
        let mut out = Vec::new();
        for p in previews {
            let gid = p.get("generated_voice_id").and_then(|x| x.as_str());
            let audio = p.get("audio_base_64").and_then(|x| x.as_str());
            if let (Some(gid), Some(audio)) = (gid, audio) {
                out.push(VoicePreview {
                    generated_voice_id: gid.to_string(),
                    audio_base_64: audio.to_string(),
                });
            }
        }
        if out.is_empty() {
            return Err(AppError::msg("Voice Design: aperçus incomplets"));
        }
        Ok(out)
    }

    /// Create (save) a reusable voice from a chosen design preview. Returns its
    /// permanent `voice_id`.
    pub fn voice_create(
        &self,
        api_key: &str,
        voice_name: &str,
        voice_description: &str,
        generated_voice_id: &str,
    ) -> AppResult<String> {
        let body = json!({
            "voice_name": voice_name,
            "voice_description": voice_description,
            "generated_voice_id": generated_voice_id,
            "labels": { "use_case": "assets_gen" },
        });
        let raw = self.post(
            api_key,
            "/text-to-voice",
            &body,
            "application/json",
            Duration::from_secs(120),
        )?;
        let v: Value = serde_json::from_slice(&raw)
            .map_err(|e| AppError::msg(format!("réponse Create Voice invalide: {e}")))?;
        v.get("voice_id")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| AppError::msg("Create Voice n'a renvoyé aucun voice_id"))
    }

    // --- generation (write mp3 to dest) ---------------------------------

    /// Text-to-speech with a saved voice → write mp3 to `dest`.
    pub fn tts(
        &self,
        api_key: &str,
        voice_id: &str,
        text: &str,
        model_id: &str,
        output_format: &str,
        voice_settings: &Value,
        dest: &Path,
    ) -> AppResult<()> {
        let mut body = json!({ "text": text, "model_id": model_id });
        if voice_settings
            .as_object()
            .map(|m| !m.is_empty())
            .unwrap_or(false)
        {
            body.as_object_mut()
                .unwrap()
                .insert("voice_settings".into(), voice_settings.clone());
        }
        let path = format!("/text-to-speech/{voice_id}?output_format={output_format}");
        let bytes = self.post(api_key, &path, &body, "audio/mpeg", Duration::from_secs(180))?;
        write_atomic(dest, &bytes)
    }

    /// Sound effect generation → write mp3 to `dest`.
    #[allow(clippy::too_many_arguments)]
    pub fn sfx(
        &self,
        api_key: &str,
        text: &str,
        model_id: &str,
        output_format: &str,
        duration_seconds: Option<f64>,
        prompt_influence: Option<f64>,
        looped: bool,
        dest: &Path,
    ) -> AppResult<()> {
        let mut body = json!({ "text": text, "model_id": model_id, "output_format": output_format });
        let o = body.as_object_mut().unwrap();
        if let Some(d) = duration_seconds {
            o.insert("duration_seconds".into(), json!(d));
        }
        if let Some(p) = prompt_influence {
            o.insert("prompt_influence".into(), json!(p));
        }
        if looped {
            o.insert("loop".into(), json!(true));
        }
        let bytes = self.post(
            api_key,
            "/sound-generation",
            &body,
            "audio/mpeg",
            Duration::from_secs(180),
        )?;
        write_atomic(dest, &bytes)
    }

    /// Music generation → write mp3 to `dest`.
    pub fn music(
        &self,
        api_key: &str,
        prompt: &str,
        model_id: &str,
        output_format: &str,
        music_length_ms: Option<i64>,
        dest: &Path,
    ) -> AppResult<()> {
        let mut body = json!({ "prompt": prompt, "model_id": model_id });
        if let Some(ms) = music_length_ms {
            body.as_object_mut()
                .unwrap()
                .insert("music_length_ms".into(), json!(ms));
        }
        let path = format!("/music?output_format={output_format}");
        let bytes = self.post(api_key, &path, &body, "audio/mpeg", Duration::from_secs(300))?;
        write_atomic(dest, &bytes)
    }
}

/// Atomic mp3 write (tmp + rename) so a partial download never leaves a corrupt
/// file on disk.
fn write_atomic(dest: &Path, bytes: &[u8]) -> AppResult<()> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut tmp = dest.to_path_buf();
    tmp.set_extension("tmp");
    std::fs::write(&tmp, bytes)?;
    if dest.exists() {
        let _ = std::fs::remove_file(dest);
    }
    std::fs::rename(&tmp, dest)?;
    Ok(())
}

/// Best-effort extraction of an ElevenLabs error message: `{detail:"..."}` or
/// `{detail:{message:"..."}}`, else the raw body (truncated).
fn extract_detail(body: &str) -> String {
    if let Ok(v) = serde_json::from_str::<Value>(body) {
        if let Some(d) = v.get("detail") {
            if let Some(s) = d.as_str() {
                return s.to_string();
            }
            if let Some(m) = d.get("message").and_then(|x| x.as_str()) {
                return m.to_string();
            }
            return d.to_string();
        }
    }
    body.trim().chars().take(500).collect()
}
