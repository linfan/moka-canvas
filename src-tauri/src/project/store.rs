use crate::assets;
use crate::config::AppConfig;
use crate::domain::commands::{apply_commands, registry_errors};
use crate::domain::{
    new_id, now_iso, CanvasDocument, DocumentCommand, MokaFile, ProjectMetadata, ResourceEntry,
    ResourceRegistry, RunRecord, SelfCheckIssue, SelfCheckNodeRef, SelfCheckReason,
    SelfCheckReport, MOKA_FILE_VERSION,
};
use crate::project::codec::{decode_moka_file, encode_moka_file};
use crate::project::{
    AssetChange, AssetFile, ByteRange, CreateProject, OpenProject, PackageReport, ProjectError,
    ProjectStore, SaveResult, StagedAsset,
};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

pub struct FsProjectStore {
    config: Arc<AppConfig>,
    state: Arc<Mutex<Option<OpenState>>>,
}

struct OpenState {
    root: PathBuf,
    moka: MokaFile,
    /// Revision of the file as last written/read by this process.
    revision: i32,
    /// Filesystem identity of canvas.moka used to detect external edits.
    file_stamp: Option<std::time::SystemTime>,
}

impl FsProjectStore {
    pub fn new(config: Arc<AppConfig>) -> Self {
        Self {
            config,
            state: Arc::new(Mutex::new(None)),
        }
    }

    fn moka_path(root: &Path) -> PathBuf {
        root.join("canvas.moka")
    }

    fn scaffold(root: &Path) -> Result<(), ProjectError> {
        std::fs::create_dir_all(root)?;
        for category in crate::domain::ASSET_CATEGORIES {
            std::fs::create_dir_all(root.join("assets").join(category))?;
        }
        std::fs::create_dir_all(root.join("output"))?;
        std::fs::create_dir_all(root.join("history").join("runs"))?;
        std::fs::create_dir_all(root.join("tmp"))?;
        Ok(())
    }

    fn clean_tmp(root: &Path) {
        let tmp = root.join("tmp");
        if let Ok(entries) = std::fs::read_dir(&tmp) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    let _ = std::fs::remove_dir_all(&path);
                } else {
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
    }

    /// Resolves a project-relative path and verifies it stays inside the
    /// canonical project root (no `..`, no absolute, no symlink escape).
    fn resolve_in_root(root: &Path, relative: &str) -> Result<PathBuf, ProjectError> {
        if !crate::domain::validate::resource_path_valid(relative) {
            return Err(ProjectError::domain(
                "PATH_ESCAPE",
                format!("Path escapes the project root: {relative}"),
            ));
        }
        let candidate = root.join(relative);
        let canonical_root = root.canonicalize()?;
        // Canonicalize the deepest existing ancestor to defeat symlink escapes.
        let mut probe = candidate.clone();
        let existing = loop {
            if probe.exists() {
                break probe.canonicalize()?;
            }
            match probe.parent() {
                Some(parent) => probe = parent.to_path_buf(),
                None => break canonical_root.clone(),
            }
        };
        if !existing.starts_with(&canonical_root) {
            return Err(ProjectError::domain(
                "PATH_ESCAPE",
                format!("Path escapes the project root: {relative}"),
            ));
        }
        Ok(candidate)
    }

    fn atomic_write(&self, root: &Path, moka: &MokaFile) -> Result<(), ProjectError> {
        let bytes = encode_moka_file(moka, Some(self.config.projects.max_moka_file_bytes))?;
        let tmp = root
            .join("tmp")
            .join(format!("canvas.moka.{}.tmp", uuid::Uuid::now_v7()));
        std::fs::write(&tmp, &bytes)?;
        {
            let file = std::fs::File::open(&tmp)?;
            file.sync_all()?;
        }
        std::fs::rename(&tmp, Self::moka_path(root))?;
        if let Ok(dir) = std::fs::File::open(root) {
            let _ = dir.sync_all();
        }
        Ok(())
    }

