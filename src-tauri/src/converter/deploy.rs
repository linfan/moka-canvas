//! Built-in converter deployment.
//!
//! On startup, every built-in converter whose version is newer than the
//! version recorded in its deployed `model.json` is written out — the protocol
//! adapter script and the self-contained document that names it. A converter
//! the reader customised carries a version of its own, so it is left as it is
//! until a later built-in version overtakes what it says.
//!
//! Only the built-in converter directories are ever written. A converter the
//! reader added under a capability directory is not this module's to touch,
//! and an upgrade does not take it away.

use std::path::Path;

use super::adapter::set_converter_root;
use super::registry::{script_name_beside, ModelConfig};

/// A single built-in converter, embedded at compile time.
pub struct ScriptDef {
    pub capability: &'static str,
    pub id: &'static str,
    /// The `model.json` source, deployed verbatim.
    pub config: &'static str,
    /// The Lua source of the protocol adapter the document names.
    pub script: &'static str,
}

impl ScriptDef {
    /// The converter directory's location under the models root.
    pub fn subdir(&self) -> String {
        format!("{}/{}", self.capability, self.id)
    }

    /// The embedded `model.json`, parsed.
    ///
    /// A document that does not parse, or that does not name a script beside
    /// itself, is a fault in this build rather than in anything a reader can
    /// fix, so it is refused here rather than deployed.
    pub fn model(&self) -> Result<ModelConfig, std::io::Error> {
        let invalid = |reason: &str, id: &str| {
            std::io::Error::other(format!("built-in converter '{id}': {reason}"))
        };
        let config: ModelConfig = serde_json::from_str(self.config)
            .map_err(|e| invalid(&format!("model.json does not parse: {e}"), self.id))?;
        if !script_name_beside(&config.script) {
            return Err(invalid(
                &format!(
                    "script '{}' is not a filename beside model.json",
                    config.script
                ),
                self.id,
            ));
        }
        Ok(config)
    }
}

/// The built-in converters. Each document carries the converter's own
/// version, bumped when this build's copy of that converter changes.
pub const BUILTIN_SCRIPTS: &[ScriptDef] = &[
    ScriptDef {
        capability: "text",
        id: "openaiChat",
        config: include_str!("../../converter-scripts/models/text/openai-chat/model.json"),
        script: include_str!("../../converter-scripts/models/text/openai-chat/openai-chat.lua"),
    },
    ScriptDef {
        capability: "text",
        id: "openaiResponses",
        config: include_str!("../../converter-scripts/models/text/openai-responses/model.json"),
        script: include_str!(
            "../../converter-scripts/models/text/openai-responses/openai-responses.lua"
        ),
    },
    ScriptDef {
        capability: "image",
        id: "openaiImages",
        config: include_str!("../../converter-scripts/models/image/openai-images/model.json"),
        script: include_str!(
            "../../converter-scripts/models/image/openai-images/openai-images.lua"
        ),
    },
    ScriptDef {
        capability: "audio",
        id: "openaiSpeech",
        config: include_str!("../../converter-scripts/models/audio/openai-speech/model.json"),
        script: include_str!(
            "../../converter-scripts/models/audio/openai-speech/openai-speech.lua"
        ),
    },
    ScriptDef {
        capability: "video",
        id: "openaiVideos",
        config: include_str!("../../converter-scripts/models/video/openai-videos/model.json"),
        script: include_str!(
            "../../converter-scripts/models/video/openai-videos/openai-videos.lua"
        ),
    },
    ScriptDef {
        capability: "text",
        id: "gemini",
        config: include_str!("../../converter-scripts/models/text/gemini/model.json"),
        script: include_str!("../../converter-scripts/models/text/gemini/gemini.lua"),
    },
    ScriptDef {
        capability: "video",
        id: "geminiVideo",
        config: include_str!("../../converter-scripts/models/video/gemini-video/model.json"),
        script: include_str!("../../converter-scripts/models/video/gemini-video/gemini-video.lua"),
    },
    ScriptDef {
        capability: "video",
        id: "bailianVideo",
        config: include_str!("../../converter-scripts/models/video/bailian-video/model.json"),
        script: include_str!(
            "../../converter-scripts/models/video/bailian-video/bailian-video.lua"
        ),
    },
    ScriptDef {
        capability: "audio",
        id: "bailianSpeech",
        config: include_str!("../../converter-scripts/models/audio/bailian-speech/model.json"),
        script: include_str!(
            "../../converter-scripts/models/audio/bailian-speech/bailian-speech.lua"
        ),
    },
    ScriptDef {
        capability: "audio",
        id: "bailianMusic",
        config: include_str!("../../converter-scripts/models/audio/bailian-music/model.json"),
        script: include_str!(
            "../../converter-scripts/models/audio/bailian-music/bailian-music.lua"
        ),
    },
    ScriptDef {
        capability: "asr",
        id: "bailianAsr",
        config: include_str!("../../converter-scripts/models/asr/bailian-asr/model.json"),
        script: include_str!("../../converter-scripts/models/asr/bailian-asr/bailian-asr.lua"),
    },
];

/// The version a deployed `model.json` records, zero when it does not say or
/// cannot be read — either way a built-in of any version may take its place.
fn deployed_version(path: &Path) -> u32 {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<ModelConfig>(&text).ok())
        .map(|config| config.version)
        .unwrap_or(0)
}

