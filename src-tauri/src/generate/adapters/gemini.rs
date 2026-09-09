//! The Gemini protocol.
//!
//! Listing only for now. A channel that can be configured and asked what it
//! offers is already usable in Settings; generation through it is a separate
//! step, and saying so here is better than an endpoint that answers nothing.

use serde::Deserialize;

use super::{
    exchange, provider_error, succeeded, ChannelCall, Reply, MAX_MODEL_LIST_BYTES,
    MODEL_LIST_TIMEOUT,
};
use crate::generate::error::ProviderError;

const MODELS: &str = "/models";

/// Enough for everything a provider lists today to arrive in one page.
const PAGE_SIZE: &str = "1000";

/// Identifiers arrive qualified, as in `models/gemini-2.5-flash`.
const NAME_PREFIX: &str = "models/";

pub(super) async fn list_models(call: &ChannelCall) -> Result<Vec<String>, ProviderError> {
    // The credential is already in a header rather than in the query parameter
    // this provider also accepts: a URL is logged and quoted back in error
    // messages, and a header is neither.
    let reply = exchange(
        call.get(MODELS).query(&[("pageSize", PAGE_SIZE)]),
        MODEL_LIST_TIMEOUT,
        MAX_MODEL_LIST_BYTES,
    )
    .await?;
    if !succeeded(reply.status) {
        return Err(provider_error(&reply, &call.api_key));
    }
    identifiers(&reply)
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

/// An entry with no usable name is dropped rather than reported: one
/// placeholder should not hide the rest of the list.
fn identifiers(reply: &Reply) -> Result<Vec<String>, ProviderError> {
    let payload: ModelPage = reply.decoded("model list")?;
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
