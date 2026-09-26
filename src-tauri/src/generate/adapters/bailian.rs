//! The Alibaba Cloud Bailian protocol, which Model Studio also speaks through
//! the DashScope shape.
//!
//! Two capabilities over one family of services. Words are asked for at the
//! text-generation endpoint and answered in one document or in a stream, and a
//! question carrying a picture moves to the multimodal sibling beside it,
//! which is the same service reading a message as parts. Pictures are asked
//! for at that same multimodal service and answered by the one call, which
//! names each drawing rather than carrying it; the drawing is fetched from the
//! address it was left at.

use base64::Engine;
use reqwest::header::HeaderName;
use serde_json::{json, Map, Value};

use super::{
    answer, exchange, image_item, open_stream, provider_error, read_stream, succeeded, usage_of,
    ModelCall, Opened, ProviderAdapter, StreamEvent,
};
use crate::domain::Capability;
use crate::generate::debug::Kind;
use crate::generate::error::ProviderError;
use crate::generate::media::MediaInput;
use crate::generate::models::{bailian_multimodal_url, is_bailian_multimodal};
use crate::generate::{Cancel, DeltaSink, GenerateRequest, GenerateResult, GeneratedItem, Usage};

/// The header that asks this service for an answer in pieces. Streaming is
/// asked for in a header here rather than in the body, which is what the raw
/// HTTP shape of the service reads.
const SSE_HEADER: HeaderName = HeaderName::from_static("x-dashscope-sse");

/// Where the totals are counted in an answer.
const INPUT_TOKENS: &str = "input_tokens";
const OUTPUT_TOKENS: &str = "output_tokens";

pub(super) static ADAPTER: BailianAdapter = BailianAdapter;

pub struct BailianAdapter;

#[async_trait::async_trait]
impl ProviderAdapter for BailianAdapter {
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
            // Speech, shots and recognition are other services of the same
            // platform, and each is served by a protocol of its own.
            other => Err(ProviderError::invalid(format!(
                "the Bailian protocol does not serve {} generation",
                other.as_str()
            ))),
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
}

/// One text generation, waited out or read as it arrives.
async fn text(
    call: &ModelCall,
    request: &GenerateRequest,
    inputs: &[MediaInput],
    sink: &DeltaSink,
    cancel: &Cancel,
) -> Result<GenerateResult, ProviderError> {
    let seen = pictures(inputs);
    let (url, parts) = address(call, &seen);
    let body = text_body(call, request, &seen, parts, sink.is_streaming());
    cancel.check()?;
    let deadline = call.budgets.timeout_for(Capability::Text);

    if sink.is_streaming() {
        let asked = call.post_at(&url).header(SSE_HEADER, "enable").json(&body);
        return match open_stream(Kind::Stream, call, asked).await? {
            Opened::Streaming(response, recording) => {
                read_stream(
                    response,
                    recording.map(|recording| *recording),
                    sink,
                    cancel,
                    deadline,
                    event,
                )
                .await
            }
            Opened::Refused(reply) => Err(provider_error(&reply, &call.api_key)),
        };
    }

    let reply = exchange(
        Kind::Generate,
        call,
        call.post_at(&url).json(&body),
        deadline,
        call.budgets.max_response_bytes,
    )
    .await?;
    if !succeeded(reply.status) {
        return Err(provider_error(&reply, &call.api_key));
    }
    read_answer(reply.value()?)
}

/// The address one question goes to, and whether that address reads a message
/// as parts rather than as one string.
///
/// The two services are one under two names: words alone are asked at the text
/// endpoint a configuration names, and a question carrying a picture is asked
/// at the multimodal sibling beside it. An address that already names the
/// multimodal service is left where it is, since a model that only answers
/// there is reachable without a second setting.
fn address(call: &ModelCall, pictures: &[&MediaInput]) -> (String, bool) {
    let configured = call.endpoint();
    if !pictures.is_empty() {
        return (bailian_multimodal_url(configured), true);
    }
    if is_bailian_multimodal(configured) {
        return (configured.to_string(), true);
    }
    (configured.to_string(), false)
}

/// The pictures a message can carry. Anything else is left out rather than
/// sent as something it is not: this shape has no field for a recording.
fn pictures(inputs: &[MediaInput]) -> Vec<&MediaInput> {
    inputs.iter().filter(|input| input.is_image()).collect()
}

