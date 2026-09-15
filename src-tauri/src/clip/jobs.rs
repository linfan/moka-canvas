//! The exports this process is running, and the driver that runs one.
//!
//! One at a time: a second render would compete for the same disk and the
//! same machine, and there is one person waiting in front of the dialog. The
//! entry a client polls is kept for a while after it ends, so a dialog that
//! was reopened still reads the answer it was waiting for, and is then
//! forgotten — an export has no life outside this process.

use super::plan::RenderPlan;
use super::runner::{self, RunError, RunSpec};
use super::ClipError;
use crate::domain::{now_iso, AssetProvenance};
use crate::project::{ProjectError, ProjectStore, StagedAsset};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

/// How long a finished export is still worth reading.
///
/// A render ends in minutes and a dialog is answered by a poll that is already
/// in flight; what this bounds is an entry nobody will ever look at again.
const TRACKED_FOR: Duration = Duration::from_secs(60 * 60);

/// Where an export has got to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportStatus {
    Queued,
    Running,
    Done,
    Failed,
    Cancelled,
}

impl ExportStatus {
    /// Whether this is a place an export stays: a terminal status is never
    /// moved again by the driver, only read by a client.
    pub fn terminal(&self) -> bool {
        matches!(self, Self::Done | Self::Failed | Self::Cancelled)
    }
}

/// What a client polls for.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportTask {
    pub id: String,
    pub timeline_id: String,
    pub status: ExportStatus,
    /// How far along, 0..1, never going backwards.
    pub progress01: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// What the render was filed as, once it is in the project.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<String>,
}

/// One export, and how to stop it.
#[derive(Debug)]
struct Tracked {
    task: ExportTask,
    /// Taken when the render ends or is cancelled, so a stop request reaches
    /// a process that is still running or nobody at all.
    cancel: Option<oneshot::Sender<()>>,
    forget_after: Instant,
}

/// The one export this process may be running, looked up by its handle.
#[derive(Debug, Default)]
pub struct ExportRegistry {
    tasks: RwLock<HashMap<String, Tracked>>,
}

/// The place one export takes, and how it hears that it should stop.
#[derive(Debug)]
pub struct Reservation {
    pub task: ExportTask,
    pub cancel: oneshot::Receiver<()>,
}

