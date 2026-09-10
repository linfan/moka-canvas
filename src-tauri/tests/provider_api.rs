//! The provider endpoints over HTTP: what a client is shown, what a partial
//! edit leaves alone, and the places a credential is allowed to appear.
//!
//! The domain rules behind these routes are covered against the store itself;
//! what is checked here is the wire — the shape of a request, the status that
//! comes back, and the body limit that keeps a configuration write from being
//! mistaken for an upload.

use std::path::{Path, PathBuf};

use axum::body::{to_bytes, Body};
use axum::http::{header, Request, StatusCode};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use base64::Engine;
use moka_canvas::api::ApiState;
use moka_canvas::config::{parse_test_config, RuntimeMode};
use moka_canvas::metadata::crypto::MASTER_KEY_FILE;
use moka_canvas::metadata::docs::PROVIDERS_DOC;
use serde_json::{json, Value};
use tower::ServiceExt;

/// Long enough that masking keeps a recognisable head and tail.
const API_KEY: &str = "sk-test-1234567890abcd";

/// The masked form of [`API_KEY`]: three characters, an ellipsis, four.
const MASKED_KEY: &str = "sk-…abcd";

struct Harness {
    app: Router,
    metadata: PathBuf,
}

/// Opens the app over a temporary directory that already holds a master key.
///
/// Server mode refuses to invent one, and most of these tests store a
/// credential. The key file is used rather than the environment variable,
/// which is shared across test threads.
fn harness(root: &Path) -> Harness {
    let config = parse_test_config(root);
    let metadata = config
        .metadata
        .dir
        .clone()
        .expect("the test configuration sets a metadata directory");
    std::fs::create_dir_all(&metadata).expect("the metadata directory is created");
    let encoded = base64::engine::general_purpose::STANDARD.encode([7u8; 32]);
    std::fs::write(metadata.join(MASTER_KEY_FILE), encoded).expect("the master key is written");
    let state = ApiState::new(config, RuntimeMode::Web, &metadata).expect("the store opens");
    Harness {
        app: moka_canvas::server::router(state),
        metadata,
    }
}

fn json_request(method: &str, uri: &str, payload: Value) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::to_vec(&payload).unwrap()))
        .unwrap()
}

fn plain_request(method: &str, uri: &str) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(uri)
        .body(Body::empty())
        .unwrap()
}

async fn send(app: &Router, request: Request<Body>) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(request)
        .await
        .expect("the request is served");
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("the response body is readable");
    let body = serde_json::from_slice(&bytes).expect("the response body is JSON");
    (status, body)
}

/// One channel with a text model and an image model, which is the smallest
/// configuration that can show a default being both set and refused.
fn channel_body(api_key: Option<&str>) -> Value {
    let mut body = json!({
        "id": "main",
        "name": "Main",
        "baseUrl": "https://provider.test/v1",
        "protocol": "openai",
        "enabled": true,
        "models": [
            { "id": "writer", "capability": "text", "alias": "", "enabled": true },
            { "id": "painter", "capability": "image", "alias": "", "enabled": true }
        ]
    });
    if let Some(api_key) = api_key {
        body["apiKey"] = json!(api_key);
    }
    body
}

async fn put_channel(app: &Router, body: Value) -> Value {
    let (status, view) = send(app, json_request("PUT", "/api/v1/providers/channels", body)).await;
    assert_eq!(status, StatusCode::OK, "{view}");
    view
}

/// Starts a throwaway provider that answers a model list, and returns the
/// address a channel would be configured with.
async fn serve_models(status: StatusCode, body: Value) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("an ephemeral port is available");
    let address = listener.local_addr().expect("the socket has an address");
    let routes = Router::new().route(
        "/v1/models",
        get(move || {
            let body = body.clone();
            async move { (status, Json(body)).into_response() }
        }),
    );
    tokio::spawn(async move {
        let _ = axum::serve(listener, routes).await;
    });
    format!("http://{address}")
}

