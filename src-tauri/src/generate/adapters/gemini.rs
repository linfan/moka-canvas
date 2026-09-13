//! The Gemini protocol.
//!
//! Three of the four capabilities answer on one endpoint, because a request is
//! a document of parts and so is an answer: words, pictures and speech differ
//! only in what the answer is asked to contain. Video is a job, started here
//! and collected later from the addresses the finished job names.

use std::time::Duration;

use base64::Engine;
use serde_json::{json, Map, Value};

use super::{
    answer, exchange, image_item, media_item, open_stream, provider_error, read_stream, succeeded,
    usage_of, ModelCall, Opened, ProviderAdapter, StreamEvent,
};
use crate::domain::{new_id, now_iso, Capability};
use crate::generate::debug::Kind;
use crate::generate::error::ProviderError;
use crate::generate::media::{video_images, video_layout, MediaInput, VideoLayout};
use crate::generate::models::{gemini_root, gemini_stream_url};
use crate::generate::{
    AsyncTask, Cancel, DeltaSink, GenerateRequest, GenerateResult, GeneratedItem, TaskState, Usage,
};

/// How long a caller should wait before looking at a job again. The provider
/// does not say, and asking more often than this only adds refusals.
const POLL_INTERVAL: Duration = Duration::from_secs(5);

/// The mime an answer is read as when neither its bytes nor the provider named
/// one: speech arrives in a wave container here, and a finished shot as a video.
const FALLBACK_AUDIO_MIME: &str = "audio/wav";
const FALLBACK_VIDEO_MIME: &str = "video/mp4";

/// Where the totals are counted in an answer.
const TOKENS: &str = "usageMetadata";
const INPUT_TOKENS: &str = "promptTokenCount";
const OUTPUT_TOKENS: &str = "candidatesTokenCount";

pub(super) static ADAPTER: GeminiAdapter = GeminiAdapter;

pub struct GeminiAdapter;

