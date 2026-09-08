//! Provider configuration: channels, model references, and the only view of
//! a stored credential that is allowed to leave the process.
//!
//! Nothing here opens a file. Durability, locking, and encryption belong to
//! [`MetadataStore`]; this module owns the rules that make a configuration
//! usable — an address the server can dial, a reference that splits, and a
//! default that points at a model which exists and may serve the capability
//! asked of it.

use std::sync::Arc;
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::domain::Capability;
use crate::metadata::{
    Channel, ChannelDraft, ChannelModel, ChannelRecord, Defaults, MetadataStore, Preferences,
    Protocol, ProviderSnapshot, SecretInfo,
};

use super::adapters;
use super::error::ProviderError;

/// The channel created on a first run, so Settings opens on a filled-in form
/// rather than an empty list. It carries no credential and no models, which
/// is what makes it safe to create without asking.
pub const SEED_CHANNEL_ID: &str = "openai";
const SEED_CHANNEL_NAME: &str = "OpenAI";
const SEED_BASE_URL: &str = "https://api.openai.com/v1";

/// Separates the channel from the model in a stored reference.
pub const REFERENCE_SEPARATOR: &str = "::";

/// Identifiers end up inside every generated node, so they are bounded.
const MAX_IDENTIFIER_LEN: usize = 96;
const MAX_NAME_LEN: usize = 120;

const MAX_IMAGES_PER_RUN: u32 = 10;
const MAX_VIDEO_SECONDS: u32 = 600;

/// Substrings that identify a model's modality from its identifier alone.
/// Used to pre-fill the capability when a provider's model list is fetched;
/// the user's own choice always wins afterwards.
///
/// Ordered by specificity: a video model's name can also contain a substring
/// that would otherwise read as image or audio.
const VIDEO_HINTS: &[&str] = &["video", "sora", "veo", "kling", "wan", "hailuo"];
const AUDIO_HINTS: &[&str] = &["audio", "tts", "speech", "voice", "music", "sound"];
const IMAGE_HINTS: &[&str] = &[
    "seedream",
    "gpt-image",
    "image",
    "dall-e",
    "dalle",
    "imagen",
    "flux",
    "sdxl",
    "stable-diffusion",
    "midjourney",
];

/// Hosts that speak the Gemini protocol. Anything else is taken to speak the
/// OpenAI one, which is what most gateways and proxies imitate.
const GEMINI_HOST_HINTS: &[&str] = &["googleapis.com", "generativelanguage"];

/// What may be disclosed about a channel's credential. Never the credential.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyView {
    pub set: bool,
    pub masked: Option<String>,
}

impl ApiKeyView {
    fn disclosed(secret: Option<SecretInfo>) -> Self {
        match secret {
            Some(secret) => Self {
                set: true,
                masked: secret.masked,
            },
            None => Self {
                set: false,
                masked: None,
            },
        }
    }

    pub const fn unset() -> Self {
        Self {
            set: false,
            masked: None,
        }
    }
}

/// A channel as the client sees it: the stored fields plus the credential's
/// disclosable state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelView {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub protocol: Protocol,
    pub enabled: bool,
    pub models: Vec<ChannelModel>,
    pub api_key: ApiKeyView,
}

/// The whole configuration, with `revision` for optimistic concurrency: a
/// client sends back the revision it read, and a write that would clobber a
/// newer one is refused.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvidersView {
    pub version: u32,
    pub revision: u64,
    pub channels: Vec<ChannelView>,
    pub defaults: Defaults,
    pub preferences: Preferences,
}

/// Everything needed to place one provider call, minus the credential.
///
/// The key is not part of this on purpose: a resolved model is logged,
/// compared, and handed between layers, and a secret that travels with it
/// would eventually be formatted by one of them. Callers fetch it at the
/// moment the request goes out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedModel {
    pub reference: String,
    pub channel_id: String,
    pub model_id: String,
    pub capability: Capability,
    pub protocol: Protocol,
    pub base_url: String,
}

/// The outcome of a connectivity check.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeReport {
    pub ok: bool,
    pub latency_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ProbeFailure>,
}

/// Why a probe failed, shaped like a problem body so the client renders it
/// through the same path as everything else.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeFailure {
    pub code: String,
    pub message: String,
}

impl ProbeReport {
    fn reachable(latency_ms: u64) -> Self {
        Self {
            ok: true,
            latency_ms,
            error: None,
        }
    }

    fn failed(latency_ms: u64, error: &ProviderError) -> Self {
        Self {
            ok: false,
            latency_ms,
            error: Some(ProbeFailure {
                code: error.code().to_string(),
                message: error.to_string(),
            }),
        }
    }
}