    fn load_from_disk(
        &self,
        root: &Path,
    ) -> Result<(MokaFile, Option<std::time::SystemTime>), ProjectError> {
        let path = Self::moka_path(root);
        let bytes = std::fs::read(&path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                ProjectError::domain(
                    "PROJECT_NOT_FOUND",
                    format!("No canvas.moka in {}", root.display()),
                )
            } else {
                ProjectError::Io(error)
            }
        })?;
        if bytes.len() as u64 > self.config.projects.max_moka_file_bytes {
            return Err(ProjectError::domain(
                "MOKA_TOO_LARGE",
                "canvas.moka exceeds the configured size limit",
            ));
        }
        let moka = decode_moka_file(&bytes)?;
        let stamp = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
        Ok((moka, stamp))
    }

    fn self_check(root: &Path, moka: &MokaFile) -> SelfCheckReport {
        let mut issues = Vec::new();
        let references = moka.asset_references();
        for entry in moka.resources.all() {
            let resolved = Self::resolve_in_root(root, &entry.path).ok();
            let meta = resolved
                .as_ref()
                .and_then(|path| std::fs::metadata(path).ok());
            let reason = match meta {
                None => Some(SelfCheckReason::Missing),
                Some(meta) if !meta.is_file() => Some(SelfCheckReason::Missing),
                Some(meta) if meta.len() == 0 => Some(SelfCheckReason::Empty),
                Some(meta) => match (&entry.sha256, entry.bytes) {
                    (Some(expected), _) => {
                        let size_hint_mismatch = entry
                            .bytes
                            .map(|bytes| bytes as u64 != meta.len())
                            .unwrap_or(false);
                        if size_hint_mismatch {
                            Some(SelfCheckReason::Changed)
                        } else {
                            match sha256_of(resolved.as_ref().unwrap()) {
                                Ok(actual) if &actual != expected => Some(SelfCheckReason::Changed),
                                Err(_) => Some(SelfCheckReason::Missing),
                                _ => None,
                            }
                        }
                    }
                    _ => None,
                },
            };
            if let Some(reason) = reason {
                let referencing_nodes = references
                    .get(&entry.id)
                    .cloned()
                    .unwrap_or_default()
                    .iter()
                    .filter_map(|node_id| {
                        moka.canvas.iter().find_map(|canvas| {
                            canvas.node(node_id).map(|node| SelfCheckNodeRef {
                                canvas_id: canvas.id.clone(),
                                node_id: node.id.clone(),
                                title: node.title.clone(),
                            })
                        })
                    })
                    .collect();
                issues.push(SelfCheckIssue {
                    asset_id: entry.id.clone(),
                    name: entry.name.clone(),
                    expected_path: entry.path.clone(),
                    reason,
                    referencing_nodes,
                });
            }
        }
        SelfCheckReport {
            ok: issues.is_empty(),
            issues,
        }
    }

    fn detect_external_edit(state: &OpenState) -> Result<(), ProjectError> {
        let path = Self::moka_path(&state.root);
        let stamp = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
        if let (Some(previous), Some(current)) = (state.file_stamp, stamp) {
            if previous != current {
                return Err(ProjectError::domain(
                    "REVISION_CONFLICT",
                    "canvas.moka changed on disk; reload the project before saving",
                ));
            }
        }
        Ok(())
    }

    fn persist_locked(&self, state: &mut OpenState) -> Result<SaveResult, ProjectError> {
        Self::detect_external_edit(state)?;
        if let Some(code) = registry_errors(&state.moka) {
            return Err(ProjectError::domain(code, "Resource registry is invalid"));
        }
        state.moka.metadata.revision += 1;
        state.moka.metadata.updated_at = now_iso();
        self.atomic_write(&state.root, &state.moka)?;
        state.revision = state.moka.metadata.revision;
        state.file_stamp = std::fs::metadata(Self::moka_path(&state.root))
            .and_then(|m| m.modified())
            .ok();
        Ok(SaveResult {
            revision: state.revision,
            updated_at: state.moka.metadata.updated_at.clone(),
        })
    }
}

fn sha256_of(path: &Path) -> std::io::Result<String> {
    use sha2::Digest;
    let bytes = std::fs::read(path)?;
    let mut hasher = sha2::Sha256::new();
    hasher.update(&bytes);
    Ok(hex::encode(hasher.finalize()))
}

