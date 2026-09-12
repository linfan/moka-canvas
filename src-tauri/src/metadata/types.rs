//! Domain types exchanged through [`super::MetadataStore`].
//!
//! These are the shapes callers see. On-disk documents wrap them in envelopes
//! that carry a revision counter; the envelopes never leave the backend.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::domain::{Capability, IsoTimestamp};

/// Cap on the recent-project list. Older entries fall off the end.
pub const MAX_RECENT: usize = 24;

/// Cap on cached prompt entries for a single source. A refresh beyond this
/// count drops the oldest entries by fetch time.
pub const MAX_PROMPT_ITEMS_PER_SOURCE: usize = 3_000;

/// Cap on one search page, so a large cache cannot be pulled in one request.
pub const MAX_SEARCH_PAGE_SIZE: usize = 100;

/// The backend implementations that exist. A database backend would add a
/// variant here without changing any caller.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MetadataStoreKind {
    File,
}

impl MetadataStoreKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            MetadataStoreKind::File => "file",
        }
    }
}

/// A project the user opened on this machine. Only the path points at project
/// content; metadata never stores the content itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub id: String,
    pub name: String,
    pub path: PathBuf,
    pub last_opened: IsoTimestamp,
}

/// The wire protocol a model configuration speaks.
///
/// One variant per endpoint shape rather than one per vendor: the category a
/// model belongs to decides which of these are on offer, because a text model
/// and a video model never speak the same endpoint even at the same provider.
/// `Custom` is reserved; nothing implements it yet. `LuaScript` names a
/// converter script the user placed in the converter directory (or one of the
/// built-in scripts that was deployed there).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum Protocol {
    /// OpenAI-compatible chat completions (`POST .../chat/completions`).
    #[default]
    OpenaiChat,
    /// OpenAI-compatible responses endpoint (`POST .../responses`).
    OpenaiResponses,
    /// OpenAI-compatible images API (`POST .../images/generations`).
    OpenaiImages,
    /// OpenAI-compatible speech API (`POST .../audio/speech`).
    OpenaiSpeech,
    /// OpenAI-compatible videos API (`POST .../videos`, polled).
    OpenaiVideos,
    /// Google Gemini content generation (`POST ...:generateContent`).
    Gemini,
    /// Google Gemini long-running prediction (`POST ...:predictLongRunning`).
    GeminiVideo,
    Custom,
    /// A protocol backed by a Lua converter script. The string is the protocol
    /// identifier from the converter meta.json (e.g. `"wan3Video"`).
    LuaScript(String),
}

impl Protocol {
    /// The wire name, as it appears on the wire and in a settings form.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::OpenaiChat => "openaiChat",
            Self::OpenaiResponses => "openaiResponses",
            Self::OpenaiImages => "openaiImages",
            Self::OpenaiSpeech => "openaiSpeech",
            Self::OpenaiVideos => "openaiVideos",
            Self::Gemini => "gemini",
            Self::GeminiVideo => "geminiVideo",
            Self::Custom => "custom",
            Self::LuaScript(_) => "luaScript",
        }
    }

    /// The variant name for display and serde.
    pub fn wire_name(&self) -> String {
        match self {
            Self::LuaScript(name) => name.clone(),
            other => other.as_str().to_string(),
        }
    }

    /// Parse a wire name back into a Protocol.
    pub fn from_wire_name(name: &str) -> Self {
        match name {
            "openaiChat" => Self::OpenaiChat,
            "openaiResponses" => Self::OpenaiResponses,
            "openaiImages" => Self::OpenaiImages,
            "openaiSpeech" => Self::OpenaiSpeech,
            "openaiVideos" => Self::OpenaiVideos,
            "gemini" => Self::Gemini,
            "geminiVideo" => Self::GeminiVideo,
            "custom" => Self::Custom,
            other => Self::LuaScript(other.to_string()),
        }
    }

    /// True when the protocol speaks the OpenAI wire format: the credential
    /// travels as a bearer token and bodies use OpenAI field names.
    pub fn is_openai(&self) -> bool {
        matches!(
            self,
            Self::OpenaiChat
                | Self::OpenaiResponses
                | Self::OpenaiImages
                | Self::OpenaiSpeech
                | Self::OpenaiVideos
        )
    }

    /// True when the protocol speaks the Gemini wire format: the credential
    /// travels in the `x-goog-api-key` header.
    pub fn is_gemini(&self) -> bool {
        matches!(self, Self::Gemini | Self::GeminiVideo)
    }

    /// True when this protocol is a Lua-backed script.
    pub fn is_lua(&self) -> bool {
        matches!(self, Self::LuaScript(_))
    }
}

