use crate::config::LimitsConfig;
use crate::domain::{DocumentCommand, MokaFile, ResourceEntry, SelfCheckReport};
use crate::generate::providers::ModelCandidate;
use crate::metadata::{
    AudioPreferences, ChannelDraft, ImagePreferences, Protocol, VideoPreferences,
};
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRunRequest {
    pub canvas_id: String,
    pub node_ids: Vec<String>,
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

/// A channel write. The credential rides along but is a separate concern:
/// leaving it out — or leaving it blank — keeps whatever is stored, so editing
/// a name or a model list cannot quietly destroy a working key. Removing one
/// is an explicit call to the key endpoint.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertChannelRequest {
    #[serde(flatten)]
    pub channel: ChannelDraft,
    #[serde(default)]
    pub api_key: Option<String>,
}

/// Sets or clears one channel's credential on its own.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelKeyRequest {
    /// Absent, null, or blank all mean "clear it".
    #[serde(default)]
    pub api_key: Option<String>,
}

/// A partial edit to the per-capability defaults.
///
/// Absent means leave it alone and `null` means clear it, which is the whole
/// reason this is not just the stored `Defaults` shape: setting the image
/// default from a model picker must not wipe the other three.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultsPatch {
    #[serde(default, deserialize_with = "present_value")]
    pub text: Option<Option<String>>,
    #[serde(default, deserialize_with = "present_value")]
    pub image: Option<Option<String>>,
    #[serde(default, deserialize_with = "present_value")]
    pub audio: Option<Option<String>>,
    #[serde(default, deserialize_with = "present_value")]
    pub video: Option<Option<String>>,
    #[serde(default)]
    pub expected_revision: Option<u64>,
}

/// A partial edit to the generation preferences.
///
/// Unlike [`DefaultsPatch`] this needs no absent-versus-null distinction:
/// every field has a built-in value, so there is no cleared state to ask for
/// and `null` can only mean "keep what is stored". The three groups are
/// replaced whole, because half of a size-and-quality pair is not a meaning.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreferencesPatch {
    #[serde(default)]
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    #[serde(default)]
    pub image: Option<ImagePreferences>,
    #[serde(default)]
    pub video: Option<VideoPreferences>,
    #[serde(default)]
    pub audio: Option<AudioPreferences>,
    #[serde(default)]
    pub expected_revision: Option<u64>,
}

/// Creates or updates a channel from an address and a credential, deriving the
/// rest.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportChannelRequest {
    pub base_url: String,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub protocol: Option<Protocol>,
    #[serde(default)]
    pub expected_revision: Option<u64>,
}

/// An optional revision carried in a query string, for the requests that have
/// no body to put it in.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionQuery {
    #[serde(default)]
    pub revision: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelListResponse {
    pub models: Vec<ModelCandidate>,
}

/// Tells "the field was left out" from "the field was sent as null", which
/// serde collapses into the same `None` for a bare `Option<Option<T>>`.
fn present_value<'de, D>(deserializer: D) -> Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Some(Option::<String>::deserialize(deserializer)?))
}
