//! OpenAI text client (chat completions, structured output) — the "creative
//! director": derives coherent per-modality prompts from the project DNA and
//! ideates whole asset packs. Pure Rust, same key as the images client.

use std::time::Duration;

use serde_json::{json, Value};

use crate::error::{AppError, AppResult};

const CHAT_URL: &str = "https://api.openai.com/v1/chat/completions";

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

/// POST /v1/chat/completions with a strict JSON-schema response format.
/// Returns the parsed JSON object of the assistant message plus the response
/// `usage` block (`{prompt_tokens, completion_tokens, …}`, for real-cost
/// accounting).
pub fn chat_json(
    api_key: &str,
    model: &str,
    system: &str,
    user: &str,
    schema_name: &str,
    schema: &Value,
    timeout_s: i64,
) -> AppResult<(Value, Option<Value>)> {
    let client = client(timeout_s)?;
    let payload = json!({
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": schema_name,
                "strict": true,
                "schema": schema,
            },
        },
    });
    let resp = client
        .post(CHAT_URL)
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
    let content = value
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|x| x.as_str())
        .ok_or_else(|| AppError::msg("réponse OpenAI sans contenu"))?;
    let parsed = serde_json::from_str(content)
        .map_err(|e| AppError::msg(format!("réponse OpenAI non-JSON: {e}")))?;
    Ok((parsed, value.get("usage").cloned()))
}
