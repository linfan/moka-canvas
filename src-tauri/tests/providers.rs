//! Provider configuration over the real file store: what the client is shown,
//! what a write refuses, and what survives a restart.
//!
//! The rules that need no storage — reference splitting, capability guesses,
//! URL building — are covered next to the code they belong to, and the wire
//! protocols are covered against a provider standing on localhost.

use std::path::Path;
use std::sync::Arc;

use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use base64::Engine;
use moka_canvas::config::{MetadataConfig, RuntimeMode};
use moka_canvas::domain::Capability;
use moka_canvas::generate::providers::{ProviderRepo, SEED_CHANNEL_ID};
use moka_canvas::metadata::crypto::MASTER_KEY_FILE;
use moka_canvas::metadata::{self, ChannelDraft, ChannelModel, Defaults, MetadataStore, Protocol};
use serde_json::json;

/// Long enough that masking keeps a recognisable head and tail.
const API_KEY: &str = "sk-test-1234567890abcd";

/// Opens a store in server mode, where the master key comes from a file
/// rather than the keychain. The environment is shared across test threads,
/// so it is deliberately not used.
fn repo(root: &Path) -> ProviderRepo {
    std::fs::create_dir_all(root).expect("the metadata directory is created");
    let encoded = base64::engine::general_purpose::STANDARD.encode([7u8; 32]);
    std::fs::write(root.join(MASTER_KEY_FILE), encoded).expect("the master key is written");
    let store = metadata::open(root, &MetadataConfig::default(), RuntimeMode::Web)
        .map(|store| store as Arc<dyn MetadataStore>)
        .expect("the store opens");
    ProviderRepo::new(store)
}

fn model(id: &str, capability: Capability) -> ChannelModel {
    ChannelModel {
        id: id.to_string(),
        capability,
        alias: String::new(),
        enabled: true,
    }
}

