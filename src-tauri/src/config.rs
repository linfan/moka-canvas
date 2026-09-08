use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfig {
    pub bind: String,
    pub static_dir: PathBuf,
    #[serde(default = "default_max_upload_bytes")]
    pub max_upload_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectsConfig {
    #[serde(default = "default_max_moka_file_bytes")]
    pub max_moka_file_bytes: u64,
}

/// Application-level metadata: recent projects, provider channels, encrypted
/// credentials, global preferences, and the prompt library cache. None of it
/// belongs to a project, so none of it travels inside a project directory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataConfig {
    #[serde(default = "default_metadata_store")]
    pub store: String,
    /// Empty means "resolve per platform"; see `metadata::paths::resolve_dir`.
    #[serde(default)]
    pub dir: Option<PathBuf>,
    #[serde(default = "default_max_document_bytes")]
    pub max_document_bytes: u64,
}

impl Default for MetadataConfig {
    fn default() -> Self {
        Self {
            store: default_metadata_store(),
            dir: None,
            max_document_bytes: default_max_document_bytes(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowConfig {
    #[serde(default = "default_enabled_executors")]
    pub enabled_executors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicConfig {
    pub product_name: String,
    #[serde(default = "default_max_upload_bytes")]
    pub max_upload_bytes: u64,
    #[serde(default = "default_allowed_media_types")]
    pub allowed_media_types: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitsConfig {
    #[serde(default = "default_max_nodes_per_canvas")]
    pub max_nodes_per_canvas: usize,
    #[serde(default = "default_max_edges_per_canvas")]
    pub max_edges_per_canvas: usize,
    #[serde(default = "default_max_canvases_per_project")]
    pub max_canvases_per_project: usize,
    #[serde(default = "default_max_package_bytes")]
    pub max_package_bytes: u64,
    #[serde(default = "default_max_package_entries")]
    pub max_package_entries: usize,
}

impl Default for LimitsConfig {
    fn default() -> Self {
        Self {
            max_nodes_per_canvas: default_max_nodes_per_canvas(),
            max_edges_per_canvas: default_max_edges_per_canvas(),
            max_canvases_per_project: default_max_canvases_per_project(),
            max_package_bytes: default_max_package_bytes(),
            max_package_entries: default_max_package_entries(),
        }
    }
}

fn default_max_upload_bytes() -> u64 {
    2_147_483_648
}
fn default_max_moka_file_bytes() -> u64 {
    33_554_432
}
fn default_metadata_store() -> String {
    "file".to_string()
}
fn default_max_document_bytes() -> u64 {
    33_554_432
}
fn default_enabled_executors() -> Vec<String> {
    vec!["deterministic".to_string()]
}
fn default_allowed_media_types() -> Vec<String> {
    vec![
        "image".into(),
        "audio".into(),
        "video".into(),
        "text".into(),
    ]
}
fn default_max_nodes_per_canvas() -> usize {
    5_000
}
fn default_max_edges_per_canvas() -> usize {
    10_000
}
fn default_max_canvases_per_project() -> usize {
    64
}
fn default_max_package_bytes() -> u64 {
    4_294_967_296
}
fn default_max_package_entries() -> usize {
    50_000
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub version: u32,
    pub server: ServerConfig,
    pub projects: ProjectsConfig,
    #[serde(default)]
    pub metadata: MetadataConfig,
    #[serde(default)]
    pub workflow: WorkflowConfig,
    pub public: PublicConfig,
    #[serde(default)]
    pub limits: LimitsConfig,
}

impl Default for WorkflowConfig {
    fn default() -> Self {
        Self {
            enabled_executors: default_enabled_executors(),
        }
    }
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("configuration file cannot be read: {0}")]
    Unreadable(String),
    #[error("configuration is not valid YAML: {0}")]
    InvalidYaml(String),
    #[error("configuration version {0} is not supported (expected 1)")]
    UnsupportedVersion(u32),
    #[error("static directory does not exist: {0}")]
    StaticDirMissing(String),
    #[error("metadata directory is not usable: {0}")]
    MetadataDirInvalid(String),
    #[error("unsupported metadata store: {0}")]
    MetadataStoreUnsupported(String),
    #[error("metadata master key is unavailable: {0}")]
    MetadataKeyMissing(String),
}

impl ConfigError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Unreadable(_) => "CONFIG_UNREADABLE",
            Self::InvalidYaml(_) => "CONFIG_INVALID",
            Self::UnsupportedVersion(_) => "CONFIG_VERSION_UNSUPPORTED",
            Self::StaticDirMissing(_) => "CONFIG_STATIC_DIR_MISSING",
            Self::MetadataDirInvalid(_) => "CONFIG_METADATA_DIR_INVALID",
            Self::MetadataStoreUnsupported(_) => "CONFIG_METADATA_STORE_UNSUPPORTED",
            Self::MetadataKeyMissing(_) => "CONFIG_METADATA_KEY_MISSING",
        }
    }
}

pub const NATIVE_CONFIG_YAML: &str = include_str!("../resources/native-config.yaml");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeMode {
    Web,
    Native,
}

impl RuntimeMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            RuntimeMode::Web => "web",
            RuntimeMode::Native => "tauri",
        }
    }
}

