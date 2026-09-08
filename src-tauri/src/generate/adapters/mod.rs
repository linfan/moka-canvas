//! The wire protocols a channel can speak.
//!
//! One module per protocol, all behind the same call, so nothing above this
//! branches on the protocol itself. Listing models is the only operation
//! today; generation arrives with the gateway that runs it.

mod gemini;
mod openai;

use std::time::Duration;

use crate::metadata::Protocol;

use super::error::ProviderError;

/// A model list is a small request, and a provider that cannot answer one in
/// this long is not about to finish a generation.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// A channel address is supplied by the user, so whatever answers at it is
/// untrusted input rather than a provider's well-formed document.
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

/// How much of a provider's complaint reaches a problem body and a log line.
const MAX_DETAIL_CHARS: usize = 300;

/// Shortest credential worth scrubbing out of a message that echoes it. A
/// shorter one could match ordinary words and mangle the explanation.
const MIN_SCRUBBED_KEY_CHARS: usize = 8;

const USER_AGENT: &str = concat!("moka-canvas/", env!("CARGO_PKG_VERSION"));

/// Asks a provider what it currently offers, sorted and without duplicates.
pub async fn list_models(
    protocol: Protocol,
    base_url: &str,
    api_key: &str,
) -> Result<Vec<String>, ProviderError> {
    let mut ids = match protocol {
        Protocol::Openai => openai::list_models(base_url, api_key).await?,
        Protocol::Gemini => gemini::list_models(base_url, api_key).await?,
        Protocol::Custom => {
            return Err(ProviderError::invalid(
                "the custom protocol is reserved and has no implementation",
            ))
        }
    };
    ids.sort();
    ids.dedup();
    Ok(ids)
}

fn client() -> Result<reqwest::Client, ProviderError> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| ProviderError::Unreachable(error.to_string()))
}

/// Runs a request and reduces the answer to a status and a body. The body is
/// read on both paths, because a provider explains a failure in it.
async fn exchange(request: reqwest::RequestBuilder) -> Result<(u16, String), ProviderError> {
    let response = request.send().await.map_err(transport)?;
    let status = response.status().as_u16();
    let body = read_body(response).await?;
    Ok((status, body))
}

fn succeeded(status: u16) -> bool {
    (200..300).contains(&status)
}

/// A body that is not a model list at all — usually an HTML error page from a
/// proxy sitting in front of the provider.
fn not_a_model_list(error: serde_json::Error) -> ProviderError {
    ProviderError::Rejected(format!("the model list is not the expected JSON: {error}"))
}

fn transport(error: reqwest::Error) -> ProviderError {
    if error.is_timeout() {
        ProviderError::Timeout(format!(
            "no answer within {} seconds",
            REQUEST_TIMEOUT.as_secs()
        ))
    } else if error.is_builder() {
        // A credential carrying a newline is a stored-value problem rather
        // than an outage, and saying so stops a client from retrying it.
        ProviderError::invalid(error.to_string())
    } else {
        // reqwest names the address and the reason here. Neither is secret:
        // credentials travel in headers, never in a URL.
        ProviderError::Unreachable(error.to_string())
    }
}

async fn read_body(response: reqwest::Response) -> Result<String, ProviderError> {
    let mut response = response;
    let mut bytes: Vec<u8> = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| ProviderError::Unreachable(error.to_string()))?
    {
        bytes.extend_from_slice(&chunk);
        if bytes.len() > MAX_RESPONSE_BYTES {
            return Err(ProviderError::Rejected(format!(
                "the answer is larger than {MAX_RESPONSE_BYTES} bytes"
            )));
        }
    }
    String::from_utf8(bytes)
        .map_err(|_| ProviderError::Rejected("the answer is not valid UTF-8 text".to_string()))
}

/// Maps a provider's answer onto a code the client can act on.
fn provider_error(status: u16, body: &str, api_key: &str) -> ProviderError {
    let explained = explain(status, body, api_key);
    match status {
        401 | 403 => ProviderError::Auth(explained),
        429 => ProviderError::RateLimited(explained),
        // A 404 here nearly always means the address is wrong rather than
        // that a model is missing, which makes it something the user fixes.
        400 | 404 | 405 | 422 => ProviderError::Rejected(explained),
        _ => ProviderError::Unreachable(explained),
    }
}

