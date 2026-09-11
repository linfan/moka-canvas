//! Model configuration over the real file store: what the client is shown,
//! what a write refuses, and what survives a restart.
//!
//! The rules that need no storage — URL derivation, identifier shape — are
//! covered next to the code they belong to, and the wire protocols are
//! covered against a provider standing on localhost.

use std::path::Path;
use std::sync::Arc;

use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use base64::Engine;
use moka_canvas::config::{MetadataConfig, RuntimeMode};
use moka_canvas::domain::Capability;
use moka_canvas::generate::models::{ModelRepo, SEED_MODEL_ID};
use moka_canvas::metadata::crypto::MASTER_KEY_FILE;
use moka_canvas::metadata::{self, Defaults, MetadataStore, ModelDraft, Protocol};
use serde_json::json;

/// Long enough that masking keeps a recognisable head and tail.
const API_KEY: &str = "sk-test-1234567890abcd";

/// Opens a store in server mode, where the master key comes from a file
/// rather than the keychain. The environment is shared across test threads,
/// so it is deliberately not used.
fn repo(root: &Path) -> ModelRepo {
    std::fs::create_dir_all(root).expect("the metadata directory is created");
    let encoded = base64::engine::general_purpose::STANDARD.encode([7u8; 32]);
    std::fs::write(root.join(MASTER_KEY_FILE), encoded).expect("the master key is written");
    let store = metadata::open(root, &MetadataConfig::default(), RuntimeMode::Web)
        .map(|store| store as Arc<dyn MetadataStore>)
        .expect("the store opens");
    ModelRepo::new(store)
}

/// One model configuration. The URL carries a trailing slash, so every test
/// also proves the value is normalised on the way in.
fn draft(id: &str, category: Capability) -> ModelDraft {
    let (protocol, url) = match category {
        Capability::Text => (
            Protocol::OpenaiChat,
            "https://provider.test/v1/chat/completions/",
        ),
        Capability::Image => (
            Protocol::OpenaiImages,
            "https://provider.test/v1/images/generations/",
        ),
        Capability::Audio => (
            Protocol::OpenaiSpeech,
            "https://provider.test/v1/audio/speech/",
        ),
        Capability::Video => (Protocol::OpenaiVideos, "https://provider.test/v1/videos/"),
    };
    ModelDraft {
        id: id.to_string(),
        category,
        protocol,
        url: url.to_string(),
        model: format!("model-{id}"),
        display_name: format!("Model {id}"),
        enabled: true,
        expected_revision: None,
    }
}

fn image_default(reference: &str) -> Defaults {
    Defaults {
        image: Some(reference.to_string()),
        ..Default::default()
    }
}

#[tokio::test]
async fn a_stored_key_is_disclosed_only_as_its_masked_form() {
    let root = tempfile::tempdir().unwrap();
    let repo = repo(root.path());
    repo.upsert(draft("painter", Capability::Image))
        .await
        .unwrap();

    let stored = repo.set_key("painter", Some(API_KEY)).await.unwrap();
    assert!(stored.set);
    assert_eq!(stored.masked.as_deref(), Some("sk-…abcd"));

    let rendered = serde_json::to_string(&repo.view().await.unwrap()).unwrap();
    assert!(
        !rendered.contains(API_KEY),
        "the response must not carry the key"
    );
    assert!(rendered.contains("sk-…abcd"));
    assert_eq!(repo.credential("painter").await.unwrap(), API_KEY);

    // An empty value clears, so the client never distinguishes blank from gone.
    let cleared = repo.set_key("painter", Some("   ")).await.unwrap();
    assert!(!cleared.set);
    assert_eq!(
        repo.credential("painter").await.unwrap_err().code(),
        "PROVIDER_NOT_CONFIGURED"
    );
}

#[tokio::test]
async fn a_key_cannot_be_stored_for_a_model_that_does_not_exist() {
    let root = tempfile::tempdir().unwrap();
    let repo = repo(root.path());
    let error = repo.set_key("ghost", Some(API_KEY)).await.unwrap_err();
    assert_eq!(error.code(), "NOT_FOUND");
}

#[tokio::test]
async fn a_model_that_is_a_default_cannot_be_deleted() {
    let root = tempfile::tempdir().unwrap();
    let repo = repo(root.path());
    repo.upsert(draft("painter", Capability::Image))
        .await
        .unwrap();
    repo.set_key("painter", Some(API_KEY)).await.unwrap();
    repo.set_defaults(&image_default("painter"), None)
        .await
        .unwrap();

    let error = repo.delete("painter", None).await.unwrap_err();
    assert_eq!(error.code(), "CONFLICT");
    assert_eq!(
        error.details().and_then(|d| d.get("modelId").cloned()),
        Some(json!("painter"))
    );

    // Clearing the default releases it, key and all.
    repo.set_defaults(&Defaults::default(), None).await.unwrap();
    repo.delete("painter", None).await.unwrap();
    assert!(repo.view().await.unwrap().models.is_empty());
    assert_eq!(
        repo.credential("painter").await.unwrap_err().code(),
        "PROVIDER_NOT_CONFIGURED"
    );
}