/// Loads the standalone YAML for the CLI/web server.
pub fn load_config_file(path: &Path) -> Result<AppConfig, ConfigError> {
    let raw = std::fs::read_to_string(path)
        .map_err(|error| ConfigError::Unreadable(format!("{}: {error}", path.display())))?;
    parse_config(&raw)
}

/// Loads the compiled-in YAML for the desktop app. Placeholders resolve
/// against the platform app-data/resource directories; there is no
/// user-editable override in this mode.
pub fn load_native_config(
    app_data_dir: &Path,
    resource_dir: &Path,
) -> Result<AppConfig, ConfigError> {
    let raw = NATIVE_CONFIG_YAML
        .replace("${appData}", &app_data_dir.to_string_lossy())
        .replace("${resourceDir}", &resource_dir.to_string_lossy());
    parse_config(&raw)
}

fn parse_config(raw: &str) -> Result<AppConfig, ConfigError> {
    let config: AppConfig =
        serde_yaml::from_str(raw).map_err(|error| ConfigError::InvalidYaml(error.to_string()))?;
    if config.version != 1 {
        return Err(ConfigError::UnsupportedVersion(config.version));
    }
    Ok(config)
}

/// Startup-time environment validation: the static directory must exist and
/// the metadata backend must be reachable at a safe location.
///
/// Returns the resolved metadata root so the caller can open the store
/// without resolving the location a second time.
pub fn validate_startup(
    config: &AppConfig,
    mode: RuntimeMode,
    app_data: Option<&Path>,
) -> Result<PathBuf, ConfigError> {
    if !config.server.static_dir.is_dir() {
        return Err(ConfigError::StaticDirMissing(
            config.server.static_dir.display().to_string(),
        ));
    }
    let store = crate::metadata::paths::resolve_store(&config.metadata);
    if store != crate::metadata::FILE_STORE {
        return Err(ConfigError::MetadataStoreUnsupported(format!(
            "{store:?} is not implemented; set metadata.store to {:?}",
            crate::metadata::FILE_STORE
        )));
    }
    let dir = crate::metadata::paths::resolve_dir(&config.metadata, mode, app_data)?;
    crate::metadata::paths::ensure_isolated(&dir, &config.server.static_dir)
}

