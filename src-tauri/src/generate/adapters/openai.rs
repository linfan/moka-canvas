//! The OpenAI-compatible protocol, which most gateways and aggregators also
//! speak.
//!
//! Four capabilities over five endpoints. Text prefers the newer answer
//! endpoint and falls back to chat completions, which every compatible gateway
//! has; an image with references travels as a multipart body rather than as
//! JSON; audio arrives as the bytes themselves; and video is a job started here
//! and collected later.

use std::time::Duration;

use base64::Engine;
use reqwest::header::CONTENT_TYPE;
use serde::Deserialize;
use serde_json::{json, Map, Value};

use super::{
    answer, exchange, image_item, media_item, open_stream, provider_error, read_stream, succeeded,
    usage_of, ChannelCall, Opened, ProviderAdapter, Reply, StreamEvent, MAX_MODEL_LIST_BYTES,
    MODEL_LIST_TIMEOUT,
};
use crate::domain::{new_id, now_iso, Capability};
use crate::generate::error::ProviderError;
use crate::generate::media::{video_images, video_layout, MediaInput, MultipartBody, VideoLayout};
use crate::generate::{
    AsyncTask, Cancel, DeltaSink, GenerateRequest, GenerateResult, GeneratedItem, InputRole,
    TaskState, Usage,
};
use crate::metadata::Protocol;

const MODELS: &str = "/models";
const SPEECH: &str = "/audio/speech";
const IMAGE_CREATE: &str = "/images/generations";
const IMAGE_EDIT: &str = "/images/edits";
const VIDEOS: &str = "/videos";

/// Identifiers expected to speak the newer answer endpoint. Anything else goes
/// straight to chat completions, which is the one route every compatible
/// gateway implements.
const ANSWER_FAMILIES: [&str; 5] = ["gpt-", "o1", "o3", "o4", "chatgpt-"];

/// How long a caller should wait before looking at a job again. The provider
/// does not say, and asking more often than this only adds refusals.
const POLL_INTERVAL: Duration = Duration::from_secs(5);

/// The mime an audio answer is read as when the provider did not say.
const FALLBACK_AUDIO_MIME: &str = "audio/mpeg";
const FALLBACK_VIDEO_MIME: &str = "video/mp4";

pub(super) static ADAPTER: OpenAiAdapter = OpenAiAdapter;

pub struct OpenAiAdapter;

#[async_trait::async_trait]
impl ProviderAdapter for OpenAiAdapter {
    fn protocol(&self) -> Protocol {
        Protocol::Openai
    }

    async fn generate(
        &self,
        call: &ChannelCall,
        request: &GenerateRequest,
        inputs: &[MediaInput],
        cancel: &Cancel,
    ) -> Result<GenerateResult, ProviderError> {
        match request.capability {
            Capability::Text => text(call, request, &DeltaSink::default(), cancel).await,
            Capability::Image => image(call, request, inputs, cancel).await,
            Capability::Audio => speech(call, request, cancel).await,
            // Starting a job answers at once, but waiting it out inside one
            // request would hold a connection open for minutes: the gateway
            // routes video through `create_task` instead.
            Capability::Video => Err(ProviderError::invalid(
                "video generation runs as a task rather than in one call",
            )),
        }
    }

    async fn generate_stream(
        &self,
        call: &ChannelCall,
        request: &GenerateRequest,
        _inputs: &[MediaInput],
        sink: &DeltaSink,
        cancel: &Cancel,
    ) -> Result<GenerateResult, ProviderError> {
        match request.capability {
            Capability::Text => text(call, request, sink, cancel).await,
            // Nothing else arrives in pieces. Saying so keeps a mistaken call
            // from quietly dropping every delta it was handed a sink for.
            other => Err(ProviderError::invalid(format!(
                "{} generation does not stream",
                other.as_str()
            ))),
        }
    }

