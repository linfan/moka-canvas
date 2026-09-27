//! Document format versioning and the upgrades between the schemas.
//!
//! Schema 2 replaced provider channels with standalone model configurations.
//! The upgrade is a deliberate clean break: channels, their model lists, the
//! per-capability defaults that pointed into them, and the credentials stored
//! against channel identifiers are all dropped, because a channel address is
//! not a model endpoint and a channel key is not a model key. The one thing
//! carried across is the generation preferences, which describe how the user
//! likes answers shaped rather than who serves them.
//!
//! Schema 3 split the audio capability into speech and music. Nothing is
//! dropped: every model and default it carried is placed under the one it
//! serves, and the preference group the voice settings lived in is read
//! through a serde alias under its new name.

use std::collections::HashMap;
use std::path::Path;

use serde::Deserialize;

use crate::domain::Capability;

use super::docs::{ModelsDoc, LEGACY_PROVIDERS_DOC, MODELS_DOC};
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

/// The schema-3 upgrade: sound was one capability and is now two.
///
/// Every model stored under the old `audio` category is placed by what its
/// converter actually serves — read from this build's own converter table,
/// since a directory on disk may still be the previous version's. A protocol
/// with no built-in converter behind it has only one piece of evidence about
/// it: whether it was the music default. The defaults are then placed the same
/// way, each falling back to the other's model when that one serves the place.
///
/// Answers whether anything moved. That is not the same question as whether
/// the document wants writing: an older document stores its models and its
/// defaults under the one old capability's name, so a model that keeps serving
/// the same place still has to be written as the capability it now reads as.
pub fn split_sound_capability(models: &mut ModelsDoc) -> bool {
    let music_default = models
        .defaults
        .music
        .as_deref()
        .map(str::trim)
        .unwrap_or_default()
        .to_string();
    let mut moved = false;
    let mut category_of: HashMap<String, Capability> = HashMap::new();
    for model in models.models.iter_mut() {
        // Speech is where both a stored "audio" and a stored "speech" read;
        // this runs only on a document from before the split, so every speech
        // here came from the single old category.
        if model.category == Capability::Speech {
            let capability = declared_sound_capability(model.protocol.wire_name()).unwrap_or(
                if music_default == model.id {
                    Capability::Music
                } else {
                    Capability::Speech
                },
            );
            if capability != model.category {
                model.category = capability;
                moved = true;
            }
        }
        category_of.insert(model.id.clone(), model.category);
    }

    let old_speech = models.defaults.speech.clone();
    let old_music = models.defaults.music.clone();
    let serves = |reference: &Option<String>, want: Capability| -> Option<String> {
        reference
            .as_ref()
            .filter(|id| category_of.get(id.as_str()) == Some(&want))
            .cloned()
    };
    let speech =
        serves(&old_speech, Capability::Speech).or_else(|| serves(&old_music, Capability::Speech));
    let music =
        serves(&old_music, Capability::Music).or_else(|| serves(&old_speech, Capability::Music));
    if speech != old_speech || music != old_music {
        moved = true;
    }
    models.defaults.speech = speech;
    models.defaults.music = music;
    moved
}

/// The capability a built-in converter declares, for the two sound ones.
/// Anything else — including a name no converter in this build answers to —
/// is not evidence about a sound model.
fn declared_sound_capability(protocol: &str) -> Option<Capability> {
    let script = crate::converter::deploy::BUILTIN_SCRIPTS
        .iter()
        .find(|script| script.id == protocol)?;
    match script.capability {
        "speech" => Some(Capability::Speech),
        "music" => Some(Capability::Music),
        _ => None,
    }
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

    /// A model as a schema-2 document stores one: the old single sound
    /// category, which reads here as speech before the upgrade runs.
    fn sound_model(id: &str, protocol: &str) -> crate::metadata::ModelConfig {
        crate::metadata::ModelConfig {
            id: id.to_string(),
            category: Capability::Speech,
            protocol: crate::metadata::Protocol::from_wire_name(protocol),
            url: "https://provider.test/v1".to_string(),
            model: id.to_string(),
            display_name: id.to_string(),
            max_video_seconds: None,
            enabled: true,
        }
    }

    fn document(models: Vec<crate::metadata::ModelConfig>, speech: &str, music: &str) -> ModelsDoc {
        let defaults = crate::metadata::Defaults {
            speech: (!speech.is_empty()).then(|| speech.to_string()),
            music: (!music.is_empty()).then(|| music.to_string()),
            ..Default::default()
        };
        ModelsDoc {
            models,
            defaults,
            ..Default::default()
        }
    }

    fn category_of(models: &ModelsDoc, id: &str) -> Capability {
        models
            .models
            .iter()
            .find(|model| model.id == id)
            .unwrap_or_else(|| panic!("{id} is not in the document"))
            .category
    }

    #[test]
    fn the_split_places_each_sound_model_by_its_converter() {
        let mut models = document(
            vec![
                sound_model("speaker", "bailianSpeech"),
                sound_model("musician", "bailianMusic"),
                sound_model("custom", "someoneElsesMusic"),
            ],
            "speaker",
            "musician",
        );
        assert!(split_sound_capability(&mut models));
        assert_eq!(category_of(&models, "speaker"), Capability::Speech);
        assert_eq!(category_of(&models, "musician"), Capability::Music);
        // A converter this build does not know falls to speech unless the
        // music default is the one piece of evidence about it.
        assert_eq!(category_of(&models, "custom"), Capability::Speech);
        assert_eq!(models.defaults.speech.as_deref(), Some("speaker"));
        assert_eq!(models.defaults.music.as_deref(), Some("musician"));

        // Run again: nothing is left to move, and nothing is written twice.
        assert!(!split_sound_capability(&mut models));
    }

    #[test]
    fn an_unknown_converter_is_a_score_when_it_was_the_music_default() {
        let mut models = document(
            vec![
                sound_model("speaker", "bailianSpeech"),
                sound_model("custom", "someoneElsesMusic"),
            ],
            "speaker",
            "custom",
        );
        assert!(split_sound_capability(&mut models));
        assert_eq!(category_of(&models, "custom"), Capability::Music);
        assert_eq!(models.defaults.music.as_deref(), Some("custom"));
    }

    #[test]
    fn a_default_whose_model_serves_the_other_place_is_moved_or_cleared() {
        // The old audio default was a music model: the score's place keeps it
        // and the voice's place is left honestly empty.
        let mut models = document(
            vec![sound_model("musician", "bailianMusic")],
            "musician",
            "",
        );
        assert!(split_sound_capability(&mut models));
        assert_eq!(models.defaults.speech, None);
        assert_eq!(models.defaults.music.as_deref(), Some("musician"));

        // The old music default was a speech model, and the voice place named
        // nothing: the one model they had keeps serving the lines.
        let mut models = document(vec![sound_model("speaker", "bailianSpeech")], "", "speaker");
        assert!(split_sound_capability(&mut models));
        assert_eq!(models.defaults.speech.as_deref(), Some("speaker"));
        assert_eq!(models.defaults.music, None);
    }

    #[test]
    fn a_document_written_after_the_split_is_left_alone() {
        let mut models = document(
            vec![
                sound_model("speaker", "bailianSpeech"),
                crate::metadata::ModelConfig {
                    category: Capability::Music,
                    ..sound_model("musician", "bailianMusic")
                },
            ],
            "speaker",
            "musician",
        );
        assert!(!split_sound_capability(&mut models));
        assert_eq!(category_of(&models, "speaker"), Capability::Speech);
        assert_eq!(category_of(&models, "musician"), Capability::Music);
    }
}