/// One model a channel says it offers, before anybody has decided what it is
/// for. The capability is a guess from the identifier, so it is optional: the
/// settings screen confirms or replaces it, and a wrong guess that looked
/// authoritative would be worse than an empty box.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCandidate {
    pub id: String,
    pub capability: Option<Capability>,
}

/// What a quick import is handed: an address, and optionally the credential
/// and display name that belong to it. The identifier and the protocol are
/// derived from the address unless the caller says otherwise.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ChannelImport {
    pub base_url: String,
    pub api_key: Option<String>,
    pub name: Option<String>,
    pub protocol: Option<Protocol>,
    pub expected_revision: Option<u64>,
}

/// Reads and writes provider configuration through the metadata store.
pub struct ProviderRepo {
    metadata: Arc<dyn MetadataStore>,
}

impl ProviderRepo {
    pub fn new(metadata: Arc<dyn MetadataStore>) -> Self {
        Self { metadata }
    }

    /// The stored configuration, with no credential material in it at all.
    ///
    /// A partial edit needs the values it is merging into; reaching for
    /// [`ProviderRepo::view`] to get them would also ask what may be
    /// disclosed about every stored credential.
    pub async fn snapshot(&self) -> Result<ProviderSnapshot, ProviderError> {
        Ok(self.metadata.provider_snapshot().await?)
    }

    pub async fn view(&self) -> Result<ProvidersView, ProviderError> {
        let snapshot = self.metadata.provider_snapshot().await?;
        let mut channels = Vec::with_capacity(snapshot.channels.len());
        for channel in snapshot.channels {
            let secret = self.metadata.secret_state(&channel.id).await?;
            channels.push(ChannelView {
                id: channel.id,
                name: channel.name,
                base_url: channel.base_url,
                protocol: channel.protocol,
                enabled: channel.enabled,
                models: channel.models,
                api_key: ApiKeyView::disclosed(secret),
            });
        }
        Ok(ProvidersView {
            version: snapshot.version,
            revision: snapshot.revision,
            channels,
            defaults: snapshot.defaults,
            preferences: snapshot.preferences,
        })
    }

    pub async fn channel(&self, id: &str) -> Result<Channel, ProviderError> {
        let snapshot = self.metadata.provider_snapshot().await?;
        snapshot
            .channels
            .into_iter()
            .find(|channel| channel.id == id)
            .ok_or_else(|| ProviderError::not_found(format!("channel {id} does not exist")))
    }

    /// Creates or replaces a channel. Fields and models move together, so a
    /// half-updated channel cannot exist.
    pub async fn upsert_channel(
        &self,
        draft: ChannelDraft,
    ) -> Result<ChannelRecord, ProviderError> {
        let mut draft = draft;
        draft.id = draft.id.trim().to_string();
        draft.name = draft.name.trim().to_string();
        draft.base_url = normalize_base_url(&draft.base_url)?;
        validate_identifier("channel", &draft.id)?;
        if draft.name.is_empty() {
            return Err(ProviderError::invalid("a channel needs a name"));
        }
        if draft.name.chars().count() > MAX_NAME_LEN {
            return Err(ProviderError::invalid(format!(
                "a channel name must be at most {MAX_NAME_LEN} characters"
            )));
        }
        for model in &draft.models {
            validate_identifier("model", &model.id)?;
        }
        Ok(self.metadata.upsert_channel(&draft).await?)
    }

    /// Creates or replaces a channel from an address alone.
    ///
    /// The identifier and the display name come from the host, and so does the
    /// protocol unless the caller named one. Importing the same address twice
    /// updates the channel rather than adding a second copy of it, which is
    /// what makes the shortcut safe to offer next to the full editor.
    pub async fn import_channel(
        &self,
        import: ChannelImport,
    ) -> Result<ChannelRecord, ProviderError> {
        let base_url = normalize_base_url(&import.base_url)?;
        let host = host_of(&base_url)?;
        let draft = ChannelDraft {
            id: identifier_from_host(&host),
            name: import
                .name
                .map(|name| name.trim().to_string())
                .filter(|name| !name.is_empty())
                .unwrap_or_else(|| host.clone()),
            base_url,
            protocol: import.protocol.unwrap_or_else(|| guess_protocol(&host)),
            enabled: true,
            models: Vec::new(),
            expected_revision: import.expected_revision,
        };
        let record = self.upsert_channel(draft).await?;
        // Stored after the channel exists, so a credential is never left
        // pointing at configuration that was refused.
        if let Some(api_key) = import.api_key.as_deref() {
            self.set_key(&record.id, Some(api_key)).await?;
        }
        Ok(record)
    }