/// Ensures every built-in converter is deployed to the models root, creating
/// or updating its directory and `model.json` as needed. Called once at
/// startup.
///
/// A converter whose deployed version is already at least the built-in
/// version is left untouched, so a converter the reader customised survives
/// until a later built-in version overtakes what it says. Directories this
/// build does not know are never read, written, or removed.
pub async fn ensure_deployed(root: &Path) -> Result<(), Box<dyn std::error::Error>> {
    for def in BUILTIN_SCRIPTS {
        // Each document is parsed before its own write, so a converter whose
        // embedded document does not parse deploys nothing at all. The
        // documents ship with the binary, so this is a build defect and the
        // tests that read every one of them are where it should be caught.
        let config = def.model()?;
        let dir = root.join(def.subdir());
        if deployed_version(&dir.join("model.json")) >= config.version {
            continue;
        }
        tokio::fs::create_dir_all(&dir).await?;
        tokio::fs::write(dir.join(&config.script), def.script).await?;
        tokio::fs::write(dir.join("model.json"), def.config).await?;
    }
    set_converter_root(root.to_path_buf());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::converter::registry::ConverterRegistry;

    async fn deploy(dir: &Path) {
        ensure_deployed(dir).await.unwrap();
    }

    /// Every embedded document parses, claims a version, and names the script
    /// embedded beside it. The script itself cannot be checked here — the
    /// adapter only runs it — so its emptiness is what a build defect would
    /// leave behind.
    #[test]
    fn every_built_in_document_is_well_formed() {
        for def in BUILTIN_SCRIPTS {
            let config = def.model().unwrap_or_else(|e| panic!("{e}"));
            assert!(config.version >= 1, "{}", def.id);
            assert!(!config.display_name.is_empty(), "{}", def.id);
            assert!(!config.url_example.is_empty(), "{}", def.id);
            assert!(!def.script.is_empty(), "{}", def.id);
        }
        assert_eq!(BUILTIN_SCRIPTS.len(), 11);
    }

    #[tokio::test]
    async fn deploys_every_built_in_converter_under_its_capability() {
        let dir = tempfile::tempdir().unwrap();
        deploy(dir.path()).await;

        let registry = ConverterRegistry::load(dir.path());
        assert!(registry.find("openaiChat").is_some());
        assert!(registry.find("bailianAsr").is_some());
        assert!(registry.find("bailianMusic").is_some());
        assert_eq!(registry.protocols_for("asr").unwrap().len(), 1);
        // What the registry reports is what is on the disk: the document and
        // the script it names both sit in the converter's own directory.
        let entry = registry.find("bailianVideo").unwrap();
        let script = dir.path().join(&entry.script);
        assert!(script.is_file(), "{}", script.display());
        assert!(dir.path().join("video/bailianVideo/model.json").is_file());

        // A second deploy finds every document already at its version and
        // leaves the tree as it is.
        deploy(dir.path()).await;
        assert!(dir
            .path()
            .join("video/bailianVideo/bailian-video.lua")
            .is_file());
    }

    #[tokio::test]
    async fn a_reader_added_converter_survives_an_upgrade() {
        let dir = tempfile::tempdir().unwrap();
        deploy(dir.path()).await;

        // A converter of the reader's own: a directory beside the built-ins,
        // claiming no version.
        let custom = dir.path().join("text/myProtocol");
        std::fs::create_dir_all(&custom).unwrap();
        std::fs::write(custom.join("my-protocol.lua"), "-- mine").unwrap();
        std::fs::write(
            custom.join("model.json"),
            r#"{"displayName": "Mine", "urlExample": "https://mine.example.com", "script": "my-protocol.lua"}"#,
        )
        .unwrap();

        deploy(dir.path()).await;

        assert!(custom.join("model.json").is_file());
        assert!(custom.join("my-protocol.lua").is_file());
        let registry = ConverterRegistry::load(dir.path());
        assert!(registry.find("myProtocol").is_some());
    }

    #[tokio::test]
    async fn a_converter_keeps_its_document_until_a_later_version_overtakes_it() {
        let dir = tempfile::tempdir().unwrap();
        deploy(dir.path()).await;

        let document = dir.path().join("text/openaiChat/model.json");
        std::fs::write(
            &document,
            r#"{"displayName": "Mine", "urlExample": "https://mine.example.com", "script": "openai-chat.lua", "version": 99}"#,
        )
        .unwrap();
        deploy(dir.path()).await;

        let text = std::fs::read_to_string(&document).unwrap();
        assert!(text.contains("Mine"), "{text}");
    }

    #[tokio::test]
    async fn a_document_that_does_not_say_its_version_is_taken_over() {
        let dir = tempfile::tempdir().unwrap();
        deploy(dir.path()).await;

        let document = dir.path().join("text/gemini/model.json");
        std::fs::write(
            &document,
            r#"{"displayName": "Anonymous", "urlExample": "https://example.com", "script": "gemini.lua"}"#,
        )
        .unwrap();
        deploy(dir.path()).await;

        let text = std::fs::read_to_string(&document).unwrap();
        assert!(text.contains("Google Gemini"), "{text}");
    }
}