/// Custom serialization: built-in variants use their camelCase name, LuaScript
/// uses its inner string directly.
impl Serialize for Protocol {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.wire_name())
    }
}

/// Custom deserialization: known string → built-in variant, everything else →
/// LuaScript.
impl<'de> Deserialize<'de> for Protocol {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        Ok(Self::from_wire_name(&s))
    }
}

/// The built-in protocol choices on offer for one category of model.
///
/// The list differs per category because each category speaks a different
/// endpoint shape: a text model posts messages, an image model posts a
/// prompt to an images endpoint, and a video model starts a job. A Lua
/// converter script the registry deploys under a category is offered beside
/// these; validation reads both lists, so what may be chosen and what may
/// be stored cannot disagree.
pub fn protocols_for(capability: Capability) -> &'static [Protocol] {
    match capability {
        Capability::Text => &[
            Protocol::OpenaiChat,
            Protocol::OpenaiResponses,
            Protocol::Gemini,
        ],
        Capability::Image => &[Protocol::OpenaiImages],
        Capability::Audio => &[Protocol::OpenaiSpeech],
        Capability::Video => &[Protocol::OpenaiVideos, Protocol::GeminiVideo],
    }
}

/// One configured model, standing on its own.
///
/// There is no provider grouping: every model carries its own address,
/// protocol, and credential, so two models from the same vendor are two
/// configurations that cannot interfere with each other. Deliberately has no
/// credential field: the API key lives in a separate encrypted document,
/// keyed by this configuration's `id`, and never appears in a snapshot handed
/// to the generation hot path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelConfig {
    pub id: String,
    /// What the model generates; also the settings tab it appears under.
    pub category: Capability,
    /// The wire format the endpoint speaks; must be one of
    /// [`protocols_for(category)`].
    pub protocol: Protocol,
    /// The complete endpoint address requests are sent to — not a base URL.
    /// For example `https://api.openai.com/v1/chat/completions` or
    /// `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`.
    pub url: String,
    /// The model name the provider knows, sent in the request body where the
    /// protocol has one.
    pub model: String,
    /// What the settings list and model pickers show.
    pub display_name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

/// Caller-supplied model configuration contents for an upsert, with the
/// optional revision the caller last read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDraft {
    pub id: String,
    pub category: Capability,
    pub protocol: Protocol,
    pub url: String,
    pub model: String,
    pub display_name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub expected_revision: Option<u64>,
}

/// The stored form of a model configuration, as returned after a write.
pub type ModelRecord = ModelConfig;

/// Default model per capability, addressed by model configuration id.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Defaults {
    pub text: Option<String>,
    pub image: Option<String>,
    pub audio: Option<String>,
    pub video: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagePreferences {
    pub size: String,
    pub quality: String,
    pub background: String,
    pub count: u32,
}

