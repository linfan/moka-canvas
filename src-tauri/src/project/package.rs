use crate::config::LimitsConfig;
use crate::domain::{now_iso, ASSET_CATEGORIES};
use crate::domain::{MokaFile, PACKAGE_MANIFEST_VERSION};
use crate::metadata::crypto;
use crate::metadata::docs;
use crate::project::store::normalize_relative;
use crate::project::{PackageReport, PackageScope, ProjectError};
use serde::{Deserialize, Serialize};
use sha2::Digest;
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageManifestEntry {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
}

/// What a rule kept out of a package, counted as the walk went past it.
///
/// Collected rather than declared: a list of patterns stating what a package
/// never carries is a claim nobody checks, and the reason to name the skips at
/// all is that a receiver can hold them against what arrived.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageSkip {
    pub pattern: String,
    pub files: u64,
    pub bytes: u64,
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
    /// Whether the records of the runs that made this project travelled with it.
    ///
    /// Said outright rather than left to be noticed in the entries: a package
    /// carrying them carries the prompts they were asked with and the names of
    /// the models that answered, which is a thing the receiver is owed.
    #[serde(default)]
    pub personal_history: bool,
    #[serde(default)]
    pub skipped: Vec<PackageSkip>,
    pub entries: Vec<PackageManifestEntry>,
}

const MANIFEST_NAME: &str = "moka-package.json";
const OS_JUNK: [&str; 3] = [".DS_Store", "Thumbs.db", "desktop.ini"];

/// Where a job a provider is still running is noted, so the poll that collects
/// it can be placed again after a restart.
///
/// Local to the process that placed the job and to the machine it ran on: it is
/// addressed by a handle the far end issued, which a package opened somewhere
/// else could not ask after even if it were allowed to carry one.
const JOB_RECORDS: &str = "history/jobs/";

/// Where the record of each run this project made is kept.
///
/// Unlike a job, a record is finished and readable — it is also about this
/// machine's use of the project rather than about the project, so it travels
/// only in a package asked to carry it.
const RUN_RECORDS: &str = "history/runs/";

/// Application-level metadata documents that sit at the project root only.
/// Matching the whole relative path keeps an asset that happens to share a
/// name — a project may well contain its own `meta.json` — in the package.
const METADATA_DOCUMENTS: [&str; 4] = [
    docs::META_DOC,
    docs::RECENT_DOC,
    docs::PROVIDERS_DOC,
    docs::PROMPT_SOURCES_DOC,
];

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = sha2::Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

/// Which rule kept a path out of a package.
///
/// A rule rather than a pattern string, so the walk can total what each one cost
/// and the manifest can state it afterwards. Ordered only so that a manifest
/// lists the same rules in the same order every time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Skip {
    /// Scratch space, holding whatever a half-finished write left behind.
    Scratch,
    /// A job a provider on this machine is still running.
    Job,
    /// The record of a run this machine made.
    Run,
    /// A credential, at any depth: nothing in a project tree has a legitimate
    /// reason to carry one.
    Secret,
    /// The key the credentials are sealed with, at any depth.
    MasterKey,
    /// A document this app put aside as unreadable.
    Corrupt,
    /// An application-level document, which belongs at a project root only.
    /// Matched on the whole relative path, so an asset that happens to share a
    /// name — a project may well contain its own `meta.json` — still ships.
    ApplicationDocument(&'static str),
    /// What an operating system leaves in a directory it was shown.
    SystemJunk(&'static str),
}

impl Skip {
    /// The rule stated as a path pattern, which is how a manifest names it.
    fn pattern(&self) -> String {
        match self {
            Self::Scratch => "tmp/**".into(),
            Self::Job => format!("{JOB_RECORDS}**"),
            Self::Run => format!("{RUN_RECORDS}**"),
            Self::Secret => format!("**/{}", docs::SECRETS_DOC),
            Self::MasterKey => format!("**/{}", crypto::MASTER_KEY_FILE),
            Self::Corrupt => "**/*.corrupt.*".into(),
            Self::ApplicationDocument(document) => (*document).to_string(),
            Self::SystemJunk(name) => format!("**/{name}"),
        }
    }
}

fn skipped(relative: &str, scope: &PackageScope) -> Option<Skip> {
    if relative == "tmp" || relative.starts_with("tmp/") {
        return Some(Skip::Scratch);
    }
    if relative.starts_with(JOB_RECORDS) {
        return Some(Skip::Job);
    }
    if !scope.personal_history && relative.starts_with(RUN_RECORDS) {
        return Some(Skip::Run);
    }
    let name = relative.rsplit('/').next().unwrap_or(relative);
    if name == docs::SECRETS_DOC {
        return Some(Skip::Secret);
    }
    if name == crypto::MASTER_KEY_FILE {
        return Some(Skip::MasterKey);
    }
    if name.contains(".corrupt.") {
        return Some(Skip::Corrupt);
    }
    if let Some(document) = METADATA_DOCUMENTS
        .iter()
        .copied()
        .find(|one| *one == relative)
    {
        return Some(Skip::ApplicationDocument(document));
    }
    OS_JUNK
        .iter()
        .copied()
        .find(|one| *one == name)
        .map(Skip::SystemJunk)
}

/// A path as the package would name it, which is always with forward slashes.
fn relative_to(root: &Path, path: &Path) -> Result<String, ProjectError> {
    Ok(path
        .strip_prefix(root)
        .map_err(|_| ProjectError::domain("INTERNAL", "Path outside root"))?
        .to_string_lossy()
        .replace('\\', "/"))
}

/// How many files a path holds and what they add up to, without reading them.
///
/// A directory left out whole still has a size, and a manifest that reported
/// only the paths the walk itself reached would understate every one of them.
fn measure(path: &Path) -> (u64, u64) {
    let Ok(meta) = std::fs::metadata(path) else {
        return (0, 0);
    };
    if meta.is_file() {
        return (1, meta.len());
    }
    let mut files = 0;
    let mut bytes = 0;
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = std::fs::metadata(&path) else {
                continue;
            };
            if meta.is_dir() {
                stack.push(path);
            } else {
                files += 1;
                bytes += meta.len();
            }
        }
    }
    (files, bytes)
}