    /// Removes a channel and its credential, refusing while the channel is
    /// still somebody's default. Deleting it anyway would leave a default
    /// that resolves to nothing and a generation button that fails opaquely.
    pub async fn delete_channel(
        &self,
        id: &str,
        expected_revision: Option<u64>,
    ) -> Result<(), ProviderError> {
        let snapshot = self.metadata.provider_snapshot().await?;
        let capabilities: Vec<String> = referencing_capabilities(&snapshot.defaults, id)
            .iter()
            .map(|capability| capability.to_string())
            .collect();
        if !capabilities.is_empty() {
            return Err(ProviderError::InUse {
                channel: id.to_string(),
                capabilities,
            });
        }
        Ok(self.metadata.delete_channel(id, expected_revision).await?)
    }

    /// Replaces a channel's model list, keeping what the user already chose
    /// for identifiers the provider still lists.
    pub async fn replace_models(
        &self,
        channel_id: &str,
        models: &[ChannelModel],
        expected_revision: Option<u64>,
    ) -> Result<(), ProviderError> {
        for model in models {
            validate_identifier("model", &model.id)?;
        }
        Ok(self
            .metadata
            .replace_channel_models(channel_id, models, expected_revision)
            .await?)
    }

    /// Stores or clears a credential. An empty value means "clear", so the
    /// client never has to distinguish between a blank field and a removal.
    pub async fn set_key(
        &self,
        channel_id: &str,
        key: Option<&str>,
    ) -> Result<ApiKeyView, ProviderError> {
        // Checked before either branch. A credential must not outlive the
        // configuration it belongs to, which nothing would ever collect, and
        // a clear aimed at a mistyped identifier would otherwise report
        // success while leaving the real one in place.
        self.channel(channel_id).await?;
        let key = key.map(str::trim).filter(|key| !key.is_empty());
        let Some(key) = key else {
            self.metadata.delete_secret(channel_id).await?;
            return Ok(ApiKeyView::unset());
        };
        let secret = self.metadata.put_secret(channel_id, key).await?;
        Ok(ApiKeyView::disclosed(Some(secret)))
    }

    pub async fn set_defaults(
        &self,
        defaults: &Defaults,
        expected_revision: Option<u64>,
    ) -> Result<(), ProviderError> {
        let snapshot = self.metadata.provider_snapshot().await?;
        for (capability, reference) in defaults_by_capability(defaults) {
            let Some(reference) = reference else { continue };
            resolve_in(&snapshot, reference, capability)?;
        }
        Ok(self
            .metadata
            .set_defaults(defaults, expected_revision)
            .await?)
    }

    pub async fn set_preferences(
        &self,
        preferences: &Preferences,
        expected_revision: Option<u64>,
    ) -> Result<(), ProviderError> {
        validate_preferences(preferences)?;
        Ok(self
            .metadata
            .set_preferences(preferences, expected_revision)
            .await?)
    }

    /// Resolves a `channelId::modelId` reference against the stored
    /// configuration.
    pub async fn resolve(
        &self,
        reference: &str,
        capability: Capability,
    ) -> Result<ResolvedModel, ProviderError> {
        let snapshot = self.metadata.provider_snapshot().await?;
        resolve_in(&snapshot, reference, capability)
    }

    /// Resolves the default model for a capability, which is what a node with
    /// no model of its own uses.
    pub async fn resolve_default(
        &self,
        capability: Capability,
    ) -> Result<ResolvedModel, ProviderError> {
        let snapshot = self.metadata.provider_snapshot().await?;
        let reference = default_for(&snapshot.defaults, capability).ok_or_else(|| {
            ProviderError::not_configured(capability.as_str(), "no default model is set")
        })?;
        resolve_in(&snapshot, reference, capability)
    }

    /// The plaintext credential, fetched as late as possible. A caller must
    /// not put this in anything that outlives the request.
    pub async fn credential(&self, channel_id: &str) -> Result<String, ProviderError> {
        self.metadata
            .get_secret(channel_id)
            .await?
            .ok_or_else(|| ProviderError::KeyMissing {
                channel: channel_id.to_string(),
            })
    }

