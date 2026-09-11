//! What can go wrong on the provider side, named so a client can tell a
//! configuration it has to fix from an outage it can only wait out.

use crate::metadata::MetadataError;
use std::time::Duration;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ProviderError {
    /// Anything the metadata layer reported. Carried as a variant instead of
    /// a second error type so a route converts once and the storage codes
    /// keep their existing meanings.
    #[error(transparent)]
    Storage(#[from] MetadataError),

    /// Anything the project layer reported: a reference that is not in the
    /// open project, or no project open at all. Carried rather than translated
    /// so those codes keep the meanings every other route gives them.
    #[error(transparent)]
    Project(#[from] crate::project::ProjectError),

    /// A disk read that failed after the asset was known to be there, which
    /// is the machine's problem rather than the request's.
    #[error(transparent)]
    Io(#[from] std::io::Error),

    /// A reference names something that is not there. Reported as a missing
    /// configuration rather than a missing record because the fix is in
    /// Settings, not in a retry.
    #[error("no {capability} model is configured: {reason}")]
    NotConfigured { capability: String, reason: String },

    #[error("model {model} has no stored API key")]
    KeyMissing { model: String },

    #[error("{reference} generates {found}, not {capability}")]
    CapabilityMismatch {
        reference: String,
        capability: String,
        found: String,
    },

    /// The model is still the default for at least one category.
    #[error("model {model} is still the default for {capabilities:?}")]
    InUse {
        model: String,
        capabilities: Vec<String>,
    },

    #[error("the provider rejected the stored credential: {0}")]
    Auth(String),

    /// The provider is busy. Carries its own advice about when to come back,
    /// because a backoff that ignores `Retry-After` either hammers a provider
    /// that asked for a minute or waits one out when it asked for a second.
    #[error("the provider is rate limiting requests: {detail}")]
    RateLimited {
        detail: String,
        retry_after: Option<Duration>,
    },

    #[error("the provider did not answer in time: {0}")]
    Timeout(String),

    #[error("the provider could not serve the request: {0}")]
    Unreachable(String),

    #[error("the provider rejected the request: {0}")]
    Rejected(String),

    /// A successful answer with nothing in it. Reported instead of handing
    /// back an empty result, because "no output" is a provider failure the
    /// caller can retry elsewhere rather than a legitimate blank page.
    #[error("the provider returned no usable output: {0}")]
    NoOutput(String),

    /// A successful answer too big to keep. The ceiling is one the deployment
    /// set, so this is not a provider misbehaving and asking it again would be
    /// answered the same way: what has to change is the request or the budget.
    #[error("the answer was too large to keep: {0}")]
    TooLarge(String),

    /// The caller walked away mid-generation.
    #[error("the generation was cancelled")]
    Cancelled,

    /// Nothing is registered under this handle: it never existed, or the
    /// process that was tracking it has gone.
    #[error("no generation task {task} is being tracked")]
    TaskMissing { task: String },

    /// The upstream job is too old to poll any more.
    #[error("generation task {task} expired before it was collected")]
    TaskExpired { task: String },

    #[error("{0}")]
    NotFound(String),

    #[error("{0}")]
    Invalid(String),
}

impl ProviderError {
    pub fn not_configured(capability: &str, reason: impl Into<String>) -> Self {
        Self::NotConfigured {
            capability: capability.to_string(),
            reason: reason.into(),
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::Invalid(message.into())
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::NotFound(message.into())
    }

    pub fn code(&self) -> &'static str {
        match self {
            Self::Storage(error) => error.code(),
            Self::Project(error) => error.code(),
            Self::Io(_) => "INTERNAL",
            Self::NotConfigured { .. } | Self::KeyMissing { .. } => "PROVIDER_NOT_CONFIGURED",
            Self::CapabilityMismatch { .. } => "MODEL_CAPABILITY_MISMATCH",
            Self::InUse { .. } => "CONFLICT",
            Self::Auth(_) => "PROVIDER_AUTH",
            Self::RateLimited { .. } => "PROVIDER_RATE_LIMIT",
            Self::Timeout(_) => "PROVIDER_TIMEOUT",
            Self::Unreachable(_) => "PROVIDER_UNAVAILABLE",
            Self::Rejected(_) => "PROVIDER_BAD_REQUEST",
            Self::NoOutput(_) => "PROVIDER_NO_OUTPUT",
            Self::TooLarge(_) => "GENERATION_OUTPUT_TOO_LARGE",
            Self::Cancelled => "GENERATION_CANCELLED",
            Self::TaskMissing { .. } => "TASK_NOT_FOUND",
            Self::TaskExpired { .. } => "TASK_EXPIRED",
            Self::NotFound(_) => "NOT_FOUND",
            Self::Invalid(_) => "VALIDATION_FAILED",
        }
    }

    /// True when waiting could fix it: the storage layer's own classification,
    /// plus a provider that is busy, slow, or unreachable. A credential the
    /// provider rejected and a request it refused are wrong, not late, so
    /// repeating them verbatim only repeats the failure.
    pub fn retryable(&self) -> bool {
        match self {
            Self::Storage(error) => error.retryable(),
            Self::RateLimited { .. } | Self::Timeout(_) | Self::Unreachable(_) => true,
            _ => false,
        }
    }

    /// Extra structure for the problem body, when the message alone would
    /// leave the client guessing which part of its state to repair.
    pub fn details(&self) -> Option<serde_json::Value> {
        match self {
            Self::InUse {
                model,
                capabilities,
            } => Some(serde_json::json!({
                "modelId": model,
                "defaultFor": capabilities,
            })),
            Self::CapabilityMismatch {
                reference,
                capability,
                found,
            } => Some(serde_json::json!({
                "reference": reference,
                "requested": capability,
                "actual": found,
            })),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_outcomes() -> Vec<ProviderError> {
        vec![
            ProviderError::NoOutput("the answer carried no text and no media".into()),
            ProviderError::TooLarge("the answer carried 17 pieces".into()),
            ProviderError::Cancelled,
            ProviderError::TaskMissing {
                task: "task-1".into(),
            },
            ProviderError::TaskExpired {
                task: "task-1".into(),
            },
        ]
    }

    #[test]
    fn each_run_outcome_has_its_own_code() {
        let codes: Vec<&str> = run_outcomes().iter().map(ProviderError::code).collect();
        assert_eq!(
            codes,
            [
                "PROVIDER_NO_OUTPUT",
                "GENERATION_OUTPUT_TOO_LARGE",
                "GENERATION_CANCELLED",
                "TASK_NOT_FOUND",
                "TASK_EXPIRED"
            ]
        );
    }

    #[test]
    fn a_run_outcome_is_never_something_waiting_fixes() {
        // An empty answer, one too big to keep, a caller that left, and a
        // handle that is gone all fail again verbatim; only a busy or
        // unreachable provider is worth a backoff.
        for error in run_outcomes() {
            assert!(!error.retryable(), "{error} must not be retried");
            assert!(error.details().is_none());
        }
    }
}
