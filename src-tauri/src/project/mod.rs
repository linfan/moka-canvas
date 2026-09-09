pub mod codec;
pub mod package;
pub mod store;

use crate::domain::{AssetProvenance, MokaFile, ResourceEntry, SelfCheckReport};
use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ProjectError {
    #[error("{0}")]
    Codec(#[from] codec::CodecError),
    #[error("{code}: {message}")]
    Domain { code: &'static str, message: String },
    #[error("package error: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

impl ProjectError {
    pub fn domain(code: &'static str, message: impl Into<String>) -> Self {
        Self::Domain {
            code,
            message: message.into(),
        }
    }

    pub fn code(&self) -> &'static str {
        match self {
            Self::Codec(error) => error.code(),
            Self::Domain { code, .. } => code,
            Self::Zip(_) => "PACKAGE_INVALID",
            Self::Io(_) => "INTERNAL",
        }
    }
}

pub struct OpenProject {
    pub root: PathBuf,
    pub moka: MokaFile,
    pub self_check: SelfCheckReport,
}

pub struct CreateProject {
    pub name: String,
}

#[derive(Debug)]
pub struct SaveResult {
    pub revision: i32,
    pub updated_at: String,
}

/// Result of an asset mutation; every asset change persists the document,
/// so the caller always learns the new revision.
#[derive(Debug)]
pub struct AssetChange {
    pub entry: ResourceEntry,
    pub revision: i32,
    pub updated_at: String,
}

#[derive(Debug, Clone, Copy)]
pub struct ByteRange {
    pub start: u64,
    pub end: Option<u64>,
}

pub struct StagedAsset {
    pub name: String,
    pub tmp_path: PathBuf,
    pub declared_mime: Option<String>,
    pub category_hint: Option<String>,
    /// Where the asset came from, for the ones that were made rather than
    /// imported. Only `add_asset` reads it: replacing an existing asset's bytes
    /// keeps the provenance that entry already carries.
    pub provenance: Option<AssetProvenance>,
}

pub struct AssetFile {
    pub entry: ResourceEntry,
    pub path: PathBuf,
    pub range: Option<ByteRange>,
}

pub struct PackageReport {
    pub destination: PathBuf,
    pub entries: usize,
    pub bytes: u64,
    pub incomplete: bool,
}

#[async_trait::async_trait]
pub trait ProjectStore: Send + Sync {
    async fn create_project(
        &self,
        root: &Path,
        input: CreateProject,
    ) -> Result<OpenProject, ProjectError>;
    async fn open_project(&self, entry: &Path) -> Result<OpenProject, ProjectError>;
    async fn current(&self) -> Result<Option<OpenProject>, ProjectError>;
    async fn apply_commands(
        &self,
        expected_revision: i32,
        commands: Vec<crate::domain::DocumentCommand>,
    ) -> Result<SaveResult, ProjectError>;
    async fn add_asset(&self, staged: StagedAsset) -> Result<AssetChange, ProjectError>;
    async fn remove_asset(&self, id: &str) -> Result<SaveResult, ProjectError>;
    async fn replace_asset_bytes(
        &self,
        id: &str,
        staged: StagedAsset,
    ) -> Result<AssetChange, ProjectError>;
    async fn asset_file(
        &self,
        id: &str,
        range: Option<ByteRange>,
    ) -> Result<AssetFile, ProjectError>;
    async fn export_package(
        &self,
        destination: Option<&Path>,
        allow_incomplete: bool,
    ) -> Result<PackageReport, ProjectError>;
    async fn import_package(
        &self,
        archive: &Path,
        target_root: &Path,
    ) -> Result<OpenProject, ProjectError>;
    async fn list_runs(&self) -> Result<Vec<crate::domain::RunRecord>, ProjectError>;
    async fn create_run(
        &self,
        run: crate::domain::RunRecord,
    ) -> Result<crate::domain::RunRecord, ProjectError>;
    async fn get_run(&self, id: &str) -> Result<crate::domain::RunRecord, ProjectError>;
    async fn update_run(
        &self,
        run: crate::domain::RunRecord,
    ) -> Result<crate::domain::RunRecord, ProjectError>;
}
