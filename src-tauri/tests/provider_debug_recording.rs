//! Recording a call that really went out, against a provider standing on
//! localhost.
//!
//! The recorder's own tests cover what it writes and how it protects it. What
//! they cannot cover is the seam that matters most: that the transport every
//! protocol shares actually reads a request before it goes out and writes the
//! answer down when it comes back. That is proven here against a real socket,
//! because a hand-written fake would exercise the wiring it was written beside
//! rather than the wiring the adapters use.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::body::Bytes;
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use moka_canvas::config::GenerateConfig;
use moka_canvas::domain::Capability;
use moka_canvas::generate::adapters::{for_protocol, ModelCall};
use moka_canvas::generate::models::ResolvedModel;
use moka_canvas::generate::{Cancel, DeltaSink, GenerateRequest};
use moka_canvas::metadata::Protocol;
use serde_json::{json, Value};

/// Long enough that masking keeps a recognisable head and tail.
const API_KEY: &str = "sk-test-1234567890abcd";

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

fn channel(base_url: &str) -> ModelCall {
    let resolved = ResolvedModel {
        config_id: "gpt-5.5".into(),
        model: "gpt-5.5".into(),
        display_name: "GPT-5.5".into(),
        category: Capability::Text,
        protocol: Protocol::new("openaiResponses"),
        url: format!("{base_url}/v1/responses"),
    };
    ModelCall::new(&resolved, API_KEY.to_string(), GenerateConfig::default())
        .expect("a client builds")
}

fn generation(prompt: &str, params: Value) -> GenerateRequest {
    GenerateRequest {
        capability: Capability::Text,
        prompt: prompt.into(),
        params: params.as_object().cloned().unwrap_or_default(),
        ..GenerateRequest::default()
    }
}

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

/// Collects what a stream pushed, so the aggregate a recording claims can be
/// checked against the one the caller was handed.
fn watching() -> (DeltaSink, Arc<std::sync::Mutex<String>>) {
    let seen = Arc::new(std::sync::Mutex::new(String::new()));
    let collected = Arc::clone(&seen);
    let sink = DeltaSink::new(Arc::new(move |chunk: &str| {
        collected.lock().expect("not poisoned").push_str(chunk);
    }));
    (sink, seen)
}

/// Turns recording on for the process, into a directory of the test's own.
///
/// One directory per process, because the recorder is one: a second call keeps
/// the first, which is the behaviour under test rather than an accident of it.
async fn record_into(dir: &Path) -> PathBuf {
    moka_canvas::generate::debug::init_in(dir)
        .expect("recording starts")
        .expect("recording is on");
    dir.to_path_buf()
}

