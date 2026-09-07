//! The run manager: owns the run lifecycle (queue, drive, cancel, retry) and
//! persists every transition through the project store. One run drives at a
//! time; the driver is the single writer of a running record, so cancel
//! requests arrive through an in-memory flag the driver observes between and
//! during steps.

use super::validate::{validate_run, RunSnapshot};
use super::{ExecutionRequest, ProgressReporter, ValueProvenance, WorkflowExecutor, WorkflowValue};
use crate::domain::{
    new_id, now_iso, AssetId, DocumentCommand, NodeId, NodeKind, NodePatch, PortDirection,
    ResultSlot, ResultSlotStatus, RunId, RunRecord, RunStatus, RunStepRecord, ValidationIssue,
    WorkflowNode,
};
use crate::project::store::FsProjectStore;
use crate::project::{ProjectError, ProjectStore};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex};

pub struct RunManager {
    store: Arc<FsProjectStore>,
    executors: Vec<Arc<dyn WorkflowExecutor>>,
    enabled_executors: Vec<String>,
    gate: tokio::sync::Mutex<()>,
    /// Serializes status transitions between the driver and cancel requests.
    transitions: tokio::sync::Mutex<()>,
    cancel_requests: Mutex<HashSet<RunId>>,
}

#[derive(Debug)]
pub enum StartRunError {
    Validation(Vec<ValidationIssue>),
    Store(ProjectError),
}

impl From<ProjectError> for StartRunError {
    fn from(error: ProjectError) -> Self {
        Self::Store(error)
    }
}

struct StepArtifacts {
    text: Option<String>,
    assets: Option<Vec<AssetId>>,
}

impl RunManager {
    pub fn new(
        store: Arc<FsProjectStore>,
        executors: Vec<Arc<dyn WorkflowExecutor>>,
        enabled_executors: Vec<String>,
    ) -> Arc<Self> {
        Arc::new(Self {
            store,
            executors,
            enabled_executors,
            gate: tokio::sync::Mutex::new(()),
            transitions: tokio::sync::Mutex::new(()),
            cancel_requests: Mutex::new(HashSet::new()),
        })
    }

    /// Validates the request against the current document, persists the
    /// queued record, and hands the run to the driver task.
    pub async fn start(
        self: &Arc<Self>,
        canvas_id: &str,
        node_ids: Vec<NodeId>,
        retry_of_run_id: Option<RunId>,
    ) -> Result<RunRecord, StartRunError> {
        let opened = self
            .store
            .current()
            .await?
            .ok_or_else(|| ProjectError::domain("PROJECT_NOT_OPEN", "No project is open"))?;
        let snapshot = validate_run(
            &opened.root,
            &opened.moka,
            canvas_id,
            &node_ids,
            &self.executors,
            &self.enabled_executors,
        )
        .await
        .map_err(StartRunError::Validation)?;

        let executor_key = node_ids
            .first()
            .and_then(|id| snapshot.nodes.get(id))
            .and_then(|node| node.data.executor_key.clone())
            .unwrap_or_default();
        let mut parameters = serde_json::Map::new();
        for node_id in &node_ids {
            if let Some(node) = snapshot.nodes.get(node_id) {
                parameters.insert(
                    node.id.clone(),
                    node.data
                        .parameters
                        .clone()
                        .unwrap_or(serde_json::Value::Null),
                );
            }
        }

        let now = now_iso();
        let run = RunRecord {
            id: new_id(),
            project_id: opened.moka.metadata.id.clone(),
            canvas_id: canvas_id.to_string(),
            requested_node_ids: node_ids,
            status: RunStatus::Queued,
            executor_key,
            graph_hash: snapshot.graph_hash.clone(),
            parameters: serde_json::Value::Object(parameters),
            retry_of_run_id,
            steps: snapshot
                .order
                .iter()
                .map(|node_id| RunStepRecord {
                    node_id: node_id.clone(),
                    status: RunStatus::Queued,
                    started_at: None,
                    finished_at: None,
                    error: None,
                    output_asset_ids: None,
                    output_text: None,
                })
                .collect(),
            error: None,
            cancel_requested: false,
            created_at: now.clone(),
            updated_at: now,
        };
        let run = self.store.create_run(run).await?;

        let driver = Arc::clone(self);
        let run_id = run.id.clone();
        tokio::spawn(async move {
            driver.drive(run_id, snapshot).await;
        });
        Ok(run)
    }

    /// A retry is a brand-new run linked to its predecessor; it revalidates
    /// against the current document rather than trusting the old snapshot.
    pub async fn retry(self: &Arc<Self>, run_id: &str) -> Result<RunRecord, StartRunError> {
        let run = self.store.get_run(run_id).await?;
        if !matches!(run.status, RunStatus::Failed | RunStatus::Cancelled) {
            return Err(ProjectError::domain(
                "RUN_NOT_RETRYABLE",
                "Only failed or cancelled runs can be retried",
            )
            .into());
        }
        self.start(
            &run.canvas_id.clone(),
            run.requested_node_ids.clone(),
            Some(run.id.clone()),
        )
        .await
    }