    async fn create_task(
        &self,
        call: &ChannelCall,
        request: &GenerateRequest,
        inputs: &[MediaInput],
        cancel: &Cancel,
    ) -> Result<AsyncTask, ProviderError> {
        if request.capability != Capability::Video {
            return Err(ProviderError::invalid(format!(
                "{} generation answers at once and has no job to start",
                request.capability.as_str()
            )));
        }
        cancel.check()?;
        let reply = answer(
            call,
            call.post(VIDEOS).json(&video_body(call, request, inputs)),
            Capability::Video,
        )
        .await?;
        let payload = reply.value()?;
        // Without a handle the job cannot be collected, which makes a 200 that
        // lacks one a failure rather than an answer.
        let reference = payload
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| {
                ProviderError::NoOutput("the job started without a handle to poll".to_string())
            })?
            .to_string();
        Ok(AsyncTask {
            // Ours, not the provider's: the handle a client polls with must not
            // change when a channel is reconfigured.
            id: new_id(),
            reference,
            protocol: Protocol::Openai,
            capability: Capability::Video,
            model: call.reference.clone(),
            created_at: now_iso(),
        })
    }

    async fn poll_task(
        &self,
        call: &ChannelCall,
        task: &AsyncTask,
        cancel: &Cancel,
    ) -> Result<TaskState, ProviderError> {
        cancel.check()?;
        let reply = exchange(
            call.get(&format!("{VIDEOS}/{}", task.reference)),
            call.budgets.poll_timeout(),
            call.budgets.max_response_bytes,
        )
        .await?;
        // A job the provider no longer knows is not a failure to look: it is
        // the end of looking, and a different status says so.
        if matches!(reply.status, 404 | 410) {
            return Err(ProviderError::TaskExpired {
                task: task.id.clone(),
            });
        }
        if !succeeded(reply.status) {
            return Err(provider_error(&reply, &call.api_key));
        }
        let payload = reply.value()?;
        let status = payload
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_lowercase();
        match status.as_str() {
            "succeeded" | "completed" => collect(call, task).await,
            "expired" => Err(ProviderError::TaskExpired {
                task: task.id.clone(),
            }),
            "failed" | "cancelled" | "canceled" | "incomplete" => Ok(outcome(&payload, &status)),
            // Queued, in progress, or a status this code has not met: the job
            // is not finished, and saying anything else would end it early.
            _ => Ok(TaskState::pending(POLL_INTERVAL)),
        }
    }
}

/// Asks the channel what it currently offers.
pub(super) async fn list_models(call: &ChannelCall) -> Result<Vec<String>, ProviderError> {
    let reply = exchange(call.get(MODELS), MODEL_LIST_TIMEOUT, MAX_MODEL_LIST_BYTES).await?;
    if !succeeded(reply.status) {
        return Err(provider_error(&reply, &call.api_key));
    }
    identifiers(&reply)
}

#[derive(Deserialize)]
struct ModelList {
    #[serde(default)]
    data: Vec<ListedModel>,
}

#[derive(Deserialize)]
struct ListedModel {
    id: Option<String>,
}

/// An entry with no usable identifier is dropped rather than reported: one
/// placeholder from a gateway should not hide the rest of the list.
fn identifiers(reply: &Reply) -> Result<Vec<String>, ProviderError> {
    let payload: ModelList = reply.decoded("model list")?;
    Ok(payload
        .data
        .into_iter()
        .filter_map(|model| model.id)
        .map(|identifier| identifier.trim().to_string())
        .filter(|identifier| !identifier.is_empty())
        .collect())
}

fn speaks_answers(model_id: &str) -> bool {
    let lowered = model_id.to_lowercase();
    ANSWER_FAMILIES
        .iter()
        .any(|family| lowered.starts_with(family))
}

/// True when a gateway said it has no such route, which is a reason to try
/// another endpoint rather than a reason to stop.
fn missing_endpoint(status: u16) -> bool {
    matches!(status, 404 | 405 | 501)
}

/// One text endpoint: where it lives, what to send it, and how to read it back.
///
/// A table rather than a branch, because the two endpoints differ in all four
/// of those and a `match` on the path would repeat the pairing at every use.
struct TextEndpoint {
    path: &'static str,
    body: fn(&ChannelCall, &GenerateRequest, bool) -> Value,
    event: fn(&Value) -> StreamEvent,
    result: fn(Value) -> GenerateResult,
}

const ANSWERS: TextEndpoint = TextEndpoint {
    path: "/responses",
    body: answers_body,
    event: answers_event,
    result: answers_result,
};

const CHAT: TextEndpoint = TextEndpoint {
    path: "/chat/completions",
    body: chat_body,
    event: chat_event,
    result: chat_result,
};

/// Why one text endpoint did not answer.
enum Tried {
    /// It has no such route, so asking the next one is worth a request.
    Missing(ProviderError),
    /// Anything else: the request was understood and refused, or never placed.
    Failed(ProviderError),
}

