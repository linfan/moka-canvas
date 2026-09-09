//! The run manager: owns the run lifecycle (queue, drive, cancel, retry) and
//! persists every transition through the project store. A bounded number of runs
//! drive at once, and each driver is the only writer of the record it drives, so
//! cancel requests arrive through an in-memory flag the driver observes between
//! and during steps.

use super::events::{streamed_words, RunEvent, RunEvents};
use super::validate::{validate_run, RunSnapshot};
use super::{
    data_type_for, executor_key_for, operation_type_for, ExecutionError, ExecutionOutput,
    ExecutionRequest, PlacedJob, ProgressReporter, ValueProvenance, WorkflowExecutor,
    WorkflowValue,
};
use crate::domain::commands::make_node;
use crate::domain::validate::MAX_TITLE_LENGTH;
use crate::domain::{
    new_id, now_iso, AssetId, CanvasDocument, Capability, DataType, DocumentCommand, EdgeEndpoint,
    MokaFile, NodeData, NodeId, NodeKind, NodePatch, PortDirection, ResultSlot, ResultSlotStatus,
    RunId, RunRecord, RunStatus, RunStepRecord, ValidationIssue, WorkflowEdge, WorkflowNode,
};
use crate::generate::{ingest_generated, GenerateResult};
use crate::project::store::FsProjectStore;
use crate::project::{ProjectError, ProjectStore};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex};

pub struct RunManager {
    store: Arc<FsProjectStore>,
    executors: Vec<Arc<dyn WorkflowExecutor>>,
    enabled_executors: Vec<String>,
    /// How many runs drive at once, as permits rather than as a lock.
    ///
    /// A run past the ceiling waits here with its record still saying queued,
    /// which is what a client reads and what the run list shows; nothing has to
    /// be told it is waiting. The driver is still the only writer of the record
    /// it is driving, so two runs driving are two runs, not two writers of one.
    gate: tokio::sync::Semaphore,
    /// Serializes status transitions between the driver and cancel requests.
    transitions: tokio::sync::Mutex<()>,
    cancel_requests: Mutex<HashSet<RunId>>,
    /// What the runs being driven are saying, to anybody listening.
    events: RunEvents,
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
    task: Option<PlacedJob>,
}

/// What one scheduled node turned out to be.
///
/// Decided before anything is run, because the two answers need different
/// things done to them: one is written down and waited out in two halves, and
/// the other has nothing to wait for.
enum StepPlan {
    /// Nothing an executor could do, so the node passes on what it already had.
    Passthrough(Option<WorkflowValue>, StepArtifacts),
    /// An executor takes it.
    Scheduled {
        executor: Arc<dyn WorkflowExecutor>,
        request: ExecutionRequest,
    },
}

/// How far to the right of a node the results past its first are placed, and how
/// far apart from each other: enough that the cards do not overlap, close enough
/// that the set still reads as one answer.
const RESULT_GAP: f64 = 40.0;

/// What a cancelled run says when a provider was still working for it.
///
/// The stop is this app's alone. There is no way back to a job once it has been
/// placed, so it ends when the far end ends it and is charged for as usual, and
/// somebody reading a cancelled run has to be told that rather than left to find
/// it on a bill.
const JOB_OUTLIVES_CANCEL: &str =
    "Cancelled here, but the job the provider is running was not: it may still finish and still be billed.";

/// What a step a previous process already finished still has to hand downstream.
///
/// Read off the record rather than asked of anybody again. A node nothing ran
/// passes on what it carries, exactly as it would have the first time through;
/// the answer of a node an executor ran is what the record says it produced.
fn remembered(
    snapshot: &RunSnapshot,
    node_id: &str,
    step: &RunStepRecord,
) -> Option<WorkflowValue> {
    let node = snapshot.nodes.get(node_id)?;
    if executor_key_for(node).is_none() {
        return snapshot.source_value(node_id);
    }
    let source = ValueProvenance {
        node_id: node.id.clone(),
        port_id: "out".to_string(),
    };
    match step.output_asset_ids.clone().unwrap_or_default().first() {
        // A picture, a voice or a shot travelled as the asset it became; words
        // travelled as words.
        Some(asset_id) if data_type_for(node.kind) != DataType::Text => {
            Some(WorkflowValue::Media {
                media_type: data_type_for(node.kind),
                asset_id: asset_id.clone(),
                source,
            })
        }
        _ => step
            .output_text
            .clone()
            .map(|text| WorkflowValue::Text { text, source }),
    }
}

/// What a finished step leaves on the node that made it.
///
/// Kept apart from the run record on purpose. The record says what happened;
/// this says what the canvas looks like afterwards, and a node that only passed
/// a value through has nothing to say about either.
enum Promotion {
    /// The answers a step made, in the order the provider gave them, and where
    /// the first of them goes.
    Answered {
        answers: Vec<Answer>,
        placement: Placement,
    },
    /// Nothing worth keeping, and why.
    Failed(String),
}

