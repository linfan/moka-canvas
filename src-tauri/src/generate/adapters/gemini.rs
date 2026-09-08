//! The Gemini protocol.

use reqwest::header::HeaderName;
use serde::Deserialize;

use super::{client, exchange, not_a_model_list, provider_error, succeeded};
use crate::generate::error::ProviderError;
use crate::generate::providers::join_url;
use crate::metadata::Protocol;

/// The credential goes in a header rather than in the query parameter the
/// provider also accepts. A URL is logged and quoted back in error messages;
/// a header is neither.
const API_KEY_HEADER: HeaderName = HeaderName::from_static("x-goog-api-key");

/// Enough for everything a provider lists today to arrive in one page.
const PAGE_SIZE: &str = "1000";

/// Identifiers arrive qualified, as in `models/gemini-2.5-flash`.
const NAME_PREFIX: &str = "models/";

pub async fn list_models(base_url: &str, api_key: &str) -> Result<Vec<String>, ProviderError> {
    let url = join_url(Protocol::Gemini, base_url, "/models");
    let request = client()?
        .get(&url)
        .query(&[("pageSize", PAGE_SIZE)])
        .header(API_KEY_HEADER, api_key);
    let (status, body) = exchange(request).await?;
    if !succeeded(status) {
        return Err(provider_error(status, &body, api_key));
    }
    identifiers(&body)
}

#[derive(Deserialize)]
struct ModelPage {
    #[serde(default)]
    models: Vec<ListedModel>,
}

#[derive(Deserialize)]
struct ListedModel {
    name: Option<String>,
}

fn identifiers(body: &str) -> Result<Vec<String>, ProviderError> {
    let payload: ModelPage = serde_json::from_str(body).map_err(not_a_model_list)?;
    Ok(payload
        .models
        .into_iter()
        .filter_map(|model| model.name)
        .map(|name| {
            let name = name.trim();
            name.strip_prefix(NAME_PREFIX).unwrap_or(name).to_string()
        })
        .filter(|name| !name.is_empty())
        .collect())
}
