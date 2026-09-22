//! Built-in converter script deployment.
//!
//! On startup, reads the converter meta.json and deploys any built-in scripts
//! whose batch number is higher than the currently recorded batch. This lets
//! the app ship updated converter scripts without overwriting user-customised
//! ones.

use std::path::Path;

use super::adapter::set_converter_root;
use super::registry::{ConverterRegistry, ProtocolEntry};

/// One batch of built-in scripts.
pub struct ScriptGroup {
    pub batch: u32,
    pub scripts: &'static [ScriptDef],
}

/// A single built-in converter script definition.
pub struct ScriptDef {
    pub protocol_id: &'static str,
    pub capability: &'static str,
    pub display_name: &'static str,
    pub url_example: &'static str,
    /// The subdirectory under converter/ (e.g. "text", "image", "audio", "video")
    pub subdir: &'static str,
    /// The filename within that subdirectory (e.g. "openai-chat.lua")
    pub filename: &'static str,
    /// The Lua source code, embedded at compile time via include_str!
    pub source: &'static str,
}

/// The built-in scripts grouped by batch. Batch 1 covers all existing
/// protocols. Higher batches are added when new converter scripts ship.
pub const BUILTIN_GROUPS: &[ScriptGroup] = &[
    // Batch 1: all current built-in protocols
    ScriptGroup {
        batch: 1,
        scripts: &[
            ScriptDef {
                protocol_id: "openaiChat",
                capability: "text",
                display_name: "OpenAI-compatible · Chat Completions",
                url_example: "https://api.openai.com/v1/chat/completions",
                subdir: "text",
                filename: "openai-chat.lua",
                source: include_str!("../../converter-scripts/text/openai-chat.lua"),
            },
            ScriptDef {
                protocol_id: "openaiResponses",
                capability: "text",
                display_name: "OpenAI-compatible · Responses API",
                url_example: "https://api.openai.com/v1/responses",
                subdir: "text",
                filename: "openai-responses.lua",
                source: include_str!("../../converter-scripts/text/openai-responses.lua"),
            },
            ScriptDef {
                protocol_id: "openaiImages",
                capability: "image",
                display_name: "OpenAI-compatible · Images API",
                url_example: "https://api.openai.com/v1/images/generations",
                subdir: "image",
                filename: "openai-images.lua",
                source: include_str!("../../converter-scripts/image/openai-images.lua"),
            },
            ScriptDef {
                protocol_id: "openaiSpeech",
                capability: "audio",
                display_name: "OpenAI-compatible · Speech API",
                url_example: "https://api.openai.com/v1/audio/speech",
                subdir: "audio",
                filename: "openai-speech.lua",
                source: include_str!("../../converter-scripts/audio/openai-speech.lua"),
            },
            ScriptDef {
                protocol_id: "openaiVideos",
                capability: "video",
                display_name: "OpenAI-compatible · Videos API",
                url_example: "https://api.openai.com/v1/videos",
                subdir: "video",
                filename: "openai-videos.lua",
                source: include_str!("../../converter-scripts/video/openai-videos.lua"),
            },
            ScriptDef {
                protocol_id: "gemini",
                capability: "text",
                display_name: "Google Gemini · generateContent",
                url_example: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
                subdir: "text",
                filename: "gemini.lua",
                source: include_str!("../../converter-scripts/text/gemini.lua"),
            },
            ScriptDef {
                protocol_id: "geminiVideo",
                capability: "video",
                display_name: "Google Gemini · long-running (Veo)",
                url_example: "https://generativelanguage.googleapis.com/v1beta/models/veo-3:predictLongRunning",
                subdir: "video",
                filename: "gemini-video.lua",
                source: include_str!("../../converter-scripts/video/gemini-video.lua"),
            },
        ],
    },
    // Batch 2: Bailian Video + Bailian Speech
    ScriptGroup {
        batch: 2,
        scripts: &[
            ScriptDef {
                protocol_id: "bailianVideo",
                capability: "video",
                display_name: "Alibaba Cloud · Bailian Video",
                url_example: "https://{workspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis",
                subdir: "video",
                filename: "bailian-video.lua",
                source: include_str!("../../converter-scripts/video/bailian-video.lua"),
            },
            ScriptDef {
                protocol_id: "bailianSpeech",
                capability: "audio",
                display_name: "Alibaba Cloud · Bailian Speech (CosyVoice TTS)",
                url_example: "https://{workspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer",
                subdir: "audio",
                filename: "bailian-speech.lua",
                source: include_str!("../../converter-scripts/audio/bailian-speech.lua"),
            },
        ],
    },
    // Batch 3: Bailian speech recognition
    ScriptGroup {
        batch: 3,
        scripts: &[ScriptDef {
            protocol_id: "bailianAsr",
            capability: "asr",
            display_name: "Alibaba Cloud · Bailian Speech Recognition (recording file)",
            url_example: "https://{workspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/asr/transcription",
            subdir: "asr",
            filename: "bailian-asr.lua",
            source: include_str!("../../converter-scripts/asr/bailian-asr.lua"),
        }],
    },
];

/// Ensures all built-in converter scripts are deployed to the converter
/// directory, creating or updating the meta.json as needed.
///
/// Called once at startup. Only deploys script groups whose batch number
/// is greater than the currently recorded batch in meta.json.
pub async fn ensure_deployed(root: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let mut registry = ConverterRegistry::load(root).await;
    let current_batch = registry.current_batch();
    let mut max_deployed = current_batch;

    for group in BUILTIN_GROUPS {
        if group.batch <= current_batch {
            continue;
        }
        for def in group.scripts {
            let subdir = root.join(def.subdir);
            tokio::fs::create_dir_all(&subdir).await?;

            let script_path = subdir.join(def.filename);
            tokio::fs::write(&script_path, def.source).await?;

            let entry = ProtocolEntry {
                script: format!("{}/{}", def.subdir, def.filename),
                display_name: def.display_name.to_string(),
                url_example: def.url_example.to_string(),
            };
            registry
                .add_protocol(def.capability, def.protocol_id, entry)
                .await
                .map_err(|e| format!("failed to update meta.json: {e}"))?;
        }
        if group.batch > max_deployed {
            max_deployed = group.batch;
        }
    }

    if max_deployed > current_batch {
        registry.set_batch(max_deployed).await?;
    }

    set_converter_root(root.to_path_buf());
    Ok(())
}
