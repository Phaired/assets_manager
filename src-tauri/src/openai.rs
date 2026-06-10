//! OpenAI Images client — multiview sheet generation + image edits, pure Rust
//! (reqwest + image). Replaces the Python worker's former /multiview and
//! /edit_image endpoints; the worker now only handles the genuinely
//! Python-bound 3D stages (Hunyuan clients, mesh export).

use std::path::Path;
use std::time::Duration;

use base64::Engine as _;
use image::imageops::FilterType;
use image::{Rgb, RgbImage};
use serde_json::{json, Value};

use crate::error::{AppError, AppResult};

const GENERATIONS_URL: &str = "https://api.openai.com/v1/images/generations";
const EDITS_URL: &str = "https://api.openai.com/v1/images/edits";

/// View files written by `split_sheet`, in 2x2 panel order (TL/TR/BL/BR).
pub const VIEW_FILES: [&str; 4] = ["front.png", "back.png", "left.png", "right.png"];

/// Background gray used to pad the split views (same value as the original
/// Python `pad_square`).
const PAD_BG: Rgb<u8> = Rgb([235, 237, 240]);

fn client(timeout_s: i64) -> AppResult<reqwest::blocking::Client> {
    Ok(reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(timeout_s.max(10) as u64))
        .build()?)
}

/// OpenAI errors come as `{"error": {"message": ...}}` — surface the message.
fn error_from_response(status: u16, text: &str) -> AppError {
    let detail = serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|v| {
            v.get("error")
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .map(String::from)
        })
        .unwrap_or_else(|| text.chars().take(500).collect());
    AppError::msg(format!("OpenAI HTTP {status}: {detail}"))
}

/// Extract the PNG bytes from an images-API response (`b64_json` or `url`).
fn decode_image_response(
    value: &Value,
    client: &reqwest::blocking::Client,
) -> AppResult<Vec<u8>> {
    let first = value
        .get("data")
        .and_then(|d| d.get(0))
        .ok_or_else(|| AppError::msg("réponse OpenAI sans données image"))?;
    if let Some(b64) = first.get("b64_json").and_then(|x| x.as_str()) {
        return base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| AppError::msg(format!("b64_json invalide: {e}")));
    }
    if let Some(url) = first.get("url").and_then(|x| x.as_str()) {
        let resp = client.get(url).send()?;
        return Ok(resp.bytes()?.to_vec());
    }
    Err(AppError::msg("réponse OpenAI sans b64_json ni url"))
}

/// POST /v1/images/generations — returns the raw PNG bytes of the 2x2 sheet.
fn request_sheet(
    api_key: &str,
    prompt: &str,
    model: &str,
    quality: &str,
    timeout_s: i64,
) -> AppResult<Vec<u8>> {
    let client = client(timeout_s)?;
    let payload = json!({
        "model": model,
        "prompt": prompt,
        "n": 1,
        "size": "1536x1024",
        "quality": quality,
        "output_format": "png",
    });
    let resp = client
        .post(GENERATIONS_URL)
        .bearer_auth(api_key)
        .json(&payload)
        .send()?;
    let status = resp.status();
    if !status.is_success() {
        return Err(error_from_response(
            status.as_u16(),
            &resp.text().unwrap_or_default(),
        ));
    }
    let value: Value = resp.json()?;
    decode_image_response(&value, &client)
}

/// Pad to a square on light gray, then resize to 1024² (Lanczos).
fn pad_square(view: &RgbImage) -> RgbImage {
    let side = view.width().max(view.height());
    let mut canvas = RgbImage::from_pixel(side, side, PAD_BG);
    let x = (side - view.width()) / 2;
    let y = (side - view.height()) / 2;
    image::imageops::replace(&mut canvas, view, x as i64, y as i64);
    image::imageops::resize(&canvas, 1024, 1024, FilterType::Lanczos3)
}

/// Split the 2x2 sheet into `sheet.png` + the four padded 1024² views.
fn split_sheet(sheet_bytes: &[u8], output_dir: &Path) -> AppResult<()> {
    let sheet = image::load_from_memory(sheet_bytes)
        .map_err(|e| AppError::msg(format!("planche multivue illisible: {e}")))?
        .to_rgb8();
    let (w, h) = sheet.dimensions();
    let (mx, my) = (w / 2, h / 2);
    std::fs::create_dir_all(output_dir)?;
    sheet.save(output_dir.join("sheet.png"))?;
    // (x, y, width, height) per panel — right/bottom halves absorb odd pixels,
    // matching the original PIL crop boxes.
    let boxes = [
        (0, 0, mx, my),
        (mx, 0, w - mx, my),
        (0, my, mx, h - my),
        (mx, my, w - mx, h - my),
    ];
    for (name, (x, y, cw, ch)) in VIEW_FILES.iter().zip(boxes) {
        let view = image::imageops::crop_imm(&sheet, x, y, cw, ch).to_image();
        pad_square(&view).save(output_dir.join(name))?;
    }
    Ok(())
}

/// Generate the sheet and write sheet/front/back/left/right.png in
/// `output_dir`. Returns the stage meta (`model`, `quality`, `files`) — cost
/// accounting stays in the job manager.
pub fn run_multiview(
    api_key: &str,
    prompt: &str,
    model: &str,
    quality: &str,
    timeout_s: i64,
    output_dir: &Path,
) -> AppResult<Value> {
    let bytes = request_sheet(api_key, prompt, model, quality, timeout_s)?;
    split_sheet(&bytes, output_dir)?;
    let mut files = vec!["sheet.png".to_string()];
    files.extend(VIEW_FILES.iter().map(|s| s.to_string()));
    Ok(json!({"model": model, "quality": quality, "files": files}))
}

/// POST /v1/images/edits (multipart; optional inpainting mask whose transparent
/// pixels delimit the editable region). Returns the edited PNG bytes — the
/// caller decides where to write them.
#[allow(clippy::too_many_arguments)]
pub fn edit_image(
    api_key: &str,
    image_path: &Path,
    prompt: &str,
    model: &str,
    size: &str,
    quality: &str,
    timeout_s: i64,
    mask_path: Option<&Path>,
) -> AppResult<Vec<u8>> {
    use reqwest::blocking::multipart::{Form, Part};

    let client = client(timeout_s)?;
    let image_bytes = std::fs::read(image_path)
        .map_err(|e| AppError::msg(format!("lecture {}: {e}", image_path.display())))?;
    let mut form = Form::new()
        .text("model", model.to_string())
        .text("prompt", prompt.to_string())
        .text("n", "1")
        .text("quality", quality.to_string())
        .part(
            "image",
            Part::bytes(image_bytes)
                .file_name("image.png")
                .mime_str("image/png")?,
        );
    // /images/edits does NOT accept size="auto" (unlike generations): only send
    // an explicit resolution, otherwise omit it so the API matches the input.
    if !size.is_empty() && size != "auto" {
        form = form.text("size", size.to_string());
    }
    if let Some(mask) = mask_path {
        let mask_bytes = std::fs::read(mask)
            .map_err(|e| AppError::msg(format!("lecture masque {}: {e}", mask.display())))?;
        form = form.part(
            "mask",
            Part::bytes(mask_bytes)
                .file_name("mask.png")
                .mime_str("image/png")?,
        );
    }
    let resp = client
        .post(EDITS_URL)
        .bearer_auth(api_key)
        .multipart(form)
        .send()?;
    let status = resp.status();
    if !status.is_success() {
        return Err(error_from_response(
            status.as_u16(),
            &resp.text().unwrap_or_default(),
        ));
    }
    let value: Value = resp.json()?;
    decode_image_response(&value, &client)
}