async fn text(
    call: &ChannelCall,
    request: &GenerateRequest,
    sink: &DeltaSink,
    cancel: &Cancel,
) -> Result<GenerateResult, ProviderError> {
    let deadline = call.budgets.timeout_for(Capability::Text);
    let endpoints: &[TextEndpoint] = if speaks_answers(&call.model_id) {
        &[ANSWERS, CHAT]
    } else {
        &[CHAT]
    };

    // A gateway that lists a model is not obliged to implement every endpoint
    // behind it. The fallback happens before anything is streamed, because one
    // after the first delta would show the answer twice.
    let mut missing: Option<ProviderError> = None;
    for endpoint in endpoints {
        match attempt(call, endpoint, request, sink, cancel, deadline).await {
            Ok(result) => return Ok(result),
            Err(Tried::Missing(error)) => missing = Some(error),
            Err(Tried::Failed(error)) => return Err(error),
        }
    }
    Err(missing.unwrap_or_else(|| {
        ProviderError::invalid("no text endpoint on this channel answered".to_string())
    }))
}

async fn attempt(
    call: &ChannelCall,
    endpoint: &TextEndpoint,
    request: &GenerateRequest,
    sink: &DeltaSink,
    cancel: &Cancel,
    deadline: Duration,
) -> Result<GenerateResult, Tried> {
    let body = (endpoint.body)(call, request, sink.is_streaming());
    cancel.check().map_err(Tried::Failed)?;

    if sink.is_streaming() {
        return match open_stream(call, call.post(endpoint.path).json(&body))
            .await
            .map_err(Tried::Failed)?
        {
            Opened::Streaming(response) => {
                read_stream(response, sink, cancel, deadline, endpoint.event)
                    .await
                    .map_err(Tried::Failed)
            }
            Opened::Refused(reply) => Err(refusal(reply, &call.api_key)),
        };
    }

    let reply = exchange(
        call.post(endpoint.path).json(&body),
        deadline,
        call.budgets.max_response_bytes,
    )
    .await
    .map_err(Tried::Failed)?;
    if succeeded(reply.status) {
        let payload = reply.value().map_err(Tried::Failed)?;
        return Ok((endpoint.result)(payload));
    }
    Err(refusal(reply, &call.api_key))
}

/// Maps a refusal onto an error, marking the one case where another endpoint is
/// worth asking.
fn refusal(reply: Reply, api_key: &str) -> Tried {
    let error = provider_error(&reply, api_key);
    if missing_endpoint(reply.status) {
        Tried::Missing(error)
    } else {
        Tried::Failed(error)
    }
}

fn answers_body(call: &ChannelCall, request: &GenerateRequest, streaming: bool) -> Value {
    let mut body = opening(call, "input", request);
    if let Some(system) = request.instruction() {
        body.insert("instructions".into(), json!(system));
    }
    if streaming {
        body.insert("stream".into(), json!(true));
    }
    if let Some(temperature) = request.float_param("temperature") {
        body.insert("temperature".into(), json!(temperature));
    }
    if let Some(tokens) = request.int_param("maxTokens") {
        body.insert("max_output_tokens".into(), json!(tokens));
    }
    if let Some(effort) = request.text_param("reasoningEffort") {
        body.insert("reasoning".into(), json!({ "effort": effort }));
    }
    Value::Object(body)
}

fn answers_event(payload: &Value) -> StreamEvent {
    // Gated on the event's own name: several of them carry a `delta` field, and
    // only one of those is the answer being written.
    match payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
    {
        "response.output_text.delta" => StreamEvent {
            text: payload
                .get("delta")
                .and_then(Value::as_str)
                .map(str::to_string),
            ..StreamEvent::default()
        },
        "response.completed" => StreamEvent {
            complete: payload
                .get("response")
                .and_then(|response| response.get("output_text"))
                .and_then(Value::as_str)
                .map(str::to_string),
            usage: payload
                .get("response")
                .and_then(|response| tokens(response, "input_tokens", "output_tokens")),
            ..StreamEvent::default()
        },
        _ => StreamEvent::default(),
    }
}

fn answers_result(payload: Value) -> GenerateResult {
    let text = payload
        .get("output_text")
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|text| !text.trim().is_empty())
        // A gateway that omits the convenience field still carries the parts.
        .or_else(|| answer_parts(&payload));
    GenerateResult {
        text,
        items: Vec::new(),
        usage: tokens(&payload, "input_tokens", "output_tokens"),
    }
}

