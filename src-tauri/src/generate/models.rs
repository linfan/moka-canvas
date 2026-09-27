//! Model configuration: standalone per-model entries, model references, and
//! the only view of a stored credential that is allowed to leave the process.
//!
//! There is no provider grouping any more. Every model is configured on its
//! own: a category, a protocol from the list that category offers, the full
//! endpoint address, the model name, a display name, and a credential of its
//! own. Nothing here opens a file. Durability, locking, and encryption belong
//! to [`MetadataStore`]; this module owns the rules that make a configuration
//! usable — an address the server can dial, a protocol that may serve the
//! category, and a default that points at a model which exists.

use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::domain::{Capability, IsoTimestamp};
use crate::metadata::{
    Defaults, MetadataStore, ModelConfig, ModelDraft, ModelRecord, ModelsSnapshot, Preferences,
    Protocol, SecretInfo, SecretStorage,
};

use super::error::ProviderError;

/// The model created on a first run, so Settings opens on a filled-in form
/// rather than an empty list. It carries no credential, which is what makes
/// it safe to create without asking.
pub const SEED_MODEL_ID: &str = "gpt-4o-mini";
const SEED_DISPLAY_NAME: &str = "GPT-4o mini (OpenAI)";
const SEED_MODEL_NAME: &str = "gpt-4o-mini";
const SEED_URL: &str = "https://api.openai.com/v1/chat/completions";

/// The separator an old `channelId::modelId` reference used. Identifiers are
/// refused when they contain it, so a stored reference can never be ambiguous
/// about which half is missing.
const LEGACY_SEPARATOR: &str = "::";

/// Identifiers end up inside every generated node, so they are bounded.
const MAX_IDENTIFIER_LEN: usize = 96;
const MAX_NAME_LEN: usize = 120;

const MAX_IMAGES_PER_RUN: u32 = 10;
const MAX_VIDEO_SECONDS: u32 = 600;

/// How much of a telling one ask may carry, in characters. The ceiling leaves
/// room for the instructions that travel with the telling's own words, since
/// the whole prompt is what the story room's job validation measures.
const MIN_STORY_CHARS: u32 = 1_000;
const MAX_STORY_CHARS: u32 = 16_000;

/// What may be disclosed about a model's credential. Never the credential.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyView {
    pub set: bool,
    pub masked: Option<String>,
    /// When the credential was last replaced. Disclosable: it says nothing
    /// about the value itself.
    pub rotated_at: Option<IsoTimestamp>,
}

impl ApiKeyView {
    fn disclosed(secret: Option<SecretInfo>) -> Self {
        match secret {
            Some(secret) => Self {
                set: true,
                masked: secret.masked,
                rotated_at: secret.rotated_at,
            },
            None => Self {
                set: false,
                masked: None,
                rotated_at: None,
            },
        }
    }

    pub const fn unset() -> Self {
        Self {
            set: false,
            masked: None,
            rotated_at: None,
        }
    }
}

/// A model configuration as the client sees it: the stored fields plus the
/// credential's disclosable state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelView {
    pub id: String,
    pub category: Capability,
    pub protocol: Protocol,
    pub url: String,
    pub model: String,
    pub display_name: String,
    /// The longest one clip this model films, when the deployment knows it.
    /// `None` means the app's own ceiling stands in for it.
    pub max_video_seconds: Option<u32>,
    pub enabled: bool,
    pub api_key: ApiKeyView,
}

/// The whole configuration, with `revision` for optimistic concurrency: a
/// client sends back the revision it read, and a write that would clobber a
/// newer one is refused.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelsView {
    pub version: u32,
    pub revision: u64,
    pub models: Vec<ModelView>,
    pub defaults: Defaults,
    pub preferences: Preferences,
    /// Which tier holds the master key protecting the stored credentials.
    /// Reported with every view so the settings page can say how strong the
    /// current protection is, and warn when it is the file tier.
    pub secret_storage: SecretStorage,
    /// The tiers this runtime can offer: the file tier always, and the OS
    /// keychain where a trustworthy native store exists.
    pub secret_storage_options: Vec<SecretStorage>,
    /// The tier a new master key would be created in.
    pub secret_storage_pref: SecretStorage,
}

