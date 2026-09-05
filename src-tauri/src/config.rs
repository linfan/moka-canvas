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
    pub recent_registry_path: PathBuf,
    #[serde(default = "default_max_moka_file_bytes")]
    pub max_moka_file_bytes: u64,
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
    #[error("recent registry parent directory cannot be created: {0}")]
    RegistryDir(String),
}

impl ConfigError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Unreadable(_) => "CONFIG_UNREADABLE",
            Self::InvalidYaml(_) => "CONFIG_INVALID",
            Self::UnsupportedVersion(_) => "CONFIG_VERSION_UNSUPPORTED",
            Self::StaticDirMissing(_) => "CONFIG_STATIC_DIR_MISSING",
            Self::RegistryDir(_) => "CONFIG_REGISTRY_DIR",
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
    parse_config(&raw, None)
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
    parse_config(&raw, None)
}

fn parse_config(raw: &str, base: Option<&Path>) -> Result<AppConfig, ConfigError> {
    let mut config: AppConfig =
        serde_yaml::from_str(raw).map_err(|error| ConfigError::InvalidYaml(error.to_string()))?;
    if config.version != 1 {
        return Err(ConfigError::UnsupportedVersion(config.version));
    }
    if let Some(base) = base {
        if config.server.static_dir.is_relative() {
            config.server.static_dir = base.join(&config.server.static_dir);
        }
        if config.projects.recent_registry_path.is_relative() {
            config.projects.recent_registry_path = base.join(&config.projects.recent_registry_path);
        }
    }
    Ok(config)
}

/// Startup-time environment validation: the static directory must exist and
/// the recent registry parent must be creatable and writable.
pub fn validate_startup(config: &AppConfig) -> Result<(), ConfigError> {
    if !config.server.static_dir.is_dir() {
        return Err(ConfigError::StaticDirMissing(
            config.server.static_dir.display().to_string(),
        ));
    }
    let registry = &config.projects.recent_registry_path;
    if let Some(parent) = registry.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| ConfigError::RegistryDir(format!("{}: {error}", parent.display())))?;
        let probe = parent.join(".moka-write-probe");
        std::fs::write(&probe, b"")
            .and_then(|_| std::fs::remove_file(&probe))
            .map_err(|error| ConfigError::RegistryDir(format!("{}: {error}", parent.display())))?;
    }
    Ok(())
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
            recent_registry_path: root.join("data/recent-projects.json"),
            max_moka_file_bytes: default_max_moka_file_bytes(),
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
        let config = parse_config(raw, None).expect("example config must parse");
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
            config.projects.recent_registry_path,
            PathBuf::from("/tmp/moka-app-data/recent-projects.json")
        );
        assert_eq!(
            config.server.static_dir,
            PathBuf::from("/tmp/moka-resources/web")
        );
    }

    #[test]
    fn rejects_an_unsupported_version() {
        let raw =
            include_str!("../../config/moka.example.yaml").replace("version: 1", "version: 9");
        let error = parse_config(&raw, None).unwrap_err();
        assert!(matches!(error, ConfigError::UnsupportedVersion(9)));
    }

    #[test]
    fn rejects_invalid_yaml() {
        let error = parse_config("version: [", None).unwrap_err();
        assert!(matches!(error, ConfigError::InvalidYaml(_)));
    }

    #[test]
    fn startup_validation_requires_the_static_dir() {
        let mut config = parse_test_config(Path::new("/tmp/moka-never-created"));
        config.server.static_dir = PathBuf::from("/tmp/moka-definitely-missing-dir");
        let error = validate_startup(&config).unwrap_err();
        assert!(matches!(error, ConfigError::StaticDirMissing(_)));
    }
}
