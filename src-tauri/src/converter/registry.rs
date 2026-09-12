//! Converter registry: manages the converter directory, meta.json, and the
//! list of available converter protocols.
//!
//! The registry reads meta.json at startup and provides the protocol list
//! that the settings page uses to populate the protocol dropdown.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// One entry in the converter meta.json protocol list.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolEntry {
    pub capability: String,
    pub script: String,
    pub display_name: String,
    pub url_example: String,
}

/// The converter directory metadata document.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConverterMeta {
    #[serde(default)]
    pub current_batch: u32,
    #[serde(default)]
    pub protocols: HashMap<String, ProtocolEntry>,
}

impl Default for ConverterMeta {
    fn default() -> Self {
        Self {
            current_batch: 0,
            protocols: HashMap::new(),
        }
    }
}

/// Holds the loaded registry state.
pub struct ConverterRegistry {
    meta: ConverterMeta,
    root: PathBuf,
}

impl ConverterRegistry {
    /// Load or create the registry from disk.
    pub async fn load(root: &Path) -> Self {
        let meta_path = root.join("meta.json");
        let meta = match tokio::fs::read_to_string(&meta_path).await {
            Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
            Err(_) => ConverterMeta::default(),
        };
        Self {
            meta,
            root: root.to_path_buf(),
        }
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

    /// Adds a protocol entry to the registry and persists.
    pub async fn add_protocol(
        &mut self,
        id: &str,
        entry: ProtocolEntry,
    ) -> Result<(), std::io::Error> {
        self.meta.protocols.insert(id.to_string(), entry);
        self.save().await
    }

    /// Returns a copy of all known protocols.
    pub fn protocols(&self) -> &HashMap<String, ProtocolEntry> {
        &self.meta.protocols
    }
}

/// Returns the list of protocol entries from the registry.
pub fn protocol_list(registry: &ConverterRegistry) -> Vec<(String, ProtocolEntry)> {
    let mut list: Vec<_> = registry
        .protocols()
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    list.sort_by(|a, b| a.1.display_name.cmp(&b.1.display_name));
    list
}
