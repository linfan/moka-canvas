//! A run that reaches a provider.
//!
//! The gateway, the adapters and the ingest each have tests of their own; what
//! is checked here is the join between them and the run pipeline. That a
//! generation node is scheduled onto the provider executor rather than refused,
//! that the answer it comes back with is filed in the project bearing the run
//! it came from, that an answer from earlier in the same run reaches the node
//! below it, and that a cancel arrives at a step already waiting on a provider.

use std::path::Path;
use std::sync::{Arc, Mutex};

use axum::body::{to_bytes, Body, Bytes};
use axum::http::{header, Request, StatusCode};
use axum::routing::post;
use axum::{Json, Router};
use base64::Engine;
use moka_canvas::api::ApiState;
use moka_canvas::config::{parse_test_config, RuntimeMode};
use moka_canvas::domain::commands::make_node;
use moka_canvas::domain::{
    generation_capability_for, now_iso, Capability, GenerationInputMode, GenerationMode,
    GenerationSpec, NodeKind,
};
use moka_canvas::metadata::crypto::MASTER_KEY_FILE;
use moka_canvas::metadata::{ChannelDraft, ChannelModel, Defaults, Protocol};
use serde_json::{json, Value};
use tempfile::TempDir;
use tokio::sync::Notify;
use tower::ServiceExt;

/// Long enough that masking keeps a recognisable head and tail.
const API_KEY: &str = "sk-test-1234567890abcd";

/// The one channel every test here configures, so a reference is predictable.
const CHANNEL: &str = "a-channel";

/// Namespaced with the family a provider's newer answer endpoint expects, so
/// what is asked for lands on the route the mock serves.
const WRITER: &str = "gpt-scribe-1";
const PAINTER: &str = "painter-1";

/// What the writer says, and what the painter says it drew.
const SENTENCE: &str = "A paper lantern drifts over a quiet lake.";
const CAPTION: &str = "a paper lantern, asleep";

struct Harness {
    app: Router,
    state: ApiState,
    /// Keeps the tree the store was opened in alive for the whole test.
    tmp: TempDir,
}

/// Opens the app over a temporary directory that already holds a master key.
/// Server mode refuses to invent one, and a generation cannot be placed without
/// a credential to send.
fn harness() -> Harness {
    let tmp = TempDir::new().expect("a temporary directory");
    let config = parse_test_config(tmp.path());
    let metadata = config
        .metadata
        .dir
        .clone()
        .expect("the test configuration sets a metadata directory");
    std::fs::create_dir_all(&metadata).expect("the metadata directory is created");
    let encoded = base64::engine::general_purpose::STANDARD.encode([7u8; 32]);
    std::fs::write(metadata.join(MASTER_KEY_FILE), encoded).expect("the master key is written");
    let state = ApiState::new(config, RuntimeMode::Web, &metadata).expect("the store opens");
    let app = moka_canvas::server::router(state.clone());
    Harness { app, state, tmp }
}

impl Harness {
    /// Points the app at a throwaway provider and makes its models the defaults,
    /// which is what Settings does before a generation can be placed at all.
    async fn configure(&self, base_url: &str, models: &[(&str, Capability)]) {
        self.state
            .providers
            .upsert_channel(ChannelDraft {
                id: CHANNEL.into(),
                name: "A channel".into(),
                base_url: base_url.into(),
                protocol: Protocol::Openai,
                enabled: true,
                models: models
                    .iter()
                    .map(|(id, capability)| ChannelModel {
                        id: (*id).into(),
                        capability: *capability,
                        alias: String::new(),
                        enabled: true,
                    })
                    .collect(),
                expected_revision: None,
            })
            .await
            .expect("the channel is stored");
        self.state
            .providers
            .set_key(CHANNEL, Some(API_KEY))
            .await
            .expect("the credential is stored");

        let mut defaults = Defaults::default();
        for (id, capability) in models {
            let reference = format!("{CHANNEL}::{id}");
            match capability {
                Capability::Text => defaults.text = Some(reference),
                Capability::Image => defaults.image = Some(reference),
                Capability::Audio => defaults.audio = Some(reference),
                Capability::Video => defaults.video = Some(reference),
            }
        }
        self.state
            .providers
            .set_defaults(&defaults, None)
            .await
            .expect("the defaults are stored");
    }

