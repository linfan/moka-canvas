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
use moka_canvas::domain::Capability;
use moka_canvas::generate::adapters::{for_protocol, list_models, ChannelCall, ProviderAdapter};
use moka_canvas::generate::media::MediaInput;
use moka_canvas::generate::providers::ResolvedModel;
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

/// Starts a throwaway provider and returns the address a channel would be
/// configured with.
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

/// A channel resolved to one model on a throwaway provider.
fn channel(base_url: &str, model_id: &str, capability: Capability) -> ChannelCall {
    let resolved = ResolvedModel {
        reference: format!("channel-1::{model_id}"),
        channel_id: "channel-1".into(),
        model_id: model_id.into(),
        capability,
        protocol: Protocol::Openai,
        base_url: base_url.to_string(),
    };
    ChannelCall::new(&resolved, API_KEY.to_string(), GenerateConfig::default())
        .expect("a client builds")
}

fn adapter() -> &'static dyn ProviderAdapter {
    for_protocol(Protocol::Openai).expect("an adapter speaks this protocol")
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

// ---------------------------------------------------------------- listing

async fn openai_models(
    recorded: Recorded,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
) -> Json<Value> {
    recorded.note("models", &headers, query);
    // A blank and a missing identifier stand for the placeholders a gateway
    // sometimes lists; neither may reach the caller.
    Json(json!({
        "object": "list",
        "data": [
            { "id": "gpt-image-2", "object": "model" },
            { "id": "gpt-5.5" },
            { "id": "   " },
            { "object": "model" }
        ]
    }))
}