#[async_trait::async_trait]
impl ProviderAdapter for GeminiAdapter {
    async fn generate(
        &self,
        call: &ModelCall,
        request: &GenerateRequest,
        inputs: &[MediaInput],
        cancel: &Cancel,
    ) -> Result<GenerateResult, ProviderError> {
        match request.capability {
            // Starting a job answers at once, but waiting it out inside one
            // request would hold a connection open for minutes: the gateway
            // routes video through `create_task` instead.
            Capability::Video => Err(ProviderError::invalid(
                "video generation runs as a task rather than in one call",
            )),
            _ => content(call, request, inputs, &DeltaSink::default(), cancel).await,
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
            Capability::Text => content(call, request, inputs, sink, cancel).await,
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
            call.post().json(&job_body(request, inputs)),
            Capability::Video,
        )
        .await?;
        let payload = reply.value()?;
        // Without a handle the job cannot be collected, which makes a 200 that
        // lacks one a failure rather than an answer.
        let reference = payload
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .ok_or_else(|| {
                ProviderError::NoOutput("the job started without a handle to poll".to_string())
            })?
            .to_string();
        Ok(AsyncTask {
            // Ours, not the provider's: the handle a client polls with must not
            // change when a channel is reconfigured.
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
        // The handle a job started with is a path under the root of the
        // configured address, so it is asked for exactly as it arrived,
        // resolved against that root.
        let root = gemini_root(call.endpoint())
            .or_else(|| call.origin())
            .unwrap_or_default();
        let reply = exchange(
            Kind::TaskPoll,
            call,
            call.get(&format!("{root}/{}", task.reference)),
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
        if !payload
            .get("done")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            return Ok(TaskState::pending(POLL_INTERVAL));
        }
        // A job that finished badly explains itself in the same document that
        // says it finished.
        if let Some(message) = payload
            .pointer("/error/message")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|message| !message.is_empty())
        {
            // The job ran and the provider refused it: the same request would
            // be refused again, so this is not something waiting fixes.
            return Ok(TaskState::Failed {
                message: message.to_string(),
                retryable: false,
            });
        }
        collect(call, &payload).await
    }
}

/// One generation, waited out or read as it arrives.
async fn content(
    call: &ModelCall,
    request: &GenerateRequest,
    inputs: &[MediaInput],
    sink: &DeltaSink,
    cancel: &Cancel,
) -> Result<GenerateResult, ProviderError> {
    cancel.check()?;
    let body = content_body(request, inputs);
    if sink.is_streaming() {
        let asked = call
            .post_at(&gemini_stream_url(call.endpoint()))
            // A stream is asked for in the query rather than in the body, and
            // as events rather than as one array of pieces.
            .query(&[("alt", "sse")])
            .json(&body);
        return match open_stream(Kind::Stream, call, asked).await? {
            Opened::Streaming(response, recording) => {
                read_stream(
                    response,
                    recording.map(|recording| *recording),
                    sink,
                    cancel,
                    call.budgets.timeout_for(request.capability),
                    event,
                )
                .await
            }
            Opened::Refused(reply) => Err(provider_error(&reply, &call.api_key)),
        };
    }
    let reply = answer(
        Kind::Generate,
        call,
        call.post().json(&body),
        request.capability,
    )
    .await?;
    read_content(reply.value()?, request.capability)
}

fn content_body(request: &GenerateRequest, inputs: &[MediaInput]) -> Value {
    let mut parts = Vec::new();
    if !request.prompt.trim().is_empty() {
        parts.push(json!({ "text": request.prompt }));
    }
    // Every reference travels inside the request: this protocol has no upload
    // to point at, and no field of its own for a mask, so one travels as a
    // picture beside the prompt like any other.
    for input in inputs {
        parts.push(json!({ "inlineData": inline_data(input) }));
    }

    let mut body = Map::from_iter([(
        "contents".to_string(),
        json!([{ "role": "user", "parts": parts }]),
    )]);
    if let Some(instruction) = request.instruction() {
        body.insert(
            "systemInstruction".into(),
            json!({ "parts": [{ "text": instruction }] }),
        );
    }
    if let Some(config) = generation_config(request) {
        body.insert("generationConfig".into(), config);
    }
    Value::Object(body)
}

/// What to ask an answer for. Nothing at all when the prompt says everything,
/// since an empty field would claim otherwise.
fn generation_config(request: &GenerateRequest) -> Option<Value> {
    let mut config = Map::new();
    match request.capability {
        // A model that can answer in pictures or in speech has to be asked for
        // them: words alone are the default, and a picture nobody asked for is
        // a picture that never arrives.
        Capability::Image => {
            config.insert("responseModalities".into(), json!(["TEXT", "IMAGE"]));
        }
        Capability::Audio => {
            config.insert("responseModalities".into(), json!(["AUDIO"]));
        }
        Capability::Text | Capability::Video => {}
    }
    if let Some(temperature) = request.float_param("temperature") {
        config.insert("temperature".into(), json!(temperature));
    }
    if let Some(tokens) = request.int_param("maxTokens") {
        config.insert("maxOutputTokens".into(), json!(tokens));
    }
    if let Some(count) = request.int_param("count").filter(|count| *count > 1) {
        config.insert("candidateCount".into(), json!(count));
    }
    // The size somebody picked describes a shape, which is what this protocol
    // can be told about, so it travels as one rather than being dropped.
    if let Some(ratio) = request.text_param("size").and_then(aspect_ratio) {
        config.insert("imageConfig".into(), json!({ "aspectRatio": ratio }));
    }
    if let Some(voice) = request.text_param("voice") {
        config.insert(
            "speechConfig".into(),
            json!({ "voiceConfig": { "prebuiltVoiceConfig": { "voiceName": voice } } }),
        );
    }
    (!config.is_empty()).then(|| Value::Object(config))
}

/// The shape a size describes, as this protocol states one.
///
/// A size in pixels is reduced so that a provider comparing it against the
/// handful of shapes it offers can recognise it. A shape already stated as one
/// is the answer: reducing it again would turn a shape a provider lists into one
/// it does not.
fn aspect_ratio(size: &str) -> Option<String> {
    let lowered = size.trim().to_lowercase();
    if let Some((width, height)) = lowered.split_once(':') {
        let (width, height) = sides(width, height)?;
        return Some(format!("{width}:{height}"));
    }
    let (width, height) = lowered.split_once('x')?;
    let (width, height) = sides(width, height)?;
    let shared = divisor(width, height);
    Some(format!("{}:{}", width / shared, height / shared))
}

/// Two whole numbers out of the two sides of a size, in whatever spacing it
/// arrived. A side of nothing or of zero describes no shape at all.
fn sides(width: &str, height: &str) -> Option<(u32, u32)> {
    let width: u32 = width.trim().parse().ok()?;
    let height: u32 = height.trim().parse().ok()?;
    (width > 0 && height > 0).then_some((width, height))
}

fn divisor(width: u32, height: u32) -> u32 {
    if height == 0 {
        width
    } else {
        divisor(height, width % height)
    }
}

/// A reference carried in the request itself.
fn inline_data(media: &MediaInput) -> Value {
    json!({ "mimeType": media.mime, "data": encoded(&media.bytes) })
}

/// The same bytes where a job names the frames it should land on, which is a
/// field of its own rather than a part of a prompt.
fn inline_frame(media: &MediaInput) -> Value {
    json!({ "mimeType": media.mime, "bytesBase64Encoded": encoded(&media.bytes) })
}

fn encoded(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Reads an answer: words and media out of the parts of every candidate, in the
/// order the provider gave them.
fn read_content(payload: Value, capability: Capability) -> Result<GenerateResult, ProviderError> {
    // A refusal can arrive as a success: a prompt this provider would not
    // answer is explained in a field of its own rather than in a status.
    if let Some(reason) = payload
        .pointer("/promptFeedback/blockReason")
        .and_then(Value::as_str)
    {
        return Err(ProviderError::Rejected(format!(
            "the prompt was refused: {reason}"
        )));
    }
    let mut text = String::new();
    let mut items = Vec::new();
    for candidate in candidates(&payload) {
        for part in parts_of(candidate) {
            if let Some(inline) = part.get("inlineData") {
                items.push(inline_item(inline, capability)?);
            } else if let Some(chunk) = part.get("text").and_then(Value::as_str) {
                text.push_str(chunk);
            }
        }
    }
    Ok(GenerateResult {
        text: (!text.trim().is_empty()).then_some(text),
        items,
        usage: tokens(&payload),
    })
}

/// One event in a stream, which is a whole answer document carrying the piece
/// written since the last one.
fn event(payload: &Value) -> StreamEvent {
    let mut text = String::new();
    for candidate in candidates(payload) {
        for part in parts_of(candidate) {
            if let Some(chunk) = part.get("text").and_then(Value::as_str) {
                text.push_str(chunk);
            }
        }
    }
    StreamEvent {
        text: (!text.is_empty()).then_some(text),
        complete: None,
        usage: tokens(payload),
    }
}

fn candidates(payload: &Value) -> &[Value] {
    payload
        .get("candidates")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
}

fn parts_of(candidate: &Value) -> &[Value] {
    candidate
        .pointer("/content/parts")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
}

fn tokens(payload: &Value) -> Option<Usage> {
    usage_of(payload.get(TOKENS), INPUT_TOKENS, OUTPUT_TOKENS)
}

/// One piece of media carried in an answer rather than left at an address.
fn inline_item(inline: &Value, capability: Capability) -> Result<GeneratedItem, ProviderError> {
    let bytes = decoded(
        inline
            .get("data")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    )?;
    let claimed = inline.get("mimeType").and_then(Value::as_str);
    match capability {
        Capability::Image => image_item(bytes),
        other => media_item(bytes, claimed, other, fallback_for(other)),
    }
}

/// The mime to read an answer as when nothing named one. Only media can need
/// it: an image is read from its own bytes.
fn fallback_for(capability: Capability) -> &'static str {
    match capability {
        Capability::Audio => FALLBACK_AUDIO_MIME,
        _ => FALLBACK_VIDEO_MIME,
    }
}

fn decoded(inline: &str) -> Result<Vec<u8>, ProviderError> {
    base64::engine::general_purpose::STANDARD
        .decode(inline.trim())
        .map_err(|error| {
            ProviderError::Rejected(format!("the media in the answer is not base64: {error}"))
        })
}

fn job_body(request: &GenerateRequest, inputs: &[MediaInput]) -> Value {
    let frames = video_images(inputs);
    let mut shot = Map::from_iter([("prompt".to_string(), json!(request.prompt))]);
    match video_layout(inputs, request) {
        VideoLayout::Prompt => {}
        // A shot that lands on a frame somebody chose names it, rather than
        // leaving the provider to guess which end of a list is which.
        VideoLayout::OpeningFrame | VideoLayout::OpeningAndClosingFrames => {
            if let Some(frame) = frames.first() {
                shot.insert("image".into(), inline_frame(frame));
            }
            if let Some(frame) = frames.get(1) {
                shot.insert("lastFrame".into(), inline_frame(frame));
            }
        }
        VideoLayout::Reference => {
            let references: Vec<Value> = frames
                .iter()
                .map(|frame| json!({ "referenceType": "ASSET", "image": inline_frame(frame) }))
                .collect();
            shot.insert("referenceImages".into(), json!(references));
        }
    }

    let mut parameters = Map::new();
    for (key, parameter) in [("aspectRatio", "ratio"), ("resolution", "resolution")] {
        if let Some(value) = request.text_param(parameter) {
            parameters.insert(key.into(), json!(value));
        }
    }
    if let Some(seconds) = request.int_param("seconds") {
        parameters.insert("durationSeconds".into(), json!(seconds));
    }
    if let Some(audio) = request.bool_param("generateAudio") {
        parameters.insert("generateAudio".into(), json!(audio));
    }
    // A watermark has no counterpart here, and inventing one would ask a
    // provider for something it never offered.
    json!({
        "instances": [Value::Object(shot)],
        "parameters": Value::Object(parameters),
    })
}

/// Downloads what a finished job left behind, from the addresses it named.
async fn collect(call: &ModelCall, payload: &Value) -> Result<TaskState, ProviderError> {
    let mut items = Vec::new();
    for address in samples(payload) {
        items.push(download(call, address).await?);
    }
    Ok(TaskState::Succeeded(GenerateResult {
        text: None,
        items,
        usage: None,
    }))
}

fn samples(payload: &Value) -> Vec<&str> {
    payload
        .pointer("/response/generateVideoResponse/generatedSamples")
        .and_then(Value::as_array)
        .map(|samples| {
            samples
                .iter()
                .filter_map(|sample| sample.pointer("/video/uri").and_then(Value::as_str))
                .collect()
        })
        .unwrap_or_default()
}

async fn download(call: &ModelCall, address: &str) -> Result<GeneratedItem, ProviderError> {
    let reply = exchange(
        Kind::Media,
        call,
        call.fetch(address),
        call.budgets.timeout_for(Capability::Video),
        call.budgets.max_response_bytes,
    )
    .await?;
    if !succeeded(reply.status) {
        return Err(provider_error(&reply, &call.api_key));
    }
    let mime = reply.content_type();
    media_item(
        reply.body,
        mime.as_deref(),
        Capability::Video,
        FALLBACK_VIDEO_MIME,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::GenerateConfig;
    use crate::generate::models::ResolvedModel;
    use crate::generate::InputRole;
    use crate::metadata::Protocol;

    /// A model configuration resolved to one call, pointed at an address
    /// nothing answers so that a body built for it cannot be sent by accident.
    fn channel(model_id: &str, capability: Capability) -> ModelCall {
        let (protocol, action) = match capability {
            Capability::Video => (Protocol::GeminiVideo, ":predictLongRunning"),
            _ => (Protocol::Gemini, ":generateContent"),
        };
        let resolved = ResolvedModel {
            config_id: model_id.to_string(),
            model: model_id.to_string(),
            display_name: format!("Model {model_id}"),
            category: capability,
            protocol,
            url: format!("https://example.invalid/v1beta/models/{model_id}{action}"),
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

    fn media(name: &str, mime: &str, role: InputRole) -> MediaInput {
        MediaInput {
            role,
            asset_id: name.into(),
            name: format!("{name}.png"),
            bytes: b"png".to_vec(),
            mime: mime.into(),
        }
    }

    /// A real encoded image, so a test can assert on what the bytes are rather
    /// than on a mime somebody claimed.
    fn png(width: u32, height: u32) -> Vec<u8> {
        let picture = image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            width,
            height,
            image::Rgba([12, 34, 56, 255]),
        ));
        let mut encoded = Vec::new();
        picture
            .write_to(
                &mut std::io::Cursor::new(&mut encoded),
                image::ImageFormat::Png,
            )
            .expect("a png encodes");
        encoded
    }

    /// The shortest bytes that are a wave file as far as the sniffer is
    /// concerned: its own header, and nothing to play.
    fn wave_header() -> Vec<u8> {
        b"RIFF\x24\x00\x00\x00WAVEfmt ".to_vec()
    }

    #[test]
    fn the_model_is_named_in_the_address_rather_than_in_a_body() {
        let call = channel("gemini-2.5-flash", Capability::Text);
        assert_eq!(
            call.endpoint(),
            "https://example.invalid/v1beta/models/gemini-2.5-flash:generateContent"
        );

        let shots = channel("veo-3", Capability::Video);
        assert_eq!(
            shots.endpoint(),
            "https://example.invalid/v1beta/models/veo-3:predictLongRunning"
        );

        let body = content_body(&generation(Capability::Text, "a lantern", json!({})), &[]);
        assert!(
            !body.to_string().contains("gemini-2.5-flash"),
            "the model travels once, in the address: {body}"
        );
    }

    #[test]
    fn an_answer_is_asked_for_in_the_modality_the_request_wants() {
        let text = content_body(&generation(Capability::Text, "a lantern", json!({})), &[]);
        assert!(
            text.get("generationConfig").is_none(),
            "words are the default, so nothing has to be asked for: {text}"
        );

        let image = generation(
            Capability::Image,
            "a lantern",
            json!({ "size": "1024x1536" }),
        );
        let config = content_body(&image, &[])["generationConfig"].clone();
        assert_eq!(config["responseModalities"], json!(["TEXT", "IMAGE"]));
        // The size picked describes a shape, and a shape is what this protocol
        // can be told about.
        assert_eq!(config["imageConfig"]["aspectRatio"], "2:3");

        let audio = generation(
            Capability::Audio,
            "read this",
            json!({ "voice": "a-voice" }),
        );
        let config = content_body(&audio, &[])["generationConfig"].clone();
        assert_eq!(config["responseModalities"], json!(["AUDIO"]));
        assert_eq!(
            config["speechConfig"]["voiceConfig"]["prebuiltVoiceConfig"]["voiceName"],
            "a-voice"
        );
    }

    #[test]
    fn a_size_is_reduced_to_the_shape_it_describes() {
        assert_eq!(aspect_ratio("1024x1536").as_deref(), Some("2:3"));
        assert_eq!(aspect_ratio("1024X1024").as_deref(), Some("1:1"));
        assert_eq!(aspect_ratio(" 512 x 768 ").as_deref(), Some("2:3"));
        // A size this protocol has no shape for is left out rather than sent as
        // something it would have to refuse.
        assert_eq!(aspect_ratio("auto"), None);
        assert_eq!(aspect_ratio("0x512"), None);
        assert_eq!(aspect_ratio("1024"), None);
    }

    #[test]
    fn a_shape_stated_as_one_is_not_reduced_again() {
        assert_eq!(aspect_ratio("21:9").as_deref(), Some("21:9"));
        assert_eq!(aspect_ratio(" 16:9 ").as_deref(), Some("16:9"));
        assert_eq!(aspect_ratio("1:1").as_deref(), Some("1:1"));
        assert_eq!(aspect_ratio("0:512"), None);
        assert_eq!(aspect_ratio("16:"), None);
    }

    #[test]
    fn only_several_results_are_asked_for() {
        let one = content_body(
            &generation(Capability::Image, "a lantern", json!({ "count": 1 })),
            &[],
        );
        assert!(
            one["generationConfig"].get("candidateCount").is_none(),
            "{one}"
        );

        let several = content_body(
            &generation(Capability::Image, "a lantern", json!({ "count": 3 })),
            &[],
        );
        assert_eq!(several["generationConfig"]["candidateCount"], 3);
    }

    #[test]
    fn a_prompt_and_its_references_travel_as_parts_of_one_message() {
        let request = GenerateRequest {
            system: Some("Answer in one sentence.".into()),
            ..generation(Capability::Image, "make it snow", json!({}))
        };
        let inputs = [
            media("photo", "image/png", InputRole::Reference),
            // This protocol has no field for a mask, so it travels as a picture
            // beside the others rather than being dropped.
            media("mask", "image/png", InputRole::Mask),
        ];
        let body = content_body(&request, &inputs);

        assert_eq!(body["contents"][0]["role"], "user");
        let parts = body["contents"][0]["parts"].as_array().expect("parts");
        assert_eq!(parts.len(), 3, "the prompt and its two references");
        assert_eq!(parts[0]["text"], "make it snow");
        assert_eq!(parts[1]["inlineData"]["mimeType"], "image/png");
        assert_eq!(parts[1]["inlineData"]["data"], encoded(b"png"));
        assert_eq!(
            body["systemInstruction"]["parts"][0]["text"],
            "Answer in one sentence."
        );
    }

    #[test]
    fn an_answer_that_says_nothing_is_not_sent_as_an_instruction() {
        let request = GenerateRequest {
            system: Some("   ".into()),
            ..generation(Capability::Text, "a lantern", json!({}))
        };
        let body = content_body(&request, &[]);
        assert!(
            body.get("systemInstruction").is_none(),
            "no field is sent for an instruction nobody gave: {body}"
        );
    }

    #[test]
    fn words_and_media_are_read_out_of_the_parts() {
        let payload = json!({
            "candidates": [{
                "content": { "parts": [
                    { "text": "A lantern, " },
                    { "text": "lit." },
                    { "inlineData": { "mimeType": "image/png", "data": encoded(&png(3, 2)) } }
                ] },
                "finishReason": "STOP"
            }],
            "usageMetadata": { "promptTokenCount": 4, "candidatesTokenCount": 2 }
        });
        let result = read_content(payload, Capability::Image).expect("the answer is read");

        assert_eq!(result.text.as_deref(), Some("A lantern, lit."));
        assert_eq!(result.items.len(), 1);
        // Read from the bytes rather than believed from the answer.
        assert_eq!(result.items[0].mime, "image/png");
        assert_eq!(result.items[0].kind, Capability::Image);
        assert_eq!(
            (result.items[0].width, result.items[0].height),
            (Some(3), Some(2))
        );
        assert_eq!(
            result.usage,
            Some(Usage {
                input_tokens: Some(4),
                output_tokens: Some(2),
                ..Usage::default()
            })
        );
    }

    #[test]
    fn speech_is_read_as_the_container_it_is_rather_than_as_the_name_it_came_with() {
        let payload = json!({
            "candidates": [{ "content": { "parts": [
                { "inlineData": { "mimeType": "audio/L16;codec=pcm", "data": encoded(&wave_header()) } }
            ] } }]
        });
        let result = read_content(payload, Capability::Audio).expect("the answer is read");
        // The name a provider gives a container is not always one a file can be
        // stored under, so the bytes decide.
        assert_eq!(result.items[0].mime, "audio/x-wav");
        assert_eq!(result.items[0].kind, Capability::Audio);
    }

    #[test]
    fn media_that_is_not_base64_is_refused_rather_than_stored_empty() {
        let payload = json!({
            "candidates": [{ "content": { "parts": [
                { "inlineData": { "mimeType": "image/png", "data": "not base64 at all" } }
            ] } }]
        });
        let error = read_content(payload, Capability::Image).expect_err("the bytes are not media");
        assert_eq!(error.code(), "PROVIDER_BAD_REQUEST");
        assert!(!error.retryable(), "{error} will not improve on a retry");
    }

    #[test]
    fn a_prompt_the_provider_blocked_is_explained_rather_than_reported_as_empty() {
        let payload = json!({
            "promptFeedback": { "blockReason": "SAFETY" },
            "candidates": []
        });
        let error = read_content(payload, Capability::Text).expect_err("nothing was answered");
        assert_eq!(error.code(), "PROVIDER_BAD_REQUEST");
        assert!(error.to_string().contains("SAFETY"), "{error}");
    }

    #[test]
    fn an_answer_with_no_totals_reports_no_usage() {
        // An all-empty struct would still show up in the interface as a row of
        // zeroes.
        let payload = json!({ "candidates": [], "usageMetadata": {} });
        assert_eq!(
            read_content(payload, Capability::Text).expect("read").usage,
            None
        );
    }

    #[test]
    fn an_event_in_a_stream_carries_the_piece_written_since_the_last_one() {
        let written = json!({
            "candidates": [{ "content": { "parts": [{ "text": "A " }, { "text": "lantern." }] } }]
        });
        let piece = event(&written);
        assert_eq!(piece.text.as_deref(), Some("A lantern."));
        assert_eq!(piece.complete, None, "nothing here closes the answer");
        assert_eq!(piece.usage, None);

        // The totals arrive with the last event, which carries no words of its
        // own.
        let closing = json!({ "usageMetadata": { "candidatesTokenCount": 2 } });
        let last = event(&closing);
        assert_eq!(last.text, None, "an empty piece is not a piece");
        assert_eq!(last.usage.and_then(|usage| usage.output_tokens), Some(2));
    }

    #[test]
    fn a_job_names_the_frames_it_was_given() {
        let frames = [
            media("opening", "image/png", InputRole::FirstFrame),
            media("closing", "image/png", InputRole::LastFrame),
        ];
        let body = job_body(
            &generation(
                Capability::Video,
                "a slow pan",
                json!({ "seconds": 6, "ratio": "16:9", "resolution": "720p", "generateAudio": true }),
            ),
            &frames,
        );

        let shot = &body["instances"][0];
        assert_eq!(shot["prompt"], "a slow pan");
        assert_eq!(shot["image"]["mimeType"], "image/png");
        assert_eq!(shot["image"]["bytesBase64Encoded"], encoded(b"png"));
        assert!(shot.get("lastFrame").is_some(), "{shot}");
        let parameters = &body["parameters"];
        assert_eq!(parameters["aspectRatio"], "16:9");
        assert_eq!(parameters["durationSeconds"], 6);
        assert_eq!(parameters["resolution"], "720p");
        assert_eq!(parameters["generateAudio"], true);
    }

    #[test]
    fn one_image_is_an_opening_frame_and_several_are_references() {
        let opening = [media("opening", "image/png", InputRole::FirstFrame)];
        let shot = &job_body(
            &generation(Capability::Video, "a slow pan", json!({})),
            &opening,
        )["instances"][0];
        assert!(shot.get("image").is_some(), "{shot}");
        assert!(
            shot.get("lastFrame").is_none(),
            "a single image is one end of the shot, not both: {shot}"
        );

        let several = [
            media("one", "image/png", InputRole::Reference),
            media("two", "image/png", InputRole::Reference),
            media("three", "image/png", InputRole::Reference),
        ];
        let shot = &job_body(
            &generation(Capability::Video, "a slow pan", json!({})),
            &several,
        )["instances"][0];
        assert_eq!(
            shot["referenceImages"].as_array().map(Vec::len),
            Some(3),
            "{shot}"
        );
        assert_eq!(shot["referenceImages"][0]["referenceType"], "ASSET");
        assert!(shot.get("image").is_none(), "{shot}");
    }

    #[test]
    fn a_prompt_alone_describes_the_shot() {
        let body = job_body(&generation(Capability::Video, "a slow pan", json!({})), &[]);
        let shot = &body["instances"][0];
        assert_eq!(shot["prompt"], "a slow pan");
        assert!(shot.get("image").is_none(), "{shot}");
        assert!(body["parameters"].as_object().is_some_and(Map::is_empty));
    }

    #[test]
    fn a_finished_job_names_the_addresses_to_collect_from() {
        let payload = json!({
            "done": true,
            "response": { "generateVideoResponse": { "generatedSamples": [
                { "video": { "uri": "https://example.invalid/files/one:download" } },
                { "video": {} },
                { "video": { "uri": "https://example.invalid/files/two:download" } }
            ] } }
        });
        assert_eq!(
            samples(&payload),
            [
                "https://example.invalid/files/one:download",
                "https://example.invalid/files/two:download"
            ],
            "a sample with nothing to collect is passed over"
        );
        assert!(samples(&json!({ "done": true })).is_empty());
    }
}