/// The text of an answer assembled from its parts, for a response that carries
/// no aggregate field of its own.
fn answer_parts(payload: &Value) -> Option<String> {
    let mut text = String::new();
    for item in payload.get("output")?.as_array()? {
        let parts = item.get("content").and_then(Value::as_array)?;
        for part in parts {
            if let Some(chunk) = part.get("text").and_then(Value::as_str) {
                text.push_str(chunk);
            }
        }
    }
    (!text.trim().is_empty()).then_some(text)
}

fn chat_body(call: &ChannelCall, request: &GenerateRequest, streaming: bool) -> Value {
    let mut messages = Vec::new();
    if let Some(system) = request.instruction() {
        messages.push(json!({ "role": "system", "content": system }));
    }
    messages.push(json!({ "role": "user", "content": request.prompt }));

    let mut body = Map::from_iter([
        ("model".to_string(), json!(call.model_id)),
        ("messages".to_string(), json!(messages)),
    ]);
    if streaming {
        body.insert("stream".into(), json!(true));
    }
    if let Some(temperature) = request.float_param("temperature") {
        body.insert("temperature".into(), json!(temperature));
    }
    if let Some(tokens) = request.int_param("maxTokens") {
        body.insert("max_tokens".into(), json!(tokens));
    }
    if let Some(effort) = request.text_param("reasoningEffort") {
        body.insert("reasoning_effort".into(), json!(effort));
    }
    Value::Object(body)
}

fn chat_event(payload: &Value) -> StreamEvent {
    StreamEvent {
        text: payload
            .pointer("/choices/0/delta/content")
            .and_then(Value::as_str)
            .map(str::to_string),
        // A gateway that buffers answers the whole thing in one closing chunk.
        complete: payload
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str)
            .map(str::to_string),
        usage: tokens(payload, "prompt_tokens", "completion_tokens"),
    }
}

fn chat_result(payload: Value) -> GenerateResult {
    GenerateResult {
        text: payload
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str)
            .map(str::to_string)
            .filter(|text| !text.trim().is_empty()),
        items: Vec::new(),
        usage: tokens(&payload, "prompt_tokens", "completion_tokens"),
    }
}

/// The token totals of an answer, under the names this protocol's endpoints use.
fn tokens(payload: &Value, input: &str, output: &str) -> Option<Usage> {
    usage_of(payload.get("usage"), input, output)
}

/// The two fields every body here starts with: the model this channel resolved,
/// and the prompt under the name this endpoint gives it.
fn opening(call: &ChannelCall, key: &str, request: &GenerateRequest) -> Map<String, Value> {
    Map::from_iter([
        ("model".to_string(), json!(call.model_id)),
        (key.to_string(), json!(request.prompt)),
    ])
}

/// One image generation. References turn it into an edit, which is a different
/// endpoint and a different body shape: the settings travel as form fields
/// beside the bytes rather than as a JSON document.
async fn image(
    call: &ChannelCall,
    request: &GenerateRequest,
    inputs: &[MediaInput],
    cancel: &Cancel,
) -> Result<GenerateResult, ProviderError> {
    cancel.check()?;
    // A mask is an image too, so it is separated before the references are
    // counted: one mask beside one photograph is still a single-reference edit.
    let (masks, references): (Vec<&MediaInput>, Vec<&MediaInput>) = inputs
        .iter()
        .filter(|input| input.is_image())
        .partition(|input| input.role == InputRole::Mask);

    let placed = if references.is_empty() {
        call.post(IMAGE_CREATE).json(&image_body(call, request))
    } else {
        let (body, content_type) = edit_body(call, request, &references, masks.first().copied());
        call.post(IMAGE_EDIT)
            .header(CONTENT_TYPE, content_type)
            .body(body)
    };
    images(call, answer(call, placed, Capability::Image).await?).await
}

fn image_body(call: &ChannelCall, request: &GenerateRequest) -> Value {
    let mut body = opening(call, "prompt", request);
    for (key, value) in [
        ("size", request.text_param("size")),
        ("quality", request.text_param("quality")),
        ("background", request.text_param("background")),
    ] {
        if let Some(value) = value {
            body.insert(key.into(), json!(value));
        }
    }
    if let Some(count) = request.int_param("count").filter(|count| *count > 0) {
        body.insert("n".into(), json!(count));
    }
    Value::Object(body)
}

