use crate::config::LimitsConfig;
use crate::domain::{now_iso, ASSET_CATEGORIES};
use crate::domain::{MokaFile, PACKAGE_MANIFEST_VERSION};
use crate::project::store::normalize_relative;
use crate::project::{PackageReport, ProjectError};
use serde::{Deserialize, Serialize};
use sha2::Digest;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageManifestEntry {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageManifest {
    pub format_version: u32,
    pub app: String,
    pub exported_at: String,
    pub project_id: String,
    pub project_name: String,
    pub incomplete: bool,
    pub exclusions: Vec<String>,
    pub entries: Vec<PackageManifestEntry>,
}

const MANIFEST_NAME: &str = "moka-package.json";
const OS_JUNK: [&str; 3] = [".DS_Store", "Thumbs.db", "desktop.ini"];

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = sha2::Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

fn is_excluded(relative: &str) -> bool {
    if relative.starts_with("tmp/") || relative == "tmp" {
        return true;
    }
    relative
        .rsplit('/')
        .next()
        .map(|name| OS_JUNK.contains(&name))
        .unwrap_or(false)
}

fn collect_files(root: &Path) -> Result<Vec<PathBuf>, ProjectError> {
    let mut files = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            let path = entry.path();
            let relative = path
                .strip_prefix(root)
                .map_err(|_| ProjectError::domain("INTERNAL", "Path outside root"))?
                .to_string_lossy()
                .replace('\\', "/");
            if is_excluded(&relative) {
                continue;
            }
            if path.is_dir() {
                stack.push(path);
            } else if path.is_file() {
                files.push(path);
            }
        }
    }
    files.sort();
    Ok(files)
}

pub fn export_project(
    root: &Path,
    moka: &MokaFile,
    destination: &Path,
    limits: &LimitsConfig,
    allow_incomplete: bool,
) -> Result<PackageReport, ProjectError> {
    let files = collect_files(root)?;

    // Completeness: every referenced resource must exist on disk.
    let mut missing = Vec::new();
    for entry in moka.resources.all() {
        if !root.join(&entry.path).is_file() {
            missing.push(entry.path.clone());
        }
    }
    if !missing.is_empty() && !allow_incomplete {
        return Err(ProjectError::domain(
            "ASSET_MISSING",
            format!(
                "Export blocked: {} referenced asset(s) are missing",
                missing.len()
            ),
        ));
    }

    let mut entries = Vec::new();
    for file in &files {
        let relative = file
            .strip_prefix(root)
            .map_err(|_| ProjectError::domain("INTERNAL", "Path outside root"))?
            .to_string_lossy()
            .replace('\\', "/");
        let bytes = std::fs::read(file)?;
        entries.push(PackageManifestEntry {
            path: relative,
            bytes: bytes.len() as u64,
            sha256: sha256_hex(&bytes),
        });
        if entries.len() > limits.max_package_entries {
            return Err(ProjectError::domain(
                "PAYLOAD_TOO_LARGE",
                "The project has too many files to export",
            ));
        }
    }
    let total: u64 = entries.iter().map(|entry| entry.bytes).sum();
    if total > limits.max_package_bytes {
        return Err(ProjectError::domain(
            "PAYLOAD_TOO_LARGE",
            "The project is too large to export",
        ));
    }

    let manifest = PackageManifest {
        format_version: PACKAGE_MANIFEST_VERSION,
        app: format!("moka-canvas/{}", env!("CARGO_PKG_VERSION")),
        exported_at: now_iso(),
        project_id: moka.metadata.id.clone(),
        project_name: moka.metadata.name.clone(),
        incomplete: !missing.is_empty(),
        exclusions: vec![
            "tmp/**".into(),
            ".DS_Store".into(),
            "Thumbs.db".into(),
            "desktop.ini".into(),
        ],
        entries,
    };

    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = destination.with_extension("zip.tmp");
    let outcome = (|| -> Result<PackageReport, ProjectError> {
        let file = std::fs::File::create(&tmp)?;
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        let manifest_json = serde_json::to_vec_pretty(&manifest)
            .map_err(|error| ProjectError::domain("INTERNAL", error.to_string()))?;
        writer.start_file(MANIFEST_NAME, options)?;
        writer.write_all(&manifest_json)?;
        for entry in &manifest.entries {
            writer.start_file(&entry.path, options)?;
            writer.write_all(&std::fs::read(root.join(&entry.path))?)?;
        }
        writer.finish()?;
        Ok(PackageReport {
            destination: destination.to_path_buf(),
            entries: manifest.entries.len(),
            bytes: total,
            incomplete: manifest.incomplete,
        })
    })();
    if outcome.is_ok() {
        std::fs::rename(&tmp, destination)?;
    } else {
        let _ = std::fs::remove_file(&tmp);
    }
    outcome
}