    /// Asks a channel what it currently offers and changes nothing.
    ///
    /// The answer is a set of suggestions to pre-fill a form, not the new
    /// stored list: deciding what each model is for is the user's next step,
    /// and a read that wrote would have committed the guess.
    pub async fn fetch_models(
        &self,
        channel_id: &str,
    ) -> Result<Vec<ModelCandidate>, ProviderError> {
        let channel = self.channel(channel_id).await?;
        let api_key = self.credential(channel_id).await?;
        let fetched = adapters::list_models(channel.protocol, &channel.base_url, &api_key).await?;
        Ok(fetched
            .into_iter()
            .map(|id| ModelCandidate {
                capability: guess_capability(&id),
                id,
            })
            .collect())
    }

    /// Asks a provider what it currently offers and stores the answer.
    ///
    /// The stored list is the base, so the capabilities, aliases, and
    /// disabled flags a user chose survive a refresh; identifiers the
    /// provider no longer lists go away.
    pub async fn refresh_models(
        &self,
        channel_id: &str,
    ) -> Result<Vec<ChannelModel>, ProviderError> {
        let channel = self.channel(channel_id).await?;
        let api_key = self.credential(channel_id).await?;
        let fetched = adapters::list_models(channel.protocol, &channel.base_url, &api_key).await?;
        let merged = merge_models(&channel.models, &fetched);
        self.replace_models(channel_id, &merged, None).await?;
        Ok(merged)
    }

    /// Answers "can this channel be used at all", without writing anything.
    ///
    /// A provider that says no is reported inside the body rather than as a
    /// failed request: the point of a probe is to show which channel is
    /// broken, and an error status would leave the client with nothing to
    /// display next to it. Only an unknown channel fails the request.
    pub async fn probe(&self, channel_id: &str) -> Result<ProbeReport, ProviderError> {
        let channel = self.channel(channel_id).await?;
        let started = Instant::now();
        let outcome = match self.credential(channel_id).await {
            Ok(api_key) => adapters::list_models(channel.protocol, &channel.base_url, &api_key)
                .await
                .map(|_| ()),
            Err(error) => Err(error),
        };
        let latency_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        Ok(match outcome {
            Ok(()) => ProbeReport::reachable(latency_ms),
            Err(error) => ProbeReport::failed(latency_ms, &error),
        })
    }

    /// Creates the starter channel on a first run.
    ///
    /// Guarded by the document still being untouched: a channel the user
    /// deliberately deleted must not come back on the next launch.
    pub async fn seed(&self) -> Result<bool, ProviderError> {
        let snapshot = self.metadata.provider_snapshot().await?;
        if snapshot.revision != 0 || !snapshot.channels.is_empty() {
            return Ok(false);
        }
        let draft = ChannelDraft {
            id: SEED_CHANNEL_ID.to_string(),
            name: SEED_CHANNEL_NAME.to_string(),
            base_url: SEED_BASE_URL.to_string(),
            protocol: Protocol::Openai,
            enabled: true,
            models: Vec::new(),
            expected_revision: Some(snapshot.revision),
        };
        self.metadata.upsert_channel(&draft).await?;
        Ok(true)
    }
}

/// Splits a model reference into its channel and model. `None` when either
/// side is missing, which is how a hand-edited document is caught before it
/// reaches a provider.
pub fn split_reference(reference: &str) -> Option<(&str, &str)> {
    let (channel, model) = reference.split_once(REFERENCE_SEPARATOR)?;
    if channel.trim().is_empty() || model.trim().is_empty() {
        return None;
    }
    Some((channel.trim(), model.trim()))
}

/// Guesses what a model generates from its identifier, for pre-filling a
/// freshly fetched model list. `None` means "no hint", which the caller
/// treats as text.
pub fn guess_capability(model_id: &str) -> Option<Capability> {
    let value = model_id.to_lowercase();
    let matches = |hints: &[&str]| hints.iter().any(|hint| value.contains(hint));
    if matches(VIDEO_HINTS) {
        Some(Capability::Video)
    } else if matches(AUDIO_HINTS) {
        Some(Capability::Audio)
    } else if matches(IMAGE_HINTS) {
        Some(Capability::Image)
    } else {
        None
    }
}

