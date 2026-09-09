//! Talking to generation providers.
//!
//! [`providers`] is the configuration domain — channels, model references,
//! and what may be disclosed about a stored credential. [`adapters`] turns
//! that configuration into an HTTP call, one module per wire protocol.
//! [`error`] names what can go wrong on the provider side, which is a
//! different thing from what can go wrong on the storage side: the client
//! recovers from the first by opening Settings and from the second by
//! retrying. [`media`] is where a reference to a stored asset becomes bytes,
//! and where the size and format rules live so that no adapter has to repeat
//! them.
//!
//! [`gateway`] sits above all four and is what the rest of the program calls:
//! it picks the channel, merges the parameters, decides between answering at
//! once and starting a job, and asks again when waiting would help. [`jobs`]
//! keeps the handles a started job is polled by, for as long as polling one
//! could still mean anything.
//!
//! [`context`] is the other side of the same boundary: where the gateway turns
//! a request into a call, this turns a node and its place in the graph into
//! that request.
//!
//! [`ingest`] is the last step of the journey: an answer becomes files in the
//! project, each carrying a record of the run and the node it came out of.
//!
//! The types below are the whole generation vocabulary that leaves this
//! module: a request phrased in the project's own terms and a result phrased
//! as bytes with a mime type. No provider field name appears in either, so
//! nothing above the adapters has to know who answered.

pub mod adapters;
pub mod context;
pub mod error;
pub mod gateway;
pub mod ingest;
pub mod jobs;
pub mod media;
pub mod providers;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::domain::{AssetId, Capability, IsoTimestamp};
use crate::metadata::Protocol;

pub use context::{collect_generation_inputs, context_node_ids, ResolvedInputs};
pub use error::ProviderError;
pub use gateway::Gateway;
pub use ingest::ingest_generated;
pub use jobs::TaskRegistry;
pub use providers::{ProbeReport, ProviderRepo, ResolvedModel};

/// One generation, in the project's words.
///
/// `params` arrives already merged — node parameters over global preferences
/// over built-in defaults — so an adapter never has to know that a settings
/// dialog exists.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateRequest {
    pub capability: Capability,
    /// `channelId::modelId`; empty means the default for the capability.
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub prompt: String,
    /// An instruction that frames the prompt rather than forming part of it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
    #[serde(default)]
    pub params: serde_json::Map<String, serde_json::Value>,
    /// Reference media: what to edit, what to imitate, which frames to land on.
    #[serde(default)]
    pub inputs: Vec<GenerateInput>,
}

impl GenerateRequest {
    pub fn param(&self, key: &str) -> Option<&serde_json::Value> {
        self.params.get(key)
    }

    pub fn text_param(&self, key: &str) -> Option<&str> {
        self.param(key).and_then(|value| value.as_str())
    }

    pub fn int_param(&self, key: &str) -> Option<i64> {
        let value = self.param(key)?;
        value
            .as_i64()
            .or_else(|| value.as_u64().and_then(|value| i64::try_from(value).ok()))
            .or_else(|| value.as_f64().map(|value| value as i64))
            // A number can arrive quoted, and dropping it here while
            // `float_param` accepts the same string would surprise an adapter.
            .or_else(|| value.as_str().and_then(|value| value.trim().parse().ok()))
    }

    pub fn float_param(&self, key: &str) -> Option<f64> {
        let value = self.param(key)?;
        value.as_f64().or_else(|| {
            value
                .as_str()
                .and_then(|value| value.trim().parse::<f64>().ok())
        })
    }

    pub fn bool_param(&self, key: &str) -> Option<bool> {
        self.param(key).and_then(|value| value.as_bool())
    }

    /// Streaming is a text parameter rather than a field: only text has
    /// anything to stream, and the caller opts in per request.
    pub fn wants_stream(&self) -> bool {
        self.bool_param("stream").unwrap_or(false)
    }

    /// The instruction that frames the prompt rather than forming part of it.
    ///
    /// A parameter can carry the same meaning as the field, and a request with
    /// both means it twice; the field wins. An instruction of nothing but
    /// whitespace is no instruction, and sending one would ask a model to obey
    /// a blank page.
    pub fn instruction(&self) -> Option<&str> {
        self.system
            .as_deref()
            .or_else(|| self.text_param("instructions"))
            .map(str::trim)
            .filter(|text| !text.is_empty())
    }

    pub fn inputs_in(&self, role: InputRole) -> impl Iterator<Item = &GenerateInput> {
        self.inputs.iter().filter(move |input| input.role == role)
    }
}

/// Why a piece of media travels with a request. The role, not the mime type,
/// decides which provider field it lands in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InputRole {
    Reference,
    FirstFrame,
    LastFrame,
    Mask,
    ControlVideo,
    ControlAudio,
}

