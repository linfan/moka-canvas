//! Graph execution: authoritative run validation, the executor boundary,
//! and the durable run lifecycle persisted under `history/runs/`.

pub mod executor;
pub mod runner;
pub mod validate;

use crate::domain::{AssetId, DataType, NodeId, NodeKind, RunId, ValidationIssue, WorkflowNode};
use serde::Serialize;
use std::collections::BTreeMap;
use std::sync::Arc;

/// The executor every generated answer is handed to. A generation node does not
/// name its own the way an operation node does: which model answers is the
/// spec's business, not the node's.
pub const PROVIDER_EXECUTOR_KEY: &str = "provider";

/// Which node/port produced a value, recorded for audit.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ValueProvenance {
    pub node_id: NodeId,
    pub port_id: String,
}

/// A typed value flowing between nodes during a run.
#[derive(Debug, Clone, PartialEq)]
pub enum WorkflowValue {
    Text {
        text: String,
        source: ValueProvenance,
    },
    Media {
        media_type: DataType,
        asset_id: AssetId,
        source: ValueProvenance,
    },
    Artifact {
        asset_id: AssetId,
        media_type: Option<DataType>,
        source: ValueProvenance,
    },
}

impl WorkflowValue {
    pub fn data_type(&self) -> DataType {
        match self {
            Self::Text { .. } => DataType::Text,
            Self::Media { media_type, .. } => *media_type,
            Self::Artifact { media_type, .. } => media_type.unwrap_or(DataType::Artifact),
        }
    }
}

/// The executor a node's step is handed to, or `None` when the node has nothing
/// a run could do.
///
/// An operation node that names no executor still answers here rather than
/// `None`: which executor it wants is a separate question from whether it can
/// be run at all, and the two deserve different complaints.
pub fn executor_key_for(node: &WorkflowNode) -> Option<&str> {
    match node.kind {
        NodeKind::Operation => Some(node.data.executor_key.as_deref().unwrap_or_default()),
        NodeKind::Text | NodeKind::Image | NodeKind::Audio | NodeKind::Video => {
            node.data.generation.as_ref().map(|_| PROVIDER_EXECUTOR_KEY)
        }
        _ => None,
    }
}

/// The operation a node's step asks its executor for. An operation node carries
/// its own; a generation node's is derived from the capability its spec
/// declares, which is the same word the gateway routes on.
pub fn operation_type_for(node: &WorkflowNode) -> String {
    match node.kind {
        NodeKind::Operation => node.data.operation_type.clone().unwrap_or_default(),
        _ => node
            .data
            .generation
            .as_ref()
            .map(|spec| format!("generate.{}", spec.capability.as_str()))
            .unwrap_or_default(),
    }
}

/// Everything an executor needs for one node step — resolved values and a
/// sanitized parameter model, never raw HTTP data or filesystem handles.
#[derive(Debug, Clone)]
pub struct ExecutionRequest {
    pub run_id: RunId,
    pub node_id: NodeId,
    pub operation_type: String,
    pub parameters: serde_json::Value,
    /// Input port id → values in deterministic edge order.
    pub inputs: BTreeMap<String, Vec<WorkflowValue>>,
}

/// What a step produced. Staged asset bytes join in a later phase; the
/// deterministic executor only emits text.
#[derive(Debug, Clone, Default)]
pub struct ExecutionOutput {
    pub text: Option<String>,
}

/// Validation failure from the executor's own operation schema.
#[derive(Debug)]
pub struct ExecutionValidationError {
    pub issues: Vec<ValidationIssue>,
}

#[derive(Debug)]
pub struct ExecutionError {
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
    pub cancelled: bool,
}

impl ExecutionError {
    pub fn failed(message: impl Into<String>) -> Self {
        Self {
            code: "STEP_FAILED",
            message: message.into(),
            retryable: false,
            cancelled: false,
        }
    }

    pub fn cancelled() -> Self {
        Self {
            code: "CANCELLED",
            message: "Cancelled".into(),
            retryable: false,
            cancelled: true,
        }
    }
}

/// Progress callback wired by the runner; a no-op for instant executors.
#[derive(Clone, Default)]
pub struct ProgressReporter {
    sink: Option<Arc<dyn Fn(f64) + Send + Sync>>,
}

impl ProgressReporter {
    pub fn new(sink: Arc<dyn Fn(f64) + Send + Sync>) -> Self {
        Self { sink: Some(sink) }
    }

    pub fn report(&self, fraction: f64) {
        if let Some(sink) = &self.sink {
            sink(fraction);
        }
    }
}

#[async_trait::async_trait]
pub trait WorkflowExecutor: Send + Sync {
    fn key(&self) -> &str;
    fn supports(&self, operation_type: &str) -> bool;
    async fn validate(&self, request: &ExecutionRequest) -> Result<(), ExecutionValidationError>;
    async fn execute(
        &self,
        request: ExecutionRequest,
        progress: ProgressReporter,
    ) -> Result<ExecutionOutput, ExecutionError>;
    async fn cancel(&self, run_id: &RunId) -> Result<(), ExecutionError>;
}