/// Merges a provider's model list into the stored one.
///
/// An identifier that is still listed keeps the capability, alias, and
/// enabled flag the user chose for it — a refresh must not silently reset
/// them. An identifier the provider dropped disappears.
pub fn merge_models(stored: &[ChannelModel], fetched: &[String]) -> Vec<ChannelModel> {
    fetched
        .iter()
        .map(String::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(|id| {
            stored
                .iter()
                .find(|model| model.id == id)
                .cloned()
                .unwrap_or_else(|| ChannelModel {
                    id: id.to_string(),
                    capability: guess_capability(id).unwrap_or(Capability::Text),
                    alias: String::new(),
                    enabled: true,
                })
        })
        .collect()
}

/// Builds a request URL from a channel's base address.
///
/// Providers publish base URLs both with and without a version segment, and
/// appending a second one is the most common misconfiguration. The segment
/// each protocol wants is added only when the address does not already end
/// in one it accepts.
pub fn join_url(protocol: Protocol, base_url: &str, path: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    let lowered = base.to_lowercase();
    let already_versioned = accepted_versions(protocol)
        .iter()
        .any(|version| lowered.ends_with(version));
    let prefix = if already_versioned {
        base.to_string()
    } else {
        format!("{base}{}", version_segment(protocol))
    };
    if path.starts_with('/') {
        format!("{prefix}{path}")
    } else {
        format!("{prefix}/{path}")
    }
}

fn version_segment(protocol: Protocol) -> &'static str {
    match protocol {
        Protocol::Gemini => "/v1beta",
        Protocol::Openai | Protocol::Custom => "/v1",
    }
}

fn accepted_versions(protocol: Protocol) -> &'static [&'static str] {
    match protocol {
        Protocol::Gemini => &["/v1beta", "/v1"],
        Protocol::Openai | Protocol::Custom => &["/v1"],
    }
}

/// Checks a channel address and returns the form to store.
///
/// `http` is allowed alongside `https` because a local gateway is a normal
/// way to reach a provider. Credentials in the URL are not: the key has its
/// own encrypted document, and a URL is logged in places a secret must not
/// reach.
pub fn normalize_base_url(value: &str) -> Result<String, ProviderError> {
    let trimmed = value.trim().trim_end_matches('/');
    let parsed = url::Url::parse(trimmed).map_err(|_| {
        ProviderError::invalid(format!("base URL is not a usable address: {trimmed:?}"))
    })?;
    match parsed.scheme() {
        "http" | "https" => {}
        scheme => {
            return Err(ProviderError::invalid(format!(
                "base URL must be http or https, not {scheme}"
            )))
        }
    }
    match parsed.host_str() {
        Some(host) if !host.is_empty() => {}
        _ => {
            return Err(ProviderError::invalid(
                "base URL must name a host".to_string(),
            ))
        }
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(ProviderError::invalid(
            "base URL must not carry credentials; store the API key separately",
        ));
    }
    Ok(trimmed.to_string())
}

/// The host of an address that has already been normalised.
fn host_of(base_url: &str) -> Result<String, ProviderError> {
    url::Url::parse(base_url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(str::to_string))
        .filter(|host| !host.is_empty())
        .ok_or_else(|| ProviderError::invalid("base URL must name a host"))
}

/// Turns a host into a channel identifier, so `api.example.com` becomes
/// `api-example-com`. Anything not alphanumeric collapses into a single dash,
/// which is what keeps the result free of the reference separator and of
/// whitespace without a second validation pass.
fn identifier_from_host(host: &str) -> String {
    let mut identifier = String::with_capacity(host.len());
    for character in host.to_ascii_lowercase().chars() {
        if character.is_ascii_alphanumeric() {
            identifier.push(character);
        } else if !identifier.is_empty() && !identifier.ends_with('-') {
            identifier.push('-');
        }
    }
    identifier
        .chars()
        .take(MAX_IDENTIFIER_LEN)
        .collect::<String>()
        .trim_end_matches('-')
        .to_string()
}

fn guess_protocol(host: &str) -> Protocol {
    if GEMINI_HOST_HINTS.iter().any(|hint| host.contains(hint)) {
        Protocol::Gemini
    } else {
        Protocol::Openai
    }
}

fn validate_identifier(kind: &str, value: &str) -> Result<(), ProviderError> {
    if value.is_empty() {
        return Err(ProviderError::invalid(format!("a {kind} needs an id")));
    }
    if value.chars().count() > MAX_IDENTIFIER_LEN {
        return Err(ProviderError::invalid(format!(
            "a {kind} id must be at most {MAX_IDENTIFIER_LEN} characters"
        )));
    }
    // Both halves of a reference have to stay separable.
    if value.contains(REFERENCE_SEPARATOR) {
        return Err(ProviderError::invalid(format!(
            "a {kind} id must not contain {REFERENCE_SEPARATOR:?}"
        )));
    }
    if value.chars().any(|character| character.is_whitespace()) {
        return Err(ProviderError::invalid(format!(
            "a {kind} id must not contain whitespace"
        )));
    }
    Ok(())
}

