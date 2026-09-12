//! Converter registry: manages the converter directory, meta.json, and the
//! list of available converter protocols.
//!
//! The registry reads meta.json at startup and provides the protocol list
//! that the settings page uses to populate the protocol dropdown.
//!
//! Protocols are grouped by capability — `text`, `image`, `audio`, `video` —
//! as the second level under `protocols`, so the document reads as "for this
//! kind of model, these are the shapes on offer". An older flat document,
//! where each entry carried its own `capability` field, is migrated on load.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// One entry in the converter meta.json protocol list. The capability it
/// serves is the key it hangs under, not a field of its own.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolEntry {
    pub script: String,
    pub display_name: String,
    pub url_example: String,
}

/// Protocols grouped by capability: `text`, `image`, `audio`, `video`.
pub type ProtocolGroups = HashMap<String, HashMap<String, ProtocolEntry>>;

/// The converter directory metadata document.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConverterMeta {
    #[serde(default)]
    pub current_batch: u32,
    #[serde(default)]
    pub protocols: ProtocolGroups,
}

impl Default for ConverterMeta {
    fn default() -> Self {
        Self {
            current_batch: 0,
            protocols: HashMap::new(),
        }
    }
}

/// The document as it looked before capabilities became keys: a flat map of
/// protocol id to entry, each entry naming its own capability. Read only to
/// migrate; every write goes out in the nested shape.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyMeta {
    #[serde(default)]
    current_batch: u32,
    #[serde(default)]
    protocols: HashMap<String, LegacyEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyEntry {
    capability: String,
    script: String,
    display_name: String,
    url_example: String,
}

impl LegacyMeta {
    fn into_current(self) -> ConverterMeta {
        let mut protocols: ProtocolGroups = HashMap::new();
        for (id, entry) in self.protocols {
            protocols.entry(entry.capability).or_default().insert(
                id,
                ProtocolEntry {
                    script: entry.script,
                    display_name: entry.display_name,
                    url_example: entry.url_example,
                },
            );
        }
        ConverterMeta {
            current_batch: self.current_batch,
            protocols,
        }
    }
}

/// Holds the loaded registry state.
pub struct ConverterRegistry {
    meta: ConverterMeta,
    root: PathBuf,
}

impl ConverterRegistry {
    /// Load or create the registry from disk. A document in the old flat
    /// shape is migrated on the way in and written straight back in the
    /// nested shape; an unreadable or unparseable document starts empty
    /// rather than failing the caller.
    pub async fn load(root: &Path) -> Self {
        let meta_path = root.join("meta.json");
        let (meta, migrated) = match tokio::fs::read_to_string(&meta_path).await {
            Ok(text) => match serde_json::from_str::<ConverterMeta>(&text) {
                Ok(meta) => (meta, false),
                Err(_) => match serde_json::from_str::<LegacyMeta>(&text) {
                    Ok(legacy) => (legacy.into_current(), true),
                    Err(_) => (ConverterMeta::default(), false),
                },
            },
            Err(_) => (ConverterMeta::default(), false),
        };
        let registry = Self {
            meta,
            root: root.to_path_buf(),
        };
        if migrated {
            // Best effort: a write would persist the new shape anyway, and a
            // read-only directory is that write's problem to report.
            let _ = registry.save().await;
        }
        registry
    }

    /// Persist the current metadata to disk.
    pub async fn save(&self) -> Result<(), std::io::Error> {
        let meta_path = self.root.join("meta.json");
        let text = serde_json::to_string_pretty(&self.meta)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
        tokio::fs::write(&meta_path, text).await
    }

    /// Returns the current batch number.
    pub fn current_batch(&self) -> u32 {
        self.meta.current_batch
    }

    /// Sets the current batch number and persists.
    pub async fn set_batch(&mut self, batch: u32) -> Result<(), std::io::Error> {
        self.meta.current_batch = batch;
        self.save().await
    }

