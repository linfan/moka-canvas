//! The reserved protocol.
//!
//! A model can be configured with it and nothing more: there is no defined
//! request shape to send, so every call says so rather than reaching an
//! endpoint whose body would have to be invented. A template-driven adapter
//! belongs here when there is one.

use super::{ModelCall, ProviderAdapter, CUSTOM_RESERVED};
use crate::generate::error::ProviderError;
use crate::generate::media::MediaInput;
use crate::generate::{AsyncTask, Cancel, DeltaSink, GenerateRequest, GenerateResult, TaskState};

pub(super) static ADAPTER: CustomAdapter = CustomAdapter;

pub struct CustomAdapter;

#[async_trait::async_trait]
impl ProviderAdapter for CustomAdapter {
    async fn generate(
        &self,
        _call: &ModelCall,
        _request: &GenerateRequest,
        _inputs: &[MediaInput],
        _cancel: &Cancel,
    ) -> Result<GenerateResult, ProviderError> {
        Err(reserved())
    }

    async fn generate_stream(
        &self,
        _call: &ModelCall,
        _request: &GenerateRequest,
        _inputs: &[MediaInput],
        _sink: &DeltaSink,
        _cancel: &Cancel,
    ) -> Result<GenerateResult, ProviderError> {
        Err(reserved())
    }

    async fn create_task(
        &self,
        _call: &ModelCall,
        _request: &GenerateRequest,
        _inputs: &[MediaInput],
        _cancel: &Cancel,
    ) -> Result<AsyncTask, ProviderError> {
        Err(reserved())
    }

    async fn poll_task(
        &self,
        _call: &ModelCall,
        _task: &AsyncTask,
        _cancel: &Cancel,
    ) -> Result<TaskState, ProviderError> {
        Err(reserved())
    }
}

/// Reported as something the caller has to fix, because no amount of waiting
/// gives a reserved protocol an implementation.
fn reserved() -> ProviderError {
    ProviderError::invalid(CUSTOM_RESERVED)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::GenerateConfig;
    use crate::domain::Capability;
    use crate::generate::models::ResolvedModel;
    use crate::metadata::Protocol;

    fn call() -> ModelCall {
        let resolved = ResolvedModel {
            config_id: "anything".into(),
            model: "anything".into(),
            display_name: "Anything".into(),
            category: Capability::Text,
            protocol: Protocol::from_wire_name("custom"),
            url: "https://example.invalid/v1/chat/completions".into(),
        };
        ModelCall::new(&resolved, "a-key".into(), GenerateConfig::default())
            .expect("a client builds")
    }

    #[tokio::test]
    async fn the_reserved_protocol_refuses_everything_without_reaching_the_network() {
        let call = call();
        let request = GenerateRequest::default();
        let cancel = Cancel::new();
        let task = AsyncTask {
            id: "task-1".into(),
            reference: "job-1".into(),
            protocol: Protocol::from_wire_name("custom"),
            capability: Capability::Video,
            model: call.config_id.clone(),
            created_at: "2026-01-01T00:00:00Z".into(),
        };

        // The address does not resolve, so an adapter that tried to use it
        // would fail differently: unreachable rather than invalid.
        let outcomes = [
            ADAPTER
                .generate(&call, &request, &[], &cancel)
                .await
                .expect_err("refused"),
            ADAPTER
                .generate_stream(&call, &request, &[], &DeltaSink::default(), &cancel)
                .await
                .expect_err("refused"),
            ADAPTER
                .create_task(&call, &request, &[], &cancel)
                .await
                .expect_err("refused"),
            ADAPTER
                .poll_task(&call, &task, &cancel)
                .await
                .expect_err("refused"),
        ];
        for error in outcomes {
            assert_eq!(error.code(), "VALIDATION_FAILED");
            assert!(!error.retryable(), "{error} must not be retried");
            assert!(error.to_string().contains("reserved"), "{error}");
        }
    }
}
