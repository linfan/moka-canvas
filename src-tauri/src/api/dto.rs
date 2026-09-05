use crate::config::LimitsConfig;
use crate::domain::{DocumentCommand, MokaFile, ResourceEntry, SelfCheckReport};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectRequest {
    pub directory: String,
    pub name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenProjectRequest {
    pub path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProjectRequest {
    pub archive_path: String,
    pub directory: String,
    pub name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyCommandsRequest {
    pub expected_revision: i32,
    pub commands: Vec<DocumentCommand>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub destination: Option<String>,
    #[serde(default)]
    pub allow_incomplete: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenProjectResponse {
    pub root: String,
    pub moka: MokaFile,
    pub self_check: SelfCheckReport,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResponse {
    pub revision: i32,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetChangeResponse {
    pub entry: ResourceEntry,
    pub revision: i32,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageResponse {
    pub destination: String,
    pub entries: usize,
    pub bytes: u64,
    pub incomplete: bool,
}

/// Sanitized public projection of the app configuration. Filesystem paths,
/// the recent-registry location, and server internals must never appear here.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicConfigResponse {
    pub product_name: String,
    pub max_upload_bytes: u64,
    pub allowed_media_types: Vec<String>,
    pub limits: LimitsConfig,
    pub capabilities: CapabilitiesResponse,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilitiesResponse {
    pub mode: String,
    pub executors: Vec<String>,
    pub asset_categories: Vec<String>,
}
