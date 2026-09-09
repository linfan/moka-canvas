//! Turning a provider's answer into project assets.
//!
//! The upload pipeline already sniffs, hashes, probes, promotes and registers a
//! file, and a generated answer is a file like any other once it exists — so
//! this writes the bytes somewhere temporary and hands them over rather than
//! growing a second pipeline that would drift from the first.
//!
//! What a generated asset carries that an uploaded one does not is where it
//! came from: the run, the node, the inputs that travelled, and the parameters
//! that were asked for. That is what makes an answer traceable and what lets an
//! editor offer to ask for it again, so it is assembled here rather than left
//! for whoever writes the node back.

use super::{GenerateResult, ResolvedInputs};
use crate::assets::new_tmp_path;
use crate::domain::{
    now_iso, AssetId, AssetProvenance, Capability, GenerationSpec, ResourceEntry, RunRecord,
    WorkflowNode,
};
use crate::project::{ProjectError, ProjectStore, StagedAsset};

/// How much of the run id an asset's name carries: enough to tell two runs of
/// the same node apart, short enough to stay readable beside the title.
const RUN_NAME_CHARS: usize = 8;

/// One thing to write, borrowed from the answer it came out of.
struct Piece<'a> {
    bytes: &'a [u8],
    mime: &'a str,
    kind: Capability,
}

/// Writes every part of a provider's answer into the project and reports what
/// landed, in the order the answer gave it. An answer with nothing to write —
/// an empty result, or a caption beside images that were written — reports
/// nothing rather than inventing an asset.
///
/// Either every part is registered or none is: a half-ingested answer would sit
/// in the resources panel as clutter nobody asked for, with no node to point at
/// it.
pub async fn ingest_generated(
    store: &dyn ProjectStore,
    run: &RunRecord,
    node: &WorkflowNode,
    inputs: &ResolvedInputs,
    result: &GenerateResult,
) -> Result<Vec<ResourceEntry>, ProjectError> {
    let pieces = pieces(result);
    if pieces.is_empty() {
        return Ok(Vec::new());
    }
    let root = store
        .current()
        .await?
        .ok_or_else(|| ProjectError::domain("PROJECT_NOT_OPEN", "No project is open"))?
        .root;
    let spec = node.data.generation.as_ref();
    let provenance = provenance(run, node, spec, inputs);

    let mut staged = Vec::with_capacity(pieces.len());
    for (index, piece) in pieces.iter().enumerate() {
        let tmp_path = new_tmp_path(&root)?;
        if let Err(error) = std::fs::write(&tmp_path, piece.bytes) {
            let _ = std::fs::remove_file(&tmp_path);
            discard(&mut staged);
            return Err(error.into());
        }
        staged.push(StagedAsset {
            name: display_name(node, run, index, pieces.len()),
            tmp_path,
            declared_mime: Some(piece.mime.to_string()),
            category_hint: category_hint(piece.kind, spec),
            provenance: Some(provenance.clone()),
        });
    }

    let mut entries = Vec::with_capacity(staged.len());
    while !staged.is_empty() {
        // The store takes the file it is handed, so the ones still waiting go
        // one at a time and stay reachable for cleanup until they do.
        match store.add_asset(staged.remove(0)).await {
            Ok(change) => entries.push(change.entry),
            Err(error) => {
                discard(&mut staged);
                for entry in entries.iter().rev() {
                    let _ = store.remove_asset(&entry.id).await;
                }
                return Err(error);
            }
        }
    }
    Ok(entries)
}

/// The parts of an answer worth keeping as files.
///
/// A caption beside an image is not one: it belongs on the node, where the
/// reader sees it next to the picture it describes. Text becomes an asset only
/// when it is the whole answer.
fn pieces(result: &GenerateResult) -> Vec<Piece<'_>> {
    if result.items.is_empty() {
        return match result.text.as_deref() {
            Some(text) if !text.trim().is_empty() => vec![Piece {
                bytes: text.as_bytes(),
                mime: "text/plain",
                kind: Capability::Text,
            }],
            _ => Vec::new(),
        };
    }
    result
        .items
        .iter()
        .map(|item| Piece {
            bytes: &item.bytes,
            mime: item.mime.as_str(),
            kind: item.kind,
        })
        .collect()
}

/// Leaves nothing behind for an ingest that did not finish: files still waiting
/// in tmp are deleted, and the store collects the rest the next time the project
/// opens.
fn discard(staged: &mut Vec<StagedAsset>) {
    for asset in staged.drain(..) {
        let _ = std::fs::remove_file(asset.tmp_path);
    }
}

/// The name the resources panel shows. The run's short id keeps two answers
/// from one node apart; the index only appears when there is more than one, so
/// a single result is never called the first of one.
fn display_name(node: &WorkflowNode, run: &RunRecord, index: usize, count: usize) -> String {
    let short: String = run.id.chars().take(RUN_NAME_CHARS).collect();
    if count > 1 {
        format!("{}-{short}-{}", node.title, index + 1)
    } else {
        format!("{}-{short}", node.title)
    }
}

/// Audio is the one category a sniffer cannot settle, so the store's hint is
/// what tells speech from music. Everything else follows its mime.
fn category_hint(kind: Capability, spec: Option<&GenerationSpec>) -> Option<String> {
    if kind != Capability::Audio {
        return None;
    }
    let music = spec
        .and_then(|spec| spec.params.as_ref())
        .and_then(|params| params.get("music"))
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    (!music).then(|| "voice".to_string())
}

fn provenance(
    run: &RunRecord,
    node: &WorkflowNode,
    spec: Option<&GenerationSpec>,
    inputs: &ResolvedInputs,
) -> AssetProvenance {
    let consumed: Vec<AssetId> = inputs
        .inputs
        .iter()
        .map(|input| input.asset_id.clone())
        .collect();
    AssetProvenance {
        run_id: Some(run.id.clone()),
        canvas_id: Some(run.canvas_id.clone()),
        operation_node_id: Some(node.id.clone()),
        input_asset_ids: if consumed.is_empty() {
            None
        } else {
            Some(consumed)
        },
        parameter_snapshot: spec.map(parameter_snapshot),
        created_at: now_iso(),
    }
}

/// The spec that was answered, without the timestamp saying when it was last
/// edited: a snapshot records what to ask for again, not when it was asked for.
///
/// It keeps the spec's own field names so that asking again is a deserialize
/// rather than a field-by-field copy that can drift from the type it copies
/// from. Nothing here reaches past the spec, which is what keeps a stored
/// credential out of the document: the model is a `channelId::modelId`
/// reference, and the key that reference resolves to is fetched at send time.
fn parameter_snapshot(spec: &GenerationSpec) -> serde_json::Value {
    let mut snapshot = serde_json::to_value(spec).unwrap_or_default();
    if let Some(fields) = snapshot.as_object_mut() {
        fields.remove("updatedAt");
    }
    snapshot
}
