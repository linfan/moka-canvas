//! The protocol adapters against a provider standing on localhost.
//!
//! A real socket rather than a stub: what these tests have to prove is the
//! address that gets built, where the credential travels, what is sent, and
//! what comes back — none of which a hand-written fake would exercise.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use axum::body::{Body, Bytes};
use axum::extract::{Multipart, RawQuery};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use moka_canvas::config::GenerateConfig;
use moka_canvas::converter::deploy::ensure_deployed;
use moka_canvas::converter::LuaAdapter;
use moka_canvas::domain::Capability;
use moka_canvas::generate::adapters::{ModelCall, ProviderAdapter};
use moka_canvas::generate::media::MediaInput;
use moka_canvas::generate::models::ResolvedModel;
use moka_canvas::generate::{Cancel, DeltaSink, GenerateRequest, InputRole, TaskState};
use moka_canvas::metadata::Protocol;
use serde_json::{json, Value};

/// Long enough that masking keeps a recognisable head and tail.
const API_KEY: &str = "sk-test-1234567890abcd";

/// What arrived at the throwaway provider, so a test can assert on the request
/// as well as on the answer.
#[derive(Clone, Default)]
struct Recorded {
    authorization: Arc<Mutex<Option<String>>>,
    api_key: Arc<Mutex<Option<String>>>,
    /// The header that asks Bailian for an answer in pieces.
    sse: Arc<Mutex<Option<String>>>,
    query: Arc<Mutex<Option<String>>>,
    /// The endpoints asked, in order, each named by the test that routed it.
    asked: Arc<Mutex<Vec<String>>>,
    bodies: Arc<Mutex<Vec<String>>>,
    /// The parts of a multipart body, as `name` or `name (filename)`.
    parts: Arc<Mutex<Vec<String>>>,
    polls: Arc<AtomicUsize>,
}

impl Recorded {
    fn note(&self, endpoint: &str, headers: &HeaderMap, query: Option<String>) {
        self.asked
            .lock()
            .expect("not poisoned")
            .push(endpoint.into());
        *self.authorization.lock().expect("not poisoned") = headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        *self.api_key.lock().expect("not poisoned") = headers
            .get("x-goog-api-key")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        *self.sse.lock().expect("not poisoned") = headers
            .get("x-dashscope-sse")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        *self.query.lock().expect("not poisoned") = query;
    }

    fn note_body(&self, body: &Bytes) {
        let text = String::from_utf8_lossy(body).to_string();
        self.bodies.lock().expect("not poisoned").push(text);
    }

    fn asked(&self) -> Vec<String> {
        self.asked.lock().expect("not poisoned").clone()
    }

    fn asked_once(&self, endpoint: &str) -> bool {
        self.asked().iter().any(|asked| asked == endpoint)
    }

    fn body(&self, index: usize) -> Value {
        let bodies = self.bodies.lock().expect("not poisoned").clone();
        serde_json::from_str(&bodies[index]).expect("the body sent was JSON")
    }

    fn headers(&self) -> Headers {
        Headers {
            authorization: self.authorization.lock().expect("not poisoned").clone(),
            api_key: self.api_key.lock().expect("not poisoned").clone(),
            query: self.query.lock().expect("not poisoned").clone(),
        }
    }

    fn parts(&self) -> Vec<String> {
        self.parts.lock().expect("not poisoned").clone()
    }

    fn sse(&self) -> Option<String> {
        self.sse.lock().expect("not poisoned").clone()
    }

    fn next_poll(&self) -> usize {
        self.polls.fetch_add(1, Ordering::SeqCst)
    }
}

#[derive(Clone)]
struct Headers {
    authorization: Option<String>,
    api_key: Option<String>,
    query: Option<String>,
}

/// Starts a throwaway provider and returns the base address a model's full
/// endpoint URL is built on.
async fn serve(routes: Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("an ephemeral port is available");
    let address = listener.local_addr().expect("the socket has an address");
    tokio::spawn(async move {
        let _ = axum::serve(listener, routes).await;
    });
    format!("http://{address}")
}

/// A model configuration resolved to one call on a throwaway provider, at the
/// endpoint address a capability speaks under the OpenAI-compatible
/// converters.
fn channel(base_url: &str, model_id: &str, capability: Capability) -> ModelCall {
    let (protocol, path) = match capability {
        Capability::Text => ("openaiChat", "/v1/chat/completions"),
        Capability::Image => ("openaiImages", "/v1/images/generations"),
        Capability::Speech => ("openaiSpeech", "/v1/audio/speech"),
        Capability::Music => ("bailianMusic", "/api/v1/services/audio/music/generation"),
        Capability::Video => ("openaiVideos", "/v1/videos"),
        // Recognition is served by a converter of its own; what it is asked at
        // is that converter's business, and no test here asks it anything.
        Capability::Asr => ("bailianAsr", "/api/v1/services/audio/asr/transcription"),
    };
    at(protocol, base_url, model_id, capability, path)
}

/// A model configuration resolved to one call under a named converter, at an
/// address on a throwaway provider's base address.
fn at(
    protocol: &str,
    base_url: &str,
    model_id: &str,
    capability: Capability,
    path: &str,
) -> ModelCall {
    let resolved = ResolvedModel {
        config_id: model_id.into(),
        model: model_id.to_string(),
        display_name: format!("Model {model_id}"),
        category: capability,
        protocol: Protocol::from_wire_name(protocol),
        url: format!("{base_url}{path}"),
    };
    ModelCall::new(&resolved, API_KEY.to_string(), GenerateConfig::default())
        .expect("a client builds")
}

fn gemini_channel(base_url: &str, model_id: &str, capability: Capability) -> ModelCall {
    match capability {
        Capability::Video => at(
            "geminiVideo",
            base_url,
            model_id,
            capability,
            &format!("/v1beta/models/{model_id}:predictLongRunning"),
        ),
        _ => at(
            "gemini",
            base_url,
            model_id,
            capability,
            &format!("/v1beta/models/{model_id}:generateContent"),
        ),
    }
}

/// A Bailian configuration: the converters of that platform, addressed at the
/// endpoint each one is configured with.
fn bailian_channel(base_url: &str, model_id: &str, capability: Capability) -> ModelCall {
    let (id, path) = match capability {
        Capability::Image => (
            "bailianImage",
            "/api/v1/services/aigc/multimodal-generation/generation",
        ),
        _ => (
            "bailianText",
            "/api/v1/services/aigc/text-generation/generation",
        ),
    };
    at(id, base_url, model_id, capability, path)
}

/// A Bailian text configuration addressed at one of the two services the
/// platform serves the same deployment at, which is a setting rather than a
/// protocol.
fn bailian_text_at(base_url: &str, model_id: &str, service: &str) -> ModelCall {
    let resolved = ResolvedModel {
        config_id: model_id.into(),
        model: model_id.to_string(),
        display_name: format!("Model {model_id}"),
        category: Capability::Text,
        protocol: Protocol::from_wire_name("bailianText"),
        url: format!("{base_url}/api/v1/services/aigc/{service}/generation"),
    };
    ModelCall::new(&resolved, API_KEY.to_string(), GenerateConfig::default())
        .expect("a client builds")
}

/// The models directory the converters under test are read from.
///
/// The host reads one root per process, so the built-in converters are
/// deployed once for the whole binary and the root is leaked: one that went
/// away with its test would leave the rest of them reading a directory that no
/// longer exists.
async fn converter_root() -> &'static std::path::Path {
    static ROOT: tokio::sync::OnceCell<&'static std::path::Path> =
        tokio::sync::OnceCell::const_new();
    ROOT.get_or_init(|| async {
        let dir =
            std::env::temp_dir().join(format!("moka-provider-adapters-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("a models directory is writable");
        let dir: &'static std::path::Path = Box::leak(dir.into_boxed_path());
        ensure_deployed(dir)
            .await
            .expect("the built-in converters deploy");
        dir
    })
    .await
}

/// The adapter every converter script is spoken by, which is deployed before
/// it is asked anything.
async fn scripted() -> &'static dyn ProviderAdapter {
    converter_root().await;
    LuaAdapter::get()
}

fn generation(capability: Capability, prompt: &str, params: Value) -> GenerateRequest {
    GenerateRequest {
        capability,
        prompt: prompt.into(),
        params: params.as_object().cloned().unwrap_or_default(),
        ..GenerateRequest::default()
    }
}

/// Collects what a stream pushed, so a test can assert on what was shown as
/// well as on the aggregate that gets stored.
fn watching() -> (DeltaSink, Arc<Mutex<String>>) {
    let seen = Arc::new(Mutex::new(String::new()));
    let collected = Arc::clone(&seen);
    let sink = DeltaSink::new(Arc::new(move |chunk: &str| {
        collected
            .lock()
            .expect("not held across a call")
            .push_str(chunk);
    }));
    (sink, seen)
}

fn shown(seen: &Arc<Mutex<String>>) -> String {
    seen.lock().expect("not held across a call").clone()
}

fn reference(name: &str, role: InputRole) -> MediaInput {
    MediaInput {
        role,
        asset_id: name.into(),
        name: format!("{name}.png"),
        bytes: png(4, 3),
        mime: "image/png".into(),
    }
}