    /// Adds a protocol entry under its capability and persists.
    pub async fn add_protocol(
        &mut self,
        capability: &str,
        id: &str,
        entry: ProtocolEntry,
    ) -> Result<(), std::io::Error> {
        self.meta
            .protocols
            .entry(capability.to_string())
            .or_default()
            .insert(id.to_string(), entry);
        self.save().await
    }

    /// The protocols grouped by capability: `text` → id → entry.
    pub fn protocols(&self) -> &ProtocolGroups {
        &self.meta.protocols
    }

    /// The protocols one capability offers, empty when it offers none.
    pub fn protocols_for(&self, capability: &str) -> Option<&HashMap<String, ProtocolEntry>> {
        self.meta.protocols.get(capability)
    }

    /// Finds a protocol entry by id across every capability. Ids are unique
    /// in practice — one script speaks one endpoint shape — so the first hit
    /// is the hit.
    pub fn find(&self, id: &str) -> Option<&ProtocolEntry> {
        self.meta.protocols.values().find_map(|group| group.get(id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(script: &str) -> ProtocolEntry {
        ProtocolEntry {
            script: script.to_string(),
            display_name: script.to_string(),
            url_example: "https://example.com".to_string(),
        }
    }

    #[tokio::test]
    async fn migrates_a_flat_legacy_document_into_capability_groups() {
        let dir = tempfile::tempdir().unwrap();
        let legacy = serde_json::json!({
            "currentBatch": 2,
            "protocols": {
                "gemini": {
                    "capability": "text",
                    "script": "text/gemini.lua",
                    "displayName": "Gemini",
                    "urlExample": "https://example.com/gemini"
                },
                "bailianVideo": {
                    "capability": "video",
                    "script": "video/bailian-video.lua",
                    "displayName": "Bailian Video",
                    "urlExample": "https://example.com/bailian"
                }
            }
        });
        tokio::fs::write(dir.path().join("meta.json"), legacy.to_string())
            .await
            .unwrap();

        let registry = ConverterRegistry::load(dir.path()).await;
        assert_eq!(registry.current_batch(), 2);
        assert!(registry
            .protocols_for("text")
            .unwrap()
            .contains_key("gemini"));
        assert!(registry
            .protocols_for("video")
            .unwrap()
            .contains_key("bailianVideo"));
        assert_eq!(
            registry.find("bailianVideo").unwrap().script,
            "video/bailian-video.lua"
        );

        // The migrated shape was written straight back to disk.
        let text = tokio::fs::read_to_string(dir.path().join("meta.json"))
            .await
            .unwrap();
        let on_disk: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert!(on_disk["protocols"]["text"]["gemini"].is_object());
        assert!(on_disk["protocols"]["text"]["gemini"]["capability"].is_null());
    }

    #[tokio::test]
    async fn reads_and_writes_the_nested_shape() {
        let dir = tempfile::tempdir().unwrap();
        let mut registry = ConverterRegistry::load(dir.path()).await;
        registry
            .add_protocol("audio", "bailianSpeech", entry("audio/bailian-speech.lua"))
            .await
            .unwrap();
        registry.set_batch(7).await.unwrap();

        let reloaded = ConverterRegistry::load(dir.path()).await;
        assert_eq!(reloaded.current_batch(), 7);
        let group = reloaded.protocols_for("audio").unwrap();
        assert_eq!(group.len(), 1);
        assert_eq!(group["bailianSpeech"].script, "audio/bailian-speech.lua");
        assert!(reloaded.find("bailianSpeech").is_some());
        assert!(reloaded.find("missing").is_none());
    }

    #[tokio::test]
    async fn an_unparseable_document_starts_empty() {
        let dir = tempfile::tempdir().unwrap();
        tokio::fs::write(dir.path().join("meta.json"), "{not json")
            .await
            .unwrap();
        let registry = ConverterRegistry::load(dir.path()).await;
        assert_eq!(registry.current_batch(), 0);
        assert!(registry.protocols().is_empty());
    }
}
