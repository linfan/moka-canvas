//! The OpenAI-compatible protocol, which most gateways and aggregators also
//! speak.
//!
//! Four capabilities over four endpoint shapes, chosen by the protocol variant
//! a model configuration named: chat completions or the responses endpoint for
//! text, the images endpoint for pictures, the speech endpoint for audio, and
//! the videos job for shots. Every request goes to the complete address the
//! configuration carries; the only addresses derived from it are the sibling
//! an image edit travels to and the job handles a video is polled by. An image
//! with references travels as a multipart body rather than as JSON, and audio
//! arrives as the bytes themselves.

use std::time::Duration;

use base64::Engine;
use reqwest::header::CONTENT_TYPE;
use serde::Deserialize;
use serde_json::{json, Map, Value};

use super::{
    answer, exchange, image_item, media_item, open_stream, provider_error, read_stream, succeeded,
    usage_of, ModelCall, Opened, ProviderAdapter, Reply, StreamEvent, MAX_MODEL_LIST_BYTES,
    MODEL_LIST_TIMEOUT,
};
use crate::domain::{new_id, now_iso, Capability};
use crate::generate::debug::Kind;
use crate::generate::error::ProviderError;
use crate::generate::media::{video_images, video_layout, MediaInput, MultipartBody, VideoLayout};
use crate::generate::models::image_edit_url;
use crate::generate::{
    AsyncTask, Cancel, DeltaSink, GenerateRequest, GenerateResult, GeneratedItem, InputRole,
    TaskState, Usage,
};
use crate::metadata::Protocol;

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
    async fn generate(
        &self,
        call: &ModelCall,
        request: &GenerateRequest,
        inputs: &[MediaInput],
        cancel: &Cancel,
    ) -> Result<GenerateResult, ProviderError> {
        match request.capability {
            Capability::Text => text(call, request, inputs, &DeltaSink::default(), cancel).await,
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
        call: &ModelCall,
        request: &GenerateRequest,
        inputs: &[MediaInput],
        sink: &DeltaSink,
        cancel: &Cancel,
    ) -> Result<GenerateResult, ProviderError> {
        match request.capability {
            Capability::Text => text(call, request, inputs, sink, cancel).await,
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
        call: &ModelCall,
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
            Kind::TaskCreate,
            call,
            call.post().json(&video_body(call, request, inputs)),
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
            // change when a model configuration is edited.
            id: new_id(),
            reference,
            protocol: call.protocol.clone(),
            capability: Capability::Video,
            model: call.config_id.clone(),
            created_at: now_iso(),
        })
    }

    async fn poll_task(
        &self,
        call: &ModelCall,
        task: &AsyncTask,
        cancel: &Cancel,
    ) -> Result<TaskState, ProviderError> {
        cancel.check()?;
        let reply = exchange(
            Kind::TaskPoll,
            call,
            call.get(&format!("{}/{}", call.endpoint(), task.reference)),
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
pub(super) async fn list_models(call: &ModelCall) -> Result<Vec<String>, ProviderError> {
    let reply = exchange(
        Kind::Models,
        call,
        call.get(call.endpoint()),
        MODEL_LIST_TIMEOUT,
        MAX_MODEL_LIST_BYTES,
    )
    .await?;
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

/// One text endpoint shape: what to send it, and how to read it back.
///
/// A table rather than a branch, because the two shapes differ in all three
/// of those and a `match` at every use would repeat the pairing.
struct TextEndpoint {
    body: fn(&ModelCall, &GenerateRequest, &[MediaInput], bool) -> Value,
    event: fn(&Value) -> StreamEvent,
    result: fn(Value) -> GenerateResult,
}

const ANSWERS: TextEndpoint = TextEndpoint {
    body: answers_body,
    event: answers_event,
    result: answers_result,
};

const CHAT: TextEndpoint = TextEndpoint {
    body: chat_body,
    event: chat_event,
    result: chat_result,
};

/// The endpoint shape the configured protocol named.
fn text_endpoint(protocol: Protocol) -> &'static TextEndpoint {
    match protocol {
        Protocol::OpenaiResponses => &ANSWERS,
        _ => &CHAT,
    }
}

async fn text(
    call: &ModelCall,
    request: &GenerateRequest,
    inputs: &[MediaInput],
    sink: &DeltaSink,
    cancel: &Cancel,
) -> Result<GenerateResult, ProviderError> {
    let deadline = call.budgets.timeout_for(Capability::Text);
    // The address a configuration carries is the whole endpoint, so the
    // protocol variant is what says which body shape arrives there. There is
    // no second candidate to fall back to: a user who named an address named
    // the shape that answers at it.
    let endpoint = text_endpoint(call.protocol.clone());
    let body = (endpoint.body)(call, request, inputs, sink.is_streaming());
    cancel.check()?;

    if sink.is_streaming() {
        return match open_stream(Kind::Stream, call, call.post().json(&body)).await? {
            Opened::Streaming(response, recording) => {
                read_stream(
                    response,
                    recording.map(|recording| *recording),
                    sink,
                    cancel,
                    deadline,
                    endpoint.event,
                )
                .await
            }
            Opened::Refused(reply) => Err(provider_error(&reply, &call.api_key)),
        };
    }

    let reply = exchange(
        Kind::Generate,
        call,
        call.post().json(&body),
        deadline,
        call.budgets.max_response_bytes,
    )
    .await?;
    if succeeded(reply.status) {
        let payload = reply.value()?;
        return Ok((endpoint.result)(payload));
    }
    Err(provider_error(&reply, &call.api_key))
}

/// Only pictures: neither text endpoint here has a field for anything else, and
/// an audio reference left out is better than one sent as a picture no model can
/// hear.
fn pictures(inputs: &[MediaInput]) -> Vec<&MediaInput> {
    inputs.iter().filter(|input| input.is_image()).collect()
}

fn answers_body(
    call: &ModelCall,
    request: &GenerateRequest,
    inputs: &[MediaInput],
    streaming: bool,
) -> Value {
    let mut body = opening(call, "input", request);
    // A question with a picture beside it is a message of parts, which is what
    // this endpoint reads a picture as; the words alone stay a bare string, since
    // that is the shape every gateway behind it accepts.
    let seen = pictures(inputs);
    if !seen.is_empty() {
        let mut parts = vec![json!({ "type": "input_text", "text": request.prompt })];
        for picture in seen {
            parts.push(json!({ "type": "input_image", "image_url": picture.data_url() }));
        }
        body.insert(
            "input".into(),
            json!([{ "type": "message", "role": "user", "content": parts }]),
        );
    }
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
    if let Some(effort) = reasoning_effort(request) {
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

fn chat_body(
    call: &ModelCall,
    request: &GenerateRequest,
    inputs: &[MediaInput],
    streaming: bool,
) -> Value {
    let mut messages = Vec::new();
    if let Some(system) = request.instruction() {
        messages.push(json!({ "role": "system", "content": system }));
    }
    // A picture travels as a part beside the words, which is how this endpoint
    // reads one; with nothing to look at the words stay a bare string, the shape
    // a gateway that cannot see pictures still accepts.
    let seen = pictures(inputs);
    let asked = if seen.is_empty() {
        json!(request.prompt)
    } else {
        let mut parts = vec![json!({ "type": "text", "text": request.prompt })];
        for picture in seen {
            parts.push(json!({
                "type": "image_url",
                "image_url": { "url": picture.data_url() },
            }));
        }
        json!(parts)
    };
    messages.push(json!({ "role": "user", "content": asked }));

    let mut body = Map::from_iter([
        ("model".to_string(), json!(call.model)),
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
    if let Some(effort) = reasoning_effort(request) {
        body.insert("reasoning_effort".into(), json!(effort));
    }
    Value::Object(body)
}

/// "Auto" means the provider picks the effort itself, and some channels reject
/// it as an unknown value, so it never travels in the body.
fn reasoning_effort(request: &GenerateRequest) -> Option<&str> {
    request
        .text_param("reasoningEffort")
        .filter(|effort| !effort.eq_ignore_ascii_case("auto"))
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
fn opening(call: &ModelCall, key: &str, request: &GenerateRequest) -> Map<String, Value> {
    Map::from_iter([
        ("model".to_string(), json!(call.model)),
        (key.to_string(), json!(request.prompt)),
    ])
}

/// One image generation. References turn it into an edit, which is a different
/// endpoint and a different body shape: the settings travel as form fields
/// beside the bytes rather than as a JSON document.
async fn image(
    call: &ModelCall,
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
        call.post().json(&image_body(call, request))
    } else {
        let (body, content_type) = edit_body(call, request, &references, masks.first().copied());
        call.post_at(&image_edit_url(call.endpoint()))
            .header(CONTENT_TYPE, content_type)
            .body(body)
    };
    images(
        call,
        answer(Kind::Generate, call, placed, Capability::Image).await?,
    )
    .await
}

fn image_body(call: &ModelCall, request: &GenerateRequest) -> Value {
    let mut body = opening(call, "prompt", request);
    if let Some(size) = image_size(request) {
        body.insert("size".into(), json!(size));
    }
    for (key, value) in [
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

/// The size this endpoint is told for the shape a request asked for.
///
/// It takes three sizes, and a shape is not one of them, so the closest of the
/// three is sent: an ask refused for the word it used costs the same as an ask
/// answered. A size already in pixels is one it takes and is passed on, as is
/// `auto`, which is its own way of saying the provider may choose.
fn image_size(request: &GenerateRequest) -> Option<String> {
    let asked = request.text_param("size")?;
    Some(match proportion(asked) {
        None => asked.to_string(),
        Some(ratio) if ratio > 1.0 => "1536x1024".to_string(),
        Some(ratio) if ratio < 1.0 => "1024x1536".to_string(),
        Some(_) => "1024x1024".to_string(),
    })
}

/// The width over the height a size stated as `16:9` describes, or nothing when
/// it is stated some other way.
fn proportion(size: &str) -> Option<f64> {
    let (width, height) = size.trim().split_once(':')?;
    let width: f64 = width.trim().parse().ok()?;
    let height: f64 = height.trim().parse().ok()?;
    (width > 0.0 && height > 0.0).then_some(width / height)
}

fn edit_body(
    call: &ModelCall,
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
        .field("model", &call.model)
        .field("prompt", &request.prompt);
    if let Some(size) = image_size(request) {
        body = body.field("size", &size);
    }
    for (key, value) in [
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
async fn images(call: &ModelCall, reply: Reply) -> Result<GenerateResult, ProviderError> {
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
async fn download(call: &ModelCall, address: &str) -> Result<GeneratedItem, ProviderError> {
    let reply = exchange(
        Kind::Media,
        call,
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
    call: &ModelCall,
    request: &GenerateRequest,
    cancel: &Cancel,
) -> Result<GenerateResult, ProviderError> {
    cancel.check()?;
    let reply = answer(
        Kind::Generate,
        call,
        call.post().json(&speech_body(call, request)),
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

fn speech_body(call: &ModelCall, request: &GenerateRequest) -> Value {
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

fn video_body(call: &ModelCall, request: &GenerateRequest, inputs: &[MediaInput]) -> Value {
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
async fn collect(call: &ModelCall, task: &AsyncTask) -> Result<TaskState, ProviderError> {
    let reply = answer(
        Kind::Media,
        call,
        call.get(&format!("{}/{}/content", call.endpoint(), task.reference)),
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
    use crate::generate::models::ResolvedModel;

    /// A model configuration resolved to one call, pointed at an address
    /// nothing answers so that a body built for it cannot be sent by accident.
    fn channel(model_id: &str) -> ModelCall {
        let resolved = ResolvedModel {
            config_id: model_id.to_string(),
            model: model_id.to_string(),
            display_name: format!("Model {model_id}"),
            category: Capability::Text,
            protocol: Protocol::OpenaiChat,
            url: "https://example.invalid/v1/chat/completions".into(),
        };
        ModelCall::new(&resolved, "a-key".into(), GenerateConfig::default())
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
    fn a_text_body_carries_only_the_settings_the_request_named() {
        let call = channel("gpt-5.5");
        let plain = generation(Capability::Text, "a lighthouse", json!({}));
        assert_eq!(
            answers_body(&call, &plain, &[], false),
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
            answers_body(&call, &tuned, &[], true),
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
            chat_body(&call, &tuned, &[], false),
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
    fn an_auto_effort_is_left_for_the_provider_to_choose() {
        let call = channel("gpt-5.5");
        let asked = generation(
            Capability::Text,
            "a lighthouse",
            json!({ "reasoningEffort": "auto" }),
        );
        // Channels that enumerate the efforts they know reject "auto" outright,
        // so it stays out of both bodies: naming no effort is what "auto" means.
        assert_eq!(
            answers_body(&call, &asked, &[], false).get("reasoning"),
            None
        );

        let older = channel("llama-3.3");
        assert_eq!(
            chat_body(&older, &asked, &[], false).get("reasoning_effort"),
            None
        );
    }

    #[test]
    fn a_question_about_a_picture_sends_it_beside_the_words() {
        let call = channel("llama-3.3");
        let asked = generation(Capability::Text, "what is in this picture", json!({}));
        // Each endpoint reads a picture in its own shape, and neither is sent
        // the words alone once there is something to look at: a body that dropped
        // the picture would be answered as though the question were about
        // nothing, which no model says it is doing.
        assert_eq!(
            chat_body(
                &call,
                &asked,
                &[media("photo", InputRole::Reference)],
                false
            )
            .pointer("/messages/0/content"),
            Some(&json!([
                { "type": "text", "text": "what is in this picture" },
                {
                    "type": "image_url",
                    "image_url": { "url": "data:image/png;base64,cG5n" },
                },
            ]))
        );

        let newer = channel("gpt-5.5");
        assert_eq!(
            answers_body(
                &newer,
                &asked,
                &[media("photo", InputRole::Reference)],
                false
            )
            .get("input"),
            Some(&json!([{
                "type": "message",
                "role": "user",
                "content": [
                    { "type": "input_text", "text": "what is in this picture" },
                    { "type": "input_image", "image_url": "data:image/png;base64,cG5n" },
                ],
            }]))
        );
    }

    #[test]
    fn only_a_picture_is_sent_to_a_text_endpoint() {
        let call = channel("llama-3.3");
        let asked = generation(Capability::Text, "describe the shot", json!({}));
        let tone = MediaInput {
            mime: "audio/wav".into(),
            ..media("voice", InputRole::ControlAudio)
        };
        // Left out rather than sent as something it is not: this protocol's text
        // endpoints have no field for anything but a picture.
        assert_eq!(
            chat_body(&call, &asked, &[tone], false).pointer("/messages/0/content"),
            Some(&json!("describe the shot"))
        );
        // And a picture beside it still travels, with nothing else in the way.
        assert_eq!(
            pictures(&[
                media("photo", InputRole::Reference),
                media("plate", InputRole::Mask)
            ])
            .iter()
            .map(|input| input.asset_id.as_str())
            .collect::<Vec<&str>>(),
            ["photo", "plate"]
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
    fn a_shape_is_sent_as_the_closest_size_this_endpoint_takes() {
        let call = channel("gpt-image-2");
        for (asked, sent) in [
            ("16:9", "1536x1024"),
            ("21:9", "1536x1024"),
            ("9:16", "1024x1536"),
            ("3:4", "1024x1536"),
            ("1:1", "1024x1024"),
            // A size it takes is passed on, as is its own way of leaving the
            // choice to the provider.
            ("1024x1536", "1024x1536"),
            ("auto", "auto"),
        ] {
            let body = image_body(
                &call,
                &generation(Capability::Image, "a cat", json!({ "size": asked })),
            );
            assert_eq!(body["size"].as_str(), Some(sent), "asked for {asked}");
        }

        // Nothing asked for is nothing sent, and the endpoint chooses.
        let plain = image_body(&call, &generation(Capability::Image, "a cat", json!({})));
        assert!(plain.get("size").is_none(), "{plain}");

        // The other endpoint takes the same three sizes, so it is told the same.
        let photo = media("photo", InputRole::Reference);
        let request = generation(Capability::Image, "make it snow", json!({ "size": "16:9" }));
        let (body, _) = edit_body(&call, &request, &[&photo], None);
        let text = String::from_utf8(body).expect("every part here is text");
        assert!(text.contains("1536x1024"), "{text}");
        assert!(!text.contains("16:9"), "{text}");
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