#[async_trait::async_trait]
impl ProjectStore for FsProjectStore {
    async fn create_project(
        &self,
        root: &Path,
        input: CreateProject,
    ) -> Result<OpenProject, ProjectError> {
        if input.name.trim().is_empty() {
            return Err(ProjectError::domain(
                "VALIDATION_FAILED",
                "Project name is empty",
            ));
        }
        Self::scaffold(root)?;

        // Reopening an existing valid root is idempotent.
        if Self::moka_path(root).exists() {
            return self.open_project(root).await;
        }

        let now = now_iso();
        let moka = MokaFile {
            version: MOKA_FILE_VERSION.to_string(),
            metadata: ProjectMetadata {
                id: new_id(),
                name: input.name.trim().to_string(),
                description: None,
                cover_path: None,
                revision: 0,
                created_at: now.clone(),
                updated_at: now,
            },
            resources: ResourceRegistry::default(),
            canvas: vec![CanvasDocument::empty(new_id(), "Canvas 1".to_string())],
        };
        self.atomic_write(root, &moka)?;
        Self::clean_tmp(root);
        let report = Self::self_check(root, &moka);
        let stamp = std::fs::metadata(Self::moka_path(root))
            .and_then(|m| m.modified())
            .ok();
        let revision = moka.metadata.revision;
        {
            let mut guard = self.state.lock().expect("store poisoned");
            *guard = Some(OpenState {
                root: root.to_path_buf(),
                moka: moka.clone(),
                revision,
                file_stamp: stamp,
            });
        }
        Ok(OpenProject {
            root: root.to_path_buf(),
            moka,
            self_check: report,
        })
    }

    async fn open_project(&self, entry: &Path) -> Result<OpenProject, ProjectError> {
        let root = if entry.is_dir() {
            entry.to_path_buf()
        } else if entry.extension().and_then(|ext| ext.to_str()) == Some("moka") {
            entry.parent().map(Path::to_path_buf).ok_or_else(|| {
                ProjectError::domain("PROJECT_NOT_FOUND", "No containing directory")
            })?
        } else {
            return Err(ProjectError::domain(
                "PROJECT_NOT_FOUND",
                format!("Not a project directory or .moka file: {}", entry.display()),
            ));
        };
        let (moka, stamp) = self.load_from_disk(&root)?;
        Self::clean_tmp(&root);
        let report = Self::self_check(&root, &moka);
        let revision = moka.metadata.revision;
        {
            let mut guard = self.state.lock().expect("store poisoned");
            *guard = Some(OpenState {
                root: root.clone(),
                moka: moka.clone(),
                revision,
                file_stamp: stamp,
            });
        }
        Ok(OpenProject {
            root,
            moka,
            self_check: report,
        })
    }

    async fn current(&self) -> Result<Option<OpenProject>, ProjectError> {
        let guard = self.state.lock().expect("store poisoned");
        Ok(guard.as_ref().map(|state| OpenProject {
            root: state.root.clone(),
            moka: state.moka.clone(),
            self_check: SelfCheckReport {
                ok: true,
                issues: Vec::new(),
            },
        }))
    }

    async fn apply_commands(
        &self,
        expected_revision: i32,
        commands: Vec<DocumentCommand>,
    ) -> Result<SaveResult, ProjectError> {
        let mut guard = self.state.lock().expect("store poisoned");
        let state = guard
            .as_mut()
            .ok_or_else(|| ProjectError::domain("PROJECT_NOT_OPEN", "No project is open"))?;
        if state.revision != expected_revision {
            return Err(ProjectError::domain(
                "REVISION_CONFLICT",
                format!(
                    "Expected revision {expected_revision} but the document is at {}",
                    state.revision
                ),
            ));
        }
        let (next, _inverse) = apply_commands(&state.moka, &commands)
            .map_err(|error| ProjectError::domain(error.code, error.to_string()))?;
        state.moka = next;
        self.persist_locked(state)
    }