/// A channel whose address carries a trailing slash, so every test also proves
/// the value is normalised on the way in.
fn draft(id: &str, models: Vec<ChannelModel>) -> ChannelDraft {
    ChannelDraft {
        id: id.to_string(),
        name: format!("Channel {id}"),
        base_url: "https://provider.test/v1/".to_string(),
        protocol: Protocol::Openai,
        enabled: true,
        models,
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
    repo.upsert_channel(draft("main", vec![model("painter", Capability::Image)]))
        .await
        .unwrap();

    let stored = repo.set_key("main", Some(API_KEY)).await.unwrap();
    assert!(stored.set);
    assert_eq!(stored.masked.as_deref(), Some("sk-…abcd"));

    let rendered = serde_json::to_string(&repo.view().await.unwrap()).unwrap();
    assert!(
        !rendered.contains(API_KEY),
        "the response must not carry the key"
    );
    assert!(rendered.contains("sk-…abcd"));
    assert_eq!(repo.credential("main").await.unwrap(), API_KEY);

    // An empty value clears, so the client never distinguishes blank from gone.
    let cleared = repo.set_key("main", Some("   ")).await.unwrap();
    assert!(!cleared.set);
    assert_eq!(
        repo.credential("main").await.unwrap_err().code(),
        "PROVIDER_NOT_CONFIGURED"
    );
}

#[tokio::test]
async fn a_key_cannot_be_stored_for_a_channel_that_does_not_exist() {
    let root = tempfile::tempdir().unwrap();
    let repo = repo(root.path());
    let error = repo.set_key("ghost", Some(API_KEY)).await.unwrap_err();
    assert_eq!(error.code(), "NOT_FOUND");
}

#[tokio::test]
async fn a_channel_that_is_a_default_cannot_be_deleted() {
    let root = tempfile::tempdir().unwrap();
    let repo = repo(root.path());
    repo.upsert_channel(draft("main", vec![model("painter", Capability::Image)]))
        .await
        .unwrap();
    repo.set_key("main", Some(API_KEY)).await.unwrap();
    repo.set_defaults(&image_default("main::painter"), None)
        .await
        .unwrap();

    let error = repo.delete_channel("main", None).await.unwrap_err();
    assert_eq!(error.code(), "CONFLICT");
    assert_eq!(
        error
            .details()
            .and_then(|details| details.get("defaultFor").cloned()),
        Some(serde_json::json!(["image"])),
        "the client has to be told which default to move first"
    );

    repo.set_defaults(&Defaults::default(), None).await.unwrap();
    repo.delete_channel("main", None).await.unwrap();
    assert!(repo.channel("main").await.is_err());
    assert_eq!(
        repo.credential("main").await.unwrap_err().code(),
        "PROVIDER_NOT_CONFIGURED",
        "deleting a channel takes its credential with it"
    );
}

#[tokio::test]
async fn a_default_has_to_name_a_model_that_can_do_the_job() {
    let root = tempfile::tempdir().unwrap();
    let repo = repo(root.path());
    repo.upsert_channel(draft("main", vec![model("painter", Capability::Image)]))
        .await
        .unwrap();

    let missing = repo
        .set_defaults(&image_default("main::writer"), None)
        .await
        .unwrap_err();
    assert_eq!(missing.code(), "PROVIDER_NOT_CONFIGURED");

    // The same model, asked of a capability it does not serve.
    let mismatched = Defaults {
        text: Some("main::painter".to_string()),
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
    repo.upsert_channel(draft("main", vec![model("painter", Capability::Image)]))
        .await
        .unwrap();
    repo.set_defaults(&image_default("main::painter"), None)
        .await
        .unwrap();

    let resolved = repo.resolve_default(Capability::Image).await.unwrap();
    assert_eq!(resolved.reference, "main::painter");
    assert_eq!(resolved.model_id, "painter");
    assert_eq!(resolved.base_url, "https://provider.test/v1");

    let unset = repo.resolve_default(Capability::Video).await.unwrap_err();
    assert_eq!(unset.code(), "PROVIDER_NOT_CONFIGURED");
}

#[tokio::test]
async fn the_starter_channel_appears_once_and_never_returns() {
    let root = tempfile::tempdir().unwrap();
    let repo = repo(root.path());
    assert!(repo.seed().await.unwrap());
    assert!(!repo.seed().await.unwrap(), "seeding is not repeated");

    let view = repo.view().await.unwrap();
    assert_eq!(view.channels.len(), 1);
    assert_eq!(view.channels[0].id, SEED_CHANNEL_ID);
    assert!(
        !view.channels[0].api_key.set,
        "it starts without a credential"
    );
    assert!(view.channels[0].models.is_empty());

    repo.delete_channel(SEED_CHANNEL_ID, None).await.unwrap();
    assert!(
        !repo.seed().await.unwrap(),
        "a channel the user deleted must not come back"
    );
    assert!(repo.view().await.unwrap().channels.is_empty());
}

#[tokio::test]
async fn a_channel_address_is_normalised_and_checked_on_the_way_in() {
    let root = tempfile::tempdir().unwrap();
    let repo = repo(root.path());

    let padded = draft("main", vec![]);
    let stored = repo.upsert_channel(padded).await.unwrap();
    assert_eq!(stored.base_url, "https://provider.test/v1");

    let mut credentialed = draft("bad", vec![]);
    credentialed.base_url = "https://user:sk-secret@provider.test/v1".to_string();
    let error = repo.upsert_channel(credentialed).await.unwrap_err();
    assert_eq!(error.code(), "VALIDATION_FAILED");
    assert!(!error.to_string().contains("sk-secret"));

    let mut unnameable = draft("worse", vec![]);
    unnameable.base_url = "provider.test/v1".to_string();
    assert_eq!(
        repo.upsert_channel(unnameable).await.unwrap_err().code(),
        "VALIDATION_FAILED"
    );
}

#[tokio::test]
async fn a_write_against_a_stale_revision_is_refused() {
    let root = tempfile::tempdir().unwrap();
    let repo = repo(root.path());
    repo.upsert_channel(draft("main", vec![])).await.unwrap();
    let revision = repo.view().await.unwrap().revision;

    repo.upsert_channel(draft("spare", vec![])).await.unwrap();

    let stale = ChannelDraft {
        expected_revision: Some(revision),
        ..draft("third", vec![])
    };
    assert_eq!(
        repo.upsert_channel(stale).await.unwrap_err().code(),
        "METADATA_CONFLICT"
    );

    let current = ChannelDraft {
        expected_revision: Some(repo.view().await.unwrap().revision),
        ..draft("third", vec![])
    };
    repo.upsert_channel(current).await.unwrap();
}

/// Stands up a provider that answers a model list, so a refresh and a probe
/// can be exercised without the internet.
async fn provider(status: StatusCode, body: serde_json::Value) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("an ephemeral port is available");
    let address = listener.local_addr().expect("the socket has an address");
    let route = get(move || {
        let body = body.clone();
        async move { (status, Json(body)) }
    });
    tokio::spawn(async move {
        let _ = axum::serve(listener, Router::new().route("/v1/models", route)).await;
    });
    format!("http://{address}")
}

/// Points a channel at a local provider and gives it a credential.
async fn connected(repo: &ProviderRepo, id: &str, base_url: String, models: Vec<ChannelModel>) {
    let channel = ChannelDraft {
        base_url,
        ..draft(id, models)
    };
    repo.upsert_channel(channel)
        .await
        .expect("the channel is stored");
    repo.set_key(id, Some(API_KEY))
        .await
        .expect("the credential is stored");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refreshing_a_model_list_stores_the_merged_result() {
    let root = tempfile::tempdir().unwrap();
    let repo = repo(root.path());
    let base_url = provider(
        StatusCode::OK,
        json!({"data": [{"id": "painter"}, {"id": "gpt-image-2"}]}),
    )
    .await;
    connected(
        &repo,
        "main",
        base_url,
        vec![
            model("painter", Capability::Text),
            model("retired", Capability::Text),
        ],
    )
    .await;

    let models = repo.refresh_models("main").await.expect("the list arrives");
    assert_eq!(
        models
            .iter()
            .map(|model| model.id.as_str())
            .collect::<Vec<_>>(),
        ["gpt-image-2", "painter"],
        "the provider's list wins, and a model it dropped goes away"
    );
    let kept = models
        .iter()
        .find(|model| model.id == "painter")
        .expect("still listed");
    assert_eq!(
        kept.capability,
        Capability::Text,
        "a refresh must not undo the user's choice"
    );
    let added = models
        .iter()
        .find(|model| model.id == "gpt-image-2")
        .expect("newly listed");
    assert_eq!(added.capability, Capability::Image);

    assert_eq!(
        repo.channel("main").await.unwrap().models,
        models,
        "the merged list is what got stored"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_probe_reports_a_broken_channel_without_failing_the_request() {
    let root = tempfile::tempdir().unwrap();
    let repo = repo(root.path());

    let healthy = provider(StatusCode::OK, json!({"data": [{"id": "painter"}]})).await;
    connected(&repo, "healthy", healthy, vec![]).await;
    let broken = provider(
        StatusCode::UNAUTHORIZED,
        json!({"error": {"message": "bad key"}}),
    )
    .await;
    connected(&repo, "broken", broken, vec![]).await;

    let report = repo
        .probe("healthy")
        .await
        .expect("the probe itself worked");
    assert!(report.ok);
    assert!(report.error.is_none());

    let report = repo.probe("broken").await.expect("the probe itself worked");
    assert!(!report.ok);
    let failure = report.error.expect("the reason is reported");
    assert_eq!(failure.code, "PROVIDER_AUTH");
    assert!(failure.message.contains("bad key"), "{failure:?}");

    assert!(
        repo.channel("broken").await.unwrap().models.is_empty(),
        "a probe writes nothing"
    );
}

#[tokio::test]
async fn a_channel_with_no_key_reports_the_gap_instead_of_dialling_out() {
    let root = tempfile::tempdir().unwrap();
    let repo = repo(root.path());
    repo.upsert_channel(draft("main", vec![])).await.unwrap();

    let report = repo.probe("main").await.expect("the probe itself worked");
    assert!(!report.ok);
    assert_eq!(
        report.error.expect("the reason is reported").code,
        "PROVIDER_NOT_CONFIGURED"
    );
    assert_eq!(
        repo.refresh_models("main").await.unwrap_err().code(),
        "PROVIDER_NOT_CONFIGURED"
    );
}

#[tokio::test]
async fn a_probe_of_an_unknown_channel_fails_the_request() {
    let root = tempfile::tempdir().unwrap();
    let repo = repo(root.path());
    assert_eq!(repo.probe("ghost").await.unwrap_err().code(), "NOT_FOUND");
}