impl Default for ImagePreferences {
    fn default() -> Self {
        Self {
            size: "1:1".to_string(),
            quality: "auto".to_string(),
            background: String::new(),
            count: 1,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VideoPreferences {
    pub seconds: u32,
    pub resolution: String,
    pub generate_audio: bool,
    pub watermark: bool,
    pub mode: String,
    pub ratio: String,
}

impl Default for VideoPreferences {
    fn default() -> Self {
        Self {
            seconds: 6,
            resolution: "720".to_string(),
            generate_audio: true,
            watermark: false,
            mode: "auto".to_string(),
            ratio: String::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AudioPreferences {
    pub voice: String,
    pub format: String,
    pub speed: f64,
    pub instructions: String,
    pub sample_rate: u32,
    pub volume: u32,
    pub rate: f64,
    pub pitch: f64,
}

impl Default for AudioPreferences {
    fn default() -> Self {
        Self {
            // No voice is invented: what a model answers to is its own, and a
            // name from one vendor means nothing to another.
            voice: String::new(),
            format: "mp3".to_string(),
            speed: 1.0,
            instructions: String::new(),
            sample_rate: 22050,
            volume: 50,
            rate: 1.0,
            pitch: 1.0,
        }
    }
}

/// Global generation defaults. A node's own parameters override these.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    pub system_prompt: String,
    pub reasoning_effort: String,
    pub image: ImagePreferences,
    pub video: VideoPreferences,
    pub audio: AudioPreferences,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            system_prompt: String::new(),
            reasoning_effort: "auto".to_string(),
            image: ImagePreferences::default(),
            video: VideoPreferences::default(),
            audio: AudioPreferences::default(),
        }
    }
}

/// Everything the generation path needs about model configurations, minus
/// credentials.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelsSnapshot {
    pub version: u32,
    pub revision: u64,
    pub models: Vec<ModelConfig>,
    pub defaults: Defaults,
    pub preferences: Preferences,
}

impl Default for ModelsSnapshot {
    fn default() -> Self {
        Self {
            version: 1,
            revision: 0,
            models: Vec::new(),
            defaults: Defaults::default(),
            preferences: Preferences::default(),
        }
    }
}

/// What may be disclosed about a stored credential. Never the credential.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretInfo {
    pub set: bool,
    pub masked: Option<String>,
    pub fingerprint: Option<String>,
    pub rotated_at: Option<IsoTimestamp>,
}

/// Where prompt entries are fetched from, plus the conditional-request state
/// that lets a refresh keep the previous cache when it fails.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PromptSource {
    pub id: String,
    pub name: String,
    pub url: String,
    pub enabled: bool,
    pub format: String,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub last_ok_at: Option<IsoTimestamp>,
    pub last_error: Option<String>,
    pub item_count: usize,
}

impl Default for PromptSource {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            url: String::new(),
            enabled: false,
            format: "image-prompts-v1".to_string(),
            etag: None,
            last_modified: None,
            last_ok_at: None,
            last_error: None,
            item_count: 0,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PromptItem {
    pub id: String,
    pub source_id: String,
    pub title: String,
    pub prompt: String,
    pub url: Option<String>,
    pub cover: Option<String>,
    pub model: Option<String>,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PromptQuery {
    pub q: Option<String>,
    pub tags: Vec<String>,
    pub source: Option<String>,
    pub page: usize,
    pub page_size: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptPage {
    pub items: Vec<PromptItem>,
    pub total: usize,
    pub page: usize,
    pub page_size: usize,
}

/// Per-document diagnostics, reported through `/api/health`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentInfo {
    pub name: String,
    pub bytes: u64,
    pub revision: u64,
    pub corrupt: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataInfo {
    pub store: MetadataStoreKind,
    /// Redacted for display: the home directory appears as `$HOME`.
    pub root: PathBuf,
    pub schema_version: u32,
    pub secret_storage: SecretStorage,
    pub documents: Vec<DocumentInfo>,
}

/// Where the master key that protects credentials came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SecretStorage {
    Keyring,
    File,
    /// Supplied through the environment; not persisted by this process.
    Env,
    /// No credential has been stored yet, so no master key was needed.
    Unset,
}

impl SecretStorage {
    pub fn as_str(&self) -> &'static str {
        match self {
            SecretStorage::Keyring => "keyring",
            SecretStorage::File => "file",
            SecretStorage::Env => "env",
            SecretStorage::Unset => "unset",
        }
    }
}

fn default_true() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capabilities_serialize_as_lowercase_names() {
        let json = serde_json::to_string(&Capability::Image).unwrap();
        assert_eq!(json, "\"image\"");
    }