    async fn add_asset(&self, staged: StagedAsset) -> Result<AssetChange, ProjectError> {
        let root = {
            let guard = self.state.lock().expect("store poisoned");
            guard
                .as_ref()
                .map(|state| state.root.clone())
                .ok_or_else(|| ProjectError::domain("PROJECT_NOT_OPEN", "No project is open"))?
        };

        let analysis = assets::analyze_staged(&staged.tmp_path).inspect_err(|_| {
            let _ = std::fs::remove_file(&staged.tmp_path);
        })?;
        if !assets::is_allowed_media(&analysis.mime, &self.config.public.allowed_media_types) {
            let _ = std::fs::remove_file(&staged.tmp_path);
            return Err(ProjectError::domain(
                "UNSUPPORTED_MEDIA_TYPE",
                format!("Media type {} is not allowed", analysis.mime),
            ));
        }

        // Audio lands in music/ or voice/ per the caller's explicit hint.
        let mut category = assets::category_for_mime(&analysis.mime).ok_or_else(|| {
            ProjectError::domain(
                "UNSUPPORTED_MEDIA_TYPE",
                format!("Media type {} has no asset category", analysis.mime),
            )
        })?;
        if analysis.mime.starts_with("audio/") {
            if let Some(hint) = staged.category_hint.as_deref() {
                if hint == "voice" {
                    category = "voice";
                }
            }
        }

        let id = new_id();
        let filename = assets::asset_filename(&staged.name, &analysis.mime, &id);
        let relative = match assets::promote(&root, &staged.tmp_path, category, &filename) {
            Ok(relative) => relative,
            Err(error) => {
                let _ = std::fs::remove_file(&staged.tmp_path);
                return Err(error);
            }
        };

        let now = now_iso();
        let entry = ResourceEntry {
            id: id.clone(),
            name: staged.name,
            path: relative,
            mime: Some(analysis.mime.clone()),
            bytes: Some(analysis.bytes as i64),
            sha256: Some(analysis.sha256),
            created_at: now.clone(),
            updated_at: now,
            probe: Some(analysis.probe),
            provenance: None,
        };

        let mut guard = self.state.lock().expect("store poisoned");
        let state = guard
            .as_mut()
            .ok_or_else(|| ProjectError::domain("PROJECT_NOT_OPEN", "No project is open"))?;
        state
            .moka
            .resources
            .category_mut(category)
            .expect("category checked above")
            .push(entry.clone());
        match self.persist_locked(state) {
            Ok(saved) => Ok(AssetChange {
                entry,
                revision: saved.revision,
                updated_at: saved.updated_at,
            }),
            Err(error) => {
                // Roll back: remove the registry entry and the promoted file.
                state.moka.resources.remove(&id);
                let _ = std::fs::remove_file(root.join(&entry.path));
                Err(error)
            }
        }
    }

    async fn remove_asset(&self, id: &str) -> Result<SaveResult, ProjectError> {
        let mut guard = self.state.lock().expect("store poisoned");
        let state = guard
            .as_mut()
            .ok_or_else(|| ProjectError::domain("PROJECT_NOT_OPEN", "No project is open"))?;
        let references = state.moka.asset_references();
        if references.contains_key(id) {
            return Err(ProjectError::domain(
                "ASSET_IN_USE",
                "The asset is referenced by canvas nodes",
            ));
        }
        let entry = state
            .moka
            .resources
            .remove(id)
            .ok_or_else(|| ProjectError::domain("NOT_FOUND", "Asset not found"))?;
        let path = Self::resolve_in_root(&state.root, &entry.path)?;
        let _ = std::fs::remove_file(path);
        self.persist_locked(state)
    }