/// A channel pointing at a throwaway provider, already holding a credential.
async fn connected(harness: &Harness, address: &str) -> Value {
    let view = put_channel(
        &harness.app,
        json!({
            "id": "main",
            "name": "Main",
            "baseUrl": address,
            "protocol": "openai",
            "enabled": true,
            "models": [],
            "apiKey": API_KEY
        }),
    )
    .await;
    assert_eq!(view["channels"][0]["apiKey"]["set"], true, "{view}");
    view
}

#[tokio::test]
async fn a_fresh_install_reports_an_empty_configuration() {
    let root = tempfile::tempdir().unwrap();
    let harness = harness(root.path());

    let (status, body) = send(&harness.app, plain_request("GET", "/api/v1/providers")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["version"], 1);
    assert_eq!(body["revision"], 0);
    assert_eq!(body["channels"], json!([]));
    assert_eq!(body["defaults"]["image"], Value::Null);
    // The built-in preferences arrive with the document, so a client has
    // nothing to invent before the first save.
    assert_eq!(body["preferences"]["reasoningEffort"], "auto");
    assert_eq!(body["preferences"]["image"]["count"], 1);
    assert_eq!(body["preferences"]["video"]["seconds"], 6);
    assert_eq!(body["preferences"]["audio"]["speed"], 1.0);
}

