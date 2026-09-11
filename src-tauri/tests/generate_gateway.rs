//! The gateway against a provider standing on localhost and a project on disk.
//!
//! The rules that need no provider — how parameters merge, which failures are
//! worth waiting out, how long to wait — are unit-tested beside the code. What
//! needs a real socket and a real store is the wiring: that a generation
//! reaches the channel it was resolved to, that a retry really asks again,
//! that a job handle really comes back, and that nothing is sent when the
//! configuration cannot place the call.

use std::future::Future;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::task::Poll;
use std::time::{Duration, Instant};

use axum::body::{Body, Bytes};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use moka_canvas::config::{parse_test_config, GenerateConfig, RuntimeMode};
use moka_canvas::domain::Capability;
use moka_canvas::generate::models::ModelRepo;
use moka_canvas::generate::{
    Cancel, DeltaSink, Gateway, GenerateInput, GenerateRequest, InputRole, TaskState,
};
use moka_canvas::metadata::crypto::MASTER_KEY_FILE;
use moka_canvas::metadata::{
    self, Defaults, ImagePreferences, MetadataStore, ModelDraft, Preferences, Protocol,
};
use moka_canvas::project::store::FsProjectStore;
use moka_canvas::project::{CreateProject, ProjectStore, StagedAsset};
use serde_json::{json, Value};
use tempfile::TempDir;
use tokio::io::ReadBuf;

/// Long enough that masking keeps a recognisable head and tail.
const API_KEY: &str = "sk-test-1234567890abcd";

/// What reached the throwaway provider, so a test can assert on the requests
/// as well as on the answers.
#[derive(Clone, Default)]
struct Watch {
    asked: Arc<AtomicUsize>,
    bodies: Arc<Mutex<Vec<Value>>>,
}

impl Watch {
    fn note(&self, body: Option<Bytes>) {
        self.asked.fetch_add(1, Ordering::SeqCst);
        let Some(body) = body else { return };
        if let Ok(value) = serde_json::from_slice::<Value>(&body) {
            self.bodies.lock().expect("not poisoned").push(value);
        }
    }

    fn times(&self) -> usize {
        self.asked.load(Ordering::SeqCst)
    }

    fn body(&self, index: usize) -> Value {
        self.bodies.lock().expect("not poisoned")[index].clone()
    }
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

/// A gateway over a real project and a real metadata store.
struct Rig {
    gateway: Arc<Gateway>,
    models: Arc<ModelRepo>,
    assets: Arc<FsProjectStore>,
    project: PathBuf,
    /// Keeps the tree both stores were opened in alive for the whole test.
    _tmp: TempDir,
}

impl Rig {
    /// Adds model configurations with stored credentials, the way Settings
    /// would. Each model carries its own full endpoint address, built from the
    /// throwaway provider's base and the endpoint shape its protocol speaks.
    async fn serving(&self, base_url: &str, models: Vec<TestModel>) {
        for entry in models {
            let protocol = entry
                .protocol
                .unwrap_or_else(|| default_protocol(entry.capability));
            let id = entry.id.clone();
            self.models
                .upsert(ModelDraft {
                    id: id.clone(),
                    category: entry.capability,
                    protocol,
                    url: endpoint_of(base_url, protocol, &id),
                    model: id.clone(),
                    display_name: id.clone(),
                    enabled: true,
                    expected_revision: None,
                })
                .await
                .expect("the model is stored");
            self.models
                .set_key(&id, Some(API_KEY))
                .await
                .expect("the credential is stored");
        }
    }

    /// Makes one model the answer for a capability, the way Settings would.
    async fn default(&self, capability: Capability, reference: &str) {
        let mut defaults = Defaults::default();
        match capability {
            Capability::Text => defaults.text = Some(reference.into()),
            Capability::Image => defaults.image = Some(reference.into()),
            Capability::Audio => defaults.audio = Some(reference.into()),
            Capability::Video => defaults.video = Some(reference.into()),
        }
        self.models
            .set_defaults(&defaults, None)
            .await
            .expect("the default resolves");
    }

