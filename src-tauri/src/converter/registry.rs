//! Converter registry: the model directories on disk, read as a list of
//! available converter protocols.
//!
//! The models root holds one directory per capability — `text`, `image`,
//! `audio`, `video`, `asr` — and each of those holds one directory per
//! converter. A converter directory is self-contained: its `model.json`
//! carries the metadata and names the protocol adapter script beside it, so a
//! script is added by dropping a directory in and removed by taking one out.
//! A directory without a readable `model.json` is skipped rather than failing
//! the read: the rest of the directory is still worth showing.

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// The capability directories a models root holds, in the order a list reads.
pub const CAPABILITY_DIRS: [&str; 5] = ["text", "image", "audio", "video", "asr"];

/// One converter's `model.json`.
///
/// The identifier is the name of the directory the document sits in, so the
/// document does not repeat it. `script` locates the protocol adapter Lua file
/// relative to that same directory — usually a bare filename beside the
/// document, which is what this module joins it onto.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelConfig {
    pub display_name: String,
    pub url_example: String,
    pub script: String,
    /// The version of the built-in converter this document was deployed
    /// from, written for a built-in and absent for a directory a reader
    /// wrote by hand. Zero when absent, so any built-in version may take the
    /// place of a document that does not claim one.
    #[serde(default)]
    pub version: u32,
}

/// One protocol entry, as the rest of the program reads it: the converter's
/// capability is the group key it hangs under, its identifier is the map key,
/// and `script` is the path from the models root to the adapter script.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolEntry {
    pub script: String,
    pub display_name: String,
    pub url_example: String,
}

/// Protocols grouped by capability: `text`, `image`, `audio`, `video`, `asr`.
pub type ProtocolGroups = HashMap<String, HashMap<String, ProtocolEntry>>;

/// Whether a `model.json` `script` value names a file in the document's own
/// directory: a bare filename, and not the document itself.
pub fn script_name_beside(script: &str) -> bool {
    let file_name = Path::new(script).file_name();
    file_name == Some(std::ffi::OsStr::new(script)) && !script.is_empty() && script != "model.json"
}

/// Holds the loaded registry state.
pub struct ConverterRegistry {
    protocols: ProtocolGroups,
}

impl ConverterRegistry {
    /// Reads every capability directory under the models root and every
    /// converter directory inside them. Never fails: an unreadable directory,
    /// a missing `model.json`, or one that does not parse is left out, and a
    /// root that does not exist yet yields an empty registry.
    pub fn load(root: &Path) -> Self {
        let mut protocols: ProtocolGroups = HashMap::new();
        for capability in CAPABILITY_DIRS {
            let group = Self::load_capability(&root.join(capability));
            if !group.is_empty() {
                protocols.insert(capability.to_string(), group);
            }
        }
        Self { protocols }
    }

