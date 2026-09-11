//! Document format versioning and the schema-2 upgrade.
//!
//! Schema 2 replaced provider channels with standalone model configurations.
//! The upgrade is a deliberate clean break: channels, their model lists, the
//! per-capability defaults that pointed into them, and the credentials stored
//! against channel identifiers are all dropped, because a channel address is
//! not a model endpoint and a channel key is not a model key. The one thing
//! carried across is the generation preferences, which describe how the user
//! likes answers shaped rather than who serves them.

use std::path::Path;

use serde::Deserialize;

use super::docs::{LEGACY_PROVIDERS_DOC, MODELS_DOC};
use super::{MetadataError, Preferences, SCHEMA_VERSION};

/// Rejects a directory written by a different format version.
///
/// A lower version migrates forward through [`upgrade_to_models`]; a higher
/// one means the user rolled the app back, and overwriting it would destroy
/// data the newer build understands.
pub fn check_schema(found: u32) -> Result<(), MetadataError> {
    if found > SCHEMA_VERSION {
        return Err(MetadataError::migration_failed(format!(
            "this metadata directory was written by schema version {found}; \
             this build understands up to {SCHEMA_VERSION}, so upgrade the app \
             or restore an older copy of the directory"
        )));
    }
    Ok(())
}

/// True when a directory written before the model-configuration schema still
/// carries the document the upgrade reads.
pub fn needs_models_upgrade(root: &Path) -> bool {
    root.join(LEGACY_PROVIDERS_DOC).exists() && !root.join(MODELS_DOC).exists()
}

/// The schema-2 upgrade: reads what is worth keeping out of the legacy
/// provider document, moves the document aside, and hands back the
/// preferences it carried.
///
/// Channels and defaults are not read at all. Stored credentials were sealed
/// against channel identifiers that no longer name anything, so the orphan
/// collector at startup drops them; there is no way to re-key a secret to a
/// model configuration that does not exist yet.
///
/// The legacy document is renamed rather than deleted so that a user who
/// upgrades by accident can still read back what was configured.
pub fn upgrade_to_models(root: &Path) -> Result<Preferences, MetadataError> {
    let path = root.join(LEGACY_PROVIDERS_DOC);
    let preferences = match std::fs::read(&path) {
        Ok(bytes) => match serde_json::from_slice::<LegacyProviders>(&bytes) {
            Ok(legacy) => legacy.preferences.unwrap_or_default(),
            // A document that cannot be parsed has nothing worth keeping, and
            // refusing startup over a file this build no longer needs would be
            // the worse trade.
            Err(error) => {
                tracing::warn!(
                    target: "moka::metadata",
                    error = %error,
                    "the legacy provider document could not be read; its preferences are lost"
                );
                Preferences::default()
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Preferences::default());
        }
        Err(error) => {
            return Err(MetadataError::migration_failed(format!(
                "{}: {error}",
                path.display()
            )))
        }
    };
    let stamp = crate::domain::now_iso().replace(':', "-");
    let aside = root.join(format!("providers.legacy.{stamp}.json"));
    std::fs::rename(&path, &aside).map_err(|error| {
        MetadataError::migration_failed(format!(
            "the legacy provider document could not be moved aside: {error}"
        ))
    })?;
    tracing::info!(
        target: "moka::metadata",
        "provider channels were replaced by per-model configurations; \
         models and keys must be set up again"
    );
    Ok(preferences)
}

/// Tolerant shape for the legacy document: everything but the preferences is
/// dropped rather than rejected, because the point of the read is to rescue
/// what is still meaningful.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyProviders {
    #[serde(default)]
    preferences: Option<Preferences>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::now_iso;
    use std::fs;

    fn write_legacy(root: &Path, body: &str) {
        fs::write(root.join(LEGACY_PROVIDERS_DOC), body).unwrap();
    }

    #[test]
    fn accepts_the_current_schema_version() {
        assert!(check_schema(SCHEMA_VERSION).is_ok());
        assert!(check_schema(0).is_ok());
        assert!(check_schema(1).is_ok());
    }

    #[test]
    fn refuses_to_downgrade_a_newer_directory() {
        let error = check_schema(SCHEMA_VERSION + 1).unwrap_err();
        assert_eq!(error.code(), "METADATA_MIGRATION_FAILED");
        assert!(error.to_string().contains("upgrade"), "{error}");
    }

    #[test]
    fn a_directory_without_the_legacy_document_needs_no_upgrade() {
        let root = tempfile::tempdir().unwrap();
        assert!(!needs_models_upgrade(root.path()));
        let preferences = upgrade_to_models(root.path()).unwrap();
        assert_eq!(preferences, Preferences::default());
    }

    #[test]
    fn the_upgrade_keeps_preferences_and_moves_the_document_aside() {
        let root = tempfile::tempdir().unwrap();
        write_legacy(
            root.path(),
            r#"{"revision":4,"version":1,
               "channels":[{"id":"openai","name":"OpenAI","baseUrl":"https://api.openai.com/v1",
                             "models":[{"id":"gpt-4o","capability":"text","alias":"","enabled":true}]}],
               "defaults":{"text":"openai::gpt-4o"},
               "preferences":{"systemPrompt":"be brief","reasoningEffort":"auto",
                 "image":{"size":"1:1","quality":"auto","background":"","count":1},
                 "video":{"seconds":6,"resolution":"720","generateAudio":true,"watermark":false,"mode":"auto"},
                 "audio":{"voice":"alloy","format":"mp3","speed":1,"instructions":""}}}"#,
        );
        assert!(needs_models_upgrade(root.path()));
        let preferences = upgrade_to_models(root.path()).unwrap();
        assert_eq!(preferences.system_prompt, "be brief");
        assert!(!root.path().join(LEGACY_PROVIDERS_DOC).exists());
        let kept: Vec<_> = fs::read_dir(root.path())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with("providers.legacy."))
            .collect();
        assert_eq!(kept.len(), 1, "{kept:?}");
        assert!(!needs_models_upgrade(root.path()));
    }

    #[test]
    fn an_unparseable_legacy_document_upgrades_with_default_preferences() {
        let root = tempfile::tempdir().unwrap();
        write_legacy(root.path(), "{");
        let preferences = upgrade_to_models(root.path()).unwrap();
        assert_eq!(preferences, Preferences::default());
        assert!(!root.path().join(LEGACY_PROVIDERS_DOC).exists());
    }

    #[test]
    fn a_legacy_document_without_preferences_upgrades_to_the_defaults() {
        let root = tempfile::tempdir().unwrap();
        write_legacy(root.path(), r#"{"revision":2,"channels":[]}"#);
        let preferences = upgrade_to_models(root.path()).unwrap();
        assert_eq!(preferences.reasoning_effort, "auto");
        let _ = now_iso();
    }
}