fn staging_dir_for(target_root: &Path) -> PathBuf {
    target_root
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(format!(
            ".moka-import-{}",
            uuid::Uuid::now_v7()
                .to_string()
                .chars()
                .take(8)
                .collect::<String>()
        ))
}

pub fn import_project(
    archive: &Path,
    target_root: &Path,
    limits: &LimitsConfig,
) -> Result<(), ProjectError> {
    let file = std::fs::File::open(archive).map_err(|error| {
        ProjectError::domain(
            "PACKAGE_INVALID",
            format!("Cannot open package {}: {error}", archive.display()),
        )
    })?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|error| ProjectError::domain("PACKAGE_INVALID", error.to_string()))?;

    if zip.len() > limits.max_package_entries {
        return Err(ProjectError::domain(
            "PAYLOAD_TOO_LARGE",
            "Package has too many entries",
        ));
    }

    // Validate all entry names before writing anything.
    let mut names = Vec::new();
    for index in 0..zip.len() {
        let entry = zip
            .by_index(index)
            .map_err(|error| ProjectError::domain("PACKAGE_INVALID", error.to_string()))?;
        let name = entry.name().replace('\\', "/");
        if entry.is_dir() {
            continue;
        }
        if normalize_relative(&name).is_none() || name.starts_with('/') || name.contains(':') {
            return Err(ProjectError::domain(
                "PACKAGE_INVALID",
                format!("Package entry escapes the target: {name}"),
            ));
        }
        if entry.size() > limits.max_package_bytes {
            return Err(ProjectError::domain(
                "PAYLOAD_TOO_LARGE",
                format!("Package entry is too large: {name}"),
            ));
        }
        names.push(name);
    }

    let staging = staging_dir_for(target_root);
    let outcome = (|| -> Result<(), ProjectError> {
        std::fs::create_dir_all(&staging)?;
        let mut manifest: Option<PackageManifest> = None;
        let mut total: u64 = 0;
        for name in &names {
            let mut entry = zip
                .by_name(name)
                .map_err(|error| ProjectError::domain("PACKAGE_INVALID", error.to_string()))?;
            let mut bytes = Vec::with_capacity(entry.size() as usize);
            entry.read_to_end(&mut bytes)?;
            total += bytes.len() as u64;
            if total > limits.max_package_bytes {
                return Err(ProjectError::domain(
                    "PAYLOAD_TOO_LARGE",
                    "Package expands beyond the configured limit",
                ));
            }
            if name == MANIFEST_NAME {
                manifest = Some(serde_json::from_slice(&bytes).map_err(|error| {
                    ProjectError::domain(
                        "PACKAGE_INVALID",
                        format!("Package manifest is invalid: {error}"),
                    )
                })?);
                continue;
            }
            let target = staging.join(name);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&target, &bytes)?;
        }

        let manifest = manifest.ok_or_else(|| {
            ProjectError::domain(
                "PACKAGE_INVALID",
                "Package has no moka-package.json manifest",
            )
        })?;
        if manifest.format_version != PACKAGE_MANIFEST_VERSION {
            return Err(ProjectError::domain(
                "MOKA_VERSION_UNSUPPORTED",
                format!(
                    "Package format {} is not supported",
                    manifest.format_version
                ),
            ));
        }

        // Verify manifest hashes against the staged content.
        for entry in &manifest.entries {
            if entry.path == MANIFEST_NAME {
                continue;
            }
            let staged = staging.join(&entry.path);
            let bytes = std::fs::read(&staged).map_err(|_| {
                ProjectError::domain(
                    "PACKAGE_INVALID",
                    format!("Package entry is missing: {}", entry.path),
                )
            })?;
            if bytes.len() as u64 != entry.bytes || sha256_hex(&bytes) != entry.sha256 {
                return Err(ProjectError::domain(
                    "PACKAGE_INVALID",
                    format!("Package entry failed verification: {}", entry.path),
                ));
            }
        }

        // The staged tree must itself be a valid project before committing.
        let moka_path = staging.join("canvas.moka");
        let moka_bytes = std::fs::read(&moka_path).map_err(|_| {
            ProjectError::domain("PACKAGE_INVALID", "Package contains no canvas.moka")
        })?;
        crate::project::codec::decode_moka_file(&moka_bytes)?;

        if target_root.exists() && target_root.read_dir()?.next().is_some() {
            return Err(ProjectError::domain(
                "CONFLICT",
                format!("Target directory is not empty: {}", target_root.display()),
            ));
        }
        if target_root.exists() {
            std::fs::remove_dir(target_root)?;
        }
        std::fs::rename(&staging, target_root)?;
        Ok(())
    })();

    if outcome.is_err() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    outcome
}

pub fn asset_categories() -> &'static [&'static str] {
    &ASSET_CATEGORIES
}