#[tokio::test]
async fn a_credential_is_neither_returned_nor_left_in_the_configuration() {
    let root = tempfile::tempdir().unwrap();
    let harness = harness(root.path());

    let response = harness
        .app
        .clone()
        .oneshot(json_request(
            "PUT",
            "/api/v1/providers/channels",
            channel_body(Some(API_KEY)),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("the response body is readable");
    let raw = String::from_utf8(bytes.to_vec()).unwrap();
    let body: Value = serde_json::from_str(&raw).unwrap();

    assert_eq!(body["channels"][0]["apiKey"]["set"], true);
    assert_eq!(body["channels"][0]["apiKey"]["masked"], MASKED_KEY);
    assert!(
        !raw.contains(API_KEY),
        "the response carries the key: {raw}"
    );

    // The channel document is what a backup or a sync would pick up, so it
    // must not even have a field for the credential.
    let stored = std::fs::read_to_string(harness.metadata.join(PROVIDERS_DOC)).unwrap();
    assert!(!stored.contains(API_KEY), "{stored}");
    assert!(!stored.contains("apiKey"), "{stored}");
}

#[tokio::test]
async fn an_edit_that_does_not_carry_a_credential_keeps_the_stored_one() {
    let root = tempfile::tempdir().unwrap();
    let harness = harness(root.path());
    put_channel(&harness.app, channel_body(Some(API_KEY))).await;

    // A form re-submits with an empty key field after every unrelated edit;
    // reading that as a removal would break a working channel silently.
    let view = put_channel(&harness.app, channel_body(Some("   "))).await;
    assert_eq!(view["channels"][0]["apiKey"]["masked"], MASKED_KEY);

    let mut renamed = channel_body(None);
    renamed["name"] = json!("Renamed");
    let view = put_channel(&harness.app, renamed).await;
    assert_eq!(view["channels"][0]["name"], "Renamed");
    assert_eq!(view["channels"][0]["apiKey"]["set"], true);
}

#[tokio::test]
async fn clearing_a_credential_is_an_explicit_call() {
    let root = tempfile::tempdir().unwrap();
    let harness = harness(root.path());
    put_channel(&harness.app, channel_body(Some(API_KEY))).await;

    let (status, view) = send(
        &harness.app,
        json_request(
            "POST",
            "/api/v1/providers/channels/main/key",
            json!({ "apiKey": null }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(view["channels"][0]["apiKey"]["set"], false);
    assert_eq!(view["channels"][0]["apiKey"]["masked"], Value::Null);

    // Aimed at a channel that is not there, a clear would otherwise report a
    // removal that did not happen and leave the real credential in place.
    let (status, problem) = send(
        &harness.app,
        json_request(
            "POST",
            "/api/v1/providers/channels/nope/key",
            json!({ "apiKey": null }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(problem["code"], "NOT_FOUND");
}

#[tokio::test]
async fn a_partial_default_edit_leaves_the_other_capabilities_alone() {
    let root = tempfile::tempdir().unwrap();
    let harness = harness(root.path());
    put_channel(&harness.app, channel_body(None)).await;

    let (status, view) = send(
        &harness.app,
        json_request(
            "PATCH",
            "/api/v1/providers/defaults",
            json!({ "image": "main::painter" }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(view["defaults"]["image"], "main::painter");
    assert_eq!(view["defaults"]["text"], Value::Null);

    let (_, view) = send(
        &harness.app,
        json_request(
            "PATCH",
            "/api/v1/providers/defaults",
            json!({ "text": "main::writer" }),
        ),
    )
    .await;
    assert_eq!(view["defaults"]["text"], "main::writer");
    assert_eq!(
        view["defaults"]["image"], "main::painter",
        "a capability the body does not mention keeps its value"
    );

    // Clearing is asked for with null, which is not the same as leaving out.
    let (_, view) = send(
        &harness.app,
        json_request(
            "PATCH",
            "/api/v1/providers/defaults",
            json!({ "image": null }),
        ),
    )
    .await;
    assert_eq!(view["defaults"]["image"], Value::Null);
    assert_eq!(view["defaults"]["text"], "main::writer");
}

#[tokio::test]
async fn a_default_has_to_name_a_model_that_serves_the_capability() {
    let root = tempfile::tempdir().unwrap();
    let harness = harness(root.path());
    put_channel(&harness.app, channel_body(None)).await;

    let (status, problem) = send(
        &harness.app,
        json_request(
            "PATCH",
            "/api/v1/providers/defaults",
            json!({ "image": "main::writer" }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(problem["code"], "MODEL_CAPABILITY_MISMATCH");
    assert_eq!(problem["details"]["reference"], "main::writer");
    assert_eq!(problem["details"]["requested"], "image");
    assert_eq!(problem["details"]["actual"], "text");
}

#[tokio::test]
async fn a_channel_still_somebodys_default_cannot_be_deleted() {
    let root = tempfile::tempdir().unwrap();
    let harness = harness(root.path());
    put_channel(&harness.app, channel_body(Some(API_KEY))).await;
    send(
        &harness.app,
        json_request(
            "PATCH",
            "/api/v1/providers/defaults",
            json!({ "image": "main::painter" }),
        ),
    )
    .await;

    let (status, problem) = send(
        &harness.app,
        plain_request("DELETE", "/api/v1/providers/channels/main"),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(problem["code"], "CONFLICT");
    assert_eq!(problem["details"]["defaultFor"], json!(["image"]));

    // Once nothing points at it the channel goes, and the revision the client
    // last read is what it says so with.
    let (_, view) = send(
        &harness.app,
        json_request(
            "PATCH",
            "/api/v1/providers/defaults",
            json!({ "image": null }),
        ),
    )
    .await;
    let revision = view["revision"].as_u64().unwrap();
    let (status, view) = send(
        &harness.app,
        plain_request(
            "DELETE",
            &format!("/api/v1/providers/channels/main?revision={revision}"),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(view["channels"], json!([]));
}

#[tokio::test]
async fn a_write_against_a_stale_revision_is_refused() {
    let root = tempfile::tempdir().unwrap();
    let harness = harness(root.path());
    let view = put_channel(&harness.app, channel_body(None)).await;
    assert!(view["revision"].as_u64().unwrap() > 0);

    let mut stale = channel_body(None);
    stale["name"] = json!("Stale");
    stale["expectedRevision"] = json!(0);
    let (status, problem) = send(
        &harness.app,
        json_request("PUT", "/api/v1/providers/channels", stale),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(problem["code"], "METADATA_CONFLICT");

    let (_, view) = send(&harness.app, plain_request("GET", "/api/v1/providers")).await;
    assert_eq!(view["channels"][0]["name"], "Main");
}

#[tokio::test]
async fn a_partial_preference_edit_keeps_the_rest() {
    let root = tempfile::tempdir().unwrap();
    let harness = harness(root.path());

    let (status, view) = send(
        &harness.app,
        json_request(
            "PATCH",
            "/api/v1/providers/preferences",
            json!({ "systemPrompt": "Keep it short" }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(view["preferences"]["systemPrompt"], "Keep it short");
    assert_eq!(view["preferences"]["reasoningEffort"], "auto");
    assert_eq!(view["preferences"]["image"]["count"], 1);

    // A group is replaced whole; what sits beside it is not.
    let (_, view) = send(
        &harness.app,
        json_request(
            "PATCH",
            "/api/v1/providers/preferences",
            json!({
                "image": {
                    "size": "16:9",
                    "quality": "high",
                    "background": "transparent",
                    "count": 4
                }
            }),
        ),
    )
    .await;
    assert_eq!(view["preferences"]["image"]["size"], "16:9");
    assert_eq!(view["preferences"]["image"]["count"], 4);
    assert_eq!(view["preferences"]["systemPrompt"], "Keep it short");
    assert_eq!(view["preferences"]["video"]["seconds"], 6);
}

#[tokio::test]
async fn a_preference_outside_its_bounds_is_refused() {
    let root = tempfile::tempdir().unwrap();
    let harness = harness(root.path());

    let (status, problem) = send(
        &harness.app,
        json_request(
            "PATCH",
            "/api/v1/providers/preferences",
            json!({
                "image": { "size": "1:1", "quality": "auto", "background": "", "count": 99 }
            }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(problem["code"], "VALIDATION_FAILED");

    let (_, view) = send(&harness.app, plain_request("GET", "/api/v1/providers")).await;
    assert_eq!(view["preferences"]["image"]["count"], 1);
}

#[tokio::test]
async fn a_configuration_write_is_capped_well_below_an_upload() {
    let root = tempfile::tempdir().unwrap();
    let harness = harness(root.path());

    let mut body = channel_body(None);
    body["name"] = json!("n".repeat(2 * 1024 * 1024));
    let (status, problem) = send(
        &harness.app,
        json_request("PUT", "/api/v1/providers/channels", body),
    )
    .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(problem["code"], "PAYLOAD_TOO_LARGE");
}

#[tokio::test]
async fn the_channel_routes_refuse_an_identifier_that_is_not_there() {
    let root = tempfile::tempdir().unwrap();
    let harness = harness(root.path());

    for (method, uri) in [
        ("GET", "/api/v1/providers/channels/nope/models"),
        ("POST", "/api/v1/providers/channels/nope/models/refresh"),
        ("POST", "/api/v1/providers/channels/nope/probe"),
    ] {
        let (status, problem) = send(&harness.app, plain_request(method, uri)).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{method} {uri}");
        assert_eq!(problem["code"], "NOT_FOUND", "{method} {uri}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_model_list_arrives_as_a_suggestion_and_changes_nothing() {
    let root = tempfile::tempdir().unwrap();
    let harness = harness(root.path());
    let address = serve_models(
        StatusCode::OK,
        json!({
            "object": "list",
            "data": [ { "id": "gpt-image-2" }, { "id": "gpt-5.5" } ]
        }),
    )
    .await;
    connected(&harness, &address).await;

    let (status, body) = send(
        &harness.app,
        plain_request("GET", "/api/v1/providers/channels/main/models"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["models"],
        json!([
            { "id": "gpt-5.5", "capability": null },
            { "id": "gpt-image-2", "capability": "image" }
        ])
    );

    // Fetching is a read. What each model is for is still the user's call,
    // and saving the channel is what records it.
    let (_, view) = send(&harness.app, plain_request("GET", "/api/v1/providers")).await;
    assert_eq!(view["channels"][0]["models"], json!([]));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refreshing_a_model_list_is_a_write_that_answers_with_the_view() {
    let root = tempfile::tempdir().unwrap();
    let harness = harness(root.path());
    let address = serve_models(
        StatusCode::OK,
        json!({
            "object": "list",
            "data": [ { "id": "gpt-image-2" }, { "id": "gpt-5.5" } ]
        }),
    )
    .await;
    let before = connected(&harness, &address).await;
    let revision = before["revision"].as_u64().expect("a revision");

    let (status, view) = send(
        &harness.app,
        plain_request(
            "POST",
            &format!("/api/v1/providers/channels/main/models/refresh?revision={revision}"),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{view}");
    // The suggestions became the stored list, which is the whole difference
    // between this and the read above.
    assert_eq!(
        view["channels"][0]["models"],
        json!([
            { "id": "gpt-5.5", "capability": "text", "alias": "", "enabled": true },
            { "id": "gpt-image-2", "capability": "image", "alias": "", "enabled": true }
        ])
    );

    // And it is checked against the revision like every other write.
    let (status, problem) = send(
        &harness.app,
        plain_request(
            "POST",
            &format!("/api/v1/providers/channels/main/models/refresh?revision={revision}"),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{problem}");
    assert_eq!(problem["code"], "METADATA_CONFLICT");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_probe_reports_a_refusing_channel_inside_a_successful_response() {
    let root = tempfile::tempdir().unwrap();
    let harness = harness(root.path());
    let address = serve_models(
        StatusCode::UNAUTHORIZED,
        json!({ "error": { "message": "Incorrect API key provided" } }),
    )
    .await;
    connected(&harness, &address).await;

    let (status, report) = send(
        &harness.app,
        plain_request("POST", "/api/v1/providers/channels/main/probe"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(report["ok"], false);
    assert_eq!(report["error"]["code"], "PROVIDER_AUTH");
    assert!(
        report["error"]["message"]
            .as_str()
            .unwrap()
            .contains("Incorrect API key provided"),
        "{report}"
    );
    assert!(report["latencyMs"].is_number());
}

#[tokio::test]
async fn a_quick_import_derives_a_channel_from_its_address() {
    let root = tempfile::tempdir().unwrap();
    let harness = harness(root.path());

    let (status, view) = send(
        &harness.app,
        json_request(
            "POST",
            "/api/v1/providers/import",
            json!({
                "baseUrl": "https://generativelanguage.googleapis.com/v1beta/",
                "apiKey": API_KEY
            }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let channel = &view["channels"][0];
    assert_eq!(channel["id"], "generativelanguage-googleapis-com");
    assert_eq!(channel["name"], "generativelanguage.googleapis.com");
    assert_eq!(channel["protocol"], "gemini");
    assert_eq!(
        channel["baseUrl"],
        "https://generativelanguage.googleapis.com/v1beta"
    );
    assert_eq!(channel["apiKey"]["masked"], MASKED_KEY);

    // The same address again is an update, not a second channel, and arriving
    // without a credential does not cost the one already stored.
    let (_, view) = send(
        &harness.app,
        json_request(
            "POST",
            "/api/v1/providers/import",
            json!({
                "baseUrl": "https://generativelanguage.googleapis.com/v1beta",
                "name": "Gemini"
            }),
        ),
    )
    .await;
    assert_eq!(view["channels"].as_array().unwrap().len(), 1);
    assert_eq!(view["channels"][0]["name"], "Gemini");
    assert_eq!(view["channels"][0]["apiKey"]["masked"], MASKED_KEY);
}