/// Everything needed to place one provider call, minus the credential.
///
/// The key is not part of this on purpose: a resolved model is logged,
/// compared, and handed between layers, and a secret that travels with it
/// would eventually be formatted by one of them. Callers fetch it at the
/// moment the request goes out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedModel {
    /// The model configuration's own identifier.
    pub config_id: String,
    /// The model name the provider knows.
    pub model: String,
    pub display_name: String,
    pub category: Capability,
    pub protocol: Protocol,
    /// The complete endpoint address requests are sent to.
    pub url: String,
}

/// Reads and writes model configuration through the metadata store.
pub struct ModelRepo {
    metadata: Arc<dyn MetadataStore>,
}

impl ModelRepo {
    pub fn new(metadata: Arc<dyn MetadataStore>) -> Self {
        Self { metadata }
    }

    /// The stored configuration, with no credential material in it at all.
    ///
    /// A partial edit needs the values it is merging into; reaching for
    /// [`ModelRepo::view`] to get them would also ask what may be disclosed
    /// about every stored credential.
    pub async fn snapshot(&self) -> Result<ModelsSnapshot, ProviderError> {
        Ok(self.metadata.models_snapshot().await?)
    }

    pub async fn view(&self) -> Result<ModelsView, ProviderError> {
        let snapshot = self.metadata.models_snapshot().await?;
        let info = self.metadata.info().await;
        let mut models = Vec::with_capacity(snapshot.models.len());
        for model in snapshot.models {
            let secret = self.metadata.secret_state(&model.id).await?;
            models.push(ModelView {
                id: model.id,
                category: model.category,
                protocol: model.protocol,
                url: model.url,
                model: model.model,
                display_name: model.display_name,
                max_video_seconds: model.max_video_seconds,
                enabled: model.enabled,
                api_key: ApiKeyView::disclosed(secret),
            });
        }
        Ok(ModelsView {
            version: snapshot.version,
            revision: snapshot.revision,
            models,
            defaults: snapshot.defaults,
            preferences: snapshot.preferences,
            secret_storage: info.secret_storage,
            secret_storage_options: info.secret_storage_options,
            secret_storage_pref: info.secret_storage_pref,
        })
    }

    pub async fn model(&self, id: &str) -> Result<ModelConfig, ProviderError> {
        let snapshot = self.metadata.models_snapshot().await?;
        snapshot
            .models
            .into_iter()
            .find(|model| model.id == id)
            .ok_or_else(|| {
                ProviderError::not_found(format!("model configuration {id} does not exist"))
            })
    }

    /// Creates or replaces one model configuration.
    pub async fn upsert(&self, draft: ModelDraft) -> Result<ModelRecord, ProviderError> {
        let mut draft = draft;
        draft.id = draft.id.trim().to_string();
        draft.display_name = draft.display_name.trim().to_string();
        draft.model = draft.model.trim().to_string();
        draft.url = normalize_url(&draft.url)?;
        validate_identifier(&draft.id)?;
        if draft.display_name.is_empty() {
            return Err(ProviderError::invalid("a model needs a display name"));
        }
        if draft.display_name.chars().count() > MAX_NAME_LEN {
            return Err(ProviderError::invalid(format!(
                "a display name must be at most {MAX_NAME_LEN} characters"
            )));
        }
        if draft.model.is_empty() {
            return Err(ProviderError::invalid("a model needs a model name"));
        }
        if draft.model.chars().count() > MAX_NAME_LEN {
            return Err(ProviderError::invalid(format!(
                "a model name must be at most {MAX_NAME_LEN} characters"
            )));
        }
        if !Self::protocol_serves(draft.category, &draft.protocol).await {
            let offered = Self::offered_protocols(draft.category).await;
            return Err(ProviderError::invalid(format!(
                "the {} protocol cannot serve a {} model; the choices are {offered:?}",
                draft.protocol.wire_name(),
                draft.category.as_str()
            )));
        }
        // A clip ceiling is a fact about a video model and means nothing for
        // any other kind: a text model carrying one is dropped rather than
        // refused, since what it asks for is a form that never had the field.
        draft.max_video_seconds = check_video_ceiling(draft.category, draft.max_video_seconds)?;
        Ok(self.metadata.upsert_model(&draft).await?)
    }

