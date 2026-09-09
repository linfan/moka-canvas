//! The upstream jobs this process is tracking.
//!
//! A generation that answers at once needs no bookkeeping; a shot that takes
//! minutes does, because the request that started it is long gone by the time
//! it finishes. What is kept here is the link between the handle a client was
//! given and the job a provider is running, which is exactly as much as one
//! poll needs and nothing that outlives it.

use std::collections::HashMap;
use std::sync::RwLock;
use std::time::{Duration, Instant};

use super::error::ProviderError;
use super::AsyncTask;

/// How long a job nobody came back for is still worth tracking.
///
/// A shot finishes in minutes, so this is generous by an order of magnitude;
/// what it bounds is a handle left behind by a window that was closed, which
/// would otherwise sit in the table for the life of the process.
const TRACKED_FOR: Duration = Duration::from_secs(60 * 60);

/// One tracked job, and the moment it stops being worth tracking.
#[derive(Debug)]
struct Tracked {
    task: AsyncTask,
    forget_after: Instant,
}

/// The jobs started here, looked up by the handle a client polls with.
///
/// In memory and nothing else. A job is a conversation between one run of this
/// process and one provider: a handle that survived a restart would name a
/// channel configuration that may have been edited since, and polling it would
/// either fail confusingly or ask the wrong provider. Reporting such a handle
/// as gone is honest; storing it would promise a poll that cannot be placed.
#[derive(Debug, Default)]
pub struct TaskRegistry {
    tracked: RwLock<HashMap<String, Tracked>>,
}

impl TaskRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Starts tracking a job.
    ///
    /// Pruning happens here rather than on a timer: a table that only grows
    /// when jobs are started is a table that can be cleaned when jobs are
    /// started, and nothing else needs to run.
    pub fn register(&self, task: AsyncTask) {
        let mut tracked = self.tracked.write().expect("a panic left this unlocked");
        let now = Instant::now();
        tracked.retain(|_, entry| entry.forget_after > now);
        tracked.insert(
            task.id.clone(),
            Tracked {
                task,
                forget_after: now + TRACKED_FOR,
            },
        );
    }

    /// The job a handle names.
    ///
    /// One that was tracked and grew old is reported differently from one that
    /// never was: the first had a job behind it, and the difference is what
    /// tells a client to start over rather than to look again.
    pub fn get(&self, id: &str) -> Result<AsyncTask, ProviderError> {
        let mut tracked = self.tracked.write().expect("a panic left this unlocked");
        match tracked.get(id) {
            None => Err(ProviderError::TaskMissing {
                task: id.to_string(),
            }),
            Some(entry) if entry.forget_after <= Instant::now() => {
                tracked.remove(id);
                Err(ProviderError::TaskExpired {
                    task: id.to_string(),
                })
            }
            Some(entry) => Ok(entry.task.clone()),
        }
    }

    /// Stops tracking a job that will not answer again.
    pub fn forget(&self, id: &str) {
        self.tracked
            .write()
            .expect("a panic left this unlocked")
            .remove(id);
    }

    pub fn len(&self) -> usize {
        self.tracked
            .read()
            .expect("a panic left this unlocked")
            .len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::Capability;
    use crate::metadata::Protocol;

    fn task(id: &str) -> AsyncTask {
        AsyncTask {
            id: id.into(),
            reference: format!("job-{id}"),
            protocol: Protocol::Openai,
            capability: Capability::Video,
            model: "channel-1::a-video-model".into(),
            created_at: "2026-01-01T00:00:00Z".into(),
        }
    }

    /// A handle whose tracking ran out, which is the only way to reach the
    /// expiry branch without waiting an hour for it.
    fn aged(id: &str) -> Tracked {
        Tracked {
            task: task(id),
            forget_after: Instant::now() - Duration::from_secs(1),
        }
    }

    #[test]
    fn a_job_is_tracked_under_the_handle_a_client_polls_with() {
        let registry = TaskRegistry::new();
        assert!(registry.is_empty());

        registry.register(task("task-1"));
        let tracked = registry.get("task-1").expect("the handle is known");
        assert_eq!(tracked.reference, "job-task-1");
        assert_eq!(registry.len(), 1);
    }

    #[test]
    fn a_handle_that_was_never_issued_is_missing_rather_than_expired() {
        let registry = TaskRegistry::new();
        let error = registry.get("task-none").expect_err("nothing is tracked");
        assert_eq!(error.code(), "TASK_NOT_FOUND");
    }

    #[test]
    fn a_handle_nobody_came_back_for_expires_and_leaves_the_table() {
        let registry = TaskRegistry::new();
        registry
            .tracked
            .write()
            .expect("a panic left this unlocked")
            .insert("task-old".into(), aged("task-old"));

        let error = registry.get("task-old").expect_err("the tracking ran out");
        assert_eq!(error.code(), "TASK_EXPIRED");
        // Reported once and dropped: a second look finds nothing, which is the
        // same answer a client would get for a handle it invented.
        assert_eq!(
            registry.get("task-old").unwrap_err().code(),
            "TASK_NOT_FOUND"
        );
        assert!(registry.is_empty());
    }

    #[test]
    fn a_job_that_answered_is_not_tracked_again() {
        let registry = TaskRegistry::new();
        registry.register(task("task-1"));
        registry.forget("task-1");
        assert!(registry.is_empty());
        // Forgetting a handle that is not there is not an error: the job
        // ending and a poll noticing it can happen in either order.
        registry.forget("task-1");
        registry.forget("task-none");
    }

    #[test]
    fn starting_a_job_drops_the_ones_nobody_is_coming_back_for() {
        let registry = TaskRegistry::new();
        registry
            .tracked
            .write()
            .expect("a panic left this unlocked")
            .insert("task-old".into(), aged("task-old"));

        registry.register(task("task-new"));
        assert_eq!(registry.len(), 1, "only the live job is left");
        assert!(registry.get("task-new").is_ok());
    }
}
