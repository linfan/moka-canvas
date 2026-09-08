use moka_canvas::domain::validate::{
    mention_node_ids, model_reference_shaped, resource_path_valid, topological_order,
    validate_canvas, validate_moka_file, MAX_PROMPT_LENGTH, MAX_RESULT_SLOTS,
};
use moka_canvas::domain::{
    CanvasDocument, Capability, EdgeEndpoint, GenerationInputMode, GenerationMode, GenerationSpec,
    MokaFile, ResultSlot, ResultSlotStatus, WorkflowEdge, WorkflowNode,
};
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

const TEXT_NODE: &str = "00000000-0000-7000-8000-00000000000a";
const IMAGE_NODE: &str = "00000000-0000-7000-8000-00000000000b";
const OPERATION_NODE: &str = "00000000-0000-7000-8000-00000000000c";

fn golden_canvas() -> CanvasDocument {
    golden_from_json().canvas.into_iter().next().unwrap()
}

fn node_mut<'a>(canvas: &'a mut CanvasDocument, id: &str) -> &'a mut WorkflowNode {
    canvas
        .nodes
        .iter_mut()
        .find(|node| node.id == id)
        .unwrap_or_else(|| panic!("golden canvas has no node {id}"))
}

fn generation(capability: Capability, prompt: &str) -> GenerationSpec {
    GenerationSpec {
        capability,
        mode: GenerationMode::Generate,
        model: String::new(),
        prompt: prompt.into(),
        input_mode: GenerationInputMode::Upstream,
        params: Some(serde_json::json!({})),
        reference_node_ids: Some(Vec::new()),
        updated_at: "2026-01-01T00:00:00.000Z".into(),
    }
}

fn flagged(canvas: &CanvasDocument, node_id: &str, code: &str) -> bool {
    validate_canvas(canvas)
        .iter()
        .any(|issue| issue.code == code && issue.node_id.as_deref() == Some(node_id))
}

fn has_code(canvas: &CanvasDocument, code: &str) -> bool {
    validate_canvas(canvas)
        .iter()
        .any(|issue| issue.code == code)
}

fn messages(canvas: &CanvasDocument, code: &str) -> Vec<String> {
    validate_canvas(canvas)
        .iter()
        .filter(|issue| issue.code == code)
        .map(|issue| issue.message.clone())
        .collect()
}

#[test]
fn golden_canvas_stays_clean_without_generation_specs() {
    assert!(validate_canvas(&golden_canvas()).is_empty());
}

#[test]
fn flags_a_spec_that_disagrees_with_its_node() {
    let mut canvas = golden_canvas();
    let mut broken = generation(Capability::Image, "Redraw @[node:missing] in ink");
    broken.model = "painter".into();
    node_mut(&mut canvas, TEXT_NODE).data.generation = Some(broken);

    assert!(flagged(
        &canvas,
        TEXT_NODE,
        "GENERATION_CAPABILITY_MISMATCH"
    ));
    assert!(flagged(&canvas, TEXT_NODE, "GENERATION_MODEL_MISSING"));
    assert!(flagged(&canvas, TEXT_NODE, "MENTION_NODE_NOT_FOUND"));
}

#[test]
fn structural_nodes_cannot_carry_a_spec() {
    let mut canvas = golden_canvas();
    node_mut(&mut canvas, OPERATION_NODE).data.generation =
        Some(generation(Capability::Text, "Summarise the board"));
    assert!(flagged(
        &canvas,
        OPERATION_NODE,
        "GENERATION_CAPABILITY_MISMATCH"
    ));
}

#[test]
fn flags_a_prompt_that_mentions_its_own_node() {
    let mut canvas = golden_canvas();
    node_mut(&mut canvas, TEXT_NODE).data.generation = Some(generation(
        Capability::Text,
        &format!("Rewrite @[node:{TEXT_NODE}]"),
    ));
    assert!(flagged(&canvas, TEXT_NODE, "MENTION_SELF_REFERENCE"));
}

