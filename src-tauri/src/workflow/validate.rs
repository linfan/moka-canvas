//! Authoritative run validation and the immutable snapshot a run executes
//! against. Edit-time checks live in `domain::validate`; this module adds the
//! run-specific phases from the execution contract.

use super::{ExecutionRequest, ValueProvenance, WorkflowExecutor, WorkflowValue};
use crate::domain::validate::topological_order;
use crate::domain::{
    CanvasDocument, CanvasId, DataType, MokaFile, NodeId, NodeKind, ValidationIssue, WorkflowEdge,
    WorkflowNode,
};
use sha2::Digest;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;

/// The frozen graph a run executes: closure nodes/edges in deterministic
/// order plus the content hash recorded on the run record.
#[derive(Debug, Clone)]
pub struct RunSnapshot {
    pub canvas_id: CanvasId,
    pub order: Vec<NodeId>,
    pub nodes: BTreeMap<NodeId, WorkflowNode>,
    /// Edges inside the closure, sorted by creation time then id — the
    /// input resolution order the contract mandates.
    pub edges: Vec<WorkflowEdge>,
    pub graph_hash: String,
}

impl RunSnapshot {
    /// Resolves one node's input ports from the snapshot. Upstream operation
    /// outputs become empty placeholders of the right type — validation only
    /// needs shape, not content.
    pub fn resolved_inputs(&self, node_id: &str) -> BTreeMap<String, Vec<WorkflowValue>> {
        let mut inputs: BTreeMap<String, Vec<WorkflowValue>> = BTreeMap::new();
        let Some(node) = self.nodes.get(node_id) else {
            return inputs;
        };
        for edge in self.edges_for_target(node_id) {
            let Some(source) = self.nodes.get(&edge.source.node_id) else {
                continue;
            };
            let value = snapshot_value(source, &edge.source.port_id);
            inputs
                .entry(edge.target.port_id.clone())
                .or_default()
                .push(value);
        }
        for port in &node.ports {
            if port.direction == crate::domain::PortDirection::Input {
                inputs.entry(port.id.clone()).or_default();
            }
        }
        inputs
    }

    pub fn edges_for_target<'a>(
        &'a self,
        node_id: &'a str,
    ) -> impl Iterator<Item = &'a WorkflowEdge> + 'a {
        self.edges
            .iter()
            .filter(move |edge| edge.target.node_id == node_id)
    }

    /// The snapshot-time value a source node emits on its output port.
    pub fn source_value(&self, node_id: &str) -> Option<WorkflowValue> {
        self.nodes
            .get(node_id)
            .map(|node| snapshot_value(node, "out"))
    }
}

/// A node's value as fixed at snapshot time (operations resolve for real
/// during the run).
fn snapshot_value(node: &WorkflowNode, port_id: &str) -> WorkflowValue {
    let source = ValueProvenance {
        node_id: node.id.clone(),
        port_id: port_id.to_string(),
    };
    match node.kind {
        NodeKind::Text => WorkflowValue::Text {
            text: node.data.content.clone().unwrap_or_default(),
            source,
        },
        NodeKind::Image | NodeKind::Audio | NodeKind::Video => WorkflowValue::Media {
            media_type: match node.kind {
                NodeKind::Image => DataType::Image,
                NodeKind::Audio => DataType::Audio,
                _ => DataType::Video,
            },
            asset_id: node.data.asset_id.clone().unwrap_or_default(),
            source,
        },
        _ => WorkflowValue::Text {
            text: String::new(),
            source,
        },
    }
}

fn issue(
    code: &str,
    message: impl Into<String>,
    canvas_id: &str,
    node_id: Option<NodeId>,
    port_id: Option<String>,
) -> ValidationIssue {
    ValidationIssue {
        code: code.to_string(),
        message: message.into(),
        canvas_id: Some(canvas_id.to_string()),
        node_id,
        port_id,
        edge_id: None,
    }
}

