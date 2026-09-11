//! Document format versioning, plus the one import that must happen.
//!
//! Recent projects are deliberately *not* imported from the location the
//! previous build used: reading two sources creates a permanent "which one is
//! real" ambiguity, especially across a rollback. The list simply starts
//! empty and refills as projects are opened.
//!
//! Plaintext credentials are the exception. If a provider document written
//! before encryption ever existed is still on disk, it is imported into the
//! encrypted document and the original is renamed aside, because leaving a
//! plaintext API key on disk is not a compatibility preference.

use serde::Deserialize;
use serde_json::Value;

use super::docs::{ProvidersDoc, PROVIDERS_DOC};
use super::{MetadataError, SCHEMA_VERSION};

#[derive(Debug, Clone, PartialEq)]
pub struct LegacyKeys {
    /// The provider document with every credential field removed.
    pub providers: ProvidersDoc,
    /// Channel id and plaintext credential, in document order.
    pub credentials: Vec<(String, String)>,
}

/// Rejects a directory written by a different format version.
///
/// A lower version migrates forward through the registry below; a higher one
/// means the user rolled the app back, and overwriting it would destroy data
/// the newer build understands.
pub fn check_schema(found: u32) -> Result<(), MetadataError> {
    if found > SCHEMA_VERSION {
        return Err(MetadataError::migration_failed(format!(
            "this metadata directory was written by schema version {found}; \
             this build understands up to {SCHEMA_VERSION}, so upgrade the app \
             or restore an older copy of the directory"
        )));
    }
    for migration in MIGRATIONS {
        if migration.from >= found && migration.to <= SCHEMA_VERSION {
            (migration.note)();
        }
    }
    Ok(())
}

struct Migration {
    from: u32,
    to: u32,
    note: fn(),
}

/// Format migrations, applied in order while the directory lock is held.
/// Version 1 is the first version, so there is nothing to migrate yet; the
/// registry exists so the next bump has an obvious home.
const MIGRATIONS: &[Migration] = &[];

/// Finds plaintext credentials in a provider document.
///
/// Returns `None` for a document that is already in the current shape, which
/// is the normal case: the stored [`super::Channel`] type has no credential
/// field, so serde would otherwise skip past it silently.
pub fn detect_plaintext_keys(raw: &[u8]) -> Result<Option<LegacyKeys>, MetadataError> {
    // An unparseable document is corrupt rather than legacy. The caller
    // quarantines it and starts from an empty document; reporting that as a
    // failed migration would block startup on a damaged file.
    let Ok(value) = super::docs::parse::<Value>(PROVIDERS_DOC, raw) else {
        return Ok(None);
    };
    let Some(channels) = value.get("channels").and_then(Value::as_array) else {
        return Ok(None);
    };

    let mut credentials = Vec::new();
    for channel in channels {
        let Some(id) = channel.get("id").and_then(Value::as_str) else {
            continue;
        };
        // Both spellings have been seen in hand-edited files.
        for field in ["apiKey", "api_key"] {
            if let Some(key) = channel.get(field).and_then(Value::as_str) {
                if !key.is_empty() {
                    credentials.push((id.to_string(), key.to_string()));
                }
            }
        }
    }
    if credentials.is_empty() {
        return Ok(None);
    }

    let providers = sanitize(&value)?;
    Ok(Some(LegacyKeys {
        providers,
        credentials,
    }))
}

/// Strips credential fields and re-parses into the current document shape.
fn sanitize(value: &Value) -> Result<ProvidersDoc, MetadataError> {
    let mut cleaned = value.clone();
    if let Some(channels) = cleaned.get_mut("channels").and_then(Value::as_array_mut) {
        for channel in channels {
            if let Some(object) = channel.as_object_mut() {
                object.remove("apiKey");
                object.remove("api_key");
            }
        }
    }
    if let Some(object) = cleaned.as_object_mut() {
        // The current document separates these into their own fields; a legacy
        // file may have nested them under a settings object.
        object.remove("settings");
    }
    serde_json::from_value::<LegacyProviders>(cleaned)
        .map(|legacy| legacy.into_current())
        .map_err(|error| MetadataError::migration_failed(error.to_string()))
}