impl InputRole {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Reference => "reference",
            Self::FirstFrame => "firstFrame",
            Self::LastFrame => "lastFrame",
            Self::Mask => "mask",
            Self::ControlVideo => "controlVideo",
            Self::ControlAudio => "controlAudio",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateInput {
    pub role: InputRole,
    pub asset_id: AssetId,
}

/// One answer. Text and media are alternatives rather than a union because a
/// provider can return a caption beside the image it made.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct GenerateResult {
    pub text: Option<String>,
    pub items: Vec<GeneratedItem>,
    /// For display and statistics only; nothing decides based on it.
    pub usage: Option<Usage>,
}

impl GenerateResult {
    /// A 200 that carried nothing usable, which the gateway reports as
    /// `PROVIDER_NO_OUTPUT` rather than handing back an empty answer.
    pub fn is_empty(&self) -> bool {
        self.items.is_empty() && self.text.as_deref().unwrap_or_default().trim().is_empty()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct GeneratedItem {
    pub bytes: Vec<u8>,
    pub mime: String,
    /// Reuses [`Capability`]: an item is exactly one modality, and a fourth
    /// enum with the same four members would only drift.
    pub kind: Capability,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub images: Option<u32>,
    pub seconds: Option<f64>,
}

/// An upstream job that outlives the request that started it.
#[derive(Debug, Clone, PartialEq)]
pub struct AsyncTask {
    /// The handle the client polls with. Ours, not the provider's.
    pub id: String,
    /// The provider's own job handle. Opaque, and never disclosed: it is a
    /// credential-adjacent identifier in some protocols.
    pub reference: String,
    pub protocol: Protocol,
    pub capability: Capability,
    /// The resolved `channelId::modelId`, kept so a poll cannot be pointed at
    /// a different channel than the one that created the job.
    pub model: String,
    pub created_at: IsoTimestamp,
}

#[derive(Debug, Clone, PartialEq)]
pub enum TaskState {
    Pending { retry_after_ms: u64 },
    Succeeded(GenerateResult),
    Failed { message: String, retryable: bool },
}

impl TaskState {
    pub fn pending(retry_after: Duration) -> Self {
        Self::Pending {
            retry_after_ms: retry_after.as_millis().min(u64::MAX as u128) as u64,
        }
    }
}

/// Cooperative cancellation for one in-flight generation.
///
/// A flag plus a wake-up rather than a dropped future: the adapters sit in
/// the middle of an HTTP exchange, and the interesting question is always
/// "should the *next* step still happen".
#[derive(Clone, Default)]
pub struct Cancel {
    flag: Arc<AtomicBool>,
    wake: Arc<tokio::sync::Notify>,
}

impl Cancel {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
        self.wake.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    pub fn check(&self) -> Result<(), ProviderError> {
        if self.is_cancelled() {
            Err(ProviderError::Cancelled)
        } else {
            Ok(())
        }
    }

    /// A backoff wait that ends at once on cancellation instead of running
    /// its full duration against a client that has already gone.
    pub async fn wait(&self, delay: Duration) -> Result<(), ProviderError> {
        let wake = Arc::clone(&self.wake);
        // Registered before the flag is read, so a cancel that lands in
        // between still wakes this waiter.
        let woken = wake.notified();
        self.check()?;
        tokio::select! {
            _ = tokio::time::sleep(delay) => self.check(),
            _ = woken => Err(ProviderError::Cancelled),
        }
    }
}

/// Callback invoked once per chunk of streamed text.
pub type DeltaHandler = Arc<dyn Fn(&str) + Send + Sync>;

/// Where streamed text goes as it arrives.
///
/// Streaming only accelerates the display: the adapter still aggregates the
/// full answer, because what gets stored is the aggregate.
#[derive(Clone, Default)]
pub struct DeltaSink {
    sink: Option<DeltaHandler>,
}

impl DeltaSink {
    pub fn new(sink: DeltaHandler) -> Self {
        Self { sink: Some(sink) }
    }

    /// True when somebody is watching, which is what decides whether a
    /// provider is asked for a stream at all.
    pub fn is_streaming(&self) -> bool {
        self.sink.is_some()
    }

    pub fn push(&self, text: &str) {
        if !text.is_empty() {
            if let Some(sink) = &self.sink {
                sink(text);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn request(params: serde_json::Value) -> GenerateRequest {
        GenerateRequest {
            capability: Capability::Image,
            params: params.as_object().cloned().unwrap_or_default(),
            ..GenerateRequest::default()
        }
    }

    #[test]
    fn a_parameter_is_read_as_the_type_the_caller_asked_for() {
        // Providers disagree about whether a number arrives as a number, so
        // the accessors coerce rather than reject.
        let request = request(serde_json::json!({
            "count": 2,
            "seconds": "6",
            "temperature": 0.7,
            "ratio": "16:9",
            "watermark": true,
            "size": null,
        }));
        assert_eq!(request.int_param("count"), Some(2));
        assert_eq!(request.int_param("seconds"), Some(6));
        assert_eq!(request.int_param("temperature"), Some(0));
        assert_eq!(request.float_param("temperature"), Some(0.7));
        assert_eq!(request.text_param("ratio"), Some("16:9"));
        assert_eq!(request.bool_param("watermark"), Some(true));
        assert_eq!(request.param("size"), Some(&serde_json::Value::Null));
        assert_eq!(request.text_param("size"), None);
        assert_eq!(request.int_param("missing"), None);
    }

    #[test]
    fn streaming_is_off_unless_the_request_says_so() {
        assert!(!request(serde_json::json!({})).wants_stream());
        assert!(request(serde_json::json!({ "stream": true })).wants_stream());
        assert!(!request(serde_json::json!({ "stream": "yes" })).wants_stream());
    }

    #[test]
    fn inputs_keep_their_order_within_a_role() {
        let mut request = request(serde_json::json!({}));
        request.inputs = vec![
            GenerateInput {
                role: InputRole::FirstFrame,
                asset_id: "a1".into(),
            },
            GenerateInput {
                role: InputRole::Reference,
                asset_id: "a2".into(),
            },
            GenerateInput {
                role: InputRole::FirstFrame,
                asset_id: "a3".into(),
            },
        ];
        let frames: Vec<&str> = request
            .inputs_in(InputRole::FirstFrame)
            .map(|input| input.asset_id.as_str())
            .collect();
        assert_eq!(frames, ["a1", "a3"]);
        assert_eq!(request.inputs_in(InputRole::Mask).count(), 0);
    }

    #[test]
    fn an_answer_counts_as_empty_unless_it_carries_text_or_media() {
        assert!(GenerateResult::default().is_empty());
        // Whitespace is not an answer; reporting it as one would store a
        // blank text node instead of surfacing the provider failure.
        assert!(GenerateResult {
            text: Some("   ".into()),
            ..Default::default()
        }
        .is_empty());
        assert!(!GenerateResult {
            text: Some("a caption".into()),
            ..Default::default()
        }
        .is_empty());
        assert!(!GenerateResult {
            items: vec![GeneratedItem {
                bytes: vec![1],
                mime: "image/png".into(),
                kind: Capability::Image,
                width: None,
                height: None,
                duration_ms: None,
            }],
            ..Default::default()
        }
        .is_empty());
    }

    #[test]
    fn a_pending_task_carries_the_retry_hint_in_milliseconds() {
        assert_eq!(
            TaskState::pending(Duration::from_millis(1500)),
            TaskState::Pending {
                retry_after_ms: 1500
            }
        );
        assert_eq!(
            TaskState::pending(Duration::ZERO),
            TaskState::Pending { retry_after_ms: 0 }
        );
    }

    #[tokio::test]
    async fn cancelling_ends_a_backoff_wait_at_once() {
        let cancel = Cancel::new();
        assert!(cancel.check().is_ok());

        let waiter = {
            let cancel = cancel.clone();
            tokio::spawn(async move {
                cancel
                    .wait(Duration::from_secs(60))
                    .await
                    .unwrap_err()
                    .code()
                    .to_string()
            })
        };
        // Yield so the waiter registers its wake-up before the cancel lands.
        tokio::task::yield_now().await;
        cancel.cancel();

        // The timeout is the assertion: a wake-up that never arrives would
        // leave the wait running its full backoff.
        let code = tokio::time::timeout(Duration::from_secs(5), waiter)
            .await
            .expect("a cancel must not wait out the backoff")
            .expect("the waiter must finish");
        assert_eq!(code, "GENERATION_CANCELLED");
        assert_eq!(cancel.check().unwrap_err().code(), "GENERATION_CANCELLED");
    }

    #[test]
    fn the_delta_sink_forwards_only_non_empty_chunks() {
        assert!(!DeltaSink::default().is_streaming());
        DeltaSink::default().push("dropped without a listener");

        let seen = Arc::new(Mutex::new(String::new()));
        let collected = Arc::clone(&seen);
        let sink = DeltaSink::new(Arc::new(move |chunk: &str| {
            collected
                .lock()
                .expect("the sink is not held across a call")
                .push_str(chunk);
        }));
        assert!(sink.is_streaming());
        sink.push("Hello");
        sink.push("");
        sink.push(", world");
        assert_eq!(
            seen.lock()
                .expect("the sink is not held across a call")
                .as_str(),
            "Hello, world"
        );
    }

    #[test]
    fn a_request_travels_in_camel_case_and_tolerates_absent_sections() {
        let request: GenerateRequest = serde_json::from_value(serde_json::json!({
            "capability": "video",
            "prompt": "a lantern over a lake",
            "inputs": [{ "role": "firstFrame", "assetId": "a1" }],
        }))
        .expect("a minimal request must decode");
        assert_eq!(request.capability, Capability::Video);
        assert!(request.model.is_empty());
        assert!(request.params.is_empty());
        assert_eq!(request.inputs[0].role, InputRole::FirstFrame);

        let wire = serde_json::to_value(&request).expect("a request must encode");
        assert_eq!(wire["inputs"][0]["assetId"], "a1");
        assert_eq!(wire["inputs"][0]["role"], "firstFrame");
        assert!(wire.get("system").is_none());
    }
}