fn edit_body(
    call: &ChannelCall,
    request: &GenerateRequest,
    references: &[&MediaInput],
    mask: Option<&MediaInput>,
) -> (Vec<u8>, String) {
    // One reference travels as `image` and several as `image[]`, which is the
    // shape the endpoint reads a list from.
    let name = if references.len() == 1 {
        "image"
    } else {
        "image[]"
    };
    let mut body = MultipartBody::new()
        .field("model", &call.model_id)
        .field("prompt", &request.prompt);
    for (key, value) in [
        ("size", request.text_param("size")),
        ("quality", request.text_param("quality")),
        ("background", request.text_param("background")),
    ] {
        if let Some(value) = value {
            body = body.field(key, value);
        }
    }
    if let Some(count) = request.int_param("count").filter(|count| *count > 1) {
        body = body.field("n", &count.to_string());
    }
    for reference in references {
        body = body.file(name, reference);
    }
    // Only one mask is sent even where several were attached: the endpoint has
    // one field for it, and picking the first keeps the choice stable.
    if let Some(mask) = mask {
        body = body.file("mask", mask);
    }
    body.finish()
}

/// The images in an answer, which arrive either inline or as an address to
/// fetch them from.
async fn images(call: &ChannelCall, reply: Reply) -> Result<GenerateResult, ProviderError> {
    let payload = reply.value()?;
    let mut items = Vec::new();
    let mut rewritten = Vec::new();
    let entries = payload.get("data").and_then(Value::as_array);
    for entry in entries.into_iter().flatten() {
        if let Some(inline) = entry.get("b64_json").and_then(Value::as_str) {
            items.push(inline_image(inline)?);
        } else if let Some(address) = entry.get("url").and_then(Value::as_str) {
            items.push(download(call, address).await?);
        }
        // A prompt the provider rewrote is the one part of this answer that is
        // text, and worth showing beside the image it produced.
        if let Some(prompt) = entry.get("revised_prompt").and_then(Value::as_str) {
            rewritten.push(prompt.trim().to_string());
        }
    }
    let count = u32::try_from(items.len()).unwrap_or(u32::MAX);
    Ok(GenerateResult {
        text: (!rewritten.is_empty()).then(|| rewritten.join("\n")),
        items,
        usage: (count > 0).then_some(Usage {
            images: Some(count),
            ..Usage::default()
        }),
    })
}

fn inline_image(inline: &str) -> Result<GeneratedItem, ProviderError> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(inline.trim())
        .map_err(|error| {
            ProviderError::Rejected(format!("the image in the answer is not base64: {error}"))
        })?;
    image_item(bytes)
}

/// Fetches an image the provider left at an address of its own.
async fn download(call: &ChannelCall, address: &str) -> Result<GeneratedItem, ProviderError> {
    let reply = exchange(
        call.fetch(address),
        call.budgets.timeout_for(Capability::Image),
        call.budgets.max_response_bytes,
    )
    .await?;
    if !succeeded(reply.status) {
        return Err(provider_error(&reply, &call.api_key));
    }
    image_item(reply.body)
}

async fn speech(
    call: &ChannelCall,
    request: &GenerateRequest,
    cancel: &Cancel,
) -> Result<GenerateResult, ProviderError> {
    cancel.check()?;
    let reply = answer(
        call,
        call.post(SPEECH).json(&speech_body(call, request)),
        Capability::Audio,
    )
    .await?;
    let mime = reply.content_type();
    let item = media_item(
        reply.body,
        mime.as_deref(),
        Capability::Audio,
        FALLBACK_AUDIO_MIME,
    )?;
    Ok(GenerateResult {
        text: None,
        items: vec![item],
        usage: None,
    })
}

fn speech_body(call: &ChannelCall, request: &GenerateRequest) -> Value {
    let mut body = opening(call, "input", request);
    for (key, parameter) in [("voice", "voice"), ("response_format", "format")] {
        if let Some(value) = request.text_param(parameter) {
            body.insert(key.into(), json!(value));
        }
    }
    if let Some(speed) = request.float_param("speed") {
        body.insert("speed".into(), json!(speed));
    }
    if let Some(instructions) = request.instruction() {
        body.insert("instructions".into(), json!(instructions));
    }
    Value::Object(body)
}

