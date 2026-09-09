//! The run manager: owns the run lifecycle (queue, drive, cancel, retry) and
//! persists every transition through the project store. One run drives at a
//! time; the driver is the single writer of a running record, so cancel
//! requests arrive through an in-memory flag the driver observes between and
//! during steps.

use super::validate::{validate_run, RunSnapshot};
use super::{
    data_type_for, executor_key_for, operation_type_for, ExecutionError, ExecutionOutput,
    ExecutionRequest, ProgressReporter, ValueProvenance, WorkflowExecutor, WorkflowValue,
};
use crate::domain::commands::make_node;
use crate::domain::validate::MAX_TITLE_LENGTH;
use crate::domain::{
    new_id, now_iso, AssetId, CanvasDocument, DataType, DocumentCommand, MokaFile, NodeId,
    NodeKind, NodePatch, PortDirection, ResultSlot, ResultSlotStatus, RunId, RunRecord, RunStatus,
    RunStepRecord, ValidationIssue, WorkflowNode,
};
use crate::generate::{ingest_generated, AsyncTask, GenerateResult};
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

/// What one step leaves behind: what to write on the run record, and what the
/// node downstream reads.
struct StepArtifacts {
    text: Option<String>,
    assets: Option<Vec<AssetId>>,
    /// The upstream job the step went through, for the ones that are a job
    /// rather than an answer waited out.
    task: Option<AsyncTask>,
}

/// How far to the right of a node the results past its first are placed, and how
/// far apart from each other: enough that the cards do not overlap, close enough
/// that the set still reads as one answer.
const RESULT_GAP: f64 = 40.0;

/// What a finished step leaves on the node that made it.
///
/// Kept apart from the run record on purpose. The record says what happened;
/// this says what the canvas looks like afterwards, and a node that only passed
/// a value through has nothing to say about either.
enum Promotion {
    /// An answer in words, and the asset it was filed as when it was filed.
    Words {
        text: String,
        asset_id: Option<AssetId>,
    },
    /// Media, in the order the provider gave it. The first is the node's own;
    /// the rest get a node each.
    Assets(Vec<AssetId>),
    /// Nothing worth keeping, and why.
    Failed(String),
}

/// What one succeeded step writes back, or `None` for a step that made nothing
/// to keep.
fn promotion_for(node: &WorkflowNode, artifacts: &StepArtifacts) -> Option<Promotion> {
    // Only a node an executor ran made anything. What a written text node or a
    // bound image already carries is its own, and a run did not add to it.
    executor_key_for(node)?;
    let assets = artifacts.assets.clone().unwrap_or_default();
    match node.kind {
        NodeKind::Image | NodeKind::Audio | NodeKind::Video => {
            // An answer with no asset in it leaves the node holding what it
            // held: there is nothing to point a card at.
            (!assets.is_empty()).then_some(Promotion::Assets(assets))
        }
        _ => Some(Promotion::Words {
            text: artifacts.text.clone().unwrap_or_default(),
            asset_id: assets.into_iter().next(),
        }),
    }
}

/// A slot's id. The first is simply the result; the ones past it are numbered,
/// because an inspector that lists them has something to call each by.
fn slot_id(index: usize) -> String {
    if index == 0 {
        "result".to_string()
    } else {
        format!("result-{}", index + 1)
    }
}

/// One result as the node that holds it records it.
fn succeeded(index: usize, asset_id: Option<AssetId>, text: Option<String>) -> ResultSlot {
    ResultSlot {
        id: slot_id(index),
        status: ResultSlotStatus::Succeeded,
        asset_id,
        text,
        error: None,
        is_primary: index == 0,
    }
}

fn failed(message: &str) -> ResultSlot {
    ResultSlot {
        id: slot_id(0),
        status: ResultSlotStatus::Failed,
        asset_id: None,
        text: None,
        error: Some(message.to_string()),
        is_primary: true,
    }
}