    /// Creates the project a run happens in, and returns its canvas and the
    /// directory its files land in.
    async fn project(&self, name: &str) -> (String, String) {
        let created = self
            .send_json(
                json_request(
                    "POST",
                    "/api/v1/projects",
                    json!({
                        "directory": self.tmp.path().join("projects").to_string_lossy(),
                        "name": name,
                    }),
                ),
                StatusCode::CREATED,
            )
            .await;
        let canvas_id = created["moka"]["canvas"][0]["id"]
            .as_str()
            .expect("a canvas is made with the project")
            .to_string();
        let root = created["root"]
            .as_str()
            .expect("a root is reported")
            .to_string();
        (canvas_id, root)
    }

    async fn apply(&self, commands: Value) {
        let revision = self.document().await["moka"]["metadata"]["revision"]
            .as_i64()
            .expect("the document carries a revision");
        self.send_json(
            json_request(
                "POST",
                "/api/v1/projects/current/commands",
                json!({ "expectedRevision": revision, "commands": commands }),
            ),
            StatusCode::OK,
        )
        .await;
    }

    async fn document(&self) -> Value {
        self.send_json(get("/api/v1/projects/current"), StatusCode::OK)
            .await
    }

    /// Starts a run and returns its id, which is all a caller can follow it by.
    async fn start(&self, canvas_id: &str, node_ids: Value) -> String {
        let run = self
            .send_json(
                json_request(
                    "POST",
                    "/api/v1/projects/current/runs",
                    json!({ "canvasId": canvas_id, "nodeIds": node_ids }),
                ),
                StatusCode::CREATED,
            )
            .await;
        assert_eq!(run["status"], "queued");
        run["id"].as_str().expect("a run has an id").to_string()
    }

    async fn run(&self, run_id: &str) -> Value {
        self.send_json(
            get(&format!("/api/v1/projects/current/runs/{run_id}")),
            StatusCode::OK,
        )
        .await
    }

    /// Waits a run out. A generation is the slowest thing in the app, but the
    /// provider here is a mock on the loopback, so a run that has not settled in
    /// a few seconds is a run that never will.
    async fn settled(&self, run_id: &str) -> Value {
        for _ in 0..200 {
            let run = self.run(run_id).await;
            let status = run["status"].as_str().expect("a run has a status");
            if status != "queued" && status != "running" {
                return run;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        panic!("run {run_id} did not reach a terminal state");
    }

    async fn cancel(&self, run_id: &str) -> Value {
        let request = Request::builder()
            .method("POST")
            .uri(format!("/api/v1/projects/current/runs/{run_id}/cancel"))
            .body(Body::empty())
            .expect("a request is built");
        let response = self
            .app
            .clone()
            .oneshot(request)
            .await
            .expect("the request is served");
        assert_eq!(response.status(), StatusCode::OK);
        body_json(response).await
    }

    async fn send_json(&self, request: Request<Body>, expected: StatusCode) -> Value {
        let response = self
            .app
            .clone()
            .oneshot(request)
            .await
            .expect("the request is served");
        let status = response.status();
        let body = body_json(response).await;
        assert_eq!(status, expected, "{body}");
        body
    }
}

fn get(uri: &str) -> Request<Body> {
    Request::builder()
        .uri(uri)
        .body(Body::empty())
        .expect("a request is built")
}

fn json_request(method: &str, uri: &str, payload: Value) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::to_vec(&payload).unwrap()))
        .expect("a request is built")
}

async fn body_json(response: axum::http::Response<Body>) -> Value {
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("the body is read");
    serde_json::from_slice(&bytes).expect("the body is JSON")
}

/// Starts a throwaway provider and returns the address a channel would carry.
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

/// What a throwaway provider was asked, in the order it was asked. A test reads
/// this to see the request that reached the far end of the whole pipeline.
#[derive(Clone, Default)]
struct Recorded(Arc<Mutex<Vec<Value>>>);

impl Recorded {
    fn note(&self, body: &Bytes) {
        self.0
            .lock()
            .expect("the recorder is not poisoned")
            .push(serde_json::from_slice(body).expect("a generation is sent as JSON"));
    }

    fn calls(&self) -> usize {
        self.0.lock().expect("the recorder is not poisoned").len()
    }