/// Reads the recordings a call left behind, waiting for the writer to catch up:
/// a recording is written by a task of its own so that a slow disk costs a
/// generation nothing, which means a test has to wait for it rather than assume
/// it landed.
async fn recordings(root: &Path, want: usize) -> Vec<Value> {
    for _ in 0..300 {
        if let Ok(index) = std::fs::read_to_string(root.join("index.jsonl")) {
            let lines: Vec<Value> = index
                .lines()
                .filter(|line| !line.trim().is_empty())
                .map(|line| serde_json::from_str(line).expect("one JSON line"))
                .collect();
            if lines.len() >= want {
                return lines;
            }
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("only {} of {want} calls were recorded", counted(root));
}

fn counted(root: &Path) -> usize {
    std::fs::read_to_string(root.join("index.jsonl"))
        .map(|index| index.lines().filter(|line| !line.trim().is_empty()).count())
        .unwrap_or_default()
}

fn read(root: &Path, name: &str, which: &str) -> Value {
    let path = root.join(format!("{name}.{which}.json"));
    let bytes = std::fs::read(&path).unwrap_or_else(|_| panic!("{} is there", path.display()));
    serde_json::from_slice(&bytes).expect("the record is JSON")
}

/// Deploys the built-in converter scripts, which is also what points the
/// process-wide converter root at them. Every protocol here is served by a
/// script, and a script is only found through that root. The root is set once
/// per process, so the directory is leaked to outlive the test.
async fn deploy_scripts() {
    if moka_canvas::converter::converter_root().is_some() {
        return;
    }
    let converter = tempfile::tempdir().expect("a converter directory");
    let path: &'static std::path::Path = Box::leak(converter.keep().into_boxed_path());
    moka_canvas::converter::deploy::ensure_deployed(path)
        .await
        .expect("the built-in scripts deploy");
}

/// The one kind a call is named for, found in the index by the address it went
/// to, which is how a reader would look for it.
fn find<'a>(lines: &'a [Value], kind: &str) -> &'a Value {
    lines
        .iter()
        .find(|line| line["kind"] == kind)
        .unwrap_or_else(|| panic!("a {kind} call was recorded"))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_call_that_really_went_out_is_written_down_whole() {
    deploy_scripts().await;
    let temp = tempfile::tempdir().expect("a directory to record into");
    let root = record_into(temp.path()).await;

    let base_url = serve(
        Router::new()
            .route(
                "/v1/responses",
                post(|headers: HeaderMap, body: Bytes| async move {
                    assert!(headers.get("authorization").is_some());
                    if serde_json::from_slice::<Value>(&body)
                        .map(|body| body.get("stream").and_then(Value::as_bool) == Some(true))
                        .unwrap_or(false)
                    {
                        return stream(&[
                            r#"{"type":"response.output_text.delta","delta":"A "}"#,
                            r#"{"type":"response.output_text.delta","delta":"lantern."}"#,
                            r#"{"type":"response.completed","response":{"output_text":"A lantern."}}"#,
                            "[DONE]",
                        ]);
                    }
                    Json(json!({ "output_text": "A lantern." })).into_response()
                }),
            )
            .route(
                "/v1/audio/speech",
                post(|_headers: HeaderMap, _body: Bytes| async move {
                    // Sound is not text, which is the case a recording has to
                    // keep rather than write down as an empty answer.
                    (
                        [(axum::http::header::CONTENT_TYPE, "audio/mpeg")],
                        vec![0xffu8, 0xd8, 0x00, 0x11, 0x22],
                    )
                        .into_response()
                }),
            ),
    )
    .await;

    let call = channel(&base_url);
    let adapter = for_protocol(Protocol::new("openaiResponses"));

    let asked = generation("describe a lantern", json!({}));
    let answered = adapter
        .generate(&call, &asked, &[], &Cancel::new())
        .await
        .expect("an answer");
    assert_eq!(answered.text.as_deref(), Some("A lantern."));

    let (sink, seen) = watching();
    let streamed = adapter
        .generate_stream(
            &call,
            &generation("describe a lantern", json!({ "stream": true })),
            &[],
            &sink,
            &Cancel::new(),
        )
        .await
        .expect("a stream");
    assert_eq!(streamed.text.as_deref(), Some("A lantern."));
    assert_eq!(*seen.lock().expect("not poisoned"), "A lantern.");

    let speech = ModelCall::new(
        &ResolvedModel {
            config_id: "a-voice".into(),
            model: "gpt-5.5".into(),
            display_name: "A voice".into(),
            category: Capability::Audio,
            protocol: Protocol::new("openaiSpeech"),
            url: format!("{base_url}/v1/audio/speech"),
        },
        API_KEY.to_string(),
        GenerateConfig::default(),
    )
    .expect("a client builds");
    let spoken = adapter
        .generate(
            &speech,
            &GenerateRequest {
                capability: Capability::Audio,
                prompt: "say it".into(),
                ..GenerateRequest::default()
            },
            &[],
            &Cancel::new(),
        )
        .await;
    // Whatever the answer is worth, the call it came from is on the disk.
    let _ = spoken;

    // Three kinds of call, one recording each: a generation, a stream, and
    // the sound the provider answered with, each accounted for.
    let lines = recordings(&root, 3).await;
    assert_eq!(
        lines.len(),
        3,
        "one recording each for the generation, the stream and the speech"
    );

    // The generation: the prompt somebody typed is the whole reason a recording
    // exists, so it is kept here rather than truncated away.
    let generation = find(&lines, "generate");
    let generation_name = generation["name"].as_str().expect("a name");
    let asked_text = std::fs::read_to_string(root.join(format!("{generation_name}.request.json")))
        .expect("the request is on the disk");
    assert!(
        asked_text.contains("describe a lantern"),
        "the prompt is written down whole"
    );
    let answer = read(&root, generation_name, "response");
    assert_eq!(answer["status"], 200);
    assert_eq!(answer["body"]["json"]["output_text"], "A lantern.");

    // The stream: what arrived and what it added up to, kept beside each other,
    // because the interesting failure is the one where the two disagree.
    let stream = find(&lines, "stream");
    let stream_name = stream["name"].as_str().expect("a name");
    let streamed = read(&root, stream_name, "response");
    assert_eq!(streamed["aggregate"], "A lantern.");
    assert_eq!(streamed["body"]["kind"], "text");
    assert!(
        streamed["body"]["text"]
            .as_str()
            .expect("the raw events")
            .contains("data:"),
        "the raw stream is kept beside the reading of it"
    );

    // The speech: a body that is not text lands beside the record as a file of
    // its own and is pointed at, rather than written down as an empty answer.
    let speech = lines
        .iter()
        .find(|line| {
            line["kind"] == "generate"
                && line["url"]
                    .as_str()
                    .map(|url| url.ends_with("/v1/audio/speech"))
                    .unwrap_or(false)
        })
        .expect("the speech call was recorded");
    let speech_name = speech["name"].as_str().expect("a name");
    let spoken = read(&root, speech_name, "response");
    assert_eq!(spoken["body"]["kind"], "binary");
    let sidecar = spoken["body"]["file"].as_str().expect("a sidecar");
    assert_eq!(
        std::fs::read(root.join(sidecar))
            .expect("the bytes are there")
            .len(),
        5,
        "nothing is cut out of a body"
    );

    // The credential: masked in every document a call left behind, so that a
    // recording can be handed to somebody else without handing them the key. The
    // raw media is the one file that is not text and so carries nothing to mask.
    for entry in std::fs::read_dir(&root).expect("the directory is readable") {
        let path = entry.expect("an entry").path();
        if path.extension().map(|ext| ext == "bin").unwrap_or(false) {
            continue;
        }
        let text = std::fs::read_to_string(&path).expect("a recording");
        assert!(
            !text.contains(API_KEY),
            "{} leaks the credential in full",
            path.display()
        );
    }
    let authorization = read(&root, generation_name, "request")["headers"]["authorization"]
        .as_str()
        .expect("the header was recorded")
        .to_string();
    // The mask keeps a recognisable head and tail: the key still says which one
    // it was, without saying what it is.
    assert!(
        authorization.starts_with("Bearer "),
        "the scheme is kept: {authorization}"
    );
    assert!(
        authorization.contains('\u{2026}'),
        "the secret is masked: {authorization}"
    );
    assert!(
        !authorization.contains("1234567890"),
        "the middle of the key is gone: {authorization}"
    );
}