fn text_body(
    call: &ModelCall,
    request: &GenerateRequest,
    pictures: &[&MediaInput],
    parts: bool,
    streaming: bool,
) -> Value {
    let mut messages = Vec::new();
    if let Some(instruction) = request.instruction() {
        messages.push(json!({ "role": "system", "content": said(instruction, parts) }));
    }
    messages.push(json!({ "role": "user", "content": asked(request, pictures, parts) }));
    Value::Object(Map::from_iter([
        ("model".to_string(), json!(call.model)),
        ("input".to_string(), json!({ "messages": messages })),
        (
            "parameters".to_string(),
            Value::Object(parameters(request, streaming)),
        ),
    ]))
}

/// One message's content as the chosen service reads it: a bare string where
/// it reads one, and a document of parts where it reads that.
fn said(text: &str, parts: bool) -> Value {
    if parts {
        json!([{ "text": text }])
    } else {
        json!(text)
    }
}

/// The question itself: the words alone where that is all it is, and beside
/// the pictures otherwise.
fn asked(request: &GenerateRequest, pictures: &[&MediaInput], parts: bool) -> Value {
    if !parts {
        return json!(request.prompt);
    }
    let mut content = Vec::new();
    if !request.prompt.trim().is_empty() {
        content.push(json!({ "text": request.prompt }));
    }
    for picture in pictures {
        content.push(json!({ "image": picture.data_url() }));
    }
    Value::Array(content)
}

/// What the service is told about the answer, under the names it uses.
fn parameters(request: &GenerateRequest, streaming: bool) -> Map<String, Value> {
    // A message is asked for rather than a bare string, which is also the
    // shape an answer with a picture's parts in it arrives under.
    let mut parameters = Map::from_iter([("result_format".to_string(), json!("message"))]);
    if streaming {
        // Without this, every piece a stream sends repeats the whole answer so
        // far, and a reader of pieces collects it over and over.
        parameters.insert("incremental_output".into(), json!(true));
    }
    if let Some(temperature) = request.float_param("temperature") {
        parameters.insert("temperature".into(), json!(temperature));
    }
    if let Some(tokens) = request.int_param("maxTokens") {
        parameters.insert("max_tokens".into(), json!(tokens));
    }
    parameters
}

/// The words of an answer.
///
/// A refusal can arrive as a success with the explanation in the body rather
/// than in a status, which reading as an empty answer would blame on the model
/// being quiet.
fn read_answer(payload: Value) -> Result<GenerateResult, ProviderError> {
    if let Some(message) = refusal(&payload) {
        return Err(ProviderError::Rejected(message));
    }
    Ok(GenerateResult {
        text: choice_content(&payload),
        items: Vec::new(),
        usage: tokens(&payload),
    })
}

/// One event in a stream, which carries the piece written since the last one
/// and, where the service reported them, the totals so far.
fn event(payload: &Value) -> StreamEvent {
    // A stream that has opened has no status left to refuse with, so a failure
    // arrives as an event carrying the complaint instead of a piece.
    if let Some(message) = refusal(payload) {
        return StreamEvent {
            failed: Some(message),
            ..StreamEvent::default()
        };
    }
    StreamEvent {
        text: choice_content(payload),
        complete: None,
        usage: tokens(payload),
        ..StreamEvent::default()
    }
}

/// The complaint in an answer that carried one instead of a generation: this
/// service names it in a `code` beside a `message`, where an answer would
/// carry an `output`.
fn refusal(payload: &Value) -> Option<String> {
    let code = payload.get("code").and_then(Value::as_str)?;
    if payload.get("output").is_some() {
        return None;
    }
    let said = payload
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    Some(if said.is_empty() {
        format!("the service refused the request: {code}")
    } else {
        format!("{code}: {said}")
    })
}

/// The text of the first choice, which this service spells either as one
/// string or as a document of parts.
fn choice_content(payload: &Value) -> Option<String> {
    let said = match payload.pointer("/output/choices/0/message/content") {
        Some(Value::String(text)) => Some(text.clone()),
        Some(Value::Array(parts)) => Some(
            parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<String>(),
        ),
        // `result_format: "text"` is the older default, where the answer is a
        // bare string rather than a message.
        _ => payload
            .pointer("/output/text")
            .and_then(Value::as_str)
            .map(str::to_string),
    };
    said.filter(|text| !text.trim().is_empty())
}