/// Bounds the numbers that reach a provider call. The rest of the
/// preferences are free text the provider gets to reject.
fn validate_preferences(preferences: &Preferences) -> Result<(), ProviderError> {
    if !(1..=MAX_IMAGES_PER_RUN).contains(&preferences.image.count) {
        return Err(ProviderError::invalid(format!(
            "image count must be between 1 and {MAX_IMAGES_PER_RUN}"
        )));
    }
    if preferences.video.seconds == 0 || preferences.video.seconds > MAX_VIDEO_SECONDS {
        return Err(ProviderError::invalid(format!(
            "video length must be between 1 and {MAX_VIDEO_SECONDS} seconds"
        )));
    }
    if !(0.25..=4.0).contains(&preferences.audio.speed) {
        return Err(ProviderError::invalid(
            "audio speed must be between 0.25 and 4".to_string(),
        ));
    }
    Ok(())
}

fn defaults_by_capability(defaults: &Defaults) -> [(Capability, Option<&str>); 4] {
    [
        (Capability::Text, defaults.text.as_deref()),
        (Capability::Image, defaults.image.as_deref()),
        (Capability::Audio, defaults.audio.as_deref()),
        (Capability::Video, defaults.video.as_deref()),
    ]
}

fn default_for(defaults: &Defaults, capability: Capability) -> Option<&str> {
    defaults_by_capability(defaults)
        .into_iter()
        .find(|(candidate, _)| *candidate == capability)
        .and_then(|(_, reference)| reference)
        .map(str::trim)
        .filter(|reference| !reference.is_empty())
}

/// The capabilities whose default points at a channel.
fn referencing_capabilities(defaults: &Defaults, channel_id: &str) -> Vec<&'static str> {
    defaults_by_capability(defaults)
        .into_iter()
        .filter(|(_, reference)| {
            reference
                .and_then(split_reference)
                .is_some_and(|(channel, _)| channel == channel_id)
        })
        .map(|(capability, _)| capability.as_str())
        .collect()
}

