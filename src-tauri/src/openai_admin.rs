//! OpenAI Admin (organization) endpoints — the REAL billed costs of the whole
//! organization, straight from OpenAI's books. Requires an ADMIN key
//! (`sk-admin-…`), distinct from the inference key: regular API keys cannot
//! call `/v1/organization/*`. Daily granularity (the API only supports
//! bucket_width=1d for costs), data settles with up to ~24h delay.

use std::time::Duration;

use serde_json::Value;

use crate::error::{AppError, AppResult};

const COSTS_URL: &str = "https://api.openai.com/v1/organization/costs";

/// One daily cost bucket (Unix seconds, summed USD across line items).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostDay {
    pub start_time: i64,
    pub end_time: i64,
    pub amount_usd: f64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostsSummary {
    pub total_usd: f64,
    pub days: Vec<CostDay>,
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

/// GET /v1/organization/costs since `start_time`, following pagination.
pub fn costs(admin_key: &str, start_time: i64, timeout_s: i64) -> AppResult<CostsSummary> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(timeout_s.max(10) as u64))
        .build()?;

    let mut days: Vec<CostDay> = Vec::new();
    let mut page: Option<String> = None;
    loop {
        let mut req = client
            .get(COSTS_URL)
            .bearer_auth(admin_key)
            .query(&[
                ("start_time", start_time.to_string()),
                ("bucket_width", "1d".to_string()),
                ("limit", "180".to_string()),
            ]);
        if let Some(p) = &page {
            req = req.query(&[("page", p.as_str())]);
        }
        let resp = req.send()?;
        let status = resp.status();
        if !status.is_success() {
            return Err(error_from_response(
                status.as_u16(),
                &resp.text().unwrap_or_default(),
            ));
        }
        let value: Value = resp.json()?;

        for bucket in value.get("data").and_then(|d| d.as_array()).into_iter().flatten() {
            let amount: f64 = bucket
                .get("results")
                .and_then(|r| r.as_array())
                .map(|results| {
                    results
                        .iter()
                        .filter_map(|r| {
                            r.get("amount")
                                .and_then(|a| a.get("value"))
                                .and_then(|v| v.as_f64())
                        })
                        .sum()
                })
                .unwrap_or(0.0);
            days.push(CostDay {
                start_time: bucket.get("start_time").and_then(|x| x.as_i64()).unwrap_or(0),
                end_time: bucket.get("end_time").and_then(|x| x.as_i64()).unwrap_or(0),
                amount_usd: amount,
            });
        }

        let has_more = value.get("has_more").and_then(|x| x.as_bool()).unwrap_or(false);
        page = value
            .get("next_page")
            .and_then(|x| x.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        if !has_more || page.is_none() {
            break;
        }
    }

    days.sort_by_key(|d| d.start_time);
    let total_usd = days.iter().map(|d| d.amount_usd).sum();
    Ok(CostsSummary { total_usd, days })
}