/// The token totals of an answer, under the names this service uses.
fn tokens(payload: &Value) -> Option<Usage> {
    usage_of(payload.get("usage"), INPUT_TOKENS, OUTPUT_TOKENS)
}

/// One picture, drawn or edited. This service answers in the one call rather
/// than with a job to poll, which is what the picture protocol here is for.
async fn image(
    call: &ModelCall,
    request: &GenerateRequest,
    inputs: &[MediaInput],
    cancel: &Cancel,
) -> Result<GenerateResult, ProviderError> {
    cancel.check()?;
    let reply = answer(
        Kind::Generate,
        call,
        call.post().json(&image_body(call, request, inputs)),
        Capability::Image,
    )
    .await?;
    drawings(call, reply.value()?).await
}

/// A picture asked for: the words alone are a drawing, and pictures beside
/// them are what makes it an edit. Both travel to the same address as parts of
/// one message, which is the shape this service reads either from.
fn image_body(call: &ModelCall, request: &GenerateRequest, inputs: &[MediaInput]) -> Value {
    let mut content: Vec<Value> = pictures(inputs)
        .iter()
        .map(|picture| json!({ "image": picture.data_url() }))
        .collect();
    content.push(json!({ "text": request.prompt }));
    Value::Object(Map::from_iter([
        ("model".to_string(), json!(call.model)),
        (
            "input".to_string(),
            json!({ "messages": [{ "role": "user", "content": content }] }),
        ),
        (
            "parameters".to_string(),
            Value::Object(image_parameters(request)),
        ),
    ]))
}

fn image_parameters(request: &GenerateRequest) -> Map<String, Value> {
    let mut parameters = Map::new();
    if let Some(size) = request.text_param("size").and_then(size_of) {
        parameters.insert("size".into(), json!(size));
    }
    if let Some(count) = request.int_param("count").filter(|count| *count > 0) {
        parameters.insert("n".into(), json!(count));
    }
    parameters
}

/// The size this service is told for the shape a request asked for.
///
/// It takes a tier — `1K`, `2K`, `4K` — and a pixel size written
/// width*height, and a shape stated as a proportion is reduced to the pixels
/// that describe it, which is the way a shape travels to a service that has no
/// name for proportions. A size nobody stated is no size at all, and the
/// service chooses.
fn size_of(asked: &str) -> Option<String> {
    let asked = asked.trim();
    if asked.is_empty() || asked.eq_ignore_ascii_case("auto") {
        return None;
    }
    let lowered = asked.to_lowercase();
    if matches!(lowered.as_str(), "1k" | "2k" | "4k") {
        return Some(lowered.to_uppercase());
    }
    if let Some((width, height)) = sides(&lowered, 'x').or_else(|| sides(&lowered, '*')) {
        return Some(format!("{width}*{height}"));
    }
    let (width, height) = sides(&lowered, ':')?;
    Some(about_a_megapixel(width, height))
}

/// Two whole numbers out of the two sides of a size, in whatever spacing it
/// arrived. A side of nothing or of zero describes no shape at all.
fn sides(size: &str, separator: char) -> Option<(u32, u32)> {
    let (width, height) = size.split_once(separator)?;
    let width: u32 = width.trim().parse().ok()?;
    let height: u32 = height.trim().parse().ok()?;
    (width > 0 && height > 0).then_some((width, height))
}

/// A shape reduced to pixels: about a megapixel in the same proportion, both
/// sides a multiple of sixteen, which is the arithmetic the service's own
/// examples are written in.
fn about_a_megapixel(width: u32, height: u32) -> String {
    let scale = (1024.0 * 1024.0 / (f64::from(width) * f64::from(height))).sqrt();
    let side = |value: u32| ((f64::from(value) * scale / 16.0).round() * 16.0).max(16.0) as u32;
    format!("{}*{}", side(width), side(height))
}

/// The drawings in an answer, each one fetched from the address it was left at
/// and stored as it arrived.
async fn drawings(call: &ModelCall, payload: Value) -> Result<GenerateResult, ProviderError> {
    if let Some(message) = refusal(&payload) {
        return Err(ProviderError::Rejected(message));
    }
    let mut items = Vec::new();
    let parts = payload
        .pointer("/output/choices/0/message/content")
        .and_then(Value::as_array);
    for part in parts.into_iter().flatten() {
        let Some(address) = part.get("image").and_then(Value::as_str) else {
            continue;
        };
        items.push(drawing(call, address).await?);
    }
    let drawn = u32::try_from(items.len()).unwrap_or(u32::MAX);
    Ok(GenerateResult {
        text: None,
        items,
        usage: drawn_usage(&payload, drawn),
    })
}