/// Where the first answer of a run goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Placement {
    /// Onto the node that asked, which had nothing on it to lose.
    Own,
    /// Onto a card beside the node that asked, which already said or showed
    /// something and keeps it: an answer written over what somebody put there
    /// would take away the only copy of it, and asking again is how a canvas is
    /// compared rather than how it is overwritten.
    Beside,
}

/// One answer, as the node that holds it records it.
enum Answer {
    /// Words, and the asset they were filed as when they were filed.
    Words {
        text: String,
        asset_id: Option<AssetId>,
    },
    /// Media, as the asset it became.
    Media(AssetId),
}

impl Answer {
    /// What a node of this kind holds of it.
    ///
    /// Only a text node carries words as its own content and only a media node
    /// points at an asset as the thing it shows; an operation node holds
    /// neither, and its answer stays on the slot, which is where a reader looks
    /// for it.
    fn write_onto(&self, data: &mut NodeData, kind: NodeKind) {
        match (self, kind) {
            (Answer::Words { text, .. }, NodeKind::Text) => data.content = Some(text.clone()),
            (Answer::Media(asset_id), _) => data.asset_id = Some(asset_id.clone()),
            (Answer::Words { .. }, _) => {}
        }
    }

    fn asset_id(&self) -> Option<&AssetId> {
        match self {
            Answer::Words { asset_id, .. } => asset_id.as_ref(),
            Answer::Media(asset_id) => Some(asset_id),
        }
    }

    fn text(&self) -> Option<&str> {
        match self {
            Answer::Words { text, .. } => Some(text),
            Answer::Media(_) => None,
        }
    }

    /// One result as the node holding it records it. `primary` says whether this
    /// is the answer the node shows as its own, which an answer placed beside it
    /// is not.
    fn slot(&self, index: usize, primary: bool) -> ResultSlot {
        ResultSlot {
            id: slot_id(index),
            status: ResultSlotStatus::Succeeded,
            asset_id: self.asset_id().cloned(),
            text: self.text().map(str::to_string),
            error: None,
            is_primary: primary,
        }
    }
}

/// Whether the node a run saw had anything on it.
///
/// A text node is made holding an empty string rather than nothing, so what it
/// says has to be read rather than merely looked for.
fn was_empty(node: &WorkflowNode) -> bool {
    node.data.asset_id.is_none()
        && node
            .data
            .content
            .as_deref()
            .unwrap_or_default()
            .trim()
            .is_empty()
}