    async fn replace_asset_bytes(
        &self,
        id: &str,
        staged: StagedAsset,
    ) -> Result<AssetChange, ProjectError> {
        let mut guard = self.state.lock().expect("store poisoned");
        let state = guard
            .as_mut()
            .ok_or_else(|| ProjectError::domain("PROJECT_NOT_OPEN", "No project is open"))?;
        let analysis = assets::analyze_staged(&staged.tmp_path).inspect_err(|_| {
            let _ = std::fs::remove_file(&staged.tmp_path);
        })?;
        let index_entry = state
            .moka
            .resources
            .find(id)
            .ok_or_else(|| ProjectError::domain("NOT_FOUND", "Asset not found"))?
            .clone();
        let target = Self::resolve_in_root(&state.root, &index_entry.path)?;
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::rename(&staged.tmp_path, &target)?;

        let entry = state
            .moka
            .resources
            .find_mut(id)
            .expect("entry checked above");
        entry.mime = Some(analysis.mime.clone());
        entry.bytes = Some(analysis.bytes as i64);
        entry.sha256 = Some(analysis.sha256);
        entry.probe = Some(analysis.probe);
        entry.updated_at = now_iso();
        let updated = entry.clone();
        let saved = self.persist_locked(state)?;
        Ok(AssetChange {
            entry: updated,
            revision: saved.revision,
            updated_at: saved.updated_at,
        })
    }

    async fn asset_file(
        &self,
        id: &str,
        range: Option<ByteRange>,
    ) -> Result<AssetFile, ProjectError> {
        let guard = self.state.lock().expect("store poisoned");
        let state = guard
            .as_ref()
            .ok_or_else(|| ProjectError::domain("PROJECT_NOT_OPEN", "No project is open"))?;
        let entry = state
            .moka
            .resources
            .find(id)
            .ok_or_else(|| ProjectError::domain("NOT_FOUND", "Asset not found"))?
            .clone();
        let path = Self::resolve_in_root(&state.root, &entry.path)?;
        if !path.is_file() {
            return Err(ProjectError::domain(
                "ASSET_MISSING",
                format!("Asset file is missing: {}", entry.path),
            ));
        }
        Ok(AssetFile { entry, path, range })
    }

    async fn export_package(
        &self,
        destination: Option<&Path>,
        allow_incomplete: bool,
    ) -> Result<PackageReport, ProjectError> {
        let (root, moka) = {
            let guard = self.state.lock().expect("store poisoned");
            let state = guard
                .as_ref()
                .ok_or_else(|| ProjectError::domain("PROJECT_NOT_OPEN", "No project is open"))?;
            (state.root.clone(), state.moka.clone())
        };
        let destination = match destination {
            Some(path) => path.to_path_buf(),
            None => root.join("output").join(format!(
                "{}-{}.mokapkg.zip",
                assets::slugify(&moka.metadata.name),
                uuid::Uuid::now_v7()
                    .to_string()
                    .chars()
                    .take(8)
                    .collect::<String>()
            )),
        };
        crate::project::package::export_project(
            &root,
            &moka,
            &destination,
            &self.config.limits,
            allow_incomplete,
        )
    }

    async fn import_package(
        &self,
        archive: &Path,
        target_root: &Path,
    ) -> Result<OpenProject, ProjectError> {
        crate::project::package::import_project(archive, target_root, &self.config.limits)?;
        self.open_project(target_root).await
    }

    async fn list_runs(&self) -> Result<Vec<RunRecord>, ProjectError> {
        let root = {
            let guard = self.state.lock().expect("store poisoned");
            guard
                .as_ref()
                .map(|state| state.root.clone())
                .ok_or_else(|| ProjectError::domain("PROJECT_NOT_OPEN", "No project is open"))?
        };
        let runs_dir = root.join("history").join("runs");
        let mut runs = Vec::new();
        if let Ok(entries) = std::fs::read_dir(&runs_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                    continue;
                }
                if let Ok(raw) = std::fs::read_to_string(&path) {
                    if let Ok(run) = serde_json::from_str::<RunRecord>(&raw) {
                        runs.push(run);
                    }
                }
            }
        }
        runs.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(runs)
    }
}

/// Normalizes a path without touching the filesystem (used by package entry checks).
pub fn normalize_relative(path: &str) -> Option<String> {
    let mut parts: Vec<&str> = Vec::new();
    for component in Path::new(path).components() {
        match component {
            Component::Normal(part) => parts.push(part.to_str()?),
            Component::CurDir => {}
            _ => return None,
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}