/// The totals of a drawing answer: how many arrived, and the tokens the
/// service counted beside them.
fn drawn_usage(payload: &Value, drawn: u32) -> Option<Usage> {
    let counted = usage_of(payload.get("usage"), INPUT_TOKENS, OUTPUT_TOKENS);
    (drawn > 0 || counted.is_some()).then(|| Usage {
        images: (drawn > 0).then_some(drawn),
        ..counted.unwrap_or_default()
    })
}

/// One drawing, fetched from the address the answer left it at.
///
/// The address is the service's own object store rather than the endpoint that
/// was asked, so the credential does not follow it: a link that names a file
/// is nobody's key's business.
async fn drawing(call: &ModelCall, address: &str) -> Result<GeneratedItem, ProviderError> {
    // A deployment that inlines the drawing sends it as a data URL rather than
    // leaving it anywhere to fetch.
    if let Some(inline) = address.strip_prefix("data:") {
        return inline_drawing(inline);
    }
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

/// A drawing carried in the answer itself, as `data:<mime>;base64,<bytes>`.
fn inline_drawing(inline: &str) -> Result<GeneratedItem, ProviderError> {
    let encoded = inline
        .split_once(";base64,")
        .map(|(_, data)| data)
        .unwrap_or_default();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .map_err(|error| {
            ProviderError::Rejected(format!("the drawing in the answer is not base64: {error}"))
        })?;
    image_item(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::GenerateConfig;
    use crate::generate::models::ResolvedModel;
    use crate::generate::InputRole;
    use crate::metadata::Protocol;
    use serde_json::json;

    const TEXT_URL: &str =
        "https://ws.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/text-generation/generation";
    const MULTIMODAL_URL: &str = "https://ws.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";

    /// A model configuration resolved to one call, pointed at an address
    /// nothing answers so that a body built for it cannot be sent by accident.
    fn channel(model_id: &str, protocol: Protocol, url: &str) -> ModelCall {
        let resolved = ResolvedModel {
            config_id: model_id.to_string(),
            model: model_id.to_string(),
            display_name: format!("Model {model_id}"),
            category: Capability::Text,
            protocol,
            url: url.into(),
        };
        ModelCall::new(&resolved, "a-key".into(), GenerateConfig::default())
            .expect("a client builds")
    }

    fn text_channel(model_id: &str) -> ModelCall {
        channel(model_id, Protocol::BailianText, TEXT_URL)
    }

    fn image_channel(model_id: &str) -> ModelCall {
        channel(model_id, Protocol::BailianImage, MULTIMODAL_URL)
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
    fn a_question_of_words_alone_is_asked_at_the_text_endpoint_as_a_string() {
        let call = text_channel("qwen3-max");
        let mut asked = generation(Capability::Text, "a lighthouse", json!({}));
        asked.system = Some("Answer in one sentence.".into());
        assert_eq!(
            text_body(&call, &asked, &[], false, false),
            json!({
                "model": "qwen3-max",
                "input": {
                    "messages": [
                        { "role": "system", "content": "Answer in one sentence." },
                        { "role": "user", "content": "a lighthouse" },
                    ],
                },
                "parameters": { "result_format": "message" },
            })
        );
        let (url, parts) = address(&call, &[]);
        assert_eq!(url, TEXT_URL);
        assert!(!parts);
    }

    #[test]
    fn a_question_with_a_picture_moves_to_the_multimodal_sibling_as_parts() {
        let call = text_channel("qwen3-vl-plus");
        let asked = generation(Capability::Text, "what is in this picture", json!({}));
        let photo = media("photo", InputRole::Reference);

        let (url, parts) = address(&call, &[&photo]);
        assert_eq!(url, MULTIMODAL_URL, "the sibling service is asked");
        assert!(parts);
        assert_eq!(
            text_body(&call, &asked, &[&photo], parts, false),
            json!({
                "model": "qwen3-vl-plus",
                "input": {
                    "messages": [{
                        "role": "user",
                        "content": [
                            { "text": "what is in this picture" },
                            { "image": "data:image/png;base64,cG5n" },
                        ],
                    }],
                },
                "parameters": { "result_format": "message" },
            })
        );
    }

    #[test]
    fn an_address_that_already_names_the_multimodal_service_is_kept() {
        // A model that only answers there is reachable without a second
        // setting, and its messages are still read as parts.
        let call = channel("qwen3-vl-plus", Protocol::BailianText, MULTIMODAL_URL);
        let asked = generation(Capability::Text, "who are you", json!({}));
        let (url, parts) = address(&call, &[]);
        assert_eq!(url, MULTIMODAL_URL);
        assert!(parts);
        assert_eq!(
            text_body(&call, &asked, &[], parts, false).pointer("/input/messages/0/content"),
            Some(&json!([{ "text": "who are you" }]))
        );
    }

    #[test]
    fn only_a_picture_travels_beside_a_question() {
        let call = text_channel("qwen3-vl-plus");
        let voice = MediaInput {
            mime: "audio/wav".into(),
            ..media("voice", InputRole::ControlAudio)
        };
        let asked = generation(Capability::Text, "describe the shot", json!({}));

        // A recording has no field in this shape, so it is left out rather
        // than sent as something it is not.
        assert!(pictures(&[voice]).is_empty());
        // And a picture beside it still travels, in the caller's own order.
        assert_eq!(
            pictures(&[
                media("photo", InputRole::Reference),
                media("plate", InputRole::Mask),
            ])
            .iter()
            .map(|input| input.asset_id.as_str())
            .collect::<Vec<&str>>(),
            ["photo", "plate"]
        );
        assert_eq!(
            text_body(&call, &asked, &[], false, false).pointer("/input/messages/0/content"),
            Some(&json!("describe the shot"))
        );
    }

    #[test]
    fn the_settings_a_request_named_travel_under_the_names_this_service_uses() {
        let asked = generation(
            Capability::Text,
            "a lighthouse",
            json!({ "temperature": 0.4, "maxTokens": "300" }),
        );
        // A count that arrives quoted is still a count: dropping it here would
        // silently ignore a setting the user made.
        assert_eq!(
            parameters(&asked, false),
            Map::from_iter([
                ("result_format".to_string(), json!("message")),
                ("temperature".to_string(), json!(0.4)),
                ("max_tokens".to_string(), json!(300)),
            ])
        );
        // A stream is asked to send pieces rather than the whole answer again.
        assert_eq!(
            parameters(&asked, true).get("incremental_output"),
            Some(&json!(true))
        );
    }

    #[test]
    fn an_answer_is_read_from_a_string_or_from_parts() {
        let message = read_answer(json!({
            "output": { "choices": [{ "message": {
                "role": "assistant",
                "content": "a lighthouse at dusk",
            } }] },
            "usage": { "input_tokens": 9, "output_tokens": 5 },
        }))
        .expect("an answer");
        assert_eq!(message.text.as_deref(), Some("a lighthouse at dusk"));
        assert_eq!(
            message.usage,
            Some(Usage {
                input_tokens: Some(9),
                output_tokens: Some(5),
                images: None,
                seconds: None,
            })
        );

        let parts = read_answer(json!({
            "output": { "choices": [{ "message": { "content": [
                { "text": "a lighthouse" },
                { "text": " at dusk" },
            ] } }] },
        }))
        .expect("an answer");
        assert_eq!(parts.text.as_deref(), Some("a lighthouse at dusk"));
        assert_eq!(parts.usage, None, "totals nobody reported are not invented");

        // The older `result_format` carries the answer without a message.
        let bare = read_answer(json!({ "output": { "text": "a lighthouse" } })).expect("an answer");
        assert_eq!(bare.text.as_deref(), Some("a lighthouse"));

        assert!(read_answer(json!({ "output": { "choices": [] } }))
            .expect("an answer")
            .is_empty());
    }

    #[test]
    fn a_refusal_that_arrived_as_a_success_is_an_error_rather_than_silence() {
        let refused = read_answer(json!({
            "code": "DataInspectionFailed",
            "message": "the question was filtered",
            "request_id": "abc",
        }))
        .expect_err("the question was refused");
        assert_eq!(refused.code(), "PROVIDER_BAD_REQUEST");
        assert!(
            refused.to_string().contains("the question was filtered"),
            "{refused}"
        );
        assert!(
            !refused.retryable(),
            "{refused} will not improve on a retry"
        );

        // What the service says when it explains itself in one word.
        let terse = read_answer(json!({ "code": "InvalidParameter" })).expect_err("refused");
        assert!(terse.to_string().contains("InvalidParameter"), "{terse}");
    }

    #[test]
    fn an_event_carries_the_piece_written_since_the_last_one() {
        let piece = event(&json!({
            "output": { "choices": [{ "message": { "content": "a light" } }] },
        }));
        assert_eq!(piece.text.as_deref(), Some("a light"));
        assert!(piece.failed.is_none());

        // The last event reports the totals of the whole answer.
        let closing = event(&json!({
            "output": { "choices": [{ "finish_reason": "stop", "message": { "content": "house" } }] },
            "usage": { "input_tokens": 4, "output_tokens": 6 },
        }));
        assert_eq!(closing.text.as_deref(), Some("house"));
        assert_eq!(closing.usage.and_then(|usage| usage.output_tokens), Some(6));
    }

    #[test]
    fn a_stream_that_failed_midway_carries_the_complaint_rather_than_a_piece() {
        let failed = event(&json!({
            "code": "Throttling",
            "message": "the service is busy",
            "request_id": "abc",
        }));
        assert_eq!(
            failed.failed.as_deref(),
            Some("Throttling: the service is busy")
        );
        assert!(failed.text.is_none());
    }

    #[test]
    fn a_drawing_is_asked_for_with_its_settings_and_an_edit_with_its_pictures() {
        let call = image_channel("wan2.7-image-pro");
        let drawn = generation(Capability::Image, "a cat on a windowsill", json!({}));
        assert_eq!(
            image_body(&call, &drawn, &[]),
            json!({
                "model": "wan2.7-image-pro",
                "input": { "messages": [{ "role": "user", "content": [
                    { "text": "a cat on a windowsill" },
                ] }] },
                "parameters": {},
            })
        );

        let asked = generation(
            Capability::Image,
            "make it snow",
            json!({ "size": "16:9", "count": 2 }),
        );
        let photo = media("photo", InputRole::Reference);
        assert_eq!(
            image_body(&call, &asked, &[photo, media("mask", InputRole::Mask)]),
            json!({
                "model": "wan2.7-image-pro",
                "input": { "messages": [{ "role": "user", "content": [
                    { "image": "data:image/png;base64,cG5n" },
                    { "image": "data:image/png;base64,cG5n" },
                    { "text": "make it snow" },
                ] }] },
                "parameters": { "size": "1360*768", "n": 2 },
            })
        );
    }

    #[test]
    fn a_shape_is_sent_as_the_pixels_that_describe_it() {
        for (asked, sent) in [
            // About a megapixel in the proportion asked for, both sides a
            // multiple of sixteen.
            ("1:1", Some("1024*1024")),
            ("16:9", Some("1360*768")),
            ("9:16", Some("768*1360")),
            ("3:4", Some("880*1184")),
            ("21:9", Some("1568*672")),
            // A size the service takes is passed on, in the spelling it reads.
            ("1024x1024", Some("1024*1024")),
            ("1280*720", Some("1280*720")),
            ("2K", Some("2K")),
            ("4k", Some("4K")),
            // Its own way of leaving the choice to the service.
            ("auto", None),
            ("", None),
        ] {
            assert_eq!(size_of(asked).as_deref(), sent, "asked for {asked}");
        }
    }

    #[test]
    fn the_drawings_of_an_answer_are_stored_under_what_they_are() {
        // The service counts the drawings it made and the tokens it spent,
        // whether or not it bills for them.
        let payload = json!({
            "usage": { "image_count": 1, "input_tokens": 12, "output_tokens": 2 },
        });
        let usage = drawn_usage(&payload, 1).expect("the count is reported");
        assert_eq!(usage.images, Some(1));
        assert_eq!(usage.input_tokens, Some(12));
        assert_eq!(
            drawn_usage(&json!({}), 0),
            None,
            "nothing reported is not zeroes"
        );

        // A drawing carried in the answer itself is decoded rather than asked
        // for over the network.
        let picture = png(2, 3);
        let inline = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&picture)
        );
        let item = inline_drawing(inline.strip_prefix("data:").expect("a data url"))
            .expect("the bytes are an image");
        assert_eq!(item.mime, "image/png");
        assert_eq!((item.width, item.height), (Some(2), Some(3)));
    }

    /// A real encoded image, so a test can assert on what sniffing and the
    /// header read find rather than on a mime somebody claimed.
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
}