#[test]
fn empty_prompt_needs_upstream_or_references() {
    let mut canvas = golden_canvas();
    node_mut(&mut canvas, TEXT_NODE).data.generation = Some(generation(Capability::Text, "   "));
    node_mut(&mut canvas, IMAGE_NODE).data.generation = Some(generation(Capability::Image, ""));
    assert!(flagged(&canvas, TEXT_NODE, "GENERATION_PROMPT_EMPTY"));
    assert!(flagged(&canvas, IMAGE_NODE, "GENERATION_PROMPT_EMPTY"));

    canvas.edges.push(WorkflowEdge {
        id: "00000000-0000-7000-8000-000000000021".into(),
        source: EdgeEndpoint {
            node_id: TEXT_NODE.into(),
            port_id: "out".into(),
        },
        target: EdgeEndpoint {
            node_id: IMAGE_NODE.into(),
            port_id: "prompt".into(),
        },
        created_at: "2026-01-01T00:00:00.000Z".into(),
    });

    assert!(!flagged(&canvas, IMAGE_NODE, "GENERATION_PROMPT_EMPTY"));
    assert!(!has_code(&canvas, "PORT_TYPE_MISMATCH"));
    assert!(flagged(&canvas, TEXT_NODE, "GENERATION_PROMPT_EMPTY"));
}

#[test]
fn references_alone_satisfy_an_empty_prompt() {
    let mut canvas = golden_canvas();
    let mut spec = generation(Capability::Image, "");
    spec.input_mode = GenerationInputMode::Manual;
    spec.reference_node_ids = Some(vec![TEXT_NODE.into()]);
    node_mut(&mut canvas, IMAGE_NODE).data.generation = Some(spec);
    assert!(!flagged(&canvas, IMAGE_NODE, "GENERATION_PROMPT_EMPTY"));
}

#[test]
fn rejects_unknown_generation_params() {
    let mut canvas = golden_canvas();
    let mut spec = generation(Capability::Image, "A poster of the lake");
    spec.params = Some(serde_json::json!({ "size": "1:1", "brush": "wet" }));
    node_mut(&mut canvas, IMAGE_NODE).data.generation = Some(spec);

    assert_eq!(
        messages(&canvas, "VALIDATION_FAILED"),
        ["Unknown parameter \"brush\" for image generation"]
    );
}

#[test]
fn rejects_an_overlong_prompt() {
    let mut canvas = golden_canvas();
    let long = "a".repeat(MAX_PROMPT_LENGTH + 1);
    node_mut(&mut canvas, TEXT_NODE).data.generation = Some(generation(Capability::Text, &long));

    assert_eq!(
        messages(&canvas, "VALIDATION_FAILED"),
        [format!(
            "Generation prompt exceeds the {MAX_PROMPT_LENGTH} character limit"
        )]
    );
}

#[test]
fn enforces_the_result_slot_limit() {
    let mut canvas = golden_canvas();
    node_mut(&mut canvas, OPERATION_NODE).data.result_slots = Some(
        (0..MAX_RESULT_SLOTS + 1)
            .map(|index| ResultSlot {
                id: format!("slot-{index}"),
                status: ResultSlotStatus::Empty,
                asset_id: None,
                text: None,
                error: None,
                is_primary: index == 0,
            })
            .collect(),
    );
    assert!(flagged(&canvas, OPERATION_NODE, "RESULT_SLOT_LIMIT"));
}

#[test]
fn mention_and_model_shapes() {
    assert_eq!(
        mention_node_ids("Paint @[node:a] beside @[node:b]"),
        vec!["a", "b"]
    );
    assert!(mention_node_ids("no mentions here").is_empty());
    assert!(mention_node_ids("@[node:] and @[node").is_empty());

    assert!(model_reference_shaped("main::painter"));
    assert!(!model_reference_shaped("::painter"));
    assert!(!model_reference_shaped("main::"));
    assert!(!model_reference_shaped("painter"));
}