fn video_body(call: &ChannelCall, request: &GenerateRequest, inputs: &[MediaInput]) -> Value {
    let mut body = opening(call, "prompt", request);
    for (key, parameter) in [("resolution", "resolution"), ("ratio", "ratio")] {
        if let Some(value) = request.text_param(parameter) {
            body.insert(key.into(), json!(value));
        }
    }
    if let Some(seconds) = request.int_param("seconds") {
        body.insert("seconds".into(), json!(seconds));
    }
    if let Some(audio) = request.bool_param("generateAudio") {
        body.insert("generate_audio".into(), json!(audio));
    }
    if let Some(watermark) = request.bool_param("watermark") {
        body.insert("watermark".into(), json!(watermark));
    }

    let frames = video_images(inputs);
    match video_layout(inputs, request) {
        VideoLayout::Prompt => {}
        // A shot that lands on a frame the user chose names it, rather than
        // leaving the provider to guess which end of a list is which.
        VideoLayout::OpeningFrame | VideoLayout::OpeningAndClosingFrames => {
            if let Some(frame) = frames.first() {
                body.insert("first_frame".into(), json!(frame.data_url()));
            }
            if let Some(frame) = frames.get(1) {
                body.insert("last_frame".into(), json!(frame.data_url()));
            }
        }
        VideoLayout::Reference => {
            let references: Vec<Value> =
                frames.iter().map(|frame| json!(frame.data_url())).collect();
            body.insert("reference_images".into(), json!(references));
        }
    }
    Value::Object(body)
}

/// Downloads a finished job. The endpoint answers with the bytes rather than a
/// document, so the mime comes from the answer itself.
async fn collect(call: &ChannelCall, task: &AsyncTask) -> Result<TaskState, ProviderError> {
    let reply = answer(
        call,
        call.get(&format!("{VIDEOS}/{}/content", task.reference)),
        Capability::Video,
    )
    .await?;
    let mime = reply.content_type();
    let item = media_item(
        reply.body,
        mime.as_deref(),
        Capability::Video,
        FALLBACK_VIDEO_MIME,
    )?;
    Ok(TaskState::Succeeded(GenerateResult {
        text: None,
        items: vec![item],
        usage: None,
    }))
}