    #[test]
    fn protocols_serialize_as_camel_case_names() {
        assert_eq!(
            serde_json::to_string(&Protocol::OpenaiChat).unwrap(),
            "\"openaiChat\""
        );
        assert_eq!(
            serde_json::to_string(&Protocol::OpenaiResponses).unwrap(),
            "\"openaiResponses\""
        );
        assert_eq!(
            serde_json::to_string(&Protocol::Gemini).unwrap(),
            "\"gemini\""
        );
        assert_eq!(
            serde_json::to_string(&Protocol::GeminiVideo).unwrap(),
            "\"geminiVideo\""
        );
    }

    #[test]
    fn each_category_offers_its_own_protocol_list() {
        // A video model never speaks a chat endpoint, so the lists cannot be
        // one shared constant.
        assert_eq!(
            protocols_for(Capability::Text),
            &[
                Protocol::OpenaiChat,
                Protocol::OpenaiResponses,
                Protocol::Gemini
            ]
        );
        assert_eq!(
            protocols_for(Capability::Video),
            &[Protocol::OpenaiVideos, Protocol::GeminiVideo]
        );
        assert!(!protocols_for(Capability::Image).contains(&Protocol::OpenaiChat));
    }

    #[test]
    fn protocol_families_split_by_wire_format() {
        assert!(Protocol::OpenaiChat.is_openai());
        assert!(Protocol::OpenaiVideos.is_openai());
        assert!(!Protocol::OpenaiChat.is_gemini());
        assert!(Protocol::Gemini.is_gemini());
        assert!(Protocol::GeminiVideo.is_gemini());
        assert!(!Protocol::Gemini.is_openai());
    }

    #[test]
    fn documents_use_camel_case_field_names() {
        let recent = RecentProject {
            id: "id".to_string(),
            name: "Film".to_string(),
            path: PathBuf::from("/tmp/film"),
            last_opened: "2026-09-09T00:00:00Z".to_string(),
        };
        let json = serde_json::to_string(&recent).unwrap();
        assert!(json.contains("\"lastOpened\""), "{json}");
        assert!(!json.contains("last_opened"), "{json}");
    }

    #[test]
    fn a_model_config_has_no_credential_field() {
        let config = ModelConfig {
            id: "gpt-4o".to_string(),
            category: Capability::Text,
            protocol: Protocol::OpenaiChat,
            url: "https://api.openai.com/v1/chat/completions".to_string(),
            model: "gpt-4o".to_string(),
            display_name: "GPT-4o".to_string(),
            enabled: true,
        };
        let json = serde_json::to_string(&config).unwrap();
        assert!(!json.contains("apiKey"), "{json}");
        assert!(!json.contains("api_key"), "{json}");
        assert!(json.contains("\"displayName\""), "{json}");
        assert!(json.contains("\"category\":\"text\""), "{json}");
    }

    #[test]
    fn preferences_fall_back_to_the_documented_defaults() {
        let preferences = Preferences::default();
        assert_eq!(preferences.image.size, "1:1");
        assert_eq!(preferences.video.seconds, 6);
        assert!(preferences.video.generate_audio);
        assert!(!preferences.video.watermark);
        // Left blank on purpose: the voice a model answers to is named by the
        // model, so one is never chosen for it here.
        assert_eq!(preferences.audio.voice, "");
        assert_eq!(preferences.reasoning_effort, "auto");
    }

    #[test]
    fn partial_documents_fill_in_missing_fields() {
        let source: PromptSource =
            serde_json::from_str(r#"{"id":"a","name":"A","url":"https://x"}"#)
                .expect("sparse source must parse");
        assert!(!source.enabled);
        assert_eq!(source.format, "image-prompts-v1");
        assert_eq!(source.item_count, 0);
    }
}
