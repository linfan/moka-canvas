//! What can go wrong on the provider side, named so a client can tell a
//! configuration it has to fix from an outage it can only wait out.

use crate::metadata::MetadataError;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ProviderError {
    /// Anything the metadata layer reported. Carried as a variant instead of
    /// a second error type so a route converts once and the storage codes
    /// keep their existing meanings.
    #[error(transparent)]
    Storage(#[from] MetadataError),

    /// A reference names something that is not there. Reported as a missing
    /// configuration rather than a missing record because the fix is in
    /// Settings, not in a retry.
    #[error("no {capability} model is configured: {reason}")]
    NotConfigured { capability: String, reason: String },

    #[error("channel {channel} has no stored API key")]
    KeyMissing { channel: String },

    #[error("{reference} generates {found}, not {capability}")]
    CapabilityMismatch {
        reference: String,
        capability: String,
        found: String,
    },

    /// The channel is still the default for at least one capability.
    #[error("channel {channel} is still the default for {capabilities:?}")]
    InUse {
        channel: String,
        capabilities: Vec<String>,
    },

    #[error("the channel rejected the stored credential: {0}")]
    Auth(String),

    #[error("the channel is rate limiting requests: {0}")]
    RateLimited(String),

    #[error("the channel did not answer in time: {0}")]
    Timeout(String),

    #[error("the channel could not serve the request: {0}")]
    Unreachable(String),

    #[error("the channel rejected the request: {0}")]
    Rejected(String),

    /// A successful answer with nothing in it. Reported instead of handing
    /// back an empty result, because "no output" is a provider failure the
    /// caller can retry elsewhere rather than a legitimate blank page.
    #[error("the channel returned no usable output: {0}")]
    NoOutput(String),

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
            Self::NotConfigured { .. } | Self::KeyMissing { .. } => "PROVIDER_NOT_CONFIGURED",
            Self::CapabilityMismatch { .. } => "MODEL_CAPABILITY_MISMATCH",
            Self::InUse { .. } => "CONFLICT",
            Self::Auth(_) => "PROVIDER_AUTH",
            Self::RateLimited(_) => "PROVIDER_RATE_LIMIT",
            Self::Timeout(_) => "PROVIDER_TIMEOUT",
            Self::Unreachable(_) => "PROVIDER_UNAVAILABLE",
            Self::Rejected(_) => "PROVIDER_BAD_REQUEST",
            Self::NoOutput(_) => "PROVIDER_NO_OUTPUT",
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
            Self::RateLimited(_) | Self::Timeout(_) | Self::Unreachable(_) => true,
            _ => false,
        }
    }

    /// Extra structure for the problem body, when the message alone would
    /// leave the client guessing which part of its state to repair.
    pub fn details(&self) -> Option<serde_json::Value> {
        match self {
            Self::InUse {
                channel,
                capabilities,
            } => Some(serde_json::json!({
                "channelId": channel,
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
                "GENERATION_CANCELLED",
                "TASK_NOT_FOUND",
                "TASK_EXPIRED"
            ]
        );
    }

    #[test]
    fn a_run_outcome_is_never_something_waiting_fixes() {
        // An empty answer, a caller that left, and a handle that is gone all
        // fail again verbatim; only a busy or unreachable channel is worth a
        // backoff.
        for error in run_outcomes() {
            assert!(!error.retryable(), "{error} must not be retried");
            assert!(error.details().is_none());
        }
    }
}
