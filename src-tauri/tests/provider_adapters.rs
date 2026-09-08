//! The protocol adapters against a provider standing on localhost.
//!
//! A real socket rather than a stub: what these tests have to prove is the
//! URL that gets built, where the credential travels, and what comes back.

use std::sync::{Arc, Mutex};

use axum::extract::{RawQuery, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use moka_canvas::generate::adapters::list_models;
use moka_canvas::metadata::Protocol;
use serde_json::json;

/// Long enough that masking keeps a recognisable head and tail.
const API_KEY: &str = "sk-test-1234567890abcd";

#[derive(Clone, Default)]
struct Recorded(Arc<Mutex<Headers>>);

#[derive(Clone, Default)]
struct Headers {
    authorization: Option<String>,
    api_key: Option<String>,
    query: Option<String>,
}

impl Recorded {
    fn note(&self, headers: &HeaderMap, query: Option<String>) {
        let mut recorded = self.0.lock().expect("the recording is not poisoned");
        recorded.authorization = headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        recorded.api_key = headers
            .get("x-goog-api-key")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        recorded.query = query;
    }

    fn headers(&self) -> Headers {
        self.0
            .lock()
            .expect("the recording is not poisoned")
            .clone()
    }
}

/// Starts a throwaway provider and returns the address a channel would be
/// configured with.
async fn serve(recorded: Recorded, routes: Router<Recorded>) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("an ephemeral port is available");
    let address = listener.local_addr().expect("the socket has an address");
    tokio::spawn(async move {
        let _ = axum::serve(listener, routes.with_state(recorded)).await;
    });
    format!("http://{address}")
}

async fn openai_models(
    State(recorded): State<Recorded>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
) -> Json<serde_json::Value> {
    recorded.note(&headers, query);
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
    State(recorded): State<Recorded>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
) -> Json<serde_json::Value> {
    recorded.note(&headers, query);
    Json(json!({
        "models": [
            { "name": "models/gemini-2.5-flash" },
            { "name": "imagen-4" },
            { "name": "models/" }
        ]
    }))
}

async fn refuse(status: StatusCode, body: serde_json::Value) -> Response {
    (status, Json(body)).into_response()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_openai_compatible_channel_lists_its_models() {
    let recorded = Recorded::default();
    let base_url = serve(
        recorded.clone(),
        Router::new().route("/v1/models", get(openai_models)),
    )
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
    let address = serve(
        recorded,
        Router::new().route("/v1/models", get(openai_models)),
    )
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
    let base_url = serve(
        recorded.clone(),
        Router::new().route("/v1beta/models", get(gemini_models)),
    )
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
    let recorded = Recorded::default();
    let base_url = serve(
        recorded,
        Router::new().route(
            "/v1/models",
            get(|| async {
                refuse(
                    StatusCode::UNAUTHORIZED,
                    json!({"error": {"message": "Incorrect API key provided", "type": "invalid_request_error"}}),
                )
                .await
            }),
        ),
    )
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
    let recorded = Recorded::default();
    let base_url = serve(
        recorded,
        Router::new().route(
            "/v1/models",
            get(|| async {
                refuse(
                    StatusCode::TOO_MANY_REQUESTS,
                    json!({"error": {"message": "rate limit reached"}}),
                )
                .await
            }),
        ),
    )
    .await;

    let error = list_models(Protocol::Openai, &base_url, API_KEY)
        .await
        .expect_err("the provider is busy");

    assert_eq!(error.code(), "PROVIDER_RATE_LIMIT");
    assert!(error.retryable());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_provider_that_echoes_the_key_back_does_not_leak_it() {
    let recorded = Recorded::default();
    let base_url = serve(
        recorded,
        Router::new().route(
            "/v1/models",
            get(|| async {
                refuse(
                    StatusCode::BAD_REQUEST,
                    json!({"error": {"message": format!("credential {API_KEY} is not recognised")}}),
                )
                .await
            }),
        ),
    )
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
    let recorded = Recorded::default();
    let base_url = serve(
        recorded,
        Router::new().route(
            "/v1/models",
            get(|| async { (StatusCode::OK, "<html>502 from the proxy</html>") }),
        ),
    )
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
