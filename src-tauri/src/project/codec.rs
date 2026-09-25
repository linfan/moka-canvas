use crate::domain::story::STORY_SCHEMA_VERSION;
use crate::domain::validate::resource_path_valid;
use crate::domain::{reconcile_ports, MokaFile, CANVAS_SCHEMA_VERSION, MOKA_FILE_VERSION};
use thiserror::Error;

pub const MOKA_MAGIC: [u8; 4] = [0x4d, 0x4f, 0x4b, 0x41];

#[derive(Debug, Error)]
pub enum CodecError {
    #[error("canvas.moka does not start with the MOKA magic bytes")]
    MagicInvalid,
    #[error("canvas.moka contains invalid BSON: {0}")]
    BsonInvalid(String),
    #[error("canvas.moka version \"{0}\" is not supported (expected \"v1\")")]
    VersionUnsupported(String),
    #[error("canvas.moka schema version {0} is not supported")]
    SchemaUnsupported(i32),
    #[error("canvas.moka is missing required field \"{0}\"")]
    FieldMissing(&'static str),
    #[error("canvas.moka resource path escapes the project root: {0}")]
    PathEscape(String),
    #[error("canvas.moka would be {actual} bytes, exceeding the {limit} byte limit")]
    TooLarge { actual: usize, limit: u64 },
}

impl CodecError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::MagicInvalid => "MOKA_MAGIC_INVALID",
            Self::BsonInvalid(_) => "MOKA_BSON_INVALID",
            Self::VersionUnsupported(_) => "MOKA_VERSION_UNSUPPORTED",
            Self::SchemaUnsupported(_) => "MOKA_VERSION_UNSUPPORTED",
            Self::FieldMissing(_) => "MOKA_FIELD_MISSING",
            Self::PathEscape(_) => "PATH_ESCAPE",
            Self::TooLarge { .. } => "MOKA_TOO_LARGE",
        }
    }
}

pub fn encode_moka_file(moka: &MokaFile, max_bytes: Option<u64>) -> Result<Vec<u8>, CodecError> {
    let bson =
        bson::serialize_to_vec(moka).map_err(|error| CodecError::BsonInvalid(error.to_string()))?;
    let mut bytes = Vec::with_capacity(4 + bson.len());
    bytes.extend_from_slice(&MOKA_MAGIC);
    bytes.extend_from_slice(&bson);
    if let Some(limit) = max_bytes {
        if bytes.len() as u64 > limit {
            return Err(CodecError::TooLarge {
                actual: bytes.len(),
                limit,
            });
        }
    }
    Ok(bytes)
}

pub fn decode_moka_file(bytes: &[u8]) -> Result<MokaFile, CodecError> {
    if bytes.len() < 5 {
        return Err(CodecError::BsonInvalid(
            "canvas.moka is too small to be valid".into(),
        ));
    }
    if bytes[..4] != MOKA_MAGIC {
        return Err(CodecError::MagicInvalid);
    }
    let mut moka: MokaFile = bson::deserialize_from_slice(&bytes[4..])
        .map_err(|error| CodecError::BsonInvalid(error.to_string()))?;

    if moka.version.is_empty() {
        return Err(CodecError::FieldMissing("version"));
    }
    if moka.version != MOKA_FILE_VERSION {
        return Err(CodecError::VersionUnsupported(moka.version));
    }
    if moka.metadata.id.is_empty() {
        return Err(CodecError::FieldMissing("metadata.id"));
    }
    for entry in moka.resources.all() {
        if !resource_path_valid(&entry.path) {
            return Err(CodecError::PathEscape(entry.path.clone()));
        }
    }
    for canvas in moka.canvas.iter_mut() {
        if canvas.schema_version > CANVAS_SCHEMA_VERSION {
            return Err(CodecError::SchemaUnsupported(canvas.schema_version));
        }
        canvas.schema_version = CANVAS_SCHEMA_VERSION;
        for node in canvas.nodes.iter_mut() {
            let stored = std::mem::take(&mut node.ports);
            node.ports = reconcile_ports(node.kind, &stored);
        }
    }
    // A story written by a newer build is refused rather than read as though
    // its words meant what this build's words mean, the way a timeline is.
    for story in moka.stories.iter().flatten() {
        if story.schema_version > STORY_SCHEMA_VERSION {
            return Err(CodecError::SchemaUnsupported(story.schema_version));
        }
    }
    Ok(moka)
}

#[cfg(test)]
mod tests {
    use super::*;

    const LEGACY: &[u8] = include_bytes!("../../../fixtures/v1-legacy.moka");

    fn port_ids(moka: &MokaFile, node: usize) -> Vec<&str> {
        moka.canvas[0].nodes[node]
            .ports
            .iter()
            .map(|port| port.id.as_str())
            .collect()
    }

    #[test]
    fn migrates_a_v1_canvas_onto_the_v2_port_table() {
        let moka = decode_moka_file(LEGACY).unwrap();
        assert_eq!(moka.canvas[0].schema_version, CANVAS_SCHEMA_VERSION);
        assert_eq!(
            port_ids(&moka, 0),
            vec!["prompt", "images", "audio", "video", "out", "legacyNote"]
        );
        assert_eq!(port_ids(&moka, 1), vec!["prompt", "images", "mask", "out"]);
        assert_eq!(
            moka.canvas[0].nodes[0].ports.last().unwrap().label,
            "Legacy note"
        );
    }

    #[test]
    fn keeps_migration_idempotent_and_byte_canonical() {
        let once = encode_moka_file(&decode_moka_file(LEGACY).unwrap(), None).unwrap();
        let twice = encode_moka_file(&decode_moka_file(&once).unwrap(), None).unwrap();
        assert_eq!(once, twice);
    }

    #[test]
    fn rejects_a_canvas_schema_from_the_future() {
        let mut moka = decode_moka_file(LEGACY).unwrap();
        moka.canvas[0].schema_version = CANVAS_SCHEMA_VERSION + 1;
        let bytes = encode_moka_file(&moka, None).unwrap();
        assert_eq!(
            decode_moka_file(&bytes).unwrap_err().code(),
            "MOKA_VERSION_UNSUPPORTED"
        );
    }
}