/// The nodes for the results past the first, and the ids to record on the node
/// that asked for them.
///
/// A result that already has a node from an earlier run keeps it, updated rather
/// than replaced, so a card the user moved stays where they put it and a re-run
/// does not litter the canvas with a second set. Nothing is ever removed: a node
/// on the canvas is the user's to delete, and a run that asked for fewer results
/// this time does not get to take one away.
fn result_nodes(
    canvas: &CanvasDocument,
    live: &WorkflowNode,
    extra: &[AssetId],
) -> (Vec<DocumentCommand>, Vec<NodeId>) {
    let mut commands = Vec::new();
    let mut ids = Vec::new();
    let previous = live.data.result_node_ids.clone().unwrap_or_default();
    for (index, asset_id) in extra.iter().enumerate() {
        let slots = Some(vec![succeeded(0, Some(asset_id.clone()), None)]);
        let id = match previous.get(index).and_then(|id| canvas.node(id)) {
            Some(child) => {
                let mut data = child.data.clone();
                data.asset_id = Some(asset_id.clone());
                data.result_slots = slots;
                commands.push(DocumentCommand::UpdateNode {
                    canvas_id: canvas.id.clone(),
                    node_id: child.id.clone(),
                    patch: NodePatch {
                        title: None,
                        z_index: None,
                        data: Some(data),
                    },
                });
                child.id.clone()
            }
            None => {
                let mut child = make_node(
                    live.kind,
                    card_title(&live.title, index + 2),
                    live.bounds.x + (live.bounds.width + RESULT_GAP) * (index as f64 + 1.0),
                    live.bounds.y,
                );
                child.data.asset_id = Some(asset_id.clone());
                child.data.result_slots = slots;
                // A card is made with the defaults for its kind, which call
                // every audio music; the node that asked for it knows better.
                child.data.audio_category = live.data.audio_category.clone();
                commands.push(DocumentCommand::AddNode {
                    canvas_id: canvas.id.clone(),
                    node: child.clone(),
                });
                child.id
            }
        };
        ids.push(id);
    }
    // Cards this run did not reach stay listed. They are still on the canvas,
    // and the next run that asks for more results reuses them rather than
    // adding a second set beside them.
    ids.extend(
        previous
            .iter()
            .skip(extra.len())
            .filter(|id| canvas.node(id).is_some())
            .cloned(),
    );
    (commands, ids)
}