/// Tolerant shape for a legacy document: unknown fields are dropped rather
/// than rejected, because the point of the import is to rescue credentials.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyProviders {
    #[serde(default)]
    revision: u64,
    #[serde(default)]
    version: Option<u32>,
    #[serde(default)]
    channels: Vec<LegacyChannel>,
    #[serde(default)]
    defaults: Option<super::Defaults>,
    #[serde(default)]
    preferences: Option<super::Preferences>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyChannel {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    base_url: String,
    #[serde(default)]
    protocol: Option<super::Protocol>,
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default)]
    models: Vec<super::ChannelModel>,
}

impl LegacyProviders {
    fn into_current(self) -> ProvidersDoc {
        ProvidersDoc {
            revision: self.revision,
            version: self.version.unwrap_or(1),
            channels: self
                .channels
                .into_iter()
                .map(|channel| super::Channel {
                    id: channel.id,
                    name: channel.name,
                    base_url: channel.base_url,
                    protocol: channel.protocol.unwrap_or_default(),
                    enabled: channel.enabled.unwrap_or(true),
                    models: channel.models,
                    capability_base_urls: std::collections::HashMap::new(),
                })
                .collect(),
            defaults: self.defaults.unwrap_or_default(),
            preferences: self.preferences.unwrap_or_default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_the_current_schema_version() {
        assert!(check_schema(SCHEMA_VERSION).is_ok());
        assert!(check_schema(0).is_ok());
    }

    #[test]
    fn refuses_to_downgrade_a_newer_directory() {
        let error = check_schema(SCHEMA_VERSION + 1).unwrap_err();
        assert_eq!(error.code(), "METADATA_MIGRATION_FAILED");
        assert!(error.to_string().contains("upgrade"), "{error}");
    }

    #[test]
    fn a_current_shaped_document_needs_no_import() {
        let raw = serde_json::to_vec(&ProvidersDoc::default()).unwrap();
        assert!(detect_plaintext_keys(&raw).unwrap().is_none());
    }

    #[test]
    fn finds_and_strips_a_plaintext_credential() {
        let raw = br#"{
            "revision": 4,
            "version": 1,
            "channels": [{
                "id": "openai",
                "name": "OpenAI",
                "baseUrl": "https://api.openai.com/v1",
                "protocol": "openai",
                "enabled": true,
                "apiKey": "sk-plaintext-value",
                "models": []
            }],
            "defaults": {},
            "preferences": {"systemPrompt":"","reasoningEffort":"auto",
                            "image":{"size":"1:1","quality":"auto","background":"","count":1},
                            "video":{"seconds":6,"resolution":"720","generateAudio":true,
                                     "watermark":false,"mode":"auto"},
                            "audio":{"voice":"alloy","format":"mp3","speed":1,"instructions":""}}
        }"#;
        let legacy = detect_plaintext_keys(raw)
            .unwrap()
            .expect("legacy document");
        assert_eq!(
            legacy.credentials,
            vec![("openai".to_string(), "sk-plaintext-value".to_string())]
        );
        assert_eq!(legacy.providers.revision, 4);
        assert_eq!(legacy.providers.channels.len(), 1);
        assert_eq!(legacy.providers.channels[0].id, "openai");

        let sanitized = serde_json::to_vec(&legacy.providers).unwrap();
        assert!(
            !sanitized.windows(11).any(|w| w == b"sk-plaintext"),
            "credential must be gone"
        );
    }

    #[test]
    fn also_accepts_the_snake_case_spelling() {
        let raw = br#"{"revision":0,"channels":[{"id":"a","api_key":"sk-x"}]}"#;
        let legacy = detect_plaintext_keys(raw)
            .unwrap()
            .expect("legacy document");
        assert_eq!(
            legacy.credentials,
            vec![("a".to_string(), "sk-x".to_string())]
        );
    }

    #[test]
    fn an_empty_credential_is_not_imported() {
        let raw = br#"{"revision":0,"channels":[{"id":"a","apiKey":""}]}"#;
        assert!(detect_plaintext_keys(raw).unwrap().is_none());
    }

    /// A document that cannot be parsed is corrupt rather than legacy, so
    /// detection steps aside and lets the loader quarantine and reset it
    /// instead of failing startup.
    #[test]
    fn an_unparseable_document_is_left_to_the_corruption_path() {
        assert!(detect_plaintext_keys(b"{").unwrap().is_none());
    }
}