/// A real encoded image, so an answer can be asserted on by what it is rather
/// than by what a test claimed it was.
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

fn base64(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

async fn refuse(status: StatusCode, body: Value) -> Response {
    (status, Json(body)).into_response()
}

/// An endpoint a test routes only to find out whether it was asked. The answer
/// type is declared so that reaching it can be a bare panic.
async fn not_for_an_edit() -> Response {
    panic!("an edit must not be sent to the endpoint for a new image")
}

/// The address a request reached this provider on.
///
/// A route cannot know the ephemeral port it was bound to, so the only way for
/// an answer to name a second endpoint on the same provider is to read the one
/// it was asked on.
fn reached_on(headers: &HeaderMap) -> String {
    headers
        .get("host")
        .and_then(|value| value.to_str().ok())
        .expect("a request names the host it asked for")
        .to_string()
}

// ------------------------------------------------------------------- text

/// An answer that arrives in pieces, as the endpoint that produces it sends it.
///
/// Only the pieces named here are sent: a provider that ends a stream with a
/// word of its own has to say so, and one that simply stops has to be tested
/// stopping.
fn stream(events: &[&str]) -> Response {
    let mut body = String::new();
    for event in events {
        body.push_str(&format!("data: {event}\n\n"));
    }
    (
        [(axum::http::header::CONTENT_TYPE, "text/event-stream")],
        body,
    )
        .into_response()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_streamed_text_generation_is_aggregated_before_it_is_stored() {
    let recorded = Recorded::default();
    let answering = recorded.clone();
    let base_url = serve(Router::new().route(
        "/v1/responses",
        post(move |headers: HeaderMap, body: Bytes| {
            let recorded = answering.clone();
            async move {
                recorded.note("responses", &headers, None);
                recorded.note_body(&body);
                stream(&[
                    r#"{"type":"response.output_text.delta","delta":"A "}"#,
                    r#"{"type":"response.output_text.delta","delta":"lantern."}"#,
                    r#"{"type":"response.completed","response":{"output_text":"A lantern.","usage":{"input_tokens":4,"output_tokens":2}}}"#,
                    "[DONE]",
                ])
            }
        }),
    ))
    .await;

    let call = at(
        "openaiResponses",
        &base_url,
        "gpt-5.5",
        Capability::Text,
        "/v1/responses",
    );
    let request = generation(
        Capability::Text,
        "describe a lantern",
        json!({ "stream": true }),
    );
    let (sink, seen) = watching();

    let result = scripted()
        .await
        .generate_stream(&call, &request, &[], &sink, &Cancel::new())
        .await
        .expect("the stream is read to its end");

    // The aggregate is what gets stored; the stream only made the wait visible.
    assert_eq!(result.text.as_deref(), Some("A lantern."));
    assert_eq!(shown(&seen), "A lantern.");
    assert_eq!(result.usage.and_then(|usage| usage.input_tokens), Some(4));
    assert_eq!(result.usage.and_then(|usage| usage.output_tokens), Some(2));

    let sent = recorded.body(0);
    assert_eq!(sent["model"], "gpt-5.5");
    assert_eq!(sent["input"], "describe a lantern");
    assert_eq!(sent["stream"], true, "the endpoint was asked for pieces");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_request_a_provider_refused_is_not_repeated_on_another_endpoint() {
    let recorded = Recorded::default();
    let refusing = recorded.clone();
    let answering = recorded.clone();
    let base_url = serve(
        Router::new()
            .route(
                "/v1/responses",
                post(move |headers: HeaderMap| {
                    let recorded = refusing.clone();
                    async move {
                        recorded.note("responses", &headers, None);
                        refuse(
                            StatusCode::BAD_REQUEST,
                            json!({"error": {"message": "that prompt is not allowed"}}),
                        )
                        .await
                    }
                }),
            )
            .route(
                "/v1/chat/completions",
                post(move |headers: HeaderMap| {
                    let recorded = answering.clone();
                    async move {
                        recorded.note("chat", &headers, None);
                        Json(json!({ "choices": [{ "message": { "content": "never" } }] }))
                    }
                }),
            ),
    )
    .await;

    let call = at(
        "openaiResponses",
        &base_url,
        "gpt-5.5",
        Capability::Text,
        "/v1/responses",
    );
    let request = generation(Capability::Text, "describe a lantern", json!({}));
    let error = scripted()
        .await
        .generate(&call, &request, &[], &Cancel::new())
        .await
        .expect_err("the provider understood and refused the request");

    assert_eq!(error.code(), "PROVIDER_BAD_REQUEST");
    assert!(
        error.to_string().contains("that prompt is not allowed"),
        "{error}"
    );
    assert_eq!(
        recorded.asked(),
        ["responses"],
        "the same request elsewhere would be refused the same way"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_chat_protocol_configuration_is_asked_at_the_chat_endpoint() {
    let recorded = Recorded::default();
    let answering = recorded.clone();
    let base_url = serve(Router::new().route(
        "/v1/chat/completions",
        post(move |headers: HeaderMap| {
            let recorded = answering.clone();
            async move {
                recorded.note("chat", &headers, None);
                Json(json!({ "choices": [{ "message": { "content": "" } }] }))
            }
        }),
    ))
    .await;

    // The address a configuration carries is the whole endpoint: the chat
    // protocol posts to it and nowhere else.
    let call = channel(&base_url, "llama-3.3", Capability::Text);
    let result = scripted()
        .await
        .generate(
            &call,
            &generation(Capability::Text, "say nothing", json!({})),
            &[],
            &Cancel::new(),
        )
        .await
        .expect("the answer arrives");

    assert_eq!(recorded.asked(), ["chat"]);
    // A blank answer is reported as empty rather than stored as a blank node;
    // turning that into a code is the gateway's job, not the adapter's.
    assert!(result.is_empty(), "{result:?}");
}

// ------------------------------------------------------------------ image

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_image_generation_arrives_inline_with_its_size_read_from_the_bytes() {
    let picture = png(4, 3);
    let recorded = Recorded::default();
    let answering = recorded.clone();
    let stored = picture.clone();
    let base_url = serve(Router::new().route(
        "/v1/images/generations",
        post(move |headers: HeaderMap, body: Bytes| {
            let recorded = answering.clone();
            let picture = stored.clone();
            async move {
                recorded.note("generations", &headers, None);
                recorded.note_body(&body);
                Json(json!({
                    "created": 1_700_000_000u64,
                    "data": [{ "b64_json": base64(&picture), "revised_prompt": "a cat, asleep" }],
                }))
            }
        }),
    ))
    .await;

    let call = channel(&base_url, "gpt-image-2", Capability::Image);
    let request = generation(
        Capability::Image,
        "a cat",
        json!({ "size": "1024x1024", "count": 1 }),
    );
    let result = scripted()
        .await
        .generate(&call, &request, &[], &Cancel::new())
        .await
        .expect("the image arrives");

    assert_eq!(result.items.len(), 1);
    let item = &result.items[0];
    assert_eq!(item.mime, "image/png", "sniffed, not assumed");
    assert_eq!(item.kind, Capability::Image);
    assert_eq!((item.width, item.height), (Some(4), Some(3)));
    assert_eq!(item.bytes, picture);
    assert_eq!(
        result.text.as_deref(),
        Some("a cat, asleep"),
        "a prompt the provider rewrote is worth showing"
    );
    assert_eq!(result.usage.and_then(|usage| usage.images), Some(1));

    let sent = recorded.body(0);
    assert_eq!(sent["model"], "gpt-image-2");
    assert_eq!(sent["size"], "1024x1024");
    assert_eq!(sent["n"], 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_image_left_on_the_channels_own_host_is_fetched_with_the_credential() {
    let picture = png(2, 2);
    let recorded = Recorded::default();
    let answering = recorded.clone();
    let serving = recorded.clone();
    let stored = picture.clone();
    // One provider serves both, so the address it answers with is by
    // construction one the channel may send its credential to.
    let base_url = serve(
        Router::new()
            .route(
                "/v1/images/generations",
                post(move |headers: HeaderMap| {
                    let recorded = answering.clone();
                    async move {
                        // The route does not know its own port, so the address
                        // is named from the one it was reached on.
                        let host = reached_on(&headers);
                        recorded.note("generations", &headers, None);
                        Json(json!({ "data": [{ "url": format!("http://{host}/made/cat.png") }] }))
                    }
                }),
            )
            .route(
                "/made/cat.png",
                get(move |headers: HeaderMap| {
                    let recorded = serving.clone();
                    let stored = stored.clone();
                    async move {
                        recorded.note("image", &headers, None);
                        ([(axum::http::header::CONTENT_TYPE, "image/png")], stored)
                    }
                }),
            ),
    )
    .await;

    let call = channel(&base_url, "gpt-image-2", Capability::Image);
    let result = scripted()
        .await
        .generate(
            &call,
            &generation(Capability::Image, "a cat", json!({})),
            &[],
            &Cancel::new(),
        )
        .await
        .expect("the image is fetched");

    assert_eq!(result.items[0].bytes, picture);
    assert_eq!(
        recorded.headers().authorization.as_deref(),
        Some(&format!("Bearer {API_KEY}")[..]),
        "the channel's own host is a place the credential may go"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_image_left_on_another_host_is_fetched_without_the_credential() {
    let picture = png(2, 2);
    let elsewhere = Recorded::default();
    let serving = elsewhere.clone();
    let stored = picture.clone();
    let elsewhere_url = serve(Router::new().route(
        "/made/cat.png",
        get(move |headers: HeaderMap| {
            let recorded = serving.clone();
            let stored = stored.clone();
            async move {
                recorded.note("image", &headers, None);
                ([(axum::http::header::CONTENT_TYPE, "image/png")], stored)
            }
        }),
    ))
    .await;

    let recorded = Recorded::default();
    let answering = recorded.clone();
    let base_url = serve(Router::new().route(
        "/v1/images/generations",
        post(move |headers: HeaderMap| {
            let recorded = answering.clone();
            let address = format!("{elsewhere_url}/made/cat.png");
            async move {
                recorded.note("generations", &headers, None);
                Json(json!({ "data": [{ "url": address }] }))
            }
        }),
    ))
    .await;

    let call = channel(&base_url, "gpt-image-2", Capability::Image);
    let result = scripted()
        .await
        .generate(
            &call,
            &generation(Capability::Image, "a cat", json!({})),
            &[],
            &Cancel::new(),
        )
        .await
        .expect("the image is fetched");

    assert_eq!(result.items[0].bytes, picture);
    assert!(
        elsewhere.headers().authorization.is_none(),
        "a credential never follows an answer to a host that did not produce it"
    );
    assert!(recorded.asked_once("generations"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn references_turn_an_image_generation_into_a_multipart_edit() {
    let recorded = Recorded::default();
    let answering = recorded.clone();
    let picture = png(3, 3);
    let stored = picture.clone();
    let base_url = serve(
        Router::new()
            .route(
                "/v1/images/edits",
                post(move |headers: HeaderMap, mut parts: Multipart| {
                    let recorded = answering.clone();
                    let picture = stored.clone();
                    async move {
                        recorded.note("edits", &headers, None);
                        while let Ok(Some(part)) = parts.next_field().await {
                            let name = part.name().unwrap_or_default().to_string();
                            let filename = part.file_name().map(str::to_string);
                            let noted = match filename {
                                Some(filename) => format!("{name} ({filename})"),
                                None => {
                                    let value = part.text().await.unwrap_or_default();
                                    recorded
                                        .bodies
                                        .lock()
                                        .expect("not poisoned")
                                        .push(format!("{name}={value}"));
                                    name
                                }
                            };
                            recorded.parts.lock().expect("not poisoned").push(noted);
                        }
                        Json(json!({ "data": [{ "b64_json": base64(&picture) }] }))
                    }
                }),
            )
            .route("/v1/images/generations", post(not_for_an_edit)),
    )
    .await;

    let call = channel(&base_url, "gpt-image-2", Capability::Image);
    let inputs = [
        reference("photo", InputRole::Reference),
        reference("second", InputRole::Reference),
        reference("mask", InputRole::Mask),
    ];
    let result = scripted()
        .await
        .generate(
            &call,
            &generation(
                Capability::Image,
                "make it snow",
                json!({ "size": "512x512" }),
            ),
            &inputs,
            &Cancel::new(),
        )
        .await
        .expect("the edit arrives");

    assert_eq!(result.items[0].bytes, picture);
    let parts = recorded.parts();
    // Several references travel under the plural field name, and the mask keeps
    // a field of its own even though it is an image too.
    assert_eq!(
        parts,
        [
            "model",
            "prompt",
            "size",
            "image[] (photo.png)",
            "image[] (second.png)",
            "mask (mask.png)",
        ],
        "{parts:?}"
    );
    assert!(recorded.asked_once("edits"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_address_with_no_edit_door_is_refused_rather_than_asked_another_way() {
    let recorded = Recorded::default();
    let refusing = recorded.clone();
    let base_url = serve(
        Router::new()
            // The address a standard shape names the edits beside the
            // generations with, absent at a gateway that serves one only.
            .route(
                "/v1/images/edits",
                post(move |headers: HeaderMap| {
                    let recorded = refusing.clone();
                    async move {
                        recorded.note("edits", &headers, None);
                        StatusCode::NOT_FOUND
                    }
                }),
            )
            .route("/v1/images/generations", post(not_for_an_edit)),
    )
    .await;

    let call = channel(&base_url, "qwen-image-3.0", Capability::Image);
    let error = scripted()
        .await
        .generate(
            &call,
            &generation(
                Capability::Image,
                "four views of the same character",
                json!({ "size": "1024x1024" }),
            ),
            &[reference("photo", InputRole::Reference)],
            &Cancel::new(),
        )
        .await
        .expect_err("the edit address is the only door an edit has");

    // An edit is asked at the edit address and nowhere else. A service that
    // reads an edit out of a generation body is a shape of its own, and the
    // converter of that platform is where that shape belongs.
    assert_eq!(recorded.asked(), ["edits"]);
    assert_eq!(error.code(), "PROVIDER_BAD_REQUEST");
}

// ------------------------------------------------------------------ audio

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn audio_arrives_as_the_bytes_the_provider_answered_with() {
    let recorded = Recorded::default();
    let answering = recorded.clone();
    let base_url = serve(Router::new().route(
        "/v1/audio/speech",
        post(move |headers: HeaderMap, body: Bytes| {
            let recorded = answering.clone();
            async move {
                recorded.note("speech", &headers, None);
                recorded.note_body(&body);
                Response::builder()
                    .header(axum::http::header::CONTENT_TYPE, "audio/wav")
                    .body(Body::from(b"RIFF-audio".to_vec()))
                    .expect("a response builds")
            }
        }),
    ))
    .await;

    let call = channel(&base_url, "a-voice", Capability::Speech);
    let request = generation(
        Capability::Speech,
        "read this aloud",
        json!({ "voice": "alloy", "format": "wav" }),
    );
    let result = scripted()
        .await
        .generate(&call, &request, &[], &Cancel::new())
        .await
        .expect("the audio arrives");

    assert_eq!(result.items.len(), 1);
    assert_eq!(result.items[0].mime, "audio/wav", "the answer said so");
    assert_eq!(result.items[0].kind, Capability::Speech);
    assert_eq!(result.items[0].bytes, b"RIFF-audio");
    assert_eq!(result.text, None);

    let sent = recorded.body(0);
    assert_eq!(sent["input"], "read this aloud");
    assert_eq!(sent["response_format"], "wav");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_audio_answer_that_is_not_audio_is_refused_rather_than_stored() {
    let base_url = serve(Router::new().route(
        "/v1/audio/speech",
        post(|| async {
            // A success carrying a complaint: storing it would produce an asset
            // that cannot be played, and the message would never be read.
            Response::builder()
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    r#"{"error":{"message":"that voice is not on this key"}}"#,
                ))
                .expect("a response builds")
        }),
    ))
    .await;

    let call = channel(&base_url, "a-voice", Capability::Speech);
    let error = scripted()
        .await
        .generate(
            &call,
            &generation(Capability::Speech, "read this", json!({})),
            &[],
            &Cancel::new(),
        )
        .await
        .expect_err("something other than audio answered");

    assert_eq!(error.code(), "PROVIDER_BAD_REQUEST");
    assert!(error.to_string().contains("application/json"), "{error}");
}

// ------------------------------------------------------------------ video

/// A provider that starts a job, answers one poll with work still to do, and
/// the next with the finished bytes.
async fn video_provider(recorded: Recorded) -> String {
    let started = recorded.clone();
    let polled = recorded.clone();
    let collected = recorded.clone();
    serve(
        Router::new()
            .route(
                "/v1/videos",
                post(move |headers: HeaderMap, body: Bytes| {
                    let recorded = started.clone();
                    async move {
                        recorded.note("start", &headers, None);
                        recorded.note_body(&body);
                        Json(json!({ "id": "job-1", "status": "queued" }))
                    }
                }),
            )
            .route(
                "/v1/videos/{id}",
                get(move |headers: HeaderMap| {
                    let recorded = polled.clone();
                    async move {
                        recorded.note("poll", &headers, None);
                        // The first look finds work in progress; the second
                        // finds the job finished.
                        let status = if recorded.next_poll() == 0 {
                            "in_progress"
                        } else {
                            "completed"
                        };
                        Json(json!({ "id": "job-1", "status": status }))
                    }
                }),
            )
            .route(
                "/v1/videos/{id}/content",
                get(move |headers: HeaderMap| {
                    let recorded = collected.clone();
                    async move {
                        recorded.note("content", &headers, None);
                        Response::builder()
                            .header(axum::http::header::CONTENT_TYPE, "video/mp4")
                            .body(Body::from(b"mp4-bytes".to_vec()))
                            .expect("a response builds")
                    }
                }),
            ),
    )
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_video_generation_is_started_polled_and_collected() {
    let recorded = Recorded::default();
    let base_url = video_provider(recorded.clone()).await;
    let call = channel(&base_url, "a-video-model", Capability::Video);
    let cancel = Cancel::new();

    let inputs = [
        reference("opening", InputRole::FirstFrame),
        reference("closing", InputRole::LastFrame),
    ];
    let request = generation(
        Capability::Video,
        "a slow pan",
        json!({ "seconds": 6, "ratio": "16:9" }),
    );
    let task = scripted()
        .await
        .create_task(&call, &request, &inputs, &cancel)
        .await
        .expect("the job starts");

    // The handle a client polls with is ours: the provider's own identifier is
    // opaque and stays inside the task.
    assert!(!task.id.is_empty());
    assert_ne!(task.id, task.reference);
    assert_eq!(task.reference, "job-1");
    assert_eq!(task.protocol, Protocol::new("openaiVideos"));
    assert_eq!(task.capability, Capability::Video);
    assert_eq!(task.model, "a-video-model");
    assert!(!task.created_at.is_empty());

    let sent = recorded.body(0);
    assert_eq!(sent["model"], "a-video-model");
    assert_eq!(sent["seconds"], 6);
    assert!(
        sent["first_frame"].is_string(),
        "the frames were named: {sent}"
    );
    assert!(sent["last_frame"].is_string(), "{sent}");

    match scripted().await.poll_task(&call, &task, &cancel).await {
        Ok(TaskState::Pending { retry_after_ms }) => {
            assert!(retry_after_ms > 0, "a poll is worth waiting for")
        }
        other => panic!("expected a job still running, got {other:?}"),
    }
    match scripted()
        .await
        .poll_task(&call, &task, &cancel)
        .await
        .expect("the job is collected")
    {
        TaskState::Succeeded(result) => {
            assert_eq!(result.items.len(), 1);
            assert_eq!(result.items[0].mime, "video/mp4");
            assert_eq!(result.items[0].kind, Capability::Video);
            assert_eq!(result.items[0].bytes, b"mp4-bytes");
        }
        other => panic!("expected the finished video, got {other:?}"),
    }
    assert_eq!(recorded.asked(), ["start", "poll", "poll", "content"]);
}

/// How an act is filmed: the ends the ports labelled are the frames the shot
/// lands on, and a board given beside them is asked for as a reference rather
/// than taking one of their places.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_picture_beside_the_labelled_ends_rides_as_a_reference() {
    let recorded = Recorded::default();
    let base_url = video_provider(recorded.clone()).await;
    let call = channel(&base_url, "a-video-model", Capability::Video);

    let inputs = [
        reference("opening", InputRole::FirstFrame),
        reference("middle", InputRole::Reference),
        reference("closing", InputRole::LastFrame),
    ];
    scripted()
        .await
        .create_task(
            &call,
            &generation(Capability::Video, "a slow pan", json!({})),
            &inputs,
            &Cancel::new(),
        )
        .await
        .expect("the job starts");

    let sent = recorded.body(0);
    assert_eq!(sent["first_frame"], inputs[0].data_url(), "{sent}");
    assert_eq!(sent["last_frame"], inputs[2].data_url(), "{sent}");
    assert_eq!(
        sent["reference_images"],
        json!([inputs[1].data_url()]),
        "{sent}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_job_the_provider_has_forgotten_ends_the_polling() {
    let base_url = serve(Router::new().route(
        "/v1/videos/{id}",
        get(|| async {
            refuse(
                StatusCode::NOT_FOUND,
                json!({"error": {"message": "no such video"}}),
            )
            .await
        }),
    ))
    .await;

    let call = channel(&base_url, "a-video-model", Capability::Video);
    let task = moka_canvas::generate::AsyncTask {
        id: "task-1".into(),
        reference: "job-gone".into(),
        protocol: Protocol::new("openaiVideos"),
        capability: Capability::Video,
        model: "a-video-model".into(),
        created_at: "2026-01-01T00:00:00Z".into(),
    };

    let error = scripted()
        .await
        .poll_task(&call, &task, &Cancel::new())
        .await
        .expect_err("the job is gone");

    // Not a failure to look: another poll cannot help, and the client is told
    // to start over rather than to wait.
    assert_eq!(error.code(), "TASK_EXPIRED");
    assert!(!error.retryable());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_job_that_failed_reports_the_providers_explanation() {
    let base_url = serve(Router::new().route(
        "/v1/videos/{id}",
        get(|| async {
            Json(json!({
                "id": "job-2",
                "status": "failed",
                "error": { "message": "the prompt was refused" },
            }))
        }),
    ))
    .await;

    let call = channel(&base_url, "a-video-model", Capability::Video);
    let task = moka_canvas::generate::AsyncTask {
        id: "task-2".into(),
        reference: "job-2".into(),
        protocol: Protocol::new("openaiVideos"),
        capability: Capability::Video,
        model: "a-video-model".into(),
        created_at: "2026-01-01T00:00:00Z".into(),
    };

    match scripted()
        .await
        .poll_task(&call, &task, &Cancel::new())
        .await
        .expect("the job answered")
    {
        TaskState::Failed { message, retryable } => {
            assert_eq!(message, "the prompt was refused");
            assert!(!retryable, "the same job would fail the same way");
        }
        other => panic!("expected a failed job, got {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_capability_with_no_job_is_not_started_as_one() {
    let call = channel("http://127.0.0.1:1", "gpt-image-2", Capability::Image);
    let error = scripted()
        .await
        .create_task(
            &call,
            &generation(Capability::Image, "a cat", json!({})),
            &[],
            &Cancel::new(),
        )
        .await
        .expect_err("an image answers at once");

    assert_eq!(error.code(), "VALIDATION_FAILED");
    assert!(
        error.to_string().contains("image"),
        "the capability is named: {error}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cancelled_generation_is_not_sent() {
    let recorded = Recorded::default();
    let answering = recorded.clone();
    let base_url = serve(Router::new().route(
        "/v1/images/generations",
        post(move |headers: HeaderMap| {
            let recorded = answering.clone();
            async move {
                recorded.note("generations", &headers, None);
                Json(json!({ "data": [] }))
            }
        }),
    ))
    .await;

    let cancel = Cancel::new();
    cancel.cancel();
    let call = channel(&base_url, "gpt-image-2", Capability::Image);
    let error = scripted()
        .await
        .generate(
            &call,
            &generation(Capability::Image, "a cat", json!({})),
            &[],
            &cancel,
        )
        .await
        .expect_err("the caller already left");

    assert_eq!(error.code(), "GENERATION_CANCELLED");
    assert!(
        recorded.asked().is_empty(),
        "nothing was sent to a caller who is gone"
    );
}

// ----------------------------------------------------------------- gemini

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_gemini_generation_is_asked_on_the_models_own_address() {
    let recorded = Recorded::default();
    let answering = recorded.clone();
    let base_url = serve(Router::new().route(
        "/v1beta/models/gemini-2.5-flash:generateContent",
        post(move |headers: HeaderMap, body: Bytes| {
            let recorded = answering.clone();
            async move {
                recorded.note("generate", &headers, None);
                recorded.note_body(&body);
                Json(json!({
                    "candidates": [{
                        "content": { "role": "model", "parts": [{ "text": "A lantern, lit." }] }
                    }],
                    "usageMetadata": { "promptTokenCount": 4, "candidatesTokenCount": 2 },
                }))
            }
        }),
    ))
    .await;

    let call = gemini_channel(&base_url, "gemini-2.5-flash", Capability::Text);
    let result = scripted()
        .await
        .generate(
            &call,
            &generation(
                Capability::Text,
                "describe a lantern",
                json!({ "instructions": "one sentence", "maxTokens": 200 }),
            ),
            &[],
            &Cancel::new(),
        )
        .await
        .expect("the answer arrives");

    assert_eq!(result.text.as_deref(), Some("A lantern, lit."));
    assert!(result.items.is_empty(), "words alone left nothing to store");
    let usage = result.usage.expect("the totals were counted");
    assert_eq!(usage.input_tokens, Some(4));
    assert_eq!(usage.output_tokens, Some(2));

    // This protocol carries its credential in a header of its own: a URL is
    // quoted back in logs and in error messages, and a header is neither.
    let headers = recorded.headers();
    assert_eq!(headers.api_key.as_deref(), Some(API_KEY));
    assert_eq!(headers.authorization, None);
    assert_eq!(headers.query, None);

    let sent = recorded.body(0);
    assert_eq!(sent["contents"][0]["role"], "user");
    assert_eq!(
        sent["contents"][0]["parts"][0]["text"],
        "describe a lantern"
    );
    assert_eq!(
        sent["systemInstruction"]["parts"][0]["text"], "one sentence",
        "an instruction frames the prompt rather than joining it"
    );
    assert_eq!(sent["generationConfig"]["maxOutputTokens"], 200);
    // The model is named in the address. Naming it again in a body would leave
    // two places for the two to disagree.
    assert!(sent.get("model").is_none(), "{sent}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_image_a_gemini_model_made_arrives_inside_its_answer() {
    // A shape of its own: the reference this request carries is 4x3, and an
    // answer that echoed it back would otherwise look like one that was read.
    let picture = png(6, 5);
    let recorded = Recorded::default();
    let answering = recorded.clone();
    let encoded = base64(&picture);
    let base_url = serve(Router::new().route(
        "/v1beta/models/an-image-model:generateContent",
        post(move |headers: HeaderMap, body: Bytes| {
            let recorded = answering.clone();
            let encoded = encoded.clone();
            async move {
                recorded.note("generate", &headers, None);
                recorded.note_body(&body);
                Json(json!({
                    "candidates": [{
                        "content": { "parts": [
                            { "text": "a cat, asleep" },
                            { "inlineData": { "mimeType": "image/png", "data": encoded } },
                        ] }
                    }],
                }))
            }
        }),
    ))
    .await;

    let call = gemini_channel(&base_url, "an-image-model", Capability::Image);
    let inputs = [reference("style", InputRole::Reference)];
    let result = scripted()
        .await
        .generate(
            &call,
            &generation(
                Capability::Image,
                "a cat",
                json!({ "size": "1024x1536", "count": 2 }),
            ),
            &inputs,
            &Cancel::new(),
        )
        .await
        .expect("the answer arrives");

    // Words beside a picture are worth keeping: this protocol answers both in
    // one document, and dropping the caption would lose what the model said.
    assert_eq!(result.text.as_deref(), Some("a cat, asleep"));
    assert_eq!(result.items.len(), 1);
    let item = &result.items[0];
    assert_eq!(item.mime, "image/png");
    assert_eq!(item.kind, Capability::Image);
    assert_eq!(item.bytes, picture);
    assert_eq!(
        (item.width, item.height),
        (Some(6), Some(5)),
        "the shape is read off the bytes rather than off the request"
    );

    let sent = recorded.body(0);
    assert_eq!(
        sent["generationConfig"]["responseModalities"],
        json!(["TEXT", "IMAGE"]),
        "words alone are the default, so a picture has to be asked for"
    );
    assert_eq!(
        sent["generationConfig"]["imageConfig"]["aspectRatio"], "2:3",
        "a size describes a shape, which is what this protocol can be told"
    );
    assert_eq!(sent["generationConfig"]["candidateCount"], 2);
    // A reference travels inside the request: there is no upload here to point
    // at, and no field of its own for one.
    assert_eq!(
        sent["contents"][0]["parts"][1]["inlineData"]["mimeType"],
        "image/png"
    );
    assert_eq!(
        sent["contents"][0]["parts"][1]["inlineData"]["data"],
        base64(&png(4, 3))
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_streamed_gemini_answer_is_asked_for_as_events_and_aggregated() {
    let recorded = Recorded::default();
    let answering = recorded.clone();
    let base_url = serve(Router::new().route(
        "/v1beta/models/gemini-2.5-flash:streamGenerateContent",
        post(
            move |RawQuery(query): RawQuery, headers: HeaderMap, body: Bytes| {
                let recorded = answering.clone();
                async move {
                    recorded.note("stream", &headers, query);
                    recorded.note_body(&body);
                    // Each piece is a whole answer document carrying only what
                    // was written since the last one, and the stream simply
                    // stops: there is no closing word to wait for.
                    stream(&[
                        r#"{"candidates":[{"content":{"parts":[{"text":"A "}]}}]}"#,
                        r#"{"candidates":[{"content":{"parts":[{"text":"lantern."}]}}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":2}}"#,
                    ])
                }
            },
        ),
    ))
    .await;

    let call = gemini_channel(&base_url, "gemini-2.5-flash", Capability::Text);
    let request = generation(
        Capability::Text,
        "describe a lantern",
        json!({ "stream": true }),
    );
    let (sink, seen) = watching();
    let result = scripted()
        .await
        .generate_stream(&call, &request, &[], &sink, &Cancel::new())
        .await
        .expect("the stream is read to its end");

    assert_eq!(shown(&seen), "A lantern.", "every piece reached the caller");
    assert_eq!(result.text.as_deref(), Some("A lantern."));
    assert_eq!(
        result.usage.and_then(|usage| usage.output_tokens),
        Some(2),
        "the totals arrived with the last piece"
    );
    assert_eq!(
        recorded.headers().query.as_deref(),
        Some("alt=sse"),
        "a stream is asked for in the query rather than in the body"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_prompt_a_gemini_model_blocked_is_explained_rather_than_reported_as_empty() {
    let base_url = serve(Router::new().route(
        "/v1beta/models/gemini-2.5-flash:generateContent",
        post(|| async {
            // A refusal can arrive as a success, so reading only the status
            // would report an answer that said nothing.
            Json(json!({ "promptFeedback": { "blockReason": "SAFETY" } }))
        }),
    ))
    .await;

    let call = gemini_channel(&base_url, "gemini-2.5-flash", Capability::Text);
    let error = scripted()
        .await
        .generate(
            &call,
            &generation(Capability::Text, "something refused", json!({})),
            &[],
            &Cancel::new(),
        )
        .await
        .expect_err("the prompt was blocked");

    assert_eq!(error.code(), "PROVIDER_BAD_REQUEST");
    assert!(error.to_string().contains("SAFETY"), "{error}");
    assert!(!error.retryable(), "{error} would be refused again");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_gemini_size_is_asked_as_the_shape_it_describes() {
    let recorded = Recorded::default();
    let answering = recorded.clone();
    let base_url = serve(Router::new().route(
        "/v1beta/models/an-image-model:generateContent",
        post(move |body: Bytes| {
            let recorded = answering.clone();
            async move {
                recorded.note_body(&body);
                Json(json!({ "candidates": [{ "content": { "parts": [{ "text": "done" }] } }] }))
            }
        }),
    ))
    .await;

    let call = gemini_channel(&base_url, "an-image-model", Capability::Image);
    let asked = |params: Value| {
        let call = call.clone();
        async move {
            scripted()
                .await
                .generate(
                    &call,
                    &generation(Capability::Image, "a cat", params),
                    &[],
                    &Cancel::new(),
                )
                .await
                .expect("the answer arrives");
        }
    };

    // A shape already stated as one is the answer: reducing it again would turn
    // a shape a provider lists into one it does not.
    asked(json!({ "size": "16:9" })).await;
    // A size this protocol has no shape for is left out rather than sent as
    // something it would have to refuse.
    asked(json!({ "size": "auto" })).await;
    asked(json!({ "size": "1024x1536" })).await;
    // One picture is what a request means unless it says otherwise.
    asked(json!({ "size": "16:9", "count": 1 })).await;
    asked(json!({ "size": "16:9", "count": 3 })).await;

    let stated = recorded.body(0);
    assert_eq!(
        stated["generationConfig"]["imageConfig"]["aspectRatio"],
        "16:9"
    );
    let shapeless = recorded.body(1);
    assert!(
        shapeless["generationConfig"].get("imageConfig").is_none(),
        "{shapeless}"
    );
    let reduced = recorded.body(2);
    assert_eq!(
        reduced["generationConfig"]["imageConfig"]["aspectRatio"],
        "2:3"
    );
    let one = recorded.body(3);
    assert!(
        one["generationConfig"].get("candidateCount").is_none(),
        "{one}"
    );
    let several = recorded.body(4);
    assert_eq!(several["generationConfig"]["candidateCount"], 3);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_gemini_answer_with_no_totals_reports_no_usage() {
    let base_url = serve(Router::new().route(
        "/v1beta/models/gemini-2.5-flash:generateContent",
        post(|| async {
            // An all-empty totals document would still show up in the interface
            // as a row of zeroes, which reads as a measurement rather than as an
            // absence.
            Json(json!({
                "candidates": [{ "content": { "parts": [{ "text": "A lantern." }] } }],
                "usageMetadata": {},
            }))
        }),
    ))
    .await;

    let call = gemini_channel(&base_url, "gemini-2.5-flash", Capability::Text);
    let result = scripted()
        .await
        .generate(
            &call,
            &generation(Capability::Text, "describe a lantern", json!({})),
            &[],
            &Cancel::new(),
        )
        .await
        .expect("the answer arrives");

    assert_eq!(result.text.as_deref(), Some("A lantern."));
    assert_eq!(result.usage, None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gemini_media_that_is_not_base64_is_refused_rather_than_stored_empty() {
    let base_url = serve(Router::new().route(
        "/v1beta/models/an-image-model:generateContent",
        post(|| async {
            Json(json!({
                "candidates": [{ "content": { "parts": [
                    { "inlineData": { "mimeType": "image/png", "data": "not base64 at all" } },
                ] } }],
            }))
        }),
    ))
    .await;

    let call = gemini_channel(&base_url, "an-image-model", Capability::Image);
    let error = scripted()
        .await
        .generate(
            &call,
            &generation(Capability::Image, "a cat", json!({})),
            &[],
            &Cancel::new(),
        )
        .await
        .expect_err("the bytes are not media");

    assert_eq!(error.code(), "PROVIDER_BAD_REQUEST");
    assert!(!error.retryable(), "{error} will not improve on a retry");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gemini_speech_is_read_as_the_container_it_is_rather_than_as_the_name_it_came_with() {
    // The shortest bytes that are a wave file as far as the sniffer is
    // concerned: its own header, and nothing to play.
    let spoken = b"RIFF\x24\x00\x00\x00WAVEfmt ".to_vec();
    let encoded = base64(&spoken);
    let base_url = serve(Router::new().route(
        "/v1beta/models/a-voice:generateContent",
        post(move || {
            let encoded = encoded.clone();
            async move {
                Json(json!({
                    "candidates": [{ "content": { "parts": [
                        { "inlineData": { "mimeType": "audio/L16;codec=pcm", "data": encoded } },
                    ] } }],
                }))
            }
        }),
    ))
    .await;

    let call = gemini_channel(&base_url, "a-voice", Capability::Speech);
    let result = scripted()
        .await
        .generate(
            &call,
            &generation(Capability::Speech, "read this", json!({})),
            &[],
            &Cancel::new(),
        )
        .await
        .expect("the answer arrives");

    // The name a provider gives a container is not always one a file can be
    // stored under, so the bytes decide.
    assert_eq!(result.items.len(), 1);
    assert_eq!(result.items[0].mime, "audio/x-wav");
    assert_eq!(result.items[0].kind, Capability::Speech);
}

/// A provider that starts a job, answers one look with work still to do, and
/// the next with the addresses the finished shot was left at.
async fn gemini_video_provider(recorded: Recorded) -> String {
    let started = recorded.clone();
    let polled = recorded.clone();
    let collected = recorded.clone();
    serve(
        Router::new()
            .route(
                "/v1beta/models/a-video-model:predictLongRunning",
                post(move |headers: HeaderMap, body: Bytes| {
                    let recorded = started.clone();
                    async move {
                        recorded.note("predict", &headers, None);
                        recorded.note_body(&body);
                        Json(json!({
                            "name": "models/a-video-model/operations/job-1",
                            "done": false,
                        }))
                    }
                }),
            )
            .route(
                "/v1beta/models/a-video-model/operations/job-1",
                get(move |headers: HeaderMap| {
                    let recorded = polled.clone();
                    async move {
                        recorded.note("operation", &headers, None);
                        if recorded.next_poll() == 0 {
                            return Json(json!({ "done": false, "progressPercent": 40 }));
                        }
                        // A finished job names where to collect from, and it
                        // can only name this provider by the address it was
                        // reached on.
                        let host = reached_on(&headers);
                        Json(json!({
                            "done": true,
                            "response": { "generateVideoResponse": { "generatedSamples": [
                                { "video": {
                                    "uri": format!("http://{host}/v1beta/files/shot:download"),
                                } },
                                // A sample with nothing to collect is passed over
                                // rather than collected from nowhere.
                                { "video": {} },
                            ] } },
                        }))
                    }
                }),
            )
            .route(
                "/v1beta/files/shot:download",
                get(move |headers: HeaderMap| {
                    let recorded = collected.clone();
                    async move {
                        recorded.note("download", &headers, None);
                        Response::builder()
                            .header(axum::http::header::CONTENT_TYPE, "video/mp4")
                            .body(Body::from(b"mp4-bytes".to_vec()))
                            .expect("a response builds")
                    }
                }),
            ),
    )
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_gemini_video_job_is_started_polled_and_collected() {
    let recorded = Recorded::default();
    let base_url = gemini_video_provider(recorded.clone()).await;
    let call = gemini_channel(&base_url, "a-video-model", Capability::Video);
    let cancel = Cancel::new();

    // A shot does not answer in one call: waiting one out would hold a
    // connection open for minutes, so it is started as a job instead.
    let request = generation(
        Capability::Video,
        "a slow pan",
        json!({ "seconds": 6, "ratio": "16:9" }),
    );
    let refused = scripted()
        .await
        .generate(&call, &request, &[], &cancel)
        .await
        .expect_err("a shot is a job rather than an answer");
    assert_eq!(refused.code(), "VALIDATION_FAILED");

    let inputs = [
        reference("opening", InputRole::FirstFrame),
        // How an act is filmed: the ends the ports labelled are the frames the
        // shot lands on, and a board between them rides as a reference.
        reference("middle", InputRole::Reference),
        reference("closing", InputRole::LastFrame),
    ];
    let task = scripted()
        .await
        .create_task(&call, &request, &inputs, &cancel)
        .await
        .expect("the job starts");

    assert!(!task.id.is_empty());
    assert_ne!(
        task.id, task.reference,
        "the handle a client polls with is ours"
    );
    assert_eq!(task.reference, "models/a-video-model/operations/job-1");
    assert_eq!(task.protocol, Protocol::new("geminiVideo"));
    assert_eq!(task.capability, Capability::Video);
    assert_eq!(task.model, "a-video-model");

    let sent = recorded.body(0);
    assert_eq!(sent["instances"][0]["prompt"], "a slow pan");
    assert!(
        sent["instances"][0]["image"]["bytesBase64Encoded"].is_string(),
        "the opening frame was named: {sent}"
    );
    assert!(
        sent["instances"][0]["lastFrame"]["bytesBase64Encoded"].is_string(),
        "and so was the closing one: {sent}"
    );
    assert_eq!(
        sent["instances"][0]["referenceImages"]
            .as_array()
            .map(Vec::len),
        Some(1),
        "the board between the ends rode as a reference: {sent}"
    );
    assert_eq!(
        sent["instances"][0]["referenceImages"][0]["referenceType"],
        "ASSET"
    );
    assert_eq!(sent["parameters"]["durationSeconds"], 6);
    assert_eq!(sent["parameters"]["aspectRatio"], "16:9");
    assert!(sent.get("model").is_none(), "{sent}");

    match scripted().await.poll_task(&call, &task, &cancel).await {
        Ok(TaskState::Pending { retry_after_ms }) => {
            assert!(retry_after_ms > 0, "another look is worth waiting for")
        }
        other => panic!("expected a job still running, got {other:?}"),
    }
    match scripted()
        .await
        .poll_task(&call, &task, &cancel)
        .await
        .expect("the job is collected")
    {
        TaskState::Succeeded(result) => {
            assert_eq!(result.items.len(), 1);
            assert_eq!(result.items[0].mime, "video/mp4");
            assert_eq!(result.items[0].kind, Capability::Video);
            assert_eq!(result.items[0].bytes, b"mp4-bytes");
        }
        other => panic!("expected the finished shot, got {other:?}"),
    }

    assert_eq!(
        recorded.asked(),
        ["predict", "operation", "operation", "download"]
    );
    // The shot was left on the channel's own host, which will only answer a
    // request for it when the credential came along.
    assert_eq!(recorded.headers().api_key.as_deref(), Some(API_KEY));
}

// ---------------------------------------------------------------- bailian

/// The adapter both Bailian shapes run through, which is the converter host:
/// each of them is a script now.
/// One choice of an answer, as this service spells it: the words of the answer
/// under `content`, which is sometimes a string and sometimes a document.
fn bailian_answer(content: Value) -> Value {
    json!({
        "output": { "choices": [{ "finish_reason": "stop", "message": {
            "role": "assistant",
            "content": content,
        } }] },
        "usage": { "input_tokens": 5, "output_tokens": 4 },
        "request_id": "0a1b2c",
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_bailian_question_of_words_is_asked_at_the_address_it_names() {
    let recorded = Recorded::default();
    let answering = recorded.clone();
    let base_url = serve(Router::new().route(
        "/api/v1/services/aigc/text-generation/generation",
        post(move |headers: HeaderMap, body: Bytes| {
            let recorded = answering.clone();
            async move {
                recorded.note("text-generation", &headers, None);
                recorded.note_body(&body);
                Json(bailian_answer(json!("A lantern drifts.")))
            }
        }),
    ))
    .await;

    let call = bailian_channel(&base_url, "qwen3-max", Capability::Text);
    let mut request = generation(Capability::Text, "describe a lantern", json!({}));
    request.system = Some("Answer in one sentence.".into());
    let result = scripted()
        .await
        .generate(&call, &request, &[], &Cancel::new())
        .await
        .expect("the answer arrives");

    assert_eq!(result.text.as_deref(), Some("A lantern drifts."));
    assert_eq!(result.usage.and_then(|usage| usage.output_tokens), Some(4));
    assert_eq!(
        recorded.headers().authorization.as_deref(),
        Some(&format!("Bearer {API_KEY}")[..]),
        "the credential travels the way this platform reads it"
    );
    assert_eq!(
        recorded.asked(),
        ["text-generation"],
        "a question of words alone is asked nowhere else"
    );
    assert_eq!(
        recorded.body(0),
        json!({
            "model": "qwen3-max",
            "input": { "messages": [
                { "role": "system", "content": "Answer in one sentence." },
                { "role": "user", "content": "describe a lantern" },
            ] },
            "parameters": { "result_format": "message" },
        })
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_bailian_question_with_a_picture_moves_to_the_multimodal_service() {
    let recorded = Recorded::default();
    let answering = recorded.clone();
    let base_url = serve(
        Router::new()
            .route(
                "/api/v1/services/aigc/text-generation/generation",
                post(not_for_a_question_with_a_picture),
            )
            .route(
                "/api/v1/services/aigc/multimodal-generation/generation",
                post(move |headers: HeaderMap, body: Bytes| {
                    let recorded = answering.clone();
                    async move {
                        recorded.note("multimodal-generation", &headers, None);
                        recorded.note_body(&body);
                        Json(bailian_answer(json!([{ "text": "A lighthouse at dusk." }])))
                    }
                }),
            ),
    )
    .await;

    let call = bailian_channel(&base_url, "qwen3-vl-plus", Capability::Text);
    let request = generation(Capability::Text, "what is in this picture", json!({}));
    let photo = reference("photo", InputRole::Reference);
    let result = scripted()
        .await
        .generate(&call, &request, &[photo], &Cancel::new())
        .await
        .expect("the answer arrives");

    assert_eq!(result.text.as_deref(), Some("A lighthouse at dusk."));
    assert_eq!(
        recorded.asked(),
        ["multimodal-generation"],
        "the picture's question belongs at the sibling service"
    );
    assert_eq!(
        recorded.body(0),
        json!({
            "model": "qwen3-vl-plus",
            "input": { "messages": [{ "role": "user", "content": [
                { "text": "what is in this picture" },
                { "image": format!("data:image/png;base64,{}", base64(&png(4, 3))) },
            ] }] },
            "parameters": { "result_format": "message" },
        })
    );
}

/// An endpoint a test routes only to find out whether it was asked.
async fn not_for_a_question_with_a_picture() -> Response {
    panic!("a question carrying a picture must not be asked at the text endpoint")
}

/// The complaint the platform answers a model asked at the service it does not
/// answer at, in its own words.
fn bailian_wrong_address() -> Value {
    json!({
        "code": "InvalidParameter",
        "message": "url error, please check url！ For details, see: https://www.alibabacloud.com/help/en/model-studio/error-code#error-url",
        "request_id": "0a1b2c",
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_bailian_model_that_answers_elsewhere_is_asked_where_it_answers() {
    // This platform serves its multimodal models — qwen3.8-flash among them —
    // only at the multimodal service, and answers one asked at the text service
    // with this complaint. The question is not the problem; the door is.
    let recorded = Recorded::default();
    let refusing = recorded.clone();
    let answering = recorded.clone();
    let base_url = serve(
        Router::new()
            .route(
                "/api/v1/services/aigc/text-generation/generation",
                post(move |headers: HeaderMap, body: Bytes| {
                    let recorded = refusing.clone();
                    async move {
                        recorded.note("text-generation", &headers, None);
                        recorded.note_body(&body);
                        refuse(StatusCode::BAD_REQUEST, bailian_wrong_address()).await
                    }
                }),
            )
            .route(
                "/api/v1/services/aigc/multimodal-generation/generation",
                post(move |headers: HeaderMap, body: Bytes| {
                    let recorded = answering.clone();
                    async move {
                        recorded.note("multimodal-generation", &headers, None);
                        recorded.note_body(&body);
                        Json(bailian_answer(json!([{ "text": "A lantern drifts." }])))
                    }
                }),
            ),
    )
    .await;

    let call = bailian_text_at(&base_url, "qwen3.8-flash", "text-generation");
    let result = scripted()
        .await
        .generate(
            &call,
            &generation(Capability::Text, "describe a lantern", json!({})),
            &[],
            &Cancel::new(),
        )
        .await
        .expect("the answer arrives from the service the model answers at");

    assert_eq!(result.text.as_deref(), Some("A lantern drifts."));
    assert_eq!(
        recorded.asked(),
        ["text-generation", "multimodal-generation"],
        "the question is moved rather than given up on"
    );
    // The service it was moved to reads a message as parts, so the words travel
    // as one part rather than as a string.
    assert_eq!(
        recorded.body(1),
        json!({
            "model": "qwen3.8-flash",
            "input": { "messages": [{ "role": "user", "content": [{ "text": "describe a lantern" }] }] },
            "parameters": { "result_format": "message" },
        })
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_bailian_stream_moves_to_the_service_the_model_answers_at() {
    let recorded = Recorded::default();
    let refusing = recorded.clone();
    let answering = recorded.clone();
    let base_url = serve(
        Router::new()
            .route(
                "/api/v1/services/aigc/text-generation/generation",
                post(move |headers: HeaderMap, body: Bytes| {
                    let recorded = refusing.clone();
                    async move {
                        recorded.note("text-generation", &headers, None);
                        recorded.note_body(&body);
                        refuse(StatusCode::BAD_REQUEST, bailian_wrong_address()).await
                    }
                }),
            )
            .route(
                "/api/v1/services/aigc/multimodal-generation/generation",
                post(move |headers: HeaderMap, body: Bytes| {
                    let recorded = answering.clone();
                    async move {
                        recorded.note("multimodal-generation", &headers, None);
                        recorded.note_body(&body);
                        stream(&[
                            r#"{"output":{"choices":[{"finish_reason":null,"message":{"content":[{"text":"A "}]}}]}}"#,
                            r#"{"output":{"choices":[{"finish_reason":"stop","message":{"content":[{"text":"lantern."}]}}]}}"#,
                        ])
                    }
                }),
            ),
    )
    .await;

    let call = bailian_text_at(&base_url, "qwen3.8-flash", "text-generation");
    let request = generation(
        Capability::Text,
        "describe a lantern",
        json!({ "stream": true }),
    );
    let (sink, seen) = watching();
    let result = scripted()
        .await
        .generate_stream(&call, &request, &[], &sink, &Cancel::new())
        .await
        .expect("the stream the model answers with is read");

    assert_eq!(result.text.as_deref(), Some("A lantern."));
    assert_eq!(shown(&seen), "A lantern.");
    assert_eq!(
        recorded.asked(),
        ["text-generation", "multimodal-generation"]
    );
    // The door the question was moved to is asked for a stream as well, which
    // this service reads as a header rather than as a body field.
    assert_eq!(recorded.sse(), Some("enable".to_string()));
    assert_eq!(
        recorded.body(1).pointer("/parameters/incremental_output"),
        Some(&json!(true))
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_bailian_question_asked_at_the_wrong_service_is_moved_to_the_other_one() {
    // A configuration pointed at the multimodal service with a model that only
    // answers at the text service: the complaint names the address, and a
    // question of words alone moves back.
    let recorded = Recorded::default();
    let refusing = recorded.clone();
    let answering = recorded.clone();
    let base_url = serve(
        Router::new()
            .route(
                "/api/v1/services/aigc/multimodal-generation/generation",
                post(move |headers: HeaderMap, body: Bytes| {
                    let recorded = refusing.clone();
                    async move {
                        recorded.note("multimodal-generation", &headers, None);
                        recorded.note_body(&body);
                        refuse(StatusCode::BAD_REQUEST, bailian_wrong_address()).await
                    }
                }),
            )
            .route(
                "/api/v1/services/aigc/text-generation/generation",
                post(move |headers: HeaderMap, body: Bytes| {
                    let recorded = answering.clone();
                    async move {
                        recorded.note("text-generation", &headers, None);
                        recorded.note_body(&body);
                        Json(bailian_answer(json!("A lantern drifts.")))
                    }
                }),
            ),
    )
    .await;

    let call = bailian_text_at(&base_url, "qwen3-max", "multimodal-generation");
    let result = scripted()
        .await
        .generate(
            &call,
            &generation(Capability::Text, "describe a lantern", json!({})),
            &[],
            &Cancel::new(),
        )
        .await
        .expect("the answer arrives from the text service");

    assert_eq!(result.text.as_deref(), Some("A lantern drifts."));
    assert_eq!(
        recorded.asked(),
        ["multimodal-generation", "text-generation"]
    );
    assert_eq!(
        recorded.body(1),
        json!({
            "model": "qwen3-max",
            "input": { "messages": [{ "role": "user", "content": "describe a lantern" }] },
            "parameters": { "result_format": "message" },
        })
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_bailian_answer_arrives_in_pieces_when_a_stream_was_asked_for() {
    let recorded = Recorded::default();
    let answering = recorded.clone();
    let base_url = serve(Router::new().route(
        "/api/v1/services/aigc/text-generation/generation",
        post(move |headers: HeaderMap, body: Bytes| {
            let recorded = answering.clone();
            async move {
                recorded.note("text-generation", &headers, None);
                recorded.note_body(&body);
                stream(&[
                    r#"{"output":{"choices":[{"finish_reason":null,"message":{"content":"A "}}]}}"#,
                    r#"{"output":{"choices":[{"finish_reason":null,"message":{"content":"lantern."}}]}}"#,
                    r#"{"output":{"choices":[{"finish_reason":"stop","message":{"content":""}}]},"usage":{"input_tokens":4,"output_tokens":2}}"#,
                ])
            }
        }),
    ))
    .await;

    let call = bailian_channel(&base_url, "qwen3-max", Capability::Text);
    let request = generation(
        Capability::Text,
        "describe a lantern",
        json!({ "stream": true }),
    );
    let (sink, seen) = watching();
    let result = scripted()
        .await
        .generate_stream(&call, &request, &[], &sink, &Cancel::new())
        .await
        .expect("the stream is read to its end");

    assert_eq!(result.text.as_deref(), Some("A lantern."));
    assert_eq!(shown(&seen), "A lantern.");
    assert_eq!(result.usage.and_then(|usage| usage.output_tokens), Some(2));
    // A stream is asked for in a header here rather than in the body, and the
    // pieces are asked for as pieces rather than as the whole answer again.
    assert_eq!(recorded.sse(), Some("enable".to_string()));
    assert_eq!(
        recorded.body(0).pointer("/parameters/incremental_output"),
        Some(&json!(true))
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_bailian_stream_that_complains_midway_is_refused_rather_than_truncated() {
    let recorded = Recorded::default();
    let answering = recorded.clone();
    let base_url = serve(Router::new().route(
        "/api/v1/services/aigc/text-generation/generation",
        post(move |headers: HeaderMap| {
            let recorded = answering.clone();
            async move {
                recorded.note("text-generation", &headers, None);
                stream(&[
                    r#"{"output":{"choices":[{"finish_reason":null,"message":{"content":"A "}}]}}"#,
                    r#"{"code":"Throttling","message":"the service is busy","request_id":"0a1b2c"}"#,
                ])
            }
        }),
    ))
    .await;

    let call = bailian_channel(&base_url, "qwen3-max", Capability::Text);
    let request = generation(
        Capability::Text,
        "describe a lantern",
        json!({ "stream": true }),
    );
    let (sink, seen) = watching();
    let error = scripted()
        .await
        .generate_stream(&call, &request, &[], &sink, &Cancel::new())
        .await
        .expect_err("the service failed halfway through the answer");

    assert_eq!(error.code(), "PROVIDER_BAD_REQUEST");
    assert!(error.to_string().contains("the service is busy"), "{error}");
    assert_eq!(
        shown(&seen),
        "A ",
        "what arrived before the complaint is not taken back"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_bailian_failure_is_reported_in_the_services_own_words() {
    let recorded = Recorded::default();
    let refusing = recorded.clone();
    let base_url = serve(Router::new().route(
        "/api/v1/services/aigc/text-generation/generation",
        post(move |headers: HeaderMap| {
            let recorded = refusing.clone();
            async move {
                recorded.note("text-generation", &headers, None);
                refuse(
                    StatusCode::BAD_REQUEST,
                    json!({
                        "code": "InvalidParameter",
                        "message": "the temperature must be below 2",
                        "request_id": "0a1b2c",
                    }),
                )
                .await
            }
        }),
    ))
    .await;

    let call = bailian_channel(&base_url, "qwen3-max", Capability::Text);
    let error = scripted()
        .await
        .generate(
            &call,
            &generation(
                Capability::Text,
                "describe a lantern",
                json!({ "temperature": 3 }),
            ),
            &[],
            &Cancel::new(),
        )
        .await
        .expect_err("the service refused the setting");

    assert_eq!(error.code(), "PROVIDER_BAD_REQUEST");
    assert!(
        error
            .to_string()
            .contains("the temperature must be below 2"),
        "{error}"
    );
    assert!(!error.retryable(), "{error} would be refused again");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_bailian_picture_is_asked_for_and_fetched_from_where_it_was_left() {
    let picture = png(6, 5);
    let elsewhere = Recorded::default();
    let serving = elsewhere.clone();
    let stored = picture.clone();
    let elsewhere_url = serve(Router::new().route(
        "/made/lantern.png",
        get(move |headers: HeaderMap| {
            let recorded = serving.clone();
            let stored = stored.clone();
            async move {
                recorded.note("drawing", &headers, None);
                ([(axum::http::header::CONTENT_TYPE, "image/png")], stored)
            }
        }),
    ))
    .await;

    let recorded = Recorded::default();
    let answering = recorded.clone();
    let base_url = serve(Router::new().route(
        "/api/v1/services/aigc/multimodal-generation/generation",
        post(move |headers: HeaderMap, body: Bytes| {
            let recorded = answering.clone();
            let address = format!("{elsewhere_url}/made/lantern.png");
            async move {
                recorded.note("draw", &headers, None);
                recorded.note_body(&body);
                Json(json!({
                    "output": { "choices": [{ "finish_reason": "stop", "message": {
                        "role": "assistant",
                        "content": [{ "image": address, "type": "image" }],
                    } }] },
                    "usage": { "image_count": 1, "input_tokens": 12, "output_tokens": 2 },
                    "request_id": "0a1b2c",
                }))
            }
        }),
    ))
    .await;

    let call = bailian_channel(&base_url, "wan2.7-image-pro", Capability::Image);
    let photo = reference("photo", InputRole::Reference);
    let request = generation(
        Capability::Image,
        "make it snow",
        json!({ "size": "1:1", "count": 1 }),
    );
    let result = scripted()
        .await
        .generate(&call, &request, &[photo], &Cancel::new())
        .await
        .expect("the drawing arrives");

    assert_eq!(result.items.len(), 1);
    assert_eq!(result.items[0].bytes, picture);
    assert_eq!(result.items[0].mime, "image/png", "sniffed, not assumed");
    assert_eq!(
        (result.items[0].width, result.items[0].height),
        (Some(6), Some(5))
    );
    assert_eq!(result.usage.and_then(|usage| usage.images), Some(1));
    assert_eq!(
        recorded.body(0),
        json!({
            "model": "wan2.7-image-pro",
            "input": { "messages": [{ "role": "user", "content": [
                { "image": format!("data:image/png;base64,{}", base64(&png(4, 3))) },
                { "text": "make it snow" },
            ] }] },
            "parameters": { "size": "1024*1024", "n": 1 },
        })
    );
    assert!(
        elsewhere.headers().authorization.is_none(),
        "a credential never follows an answer to a host that did not produce it"
    );
    assert_eq!(recorded.asked(), ["draw"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_bailian_shape_is_sent_as_the_pixels_that_describe_it() {
    let recorded = Recorded::default();
    let answering = recorded.clone();
    let base_url = serve(Router::new().route(
        "/api/v1/services/aigc/multimodal-generation/generation",
        post(move |headers: HeaderMap, body: Bytes| {
            let recorded = answering.clone();
            async move {
                recorded.note("draw", &headers, None);
                recorded.note_body(&body);
                // A drawing carried in the answer itself, so a case that only
                // cares about the shape asked for has nothing to fetch.
                Json(bailian_answer(json!([{
                    "image": format!("data:image/png;base64,{}", base64(&png(4, 3))),
                    "type": "image",
                }])))
            }
        }),
    ))
    .await;

    let call = bailian_channel(&base_url, "wan2.7-image-pro", Capability::Image);
    for (asked, (shape, told)) in [
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
    ]
    .into_iter()
    .enumerate()
    {
        let request = generation(Capability::Image, "a lighthouse", json!({ "size": shape }));
        scripted()
            .await
            .generate(&call, &request, &[], &Cancel::new())
            .await
            .expect("the drawing arrives");
        assert_eq!(
            recorded
                .body(asked)
                .pointer("/parameters/size")
                .and_then(Value::as_str),
            told,
            "asked for {shape}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_bailian_refusal_that_arrived_as_a_success_is_an_error_rather_than_silence() {
    let recorded = Recorded::default();
    let answering = recorded.clone();
    let base_url = serve(Router::new().route(
        "/api/v1/services/aigc/text-generation/generation",
        post(move |headers: HeaderMap| {
            let recorded = answering.clone();
            async move {
                recorded.note("text-generation", &headers, None);
                // A success carrying the complaint instead of a generation,
                // which reading as an empty answer would blame on a quiet model.
                Json(json!({
                    "code": "DataInspectionFailed",
                    "message": "the question was filtered",
                    "request_id": "0a1b2c",
                }))
            }
        }),
    ))
    .await;

    let call = bailian_channel(&base_url, "qwen3-max", Capability::Text);
    let error = scripted()
        .await
        .generate(
            &call,
            &generation(Capability::Text, "a lighthouse", json!({})),
            &[],
            &Cancel::new(),
        )
        .await
        .expect_err("the question was refused");

    assert_eq!(error.code(), "PROVIDER_BAD_REQUEST");
    assert!(
        error.to_string().contains("the question was filtered"),
        "{error}"
    );
    assert!(!error.retryable(), "{error} will not improve on a retry");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_bailian_answer_without_a_message_is_read_from_its_bare_text() {
    let recorded = Recorded::default();
    let answering = recorded.clone();
    let base_url = serve(Router::new().route(
        "/api/v1/services/aigc/text-generation/generation",
        post(move |headers: HeaderMap| {
            let recorded = answering.clone();
            async move {
                recorded.note("text-generation", &headers, None);
                // The older `result_format`, where the answer is a bare string
                // rather than a message.
                Json(json!({ "output": { "text": "a lighthouse at dusk" } }))
            }
        }),
    ))
    .await;

    let call = bailian_channel(&base_url, "qwen3-max", Capability::Text);
    let result = scripted()
        .await
        .generate(
            &call,
            &generation(Capability::Text, "a lighthouse", json!({})),
            &[],
            &Cancel::new(),
        )
        .await
        .expect("the answer arrives");

    assert_eq!(result.text.as_deref(), Some("a lighthouse at dusk"));
    assert_eq!(
        result.usage, None,
        "totals nobody reported are not invented"
    );
}
