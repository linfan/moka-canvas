//! The OpenAI-compatible protocol, which most gateways and aggregators also
//! speak.

use serde::Deserialize;

use super::{client, exchange, not_a_model_list, provider_error, succeeded};
use crate::generate::error::ProviderError;
use crate::generate::providers::join_url;
use crate::metadata::Protocol;

pub async fn list_models(base_url: &str, api_key: &str) -> Result<Vec<String>, ProviderError> {
    let url = join_url(Protocol::Openai, base_url, "/models");
    let (status, body) = exchange(client()?.get(&url).bearer_auth(api_key)).await?;
    if !succeeded(status) {
        return Err(provider_error(status, &body, api_key));
    }
    identifiers(&body)
}

#[derive(Deserialize)]
struct ModelList {
    #[serde(default)]
    data: Vec<ListedModel>,
}

#[derive(Deserialize)]
struct ListedModel {
    id: Option<String>,
}

/// An entry with no usable identifier is dropped rather than reported: one
/// placeholder from a gateway should not hide the rest of the list.
fn identifiers(body: &str) -> Result<Vec<String>, ProviderError> {
    let payload: ModelList = serde_json::from_str(body).map_err(not_a_model_list)?;
    Ok(payload
        .data
        .into_iter()
        .filter_map(|model| model.id)
        .map(|identifier| identifier.trim().to_string())
        .filter(|identifier| !identifier.is_empty())
        .collect())
}
