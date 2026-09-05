pub mod commands;
pub mod validate;

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub type ProjectId = String;
pub type CanvasId = String;
pub type NodeId = String;
pub type EdgeId = String;
pub type AssetId = String;
pub type RunId = String;
pub type IsoTimestamp = String;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Viewport {
    pub x: f64,
    pub y: f64,
    pub zoom: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMetadata {
    pub id: ProjectId,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover_path: Option<String>,
    pub revision: i32,
    pub created_at: IsoTimestamp,
    pub updated_at: IsoTimestamp,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetProbe {
    pub mime: String,
    pub bytes: i64,
    pub sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample_rate: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channels: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codec_summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poster_asset_id: Option<AssetId>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetProvenance {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<RunId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canvas_id: Option<CanvasId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_node_id: Option<NodeId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_asset_ids: Option<Vec<AssetId>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parameter_snapshot: Option<serde_json::Value>,
    pub created_at: IsoTimestamp,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceEntry {
    pub id: AssetId,
    pub name: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    pub created_at: IsoTimestamp,
    pub updated_at: IsoTimestamp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub probe: Option<AssetProbe>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provenance: Option<AssetProvenance>,
}

pub const ASSET_CATEGORIES: [&str; 5] = ["images", "music", "voice", "texts", "videos"];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct ResourceRegistry {
    #[serde(default)]
    pub images: Vec<ResourceEntry>,
    #[serde(default)]
    pub music: Vec<ResourceEntry>,
    #[serde(default)]
    pub voice: Vec<ResourceEntry>,
    #[serde(default)]
    pub texts: Vec<ResourceEntry>,
    #[serde(default)]
    pub videos: Vec<ResourceEntry>,
}

impl ResourceRegistry {
    pub fn category_mut(&mut self, category: &str) -> Option<&mut Vec<ResourceEntry>> {
        match category {
            "images" => Some(&mut self.images),
            "music" => Some(&mut self.music),
            "voice" => Some(&mut self.voice),
            "texts" => Some(&mut self.texts),
            "videos" => Some(&mut self.videos),
            _ => None,
        }
    }

    pub fn category(&self, category: &str) -> Option<&Vec<ResourceEntry>> {
        match category {
            "images" => Some(&self.images),
            "music" => Some(&self.music),
            "voice" => Some(&self.voice),
            "texts" => Some(&self.texts),
            "videos" => Some(&self.videos),
            _ => None,
        }
    }

    pub fn all(&self) -> impl Iterator<Item = &ResourceEntry> {
        ASSET_CATEGORIES
            .iter()
            .filter_map(|c| self.category(c))
            .flatten()
    }

    pub fn find(&self, id: &str) -> Option<&ResourceEntry> {
        self.all().find(|entry| entry.id == id)
    }

    pub fn find_mut(&mut self, id: &str) -> Option<&mut ResourceEntry> {
        let category = ASSET_CATEGORIES.into_iter().find(|category| {
            self.category(category)
                .map(|list| list.iter().any(|entry| entry.id == id))
                .unwrap_or(false)
        })?;
        self.category_mut(category)
            .and_then(|list| list.iter_mut().find(|entry| entry.id == id))
    }

    pub fn category_of(&self, id: &str) -> Option<&'static str> {
        ASSET_CATEGORIES.iter().copied().find(|category| {
            self.category(category)
                .map(|list| list.iter().any(|entry| entry.id == id))
                .unwrap_or(false)
        })
    }

    pub fn remove(&mut self, id: &str) -> Option<ResourceEntry> {
        for category in ASSET_CATEGORIES {
            if let Some(list) = self.category_mut(category) {
                if let Some(index) = list.iter().position(|entry| entry.id == id) {
                    return Some(list.remove(index));
                }
            }
        }
        None
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BackgroundMode {
    Dots,
    Lines,
    Blank,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSettings {
    pub background: BackgroundMode,
    pub show_minimap: bool,
    pub snap_to_grid: bool,
}

impl Default for DocumentSettings {
    fn default() -> Self {
        Self {
            background: BackgroundMode::Dots,
            show_minimap: true,
            snap_to_grid: true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NodeKind {
    Text,
    Image,
    Audio,
    Video,
    Operation,
    Group,
    Export,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DataType {
    Text,
    Image,
    Audio,
    Video,
    Timeline,
    Artifact,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PortDirection {
    Input,
    Output,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Cardinality {
    One,
    Many,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortDefinition {
    pub id: String,
    pub direction: PortDirection,
    pub data_types: Vec<DataType>,
    pub required: bool,
    pub cardinality: Cardinality,
    pub label: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResultSlotStatus {
    Empty,
    Pending,
    Succeeded,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultSlot {
    pub id: String,
    pub status: ResultSlotStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<AssetId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub is_primary: bool,
}

/// Flat node payload; which fields are meaningful is determined by `kind`.
/// Field declaration order must match the TypeScript codec key order so
/// both languages produce byte-identical BSON.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NodeData {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<AssetId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub poster_asset_id: Option<AssetId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio_category: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parameters: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executor_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_slots: Option<Vec<ResultSlot>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_node_ids: Option<Vec<NodeId>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub child_node_ids: Option<Vec<NodeId>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowNode {
    pub id: NodeId,
    pub kind: NodeKind,
    pub title: String,
    pub bounds: Rect,
    pub z_index: i32,
    pub ports: Vec<PortDefinition>,
    pub data: NodeData,
    pub created_at: IsoTimestamp,
    pub updated_at: IsoTimestamp,
}

impl WorkflowNode {
    pub fn port(&self, port_id: &str) -> Option<&PortDefinition> {
        self.ports.iter().find(|port| port.id == port_id)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeEndpoint {
    pub node_id: NodeId,
    pub port_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowEdge {
    pub id: EdgeId,
    pub source: EdgeEndpoint,
    pub target: EdgeEndpoint,
    pub created_at: IsoTimestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupMembership {
    pub group_id: NodeId,
    pub child_node_ids: Vec<NodeId>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasDocument {
    pub id: CanvasId,
    pub name: String,
    pub schema_version: i32,
    pub viewport: Viewport,
    pub nodes: Vec<WorkflowNode>,
    pub edges: Vec<WorkflowEdge>,
    pub groups: Vec<GroupMembership>,
    pub settings: DocumentSettings,
}

impl CanvasDocument {
    pub fn node(&self, node_id: &str) -> Option<&WorkflowNode> {
        self.nodes.iter().find(|node| node.id == node_id)
    }

    pub fn empty(id: CanvasId, name: String) -> Self {
        Self {
            id,
            name,
            schema_version: 1,
            viewport: Viewport {
                x: 0.0,
                y: 0.0,
                zoom: 1.0,
            },
            nodes: Vec::new(),
            edges: Vec::new(),
            groups: Vec::new(),
            settings: DocumentSettings::default(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MokaFile {
    pub version: String,
    pub metadata: ProjectMetadata,
    pub resources: ResourceRegistry,
    pub canvas: Vec<CanvasDocument>,
}

pub const MOKA_FILE_VERSION: &str = "v1";
pub const PACKAGE_MANIFEST_VERSION: u32 = 1;

impl MokaFile {
    pub fn canvas(&self, canvas_id: &str) -> Option<&CanvasDocument> {
        self.canvas.iter().find(|canvas| canvas.id == canvas_id)
    }

    pub fn canvas_mut(&mut self, canvas_id: &str) -> Option<&mut CanvasDocument> {
        self.canvas.iter_mut().find(|canvas| canvas.id == canvas_id)
    }

    /// Asset id → referencing node ids, across every canvas.
    pub fn asset_references(&self) -> BTreeMap<AssetId, Vec<NodeId>> {
        let mut refs: BTreeMap<AssetId, Vec<NodeId>> = BTreeMap::new();
        let mut add = |asset_id: &Option<AssetId>, node_id: &NodeId| {
            if let Some(asset_id) = asset_id {
                refs.entry(asset_id.clone())
                    .or_default()
                    .push(node_id.clone());
            }
        };
        for canvas in &self.canvas {
            for node in &canvas.nodes {
                add(&node.data.asset_id, &node.id);
                add(&node.data.poster_asset_id, &node.id);
                if let Some(slots) = &node.data.result_slots {
                    for slot in slots {
                        add(&slot.asset_id, &node.id);
                    }
                }
            }
        }
        refs
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NodePatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub z_index: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<NodeData>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum DocumentCommand {
    #[serde(rename_all = "camelCase")]
    AddNode {
        canvas_id: CanvasId,
        node: WorkflowNode,
    },
    #[serde(rename_all = "camelCase")]
    UpdateNode {
        canvas_id: CanvasId,
        node_id: NodeId,
        patch: NodePatch,
    },
    #[serde(rename_all = "camelCase")]
    MoveNodes {
        canvas_id: CanvasId,
        positions: BTreeMap<NodeId, PointValue>,
    },
    #[serde(rename_all = "camelCase")]
    ResizeNode {
        canvas_id: CanvasId,
        node_id: NodeId,
        bounds: Rect,
    },
    #[serde(rename_all = "camelCase")]
    RemoveNodes {
        canvas_id: CanvasId,
        node_ids: Vec<NodeId>,
    },
    #[serde(rename_all = "camelCase")]
    AddEdge {
        canvas_id: CanvasId,
        edge: WorkflowEdge,
    },
    #[serde(rename_all = "camelCase")]
    RemoveEdges {
        canvas_id: CanvasId,
        edge_ids: Vec<EdgeId>,
    },
    #[serde(rename_all = "camelCase")]
    SetGroupMembership {
        canvas_id: CanvasId,
        group_id: NodeId,
        child_node_ids: Vec<NodeId>,
    },
    #[serde(rename_all = "camelCase")]
    SetViewport {
        canvas_id: CanvasId,
        viewport: Viewport,
    },
    #[serde(rename_all = "camelCase")]
    AddCanvas {
        canvas: CanvasDocument,
        index: Option<usize>,
    },
    #[serde(rename_all = "camelCase")]
    RenameCanvas { canvas_id: CanvasId, name: String },
    #[serde(rename_all = "camelCase")]
    ReorderCanvas { canvas_id: CanvasId, index: usize },
    #[serde(rename_all = "camelCase")]
    RemoveCanvas { canvas_id: CanvasId },
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct PointValue {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfCheckNodeRef {
    pub canvas_id: CanvasId,
    pub node_id: NodeId,
    pub title: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SelfCheckReason {
    Missing,
    Changed,
    Empty,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfCheckIssue {
    pub asset_id: AssetId,
    pub name: String,
    pub expected_path: String,
    pub reason: SelfCheckReason,
    pub referencing_nodes: Vec<SelfCheckNodeRef>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfCheckReport {
    pub ok: bool,
    pub issues: Vec<SelfCheckIssue>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationIssue {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub canvas_id: Option<CanvasId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_id: Option<NodeId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edge_id: Option<EdgeId>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RunStatus {
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunStepRecord {
    pub node_id: NodeId,
    pub status: RunStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<IsoTimestamp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<IsoTimestamp>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_asset_ids: Option<Vec<AssetId>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_text: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    pub id: RunId,
    pub project_id: ProjectId,
    pub canvas_id: CanvasId,
    pub requested_node_ids: Vec<NodeId>,
    pub status: RunStatus,
    pub executor_key: String,
    pub graph_hash: String,
    pub parameters: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_of_run_id: Option<RunId>,
    pub steps: Vec<RunStepRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub cancel_requested: bool,
    pub created_at: IsoTimestamp,
    pub updated_at: IsoTimestamp,
}

pub fn now_iso() -> IsoTimestamp {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

pub fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}