/// A job that finished badly, in the provider's own words where it offered any.
fn outcome(payload: &Value, status: &str) -> TaskState {
    let message = payload
        .pointer("/error/message")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|message| !message.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("the job ended as {status}"));
    // The job ran and the provider refused it: the same request would be
    // refused again, so this is not something waiting fixes.
    TaskState::Failed {
        message,
        retryable: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::GenerateConfig;
    use crate::generate::providers::ResolvedModel;

    /// A channel resolved to one model, pointed at an address nothing answers
    /// so that a body built for it cannot be sent by accident.
    fn channel(model_id: &str) -> ChannelCall {
        let resolved = ResolvedModel {
            reference: format!("channel-1::{model_id}"),
            channel_id: "channel-1".into(),
            model_id: model_id.into(),
            capability: Capability::Text,
            protocol: Protocol::Openai,
            base_url: "https://example.invalid".into(),
        };
        ChannelCall::new(&resolved, "a-key".into(), GenerateConfig::default())
            .expect("a client builds")
    }

    fn generation(capability: Capability, prompt: &str, params: Value) -> GenerateRequest {
        GenerateRequest {
            capability,
            prompt: prompt.into(),
            params: params.as_object().cloned().unwrap_or_default(),
            ..GenerateRequest::default()
        }
    }

    fn media(name: &str, role: InputRole) -> MediaInput {
        MediaInput {
            role,
            asset_id: name.into(),
            name: format!("{name}.png"),
            bytes: b"png".to_vec(),
            mime: "image/png".into(),
        }
    }

    #[test]
    fn a_model_is_sent_to_the_endpoint_it_is_expected_to_speak() {
        for model in [
            "gpt-5.5",
            "gpt-image-2",
            "o3-mini",
            "o4",
            "chatgpt-4o-latest",
            "GPT-4o",
        ] {
            assert!(speaks_answers(model), "{model} should be tried first");
        }
        for model in [
            "llama-3.3",
            "mistral-large",
            "deepseek-v3",
            "qwen-vl",
            "gpt4",
        ] {
            assert!(!speaks_answers(model), "{model} should not be tried first");
        }
    }

    #[test]
    fn only_a_missing_route_makes_a_second_endpoint_worth_asking() {
        // A gateway that lists a model is not obliged to implement every
        // endpoint behind it; one that understood a request and refused it will
        // refuse the same request elsewhere.
        for status in [404, 405, 501] {
            assert!(missing_endpoint(status), "status {status}");
        }
        for status in [400, 401, 403, 422, 429, 500] {
            assert!(!missing_endpoint(status), "status {status}");
        }
    }

    #[test]
    fn a_text_body_carries_only_the_settings_the_request_named() {
        let call = channel("gpt-5.5");
        let plain = generation(Capability::Text, "a lighthouse", json!({}));
        assert_eq!(
            answers_body(&call, &plain, false),
            json!({ "model": "gpt-5.5", "input": "a lighthouse" })
        );

        let mut tuned = generation(
            Capability::Text,
            "a lighthouse",
            json!({ "temperature": 0.4, "maxTokens": "300", "reasoningEffort": "low" }),
        );
        tuned.system = Some("Answer in one sentence.".into());
        // A count that arrives quoted is still a count: dropping it here would
        // silently ignore a setting the user made.
        assert_eq!(
            answers_body(&call, &tuned, true),
            json!({
                "model": "gpt-5.5",
                "input": "a lighthouse",
                "instructions": "Answer in one sentence.",
                "stream": true,
                "temperature": 0.4,
                "max_output_tokens": 300,
                "reasoning": { "effort": "low" },
            })
        );
    }

    #[test]
    fn the_fallback_body_speaks_in_messages() {
        let call = channel("llama-3.3");
        let mut tuned = generation(Capability::Text, "a lighthouse", json!({ "maxTokens": 64 }));
        tuned.system = Some("Be brief.".into());
        assert_eq!(
            chat_body(&call, &tuned, false),
            json!({
                "model": "llama-3.3",
                "messages": [
                    { "role": "system", "content": "Be brief." },
                    { "role": "user", "content": "a lighthouse" },
                ],
                "max_tokens": 64,
            })
        );
    }

    #[test]
    fn an_answer_is_read_from_its_aggregate_or_from_its_parts() {
        let whole = answers_result(json!({
            "output_text": "a lighthouse at dusk",
            "usage": { "input_tokens": 9, "output_tokens": 5 },
        }));
        assert_eq!(whole.text.as_deref(), Some("a lighthouse at dusk"));
        assert_eq!(
            whole.usage,
            Some(Usage {
                input_tokens: Some(9),
                output_tokens: Some(5),
                images: None,
                seconds: None,
            })
        );

        let parts = answers_result(json!({
            "output": [{ "type": "message", "content": [
                { "type": "output_text", "text": "a lighthouse" },
                { "type": "output_text", "text": " at dusk" },
            ]}],
        }));
        assert_eq!(parts.text.as_deref(), Some("a lighthouse at dusk"));
        assert_eq!(parts.usage, None, "totals nobody reported are not invented");

        assert!(answers_result(json!({})).is_empty());
    }

    #[test]
    fn a_chat_answer_is_read_from_its_first_choice() {
        let result = chat_result(json!({
            "choices": [{ "message": { "content": "   " } }],
            "usage": { "prompt_tokens": 3, "completion_tokens": 0 },
        }));
        assert_eq!(result.text, None, "whitespace is not an answer");
        assert_eq!(result.usage.and_then(|usage| usage.input_tokens), Some(3));
    }

    #[test]
    fn only_the_event_writing_the_answer_contributes_text() {
        // Several events in this stream carry a field of the same name; only one
        // of them is the answer being written.
        assert_eq!(
            answers_event(&json!({"type": "response.output_text.delta", "delta": "He"}))
                .text
                .as_deref(),
            Some("He")
        );
        assert!(answers_event(
            &json!({"type": "response.function_call_arguments.delta", "delta": "{}"})
        )
        .text
        .is_none());

        let closing = answers_event(&json!({
            "type": "response.completed",
            "response": { "output_text": "Hello", "usage": { "output_tokens": 2 } },
        }));
        assert_eq!(closing.complete.as_deref(), Some("Hello"));
        assert_eq!(closing.usage.and_then(|usage| usage.output_tokens), Some(2));
    }

    #[test]
    fn a_streamed_chat_chunk_contributes_its_delta() {
        assert_eq!(
            chat_event(&json!({"choices": [{ "delta": { "content": "He" } }]}))
                .text
                .as_deref(),
            Some("He")
        );
        // The chunk that closes a stream carries totals and no text.
        let closing = chat_event(&json!({"choices": [], "usage": { "completion_tokens": 4 }}));
        assert!(closing.text.is_none());
        assert_eq!(closing.usage.and_then(|usage| usage.output_tokens), Some(4));
    }

    #[test]
    fn an_instruction_that_says_nothing_is_not_sent() {
        let call = channel("a-voice");
        assert_eq!(
            speech_body(
                &call,
                &generation(Capability::Audio, "read this", json!({}))
            ),
            json!({ "model": "a-voice", "input": "read this" }),
            "no field is sent for an instruction nobody gave"
        );

        let blank = generation(
            Capability::Audio,
            "read this",
            json!({ "instructions": "   " }),
        );
        assert_eq!(
            speech_body(&call, &blank),
            json!({ "model": "a-voice", "input": "read this" })
        );

        let mut framed = generation(
            Capability::Audio,
            "read this",
            json!({ "voice": "alloy", "format": "wav", "speed": 1.25 }),
        );
        framed.system = Some("Speak slowly.".into());
        assert_eq!(
            speech_body(&call, &framed),
            json!({
                "model": "a-voice",
                "input": "read this",
                "voice": "alloy",
                "response_format": "wav",
                "speed": 1.25,
                "instructions": "Speak slowly.",
            })
        );
    }

    #[test]
    fn an_image_body_carries_the_settings_and_a_count() {
        let call = channel("gpt-image-2");
        assert_eq!(
            image_body(&call, &generation(Capability::Image, "a cat", json!({}))),
            json!({ "model": "gpt-image-2", "prompt": "a cat" })
        );
        assert_eq!(
            image_body(
                &call,
                &generation(
                    Capability::Image,
                    "a cat",
                    json!({ "size": "1024x1024", "quality": "high", "background": "transparent", "count": 2 })
                )
            ),
            json!({
                "model": "gpt-image-2",
                "prompt": "a cat",
                "size": "1024x1024",
                "quality": "high",
                "background": "transparent",
                "n": 2,
            })
        );
    }

    #[test]
    fn one_reference_travels_as_a_single_field_and_several_as_a_list() {
        let call = channel("gpt-image-2");
        let request = generation(
            Capability::Image,
            "make it snow",
            json!({ "size": "512x512" }),
        );
        let first = media("photo", InputRole::Reference);
        let (body, content_type) = edit_body(&call, &request, &[&first], None);

        let text = String::from_utf8(body).expect("every part here is text");
        assert!(text.contains("name=\"image\""), "{text}");
        assert!(!text.contains("name=\"image[]\""), "{text}");
        assert!(text.contains("name=\"size\""), "{text}");
        assert!(
            content_type.starts_with("multipart/form-data; boundary="),
            "{content_type}"
        );

        let second = media("second", InputRole::Reference);
        let mask = media("mask", InputRole::Mask);
        let (body, _) = edit_body(&call, &request, &[&first, &second], Some(&mask));
        let text = String::from_utf8(body).expect("every part here is text");
        assert_eq!(text.matches("name=\"image[]\"").count(), 2, "{text}");
        assert_eq!(text.matches("name=\"mask\"").count(), 1, "{text}");
        assert_eq!(text.matches("name=\"image\"").count(), 0, "{text}");
    }

    #[test]
    fn a_video_body_names_the_frames_a_shot_lands_on() {
        let call = channel("a-video-model");
        let request = generation(
            Capability::Video,
            "a slow pan",
            json!({ "seconds": 6, "ratio": "16:9", "generateAudio": false }),
        );
        assert_eq!(
            video_body(&call, &request, &[]),
            json!({
                "model": "a-video-model",
                "prompt": "a slow pan",
                "seconds": 6,
                "ratio": "16:9",
                "generate_audio": false,
            })
        );

        let opening = media("opening", InputRole::FirstFrame);
        let closing = media("closing", InputRole::LastFrame);
        let body = video_body(&call, &request, &[opening.clone(), closing.clone()]);
        assert_eq!(body["first_frame"], json!(opening.data_url()));
        assert_eq!(body["last_frame"], json!(closing.data_url()));

        // More frames than a shot can land on become references, in the order
        // the shared layout rules put them: opening first, closing last.
        let extra = media("extra", InputRole::Reference);
        let body = video_body(
            &call,
            &request,
            &[opening.clone(), closing.clone(), extra.clone()],
        );
        assert!(body.get("first_frame").is_none(), "{body}");
        assert_eq!(
            body["reference_images"],
            json!([opening.data_url(), extra.data_url(), closing.data_url(),])
        );
    }

    #[test]
    fn a_job_that_ended_badly_says_so_in_the_providers_words() {
        let explained = outcome(
            &json!({"status": "failed", "error": { "message": "the prompt was refused" }}),
            "failed",
        );
        assert_eq!(
            explained,
            TaskState::Failed {
                message: "the prompt was refused".into(),
                retryable: false,
            }
        );
        let quiet = outcome(&json!({"status": "failed"}), "failed");
        assert_eq!(
            quiet,
            TaskState::Failed {
                message: "the job ended as failed".into(),
                retryable: false,
            }
        );
    }
}