    pub async fn cancel(&self, run_id: &str) -> Result<RunRecord, ProjectError> {
        let _guard = self.transitions.lock().await;
        let run = self.store.get_run(run_id).await?;
        match run.status {
            RunStatus::Queued => {
                let mut run = run;
                run.status = RunStatus::Cancelled;
                run.cancel_requested = true;
                for step in &mut run.steps {
                    if step.status == RunStatus::Queued {
                        step.status = RunStatus::Cancelled;
                    }
                }
                run.updated_at = now_iso();
                self.store.update_run(run).await
            }
            RunStatus::Running => {
                let owned = run_id.to_string();
                self.cancel_requests
                    .lock()
                    .expect("cancel registry poisoned")
                    .insert(owned.clone());
                for executor in &self.executors {
                    let _ = executor.cancel(&owned).await;
                }
                let mut run = run;
                run.cancel_requested = true;
                Ok(run)
            }
            _ => Err(ProjectError::domain(
                "RUN_NOT_CANCELLABLE",
                "The run has already finished",
            )),
        }
    }

    fn cancellation_requested(&self, run_id: &str) -> bool {
        self.cancel_requests
            .lock()
            .expect("cancel registry poisoned")
            .contains(run_id)
    }

    async fn drive(self: Arc<Self>, run_id: RunId, snapshot: RunSnapshot) {
        let _gate = self.gate.lock().await;
        let mut run = {
            let _guard = self.transitions.lock().await;
            match self.store.get_run(&run_id).await {
                Ok(run) if run.status == RunStatus::Queued => {
                    let mut run = run;
                    run.status = RunStatus::Running;
                    run.updated_at = now_iso();
                    match self.store.update_run(run).await {
                        Ok(run) => run,
                        Err(error) => {
                            tracing::warn!("run {run_id}: could not mark running: {error}");
                            return;
                        }
                    }
                }
                // Cancelled while waiting for the gate; nothing to do.
                _ => return,
            }
        };

        let mut outputs: HashMap<NodeId, WorkflowValue> = HashMap::new();
        let mut halt: Option<(RunStatus, Option<String>)> = None;

        for (position, node_id) in snapshot.order.iter().enumerate() {
            if self.cancellation_requested(&run_id) {
                halt = Some((RunStatus::Cancelled, None));
                break;
            }
            let node = &snapshot.nodes[node_id];
            run.steps[position].status = RunStatus::Running;
            run.steps[position].started_at = Some(now_iso());
            run.updated_at = now_iso();
            if let Err(error) = self.store.update_run(run.clone()).await {
                tracing::warn!("run {run_id}: could not persist step start: {error}");
            }

            let outcome = self.execute_step(&run, &snapshot, node, &outputs).await;
            run.steps[position].finished_at = Some(now_iso());
            match outcome {
                Ok((value, artifacts)) => {
                    run.steps[position].status = RunStatus::Succeeded;
                    run.steps[position].output_text = artifacts.text;
                    run.steps[position].output_asset_ids = artifacts.assets;
                    if node.kind == NodeKind::Operation {
                        let text = run.steps[position].output_text.clone().unwrap_or_default();
                        self.promote_result(&snapshot, node, Ok(text)).await;
                    }
                    if let Some(value) = value {
                        outputs.insert(node_id.clone(), value);
                    }
                }
                Err(error) => {
                    if error.cancelled {
                        run.steps[position].status = RunStatus::Cancelled;
                        halt = Some((RunStatus::Cancelled, None));
                    } else {
                        run.steps[position].status = RunStatus::Failed;
                        run.steps[position].error = Some(error.message.clone());
                        halt = Some((
                            RunStatus::Failed,
                            Some(format!("\"{}\": {}", node.title, error.message)),
                        ));
                        // A cancellation produced no output; only genuine
                        // failures mark the node's result slot as failed.
                        if node.kind == NodeKind::Operation {
                            self.promote_result(&snapshot, node, Err(error.message.clone()))
                                .await;
                        }
                    }
                    run.updated_at = now_iso();
                    let _ = self.store.update_run(run.clone()).await;
                    break;
                }
            }
            run.updated_at = now_iso();
            if let Err(error) = self.store.update_run(run.clone()).await {
                tracing::warn!("run {run_id}: could not persist step result: {error}");
            }
        }

        let (status, error) = halt.unwrap_or((RunStatus::Succeeded, None));
        {
            let _guard = self.transitions.lock().await;
            for step in &mut run.steps {
                if matches!(step.status, RunStatus::Queued | RunStatus::Running) {
                    step.status = RunStatus::Cancelled;
                }
            }
            run.status = status;
            run.error = error;
            if status == RunStatus::Cancelled {
                run.cancel_requested = true;
            }
            run.updated_at = now_iso();
            if let Err(error) = self.store.update_run(run).await {
                tracing::warn!("run {run_id}: could not persist final state: {error}");
            }
        }
        self.cancel_requests
            .lock()
            .expect("cancel registry poisoned")
            .remove(&run_id);
    }

