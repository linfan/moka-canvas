use moka_canvas::domain::validate::{resource_path_valid, topological_order, validate_moka_file};
use moka_canvas::domain::MokaFile;
use moka_canvas::project::codec::{decode_moka_file, encode_moka_file, CodecError};
use std::path::PathBuf;

fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("fixtures")
        .join(name)
}

fn golden_from_json() -> MokaFile {
    let raw = std::fs::read_to_string(fixture_path("minimal.moka.json")).unwrap();
    serde_json::from_str(&raw).unwrap()
}

#[test]
fn golden_binary_decodes_to_golden_json_model() {
    let bytes = std::fs::read(fixture_path("minimal.canvas.moka")).unwrap();
    let decoded = decode_moka_file(&bytes).unwrap();
    let expected = golden_from_json();
    assert_eq!(decoded, expected);
}

#[test]
fn re_encode_is_byte_canonical() {
    let bytes = std::fs::read(fixture_path("minimal.canvas.moka")).unwrap();
    let decoded = decode_moka_file(&bytes).unwrap();
    let reencoded = encode_moka_file(&decoded, None).unwrap();
    assert_eq!(
        bytes, reencoded,
        "Rust re-encode must reproduce the golden bytes exactly"
    );
}

#[test]
fn rejects_bad_magic() {
    let mut bytes = std::fs::read(fixture_path("minimal.canvas.moka")).unwrap();
    bytes[1] = 0x00;
    let error = decode_moka_file(&bytes).unwrap_err();
    assert!(matches!(error, CodecError::MagicInvalid));
    assert_eq!(error.code(), "MOKA_MAGIC_INVALID");
}

#[test]
fn rejects_truncated_bson() {
    let bytes = std::fs::read(fixture_path("minimal.canvas.moka")).unwrap();
    let truncated = &bytes[..bytes.len() - 4];
    let error = decode_moka_file(truncated).unwrap_err();
    assert_eq!(error.code(), "MOKA_BSON_INVALID");
}

#[test]
fn rejects_unknown_version() {
    let mut moka = golden_from_json();
    moka.version = "v2".into();
    let bytes = encode_moka_file(&moka, None).unwrap();
    let error = decode_moka_file(&bytes).unwrap_err();
    assert!(matches!(error, CodecError::VersionUnsupported(_)));
}

#[test]
fn enforces_size_cap() {
    let moka = golden_from_json();
    let error = encode_moka_file(&moka, Some(16)).unwrap_err();
    assert!(matches!(error, CodecError::TooLarge { .. }));
}

#[test]
fn golden_document_passes_validation() {
    let moka = golden_from_json();
    assert!(validate_moka_file(&moka).is_empty());
}

#[test]
fn golden_canvas_has_deterministic_topological_order() {
    let moka = golden_from_json();
    let canvas = &moka.canvas[0];
    let order: Vec<&str> = topological_order(canvas)
        .iter()
        .map(|node| node.id.as_str())
        .collect();
    let text = "00000000-0000-7000-8000-00000000000a";
    let operation = "00000000-0000-7000-8000-00000000000c";
    let export = "00000000-0000-7000-8000-00000000000d";
    let pos = |id: &str| order.iter().position(|candidate| *candidate == id).unwrap();
    assert!(pos(text) < pos(operation));
    assert!(pos(operation) < pos(export));
}

#[test]
fn resource_path_rules() {
    assert!(resource_path_valid("assets/images/a.png"));
    assert!(!resource_path_valid("../a.png"));
    assert!(!resource_path_valid("/etc/passwd"));
    assert!(!resource_path_valid("assets//a.png"));
    assert!(!resource_path_valid("assets/./a.png"));
    assert!(!resource_path_valid("C:/a.png"));
}
