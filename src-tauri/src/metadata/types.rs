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

/// The wire protocol a channel speaks. `Custom` is reserved; nothing
/// implements it yet.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Protocol {
    #[default]
    Openai,
    Gemini,
    Custom,
}

/// One model offered by a channel, tagged with what it can generate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelModel {
    pub id: String,
    pub capability: Capability,
    #[serde(default)]
    pub alias: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

/// A configured provider channel. Deliberately has no credential field: the
/// API key lives in a separate encrypted document and never appears in a
/// snapshot handed to the generation hot path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Channel {
    pub id: String,
    pub name: String,
    pub base_url: String,
    #[serde(default)]
    pub protocol: Protocol,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub models: Vec<ChannelModel>,
}

/// Caller-supplied channel contents for an upsert, with the optional revision
/// the caller last read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelDraft {
    pub id: String,
    pub name: String,
    pub base_url: String,
    #[serde(default)]
    pub protocol: Protocol,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub models: Vec<ChannelModel>,
    #[serde(default)]
    pub expected_revision: Option<u64>,
}

/// The stored form of a channel, as returned after a write.
pub type ChannelRecord = Channel;

/// Default model per capability, addressed as `channelId::modelId`.
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
#[serde(rename_all = "camelCase")]
pub struct VideoPreferences {
    pub seconds: u32,
    pub resolution: String,
    pub generate_audio: bool,
    pub watermark: bool,
    pub mode: String,
}

impl Default for VideoPreferences {
    fn default() -> Self {
        Self {
            seconds: 6,
            resolution: "720".to_string(),
            generate_audio: true,
            watermark: false,
            mode: "auto".to_string(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioPreferences {
    pub voice: String,
    pub format: String,
    pub speed: f64,
    pub instructions: String,
}

impl Default for AudioPreferences {
    fn default() -> Self {
        Self {
            voice: "alloy".to_string(),
            format: "mp3".to_string(),
            speed: 1.0,
            instructions: String::new(),
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

/// Everything the generation path needs about providers, minus credentials.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSnapshot {
    pub version: u32,
    pub revision: u64,
    pub channels: Vec<Channel>,
    pub defaults: Defaults,
    pub preferences: Preferences,
}

impl Default for ProviderSnapshot {
    fn default() -> Self {
        Self {
            version: 1,
            revision: 0,
            channels: Vec::new(),
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
    fn protocols_serialize_as_lowercase_names() {
        assert_eq!(
            serde_json::to_string(&Protocol::Openai).unwrap(),
            "\"openai\""
        );
        assert_eq!(
            serde_json::to_string(&Protocol::Gemini).unwrap(),
            "\"gemini\""
        );
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
    fn a_channel_has_no_credential_field() {
        let channel = Channel {
            id: "openai".to_string(),
            name: "OpenAI".to_string(),
            base_url: "https://api.openai.com/v1".to_string(),
            protocol: Protocol::Openai,
            enabled: true,
            models: Vec::new(),
        };
        let json = serde_json::to_string(&channel).unwrap();
        assert!(!json.contains("apiKey"), "{json}");
        assert!(!json.contains("api_key"), "{json}");
    }

    #[test]
    fn preferences_fall_back_to_the_documented_defaults() {
        let preferences = Preferences::default();
        assert_eq!(preferences.image.size, "1:1");
        assert_eq!(preferences.video.seconds, 6);
        assert!(preferences.video.generate_audio);
        assert!(!preferences.video.watermark);
        assert_eq!(preferences.audio.voice, "alloy");
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