    async fn execute_step(
        &self,
        run: &RunRecord,
        snapshot: &RunSnapshot,
        node: &WorkflowNode,
        outputs: &HashMap<NodeId, WorkflowValue>,
    ) -> Result<(Option<WorkflowValue>, StepArtifacts), super::ExecutionError> {
        if node.kind != NodeKind::Operation {
            let value = snapshot.source_value(&node.id);
            let artifacts = match &value {
                Some(WorkflowValue::Text { text, .. }) => StepArtifacts {
                    text: Some(text.clone()),
                    assets: None,
                },
                Some(WorkflowValue::Media { asset_id, .. })
                | Some(WorkflowValue::Artifact { asset_id, .. }) => StepArtifacts {
                    text: None,
                    assets: Some(vec![asset_id.clone()]),
                },
                None => StepArtifacts {
                    text: None,
                    assets: None,
                },
            };
            return Ok((value, artifacts));
        }

        let operation_type = node.data.operation_type.clone().unwrap_or_default();
        let executor = self
            .executors
            .iter()
            .find(|executor| executor.supports(&operation_type))
            .ok_or_else(|| super::ExecutionError {
                code: "OPERATION_UNSUPPORTED",
                message: format!("No executor supports \"{operation_type}\""),
                retryable: false,
                cancelled: false,
            })?;

        let mut inputs: BTreeMap<String, Vec<WorkflowValue>> = BTreeMap::new();
        for edge in snapshot.edges_for_target(&node.id) {
            if let Some(value) = outputs.get(&edge.source.node_id) {
                inputs
                    .entry(edge.target.port_id.clone())
                    .or_default()
                    .push(value.clone());
            }
        }
        for port in &node.ports {
            if port.direction == PortDirection::Input {
                inputs.entry(port.id.clone()).or_default();
            }
        }

        let request = ExecutionRequest {
            run_id: run.id.clone(),
            node_id: node.id.clone(),
            operation_type,
            parameters: node
                .data
                .parameters
                .clone()
                .unwrap_or(serde_json::Value::Null),
            inputs,
        };
        let output = executor
            .execute(request, ProgressReporter::default())
            .await?;
        let text = output.text;
        let value = text.clone().map(|text| WorkflowValue::Text {
            text,
            source: ValueProvenance {
                node_id: node.id.clone(),
                port_id: "out".to_string(),
            },
        });
        Ok((value, StepArtifacts { text, assets: None }))
    }

    /// Writes the operation's result slot through the command pipeline so the
    /// document stays the single source of truth. Best-effort: the run record
    /// keeps the output even when the node vanished or the revision keeps
    /// conflicting under concurrent edits.
    async fn promote_result(
        &self,
        snapshot: &RunSnapshot,
        node: &WorkflowNode,
        outcome: Result<String, String>,
    ) {
        for attempt in 0..5 {
            let current = match self.store.current().await {
                Ok(Some(opened)) => opened,
                _ => return,
            };
            let Some(live) = current
                .moka
                .canvas(&snapshot.canvas_id)
                .and_then(|canvas| canvas.node(&node.id))
            else {
                return;
            };
            let mut data = live.data.clone();
            let slot = match &outcome {
                Ok(text) => ResultSlot {
                    id: "result".to_string(),
                    status: ResultSlotStatus::Succeeded,
                    asset_id: None,
                    text: Some(text.clone()),
                    error: None,
                    is_primary: true,
                },
                Err(message) => ResultSlot {
                    id: "result".to_string(),
                    status: ResultSlotStatus::Failed,
                    asset_id: None,
                    text: None,
                    error: Some(message.clone()),
                    is_primary: true,
                },
            };
            data.result_slots = Some(vec![slot]);
            let result = self
                .store
                .apply_commands(
                    current.moka.metadata.revision,
                    vec![DocumentCommand::UpdateNode {
                        canvas_id: snapshot.canvas_id.clone(),
                        node_id: node.id.clone(),
                        patch: NodePatch {
                            title: None,
                            z_index: None,
                            data: Some(data),
                        },
                    }],
                )
                .await;
            match result {
                Ok(_) => return,
                Err(error) if error.code() == "REVISION_CONFLICT" && attempt < 4 => continue,
                Err(error) => {
                    tracing::warn!("run: result promotion failed for node {}: {error}", node.id);
                    return;
                }
            }
        }
    }
}