#[tokio::test]
async fn a_default_has_to_name_a_model_that_can_do_the_job() {
    let root = tempfile::tempdir().unwrap();
    let repo = repo(root.path());
    repo.upsert(draft("painter", Capability::Image))
        .await
        .unwrap();

    let missing = repo
        .set_defaults(&image_default("writer"), None)
        .await
        .unwrap_err();
    assert_eq!(missing.code(), "PROVIDER_NOT_CONFIGURED");

    // The same model, asked of a category it does not serve.
    let mismatched = Defaults {
        text: Some("painter".to_string()),
        ..Default::default()
    };
    let error = repo.set_defaults(&mismatched, None).await.unwrap_err();
    assert_eq!(error.code(), "MODEL_CAPABILITY_MISMATCH");

    assert_eq!(
        repo.view().await.unwrap().defaults,
        Defaults::default(),
        "a refused default must not be written"
    );
}

#[tokio::test]
async fn resolution_follows_the_configured_default() {
    let root = tempfile::tempdir().unwrap();
    let repo = repo(root.path());
    repo.upsert(draft("painter", Capability::Image))
        .await
        .unwrap();
    repo.set_defaults(&image_default("painter"), None)
        .await
        .unwrap();

    let resolved = repo.resolve_default(Capability::Image).await.unwrap();
    assert_eq!(resolved.config_id, "painter");
    assert_eq!(resolved.model, "model-painter");
    assert_eq!(resolved.protocol, Protocol::OpenaiImages);
    assert_eq!(resolved.url, "https://provider.test/v1/images/generations");

    let unset = repo.resolve_default(Capability::Video).await.unwrap_err();
    assert_eq!(unset.code(), "PROVIDER_NOT_CONFIGURED");
}

#[tokio::test]
async fn the_starter_model_appears_once_and_never_returns() {
    let root = tempfile::tempdir().unwrap();
    let repo = repo(root.path());
    assert!(repo.seed().await.unwrap());
    assert!(!repo.seed().await.unwrap(), "seeding is not repeated");

    let view = repo.view().await.unwrap();
    assert_eq!(view.models.len(), 1);
    assert_eq!(view.models[0].id, SEED_MODEL_ID);
    assert_eq!(view.models[0].category, Capability::Text);
    assert!(
        !view.models[0].api_key.set,
        "it starts without a credential"
    );

    repo.delete(SEED_MODEL_ID, None).await.unwrap();
    assert!(
        !repo.seed().await.unwrap(),
        "a model the user deleted must not come back"
    );
    assert!(repo.view().await.unwrap().models.is_empty());
}

#[tokio::test]
async fn a_model_address_is_normalised_and_checked_on_the_way_in() {
    let root = tempfile::tempdir().unwrap();
    let repo = repo(root.path());

    let stored = repo.upsert(draft("main", Capability::Text)).await.unwrap();
    assert_eq!(stored.url, "https://provider.test/v1/chat/completions");

    let mut credentialed = draft("bad", Capability::Text);
    credentialed.url = "https://user:sk-secret@provider.test/v1/chat/completions".to_string();
    let error = repo.upsert(credentialed).await.unwrap_err();
    assert_eq!(error.code(), "VALIDATION_FAILED");
    assert!(!error.to_string().contains("sk-secret"));

    let mut unnameable = draft("worse", Capability::Text);
    unnameable.url = "provider.test/v1/chat/completions".to_string();
    assert_eq!(
        repo.upsert(unnameable).await.unwrap_err().code(),
        "VALIDATION_FAILED"
    );
}

#[tokio::test]
async fn a_protocol_the_category_does_not_offer_is_refused() {
    let root = tempfile::tempdir().unwrap();
    let repo = repo(root.path());

    // A chat endpoint cannot serve a video model, whatever its address says.
    let mismatched = ModelDraft {
        protocol: Protocol::OpenaiChat,
        ..draft("shot", Capability::Video)
    };
    let error = repo.upsert(mismatched).await.unwrap_err();
    assert_eq!(error.code(), "VALIDATION_FAILED");
    assert!(error.to_string().contains("video"), "{error}");
}

#[tokio::test]
async fn a_write_against_a_stale_revision_is_refused() {
    let root = tempfile::tempdir().unwrap();
    let repo = repo(root.path());
    repo.upsert(draft("main", Capability::Text)).await.unwrap();
    let revision = repo.view().await.unwrap().revision;

    repo.upsert(draft("spare", Capability::Text)).await.unwrap();

    let stale = ModelDraft {
        expected_revision: Some(revision),
        ..draft("third", Capability::Text)
    };
    assert_eq!(
        repo.upsert(stale).await.unwrap_err().code(),
        "METADATA_CONFLICT"
    );

    let current = ModelDraft {
        expected_revision: Some(repo.view().await.unwrap().revision),
        ..draft("third", Capability::Text)
    };
    repo.upsert(current).await.unwrap();
}