/// Validates a run request against the current document and returns the
/// executable snapshot on success. Every actionable problem is reported in
/// one pass; nothing starts when this fails.
pub async fn validate_run(
    root: &Path,
    moka: &MokaFile,
    canvas_id: &str,
    requested: &[NodeId],
    executors: &[Arc<dyn WorkflowExecutor>],
    enabled_executors: &[String],
) -> Result<RunSnapshot, Vec<ValidationIssue>> {
    let mut issues = Vec::new();
    let Some(canvas) = moka.canvas(canvas_id) else {
        return Err(vec![issue(
            "CANVAS_NOT_FOUND",
            "The requested canvas does not exist",
            canvas_id,
            None,
            None,
        )]);
    };

    if requested.is_empty() {
        issues.push(issue(
            "VALIDATION_FAILED",
            "No nodes requested",
            canvas_id,
            None,
            None,
        ));
    }
    let mut seen_requested = HashSet::new();
    for node_id in requested {
        if !seen_requested.insert(node_id) {
            issues.push(issue(
                "VALIDATION_FAILED",
                "Duplicate requested node",
                canvas_id,
                Some(node_id.clone()),
                None,
            ));
            continue;
        }
        match canvas.node(node_id) {
            None => issues.push(issue(
                "NODE_NOT_FOUND",
                "Requested node does not exist",
                canvas_id,
                Some(node_id.clone()),
                None,
            )),
            Some(node) if !executable_kind(node.kind) => issues.push(issue(
                "NOT_EXECUTABLE",
                format!("{} nodes cannot be run", kind_label(node.kind)),
                canvas_id,
                Some(node_id.clone()),
                None,
            )),
            _ => {}
        }
    }
    if !issues.is_empty() {
        return Err(issues);
    }

    let closure = upstream_closure(canvas, requested);
    let scoped = scoped_canvas(canvas, &closure);
    issues.extend(crate::domain::validate::validate_canvas(&scoped));

    let mut edges: Vec<WorkflowEdge> = scoped.edges.clone();
    edges.sort_by(|a, b| {
        a.created_at
            .cmp(&b.created_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    let snapshot = build_snapshot(canvas_id, &scoped, edges);

    for node_id in &snapshot.order {
        let node = &snapshot.nodes[node_id];
        match node.kind {
            NodeKind::Operation => {
                validate_operation(
                    node,
                    &snapshot,
                    executors,
                    enabled_executors,
                    canvas_id,
                    &mut issues,
                )
                .await;
            }
            NodeKind::Image | NodeKind::Audio | NodeKind::Video => {
                validate_media_node(root, moka, node, canvas_id, &mut issues);
            }
            _ => {}
        }
    }

    if !issues.is_empty() {
        return Err(issues);
    }
    Ok(snapshot)
}

fn executable_kind(kind: NodeKind) -> bool {
    matches!(kind, NodeKind::Operation)
}

fn kind_label(kind: NodeKind) -> &'static str {
    match kind {
        NodeKind::Text => "Text",
        NodeKind::Image => "Image",
        NodeKind::Audio => "Audio",
        NodeKind::Video => "Video",
        NodeKind::Operation => "Operation",
        NodeKind::Group => "Group",
        NodeKind::Export => "Export",
    }
}

/// All nodes reachable upstream from the requested set, requested included.
fn upstream_closure(canvas: &CanvasDocument, requested: &[NodeId]) -> HashSet<NodeId> {
    let mut incoming: HashMap<&str, Vec<&str>> = HashMap::new();
    for edge in &canvas.edges {
        incoming
            .entry(edge.target.node_id.as_str())
            .or_default()
            .push(edge.source.node_id.as_str());
    }
    let mut closure = HashSet::new();
    let mut stack: Vec<&str> = requested.iter().map(String::as_str).collect();
    while let Some(node_id) = stack.pop() {
        if !closure.insert(node_id.to_string()) {
            continue;
        }
        if let Some(sources) = incoming.get(node_id) {
            stack.extend(sources.iter().copied());
        }
    }
    closure
}

fn scoped_canvas(canvas: &CanvasDocument, closure: &HashSet<NodeId>) -> CanvasDocument {
    let mut scoped = canvas.clone();
    scoped.nodes.retain(|node| closure.contains(&node.id));
    scoped.edges.retain(|edge| {
        closure.contains(&edge.source.node_id) && closure.contains(&edge.target.node_id)
    });
    scoped
}

fn build_snapshot(
    canvas_id: &str,
    scoped: &CanvasDocument,
    edges: Vec<WorkflowEdge>,
) -> RunSnapshot {
    let order: Vec<NodeId> = topological_order(scoped)
        .into_iter()
        .map(|node| node.id.clone())
        .collect();
    let nodes: BTreeMap<NodeId, WorkflowNode> = scoped
        .nodes
        .iter()
        .map(|node| (node.id.clone(), node.clone()))
        .collect();
    let canonical = serde_json::json!({
        "nodes": order.iter().map(|id| &nodes[id]).collect::<Vec<_>>(),
        "edges": edges,
    });
    let hash = hex::encode(sha2::Sha256::digest(canonical.to_string().as_bytes()));
    RunSnapshot {
        canvas_id: canvas_id.to_string(),
        order,
        nodes,
        edges,
        graph_hash: hash,
    }
}

async fn validate_operation(
    node: &WorkflowNode,
    snapshot: &RunSnapshot,
    executors: &[Arc<dyn WorkflowExecutor>],
    enabled_executors: &[String],
    canvas_id: &str,
    issues: &mut Vec<ValidationIssue>,
) {
    let executor_key = node.data.executor_key.clone().unwrap_or_default();
    if executor_key.is_empty() {
        issues.push(issue(
            "EXECUTOR_DISABLED",
            format!("Operation \"{}\" declares no executor", node.title),
            canvas_id,
            Some(node.id.clone()),
            None,
        ));
        return;
    }
    if !enabled_executors.contains(&executor_key) {
        issues.push(issue(
            "EXECUTOR_DISABLED",
            format!("Executor \"{executor_key}\" is disabled in the startup configuration"),
            canvas_id,
            Some(node.id.clone()),
            None,
        ));
        return;
    }
    let operation_type = node.data.operation_type.clone().unwrap_or_default();
    let Some(executor) = executors
        .iter()
        .find(|executor| executor.key() == executor_key && executor.supports(&operation_type))
    else {
        issues.push(issue(
            "OPERATION_UNSUPPORTED",
            format!("No enabled executor supports \"{operation_type}\""),
            canvas_id,
            Some(node.id.clone()),
            None,
        ));
        return;
    };

    let request = ExecutionRequest {
        run_id: String::new(),
        node_id: node.id.clone(),
        operation_type,
        parameters: node
            .data
            .parameters
            .clone()
            .unwrap_or(serde_json::Value::Null),
        inputs: snapshot.resolved_inputs(&node.id),
    };
    if let Err(error) = executor.validate(&request).await {
        issues.extend(error.issues.into_iter().map(|mut item| {
            item.canvas_id = Some(canvas_id.to_string());
            if item.node_id.is_none() {
                item.node_id = Some(node.id.clone());
            }
            item
        }));
    }
}

fn validate_media_node(
    root: &Path,
    moka: &MokaFile,
    node: &WorkflowNode,
    canvas_id: &str,
    issues: &mut Vec<ValidationIssue>,
) {
    let Some(asset_id) = node.data.asset_id.clone() else {
        issues.push(issue(
            "ASSET_MISSING",
            format!(
                "{} node \"{}\" has no asset bound",
                kind_label(node.kind),
                node.title
            ),
            canvas_id,
            Some(node.id.clone()),
            None,
        ));
        return;
    };
    let Some(entry) = moka.resources.find(&asset_id) else {
        issues.push(issue(
            "ASSET_MISSING",
            format!("Node \"{}\" references an unregistered asset", node.title),
            canvas_id,
            Some(node.id.clone()),
            None,
        ));
        return;
    };
    let path = root.join(&entry.path);
    let reason = match std::fs::metadata(&path) {
        Err(_) => Some("missing on disk"),
        Ok(meta) if !meta.is_file() || meta.len() == 0 => Some("missing on disk"),
        Ok(meta) => match (&entry.sha256, entry.bytes) {
            (Some(expected), _) if entry.bytes.map(|b| b as u64 != meta.len()).unwrap_or(false) => {
                let _ = expected;
                Some("changed on disk")
            }
            (Some(expected), _) => match std::fs::read(&path) {
                Ok(bytes) => {
                    let actual = hex::encode(sha2::Sha256::digest(&bytes));
                    if actual != *expected {
                        Some("changed on disk")
                    } else {
                        None
                    }
                }
                Err(_) => Some("missing on disk"),
            },
            _ => None,
        },
    };
    if let Some(reason) = reason {
        issues.push(issue(
            "ASSET_NOT_READY",
            format!("Asset \"{}\" is {reason}", entry.name),
            canvas_id,
            Some(node.id.clone()),
            None,
        ));
    }
}