    fn call(&self, index: usize) -> Value {
        self.0.lock().expect("the recorder is not poisoned")[index].clone()
    }
}

/// A provider that answers both capabilities, so one channel can serve a chain.
fn answering(recorded: Recorded) -> Router {
    let writing = recorded.clone();
    Router::new()
        .route(
            "/v1/responses",
            post(move |body: Bytes| {
                let recorded = writing.clone();
                async move {
                    recorded.note(&body);
                    Json(json!({
                        "output_text": SENTENCE,
                        "usage": { "input_tokens": 4, "output_tokens": 2 },
                    }))
                }
            }),
        )
        .route(
            "/v1/images/generations",
            post(move |body: Bytes| {
                let recorded = recorded.clone();
                async move {
                    recorded.note(&body);
                    painted()
                }
            }),
        )
}

/// A provider that holds its answer until the test lets it go, so a cancel can
/// be asked for while a step is still waiting on one.
fn hesitant(recorded: Recorded, gate: Arc<Notify>) -> Router {
    Router::new().route(
        "/v1/images/generations",
        post(move |body: Bytes| {
            let recorded = recorded.clone();
            let gate = Arc::clone(&gate);
            async move {
                recorded.note(&body);
                gate.notified().await;
                painted()
            }
        }),
    )
}

fn painted() -> Json<Value> {
    Json(json!({
        "created": 1_700_000_000u64,
        "data": [{ "b64_json": encoded(&picture(8, 6)), "revised_prompt": CAPTION }],
    }))
}