/// What one succeeded step writes back, or `None` for a step that made nothing
/// to keep.
fn promotion_for(node: &WorkflowNode, artifacts: &StepArtifacts) -> Option<Promotion> {
    // Only a node an executor ran made anything. What a written text node or a
    // bound image already carries is its own, and a run did not add to it.
    executor_key_for(node)?;
    // Read off the node as the run saw it rather than as it stands when the
    // answer lands: what somebody put there while it ran is theirs to keep, and
    // a generation waited out is a long time to have changed one's mind.
    let placement = if was_empty(node) {
        Placement::Own
    } else {
        Placement::Beside
    };
    let assets = artifacts.assets.clone().unwrap_or_default();
    let answers = match node.kind {
        NodeKind::Image | NodeKind::Audio | NodeKind::Video => {
            assets.into_iter().map(Answer::Media).collect()
        }
        _ => vec![Answer::Words {
            text: artifacts.text.clone().unwrap_or_default(),
            asset_id: assets.into_iter().next(),
        }],
    };
    // An answer with no asset in it leaves a media node holding what it held:
    // there is nothing to point a card at.
    (!answers.is_empty()).then_some(Promotion::Answered { answers, placement })
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

/// The cards for the answers that do not go onto the node that asked, and the
/// ids to record on it. Cards are numbered from `first`.
///
/// An answer that already has a card from an earlier run keeps it, updated rather
/// than replaced, so a card the user moved stays where they put it and a re-run
/// does not litter the canvas with a second set. Nothing is ever removed: a node
/// on the canvas is the user's to delete, and a run that asked for fewer answers
/// this time does not get to take one away.
fn result_nodes(
    canvas: &CanvasDocument,
    live: &WorkflowNode,
    extra: &[Answer],
    first: usize,
) -> (Vec<DocumentCommand>, Vec<NodeId>) {
    let mut commands = Vec::new();
    let mut ids = Vec::new();
    let previous = live.data.result_node_ids.clone().unwrap_or_default();
    for (index, answer) in extra.iter().enumerate() {
        let slots = Some(vec![answer.slot(0, true)]);
        let id = match previous.get(index).and_then(|id| canvas.node(id)) {
            Some(child) => {
                let mut data = child.data.clone();
                answer.write_onto(&mut data, child.kind);
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
                    card_title(&live.title, first + index),
                    live.bounds.x + (live.bounds.width + RESULT_GAP) * (index as f64 + 1.0),
                    live.bounds.y,
                );
                answer.write_onto(&mut child.data, child.kind);
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

/// The edge joining a node to the card that took its answer's place, or `None`
/// when there is nowhere to put one.
///
/// A kind with no input that can take what the node makes — an audio card cannot
/// be fed audio — is left unjoined rather than joined wrongly, and so is a card
/// an earlier run made, which has the edge already or had it taken away on
/// purpose. Both matter because a batch is applied as one: an edge the document
/// refuses would cost the answers beside it.
fn joined_back(
    canvas: &CanvasDocument,
    made: &[DocumentCommand],
    live: &WorkflowNode,
    card_id: &str,
) -> Option<DocumentCommand> {
    // The card is not on the canvas yet, it is in the commands about to be
    // written, so it is read out of those.
    let card = made.iter().find_map(|command| match command {
        DocumentCommand::AddNode { node, .. } if node.id == card_id => Some(node),
        _ => None,
    })?;
    let out = live.port("out")?;
    let into = card.ports.iter().find(|port| {
        port.direction == PortDirection::Input
            && port
                .data_types
                .iter()
                .any(|data_type| out.data_types.contains(data_type))
    })?;
    Some(DocumentCommand::AddEdge {
        canvas_id: canvas.id.clone(),
        edge: WorkflowEdge {
            id: new_id(),
            source: EdgeEndpoint {
                node_id: live.id.clone(),
                port_id: out.id.clone(),
            },
            target: EdgeEndpoint {
                node_id: card.id.clone(),
                port_id: into.id.clone(),
            },
            created_at: now_iso(),
        },
    })
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
        concurrent_runs: usize,
    ) -> Arc<Self> {
        Arc::new(Self {
            store,
            executors,
            enabled_executors,
            gate: tokio::sync::Semaphore::new(concurrent_runs),
            transitions: tokio::sync::Mutex::new(()),
            cancel_requests: Mutex::new(HashSet::new()),
            events: RunEvents::default(),
        })
    }

    /// What the runs being driven are saying.
    ///
    /// Handed out rather than served from inside, because the listener is a
    /// route and a route reads the run record as well: the two have to be the
    /// same bus for the record to arrive where the words were going.
    pub fn events(&self) -> RunEvents {
        self.events.clone()
    }

    /// What one step says about how far along it is.
    ///
    /// Published to whoever is listening and kept for the record, because a run
    /// that ends before the next write still says how far it got — which is the
    /// difference between "it stopped" and "it stopped three quarters in".
    fn reporter(
        &self,
        run_id: &RunId,
        node_id: &NodeId,
        reached: Arc<Mutex<Option<f64>>>,
    ) -> ProgressReporter {
        let events = self.events.clone();
        let run_id = run_id.clone();
        let node_id = node_id.clone();
        ProgressReporter::new(Arc::new(move |fraction| {
            *reached
                .lock()
                .expect("a step's progress is not held across a call") = Some(fraction);
            events.publish(RunEvent::progress(
                run_id.clone(),
                node_id.clone(),
                fraction,
            ));
        }))
    }

    /// Says a run has ended and stops its channel.
    ///
    /// Both, because a listener that is told nothing waits for a record that is
    /// already written, and a channel left open is a stream left hanging.
    async fn ended(&self, run: &RunRecord) {
        // The last read of an answer is still buffered when the step that
        // produced it returns, and a listener stops reading at an ending.
        self.events.settle(&run.id).await;
        self.events.publish(RunEvent::done(
            run.id.clone(),
            run.status,
            run.error.clone(),
        ));
        self.events.close(&run.id);
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

    /// Picks up the runs a previous process was in the middle of.
    ///
    /// Called when a project opens, because that is the first moment there is
    /// somewhere to put an answer. The sweep on open has already failed
    /// everything that cannot be picked up again, so what is left here is
    /// waiting on a job a provider is still running.
    pub async fn resume_interrupted(self: &Arc<Self>) {
        let interrupted = match self.store.interrupted_runs().await {
            Ok(interrupted) => interrupted,
            Err(error) => {
                tracing::warn!("the runs left in progress could not be listed: {error}");
                return;
            }
        };
        for run_id in interrupted {
            let driver = Arc::clone(self);
            tokio::spawn(async move {
                driver.resume(run_id).await;
            });
        }
    }

    /// Drives a run that was already under way.
    ///
    /// Revalidated against the document rather than trusted: it may have been
    /// edited while the process was down, and a step whose node is gone has
    /// nothing left to wait out.
    async fn resume(self: Arc<Self>, run_id: RunId) {
        let run = match self.store.get_run(&run_id).await {
            Ok(run) => run,
            Err(error) => {
                tracing::warn!("run {run_id}: could not be read back: {error}");
                return;
            }
        };
        let Some(opened) = self.store.current().await.ok().flatten() else {
            return;
        };
        let snapshot = match validate_run(
            &opened.root,
            &opened.moka,
            &run.canvas_id,
            &run.requested_node_ids,
            &self.executors,
            &self.enabled_executors,
        )
        .await
        {
            Ok(snapshot) => snapshot,
            Err(issues) => {
                let reason = issues
                    .first()
                    .map(|issue| issue.message.clone())
                    .unwrap_or_else(|| "The document no longer supports this run".to_string());
                tracing::warn!("run {run_id}: {reason}");
                self.end_unresumable(run, &reason).await;
                return;
            }
        };
        // Steps are walked by position, so an order that came out differently is
        // a record this driver cannot read: it would write one node's answer
        // onto another's step.
        let same_walk = snapshot.order.len() == run.steps.len()
            && snapshot
                .order
                .iter()
                .zip(run.steps.iter())
                .all(|(node_id, step)| node_id == &step.node_id);
        if !same_walk {
            let reason = "The graph was edited while this run was in progress";
            tracing::warn!("run {run_id}: {reason}");
            self.end_unresumable(run, reason).await;
            return;
        }
        self.drive(run_id, snapshot).await;
    }

    /// Ends a run that cannot be picked up again.
    ///
    /// Left in progress it would be attempted at every open after this one, and
    /// the notes of the jobs it was waiting on would stay on disk for nobody.
    async fn end_unresumable(&self, run: RunRecord, reason: &str) {
        let _guard = self.transitions.lock().await;
        let run_id = run.id.clone();
        let mut run = run;
        for step in &run.steps {
            if let Some(task_id) = &step.task_id {
                if let Err(error) = self.store.drop_job(task_id).await {
                    tracing::warn!("run {run_id}: job {task_id} could not be forgotten: {error}");
                }
            }
        }
        run.status = RunStatus::Failed;
        run.error = Some(reason.to_string());
        for step in &mut run.steps {
            if matches!(step.status, RunStatus::Queued | RunStatus::Running) {
                step.status = RunStatus::Failed;
                step.error = Some("Interrupted before completion".to_string());
            }
        }
        run.updated_at = now_iso();
        match self.store.update_run(run).await {
            Ok(run) => self.ended(&run).await,
            Err(error) => tracing::warn!("run {run_id}: could not be ended: {error}"),
        }
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
                // Ended here rather than by a driver, and so said here: a run
                // cancelled before it started has nobody else to speak for it.
                let run = self.store.update_run(run).await?;
                self.ended(&run).await;
                Ok(run)
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
        // Held for the whole walk rather than taken per step: what the ceiling
        // bounds is how many runs are driving, and a step that let its permit go
        // would hand the run's place to another one mid-flight.
        let _permit = self
            .gate
            .acquire()
            .await
            .expect("the ceiling on runs is never closed");
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
                // A run a previous process was in the middle of. It is already
                // recorded as running, so picking it up is walking the steps it
                // had not reached rather than starting over.
                Ok(run) if run.status == RunStatus::Running => run,
                // Ended while waiting for the gate, or unreadable. Either way
                // there is nothing to drive, and a listener is told so rather
                // than left waiting on a driver that is not coming.
                Ok(run) => {
                    self.ended(&run).await;
                    return;
                }
                Err(error) => {
                    tracing::warn!("run {run_id}: could not be read back: {error}");
                    return;
                }
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
            // A step a previous process already finished is remembered rather
            // than run again: what the steps after it need is the answer, and
            // asking a provider for it a second time would pay twice for one.
            if run.steps[position].status == RunStatus::Succeeded {
                if let Some(value) = remembered(&snapshot, node_id, &run.steps[position]) {
                    snapshot.record_output(node_id, &value);
                    outputs.insert(node_id.clone(), value);
                }
                continue;
            }
            // A handle already on the record is a job that was placed before the
            // process stopped, which is waited out rather than placed again.
            let placed = run.steps[position]
                .task_id
                .clone()
                .map(|task_id| PlacedJob {
                    run_id: run.id.clone(),
                    task_id,
                    created_at: run.steps[position]
                        .task_created_at
                        .clone()
                        .unwrap_or_else(now_iso),
                });
            if run.steps[position].status != RunStatus::Running {
                run.steps[position].status = RunStatus::Running;
                run.steps[position].started_at = Some(now_iso());
                run.updated_at = now_iso();
                if let Err(error) = self.store.update_run(run.clone()).await {
                    tracing::warn!("run {run_id}: could not persist step start: {error}");
                }
            }

            let outcome = self
                .run_step(&mut run, &snapshot, position, &outputs, placed)
                .await;
            run.steps[position].finished_at = Some(now_iso());
            match outcome {
                Ok((value, artifacts)) => {
                    // Decided before the artifacts are moved into the record.
                    let promotion = promotion_for(&snapshot.nodes[node_id], &artifacts);
                    let step = &mut run.steps[position];
                    step.status = RunStatus::Succeeded;
                    step.output_text = artifacts.text;
                    step.output_asset_ids = artifacts.assets;
                    step.task_id = artifacts.task.as_ref().map(|job| job.task_id.clone());
                    step.task_created_at = artifacts.task.map(|job| job.created_at);
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
                        // Stopping here stops the waiting, not the work: a job a
                        // provider is running has no way back and keeps costing
                        // until it ends on its own.
                        let billing = run.steps[position]
                            .task_id
                            .is_some()
                            .then(|| JOB_OUTLIVES_CANCEL.to_string());
                        halt = Some((RunStatus::Cancelled, billing));
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
        // Given up before the run is written as ended, because the note of a job
        // is the only thing that makes a run resumable: a process that stops in
        // between leaves a run that fails the next time somebody asks after the
        // job, rather than a handle on disk that nobody is ever coming back for.
        for step in &run.steps {
            if let Some(task_id) = &step.task_id {
                if let Err(error) = self.store.drop_job(task_id).await {
                    tracing::warn!("run {run_id}: job {task_id} could not be forgotten: {error}");
                }
            }
        }
        {
            let _guard = self.transitions.lock().await;
            for step in &mut run.steps {
                if matches!(step.status, RunStatus::Queued | RunStatus::Running) {
                    step.status = RunStatus::Cancelled;
                }
            }
            run.status = status;
            run.error = error;
            if run.status == RunStatus::Cancelled {
                run.cancel_requested = true;
            }
            run.updated_at = now_iso();
            match self.store.update_run(run).await {
                // Said after the write rather than before: a listener that
                // hears the ending is about to ask for the record, and it has
                // to be there.
                Ok(run) => self.ended(&run).await,
                Err(error) => {
                    tracing::warn!("run {run_id}: could not persist final state: {error}")
                }
            }
        }
        self.cancel_requests
            .lock()
            .expect("cancel registry poisoned")
            .remove(&run_id);
    }

    /// Resolves one scheduled node into what is going to happen to it.
    ///
    /// A node with nothing an executor could do passes the value it already had
    /// downstream, which is how written words or a bound image reach the step
    /// after them. Everything else is handed to the executor it names.
    fn plan_step(
        &self,
        run: &RunRecord,
        snapshot: &RunSnapshot,
        node_id: &str,
        outputs: &HashMap<NodeId, WorkflowValue>,
    ) -> Result<StepPlan, ExecutionError> {
        let node = &snapshot.nodes[node_id];
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
            return Ok(StepPlan::Passthrough(value, artifacts));
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
                // Resolved once here rather than in the executor: the same
                // reading of the graph builds the request and stamps the answer
                // that comes back, so the two cannot disagree about what fed it.
                .map(|spec| snapshot.generation_inputs(&node.id).request_for(spec)),
            // Words are the only answer that arrives a piece at a time, so the
            // only one worth a stream of its own. Where they will land is known
            // now, and saying so lets a listener show them there rather than
            // somewhere it has to move them from later.
            deltas: node
                .data
                .generation
                .as_ref()
                .filter(|spec| spec.capability == Capability::Text)
                .map(|_| {
                    streamed_words(
                        self.events.clone(),
                        run.id.clone(),
                        node.id.clone(),
                        slot_id(0),
                    )
                })
                .unwrap_or_default(),
        };
        Ok(StepPlan::Scheduled {
            executor: Arc::clone(executor),
            request,
        })
    }

    /// Runs one scheduled node.
    ///
    /// A step whose answer arrives later is the reason this is not one call:
    /// the handle is written onto the record the moment a job exists, because a
    /// shot takes minutes and a process that stops in the middle of one has to
    /// leave enough behind to ask again rather than pay for a second shot.
    async fn run_step(
        &self,
        run: &mut RunRecord,
        snapshot: &RunSnapshot,
        position: usize,
        outputs: &HashMap<NodeId, WorkflowValue>,
        placed: Option<PlacedJob>,
    ) -> Result<(Option<WorkflowValue>, StepArtifacts), ExecutionError> {
        let node_id = run.steps[position].node_id.clone();
        let plan = self.plan_step(run, snapshot, &node_id, outputs)?;
        match plan {
            StepPlan::Passthrough(value, artifacts) => Ok((value, artifacts)),
            StepPlan::Scheduled { executor, request } => {
                // Kept beside the reporter rather than asked of it: a reporter
                // is a callback with no way to answer a question, and the
                // record has to say how far the step got even when the next
                // thing it did was fail.
                let reached = Arc::new(Mutex::new(None));
                let progress = self.reporter(&run.id, &node_id, Arc::clone(&reached));
                let how_far = || {
                    *reached
                        .lock()
                        .expect("a step's progress is not held across a call")
                };
                let job = match placed {
                    // A job a previous process placed is waited out rather than
                    // placed again: it survived, and so did the answer it is
                    // going to give.
                    Some(job) => job,
                    None => {
                        let Some(job) = executor.place_job(request.clone()).await? else {
                            // Nothing to wait for, so nothing to write down.
                            let outcome = executor.execute(request, progress).await;
                            run.steps[position].progress = how_far();
                            return self.finish_step(run, snapshot, &node_id, outcome?).await;
                        };
                        run.steps[position].task_id = Some(job.task_id.clone());
                        run.steps[position].task_created_at = Some(job.created_at.clone());
                        run.updated_at = now_iso();
                        if let Err(error) = self.store.update_run(run.clone()).await {
                            tracing::warn!(
                                "run {}: could not persist the job handle: {error}",
                                run.id
                            );
                        }
                        job
                    }
                };
                let outcome = executor.wait_job(job.clone(), progress).await;
                run.steps[position].progress = how_far();
                let (value, mut artifacts) =
                    self.finish_step(run, snapshot, &node_id, outcome?).await?;
                // Reported with the artifacts as well, so a step waited out in
                // one call and one waited out in two leave the same record.
                artifacts.task = Some(job);
                Ok((value, artifacts))
            }
        }
    }

    /// Files a step's answer in the project and turns it into what travels on.
    ///
    /// A generation's answer is filed before any of it travels downstream: what
    /// flows between nodes is an asset reference, never the bytes.
    async fn finish_step(
        &self,
        run: &RunRecord,
        snapshot: &RunSnapshot,
        node_id: &str,
        output: ExecutionOutput,
    ) -> Result<(Option<WorkflowValue>, StepArtifacts), ExecutionError> {
        let node = &snapshot.nodes[node_id];
        let source = ValueProvenance {
            node_id: node.id.clone(),
            port_id: "out".to_string(),
        };
        let ExecutionOutput { text, items, task } = output;
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
        let resolved = snapshot.generation_inputs(&node.id);
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
/// The cards come before the node that points at them and the edge between them
/// comes after both, and the whole set is a single batch: written apart, a crash
/// on the way would leave a slot naming a card that was never added, or an edge
/// the document refuses for want of a node at one end of it.
fn promotion_commands(
    moka: &MokaFile,
    canvas_id: &str,
    node_id: &str,
    promotion: &Promotion,
) -> Option<Vec<DocumentCommand>> {
    let canvas = moka.canvas(canvas_id)?;
    let live = canvas.node(node_id)?;
    let mut data = live.data.clone();
    let (answers, placement) = match promotion {
        Promotion::Answered { answers, placement } => (answers.as_slice(), *placement),
        // What the node held before is left where it was: a failed attempt says
        // why it failed, it does not take the last answer that worked away. It
        // gets no card either, since there is nothing for one to hold.
        Promotion::Failed(message) => {
            data.result_slots = Some(vec![failed(message)]);
            return Some(vec![write_back(canvas_id, node_id, data)]);
        }
    };
    let (own, cards, numbering) = match placement {
        Placement::Own => (answers.first(), answers.get(1..).unwrap_or(&[]), 2),
        Placement::Beside => (None, answers, 1),
    };
    if let Some(answer) = own {
        answer.write_onto(&mut data, live.kind);
    }
    let mut commands = Vec::new();
    let (made, ids) = result_nodes(canvas, live, cards, numbering);
    commands.extend(made);
    if placement == Placement::Beside {
        if let Some(card_id) = ids.first() {
            // The card standing in for the node's own answer is joined back to
            // it, so the canvas says what it came from. One edge says that: the
            // cards beside it are the same batch, not a chain.
            commands.extend(joined_back(canvas, &commands, live, card_id));
        }
    }
    data.result_node_ids = Some(ids);
    data.result_slots = Some(
        answers
            .iter()
            .enumerate()
            .map(|(index, answer)| answer.slot(index, own.is_some() && index == 0))
            .collect(),
    );
    commands.push(write_back(canvas_id, node_id, data));
    Some(commands)
}

/// The node that asked, written last: a crash on the way leaves cards nothing
/// points at rather than slots pointing at cards that were never made.
fn write_back(canvas_id: &str, node_id: &str, data: NodeData) -> DocumentCommand {
    DocumentCommand::UpdateNode {
        canvas_id: canvas_id.to_string(),
        node_id: node_id.to_string(),
        patch: NodePatch {
            title: None,
            z_index: None,
            data: Some(data),
        },
    }
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

    /// An answer in words, and the asset those words were filed as when they were.
    fn words(text: &str, asset_id: Option<&str>) -> Answer {
        Answer::Words {
            text: text.to_string(),
            asset_id: asset_id.map(str::to_string),
        }
    }

    /// Answers in media, in the order a provider gave them.
    fn media(ids: &[&str]) -> Vec<Answer> {
        ids.iter()
            .map(|id| Answer::Media((*id).to_string()))
            .collect()
    }

    /// A promotion whose first answer goes onto the node that asked, which is
    /// what a node holding nothing gets.
    fn onto(answers: Vec<Answer>) -> Promotion {
        Promotion::Answered {
            answers,
            placement: Placement::Own,
        }
    }

    /// A promotion whose answers all go onto cards beside the node that asked,
    /// which is what a node holding something gets.
    fn beside(answers: Vec<Answer>) -> Promotion {
        Promotion::Answered {
            answers,
            placement: Placement::Beside,
        }
    }

    /// Where a promotion puts its first answer.
    fn placement_of(promotion: Option<Promotion>) -> Placement {
        let Promotion::Answered { placement, .. } =
            promotion.expect("a node an executor ran made something")
        else {
            panic!("and it made an answer");
        };
        placement
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
    fn a_node_holding_something_when_the_run_started_has_its_answer_placed_beside_it() {
        let artifacts = StepArtifacts {
            text: Some("An answer.".to_string()),
            assets: Some(vec!["asset-1".to_string()]),
            task: None,
        };
        // A node made and never written in holds an empty string rather than
        // nothing, and is still a node with nothing to lose.
        assert_eq!(
            placement_of(promotion_for(&asking(NodeKind::Text, "script"), &artifacts)),
            Placement::Own
        );
        assert_eq!(
            placement_of(promotion_for(
                &asking(NodeKind::Image, "poster"),
                &artifacts
            )),
            Placement::Own
        );

        let mut written_in = asking(NodeKind::Text, "script");
        written_in.data.content = Some("Written by hand.".to_string());
        assert_eq!(
            placement_of(promotion_for(&written_in, &artifacts)),
            Placement::Beside
        );

        let mut showing = asking(NodeKind::Image, "poster");
        showing.data.asset_id = Some("asset-kept".to_string());
        assert_eq!(
            placement_of(promotion_for(&showing, &artifacts)),
            Placement::Beside
        );

        // What a run wrote is on the node when the next one starts, so asking
        // again is what puts an answer beside it rather than over it.
        let mut answered = asking(NodeKind::Text, "script");
        answered.data.content = Some("   ".to_string());
        assert_eq!(
            placement_of(promotion_for(&answered, &artifacts)),
            Placement::Own,
            "a node saying nothing but spaces still says nothing"
        );
    }

    #[test]
    fn words_go_into_a_text_node_and_onto_its_slot() {
        let moka = document(vec![asking(NodeKind::Text, "script")]);
        let commands = written(
            &moka,
            "script",
            &onto(vec![words("A lantern drifts.", Some("asset-text"))]),
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
        let commands = written(&moka, "join", &onto(vec![words("Joined.", None)]));
        let data = data_of(&commands[0]);
        // An operation node has no words of its own, and the document only ever
        // carries a content key on a text node.
        assert!(data.content.is_none());
        assert_eq!(slots_of(data)[0].text.as_deref(), Some("Joined."));
    }

    #[test]
    fn one_picture_backfills_the_node_that_asked_for_it() {
        let moka = document(vec![asking(NodeKind::Image, "poster")]);
        let commands = written(&moka, "poster", &onto(media(&["asset-1"])));
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
        let promotion = onto(assets.iter().cloned().map(Answer::Media).collect());
        let commands = written(&moka, "poster", &promotion);
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
        let commands = written(&moka, "voice", &onto(media(&["asset-1", "asset-2"])));
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
        let commands = written(
            &moka,
            "poster",
            &onto(media(&["asset-new", "asset-second", "asset-third"])),
        );
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
        let commands = written(&moka, "poster", &onto(media(&["asset-1"])));
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
    fn an_answer_a_node_already_saying_something_goes_onto_a_card_beside_it() {
        let mut script = asking(NodeKind::Text, "script");
        script.data.content = Some("What was there before.".to_string());
        let moka = document(vec![script]);
        let commands = written(
            &moka,
            "script",
            &beside(vec![words("A new answer.", Some("asset-text"))]),
        );
        assert_eq!(
            commands.len(),
            3,
            "a card, the edge to it, and the node itself"
        );

        let DocumentCommand::AddNode { node, .. } = &commands[0] else {
            panic!("the answer gets a card of its own");
        };
        assert_eq!(node.kind, NodeKind::Text);
        assert_eq!(node.title, "script 1", "the cards are the whole batch");
        assert_eq!(node.data.content.as_deref(), Some("A new answer."));
        assert!(
            node.data.asset_id.is_none(),
            "the asset the words were filed as travels on the slot, as it does on the node that asked"
        );
        assert!(
            slots_of(&node.data)[0].is_primary,
            "a card's own answer is its primary"
        );

        let DocumentCommand::AddEdge { edge, .. } = &commands[1] else {
            panic!("the card is joined back to the node it came from");
        };
        assert_eq!(edge.source.node_id, "node-script");
        assert_eq!(edge.source.port_id, "out");
        assert_eq!(
            edge.target.node_id, node.id,
            "and joined to the card rather than to nothing"
        );
        assert_eq!(
            edge.target.port_id, "prompt",
            "words go in where words are read"
        );

        let parent = data_of(&commands[2]);
        assert_eq!(
            parent.content.as_deref(),
            Some("What was there before."),
            "what the node said is still what it says"
        );
        assert_eq!(
            parent
                .result_node_ids
                .clone()
                .expect("the card is recorded"),
            vec![node.id.clone()]
        );
        let slots = slots_of(parent);
        assert_eq!(slots.len(), 1);
        assert_eq!(slots[0].text.as_deref(), Some("A new answer."));
        assert_eq!(slots[0].asset_id.as_deref(), Some("asset-text"));
        assert!(
            !slots[0].is_primary,
            "no answer is the node's own while it is holding something else"
        );
    }

    #[test]
    fn answers_beside_a_node_join_only_the_first_card_to_it() {
        let mut poster = asking(NodeKind::Image, "poster");
        poster.data.asset_id = Some("asset-kept".to_string());
        let moka = document(vec![poster]);
        let commands = written(
            &moka,
            "poster",
            &beside(media(&["asset-new", "asset-second"])),
        );
        assert_eq!(
            commands.len(),
            4,
            "two cards, the edge to the first of them, and the node itself"
        );
        let DocumentCommand::AddNode { node: first, .. } = &commands[0] else {
            panic!("checked above");
        };
        let DocumentCommand::AddNode { node: second, .. } = &commands[1] else {
            panic!("checked above");
        };
        assert_eq!(first.title, "poster 1");
        assert_eq!(second.title, "poster 2");
        assert_eq!(first.data.asset_id.as_deref(), Some("asset-new"));
        assert_eq!(second.data.asset_id.as_deref(), Some("asset-second"));
        assert!(
            second.bounds.x > first.bounds.x + first.bounds.width,
            "the cards are beside each other as well as beside the node"
        );

        let DocumentCommand::AddEdge { edge, .. } = &commands[2] else {
            panic!("the first card is joined back");
        };
        assert_eq!(edge.source.node_id, "node-poster");
        assert_eq!(edge.target.node_id, first.id);
        assert_eq!(
            edge.target.port_id, "images",
            "a picture goes in where pictures are read"
        );

        let parent = data_of(&commands[3]);
        assert_eq!(
            parent.asset_id.as_deref(),
            Some("asset-kept"),
            "what the node showed is still what it shows"
        );
        assert_eq!(
            parent
                .result_node_ids
                .clone()
                .expect("the cards are recorded"),
            vec![first.id.clone(), second.id.clone()]
        );
        let slots = slots_of(parent);
        assert_eq!(slots.len(), 2, "every answer is still named");
        assert!(
            slots.iter().all(|slot| !slot.is_primary),
            "and none of them is the node's own"
        );
    }

    #[test]
    fn a_card_a_node_has_nowhere_to_feed_is_left_unjoined() {
        let mut voice = asking(NodeKind::Audio, "voice");
        voice.data.asset_id = Some("asset-kept".to_string());
        let moka = document(vec![voice]);
        let commands = written(&moka, "voice", &beside(media(&["asset-new"])));
        assert_eq!(
            commands.len(),
            2,
            "a card and the node: an audio node takes no audio in, and an edge the document refuses would cost the answer beside it"
        );
        assert!(matches!(commands[0], DocumentCommand::AddNode { .. }));
        assert_eq!(id_of(&commands[1]), "node-voice");
    }

    #[test]
    fn a_card_an_earlier_run_made_is_not_joined_a_second_time() {
        let mut poster = asking(NodeKind::Image, "poster");
        poster.data.asset_id = Some("asset-kept".to_string());
        poster.data.result_node_ids = Some(vec!["node-card".to_string()]);
        let moka = document(vec![poster, card("node-card", "asset-old")]);
        let commands = written(&moka, "poster", &beside(media(&["asset-new"])));
        assert_eq!(
            commands.len(),
            2,
            "the card and the node, and no edge again"
        );
        assert_eq!(id_of(&commands[0]), "node-card");
        assert!(
            matches!(commands[0], DocumentCommand::UpdateNode { .. }),
            "a card that is there is written into, which is how an edge it already has, or one taken away on purpose, is left as it is"
        );
        assert_eq!(id_of(&commands[1]), "node-poster");
    }

    #[test]
    fn a_failed_attempt_says_why_and_leaves_the_node_holding_what_it_held() {
        let mut script = asking(NodeKind::Text, "script");
        script.data.content = Some("An earlier answer.".to_string());
        script.data.result_slots = Some(vec![words("An earlier answer.", None).slot(0, true)]);
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
        let promotion = onto(vec![words("words", None)]);
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
        RunManager::new(store, Vec::new(), Vec::new(), 1)
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
        let promotion = onto(vec![words("An answer.", None)]);
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