impl ExportRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Takes the one place, or refuses because somebody is in it.
    ///
    /// Entries that have grown old are dropped here rather than on a timer:
    /// the only thing this table's size depends on is exports, so that is when
    /// it is cleaned.
    pub fn begin(&self, timeline_id: &str) -> Result<Reservation, ClipError> {
        let mut tasks = self.tasks.write().expect("a panic left this unlocked");
        let now = Instant::now();
        tasks.retain(|_, entry| entry.forget_after > now);
        if tasks.values().any(|entry| !entry.task.status.terminal()) {
            return Err(ClipError::Busy);
        }
        let id = crate::domain::new_id();
        let (cancel, receiver) = oneshot::channel();
        let task = ExportTask {
            id: id.clone(),
            timeline_id: timeline_id.to_string(),
            status: ExportStatus::Queued,
            progress01: 0.0,
            message: None,
            asset_id: None,
        };
        tasks.insert(
            id,
            Tracked {
                task: task.clone(),
                cancel: Some(cancel),
                forget_after: now + TRACKED_FOR,
            },
        );
        Ok(Reservation {
            task,
            cancel: receiver,
        })
    }

    /// What has become of a handle.
    pub fn snapshot(&self, id: &str) -> Result<ExportTask, ClipError> {
        let mut tasks = self.tasks.write().expect("a panic left this unlocked");
        let now = Instant::now();
        match tasks.get(id) {
            Some(entry) if entry.forget_after > now => Ok(entry.task.clone()),
            Some(_) => {
                tasks.remove(id);
                Err(ClipError::ExportMissing { id: id.to_string() })
            }
            None => Err(ClipError::ExportMissing { id: id.to_string() }),
        }
    }

    /// Asks an export to stop. One that already ended is answered as it ended,
    /// since a stop request and a finish can cross in flight.
    pub fn cancel(&self, id: &str) -> Result<ExportTask, ClipError> {
        let mut tasks = self.tasks.write().expect("a panic left this unlocked");
        let now = Instant::now();
        let Some(entry) = tasks.get_mut(id) else {
            return Err(ClipError::ExportMissing { id: id.to_string() });
        };
        if entry.forget_after <= now {
            tasks.remove(id);
            return Err(ClipError::ExportMissing { id: id.to_string() });
        }
        if !entry.task.status.terminal() {
            if let Some(cancel) = entry.cancel.take() {
                let _ = cancel.send(());
            }
        }
        Ok(entry.task.clone())
    }

    /// Says the render has started.
    pub fn set_running(&self, id: &str) {
        self.edit(id, |task| {
            if !task.status.terminal() {
                task.status = ExportStatus::Running;
            }
        });
    }

    /// Writes down how far along the render is, never backwards.
    pub fn set_progress(&self, id: &str, progress01: f64) {
        self.edit(id, |task| {
            task.progress01 = task.progress01.max(progress01.clamp(0.0, 1.0));
        });
    }

    /// Puts an export in its final place and stops offering to cancel it.
    pub fn finish(
        &self,
        id: &str,
        status: ExportStatus,
        message: Option<String>,
        asset_id: Option<String>,
    ) {
        debug_assert!(status.terminal());
        let mut tasks = self.tasks.write().expect("a panic left this unlocked");
        let Some(entry) = tasks.get_mut(id) else {
            return;
        };
        entry.task.status = status;
        entry.task.message = message;
        entry.task.asset_id = asset_id;
        if status == ExportStatus::Done {
            entry.task.progress01 = 1.0;
        }
        entry.cancel = None;
        // Read for a while rather than forgotten at once: the dialog that
        // started this is still polling.
        entry.forget_after = Instant::now() + TRACKED_FOR;
    }

    pub fn len(&self) -> usize {
        self.tasks.read().expect("a panic left this unlocked").len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Applies one write to one entry, ignoring a handle that is not there.
    fn edit(&self, id: &str, write: impl FnOnce(&mut ExportTask)) {
        let mut tasks = self.tasks.write().expect("a panic left this unlocked");
        if let Some(entry) = tasks.get_mut(id) {
            write(&mut entry.task);
        }
    }
}

/// Where a finished render goes.
///
/// A trait rather than a store so a render's whole life — progress, the
/// artifact, the scratch directory — can be driven in a test without a
/// project on disk, and so filing one is something a caller can hand over.
#[async_trait::async_trait]
pub trait ArtifactSink: Send + Sync {
    /// Files the artifact and answers with the asset that holds it.
    async fn keep(
        &self,
        artifact: &Path,
        plan: &RenderPlan,
        timeline_id: &str,
    ) -> Result<String, ProjectError>;
}

/// The project's own shelf: what a render made is an asset like any other.
pub struct ProjectSink(pub Arc<dyn ProjectStore>);

#[async_trait::async_trait]
impl ArtifactSink for ProjectSink {
    async fn keep(
        &self,
        artifact: &Path,
        plan: &RenderPlan,
        timeline_id: &str,
    ) -> Result<String, ProjectError> {
        let change = self
            .0
            .add_asset(StagedAsset {
                name: plan.output_name.clone(),
                tmp_path: artifact.to_path_buf(),
                declared_mime: Some("video/mp4".to_string()),
                category_hint: None,
                provenance: Some(AssetProvenance {
                    run_id: None,
                    canvas_id: None,
                    operation_node_id: None,
                    assistant_session_id: None,
                    input_asset_ids: None,
                    // What this file is a render of, so a reader a month from
                    // now can tell it from anything else in the project.
                    parameter_snapshot: Some(serde_json::json!({
                        "timelineId": timeline_id,
                        "timeline": plan.output_name,
                    })),
                    created_at: now_iso(),
                }),
            })
            .await?;
        Ok(change.entry.id)
    }
}

/// Everything one run needs that is not in the plan.
#[derive(Debug, Clone)]
pub struct ExportRun {
    pub id: String,
    pub timeline_id: String,
    pub plan: RenderPlan,
    pub program: PathBuf,
    /// The H.264 encoder the capability probe chose, by name.
    pub encoder: String,
    /// The project's scratch directory: `export-<id>/` is made inside it.
    pub temp_root: PathBuf,
    pub timeout: Duration,
}

