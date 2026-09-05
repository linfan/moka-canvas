use crate::domain::validate::resource_path_valid;
use crate::domain::{MokaFile, MOKA_FILE_VERSION};
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
    let moka: MokaFile = bson::deserialize_from_slice(&bytes[4..])
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
    Ok(moka)
}
