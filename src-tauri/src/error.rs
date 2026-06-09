//! Crate error type. Tauri commands return `Result<T, String>`; we convert
//! `AppError` into a human-readable message (French OK) at the command boundary.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("{0}")]
    Msg(String),

    #[error("projet introuvable: {0}")]
    ProjectNotFound(String),

    #[error("asset introuvable: {project}/{asset_id}")]
    AssetNotFound { project: String, asset_id: String },

    #[error("erreur IO: {0}")]
    Io(#[from] std::io::Error),

    #[error("erreur JSON: {0}")]
    Json(#[from] serde_json::Error),

    #[error("erreur HTTP: {0}")]
    Http(#[from] reqwest::Error),

    #[error("erreur image: {0}")]
    Image(#[from] image::ImageError),

    #[error("{0}")]
    Other(#[from] anyhow::Error),
}

impl AppError {
    pub fn msg(s: impl Into<String>) -> Self {
        AppError::Msg(s.into())
    }
}

/// Convenience: convert any error into the `String` the bridge expects.
impl From<AppError> for String {
    fn from(e: AppError) -> Self {
        e.to_string()
    }
}

pub type AppResult<T> = Result<T, AppError>;