/// What the walk of a project tree found, and what keeping the rest out cost.
struct Collected {
    files: Vec<PathBuf>,
    skips: BTreeMap<Skip, (u64, u64)>,
}

fn collect_files(root: &Path, scope: &PackageScope) -> Result<Collected, ProjectError> {
    let mut collected = Collected {
        files: Vec::new(),
        skips: BTreeMap::new(),
    };
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            let path = entry.path();
            let relative = relative_to(root, &path)?;
            if let Some(rule) = skipped(&relative, scope) {
                let (files, bytes) = measure(&path);
                let total = collected.skips.entry(rule).or_default();
                total.0 += files;
                total.1 += bytes;
                continue;
            }
            if path.is_dir() {
                stack.push(path);
            } else if path.is_file() {
                collected.files.push(path);
            }
        }
    }
    collected.files.sort();
    Ok(collected)
}

pub fn export_project(
    root: &Path,
    moka: &MokaFile,
    destination: &Path,
    limits: &LimitsConfig,
    allow_incomplete: bool,
    scope: PackageScope,
) -> Result<PackageReport, ProjectError> {
    let collected = collect_files(root, &scope)?;

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
    for file in &collected.files {
        let relative = relative_to(root, file)?;
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
        personal_history: scope.personal_history,
        // A rule that found nothing to keep out has nothing to say: which kind
        // of package this is is the flag above, not a row of zeroes.
        skipped: collected
            .skips
            .into_iter()
            .filter(|(_, (files, _))| *files > 0)
            .map(|(rule, (files, bytes))| PackageSkip {
                pattern: rule.pattern(),
                files,
                bytes,
            })
            .collect(),
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
        // A range rather than an equality: a package made by an earlier build is
        // still a package, and refusing it would refuse work somebody has on
        // disk. What an older one may carry that a newer one may not is dealt
        // with below, not by turning it away at the door.
        if manifest.format_version == 0 || manifest.format_version > PACKAGE_MANIFEST_VERSION {
            return Err(ProjectError::domain(
                "MOKA_VERSION_UNSUPPORTED",
                format!(
                    "Package format {} is not supported: this build reads 1 to {}",
                    manifest.format_version, PACKAGE_MANIFEST_VERSION
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The package an export makes unless it is asked for more.
    const WORK: PackageScope = PackageScope {
        personal_history: false,
        referenced_assets_only: false,
    };

    /// The package a user asks for when moving their own project elsewhere.
    const BACKUP: PackageScope = PackageScope {
        personal_history: true,
        referenced_assets_only: false,
    };

    fn ships(relative: &str, scope: &PackageScope) -> bool {
        skipped(relative, scope).is_none()
    }

    #[test]
    fn application_metadata_is_never_collected() {
        for relative in [
            "meta.json",
            "recent-projects.json",
            "providers.json",
            "prompts/sources.json",
            "secrets.json",
            "master.key",
            "assets/secrets.json",
            "nested/master.key",
            "recent-projects.corrupt.20260101T000000Z.json",
        ] {
            // Under either kind of package: a credential is not this machine's
            // history to carry, and asking for that history does not ask for one.
            for scope in [&WORK, &BACKUP] {
                assert!(!ships(relative, scope), "{relative} must not be packaged");
            }
        }
    }

    #[test]
    fn an_asset_sharing_a_metadata_name_still_ships() {
        // Only the credential documents are excluded at any depth; the rest are
        // matched on the whole relative path so project content is untouched.
        for relative in [
            "assets/meta.json",
            "assets/providers.json",
            "notes/sources.json",
        ] {
            assert!(ships(relative, &WORK), "{relative} is project content");
        }
    }

    #[test]
    fn scratch_and_os_junk_are_never_collected() {
        for relative in [
            "tmp/partial",
            "tmp",
            ".DS_Store",
            "assets/.DS_Store",
            "Thumbs.db",
        ] {
            assert!(!ships(relative, &WORK), "{relative} must not be packaged");
        }
    }

    #[test]
    fn a_run_this_machine_made_travels_only_in_a_package_that_asked_for_it() {
        let record = "history/runs/0192b7d4-0000-7000-8000-000000000000.json";
        assert_eq!(skipped(record, &WORK), Some(Skip::Run));
        assert!(ships(record, &BACKUP), "a backup carries its own history");
        // A job is a handle on a provider only this machine could ask after, so
        // it stays behind whichever way the package was asked for.
        assert_eq!(
            skipped(
                "history/jobs/0192b7d4-0000-7000-8000-000000000000.json",
                &BACKUP
            ),
            Some(Skip::Job)
        );
    }
}