    async fn prefer(&self, preferences: Preferences) {
        self.models
            .set_preferences(&preferences, None)
            .await
            .expect("the preferences are stored");
    }

    /// Stores bytes the way an upload would and returns the asset's identifier.
    async fn upload(&self, name: &str, mime: &str, bytes: &[u8]) -> String {
        let staging = self.project.join("tmp").join(format!("staged-{name}"));
        std::fs::write(&staging, bytes).expect("the staging directory exists");
        self.assets
            .add_asset(StagedAsset {
                name: name.into(),
                tmp_path: staging,
                declared_mime: Some(mime.into()),
                category_hint: None,
                provenance: None,
            })
            .await
            .expect("the asset is accepted")
            .entry
            .id
    }
}

async fn rig() -> Rig {
    let tmp = TempDir::new().expect("a temporary directory");
    let mut config = parse_test_config(tmp.path());
    // A test waits out its own retries, so a backoff that started at a second
    // would make a single one take three.
    config.generate = GenerateConfig {
        retry_base_ms: 1,
        ..GenerateConfig::default()
    };
    let budgets = config.generate.clone();
    let metadata_config = config.metadata.clone();
    let config = Arc::new(config);

    let root = metadata_config
        .dir
        .clone()
        .expect("the test configuration names a directory");
    std::fs::create_dir_all(&root).expect("the metadata directory is created");
    // Server mode reads the master key from a file rather than a keychain, and
    // the environment is shared across test threads so it is not used.
    let encoded = base64::engine::general_purpose::STANDARD.encode([7u8; 32]);
    std::fs::write(root.join(MASTER_KEY_FILE), encoded).expect("the master key is written");
    let metadata = metadata::open(&root, &metadata_config, RuntimeMode::Web)
        .map(|store| store as Arc<dyn MetadataStore>)
        .expect("the store opens");

    let models = Arc::new(ModelRepo::new(metadata));
    let assets = Arc::new(FsProjectStore::new(Arc::clone(&config)));
    let project = tmp.path().join("demo-project");
    assets
        .create_project(
            &project,
            CreateProject {
                name: "Demo".into(),
            },
        )
        .await
        .expect("the project scaffolds");

    let gateway = Arc::new(Gateway::new(
        Arc::clone(&models),
        Arc::clone(&assets) as Arc<dyn ProjectStore>,
        budgets,
    ));
    Rig {
        gateway,
        models,
        assets,
        project,
        _tmp: tmp,
    }
}

/// One model a test configures. The protocol is optional: a category has a
/// default shape, and a test that serves a different endpoint names it.
struct TestModel {
    id: String,
    capability: Capability,
    protocol: Option<Protocol>,
}

fn model(id: &str, capability: Capability) -> TestModel {
    TestModel {
        id: id.into(),
        capability,
        protocol: None,
    }
}

fn model_via(id: &str, capability: Capability, protocol: Protocol) -> TestModel {
    TestModel {
        id: id.into(),
        capability,
        protocol: Some(protocol),
    }
}

fn default_protocol(capability: Capability) -> Protocol {
    match capability {
        Capability::Text => Protocol::OpenaiChat,
        Capability::Image => Protocol::OpenaiImages,
        Capability::Audio => Protocol::OpenaiSpeech,
        Capability::Video => Protocol::OpenaiVideos,
    }
}

/// The complete endpoint address a protocol speaks at, on a throwaway
/// provider's base address.
fn endpoint_of(base_url: &str, protocol: Protocol, model_id: &str) -> String {
    match protocol {
        Protocol::OpenaiChat => format!("{base_url}/v1/chat/completions"),
        Protocol::OpenaiResponses => format!("{base_url}/v1/responses"),
        Protocol::OpenaiImages => format!("{base_url}/v1/images/generations"),
        Protocol::OpenaiSpeech => format!("{base_url}/v1/audio/speech"),
        Protocol::OpenaiVideos => format!("{base_url}/v1/videos"),
        Protocol::Gemini => format!("{base_url}/v1beta/models/{model_id}:generateContent"),
        Protocol::GeminiVideo => {
            format!("{base_url}/v1beta/models/{model_id}:predictLongRunning")
        }
        Protocol::Custom => format!("{base_url}/v1/chat/completions"),
    }
}

fn request(capability: Capability, prompt: &str, params: Value) -> GenerateRequest {
    GenerateRequest {
        capability,
        prompt: prompt.into(),
        params: params.as_object().cloned().unwrap_or_default(),
        ..GenerateRequest::default()
    }
}

/// A text answer as the newer of the two endpoints this protocol has sends it.
fn answer(text: &str) -> Json<Value> {
    Json(json!({
        "output_text": text,
        "usage": { "input_tokens": 4, "output_tokens": 2 },
    }))
}

fn events(chunks: &[&str]) -> Response {
    let mut body = String::new();
    for chunk in chunks {
        body.push_str(&format!(
            "data: {{\"type\":\"response.output_text.delta\",\"delta\":{chunk}}}\n\n"
        ));
    }
    // The totals arrive with the event that closes the answer rather than with
    // any of the pieces.
    body.push_str(
        "data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":4,\"output_tokens\":2}}}\n\n",
    );
    body.push_str("data: [DONE]\n\n");
    ([(header::CONTENT_TYPE, "text/event-stream")], body).into_response()
}

fn encoded(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = Vec::new();
    image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
        width,
        height,
        image::Rgb([40, 90, 160]),
    ))
    .write_to(
        &mut std::io::Cursor::new(&mut bytes),
        image::ImageFormat::Png,
    )
    .expect("the format encodes");
    bytes
}

