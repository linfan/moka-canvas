//! On-disk document shapes.
//!
//! One aggregate per document, each with a revision counter in its header.
//! Splitting this way keeps a frequently written document (recent projects)
//! from rewriting an almost never touched one (provider configuration), and
//! keeps the blast radius of a corrupt file to a single aggregate.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::types::{Channel, Defaults, Preferences, PromptItem, PromptSource, RecentProject};
use crate::domain::{now_iso, IsoTimestamp};

pub const META_DOC: &str = "meta.json";
pub const RECENT_DOC: &str = "recent-projects.json";
pub const PROVIDERS_DOC: &str = "providers.json";
pub const SECRETS_DOC: &str = "secrets.json";
pub const PROMPT_SOURCES_DOC: &str = "prompts/sources.json";
pub const PROMPT_ITEMS_DIR: &str = "prompts/items";

/// Document names known to this layer. Anything else in the directory is
/// never read and never deleted.
pub const MANAGED_DOCUMENTS: [&str; 5] = [
    META_DOC,
    RECENT_DOC,
    PROVIDERS_DOC,
    SECRETS_DOC,
    PROMPT_SOURCES_DOC,
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetaDoc {
    pub schema_version: u32,
    pub store: String,
    pub created_at: IsoTimestamp,
    pub updated_at: IsoTimestamp,
    pub app_version: String,
}

impl MetaDoc {
    pub fn new(store: &str, schema_version: u32) -> Self {
        let now = now_iso();
        Self {
            schema_version,
            store: store.to_string(),
            created_at: now.clone(),
            updated_at: now,
            app_version: env!("CARGO_PKG_VERSION").to_string(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentDoc {
    pub revision: u64,
    #[serde(default)]
    pub items: Vec<RecentProject>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvidersDoc {
    pub revision: u64,
    pub version: u32,
    #[serde(default)]
    pub channels: Vec<Channel>,
    #[serde(default)]
    pub defaults: Defaults,
    #[serde(default)]
    pub preferences: Preferences,
}

impl Default for ProvidersDoc {
    fn default() -> Self {
        Self {
            revision: 0,
            version: 1,
            channels: Vec::new(),
            defaults: Defaults::default(),
            preferences: Preferences::default(),
        }
    }
}

/// One stored credential. Only ciphertext and the disclosable derivations of
/// the plaintext; the plaintext itself never reaches this struct.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretEntry {
    pub cipher: String,
    pub fingerprint: String,
    pub masked: String,
    pub rotated_at: IsoTimestamp,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretsDoc {
    pub revision: u64,
    #[serde(default)]
    pub entries: BTreeMap<String, SecretEntry>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptSourcesDoc {
    pub revision: u64,
    #[serde(default)]
    pub items: Vec<PromptSource>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptItemsDoc {
    pub revision: u64,
    pub fetched_at: IsoTimestamp,
    #[serde(default)]
    pub items: Vec<PromptItem>,
}

impl Default for PromptItemsDoc {
    fn default() -> Self {
        Self {
            revision: 0,
            fetched_at: now_iso(),
            items: Vec::new(),
        }
    }
}

/// Parses a document, treating a missing file as the default and anything
/// unreadable as corruption the caller must quarantine.
pub fn parse<T>(name: &str, bytes: &[u8]) -> Result<T, DocumentCorruption>
where
    T: for<'de> Deserialize<'de>,
{
    serde_json::from_slice(bytes).map_err(|error| DocumentCorruption {
        document: name.to_string(),
        reason: error.to_string(),
    })
}

pub fn serialize<T: Serialize>(name: &str, document: &T) -> Result<Vec<u8>, DocumentCorruption> {
    serde_json::to_vec_pretty(document).map_err(|error| DocumentCorruption {
        document: name.to_string(),
        reason: error.to_string(),
    })
}

/// A document that could not be parsed. The file is renamed aside so the user
/// can inspect it, and the layer starts from an empty document rather than
/// silently discarding the rest of the configuration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentCorruption {
    pub document: String,
    pub reason: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn documents_serialize_with_camel_case_headers() {
        let json = serde_json::to_string(&MetaDoc::new("file", 1)).unwrap();
        assert!(json.contains("\"schemaVersion\":1"), "{json}");
        assert!(json.contains("\"appVersion\""), "{json}");
    }

    #[test]
    fn an_empty_document_round_trips() {
        for (name, bytes) in [
            (
                RECENT_DOC,
                serde_json::to_vec(&RecentDoc::default()).unwrap(),
            ),
            (
                PROVIDERS_DOC,
                serde_json::to_vec(&ProvidersDoc::default()).unwrap(),
            ),
            (
                SECRETS_DOC,
                serde_json::to_vec(&SecretsDoc::default()).unwrap(),
            ),
            (
                PROMPT_SOURCES_DOC,
                serde_json::to_vec(&PromptSourcesDoc::default()).unwrap(),
            ),
        ] {
            let raw = String::from_utf8(bytes).unwrap();
            assert!(raw.contains("\"revision\":0"), "{name}: {raw}");
            assert!(!raw.contains('_'), "{name} must not use snake_case: {raw}");
        }
    }

    #[test]
    fn a_missing_field_falls_back_instead_of_failing() {
        let parsed: ProvidersDoc =
            serde_json::from_str(r#"{"revision":3,"version":1}"#).expect("sparse doc");
        assert_eq!(parsed.revision, 3);
        assert!(parsed.channels.is_empty());
        assert_eq!(parsed.preferences.reasoning_effort, "auto");
    }

    #[test]
    fn unparseable_bytes_report_which_document_failed() {
        let error = parse::<RecentDoc>(RECENT_DOC, b"{\"revision\":").unwrap_err();
        assert_eq!(error.document, RECENT_DOC);
        assert!(!error.reason.is_empty());
    }

    #[test]
    fn secret_entries_carry_no_plaintext_field() {
        let entry = SecretEntry {
            cipher: "base64".to_string(),
            fingerprint: "0123abcd".to_string(),
            masked: "sk-…3456".to_string(),
            rotated_at: now_iso(),
        };
        let json = serde_json::to_string(&entry).unwrap();
        assert!(json.contains("\"cipher\""), "{json}");
        assert!(!json.contains("plaintext"), "{json}");
    }
}