/// Builds a configuration rooted inside the given directory, for tests.
pub fn parse_test_config(root: &Path) -> AppConfig {
    let static_dir = root.join("static");
    std::fs::create_dir_all(&static_dir).expect("static dir");
    AppConfig {
        version: 1,
        server: ServerConfig {
            bind: "127.0.0.1:0".into(),
            static_dir,
            max_upload_bytes: default_max_upload_bytes(),
        },
        projects: ProjectsConfig {
            max_moka_file_bytes: default_max_moka_file_bytes(),
        },
        metadata: MetadataConfig {
            store: default_metadata_store(),
            dir: Some(root.join("metadata")),
            max_document_bytes: default_max_document_bytes(),
        },
        workflow: WorkflowConfig::default(),
        public: PublicConfig {
            product_name: "Moka Canvas".into(),
            max_upload_bytes: default_max_upload_bytes(),
            allowed_media_types: default_allowed_media_types(),
        },
        limits: LimitsConfig::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_example_config() {
        let raw = include_str!("../../config/moka.example.yaml");
        let config = parse_config(raw).expect("example config must parse");
        assert_eq!(config.server.bind, "127.0.0.1:3000");
        assert_eq!(config.public.product_name, "Moka Canvas");
        assert!(config
            .workflow
            .enabled_executors
            .contains(&"deterministic".to_string()));
    }

    #[test]
    fn parses_the_embedded_native_config_with_placeholders() {
        let app_data = Path::new("/tmp/moka-app-data");
        let resource = Path::new("/tmp/moka-resources");
        let config = load_native_config(app_data, resource).expect("native config must parse");
        assert_eq!(
            config.metadata.dir,
            Some(PathBuf::from("/tmp/moka-app-data/metadata"))
        );
        assert_eq!(
            config.server.static_dir,
            PathBuf::from("/tmp/moka-resources/web")
        );
    }

    #[test]
    fn metadata_section_is_optional() {
        let legacy = r#"
version: 1
server:
  bind: "127.0.0.1:3000"
  staticDir: "./dist"
projects:
  maxMokaFileBytes: 33554432
public:
  productName: "Moka Canvas"
"#;
        let config = parse_config(legacy).expect("legacy config must parse");
        assert_eq!(config.metadata, MetadataConfig::default());
    }

    #[test]
    fn rejects_an_unsupported_version() {
        let raw =
            include_str!("../../config/moka.example.yaml").replace("version: 1", "version: 9");
        let error = parse_config(&raw).unwrap_err();
        assert!(matches!(error, ConfigError::UnsupportedVersion(9)));
    }

    #[test]
    fn rejects_invalid_yaml() {
        let error = parse_config("version: [").unwrap_err();
        assert!(matches!(error, ConfigError::InvalidYaml(_)));
    }

    #[test]
    fn startup_validation_requires_the_static_dir() {
        let root = tempfile::tempdir().unwrap();
        let mut config = parse_test_config(root.path());
        config.server.static_dir = PathBuf::from("/tmp/moka-definitely-missing-dir");
        let error = validate_startup(&config, RuntimeMode::Web, None).unwrap_err();
        assert!(matches!(error, ConfigError::StaticDirMissing(_)));
    }

    #[test]
    fn startup_validation_rejects_an_unimplemented_store() {
        let root = tempfile::tempdir().unwrap();
        let mut config = parse_test_config(root.path());
        config.metadata.store = "postgres".to_string();
        let error = validate_startup(&config, RuntimeMode::Web, None).unwrap_err();
        assert_eq!(error.code(), "CONFIG_METADATA_STORE_UNSUPPORTED");
    }

    #[test]
    fn startup_validation_rejects_a_directory_inside_the_program_tree() {
        let root = tempfile::tempdir().unwrap();
        let mut config = parse_test_config(root.path());
        config.metadata.dir = Some(config.server.static_dir.join("metadata"));
        let error = validate_startup(&config, RuntimeMode::Web, None).unwrap_err();
        assert_eq!(error.code(), "CONFIG_METADATA_DIR_INVALID");
    }

    #[test]
    fn startup_validation_resolves_the_metadata_root() {
        let root = tempfile::tempdir().unwrap();
        let config = parse_test_config(root.path());
        let resolved = validate_startup(&config, RuntimeMode::Web, None).expect("valid config");
        assert!(resolved.is_absolute());
        assert!(resolved.is_dir());
    }
}
