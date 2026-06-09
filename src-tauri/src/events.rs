//! Event payloads + emit helpers for the Tauri bridge events:
//! `server-status`, `project-changed`, `job-changed`.

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::types::{JobSnapshot, ServerStatus};

pub const EVENT_SERVER_STATUS: &str = "server-status";
pub const EVENT_PROJECT_CHANGED: &str = "project-changed";
pub const EVENT_JOB_CHANGED: &str = "job-changed";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectChanged {
    pub name: String,
}

/// Emit `server-status`.
pub fn emit_server_status(app: &AppHandle, status: &ServerStatus) {
    let _ = app.emit(EVENT_SERVER_STATUS, status);
}

/// Emit `project-changed` for a project name.
pub fn emit_project_changed(app: &AppHandle, name: &str) {
    let _ = app.emit(
        EVENT_PROJECT_CHANGED,
        ProjectChanged {
            name: name.to_string(),
        },
    );
}

/// Emit `job-changed` with a fresh snapshot.
pub fn emit_job_changed(app: &AppHandle, snapshot: &JobSnapshot) {
    let _ = app.emit(EVENT_JOB_CHANGED, snapshot);
}