/// A generated card's title: the node it came from, numbered. Shortened from the
/// parent's title when that alone would take the whole limit, since a title past
/// it is refused and would cost the whole write.
fn card_title(parent: &str, number: usize) -> String {
    let suffix = format!(" {number}");
    let room = MAX_TITLE_LENGTH.saturating_sub(suffix.chars().count());
    let mut title: String = parent.chars().take(room).collect();
    title.push_str(&suffix);
    title
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
            .and_then(executor_key_for)
            .unwrap_or_default()
            .to_string();
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
                    task_id: None,
                    task_created_at: None,
                    progress: None,
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

        // The snapshot is written to as the run goes, so the order it is walked
        // in is taken out first: a step's answer has to reach the step after it,
        // and the order is the one thing about the walk that must not change.
        let mut snapshot = snapshot;
        let order = snapshot.order.clone();
        let mut outputs: HashMap<NodeId, WorkflowValue> = HashMap::new();
        let mut halt: Option<(RunStatus, Option<String>)> = None;

        for (position, node_id) in order.iter().enumerate() {
            if self.cancellation_requested(&run_id) {
                halt = Some((RunStatus::Cancelled, None));
                break;
            }
            run.steps[position].status = RunStatus::Running;
            run.steps[position].started_at = Some(now_iso());
            run.updated_at = now_iso();
            if let Err(error) = self.store.update_run(run.clone()).await {
                tracing::warn!("run {run_id}: could not persist step start: {error}");
            }

            let outcome = self.execute_step(&run, &snapshot, node_id, &outputs).await;
            run.steps[position].finished_at = Some(now_iso());
            match outcome {
                Ok((value, artifacts)) => {
                    // Decided before the artifacts are moved into the record.
                    let promotion = promotion_for(&snapshot.nodes[node_id], &artifacts);
                    let step = &mut run.steps[position];
                    step.status = RunStatus::Succeeded;
                    step.output_text = artifacts.text;
                    step.output_asset_ids = artifacts.assets;
                    step.task_id = artifacts.task.as_ref().map(|task| task.id.clone());
                    step.task_created_at = artifacts.task.map(|task| task.created_at);
                    if let Some(promotion) = promotion {
                        self.promote_result(&snapshot, node_id, promotion).await;
                    }
                    if let Some(value) = value {
                        snapshot.record_output(node_id, &value);
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
                        let title = &snapshot.nodes[node_id].title;
                        halt = Some((
                            RunStatus::Failed,
                            Some(format!("\"{title}\": {}", error.message)),
                        ));
                        // A cancellation produced no output. Only a step an
                        // executor ran can fail, so there is no kind to check.
                        self.promote_result(
                            &snapshot,
                            node_id,
                            Promotion::Failed(error.message.clone()),
                        )
                        .await;
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

    /// Runs one scheduled node.
    ///
    /// A node with nothing an executor could do passes the value it already had
    /// downstream, which is how written words or a bound image reach the step
    /// after them. Everything else goes to the executor it names, and a
    /// generation's answer is filed in the project before any of it travels on:
    /// what flows between nodes is an asset reference, never the bytes.
    async fn execute_step(
        &self,
        run: &RunRecord,
        snapshot: &RunSnapshot,
        node_id: &str,
        outputs: &HashMap<NodeId, WorkflowValue>,
    ) -> Result<(Option<WorkflowValue>, StepArtifacts), ExecutionError> {
        let node = &snapshot.nodes[node_id];
        let source = ValueProvenance {
            node_id: node.id.clone(),
            port_id: "out".to_string(),
        };
        let Some(executor_key) = executor_key_for(node) else {
            let value = snapshot.source_value(&node.id);
            let artifacts = match &value {
                Some(WorkflowValue::Text { text, .. }) => StepArtifacts {
                    text: Some(text.clone()),
                    assets: None,
                    task: None,
                },
                Some(WorkflowValue::Media { asset_id, .. })
                | Some(WorkflowValue::Artifact { asset_id, .. }) => StepArtifacts {
                    text: None,
                    assets: Some(vec![asset_id.clone()]),
                    task: None,
                },
                None => StepArtifacts {
                    text: None,
                    assets: None,
                    task: None,
                },
            };
            return Ok((value, artifacts));
        };

        let operation_type = operation_type_for(node);
        let executor = self
            .executors
            .iter()
            // Both halves matter: an executor that would take the operation but
            // is not the one the node named would run a step the document never
            // asked for.
            .find(|executor| executor.key() == executor_key && executor.supports(&operation_type))
            .ok_or_else(|| ExecutionError {
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

        // Resolved once here rather than in the executor: the same reading of
        // the graph builds the request and stamps the answer that comes back,
        // so the two cannot disagree about what fed it.
        let resolved = snapshot.generation_inputs(&node.id);
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
            generation: node
                .data
                .generation
                .as_ref()
                .map(|spec| resolved.request_for(spec)),
        };
        let ExecutionOutput { text, items, task } = executor
            .execute(request, ProgressReporter::default())
            .await?;

        if node.data.generation.is_none() {
            let value = text
                .clone()
                .map(|text| WorkflowValue::Text { text, source });
            return Ok((
                value,
                StepArtifacts {
                    text,
                    assets: None,
                    task: None,
                },
            ));
        }

        let result = GenerateResult {
            text: text.clone(),
            items,
            usage: None,
        };
        let entries = ingest_generated(self.store.as_ref(), run, node, &resolved, &result)
            .await
            .map_err(|error| ExecutionError {
                code: error.code(),
                message: error.to_string(),
                // The provider already answered; what failed is filing the
                // answer. Retrying the step would pay for a second generation
                // to fix a problem on this disk.
                retryable: false,
                cancelled: false,
            })?;
        let assets: Vec<AssetId> = entries.into_iter().map(|entry| entry.id).collect();
        let value = match assets.first() {
            // A picture, a voice or a shot travels as the asset it became.
            // Words travel as words, whether or not filing them made a text
            // asset of its own.
            Some(asset_id) if data_type_for(node.kind) != DataType::Text => {
                Some(WorkflowValue::Media {
                    media_type: data_type_for(node.kind),
                    asset_id: asset_id.clone(),
                    source,
                })
            }
            _ => text
                .clone()
                .map(|text| WorkflowValue::Text { text, source }),
        };
        Ok((
            value,
            StepArtifacts {
                text,
                assets: if assets.is_empty() {
                    None
                } else {
                    Some(assets)
                },
                task,
            },
        ))
    }

    /// Writes a step's result onto the node that made it, through the command
    /// pipeline so the document stays the single source of truth.
    ///
    /// Best-effort: the run record keeps the output even when the node vanished
    /// or the write could not land, and a result the canvas cannot show is not
    /// worth failing a run over.
    async fn promote_result(&self, snapshot: &RunSnapshot, node_id: &str, promotion: Promotion) {
        let canvas_id = snapshot.canvas_id.clone();
        let node_id = node_id.to_string();
        self.write_live(
            &format!("run: result promotion for node {node_id}"),
            |moka| promotion_commands(moka, &canvas_id, &node_id, &promotion),
        )
        .await;
    }

    /// Applies a write built from the document as it is right now, rebuilding it
    /// from a fresh read whenever the document moved in between.
    async fn write_live(
        &self,
        label: &str,
        build: impl Fn(&MokaFile) -> Option<Vec<DocumentCommand>>,
    ) {
        for _ in 0..5 {
            let current = match self.store.current().await {
                Ok(Some(opened)) => opened,
                _ => return,
            };
            let revision = current.moka.metadata.revision;
            let Some(commands) = build(&current.moka) else {
                return;
            };
            match self.store.apply_commands(revision, commands).await {
                Ok(_) => return,
                Err(error) if error.code() == "REVISION_CONFLICT" => continue,
                Err(error) => {
                    tracing::warn!("{label}: {error}");
                    return;
                }
            }
        }
        tracing::warn!("{label}: the document kept moving");
    }
}

/// The commands one promotion is written with, built from the document as it
/// stands, or `None` when the node it belongs to is no longer there.
///
/// The cards for the results past the first come before the node that points at
/// them, and the whole set is a single batch: written apart, a crash between the
/// two would leave a slot with nothing behind it.
fn promotion_commands(
    moka: &MokaFile,
    canvas_id: &str,
    node_id: &str,
    promotion: &Promotion,
) -> Option<Vec<DocumentCommand>> {
    let canvas = moka.canvas(canvas_id)?;
    let live = canvas.node(node_id)?;
    let mut data = live.data.clone();
    let mut commands = Vec::new();
    match promotion {
        Promotion::Words { text, asset_id } => {
            // Only a text node carries words as its own content; for every other
            // kind the key is not written at all, and the words stay in the slot,
            // which is where a reader looks for them.
            if live.kind == NodeKind::Text {
                data.content = Some(text.clone());
            }
            data.result_slots = Some(vec![succeeded(0, asset_id.clone(), Some(text.clone()))]);
        }
        Promotion::Assets(assets) => {
            data.asset_id = assets.first().cloned();
            let (cards, ids) = result_nodes(canvas, live, assets.get(1..).unwrap_or(&[]));
            commands.extend(cards);
            data.result_node_ids = Some(ids);
            data.result_slots = Some(
                assets
                    .iter()
                    .enumerate()
                    .map(|(index, id)| succeeded(index, Some(id.clone()), None))
                    .collect(),
            );
        }
        // What the node held before is left where it was: a failed attempt says
        // why it failed, it does not take the last answer that worked away.
        Promotion::Failed(message) => data.result_slots = Some(vec![failed(message)]),
    }
    commands.push(DocumentCommand::UpdateNode {
        canvas_id: canvas_id.to_string(),
        node_id: node_id.to_string(),
        patch: NodePatch {
            title: None,
            z_index: None,
            data: Some(data),
        },
    });
    Some(commands)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::parse_test_config;
    use crate::domain::{
        derive_ports, generation_capability_for, now_iso, GenerationSpec, NodeData,
        ProjectMetadata, Rect, ResourceRegistry, MOKA_FILE_VERSION,
    };
    use crate::project::CreateProject;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tempfile::TempDir;

    fn node(kind: NodeKind, name: &str, data: NodeData) -> WorkflowNode {
        let mut node = make_node(kind, name.to_string(), 0.0, 0.0);
        node.id = format!("node-{name}");
        node.data = data;
        node
    }

    /// A node that asks a provider for something, which is the only kind of node
    /// a run has an answer to write back onto.
    fn asking(kind: NodeKind, name: &str) -> WorkflowNode {
        node(
            kind,
            name,
            NodeData {
                generation: Some(GenerationSpec {
                    capability: generation_capability_for(kind).expect("a media kind asks"),
                    ..GenerationSpec::default()
                }),
                ..NodeData::default()
            },
        )
    }

    /// A card an earlier run made, holding the answer it was given.
    fn card(id: &str, asset_id: &str) -> WorkflowNode {
        let mut card = node(
            NodeKind::Image,
            "card",
            NodeData {
                asset_id: Some(asset_id.to_string()),
                ..NodeData::default()
            },
        );
        card.id = id.to_string();
        card
    }

    fn document(nodes: Vec<WorkflowNode>) -> MokaFile {
        let mut canvas = CanvasDocument::empty("canvas-1".to_string(), "Canvas".to_string());
        canvas.nodes = nodes;
        let now = now_iso();
        MokaFile {
            version: MOKA_FILE_VERSION.to_string(),
            metadata: ProjectMetadata {
                id: "project-1".to_string(),
                name: "Project".to_string(),
                description: None,
                cover_path: None,
                revision: 1,
                created_at: now.clone(),
                updated_at: now,
            },
            resources: ResourceRegistry::default(),
            canvas: vec![canvas],
        }
    }

    fn written(moka: &MokaFile, name: &str, promotion: &Promotion) -> Vec<DocumentCommand> {
        promotion_commands(moka, "canvas-1", &format!("node-{name}"), promotion)
            .expect("the node is on the canvas")
    }

    fn data_of(command: &DocumentCommand) -> &NodeData {
        match command {
            DocumentCommand::UpdateNode { patch, .. } => patch
                .data
                .as_ref()
                .expect("a promotion writes the node's data"),
            DocumentCommand::AddNode { node, .. } => &node.data,
            _ => panic!("a promotion only writes nodes"),
        }
    }

    fn id_of(command: &DocumentCommand) -> &str {
        match command {
            DocumentCommand::UpdateNode { node_id, .. } => node_id,
            DocumentCommand::AddNode { node, .. } => &node.id,
            _ => panic!("a promotion only writes nodes"),
        }
    }

    fn patch_of(command: &DocumentCommand) -> &NodePatch {
        match command {
            DocumentCommand::UpdateNode { patch, .. } => patch,
            _ => panic!("an added node carries no patch"),
        }
    }

    fn slots_of(data: &NodeData) -> &Vec<ResultSlot> {
        data.result_slots.as_ref().expect("a result is recorded")
    }

    #[test]
    fn a_node_nothing_ran_has_nothing_to_write_back() {
        let nodes = [
            node(
                NodeKind::Text,
                "brief",
                NodeData {
                    content: Some("a lantern".to_string()),
                    ..NodeData::default()
                },
            ),
            node(
                NodeKind::Image,
                "still",
                NodeData {
                    asset_id: Some("asset-1".to_string()),
                    ..NodeData::default()
                },
            ),
        ];
        let artifacts = StepArtifacts {
            text: Some("words".to_string()),
            assets: Some(vec!["asset-2".to_string()]),
            task: None,
        };
        for node in &nodes {
            assert!(promotion_for(node, &artifacts).is_none(), "{}", node.title);
        }
    }

    #[test]
    fn an_answer_with_no_media_in_it_leaves_a_media_node_holding_what_it_held() {
        let poster = asking(NodeKind::Image, "poster");
        let artifacts = StepArtifacts {
            text: Some("a caption".to_string()),
            assets: None,
            task: None,
        };
        assert!(promotion_for(&poster, &artifacts).is_none());
    }

    #[test]
    fn words_go_into_a_text_node_and_onto_its_slot() {
        let moka = document(vec![asking(NodeKind::Text, "script")]);
        let commands = written(
            &moka,
            "script",
            &Promotion::Words {
                text: "A lantern drifts.".to_string(),
                asset_id: Some("asset-text".to_string()),
            },
        );
        assert_eq!(commands.len(), 1, "one node, one write");
        let data = data_of(&commands[0]);
        assert_eq!(data.content.as_deref(), Some("A lantern drifts."));
        let slots = slots_of(data);
        assert_eq!(slots.len(), 1);
        assert_eq!(slots[0].id, "result");
        assert_eq!(slots[0].status, ResultSlotStatus::Succeeded);
        assert_eq!(slots[0].text.as_deref(), Some("A lantern drifts."));
        assert_eq!(
            slots[0].asset_id.as_deref(),
            Some("asset-text"),
            "the text asset the words were filed as travels with them"
        );
        assert!(slots[0].is_primary);
    }

    #[test]
    fn words_reach_an_operation_node_through_its_slot_alone() {
        let join = node(
            NodeKind::Operation,
            "join",
            NodeData {
                operation_type: Some("deterministic.text".to_string()),
                executor_key: Some("deterministic".to_string()),
                ..NodeData::default()
            },
        );
        let moka = document(vec![join]);
        let commands = written(
            &moka,
            "join",
            &Promotion::Words {
                text: "Joined.".to_string(),
                asset_id: None,
            },
        );
        let data = data_of(&commands[0]);
        // An operation node has no words of its own, and the document only ever
        // carries a content key on a text node.
        assert!(data.content.is_none());
        assert_eq!(slots_of(data)[0].text.as_deref(), Some("Joined."));
    }

    #[test]
    fn one_picture_backfills_the_node_that_asked_for_it() {
        let moka = document(vec![asking(NodeKind::Image, "poster")]);
        let commands = written(
            &moka,
            "poster",
            &Promotion::Assets(vec!["asset-1".to_string()]),
        );
        assert_eq!(commands.len(), 1, "nothing beside the node itself");
        let data = data_of(&commands[0]);
        assert_eq!(data.asset_id.as_deref(), Some("asset-1"));
        assert!(data
            .result_node_ids
            .clone()
            .expect("the list is written")
            .is_empty());
        let slots = slots_of(data);
        assert_eq!(slots.len(), 1);
        assert_eq!(slots[0].asset_id.as_deref(), Some("asset-1"));
        assert!(slots[0].text.is_none());
        assert!(slots[0].is_primary);
    }

    #[test]
    fn three_pictures_fill_the_node_and_get_a_card_each() {
        let moka = document(vec![asking(NodeKind::Image, "poster")]);
        let assets: Vec<AssetId> = (1..=3).map(|index| format!("asset-{index}")).collect();
        let commands = written(&moka, "poster", &Promotion::Assets(assets.clone()));
        assert_eq!(
            commands.len(),
            3,
            "two cards and the node that points at them"
        );
        // The cards come first: written the other way round, a crash in between
        // leaves a slot pointing at a node that was never added.
        assert!(matches!(commands[0], DocumentCommand::AddNode { .. }));
        assert!(matches!(commands[1], DocumentCommand::AddNode { .. }));
        assert!(matches!(commands[2], DocumentCommand::UpdateNode { .. }));

        let parent = data_of(&commands[2]);
        assert_eq!(
            parent.asset_id.as_deref(),
            Some("asset-1"),
            "the first answer is the node's own"
        );
        let slots = slots_of(parent);
        assert_eq!(slots.len(), 3);
        for (index, slot) in slots.iter().enumerate() {
            assert_eq!(slot.status, ResultSlotStatus::Succeeded);
            assert_eq!(
                slot.asset_id.as_deref(),
                Some(assets[index].as_str()),
                "every answer is still named"
            );
            assert_eq!(slot.is_primary, index == 0);
        }
        let ids: Vec<&str> = slots.iter().map(|slot| slot.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["result", "result-2", "result-3"],
            "an inspector lists them by these, so they are not all the same"
        );

        let cards = parent
            .result_node_ids
            .clone()
            .expect("the cards are recorded");
        assert_eq!(cards.len(), 2);
        let mut left = 280.0;
        for (index, command) in commands.iter().take(2).enumerate() {
            let DocumentCommand::AddNode { node, .. } = command else {
                panic!("checked above");
            };
            assert_eq!(node.id, cards[index]);
            assert_eq!(
                node.kind,
                NodeKind::Image,
                "a card is the same kind of thing"
            );
            assert_eq!(node.title, format!("poster {}", index + 2));
            assert_eq!(node.ports, derive_ports(NodeKind::Image));
            assert!(
                node.data.generation.is_none(),
                "a card holds an answer, it does not ask for one"
            );
            assert_eq!(
                node.data.asset_id.as_deref(),
                Some(assets[index + 1].as_str())
            );
            let card_slots = slots_of(&node.data);
            assert_eq!(card_slots.len(), 1);
            assert_eq!(
                card_slots[0].asset_id.as_deref(),
                Some(assets[index + 1].as_str())
            );
            assert!(
                card_slots[0].is_primary,
                "a card's own answer is its primary"
            );
            // Beside the node that asked, then beside each other, on the same line.
            assert!(node.bounds.x > left, "{}", node.bounds.x);
            assert_eq!(node.bounds.y, 0.0);
            left = node.bounds.x + node.bounds.width;
        }
    }

    #[test]
    fn a_card_says_which_kind_of_audio_it_holds() {
        let mut voice = asking(NodeKind::Audio, "voice");
        voice.data.audio_category = Some("voice".to_string());
        let moka = document(vec![voice]);
        let commands = written(
            &moka,
            "voice",
            &Promotion::Assets(vec!["asset-1".to_string(), "asset-2".to_string()]),
        );
        let DocumentCommand::AddNode { node, .. } = &commands[0] else {
            panic!("the second answer gets a card");
        };
        assert_eq!(node.kind, NodeKind::Audio);
        assert_eq!(
            node.data.audio_category.as_deref(),
            Some("voice"),
            "a card is made for the node that asked, not for its kind in general"
        );
    }

    #[test]
    fn a_re_run_writes_into_the_cards_it_made_last_time() {
        let mut poster = asking(NodeKind::Image, "poster");
        poster.data.result_node_ids = Some(vec!["node-kept".to_string(), "node-gone".to_string()]);
        let mut kept = card("node-kept", "asset-old");
        kept.title = "The one I moved".to_string();
        kept.bounds = Rect {
            x: 900.0,
            y: 500.0,
            width: 280.0,
            height: 200.0,
        };
        let moka = document(vec![poster, kept]);
        let assets = vec![
            "asset-new".to_string(),
            "asset-second".to_string(),
            "asset-third".to_string(),
        ];
        let commands = written(&moka, "poster", &Promotion::Assets(assets.clone()));
        assert_eq!(commands.len(), 3, "one card is written into, one is made");

        assert_eq!(id_of(&commands[0]), "node-kept");
        assert!(matches!(commands[0], DocumentCommand::UpdateNode { .. }));
        assert_eq!(
            data_of(&commands[0]).asset_id.as_deref(),
            Some("asset-second")
        );
        let patch = patch_of(&commands[0]);
        assert!(
            patch.title.is_none() && patch.z_index.is_none(),
            "a card the user renamed and moved keeps both"
        );

        let DocumentCommand::AddNode { node, .. } = &commands[1] else {
            panic!("the card that is gone is made again");
        };
        assert_eq!(node.data.asset_id.as_deref(), Some("asset-third"));

        let parent = data_of(&commands[2]);
        assert_eq!(slots_of(parent).len(), 3, "every answer is still named");
        let cards = parent
            .result_node_ids
            .clone()
            .expect("the cards are recorded");
        assert_eq!(cards, vec!["node-kept".to_string(), node.id.clone()]);
    }

    #[test]
    fn cards_a_shorter_re_run_did_not_reach_stay_listed() {
        let mut poster = asking(NodeKind::Image, "poster");
        poster.data.result_node_ids = Some(vec!["node-a".to_string(), "node-b".to_string()]);
        let moka = document(vec![
            poster,
            card("node-a", "asset-old-a"),
            card("node-b", "asset-old-b"),
        ]);
        let commands = written(
            &moka,
            "poster",
            &Promotion::Assets(vec!["asset-1".to_string()]),
        );
        assert_eq!(
            commands.len(),
            1,
            "no card is written and none is taken away"
        );
        let data = data_of(&commands[0]);
        assert_eq!(slots_of(data).len(), 1, "the node holds the one answer");
        assert_eq!(
            data.result_node_ids
                .clone()
                .expect("the cards are recorded"),
            vec!["node-a".to_string(), "node-b".to_string()],
            "the next run that asks for more reuses them instead of adding a second set"
        );
    }

    #[test]
    fn a_failed_attempt_says_why_and_leaves_the_node_holding_what_it_held() {
        let mut script = asking(NodeKind::Text, "script");
        script.data.content = Some("An earlier answer.".to_string());
        script.data.result_slots = Some(vec![succeeded(
            0,
            None,
            Some("An earlier answer.".to_string()),
        )]);
        let moka = document(vec![script]);
        let commands = written(
            &moka,
            "script",
            &Promotion::Failed("The provider refused.".to_string()),
        );
        assert_eq!(commands.len(), 1);
        let data = data_of(&commands[0]);
        assert_eq!(
            data.content.as_deref(),
            Some("An earlier answer."),
            "the last answer that worked stays on the card"
        );
        assert!(data.asset_id.is_none(), "a failure files nothing");
        let slots = slots_of(data);
        assert_eq!(slots.len(), 1);
        assert_eq!(slots[0].status, ResultSlotStatus::Failed);
        assert_eq!(slots[0].error.as_deref(), Some("The provider refused."));
        assert!(slots[0].text.is_none());
        assert!(slots[0].is_primary);
    }

    #[test]
    fn a_node_that_is_no_longer_on_the_canvas_has_nothing_to_write() {
        let moka = document(vec![asking(NodeKind::Text, "script")]);
        let promotion = Promotion::Words {
            text: "words".to_string(),
            asset_id: None,
        };
        assert!(promotion_commands(&moka, "canvas-1", "node-gone", &promotion).is_none());
        assert!(promotion_commands(&moka, "canvas-gone", "node-script", &promotion).is_none());
    }

    #[test]
    fn a_card_title_never_outgrows_the_limit_a_node_is_held_to() {
        let title = card_title(&"lantern".repeat(80), 2);
        assert_eq!(title.chars().count(), MAX_TITLE_LENGTH);
        assert!(title.ends_with(" 2"), "it still says which card it is");
        assert_eq!(card_title("Poster", 3), "Poster 3");
    }

    /// Opens a project on a temporary directory and a run manager over it, with
    /// no executors: what is under test here is the write, not the running.
    async fn manager_over(tmp: &TempDir) -> Arc<RunManager> {
        let config = Arc::new(parse_test_config(tmp.path()));
        let store = Arc::new(FsProjectStore::new(config));
        store
            .create_project(
                &tmp.path().join("demo"),
                CreateProject {
                    name: "Demo".to_string(),
                },
            )
            .await
            .expect("the project opens");
        RunManager::new(store, Vec::new(), Vec::new())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_write_rebuilds_itself_when_the_document_moves_under_it() {
        let tmp = TempDir::new().expect("a temporary directory");
        let manager = manager_over(&tmp).await;
        let store = Arc::clone(&manager.store);
        let canvas_id = {
            let opened = store.current().await.expect("read").expect("open");
            let canvas_id = opened.moka.canvas[0].id.clone();
            let mut script = make_node(NodeKind::Text, "Script".to_string(), 0.0, 0.0);
            script.id = "node-script".to_string();
            store
                .apply_commands(
                    opened.moka.metadata.revision,
                    vec![DocumentCommand::AddNode {
                        canvas_id: canvas_id.clone(),
                        node: script,
                    }],
                )
                .await
                .expect("the node is added");
            canvas_id
        };

        let handle = tokio::runtime::Handle::current();
        let competing = Arc::clone(&store);
        let attempts = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&attempts);
        let promotion = Promotion::Words {
            text: "An answer.".to_string(),
            asset_id: None,
        };
        manager
            .write_live("test", |moka| {
                // The first read is the one an edit lands behind: the rename goes
                // in after the document was read and before what was built from
                // it is applied, which is the race the retry is there for.
                if counted.fetch_add(1, Ordering::SeqCst) == 0 {
                    let rename = DocumentCommand::UpdateNode {
                        canvas_id: moka.canvas[0].id.clone(),
                        node_id: "node-script".to_string(),
                        patch: NodePatch {
                            title: Some("Renamed while it ran".to_string()),
                            z_index: None,
                            data: None,
                        },
                    };
                    let store = Arc::clone(&competing);
                    let revision = moka.metadata.revision;
                    tokio::task::block_in_place(|| {
                        handle
                            .block_on(store.apply_commands(revision, vec![rename]))
                            .expect("the competing edit lands");
                    });
                }
                promotion_commands(moka, &canvas_id, "node-script", &promotion)
            })
            .await;

        assert_eq!(
            attempts.load(Ordering::SeqCst),
            2,
            "the write was rebuilt once"
        );
        let opened = store.current().await.expect("read").expect("open");
        let script = opened
            .moka
            .canvas(&canvas_id)
            .expect("the canvas is there")
            .node("node-script")
            .expect("the node is there");
        assert_eq!(
            script.title, "Renamed while it ran",
            "the rebuild is built from what the other writer left"
        );
        assert_eq!(
            slots_of(&script.data)[0].text.as_deref(),
            Some("An answer."),
            "and the write still landed"
        );
    }
}