    /// Reads one capability directory: each subdirectory that holds a
    /// readable `model.json` becomes an entry, keyed by the directory name.
    fn load_capability(dir: &Path) -> HashMap<String, ProtocolEntry> {
        let mut group = HashMap::new();
        let Ok(entries) = std::fs::read_dir(dir) else {
            return group;
        };
        for entry in entries.flatten() {
            if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                continue;
            }
            let Some(id) = entry.file_name().into_string().ok() else {
                continue;
            };
            if let Some(entry) = Self::load_converter(&entry.path(), dir) {
                group.insert(id, entry);
            }
        }
        group
    }

    /// Reads one converter directory's `model.json`. `capability_dir` is the
    /// directory it sits in, named in the script path so every entry can be
    /// resolved against the models root alone.
    ///
    /// The script is a bare filename beside the document — one that climbs
    /// out of the converter's own directory, or names the document itself,
    /// is refused rather than followed.
    fn load_converter(dir: &Path, capability_dir: &Path) -> Option<ProtocolEntry> {
        let text = std::fs::read_to_string(dir.join("model.json")).ok()?;
        let config: ModelConfig = serde_json::from_str(&text).ok()?;
        if !script_name_beside(&config.script) {
            return None;
        }
        let capability = capability_dir.file_name()?.to_str()?;
        let id = dir.file_name()?.to_str()?;
        Some(ProtocolEntry {
            script: format!("{capability}/{id}/{}", config.script),
            display_name: config.display_name,
            url_example: config.url_example,
        })
    }

    /// The protocols grouped by capability: `text` → id → entry.
    pub fn protocols(&self) -> &ProtocolGroups {
        &self.protocols
    }

    /// The protocols one capability offers, empty when it offers none.
    pub fn protocols_for(&self, capability: &str) -> Option<&HashMap<String, ProtocolEntry>> {
        self.protocols.get(capability)
    }

    /// Finds a protocol entry by id across every capability. Ids are unique
    /// in practice — one script speaks one endpoint shape — so the first hit
    /// is the hit.
    pub fn find(&self, id: &str) -> Option<&ProtocolEntry> {
        self.protocols.values().find_map(|group| group.get(id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, converter: &str, model_json: &str, script: Option<&str>) {
        let converter_dir = dir.join(converter);
        std::fs::create_dir_all(&converter_dir).unwrap();
        std::fs::write(converter_dir.join("model.json"), model_json).unwrap();
        if let Some(name) = script {
            std::fs::write(converter_dir.join(name), "-- lua").unwrap();
        }
    }

    #[test]
    fn reads_every_converter_directory_under_its_capability() {
        let dir = tempfile::tempdir().unwrap();
        write(
            &dir.path().join("text"),
            "gemini",
            r#"{"displayName": "Gemini", "urlExample": "https://example.com", "script": "gemini.lua", "version": 1}"#,
            Some("gemini.lua"),
        );
        write(
            &dir.path().join("video"),
            "bailianVideo",
            r#"{"displayName": "Bailian Video", "urlExample": "https://example.com/bailian", "script": "bailian-video.lua", "version": 2}"#,
            Some("bailian-video.lua"),
        );
        // A converter whose document does not parse is left out, and the rest
        // of the directory is still read.
        write(&dir.path().join("text"), "broken", "{not json", None);

        let registry = ConverterRegistry::load(dir.path());
        assert_eq!(registry.protocols().len(), 2);
        assert!(registry
            .protocols_for("text")
            .unwrap()
            .contains_key("gemini"));
        assert!(!registry
            .protocols_for("text")
            .unwrap()
            .contains_key("broken"));
        assert!(registry.find("broken").is_none());
        assert_eq!(
            registry.find("bailianVideo").unwrap().script,
            "video/bailianVideo/bailian-video.lua"
        );
        assert_eq!(registry.find("gemini").unwrap().display_name, "Gemini");
    }

    #[test]
    fn a_converter_without_a_readable_document_is_skipped() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("audio/no-document")).unwrap();
        // A loose file where a converter directory is expected is not one.
        std::fs::write(dir.path().join("audio").join("stray.lua"), "-- lua").unwrap();

        let registry = ConverterRegistry::load(dir.path());
        assert!(registry.protocols().is_empty());
        assert!(registry.find("no-document").is_none());
    }

    #[test]
    fn a_root_that_does_not_exist_reads_empty() {
        let dir = tempfile::tempdir().unwrap();
        let registry = ConverterRegistry::load(&dir.path().join("models"));
        assert!(registry.protocols().is_empty());
        assert!(registry.protocols_for("text").is_none());
    }

    #[test]
    fn a_directory_left_in_the_root_is_not_a_capability() {
        let dir = tempfile::tempdir().unwrap();
        write(
            &dir.path().join("script-backup"),
            "gemini",
            r#"{"displayName": "Gemini", "urlExample": "https://example.com", "script": "gemini.lua"}"#,
            None,
        );
        let registry = ConverterRegistry::load(dir.path());
        assert!(registry.protocols().is_empty());
    }

    #[test]
    fn a_script_that_would_climb_out_of_its_directory_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        write(
            &dir.path().join("text"),
            "wanderer",
            r#"{"displayName": "Wanderer", "urlExample": "https://example.com", "script": "../../../etc/passwd"}"#,
            None,
        );
        write(
            &dir.path().join("text"),
            "absolute",
            r#"{"displayName": "Absolute", "urlExample": "https://example.com", "script": "/etc/passwd"}"#,
            None,
        );
        let registry = ConverterRegistry::load(dir.path());
        assert!(registry.find("wanderer").is_none());
        assert!(registry.find("absolute").is_none());
    }

    #[test]
    fn only_a_bare_filename_sits_beside_the_document() {
        assert!(script_name_beside("bailian-video.lua"));
        assert!(!script_name_beside("../bailian-video.lua"));
        assert!(!script_name_beside("sub/bailian-video.lua"));
        assert!(!script_name_beside("/etc/passwd"));
        assert!(!script_name_beside("model.json"));
        assert!(!script_name_beside(""));
    }
}