#[tokio::test]
async fn a_copy_carries_the_configuration_and_the_key() {
    let root = tempfile::tempdir().unwrap();
    let repo = repo(root.path());
    repo.upsert(draft("painter", Capability::Image))
        .await
        .unwrap();
    repo.set_key("painter", Some(API_KEY)).await.unwrap();

    let copy = repo.duplicate("painter", None).await.unwrap();
    assert_eq!(copy.id, "painter-copy");
    assert_eq!(copy.url, "https://provider.test/v1/images/generations");
    assert_eq!(copy.display_name, "Model painter (copy)");
    assert_eq!(repo.credential("painter-copy").await.unwrap(), API_KEY);

    // A second copy does not collide with the first.
    let second = repo.duplicate("painter", None).await.unwrap();
    assert_eq!(second.id, "painter-copy-2");

    let view = repo.view().await.unwrap();
    assert_eq!(view.models.len(), 3);
    assert!(view
        .models
        .iter()
        .all(|model| model.api_key.set || model.id == "painter"));
}

#[tokio::test]
async fn a_copy_of_a_model_that_does_not_exist_is_refused() {
    let root = tempfile::tempdir().unwrap();
    let repo = repo(root.path());
    let error = repo.duplicate("ghost", None).await.unwrap_err();
    assert_eq!(error.code(), "NOT_FOUND");
}

/// Stands up a provider that answers a model list, so a probe has something
/// real to ask. Returns the base address the configured endpoint is built on.
async fn provider(status: StatusCode, body: serde_json::Value) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("an ephemeral port is available");
    let address = listener.local_addr().expect("the socket has an address");
    tokio::spawn(async move {
        let app = Router::new().route(
            "/v1/models",
            get(move || async move { (status, Json(body)) }),
        );
        let _ = axum::serve(listener, app).await;
    });
    format!("http://{address}")
}

/// Stores a text model whose endpoint sits on the throwaway provider, with a
/// key, the way a working configuration looks.
async fn connected(repo: &ModelRepo, id: &str, base_url: &str) {
    repo.upsert(ModelDraft {
        id: id.to_string(),
        url: format!("{base_url}/v1/chat/completions"),
        model: id.to_string(),
        display_name: format!("Model {id}"),
        category: Capability::Text,
        protocol: Protocol::OpenaiChat,
        enabled: true,
        expected_revision: None,
    })
    .await
    .expect("the model is stored");
    repo.set_key(id, Some(API_KEY))
        .await
        .expect("the key is stored");
}

#[tokio::test]
async fn a_probe_reports_a_broken_model_without_failing_the_request() {
    let root = tempfile::tempdir().unwrap();
    let repo = repo(root.path());
    let base_url = provider(
        StatusCode::UNAUTHORIZED,
        json!({ "error": { "message": "incorrect API key" } }),
    )
    .await;
    connected(&repo, "main", &base_url).await;

    // The refusal is the answer, not a failed request: the settings list has
    // to render it beside the model it is about.
    let report = repo.probe("main").await.expect("the probe itself succeeds");
    assert!(!report.ok);
    let error = report.error.expect("a broken probe explains itself");
    assert_eq!(error.code, "PROVIDER_AUTH");
}

#[tokio::test]
async fn a_reachable_provider_probes_ok() {
    let root = tempfile::tempdir().unwrap();
    let repo = repo(root.path());
    let base_url = provider(StatusCode::OK, json!({ "data": [] })).await;
    connected(&repo, "main", &base_url).await;

    let report = repo.probe("main").await.unwrap();
    assert!(report.ok, "{report:?}");
}

#[tokio::test]
async fn a_model_with_no_key_reports_the_gap_instead_of_dialling_out() {
    let root = tempfile::tempdir().unwrap();
    let repo = repo(root.path());
    let base_url = provider(StatusCode::OK, json!({ "data": [] })).await;
    repo.upsert(ModelDraft {
        id: "keyless".to_string(),
        url: format!("{base_url}/v1/chat/completions"),
        model: "keyless".to_string(),
        display_name: "Keyless".to_string(),
        category: Capability::Text,
        protocol: Protocol::OpenaiChat,
        enabled: true,
        expected_revision: None,
    })
    .await
    .unwrap();

    let report = repo.probe("keyless").await.unwrap();
    assert!(!report.ok);
    assert_eq!(
        report.error.expect("explained").code,
        "PROVIDER_NOT_CONFIGURED"
    );
}

#[tokio::test]
async fn a_probe_of_an_unknown_model_fails_the_request() {
    let root = tempfile::tempdir().unwrap();
    let repo = repo(root.path());
    let error = repo.probe("ghost").await.unwrap_err();
    assert_eq!(error.code(), "NOT_FOUND");
}