fn resolve_in(
    snapshot: &ProviderSnapshot,
    reference: &str,
    capability: Capability,
) -> Result<ResolvedModel, ProviderError> {
    let want = capability.as_str();
    let (channel_id, model_id) = split_reference(reference).ok_or_else(|| {
        ProviderError::invalid(format!(
            "a model reference must be written as \"channel{REFERENCE_SEPARATOR}model\", got {reference:?}"
        ))
    })?;
    let channel = snapshot
        .channels
        .iter()
        .find(|channel| channel.id == channel_id)
        .ok_or_else(|| {
            ProviderError::not_configured(want, format!("channel {channel_id} no longer exists"))
        })?;
    if !channel.enabled {
        return Err(ProviderError::not_configured(
            want,
            format!("channel {channel_id} is disabled"),
        ));
    }
    let model = channel
        .models
        .iter()
        .find(|model| model.id == model_id)
        .ok_or_else(|| {
            ProviderError::not_configured(
                want,
                format!("channel {channel_id} does not list model {model_id}"),
            )
        })?;
    if !model.enabled {
        return Err(ProviderError::not_configured(
            want,
            format!("model {model_id} is disabled"),
        ));
    }
    if model.capability != capability {
        return Err(ProviderError::CapabilityMismatch {
            reference: reference.to_string(),
            capability: want.to_string(),
            found: model.capability.as_str().to_string(),
        });
    }
    Ok(ResolvedModel {
        reference: reference.to_string(),
        channel_id: channel.id.clone(),
        model_id: model.id.clone(),
        capability,
        protocol: channel.protocol,
        base_url: channel.base_url.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metadata::{ImagePreferences, VideoPreferences};

    fn model(id: &str, capability: Capability) -> ChannelModel {
        ChannelModel {
            id: id.to_string(),
            capability,
            alias: String::new(),
            enabled: true,
        }
    }

    fn channel(id: &str, models: Vec<ChannelModel>) -> Channel {
        Channel {
            id: id.to_string(),
            name: format!("Channel {id}"),
            base_url: "https://provider.test/v1".to_string(),
            protocol: Protocol::Openai,
            enabled: true,
            models,
        }
    }

    fn configured() -> ProviderSnapshot {
        ProviderSnapshot {
            channels: vec![
                channel(
                    "main",
                    vec![
                        model("writer", Capability::Text),
                        model("painter", Capability::Image),
                    ],
                ),
                channel("spare", vec![model("backup", Capability::Text)]),
            ],
            ..Default::default()
        }
    }

    #[test]
    fn a_reference_splits_into_a_channel_and_a_model() {
        assert_eq!(split_reference("main::painter"), Some(("main", "painter")));
        assert_eq!(split_reference("main::a::b"), Some(("main", "a::b")));
        assert_eq!(
            split_reference(" main :: painter "),
            Some(("main", "painter"))
        );
        assert_eq!(split_reference("painter"), None);
        assert_eq!(split_reference("main::"), None);
        assert_eq!(split_reference("::painter"), None);
    }

    #[test]
    fn an_identifier_cannot_break_a_reference_apart() {
        assert!(validate_identifier("channel", "main").is_ok());
        assert!(validate_identifier("channel", "ma::in").is_err());
        assert!(validate_identifier("channel", "main channel").is_err());
        assert!(validate_identifier("channel", "").is_err());
    }

    #[test]
    fn capability_guesses_follow_the_most_specific_hint() {
        // "imagine" also contains "image"; the video hint has to win.
        assert_eq!(
            guess_capability("grok-imagine-video"),
            Some(Capability::Video)
        );
        assert_eq!(guess_capability("veo-3"), Some(Capability::Video));
        assert_eq!(guess_capability("gpt-4o-mini-tts"), Some(Capability::Audio));
        assert_eq!(guess_capability("gpt-image-2"), Some(Capability::Image));
        assert_eq!(guess_capability("GPT-5.5"), None);
        assert_eq!(guess_capability("gemini-2.5-flash"), None);
    }

    #[test]
    fn resolution_needs_the_channel_the_model_and_the_right_capability() {
        let snapshot = configured();
        let resolved = resolve_in(&snapshot, "main::painter", Capability::Image).unwrap();
        assert_eq!(resolved.channel_id, "main");
        assert_eq!(resolved.model_id, "painter");
        assert_eq!(resolved.capability, Capability::Image);
        assert_eq!(resolved.protocol, Protocol::Openai);
        assert_eq!(resolved.base_url, "https://provider.test/v1");

        let mismatch = resolve_in(&snapshot, "main::painter", Capability::Text).unwrap_err();
        assert_eq!(mismatch.code(), "MODEL_CAPABILITY_MISMATCH");
        assert_eq!(
            mismatch
                .details()
                .and_then(|details| details.get("actual").cloned()),
            Some(serde_json::json!("image")),
            "the client has to be told what the model does generate"
        );

        for reference in ["gone::painter", "main::gone", "main::painter::extra"] {
            let error = resolve_in(&snapshot, reference, Capability::Image).unwrap_err();
            assert_eq!(error.code(), "PROVIDER_NOT_CONFIGURED", "{reference}");
        }
    }

    #[test]
    fn a_disabled_channel_or_model_does_not_resolve() {
        let mut snapshot = configured();
        snapshot.channels[0].enabled = false;
        let error = resolve_in(&snapshot, "main::painter", Capability::Image).unwrap_err();
        assert_eq!(error.code(), "PROVIDER_NOT_CONFIGURED");
        assert!(error.to_string().contains("disabled"));

        let mut snapshot = configured();
        snapshot.channels[0].models[1].enabled = false;
        let error = resolve_in(&snapshot, "main::painter", Capability::Image).unwrap_err();
        assert_eq!(error.code(), "PROVIDER_NOT_CONFIGURED");
    }

    #[test]
    fn a_reference_that_does_not_split_is_rejected_before_any_lookup() {
        let error = resolve_in(&configured(), "painter", Capability::Image).unwrap_err();
        assert_eq!(error.code(), "VALIDATION_FAILED");
    }

    #[test]
    fn only_a_default_naming_the_channel_blocks_its_removal() {
        let defaults = Defaults {
            image: Some("main::painter".to_string()),
            text: Some("spare::backup".to_string()),
            ..Default::default()
        };
        assert_eq!(referencing_capabilities(&defaults, "main"), ["image"]);
        assert_eq!(
            referencing_capabilities(&defaults, "spare"),
            ["text"],
            "a default naming a missing channel still counts as a reference"
        );
        assert!(referencing_capabilities(&defaults, "gone").is_empty());
        assert_eq!(
            default_for(&defaults, Capability::Image),
            Some("main::painter")
        );
        assert_eq!(default_for(&defaults, Capability::Video), None);
    }

    #[test]
    fn the_version_segment_is_added_once() {
        let openai = Protocol::Openai;
        let gemini = Protocol::Gemini;
        assert_eq!(
            join_url(openai, "https://api.test", "/models"),
            "https://api.test/v1/models"
        );
        assert_eq!(
            join_url(openai, "https://api.test/v1", "/models"),
            "https://api.test/v1/models"
        );
        assert_eq!(
            join_url(openai, "https://api.test/v1//", "/models"),
            "https://api.test/v1/models"
        );
        assert_eq!(
            join_url(gemini, "https://api.test", "/models"),
            "https://api.test/v1beta/models"
        );
        assert_eq!(
            join_url(gemini, "https://api.test/v1beta", "/models"),
            "https://api.test/v1beta/models"
        );
        // Gemini publishes both spellings, so an existing /v1 is kept verbatim.
        assert_eq!(
            join_url(gemini, "https://api.test/v1", "/models"),
            "https://api.test/v1/models"
        );
        // The configured casing survives, and a path may omit its slash.
        assert_eq!(
            join_url(openai, "https://api.test/V1", "models"),
            "https://api.test/V1/models"
        );
    }

    #[test]
    fn a_channel_address_has_to_be_dialable() {
        assert_eq!(
            normalize_base_url("  https://api.test/v1/  ").unwrap(),
            "https://api.test/v1"
        );
        // A local gateway is a normal way to reach a provider.
        assert_eq!(
            normalize_base_url("http://127.0.0.1:8787").unwrap(),
            "http://127.0.0.1:8787"
        );
        for value in [
            "",
            "api.test",
            "https://",
            "ftp://api.test",
            "file:///etc/hosts",
        ] {
            assert!(
                normalize_base_url(value).is_err(),
                "{value:?} must be rejected"
            );
        }
    }

    #[test]
    fn credentials_in_the_address_are_rejected_without_being_echoed() {
        let error = normalize_base_url("https://user:sk-live-value@api.test/v1").unwrap_err();
        assert_eq!(error.code(), "VALIDATION_FAILED");
        assert!(!error.to_string().contains("sk-live-value"));
    }

    /// A derived identifier lands in model references, so it has to stay on
    /// the right side of the separator whatever the host looked like.
    #[test]
    fn a_derived_channel_identifier_stays_separable() {
        assert_eq!(identifier_from_host("API.Example.COM"), "api-example-com");
        assert_eq!(
            identifier_from_host("127.0.0.1"),
            "127-0-0-1",
            "a local gateway is a normal thing to point a channel at"
        );
        assert_eq!(identifier_from_host(".example."), "example");
        assert_eq!(identifier_from_host("..."), "");
        assert!(!identifier_from_host(&"a".repeat(400)).contains(REFERENCE_SEPARATOR));
        assert_eq!(
            identifier_from_host(&"a".repeat(400)).chars().count(),
            MAX_IDENTIFIER_LEN
        );
    }

    #[test]
    fn a_protocol_is_recognised_from_the_host() {
        assert_eq!(
            guess_protocol("generativelanguage.googleapis.com"),
            Protocol::Gemini
        );
        assert_eq!(guess_protocol("api.openai.com"), Protocol::Openai);
        assert_eq!(
            guess_protocol("gateway.internal"),
            Protocol::Openai,
            "anything unrecognised is assumed to imitate the common shape"
        );
    }

    #[test]
    fn refreshing_a_model_list_keeps_what_the_user_chose() {
        let kept = ChannelModel {
            alias: "My painter".to_string(),
            // Deliberately wrong, to prove a refresh does not "correct" it.
            capability: Capability::Text,
            enabled: false,
            ..model("painter", Capability::Image)
        };
        let stored = [kept, model("retired", Capability::Text)];
        let merged = merge_models(
            &stored,
            &[
                "painter".to_string(),
                "gpt-image-2".to_string(),
                "  ".to_string(),
            ],
        );

        assert_eq!(
            merged
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            ["painter", "gpt-image-2"]
        );
        assert_eq!(merged[0].alias, "My painter");
        assert_eq!(merged[0].capability, Capability::Text);
        assert!(!merged[0].enabled);
        assert_eq!(merged[1].capability, Capability::Image);
        assert!(merged[1].enabled);
    }

    #[test]
    fn preference_numbers_are_bounded() {
        assert!(validate_preferences(&Preferences::default()).is_ok());

        let zero_images = Preferences {
            image: ImagePreferences {
                count: 0,
                ..Default::default()
            },
            ..Default::default()
        };
        assert_eq!(
            validate_preferences(&zero_images).unwrap_err().code(),
            "VALIDATION_FAILED"
        );

        let endless_video = Preferences {
            video: VideoPreferences {
                seconds: 10_000,
                ..Default::default()
            },
            ..Default::default()
        };
        assert!(validate_preferences(&endless_video).is_err());
    }
}