    /// Whether a protocol may serve one category of model: it must name a
    /// converter the models tree holds under that category.
    async fn protocol_serves(category: Capability, protocol: &Protocol) -> bool {
        let name = protocol.wire_name();
        Self::offered_protocols(category)
            .await
            .iter()
            .any(|offered| offered == name)
    }

    /// Every protocol name a category accepts: the converters the models
    /// directory holds under it. Before the root is set — a unit test, or a
    /// startup that failed before deploy — the converters this build ships
    /// stand in, which is the set deploy is about to write out.
    async fn offered_protocols(category: Capability) -> Vec<String> {
        if let Some(root) = crate::converter::converter_root() {
            let registry = crate::converter::ConverterRegistry::load(root);
            return registry
                .protocols_for(category.as_str())
                .map(|group| group.keys().cloned().collect())
                .unwrap_or_default();
        }
        crate::converter::deploy::BUILTIN_SCRIPTS
            .iter()
            .filter(|script| script.capability == category.as_str())
            .map(|script| script.id.to_string())
            .collect()
    }

    /// Removes a model configuration and its credential. A default that
    /// named it is cleared in the same breath: with no stored default the
    /// capability falls back to the first model that can serve it, so the
    /// removal never leaves a generation refused and never needs refusing
    /// itself.
    pub async fn delete(
        &self,
        id: &str,
        expected_revision: Option<u64>,
    ) -> Result<(), ProviderError> {
        let snapshot = self.metadata.models_snapshot().await?;
        if !snapshot.models.iter().any(|model| model.id == id) {
            return Err(ProviderError::not_found(format!(
                "model configuration {id} does not exist"
            )));
        }
        self.metadata.delete_model(id, expected_revision).await?;
        let mut defaults = snapshot.defaults.clone();
        if clear_references(&mut defaults, id) {
            // The removal already moved the revision, so this write rides on
            // whatever the store holds now rather than on a revision that is
            // stale by definition.
            self.metadata.set_defaults(&defaults, None).await?;
        }
        Ok(())
    }

    /// Stores or clears a credential. An empty value means "clear", so the
    /// client never has to distinguish between a blank field and a removal.
    pub async fn set_key(&self, id: &str, key: Option<&str>) -> Result<ApiKeyView, ProviderError> {
        // Checked before either branch. A credential must not outlive the
        // configuration it belongs to, which nothing would ever collect, and a
        // clear aimed at a mistyped identifier would otherwise report success
        // while leaving the real one in place.
        self.model(id).await?;
        let key = key.map(str::trim).filter(|key| !key.is_empty());
        let Some(key) = key else {
            self.metadata.delete_secret(id).await?;
            return Ok(ApiKeyView::unset());
        };
        let secret = self.metadata.put_secret(id, key).await?;
        Ok(ApiKeyView::disclosed(Some(secret)))
    }

    /// Moves the master key protecting every stored credential to another
    /// tier and answers with the whole view, so one call resyncs a client.
    pub async fn set_secret_storage(
        &self,
        target: SecretStorage,
    ) -> Result<ModelsView, ProviderError> {
        self.metadata.set_secret_storage(target).await?;
        self.view().await
    }