async fn gemini_models(
    recorded: Recorded,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
) -> Json<Value> {
    recorded.note("models", &headers, query);
    Json(json!({
        "models": [
            { "name": "models/gemini-2.5-flash" },
            { "name": "imagen-4" },
            { "name": "models/" }
        ]
    }))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_openai_compatible_channel_lists_its_models() {
    let recorded = Recorded::default();
    let listing = recorded.clone();
    let base_url = serve(Router::new().route(
        "/v1/models",
        get(move |query: RawQuery, headers: HeaderMap| {
            let recorded = listing.clone();
            async move { openai_models(recorded, query, headers).await }
        }),
    ))
    .await;

    let models = list_models(Protocol::Openai, &base_url, API_KEY)
        .await
        .expect("the list arrives");

    assert_eq!(models, ["gpt-5.5", "gpt-image-2"], "sorted, without blanks");
    let headers = recorded.headers();
    assert_eq!(
        headers.authorization.as_deref(),
        Some(&format!("Bearer {API_KEY}")[..])
    );
    assert_eq!(headers.query, None, "the credential never travels in a URL");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_base_url_that_already_carries_the_version_is_not_extended() {
    let recorded = Recorded::default();
    let listing = recorded.clone();
    let address = serve(Router::new().route(
        "/v1/models",
        get(move |query: RawQuery, headers: HeaderMap| {
            let recorded = listing.clone();
            async move { openai_models(recorded, query, headers).await }
        }),
    ))
    .await;

    // Only /v1/models is routed, so appending a second version would answer
    // 404 and the assertion below would fail.
    let models = list_models(Protocol::Openai, &format!("{address}/v1"), API_KEY)
        .await
        .expect("the version segment is not added twice");
    assert!(!models.is_empty());

    let models = list_models(Protocol::Openai, &format!("{address}/v1/"), API_KEY)
        .await
        .expect("a trailing slash is not a second version either");
    assert!(!models.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_gemini_channel_sends_its_key_in_a_header() {
    let recorded = Recorded::default();
    let listing = recorded.clone();
    let base_url = serve(Router::new().route(
        "/v1beta/models",
        get(move |query: RawQuery, headers: HeaderMap| {
            let recorded = listing.clone();
            async move { gemini_models(recorded, query, headers).await }
        }),
    ))
    .await;

    let models = list_models(Protocol::Gemini, &base_url, API_KEY)
        .await
        .expect("the list arrives");

    assert_eq!(
        models,
        ["gemini-2.5-flash", "imagen-4"],
        "the qualification is stripped and empty names are dropped"
    );
    let headers = recorded.headers();
    assert_eq!(headers.api_key.as_deref(), Some(API_KEY));
    assert!(
        headers.authorization.is_none(),
        "the bearer scheme is not used"
    );
    assert_eq!(
        headers.query.as_deref(),
        Some("pageSize=1000"),
        "the key is not a query parameter, so it cannot reach a log line"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_rejected_credential_is_an_auth_failure_worth_fixing_not_retrying() {
    let base_url = serve(Router::new().route(
        "/v1/models",
        get(|| async {
            refuse(
                StatusCode::UNAUTHORIZED,
                json!({"error": {"message": "Incorrect API key provided", "type": "invalid_request_error"}}),
            )
            .await
        }),
    ))
    .await;

    let error = list_models(Protocol::Openai, &base_url, API_KEY)
        .await
        .expect_err("the provider refused the key");

    assert_eq!(error.code(), "PROVIDER_AUTH");
    assert!(!error.retryable(), "the same key will be refused again");
    assert!(
        error.to_string().contains("Incorrect API key provided"),
        "the provider's own explanation survives: {error}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_busy_provider_is_worth_waiting_for() {
    let base_url = serve(Router::new().route(
        "/v1/models",
        get(|| async {
            refuse(
                StatusCode::TOO_MANY_REQUESTS,
                json!({"error": {"message": "rate limit reached"}}),
            )
            .await
        }),
    ))
    .await;

    let error = list_models(Protocol::Openai, &base_url, API_KEY)
        .await
        .expect_err("the provider is busy");

    assert_eq!(error.code(), "PROVIDER_RATE_LIMIT");
    assert!(error.retryable());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_provider_that_echoes_the_key_back_does_not_leak_it() {
    let base_url = serve(Router::new().route(
        "/v1/models",
        get(|| async {
            refuse(
                StatusCode::BAD_REQUEST,
                json!({"error": {"message": format!("credential {API_KEY} is not recognised")}}),
            )
            .await
        }),
    ))
    .await;

    let error = list_models(Protocol::Openai, &base_url, API_KEY)
        .await
        .expect_err("the provider refused the request");

    assert_eq!(error.code(), "PROVIDER_BAD_REQUEST");
    assert!(!error.to_string().contains(API_KEY), "{error}");
    assert!(error.to_string().contains("sk-…abcd"), "{error}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_answer_that_is_not_a_model_list_says_so() {
    let base_url = serve(Router::new().route(
        "/v1/models",
        get(|| async { (StatusCode::OK, "<html>502 from the proxy</html>") }),
    ))
    .await;

    let error = list_models(Protocol::Openai, &base_url, API_KEY)
        .await
        .expect_err("a proxy answered instead of the provider");

    assert_eq!(error.code(), "PROVIDER_BAD_REQUEST");
    assert!(!error.retryable());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_address_nothing_answers_at_is_unreachable() {
    let address = {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("an ephemeral port is available");
        listener.local_addr().expect("the socket has an address")
    };

    // The listener is gone, so the port refuses the connection.
    let error = list_models(Protocol::Openai, &format!("http://{address}"), API_KEY)
        .await
        .expect_err("nothing is listening");

    assert_eq!(error.code(), "PROVIDER_UNAVAILABLE");
    assert!(error.retryable());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_protocol_with_no_implementation_says_so_rather_than_dialling() {
    let error = list_models(Protocol::Custom, "http://127.0.0.1:1", API_KEY)
        .await
        .expect_err("nothing speaks this protocol");
    assert_eq!(error.code(), "VALIDATION_FAILED");
    assert!(error.to_string().contains("reserved"), "{error}");
}

// ------------------------------------------------------------------- text

/// An answer that arrives in pieces, as the endpoint that produces it sends it.
fn stream(events: &[&str]) -> Response {
    let mut body = String::new();
    for event in events {
        body.push_str(&format!("data: {event}\n\n"));
    }
    body.push_str("data: [DONE]\n\n");
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
                ])
            }
        }),
    ))
    .await;

    let call = channel(&base_url, "gpt-5.5", Capability::Text);
    let request = generation(
        Capability::Text,
        "describe a lantern",
        json!({ "stream": true }),
    );
    let (sink, seen) = watching();

    let result = adapter()
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
async fn a_gateway_without_the_newer_text_endpoint_is_asked_on_the_older_one() {
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
                            StatusCode::NOT_FOUND,
                            json!({"error": {"message": "no such route"}}),
                        )
                        .await
                    }
                }),
            )
            .route(
                "/v1/chat/completions",
                post(move |headers: HeaderMap, body: Bytes| {
                    let recorded = answering.clone();
                    async move {
                        recorded.note("chat", &headers, None);
                        recorded.note_body(&body);
                        Json(json!({
                            "choices": [{ "message": { "content": "A lantern." } }],
                            "usage": { "prompt_tokens": 4, "completion_tokens": 2 },
                        }))
                    }
                }),
            ),
    )
    .await;

    let call = channel(&base_url, "gpt-5.5", Capability::Text);
    let request = generation(Capability::Text, "describe a lantern", json!({}));
    let result = adapter()
        .generate(&call, &request, &[], &Cancel::new())
        .await
        .expect("a listing gateway is not obliged to have every endpoint");

    assert_eq!(result.text.as_deref(), Some("A lantern."));
    assert_eq!(recorded.asked(), ["responses", "chat"], "asked in order");
    // The endpoint that refused recorded no body, so the one that remains was
    // sent to the fallback — and it speaks in messages, not in the newer
    // endpoint's fields. Without a system prompt of its own, the request has
    // exactly one of them.
    let sent = recorded.body(0);
    assert_eq!(sent["messages"].as_array().map(Vec::len), Some(1), "{sent}");
    assert_eq!(sent["messages"][0]["role"], "user");
    assert_eq!(sent["messages"][0]["content"], "describe a lantern");
    assert!(sent.get("input").is_none(), "{sent}");
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

    let call = channel(&base_url, "gpt-5.5", Capability::Text);
    let request = generation(Capability::Text, "describe a lantern", json!({}));
    let error = adapter()
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
async fn a_model_nobody_recognises_goes_straight_to_the_endpoint_everyone_has() {
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

    // Only the older endpoint is routed, so trying the newer one first would
    // have to fall back to reach this answer at all.
    let call = channel(&base_url, "llama-3.3", Capability::Text);
    let result = adapter()
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
    let result = adapter()
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
                        let host = headers
                            .get("host")
                            .and_then(|value| value.to_str().ok())
                            .expect("a request names the host it asked for")
                            .to_string();
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
    let result = adapter()
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
    let result = adapter()
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
    let result = adapter()
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

    let call = channel(&base_url, "a-voice", Capability::Audio);
    let request = generation(
        Capability::Audio,
        "read this aloud",
        json!({ "voice": "alloy", "format": "wav" }),
    );
    let result = adapter()
        .generate(&call, &request, &[], &Cancel::new())
        .await
        .expect("the audio arrives");

    assert_eq!(result.items.len(), 1);
    assert_eq!(result.items[0].mime, "audio/wav", "the answer said so");
    assert_eq!(result.items[0].kind, Capability::Audio);
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

    let call = channel(&base_url, "a-voice", Capability::Audio);
    let error = adapter()
        .generate(
            &call,
            &generation(Capability::Audio, "read this", json!({})),
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
    let task = adapter()
        .create_task(&call, &request, &inputs, &cancel)
        .await
        .expect("the job starts");

    // The handle a client polls with is ours: the provider's own identifier is
    // opaque and stays inside the task.
    assert!(!task.id.is_empty());
    assert_ne!(task.id, task.reference);
    assert_eq!(task.reference, "job-1");
    assert_eq!(task.protocol, Protocol::Openai);
    assert_eq!(task.capability, Capability::Video);
    assert_eq!(task.model, "channel-1::a-video-model");
    assert!(!task.created_at.is_empty());

    let sent = recorded.body(0);
    assert_eq!(sent["model"], "a-video-model");
    assert_eq!(sent["seconds"], 6);
    assert!(
        sent["first_frame"].is_string(),
        "the frames were named: {sent}"
    );
    assert!(sent["last_frame"].is_string(), "{sent}");

    match adapter().poll_task(&call, &task, &cancel).await {
        Ok(TaskState::Pending { retry_after_ms }) => {
            assert!(retry_after_ms > 0, "a poll is worth waiting for")
        }
        other => panic!("expected a job still running, got {other:?}"),
    }
    match adapter()
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
        protocol: Protocol::Openai,
        capability: Capability::Video,
        model: "channel-1::a-video-model".into(),
        created_at: "2026-01-01T00:00:00Z".into(),
    };

    let error = adapter()
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
        protocol: Protocol::Openai,
        capability: Capability::Video,
        model: "channel-1::a-video-model".into(),
        created_at: "2026-01-01T00:00:00Z".into(),
    };

    match adapter()
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
    let error = adapter()
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
    let error = adapter()
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