// ------------------------------------------------------------------ placing

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_generation_goes_to_the_default_model_when_the_request_names_none() {
    let watched = Watch::default();
    let answering = watched.clone();
    let base_url = serve(Router::new().route(
        "/v1/responses",
        post(move |body: Bytes| {
            let watched = answering.clone();
            async move {
                watched.note(Some(body));
                answer("A lantern, lit.")
            }
        }),
    ))
    .await;

    let rig = rig().await;
    rig.serving(
        &base_url,
        vec![model_via(
            "gpt-5.5",
            Capability::Text,
            Protocol::OpenaiResponses,
        )],
    )
    .await;
    rig.default(Capability::Text, "gpt-5.5").await;

    let result = rig
        .gateway
        .text(
            // No model of its own, which is what a node with nothing picked
            // looks like.
            request(Capability::Text, "describe a lantern", json!({})),
            &DeltaSink::default(),
            &Cancel::new(),
        )
        .await
        .expect("the answer arrives");

    assert_eq!(result.text.as_deref(), Some("A lantern, lit."));
    assert_eq!(watched.times(), 1);
    assert_eq!(watched.body(0)["model"], "gpt-5.5");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_parameter_the_caller_set_reaches_the_provider_over_the_global_one() {
    let watched = Watch::default();
    let answering = watched.clone();
    let base_url = serve(Router::new().route(
        "/v1/images/generations",
        post(move |body: Bytes| {
            let watched = answering.clone();
            async move {
                watched.note(Some(body));
                Json(json!({ "data": [] }))
            }
        }),
    ))
    .await;

    let rig = rig().await;
    rig.serving(&base_url, vec![model("gpt-image-2", Capability::Image)])
        .await;
    rig.default(Capability::Image, "gpt-image-2").await;
    rig.prefer(Preferences {
        image: ImagePreferences {
            size: "1024x1024".into(),
            quality: "high".into(),
            ..ImagePreferences::default()
        },
        ..Preferences::default()
    })
    .await;

    // Both calls fail on the empty answer below; what matters is what reached
    // the provider on the way.
    let _ = rig
        .gateway
        .image(
            request(Capability::Image, "a cat", json!({ "size": "512x512" })),
            &Cancel::new(),
        )
        .await;
    let _ = rig
        .gateway
        .image(
            request(Capability::Image, "a cat", json!({})),
            &Cancel::new(),
        )
        .await;

    assert_eq!(watched.times(), 2);
    assert_eq!(
        watched.body(0)["size"],
        "512x512",
        "what the caller said wins over what the user set globally"
    );
    assert_eq!(
        watched.body(1)["size"],
        "1024x1024",
        "and the global one fills the gap it left"
    );
    assert_eq!(watched.body(1)["quality"], "high");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn each_capability_is_asked_at_the_address_that_serves_it() {
    let text_watched = Watch::default();
    let text_answering = text_watched.clone();
    let text_url = serve(Router::new().route(
        "/v1/responses",
        post(move |body: Bytes| {
            let watched = text_answering.clone();
            async move {
                watched.note(Some(body));
                answer("A lantern, lit.")
            }
        }),
    ))
    .await;

    let image_watched = Watch::default();
    let image_answering = image_watched.clone();
    let image_url = serve(Router::new().route(
        "/v1/images/generations",
        post(move |body: Bytes| {
            let watched = image_answering.clone();
            async move {
                watched.note(Some(body));
                Json(json!({ "data": [{ "b64_json": base64(&encoded(3, 2)) }] }))
            }
        }),
    ))
    .await;

    // One configuration per model, each addressed at the endpoint that
    // serves its own category: there is no shared channel address any more.
    let rig = rig().await;
    rig.serving(
        &text_url,
        vec![model_via(
            "gpt-5.5",
            Capability::Text,
            Protocol::OpenaiResponses,
        )],
    )
    .await;
    rig.serving(&image_url, vec![model("gpt-image-2", Capability::Image)])
        .await;

    let mut generation = request(Capability::Image, "a cat", json!({}));
    generation.model = "gpt-image-2".into();
    let picture = rig
        .gateway
        .image(generation, &Cancel::new())
        .await
        .expect("the image request is placed where images live");

    assert_eq!(picture.items.len(), 1);
    assert_eq!(
        image_watched.times(),
        1,
        "the image model was asked at the address it was configured with"
    );
    assert_eq!(
        text_watched.times(),
        0,
        "the text model's address never saw the image call"
    );

    let mut generation = request(Capability::Text, "describe a lantern", json!({}));
    generation.model = "gpt-5.5".into();
    let words = rig
        .gateway
        .text(generation, &DeltaSink::default(), &Cancel::new())
        .await
        .expect("the text request stays on its own address");

    assert_eq!(words.text.as_deref(), Some("A lantern, lit."));
    assert_eq!(text_watched.times(), 1);
    assert_eq!(
        image_watched.times(),
        1,
        "and the text model did not reach for the image address"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_reference_is_read_out_of_the_project_and_sent_along() {
    let watched = Watch::default();
    let answering = watched.clone();
    let base_url = serve(
        Router::new()
            .route("/v1/images/generations", post(not_for_an_edit))
            .route(
                "/v1/images/edits",
                post(move |multipart: axum::extract::Multipart| {
                    let watched = answering.clone();
                    async move {
                        watched.note(None);
                        let mut multipart = multipart;
                        while let Some(field) = multipart.next_field().await.expect("a field reads")
                        {
                            let _ = field.bytes().await.expect("the field is read");
                        }
                        Json(json!({ "data": [{ "b64_json": base64(&encoded(3, 2)) }] }))
                    }
                }),
            ),
    )
    .await;

    let rig = rig().await;
    rig.serving(&base_url, vec![model("gpt-image-2", Capability::Image)])
        .await;
    rig.default(Capability::Image, "gpt-image-2").await;
    let asset = rig.upload("cat.png", "image/png", &encoded(4, 3)).await;

    let mut generation = request(Capability::Image, "a cat, older", json!({}));
    generation.inputs = vec![GenerateInput {
        role: InputRole::Reference,
        asset_id: asset,
    }];
    let result = rig
        .gateway
        .image(generation, &Cancel::new())
        .await
        .expect("the edit arrives");

    assert_eq!(result.items.len(), 1);
    assert_eq!(result.items[0].mime, "image/png");
    assert_eq!(
        (result.items[0].width, result.items[0].height),
        (Some(3), Some(2))
    );
    assert_eq!(watched.times(), 1, "the reference made this an edit");
}

fn base64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// An endpoint a test routes only to find out whether it was asked. The answer
/// type is declared so that reaching it can be a bare panic.
async fn not_for_an_edit() -> Response {
    panic!("a reference must turn this into an edit")
}

// ------------------------------------------------------------------ failing

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_channel_that_asked_to_be_waited_for_is_asked_again_after_that_wait() {
    let watched = Watch::default();
    let answering = watched.clone();
    let base_url = serve(Router::new().route(
        "/v1/responses",
        post(move |body: Bytes| {
            let watched = answering.clone();
            async move {
                let asked_first = watched.times() == 0;
                watched.note(Some(body));
                if asked_first {
                    return (
                        StatusCode::TOO_MANY_REQUESTS,
                        // One second, against a backoff configured to start at
                        // one millisecond: only a wait taken from this header
                        // makes the elapsed assertion below meaningful.
                        [(header::RETRY_AFTER, "1")],
                        Json(json!({ "error": { "message": "slow down" } })),
                    )
                        .into_response();
                }
                answer("A lantern, lit.").into_response()
            }
        }),
    ))
    .await;

    let rig = rig().await;
    rig.serving(
        &base_url,
        vec![model_via(
            "gpt-5.5",
            Capability::Text,
            Protocol::OpenaiResponses,
        )],
    )
    .await;
    rig.default(Capability::Text, "gpt-5.5").await;

    let started = Instant::now();
    let result = rig
        .gateway
        .text(
            request(Capability::Text, "describe a lantern", json!({})),
            &DeltaSink::default(),
            &Cancel::new(),
        )
        .await
        .expect("the second attempt answers");

    assert_eq!(result.text.as_deref(), Some("A lantern, lit."));
    assert_eq!(watched.times(), 2, "a busy channel is worth asking again");
    assert!(
        started.elapsed() >= Duration::from_secs(1),
        "and the wait it asked for is the one that was kept"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_credential_the_provider_rejected_is_reported_once() {
    let watched = Watch::default();
    let answering = watched.clone();
    let base_url = serve(Router::new().route(
        "/v1/responses",
        post(move |body: Bytes| {
            let watched = answering.clone();
            async move {
                watched.note(Some(body));
                (
                    StatusCode::UNAUTHORIZED,
                    Json(json!({ "error": { "message": "incorrect API key" } })),
                )
            }
        }),
    ))
    .await;

    let rig = rig().await;
    rig.serving(
        &base_url,
        vec![model_via(
            "gpt-5.5",
            Capability::Text,
            Protocol::OpenaiResponses,
        )],
    )
    .await;
    rig.default(Capability::Text, "gpt-5.5").await;

    let error = rig
        .gateway
        .text(
            request(Capability::Text, "describe a lantern", json!({})),
            &DeltaSink::default(),
            &Cancel::new(),
        )
        .await
        .expect_err("the key is wrong");

    assert_eq!(error.code(), "PROVIDER_AUTH");
    // Wrong is not late: asking again with the same key only repeats it, and
    // each repeat is another line in somebody's usage bill.
    assert_eq!(watched.times(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_answer_that_carried_nothing_is_reported_rather_than_stored() {
    let base_url = serve(Router::new().route(
        "/v1/images/generations",
        post(|| async { Json(json!({ "data": [] })) }),
    ))
    .await;

    let rig = rig().await;
    rig.serving(&base_url, vec![model("gpt-image-2", Capability::Image)])
        .await;
    rig.default(Capability::Image, "gpt-image-2").await;

    let error = rig
        .gateway
        .image(
            request(Capability::Image, "a cat", json!({})),
            &Cancel::new(),
        )
        .await
        .expect_err("there is nothing to store");

    assert_eq!(error.code(), "PROVIDER_NO_OUTPUT");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_model_that_generates_something_else_is_refused_before_anything_is_sent() {
    let watched = Watch::default();
    let answering = watched.clone();
    let base_url = serve(Router::new().route(
        "/v1/images/generations",
        post(move |body: Bytes| {
            let watched = answering.clone();
            async move {
                watched.note(Some(body));
                Json(json!({ "data": [] }))
            }
        }),
    ))
    .await;

    let rig = rig().await;
    rig.serving(&base_url, vec![model("gpt-image-2", Capability::Image)])
        .await;

    // The endpoint says text, and the only model named is one that makes
    // pictures: answering would produce an asset no text node can hold.
    let mut generation = request(Capability::Text, "describe a lantern", json!({}));
    generation.model = "gpt-image-2".into();
    let error = rig
        .gateway
        .text(generation, &DeltaSink::default(), &Cancel::new())
        .await
        .expect_err("the capability does not match");

    assert_eq!(error.code(), "MODEL_CAPABILITY_MISMATCH");
    assert_eq!(watched.times(), 0, "nothing was sent");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_model_with_no_stored_key_is_reported_before_anything_is_sent() {
    let watched = Watch::default();
    let answering = watched.clone();
    let base_url = serve(Router::new().route(
        "/v1/responses",
        post(move |body: Bytes| {
            let watched = answering.clone();
            async move {
                watched.note(Some(body));
                answer("A lantern, lit.")
            }
        }),
    ))
    .await;

    let rig = rig().await;
    rig.models
        .upsert(ModelDraft {
            id: "gpt-5.5".into(),
            category: Capability::Text,
            protocol: Protocol::OpenaiResponses,
            url: format!("{base_url}/v1/responses"),
            model: "gpt-5.5".into(),
            display_name: "GPT-5.5".into(),
            enabled: true,
            expected_revision: None,
        })
        .await
        .expect("the model is stored");
    rig.default(Capability::Text, "gpt-5.5").await;

    let error = rig
        .gateway
        .text(
            request(Capability::Text, "describe a lantern", json!({})),
            &DeltaSink::default(),
            &Cancel::new(),
        )
        .await
        .expect_err("there is no credential to send");

    assert_eq!(error.code(), "PROVIDER_NOT_CONFIGURED");
    assert_eq!(watched.times(), 0, "nothing was sent without a key");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cancelled_generation_never_reaches_the_provider() {
    let watched = Watch::default();
    let answering = watched.clone();
    let base_url = serve(Router::new().route(
        "/v1/responses",
        post(move |body: Bytes| {
            let watched = answering.clone();
            async move {
                watched.note(Some(body));
                answer("A lantern, lit.")
            }
        }),
    ))
    .await;

    let rig = rig().await;
    rig.serving(
        &base_url,
        vec![model_via(
            "gpt-5.5",
            Capability::Text,
            Protocol::OpenaiResponses,
        )],
    )
    .await;
    rig.default(Capability::Text, "gpt-5.5").await;

    let cancel = Cancel::new();
    cancel.cancel();
    let error = rig
        .gateway
        .text(
            request(Capability::Text, "describe a lantern", json!({})),
            &DeltaSink::default(),
            &cancel,
        )
        .await
        .expect_err("the caller already left");

    assert_eq!(error.code(), "GENERATION_CANCELLED");
    assert_eq!(watched.times(), 0);
}

// ---------------------------------------------------------------- streaming

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_streamed_answer_reaches_the_caller_as_it_arrives_and_comes_back_whole() {
    let base_url = serve(Router::new().route(
        "/v1/responses",
        post(|| async { events(&["\"A \"", "\"lantern.\""]) }),
    ))
    .await;

    let rig = rig().await;
    rig.serving(
        &base_url,
        vec![model_via(
            "gpt-5.5",
            Capability::Text,
            Protocol::OpenaiResponses,
        )],
    )
    .await;
    rig.default(Capability::Text, "gpt-5.5").await;

    let seen = Arc::new(Mutex::new(String::new()));
    let collected = Arc::clone(&seen);
    let sink = DeltaSink::new(Arc::new(move |chunk: &str| {
        collected
            .lock()
            .expect("the sink is not held across a call")
            .push_str(chunk);
    }));

    let result = rig
        .gateway
        .text(
            request(
                Capability::Text,
                "describe a lantern",
                json!({ "stream": true }),
            ),
            &sink,
            &Cancel::new(),
        )
        .await
        .expect("the stream is read to its end");

    assert_eq!(
        seen.lock()
            .expect("the sink is not held across a call")
            .as_str(),
        "A lantern.",
        "every piece reached the caller while it was arriving"
    );
    // Streaming only makes the wait visible: what gets stored is the aggregate.
    assert_eq!(result.text.as_deref(), Some("A lantern."));
    assert_eq!(result.usage.and_then(|usage| usage.output_tokens), Some(2));
}

/// Reads out one event and then fails, the way a provider that drops the
/// connection mid-answer does.
struct Abandoned {
    pending: Vec<u8>,
    stall: Option<std::pin::Pin<Box<tokio::time::Sleep>>>,
}

impl Abandoned {
    fn new(body: String) -> Self {
        Self {
            pending: body.into_bytes(),
            stall: None,
        }
    }
}

impl tokio::io::AsyncRead for Abandoned {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        if !self.pending.is_empty() {
            let take = buf.remaining().min(self.pending.len());
            buf.put_slice(&self.pending[..take]);
            self.pending.drain(..take);
            return Poll::Ready(Ok(()));
        }
        // Paused before failing, so the piece already produced has time to
        // leave the machine: a body that ends in the same instant it begins
        // takes what it sent with it.
        let stall = self
            .stall
            .get_or_insert_with(|| Box::pin(tokio::time::sleep(Duration::from_millis(50))));
        if stall.as_mut().poll(cx).is_pending() {
            return Poll::Pending;
        }
        Poll::Ready(Err(std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            "the provider dropped the connection",
        )))
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_failure_after_something_was_streamed_is_not_asked_again() {
    let watched = Watch::default();
    let answering = watched.clone();
    let base_url = serve(Router::new().route(
        "/v1/responses",
        post(move |body: Bytes| {
            let watched = answering.clone();
            async move {
                watched.note(Some(body));
                // One piece reaches the caller, and then the connection goes:
                // a retry would put the same words on screen a second time.
                let pending = String::from(
                    "data: {\"type\":\"response.output_text.delta\",\"delta\":\"A \"}\n\n\
                     data: {\"type\":\"response.output_text.delt",
                );
                (
                    [(header::CONTENT_TYPE, "text/event-stream")],
                    Body::from_stream(tokio_util::io::ReaderStream::new(Abandoned::new(pending))),
                )
                    .into_response()
            }
        }),
    ))
    .await;

    let rig = rig().await;
    rig.serving(
        &base_url,
        vec![model_via(
            "gpt-5.5",
            Capability::Text,
            Protocol::OpenaiResponses,
        )],
    )
    .await;
    rig.default(Capability::Text, "gpt-5.5").await;

    let seen = Arc::new(Mutex::new(String::new()));
    let collected = Arc::clone(&seen);
    let sink = DeltaSink::new(Arc::new(move |chunk: &str| {
        collected
            .lock()
            .expect("the sink is not held across a call")
            .push_str(chunk);
    }));

    let error = rig
        .gateway
        .text(
            request(
                Capability::Text,
                "describe a lantern",
                json!({ "stream": true }),
            ),
            &sink,
            &Cancel::new(),
        )
        .await
        .expect_err("the connection went mid-answer");

    assert_eq!(
        seen.lock()
            .expect("the sink is not held across a call")
            .as_str(),
        "A ",
        "the caller had already seen something"
    );
    assert_eq!(error.code(), "PROVIDER_UNAVAILABLE", "{error}");
    assert_eq!(
        watched.times(),
        1,
        "an answer already on screen is not repeated behind it"
    );
}

// -------------------------------------------------------------------- video

/// A provider that starts a job, answers one poll with work still to do, and
/// the next with the finished bytes.
async fn video_provider(watched: Watch) -> String {
    let started = watched.clone();
    let polled = watched.clone();
    let collected = watched.clone();
    serve(
        Router::new()
            .route(
                "/v1/videos",
                post(move |body: Bytes| {
                    let watched = started.clone();
                    async move {
                        watched.note(Some(body));
                        Json(json!({ "id": "job-1", "status": "queued" }))
                    }
                }),
            )
            .route(
                "/v1/videos/{id}",
                get(move || {
                    let watched = polled.clone();
                    async move {
                        let first = watched.times() == 1;
                        watched.note(None);
                        let status = if first { "in_progress" } else { "completed" };
                        Json(json!({ "id": "job-1", "status": status }))
                    }
                }),
            )
            .route(
                "/v1/videos/{id}/content",
                get(move || {
                    let watched = collected.clone();
                    async move {
                        watched.note(None);
                        ([(header::CONTENT_TYPE, "video/mp4")], b"mp4-bytes".to_vec())
                    }
                }),
            ),
    )
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_shot_is_started_polled_and_then_the_handle_is_done_with() {
    let watched = Watch::default();
    let base_url = video_provider(watched.clone()).await;

    let rig = rig().await;
    rig.serving(&base_url, vec![model("a-video-model", Capability::Video)])
        .await;
    rig.default(Capability::Video, "a-video-model").await;

    let task = rig
        .gateway
        .video(
            request(Capability::Video, "a slow pan", json!({ "seconds": 6 })),
            &Cancel::new(),
        )
        .await
        .expect("the job starts");

    assert!(!task.id.is_empty());
    assert_eq!(task.capability, Capability::Video);
    assert_eq!(
        rig.gateway.tasks().len(),
        1,
        "the handle is tracked at once"
    );
    assert_eq!(watched.body(0)["seconds"], 6);

    let cancel = Cancel::new();
    match rig.gateway.poll(&task.id, &cancel).await.expect("a look") {
        TaskState::Pending { retry_after_ms } => {
            assert!(retry_after_ms > 0, "another look is worth waiting for")
        }
        other => panic!("expected a job still running, got {other:?}"),
    }
    assert_eq!(rig.gateway.tasks().len(), 1, "a running job stays tracked");

    match rig
        .gateway
        .poll(&task.id, &cancel)
        .await
        .expect("the job is collected")
    {
        TaskState::Succeeded(result) => {
            assert_eq!(result.items.len(), 1);
            assert_eq!(result.items[0].mime, "video/mp4");
            assert_eq!(result.items[0].bytes, b"mp4-bytes");
        }
        other => panic!("expected the finished shot, got {other:?}"),
    }

    // A job that answered will not answer again, so its handle is dropped
    // rather than kept until it grows old.
    assert!(rig.gateway.tasks().is_empty());
    let error = rig
        .gateway
        .poll(&task.id, &cancel)
        .await
        .expect_err("the handle is done with");
    assert_eq!(error.code(), "TASK_NOT_FOUND");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_handle_the_gateway_never_issued_is_missing() {
    let rig = rig().await;
    let error = rig
        .gateway
        .poll("a-handle-from-nowhere", &Cancel::new())
        .await
        .expect_err("nothing is tracked under it");
    assert_eq!(error.code(), "TASK_NOT_FOUND");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_job_the_provider_has_forgotten_ends_the_tracking() {
    let base_url = serve(Router::new().route(
        "/v1/videos",
        post(|| async { Json(json!({ "id": "job-1", "status": "queued" })) }),
    ))
    .await;

    let rig = rig().await;
    rig.serving(&base_url, vec![model("a-video-model", Capability::Video)])
        .await;
    rig.default(Capability::Video, "a-video-model").await;

    let task = rig
        .gateway
        .video(
            request(Capability::Video, "a slow pan", json!({})),
            &Cancel::new(),
        )
        .await
        .expect("the job starts");

    // Only the start endpoint is routed, so a poll answers 404 and the job is
    // one this provider no longer knows.
    let error = rig
        .gateway
        .poll(&task.id, &Cancel::new())
        .await
        .expect_err("the job is gone");
    assert_eq!(error.code(), "TASK_EXPIRED");
    assert!(
        rig.gateway.tasks().is_empty(),
        "a job the provider forgot cannot answer again"
    );
}