/// Keeps the provider's own words — usually the only explanation that makes
/// sense — after lifting them out of the error envelope, cutting them down,
/// and removing any credential they echo back.
fn explain(status: u16, body: &str, api_key: &str) -> String {
    let text = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|payload| {
            payload
                .get("error")?
                .get("message")?
                .as_str()
                .map(str::to_string)
        })
        .unwrap_or_else(|| body.to_string());
    let detail = truncate(scrub(&text, api_key).trim());
    if detail.is_empty() {
        format!("status {status}")
    } else {
        format!("status {status}: {detail}")
    }
}

fn scrub(text: &str, api_key: &str) -> String {
    if api_key.chars().count() >= MIN_SCRUBBED_KEY_CHARS && text.contains(api_key) {
        text.replace(api_key, &crate::metadata::redact::masked(api_key))
    } else {
        text.to_string()
    }
}

fn truncate(text: &str) -> String {
    if text.chars().count() <= MAX_DETAIL_CHARS {
        return text.to_string();
    }
    let mut shortened: String = text.chars().take(MAX_DETAIL_CHARS).collect();
    shortened.push('…');
    shortened
}

#[cfg(test)]
mod tests {
    use super::*;

    const API_KEY: &str = "sk-test-1234567890abcd";

    #[test]
    fn a_provider_status_becomes_the_code_a_client_can_act_on() {
        let cases = [
            (401, "PROVIDER_AUTH"),
            (403, "PROVIDER_AUTH"),
            (429, "PROVIDER_RATE_LIMIT"),
            (400, "PROVIDER_BAD_REQUEST"),
            (404, "PROVIDER_BAD_REQUEST"),
            (500, "PROVIDER_UNAVAILABLE"),
            (503, "PROVIDER_UNAVAILABLE"),
        ];
        for (status, code) in cases {
            assert_eq!(provider_error(status, "", API_KEY).code(), code, "{status}");
        }
    }

    #[test]
    fn waiting_can_fix_a_busy_or_absent_provider_but_not_a_wrong_key() {
        assert!(provider_error(429, "", API_KEY).retryable());
        assert!(provider_error(503, "", API_KEY).retryable());
        assert!(!provider_error(401, "", API_KEY).retryable());
        assert!(!provider_error(400, "", API_KEY).retryable());
    }

    #[test]
    fn the_explanation_comes_out_of_the_error_envelope() {
        let body =
            r#"{"error":{"message":"that model is not yours","type":"invalid_request_error"}}"#;
        assert_eq!(
            explain(400, body, API_KEY),
            "status 400: that model is not yours"
        );
        assert_eq!(
            explain(500, "upstream exploded", API_KEY),
            "status 500: upstream exploded"
        );
        assert_eq!(explain(502, "   ", API_KEY), "status 502");
    }

    #[test]
    fn a_credential_the_provider_echoes_back_is_scrubbed() {
        let body = format!(r#"{{"error":{{"message":"key {API_KEY} is not valid"}}}}"#);
        let explained = explain(400, &body, API_KEY);
        assert!(!explained.contains(API_KEY));
        assert!(explained.contains("sk-…abcd"), "{explained}");
    }

    #[test]
    fn a_long_complaint_is_cut_down() {
        let explained = explain(500, &"x".repeat(MAX_DETAIL_CHARS + 50), API_KEY);
        assert_eq!(
            explained.chars().count(),
            "status 500: ".chars().count() + MAX_DETAIL_CHARS + 1
        );
        assert!(explained.ends_with('…'));
    }

    #[tokio::test]
    async fn the_reserved_protocol_says_so_instead_of_guessing() {
        let error = list_models(Protocol::Custom, "https://provider.test", API_KEY)
            .await
            .unwrap_err();
        assert_eq!(error.code(), "VALIDATION_FAILED");
    }
}