/// Drives one export from queued to a place it stays, and leaves nothing on
/// the disk whichever way it ends.
pub async fn drive(
    registry: Arc<ExportRegistry>,
    sink: Arc<dyn ArtifactSink>,
    run: ExportRun,
    cancel: oneshot::Receiver<()>,
) {
    registry.set_running(&run.id);
    let spec = RunSpec {
        program: run.program,
        inputs: run.plan.inputs.clone(),
        graph: run.plan.graph.clone(),
        ass: run.plan.ass.clone(),
        duration_ms: run.plan.duration_ms,
        fps: run.plan.fps,
        encoder: run.encoder.clone(),
        audio: run.plan.audio,
        temp_dir: run.temp_root.join(format!("export-{}", run.id)),
        timeout: run.timeout,
    };
    let progress_registry = Arc::clone(&registry);
    let progress_id = run.id.clone();
    let outcome = runner::run(spec, cancel, move |progress01| {
        progress_registry.set_progress(&progress_id, progress01);
    })
    .await;

    match outcome {
        Ok(artifact) => {
            // The artifact has to be filed before the guard goes: the
            // scratch directory leaves with it.
            match sink.keep(&artifact.path, &run.plan, &run.timeline_id).await {
                Ok(asset_id) => registry.finish(&run.id, ExportStatus::Done, None, Some(asset_id)),
                Err(error) => {
                    registry.finish(&run.id, ExportStatus::Failed, Some(error.to_string()), None)
                }
            }
        }
        Err(RunError::Cancelled) => registry.finish(&run.id, ExportStatus::Cancelled, None, None),
        Err(error) => registry.finish(&run.id, ExportStatus::Failed, Some(error.message()), None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn plan_stub() -> RenderPlan {
        RenderPlan {
            inputs: Vec::new(),
            graph: "color=c=#000000:s=1920x1080:r=30:d=2,format=yuv420p[vout]\n".to_string(),
            ass: None,
            duration_ms: 2_000,
            fps: 30,
            output_name: "Cut.mp4".to_string(),
            audio: false,
        }
    }

    /// A sink that writes down what it was handed instead of filing it, so a
    /// render's whole life can be driven without a project on disk.
    #[derive(Default)]
    struct RecordingSink {
        kept: Mutex<Vec<(PathBuf, String)>>,
        refuse: bool,
    }

    #[async_trait::async_trait]
    impl ArtifactSink for RecordingSink {
        async fn keep(
            &self,
            artifact: &Path,
            _plan: &RenderPlan,
            timeline_id: &str,
        ) -> Result<String, ProjectError> {
            self.kept
                .lock()
                .unwrap()
                .push((artifact.to_path_buf(), timeline_id.to_string()));
            assert!(artifact.is_file(), "the artifact is handed over as a file");
            if self.refuse {
                return Err(ProjectError::domain(
                    "UNSUPPORTED_MEDIA_TYPE",
                    "the shelf would not take it",
                ));
            }
            Ok("asset-1".to_string())
        }
    }

    #[cfg(unix)]
    fn write_script(directory: &Path, name: &str, body: &str) -> PathBuf {
        use std::io::Write;
        let path = directory.join(name);
        let mut file = std::fs::File::create(&path).expect("script");
        file.write_all(body.as_bytes()).expect("script body");
        drop(file);
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
            .expect("script is executable");
        path
    }

    #[test]
    fn one_export_runs_at_a_time() {
        let registry = ExportRegistry::new();
        let first = registry.begin("tl-1").expect("the place is free");
        assert_eq!(first.task.status, ExportStatus::Queued);
        assert_eq!(first.task.timeline_id, "tl-1");

        let error = registry
            .begin("tl-1")
            .expect_err("somebody is in the place");
        assert_eq!(error.code(), "CONFLICT");
        assert_eq!(error.to_string(), "An export is already running.");

        registry.finish(&first.task.id, ExportStatus::Done, None, Some("a".into()));
        assert!(registry.begin("tl-1").is_ok(), "the place is free again");
    }

    #[test]
    fn a_handle_nobody_issued_is_missing() {
        let registry = ExportRegistry::new();
        assert_eq!(
            registry.snapshot("nothing").unwrap_err().code(),
            "EXPORT_NOT_FOUND"
        );
        assert_eq!(
            registry.cancel("nothing").unwrap_err().code(),
            "EXPORT_NOT_FOUND"
        );
    }

    #[test]
    fn progress_never_goes_backwards_and_never_leaves_its_range() {
        let registry = ExportRegistry::new();
        let reservation = registry.begin("tl-1").expect("the place is free");
        let id = reservation.task.id.clone();
        registry.set_running(&id);
        registry.set_progress(&id, 0.5);
        registry.set_progress(&id, 0.2);
        registry.set_progress(&id, 4.0);
        let task = registry.snapshot(&id).expect("still tracked");
        assert_eq!(task.status, ExportStatus::Running);
        assert_eq!(task.progress01, 1.0);

        registry.set_progress(&id, -3.0);
        assert_eq!(registry.snapshot(&id).unwrap().progress01, 1.0);
    }

    #[tokio::test]
    async fn cancelling_reaches_the_render_and_the_status_follows_it() {
        let registry = ExportRegistry::new();
        let mut reservation = registry.begin("tl-1").expect("the place is free");
        let id = reservation.task.id.clone();
        registry.set_running(&id);

        let asked = registry.cancel(&id).expect("the handle is known");
        assert_eq!(
            asked.status,
            ExportStatus::Running,
            "the answer is the status as it stands"
        );
        reservation
            .cancel
            .try_recv()
            .expect("the stop request reached the process");

        registry.finish(&id, ExportStatus::Cancelled, None, None);
        let task = registry.snapshot(&id).expect("still tracked");
        assert_eq!(task.status, ExportStatus::Cancelled);
        // A stop request for something that already ended is answered with
        // how it ended rather than refused.
        assert_eq!(
            registry.cancel(&id).unwrap().status,
            ExportStatus::Cancelled
        );
    }

    #[test]
    fn a_finished_export_is_read_for_a_while_and_then_forgotten() {
        let registry = ExportRegistry::new();
        let reservation = registry.begin("tl-1").expect("the place is free");
        let id = reservation.task.id.clone();
        registry.finish(&id, ExportStatus::Done, None, Some("asset-1".into()));
        // A done render reports as done, at the end of its progress.
        let task = registry.snapshot(&id).unwrap();
        assert_eq!(task.status, ExportStatus::Done);
        assert_eq!(task.asset_id.as_deref(), Some("asset-1"));
        assert_eq!(task.progress01, 1.0);

        // Aged out: the same handle then reads as one that was never issued,
        // which is what tells the dialog to start over.
        {
            let mut tasks = registry.tasks.write().unwrap();
            let entry = tasks.get_mut(&id).unwrap();
            entry.forget_after = Instant::now() - Duration::from_secs(1);
        }
        assert_eq!(
            registry.snapshot(&id).unwrap_err().code(),
            "EXPORT_NOT_FOUND"
        );
        assert!(registry.is_empty());
    }

    #[test]
    fn starting_an_export_drops_the_ones_nobody_is_coming_back_for() {
        let registry = ExportRegistry::new();
        let first = registry.begin("tl-1").expect("the place is free");
        registry.finish(
            &first.task.id,
            ExportStatus::Failed,
            Some("no".into()),
            None,
        );
        {
            let mut tasks = registry.tasks.write().unwrap();
            let entry = tasks.get_mut(&first.task.id).unwrap();
            entry.forget_after = Instant::now() - Duration::from_secs(1);
        }
        registry
            .begin("tl-1")
            .expect("an old entry is not in the way");
        assert_eq!(registry.len(), 1);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_render_is_driven_to_done_and_filed() {
        let root = tempfile::tempdir().unwrap();
        let script = write_script(
            root.path(),
            "fake-ffmpeg.sh",
            "#!/bin/sh\n\
             printf 'out_time_ms=1000000\\nprogress=continue\\n'\n\
             printf 'progress=end\\n'\n\
             printf 'artifact' > out.mp4\n\
             exit 0\n",
        );
        let registry = Arc::new(ExportRegistry::new());
        let sink = Arc::new(RecordingSink::default());
        let reservation = registry.begin("tl-1").expect("the place is free");
        let id = reservation.task.id.clone();
        let run = ExportRun {
            id: id.clone(),
            timeline_id: "tl-1".to_string(),
            plan: plan_stub(),
            program: script,
            encoder: "libx264".to_string(),
            temp_root: root.path().join("tmp"),
            timeout: Duration::from_secs(10),
        };
        let _cancel = reservation.cancel;

        drive(
            Arc::clone(&registry),
            Arc::clone(&sink) as Arc<dyn ArtifactSink>,
            run,
            oneshot::channel().1,
        )
        .await;

        let task = registry.snapshot(&id).expect("still tracked");
        assert_eq!(task.status, ExportStatus::Done);
        assert_eq!(task.asset_id.as_deref(), Some("asset-1"));
        assert_eq!(task.progress01, 1.0);
        let kept = sink.kept.lock().unwrap();
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].1, "tl-1");
        assert!(!kept[0].0.exists(), "the artifact was taken away");
        // The scratch directory went with it.
        assert!(!root
            .path()
            .join("tmp")
            .join(format!("export-{id}"))
            .exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_render_that_fails_is_reported_with_its_own_words_and_no_scratch() {
        let root = tempfile::tempdir().unwrap();
        let script = write_script(
            root.path(),
            "fake-fail.sh",
            "#!/bin/sh\nprintf 'the encoder gave up\\n' >&2\nexit 1\n",
        );
        let registry = Arc::new(ExportRegistry::new());
        let sink = Arc::new(RecordingSink::default());
        let reservation = registry.begin("tl-1").expect("the place is free");
        let id = reservation.task.id.clone();
        let run = ExportRun {
            id: id.clone(),
            timeline_id: "tl-1".to_string(),
            plan: plan_stub(),
            program: script,
            encoder: "libx264".to_string(),
            temp_root: root.path().join("tmp"),
            timeout: Duration::from_secs(10),
        };
        let _cancel = reservation.cancel;

        drive(
            Arc::clone(&registry),
            Arc::clone(&sink) as Arc<dyn ArtifactSink>,
            run,
            oneshot::channel().1,
        )
        .await;

        let task = registry.snapshot(&id).expect("still tracked");
        assert_eq!(task.status, ExportStatus::Failed);
        assert!(
            task.message
                .as_deref()
                .is_some_and(|message| message.contains("gave up")),
            "{:?}",
            task.message
        );
        assert!(sink.kept.lock().unwrap().is_empty());
        assert!(!root
            .path()
            .join("tmp")
            .join(format!("export-{id}"))
            .exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_render_whose_filing_fails_is_failed_rather_than_lost() {
        let root = tempfile::tempdir().unwrap();
        let script = write_script(
            root.path(),
            "fake-ffmpeg.sh",
            "#!/bin/sh\nprintf 'progress=end\\n'\nprintf 'artifact' > out.mp4\nexit 0\n",
        );
        let registry = Arc::new(ExportRegistry::new());
        let sink = Arc::new(RecordingSink {
            refuse: true,
            ..RecordingSink::default()
        });
        let reservation = registry.begin("tl-1").expect("the place is free");
        let id = reservation.task.id.clone();
        let run = ExportRun {
            id: id.clone(),
            timeline_id: "tl-1".to_string(),
            plan: plan_stub(),
            program: script,
            encoder: "libx264".to_string(),
            temp_root: root.path().join("tmp"),
            timeout: Duration::from_secs(10),
        };
        let _cancel = reservation.cancel;

        drive(
            Arc::clone(&registry),
            Arc::clone(&sink) as Arc<dyn ArtifactSink>,
            run,
            oneshot::channel().1,
        )
        .await;

        let task = registry.snapshot(&id).expect("still tracked");
        assert_eq!(task.status, ExportStatus::Failed);
        assert!(task
            .message
            .as_deref()
            .unwrap()
            .contains("would not take it"));
        assert!(!root
            .path()
            .join("tmp")
            .join(format!("export-{id}"))
            .exists());
    }
}
