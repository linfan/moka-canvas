use crate::project::ProjectError;
use axum::{
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProblemBody {
    pub code: String,
    pub message: String,
    pub status: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

#[derive(Debug)]
struct ProblemInner {
    status: StatusCode,
    body: ProblemBody,
}

#[derive(Debug)]
pub struct Problem(Box<ProblemInner>);

impl Problem {
    pub fn new(status: StatusCode, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self(Box::new(ProblemInner {
            status,
            body: ProblemBody {
                code: code.into(),
                message: message.into(),
                status: status.as_u16(),
                details: None,
            },
        }))
    }

    pub fn with_details(mut self, details: serde_json::Value) -> Self {
        self.0.body.details = Some(details);
        self
    }
}

pub fn status_for_code(code: &str) -> StatusCode {
    match code {
        "NOT_FOUND" | "PROJECT_NOT_FOUND" | "RUN_NOT_FOUND" | "ASSET_MISSING" => {
            StatusCode::NOT_FOUND
        }
        "PROJECT_NOT_OPEN"
        | "REVISION_CONFLICT"
        | "ASSET_IN_USE"
        | "CONFLICT"
        | "RUN_NOT_CANCELLABLE"
        | "RUN_NOT_RETRYABLE" => StatusCode::CONFLICT,
        "PAYLOAD_TOO_LARGE" | "MOKA_TOO_LARGE" => StatusCode::PAYLOAD_TOO_LARGE,
        "UNSUPPORTED_MEDIA_TYPE" => StatusCode::UNSUPPORTED_MEDIA_TYPE,
        "PATH_ESCAPE" => StatusCode::BAD_REQUEST,
        "INTERNAL" => StatusCode::INTERNAL_SERVER_ERROR,
        _ => StatusCode::UNPROCESSABLE_ENTITY,
    }
}

impl From<ProjectError> for Problem {
    fn from(error: ProjectError) -> Self {
        Problem::new(
            status_for_code(error.code()),
            error.code(),
            error.to_string(),
        )
    }
}

impl From<std::io::Error> for Problem {
    fn from(error: std::io::Error) -> Self {
        Problem::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "INTERNAL",
            format!("I/O error: {error}"),
        )
    }
}

impl IntoResponse for Problem {
    fn into_response(self) -> Response {
        let inner = *self.0;
        (
            inner.status,
            [(
                header::CONTENT_TYPE,
                header::HeaderValue::from_static("application/problem+json"),
            )],
            Json(inner.body),
        )
            .into_response()
    }
}

/// Maps axum JSON extractor rejections into the shared problem shape.
pub fn json_or_problem<T>(
    result: Result<Json<T>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<T>, Problem> {
    result.map_err(|rejection| {
        Problem::new(
            rejection.status(),
            "VALIDATION_FAILED",
            format!("Request body is not valid: {}", rejection.body_text()),
        )
    })
}