fn encoded(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// The bytes a provider would send back, small enough to compare whole.
fn picture(width: u32, height: u32) -> Vec<u8> {
    let mut canvas = image::RgbaImage::new(width, height);
    for pixel in canvas.pixels_mut() {
        *pixel = image::Rgba([40, 200, 120, 255]);
    }
    let mut bytes = Vec::new();
    image::DynamicImage::ImageRgba8(canvas)
        .write_to(
            &mut std::io::Cursor::new(&mut bytes),
            image::ImageFormat::Png,
        )
        .expect("a picture is written");
    bytes
}

/// The reference a generation spec stores: which channel answers, and which of
/// its models. An empty one means the default the user set for the capability.
fn reference(model: &str) -> String {
    format!("{CHANNEL}::{model}")
}

/// A node that asks a provider for something, built the way the editor builds
/// one: the kind decides the capability, so the two can never disagree.
fn asking(
    id: &str,
    kind: NodeKind,
    title: &str,
    model: &str,
    prompt: &str,
    params: Option<Value>,
) -> Value {
    let capability = generation_capability_for(kind).expect("a generation node has a capability");
    let mut node = make_node(kind, title.into(), 0.0, 0.0);
    node.id = id.to_string();
    node.data.generation = Some(GenerationSpec {
        capability,
        mode: GenerationMode::Generate,
        model: model.into(),
        prompt: prompt.into(),
        input_mode: GenerationInputMode::Upstream,
        params,
        reference_node_ids: None,
        updated_at: now_iso(),
    });
    serde_json::to_value(&node).expect("a node is sent as it is stored")
}

fn edge(id: &str, source: (&str, &str), target: (&str, &str)) -> Value {
    json!({
        "id": id,
        "source": { "nodeId": source.0, "portId": source.1 },
        "target": { "nodeId": target.0, "portId": target.1 },
        "createdAt": "2026-01-01T00:00:00Z"
    })
}

fn files_in(root: &str, category: &str) -> usize {
    std::fs::read_dir(Path::new(root).join("assets").join(category))
        .map(|entries| entries.count())
        .unwrap_or(0)
}

/// Waits until a throwaway provider has been asked, so what follows happens
/// while the step is in the middle of a call rather than before it.
async fn until_asked(recorded: &Recorded) {
    for _ in 0..200 {
        if recorded.calls() > 0 {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    panic!("the provider was never asked");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_generation_node_is_run_by_the_provider_and_its_answer_is_filed_in_the_project() {
    let harness = harness();
    let recorded = Recorded::default();
    let base_url = serve(answering(recorded.clone())).await;
    harness
        .configure(&base_url, &[(PAINTER, Capability::Image)])
        .await;
    let (canvas_id, root) = harness.project("Poster").await;
    harness
        .apply(json!([
            { "type": "addNode", "canvasId": canvas_id, "node": asking(
                "n-poster", NodeKind::Image, "Poster", &reference(PAINTER),
                "a paper lantern over a quiet lake", Some(json!({ "size": "1024x1024" }))) },
        ]))
        .await;

    let run_id = harness.start(&canvas_id, json!(["n-poster"])).await;
    assert_eq!(harness.run(&run_id).await["executorKey"], "provider");

    let finished = harness.settled(&run_id).await;
    assert_eq!(finished["status"], "succeeded");
    let steps = finished["steps"].as_array().expect("a run has steps");
    assert_eq!(steps.len(), 1);
    assert_eq!(steps[0]["nodeId"], "n-poster");
    assert_eq!(steps[0]["status"], "succeeded");
    let assets = steps[0]["outputAssetIds"]
        .as_array()
        .expect("the answer was filed");
    assert_eq!(assets.len(), 1);
    // A caption a provider rewrote is worth keeping beside the step, so a reader
    // can compare it with what was asked for; it is not an asset of its own.
    assert_eq!(steps[0]["outputText"], json!(CAPTION));

    // What reached the provider is the spec's own words and parameters, sent
    // under the model the reference named and nothing else.
    assert_eq!(recorded.calls(), 1, "one step, one call");
    let sent = recorded.call(0);
    assert_eq!(sent["model"], json!(PAINTER));
    assert_eq!(sent["prompt"], json!("a paper lantern over a quiet lake"));
    assert_eq!(sent["size"], json!("1024x1024"));

    let images = harness.document().await["moka"]["resources"]["images"].clone();
    let entries = images.as_array().expect("the registry holds the answer");
    assert_eq!(entries.len(), 1);
    let entry = &entries[0];
    assert_eq!(entry["id"], assets[0], "the step names the asset it made");
    let path = entry["path"].as_str().expect("an asset has a path");
    assert!(path.starts_with("assets/images/"), "{path}");
    assert_eq!(entry["mime"], json!("image/png"));
    let probe = &entry["probe"];
    assert_eq!(probe["width"], json!(8), "read from the bytes, not assumed");
    assert_eq!(probe["height"], json!(6));
    // The bytes are the provider's own, not a copy of them re-encoded on the way
    // in: what a run made has to be what the run was given.
    assert_eq!(
        std::fs::read(Path::new(&root).join(path)).expect("the asset is on disk"),
        picture(8, 6)
    );

    let provenance = &entry["provenance"];
    assert_eq!(provenance["runId"], json!(run_id));
    assert_eq!(provenance["canvasId"], json!(canvas_id));
    assert_eq!(provenance["operationNodeId"], json!("n-poster"));
    assert!(
        provenance["inputAssetIds"].is_null(),
        "nothing travelled with this request"
    );
    let snapshot = &provenance["parameterSnapshot"];
    assert_eq!(snapshot["model"], json!(reference(PAINTER)));
    assert_eq!(snapshot["params"]["size"], json!("1024x1024"));
    // The snapshot is what a node was asked with, so it must never carry the
    // credential the model resolves to.
    assert!(!snapshot.to_string().contains(API_KEY));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_answer_from_earlier_in_the_run_reaches_the_generation_below_it() {
    let harness = harness();
    let recorded = Recorded::default();
    let base_url = serve(answering(recorded.clone())).await;
    harness
        .configure(
            &base_url,
            &[(WRITER, Capability::Text), (PAINTER, Capability::Image)],
        )
        .await;
    let (canvas_id, _root) = harness.project("Chain").await;
    harness
        .apply(json!([
            // An empty model is the default the user set for the capability, and
            // a reference is a model named by hand: a chain can mix the two.
            { "type": "addNode", "canvasId": canvas_id, "node": asking(
                "n-script", NodeKind::Text, "Script", "", "Write one sentence.", None) },
            { "type": "addNode", "canvasId": canvas_id, "node": asking(
                "n-poster", NodeKind::Image, "Poster", &reference(PAINTER),
                "Paint it as a poster.", None) },
            { "type": "addEdge", "canvasId": canvas_id,
              "edge": edge("e-1", ("n-script", "out"), ("n-poster", "prompt")) },
        ]))
        .await;

    // Only the poster was asked for; the script is pulled in because the poster
    // reads from it, and a run that skipped it would ask for a poster with
    // nothing to paint.
    let run_id = harness.start(&canvas_id, json!(["n-poster"])).await;
    let finished = harness.settled(&run_id).await;
    assert_eq!(finished["status"], "succeeded");
    let steps = finished["steps"].as_array().expect("a run has steps");
    assert_eq!(steps.len(), 2, "the upstream node became a step of its own");
    assert_eq!(steps[0]["nodeId"], "n-script");
    assert_eq!(steps[0]["status"], "succeeded");
    assert_eq!(steps[0]["outputText"], json!(SENTENCE));
    assert_eq!(steps[1]["nodeId"], "n-poster");
    assert_eq!(steps[1]["status"], "succeeded");

    assert_eq!(recorded.calls(), 2, "one call per generation step");
    assert_eq!(
        recorded.call(0)["model"],
        json!(WRITER),
        "a node with no model of its own lands on the default for its capability"
    );
    let asked = recorded.call(1);
    assert_eq!(asked["model"], json!(PAINTER));
    let prompt = asked["prompt"]
        .as_str()
        .expect("a picture is asked for in words");
    assert!(prompt.starts_with("Paint it as a poster."), "{prompt}");
    // The document said nothing about the script when the run started: what
    // reaches this step is the answer the step above it made moments ago.
    assert!(prompt.contains(SENTENCE), "{prompt}");
    assert!(
        prompt.contains("[Text 1]"),
        "the block is labelled, so the prompt can point at it: {prompt}"
    );

    // Both answers were filed, each under the category its kind implies.
    let resources = harness.document().await["moka"]["resources"].clone();
    assert_eq!(resources["texts"].as_array().expect("a registry").len(), 1);
    let posters = resources["images"].as_array().expect("a registry");
    assert_eq!(posters.len(), 1);
    assert_eq!(
        posters[0]["provenance"]["operationNodeId"],
        json!("n-poster"),
        "each asset names the node that asked for it"
    );
    assert!(
        posters[0]["provenance"]["inputAssetIds"].is_null(),
        "words folded into a prompt are not media that travelled"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cancel_reaches_a_step_that_is_waiting_on_a_provider() {
    let harness = harness();
    let recorded = Recorded::default();
    let gate = Arc::new(Notify::new());
    let base_url = serve(hesitant(recorded.clone(), Arc::clone(&gate))).await;
    harness
        .configure(&base_url, &[(PAINTER, Capability::Image)])
        .await;
    let (canvas_id, root) = harness.project("Cancelled").await;
    harness
        .apply(json!([
            { "type": "addNode", "canvasId": canvas_id, "node": asking(
                "n-poster", NodeKind::Image, "Poster", &reference(PAINTER),
                "a paper lantern", None) },
        ]))
        .await;

    let run_id = harness.start(&canvas_id, json!(["n-poster"])).await;
    until_asked(&recorded).await;

    let cancelling = harness.cancel(&run_id).await;
    assert_eq!(cancelling["cancelRequested"], true);
    // Let the answer arrive. A cancel is checked around a call rather than
    // dropped into the middle of one, so this is what ends the wait.
    gate.notify_one();

    let finished = harness.settled(&run_id).await;
    assert_eq!(finished["status"], "cancelled");
    assert_eq!(finished["cancelRequested"], true);
    assert!(
        finished["error"].is_null(),
        "a run nobody wants any more did not go wrong: {:?}",
        finished["error"]
    );
    let steps = finished["steps"].as_array().expect("a run has steps");
    assert_eq!(steps[0]["status"], "cancelled");
    assert!(
        steps[0]["outputAssetIds"].is_null(),
        "an answer that arrived after the cancel was not kept"
    );

    // Nothing was filed for a run that was called off, so there is no asset in
    // the panel with no node pointing at it.
    let resources = harness.document().await["moka"]["resources"].clone();
    assert!(resources["images"]
        .as_array()
        .expect("a registry")
        .is_empty());
    assert_eq!(files_in(&root, "images"), 0);
    assert_eq!(
        std::fs::read_dir(Path::new(&root).join("tmp"))
            .expect("the temporary directory exists")
            .count(),
        0,
        "the bytes that arrived on the way out were not left behind"
    );
}