    pub async fn set_defaults(
        &self,
        defaults: &Defaults,
        expected_revision: Option<u64>,
    ) -> Result<(), ProviderError> {
        let snapshot = self.metadata.models_snapshot().await?;
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

    /// Resolves a model configuration identifier against the stored
    /// configuration.
    pub async fn resolve(
        &self,
        reference: &str,
        capability: Capability,
    ) -> Result<ResolvedModel, ProviderError> {
        let snapshot = self.metadata.models_snapshot().await?;
        resolve_in(&snapshot, reference, capability)
    }

    /// Resolves the default model for a capability, which is what a node with
    /// no model of its own uses.
    pub async fn resolve_default(
        &self,
        capability: Capability,
    ) -> Result<ResolvedModel, ProviderError> {
        let snapshot = self.metadata.models_snapshot().await?;
        // An empty reference is how a caller asks for the default.
        resolve_within(&snapshot, "", capability)
    }

    /// The plaintext credential, fetched as late as possible. A caller must
    /// not put this in anything that outlives the request.
    pub async fn credential(&self, config_id: &str) -> Result<String, ProviderError> {
        self.metadata
            .get_secret(config_id)
            .await?
            .ok_or_else(|| ProviderError::KeyMissing {
                model: config_id.to_string(),
            })
    }

    /// Creates the starter model on a first run.
    ///
    /// Guarded by the document still being untouched: a configuration the user
    /// deliberately deleted must not come back on the next launch.
    pub async fn seed(&self) -> Result<bool, ProviderError> {
        let snapshot = self.metadata.models_snapshot().await?;
        if snapshot.revision != 0 || !snapshot.models.is_empty() {
            return Ok(false);
        }
        let draft = ModelDraft {
            id: SEED_MODEL_ID.to_string(),
            category: Capability::Text,
            protocol: Protocol::from_wire_name("openaiChat"),
            url: SEED_URL.to_string(),
            model: SEED_MODEL_NAME.to_string(),
            display_name: SEED_DISPLAY_NAME.to_string(),
            max_video_seconds: None,
            enabled: true,
            expected_revision: Some(snapshot.revision),
        };
        self.metadata.upsert_model(&draft).await?;
        Ok(true)
    }
}

fn defaults_by_capability(defaults: &Defaults) -> [(Capability, Option<&str>); 6] {
    [
        (Capability::Text, defaults.text.as_deref()),
        (Capability::Image, defaults.image.as_deref()),
        (Capability::Speech, defaults.speech.as_deref()),
        (Capability::Music, defaults.music.as_deref()),
        (Capability::Video, defaults.video.as_deref()),
        (Capability::Asr, defaults.asr.as_deref()),
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

/// Clears every default that points at one model configuration, reporting
/// whether there was anything to clear.
fn clear_references(defaults: &mut Defaults, model_id: &str) -> bool {
    let mut cleared = false;
    for slot in [
        &mut defaults.text,
        &mut defaults.image,
        &mut defaults.speech,
        &mut defaults.music,
        &mut defaults.video,
        &mut defaults.asr,
    ] {
        if slot.as_deref().map(str::trim) == Some(model_id) {
            *slot = None;
            cleared = true;
        }
    }
    cleared
}

/// Resolves what one generation is placed with, from a snapshot already in
/// hand.
///
/// A caller that also needs the preferences reads them from this same
/// snapshot, so a configuration edited mid-request cannot be half-applied:
/// the model from before the edit and the parameters from after it. An empty
/// reference means the caller has no model of its own and wants the default
/// for the capability.
pub fn resolve_within(
    snapshot: &ModelsSnapshot,
    reference: &str,
    capability: Capability,
) -> Result<ResolvedModel, ProviderError> {
    let named = reference.trim();
    if !named.is_empty() {
        return resolve_in(snapshot, named, capability);
    }
    // The default is the stored one while it still names a model that can
    // serve the capability. One that was deleted or disabled since — or no
    // stored default at all — falls back to the first model that can serve,
    // so a capability with models is never refused for want of a hand-picked
    // default.
    if let Some(stored) = default_for(&snapshot.defaults, capability) {
        if let Ok(resolved) = resolve_in(snapshot, stored, capability) {
            return Ok(resolved);
        }
    }
    match snapshot
        .models
        .iter()
        .find(|model| model.enabled && model.category == capability)
    {
        Some(model) => resolve_in(snapshot, &model.id, capability),
        None => Err(ProviderError::not_configured(
            capability.as_str(),
            "no default model is set",
        )),
    }
}

fn resolve_in(
    snapshot: &ModelsSnapshot,
    reference: &str,
    capability: Capability,
) -> Result<ResolvedModel, ProviderError> {
    let want = capability.as_str();
    let named = reference.trim();
    if named.is_empty() {
        return Err(ProviderError::invalid("a model reference is empty"));
    }
    if named.contains(LEGACY_SEPARATOR) {
        return Err(ProviderError::invalid(format!(
            "{named:?} is an old \"channel{LEGACY_SEPARATOR}model\" reference; \
             provider channels are gone, so pick one of the configured models again"
        )));
    }
    let config = snapshot
        .models
        .iter()
        .find(|model| model.id == named)
        .ok_or_else(|| {
            ProviderError::not_configured(
                want,
                format!("model configuration {named} does not exist"),
            )
        })?;
    if !config.enabled {
        return Err(ProviderError::not_configured(
            want,
            format!("model configuration {named} is disabled"),
        ));
    }
    if config.category != capability {
        return Err(ProviderError::CapabilityMismatch {
            reference: named.to_string(),
            capability: want.to_string(),
            found: config.category.as_str().to_string(),
        });
    }
    Ok(ResolvedModel {
        config_id: config.id.clone(),
        model: config.model.clone(),
        display_name: config.display_name.clone(),
        category: capability,
        protocol: config.protocol.clone(),
        url: config.url.clone(),
    })
}

/// Checks a model's endpoint address and returns the form to store.
///
/// `http` is allowed alongside `https` because a local gateway is a normal
/// way to reach a provider. Credentials in the URL are not: the key has its
/// own encrypted document, and a URL is logged in places a secret must not
/// reach.
pub fn normalize_url(value: &str) -> Result<String, ProviderError> {
    let trimmed = value.trim().trim_end_matches('/');
    let parsed = url::Url::parse(trimmed)
        .map_err(|_| ProviderError::invalid(format!("URL is not a usable address: {trimmed:?}")))?;
    match parsed.scheme() {
        "http" | "https" => {}
        scheme => {
            return Err(ProviderError::invalid(format!(
                "URL must be http or https, not {scheme}"
            )))
        }
    }
    match parsed.host_str() {
        Some(host) if !host.is_empty() => {}
        _ => return Err(ProviderError::invalid("URL must name a host".to_string())),
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(ProviderError::invalid(
            "URL must not carry credentials; store the API key separately",
        ));
    }
    Ok(trimmed.to_string())
}

fn validate_identifier(value: &str) -> Result<(), ProviderError> {
    if value.is_empty() {
        return Err(ProviderError::invalid(
            "a model configuration needs an id".to_string(),
        ));
    }
    if value.chars().count() > MAX_IDENTIFIER_LEN {
        return Err(ProviderError::invalid(format!(
            "a model configuration id must be at most {MAX_IDENTIFIER_LEN} characters"
        )));
    }
    // An old reference read as "channel::model"; an identifier carrying the
    // separator would make a stored reference ambiguous forever.
    if value.contains(LEGACY_SEPARATOR) {
        return Err(ProviderError::invalid(format!(
            "a model configuration id must not contain {LEGACY_SEPARATOR:?}"
        )));
    }
    if value.chars().any(|character| character.is_whitespace()) {
        return Err(ProviderError::invalid(
            "a model configuration id must not contain whitespace".to_string(),
        ));
    }
    Ok(())
}

/// The clip ceiling a configuration may keep, or the refusal it is.
///
/// Only a video model has a window of its own, and a number outside what one
/// clip may be at all is nothing the app could plan with: it is refused rather
/// than stored and discovered at the first long act.
fn check_video_ceiling(
    category: Capability,
    seconds: Option<u32>,
) -> Result<Option<u32>, ProviderError> {
    if category != Capability::Video {
        return Ok(None);
    }
    match seconds {
        Some(seconds) if seconds == 0 || seconds > MAX_VIDEO_SECONDS => {
            Err(ProviderError::invalid(format!(
                "the longest clip must be between 1 and {MAX_VIDEO_SECONDS} seconds"
            )))
        }
        other => Ok(other),
    }
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
    if !(0.25..=4.0).contains(&preferences.speech.speed) {
        return Err(ProviderError::invalid(
            "speech speed must be between 0.25 and 4".to_string(),
        ));
    }
    for (name, chars) in [
        ("splitChars", preferences.story.split_chars),
        ("readChars", preferences.story.read_chars),
    ] {
        if !(MIN_STORY_CHARS..=MAX_STORY_CHARS).contains(&chars) {
            return Err(ProviderError::invalid(format!(
                "story {name} must be between {MIN_STORY_CHARS} and {MAX_STORY_CHARS} characters"
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::metadata::{ImagePreferences, StoryPreferences, VideoPreferences};

    fn model(id: &str, category: Capability) -> ModelConfig {
        let protocol = Protocol::from_wire_name(match category {
            Capability::Image => "openaiImages",
            _ => "openaiChat",
        });
        ModelConfig {
            id: id.to_string(),
            category,
            protocol,
            url: "https://provider.test/v1/chat/completions".to_string(),
            model: id.to_string(),
            display_name: format!("Model {id}"),
            max_video_seconds: None,
            enabled: true,
        }
    }

    fn configured() -> ModelsSnapshot {
        ModelsSnapshot {
            models: vec![
                model("writer", Capability::Text),
                model("painter", Capability::Image),
                model("backup", Capability::Text),
            ],
            ..Default::default()
        }
    }

    #[test]
    fn resolution_needs_the_configuration_and_the_right_category() {
        let snapshot = configured();
        let resolved = resolve_in(&snapshot, "painter", Capability::Image).unwrap();
        assert_eq!(resolved.config_id, "painter");
        assert_eq!(resolved.model, "painter");
        assert_eq!(resolved.category, Capability::Image);
        assert_eq!(resolved.protocol, Protocol::from_wire_name("openaiImages"));
        assert_eq!(resolved.url, "https://provider.test/v1/chat/completions");

        let mismatch = resolve_in(&snapshot, "painter", Capability::Text).unwrap_err();
        assert_eq!(mismatch.code(), "MODEL_CAPABILITY_MISMATCH");
        assert_eq!(
            mismatch
                .details()
                .and_then(|details| details.get("actual").cloned()),
            Some(serde_json::json!("image")),
            "the client has to be told what the model does generate"
        );

        let error = resolve_in(&snapshot, "gone", Capability::Image).unwrap_err();
        assert_eq!(error.code(), "PROVIDER_NOT_CONFIGURED");
    }

    #[test]
    fn an_old_channel_reference_says_what_it_is() {
        let error = resolve_in(&configured(), "main::painter", Capability::Image).unwrap_err();
        assert_eq!(error.code(), "VALIDATION_FAILED");
        assert!(error.to_string().contains("channel"), "{error}");
    }

    #[test]
    fn a_disabled_model_does_not_resolve() {
        let mut snapshot = configured();
        snapshot.models[1].enabled = false;
        let error = resolve_in(&snapshot, "painter", Capability::Image).unwrap_err();
        assert_eq!(error.code(), "PROVIDER_NOT_CONFIGURED");
        assert!(error.to_string().contains("disabled"));
    }

    #[test]
    fn an_empty_reference_falls_back_to_the_default() {
        let mut snapshot = configured();
        snapshot.defaults.image = Some("painter".to_string());
        let resolved = resolve_within(&snapshot, "", Capability::Image).unwrap();
        assert_eq!(resolved.config_id, "painter");

        // No stored default: the first enabled model of the capability serves.
        let resolved = resolve_within(&snapshot, "", Capability::Text).unwrap();
        assert_eq!(resolved.config_id, "writer");

        // A stored default that is gone falls back the same way.
        snapshot.defaults.text = Some("ghost".to_string());
        let resolved = resolve_within(&snapshot, "", Capability::Text).unwrap();
        assert_eq!(resolved.config_id, "writer");

        // So does one that was disabled since it was chosen: "backup" is the
        // second text model, and "writer" stays the fallback ahead of it.
        snapshot.defaults.text = Some("backup".to_string());
        snapshot.models[2].enabled = false;
        let resolved = resolve_within(&snapshot, "", Capability::Text).unwrap();
        assert_eq!(resolved.config_id, "writer");

        let error = resolve_within(&snapshot, "", Capability::Video).unwrap_err();
        assert_eq!(error.code(), "PROVIDER_NOT_CONFIGURED");
        assert!(error.to_string().contains("no default"), "{error}");
    }

    #[test]
    fn clearing_defaults_names_the_models_they_point_at() {
        let mut defaults = Defaults {
            image: Some("painter".to_string()),
            text: Some("backup".to_string()),
            music: Some("musician".to_string()),
            ..Default::default()
        };
        assert_eq!(default_for(&defaults, Capability::Image), Some("painter"));
        assert_eq!(default_for(&defaults, Capability::Video), None);

        assert!(!clear_references(&mut defaults, "gone"));
        assert!(clear_references(&mut defaults, "painter"));
        assert_eq!(defaults.image, None);
        assert_eq!(defaults.text.as_deref(), Some("backup"));

        // A music model is a default like any other: removing it clears the
        // place that named it, and leaving it alone keeps the score's model.
        assert!(clear_references(&mut defaults, "musician"));
        assert_eq!(defaults.music, None);
    }

    #[test]
    fn a_score_asks_a_music_model_and_a_voice_asks_a_speech_one() {
        let mut snapshot = configured();
        snapshot.models.push(model("musician", Capability::Music));
        snapshot.models.push(model("speaker", Capability::Speech));
        snapshot.defaults.speech = Some("speaker".to_string());
        snapshot.defaults.music = Some("musician".to_string());

        // Each default answers for its own capability.
        let music = resolve_within(&snapshot, "", Capability::Music).unwrap();
        assert_eq!(music.config_id, "musician");
        let voice = resolve_within(&snapshot, "", Capability::Speech).unwrap();
        assert_eq!(voice.config_id, "speaker");

        // A voice model is no longer a score's model: a deployment with none
        // answers with the gap's own name rather than a speech model asked for
        // a tune.
        let mut speech_only = configured();
        speech_only
            .models
            .push(model("speaker", Capability::Speech));
        speech_only.defaults.speech = Some("speaker".to_string());
        let error = resolve_within(&speech_only, "", Capability::Music).unwrap_err();
        assert_eq!(error.code(), "PROVIDER_NOT_CONFIGURED");
        assert!(error.to_string().contains("music"), "{error}");
    }

    #[test]
    fn an_endpoint_address_has_to_be_dialable() {
        assert_eq!(
            normalize_url("  https://api.test/v1/chat/completions  ").unwrap(),
            "https://api.test/v1/chat/completions"
        );
        // A local gateway is a normal way to reach a provider.
        assert_eq!(
            normalize_url("http://127.0.0.1:8787/v1/chat/completions").unwrap(),
            "http://127.0.0.1:8787/v1/chat/completions"
        );
        for value in [
            "",
            "api.test",
            "https://",
            "ftp://api.test",
            "file:///etc/hosts",
        ] {
            assert!(normalize_url(value).is_err(), "{value:?} must be rejected");
        }
    }

    #[test]
    fn credentials_in_the_address_are_rejected_without_being_echoed() {
        let error =
            normalize_url("https://user:sk-live-value@api.test/v1/chat/completions").unwrap_err();
        assert_eq!(error.code(), "VALIDATION_FAILED");
        assert!(!error.to_string().contains("sk-live-value"));
    }

    #[test]
    fn an_identifier_cannot_carry_the_legacy_separator() {
        assert!(validate_identifier("gpt-4o").is_ok());
        assert!(validate_identifier("ma::in").is_err());
        assert!(validate_identifier("main model").is_err());
        assert!(validate_identifier("").is_err());
        assert!(validate_identifier(&"a".repeat(97)).is_err());
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

        let overlong_reading = Preferences {
            story: StoryPreferences {
                read_chars: MAX_STORY_CHARS + 1,
                ..Default::default()
            },
            ..Default::default()
        };
        assert!(validate_preferences(&overlong_reading).is_err());

        let split_finer_than_a_line = Preferences {
            story: StoryPreferences {
                split_chars: MIN_STORY_CHARS - 1,
                ..Default::default()
            },
            ..Default::default()
        };
        assert!(validate_preferences(&split_finer_than_a_line).is_err());
    }

    #[test]
    fn a_clip_ceiling_belongs_to_a_video_model_and_is_bounded() {
        assert_eq!(
            check_video_ceiling(Capability::Video, Some(15)).unwrap(),
            Some(15)
        );
        assert_eq!(check_video_ceiling(Capability::Video, None).unwrap(), None);
        assert_eq!(
            check_video_ceiling(Capability::Video, Some(MAX_VIDEO_SECONDS)).unwrap(),
            Some(MAX_VIDEO_SECONDS)
        );
        assert!(check_video_ceiling(Capability::Video, Some(0)).is_err());
        assert!(check_video_ceiling(Capability::Video, Some(MAX_VIDEO_SECONDS + 1)).is_err());

        // A text model carrying a number is not a video model with a window:
        // it is dropped, since the form it arrived from never had the field.
        assert_eq!(
            check_video_ceiling(Capability::Text, Some(15)).unwrap(),
            None
        );
    }
}
