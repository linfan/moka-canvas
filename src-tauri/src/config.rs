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

/// Budgets for talking to a provider. Every value bounds how long to wait or
/// how much to accept; none of them change what is asked for.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateConfig {
    #[serde(default = "default_text_timeout_seconds")]
    pub text_timeout_seconds: u64,
    #[serde(default = "default_image_timeout_seconds")]
    pub image_timeout_seconds: u64,
    #[serde(default = "default_audio_timeout_seconds")]
    pub audio_timeout_seconds: u64,
    /// Starting an upstream video job, which answers with a handle at once.
    #[serde(default = "default_video_task_timeout_seconds")]
    pub video_task_timeout_seconds: u64,
    /// One poll of an upstream video job.
    #[serde(default = "default_video_poll_timeout_seconds")]
    pub video_poll_timeout_seconds: u64,
    /// Attempts for a failure waiting can fix, counting the first.
    #[serde(default = "default_max_attempts")]
    pub max_attempts: u32,
    /// First backoff wait; doubled each attempt, and a `Retry-After` wins.
    #[serde(default = "default_retry_base_ms")]
    pub retry_base_ms: u64,
    #[serde(default = "default_max_image_input_bytes")]
    pub max_image_input_bytes: u64,
    #[serde(default = "default_max_media_input_bytes")]
    pub max_media_input_bytes: u64,
    /// What one reply from a provider may weigh.
    ///
    /// A generation answer can carry a base64 image, so the ceiling here is far
    /// above the one a model list gets, and above the one on the answer it
    /// carries: an answer arrives encoded, so the reply is the larger of the two.
    #[serde(default = "default_max_response_bytes")]
    pub max_response_bytes: u64,
    /// How many runs drive at once. One past the ceiling waits with its record
    /// still saying queued, which is what a client reads.
    #[serde(default = "default_max_concurrent_runs")]
    pub max_concurrent_runs: usize,
    /// Nothing reaches a provider. The executor that would is not offered, so a
    /// generation node is refused before a run starts rather than failing inside
    /// one.
    #[serde(default)]
    pub offline: bool,
    /// What one answer's media may add up to.
    #[serde(default = "default_max_output_bytes")]
    pub max_output_bytes: u64,
    /// How many pieces one answer may carry, which is also how many cards a node
    /// can point at.
    #[serde(default = "default_max_output_items")]
    pub max_output_items: usize,
    /// Looks at an upstream job before it is given up on.
    #[serde(default = "default_video_max_polls")]
    pub video_max_polls: u32,
}

impl Default for GenerateConfig {
    fn default() -> Self {
        Self {
            text_timeout_seconds: default_text_timeout_seconds(),
            image_timeout_seconds: default_image_timeout_seconds(),
            audio_timeout_seconds: default_audio_timeout_seconds(),
            video_task_timeout_seconds: default_video_task_timeout_seconds(),
            video_poll_timeout_seconds: default_video_poll_timeout_seconds(),
            max_attempts: default_max_attempts(),
            retry_base_ms: default_retry_base_ms(),
            max_image_input_bytes: default_max_image_input_bytes(),
            max_media_input_bytes: default_max_media_input_bytes(),
            max_response_bytes: default_max_response_bytes(),
            max_concurrent_runs: default_max_concurrent_runs(),
            offline: false,
            max_output_bytes: default_max_output_bytes(),
            max_output_items: default_max_output_items(),
            video_max_polls: default_video_max_polls(),
        }
    }
}

impl GenerateConfig {
    /// How long one request of this capability may take. Video is task-based,
    /// so its budget belongs to the two task calls rather than to `generate`.
    pub fn timeout_for(&self, capability: crate::domain::Capability) -> std::time::Duration {
        let secs = match capability {
            crate::domain::Capability::Text => self.text_timeout_seconds,
            crate::domain::Capability::Image => self.image_timeout_seconds,
            crate::domain::Capability::Audio => self.audio_timeout_seconds,
            crate::domain::Capability::Video => self.video_task_timeout_seconds,
        };
        std::time::Duration::from_secs(secs)
    }

    /// How long one look at an upstream job may take. Video is the only
    /// capability with a job today, so its budget answers for all of them.
    pub fn poll_timeout(&self) -> std::time::Duration {
        std::time::Duration::from_secs(self.video_poll_timeout_seconds)
    }

    /// The input ceiling for an asset of this kind.
    pub fn input_cap_for(&self, capability: crate::domain::Capability) -> u64 {
        match capability {
            crate::domain::Capability::Image | crate::domain::Capability::Text => {
                self.max_image_input_bytes
            }
            crate::domain::Capability::Audio | crate::domain::Capability::Video => {
                self.max_media_input_bytes
            }
        }
    }

    /// How many runs may drive at once.
    ///
    /// Never none: a ceiling of zero is a queue nothing ever leaves, and a
    /// mistyped number should not be able to ask for one.
    pub fn concurrent_runs(&self) -> usize {
        self.max_concurrent_runs.max(1)
    }

    /// How many looks at an upstream job before it is given up on.
    ///
    /// Never none, because a ceiling of zero would fail a job before asking
    /// about it once, and a job this process placed is one a provider is already
    /// being paid for.
    pub fn poll_ceiling(&self) -> u32 {
        self.video_max_polls.max(1)
    }
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
    vec!["deterministic".to_string(), "provider".to_string()]
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
fn default_text_timeout_seconds() -> u64 {
    120
}
fn default_image_timeout_seconds() -> u64 {
    300
}
fn default_audio_timeout_seconds() -> u64 {
    120
}
fn default_video_task_timeout_seconds() -> u64 {
    60
}
fn default_video_poll_timeout_seconds() -> u64 {
    30
}
fn default_max_attempts() -> u32 {
    3
}
fn default_retry_base_ms() -> u64 {
    1_000
}
fn default_max_image_input_bytes() -> u64 {
    20 * 1024 * 1024
}
fn default_max_media_input_bytes() -> u64 {
    200 * 1024 * 1024
}
/// Wide enough to carry the biggest answer one is allowed to keep.
///
/// An answer arrives encoded inside a reply, so the reply is the larger of the
/// two. Deriving one from the other rather than shipping two numbers is what
/// keeps the ceiling on an answer the one that bites: a reply ceiling below it
/// would refuse answers that were inside it, and the number a deployment set
/// about its answers would never be reached.
fn default_max_response_bytes() -> u64 {
    default_max_output_bytes() * 3 / 2
}
fn default_max_concurrent_runs() -> usize {
    2
}
fn default_max_output_bytes() -> u64 {
    256 * 1024 * 1024
}
/// The same number as the cards a node can point at, taken from the one place
/// that says so: a piece past it would be filed in the project with nowhere on
/// the canvas to show it.
fn default_max_output_items() -> usize {
    crate::domain::validate::MAX_RESULT_SLOTS
}
fn default_video_max_polls() -> u32 {
    120
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
    #[serde(default)]
    pub generate: GenerateConfig,
    pub public: PublicConfig,
    #[serde(default)]
    pub limits: LimitsConfig,
}

impl AppConfig {
    /// The executors a run may use.
    ///
    /// Offline takes the one that reaches a provider out of the list rather than
    /// adding a refusal of its own: a node that cannot run is refused where every
    /// other reason a node cannot run is, and the list handed to a client is the
    /// list a run is validated against, so the two cannot disagree about what is
    /// switched off.
    pub fn active_executors(&self) -> Vec<String> {
        if !self.generate.offline {
            return self.workflow.enabled_executors.clone();
        }
        self.workflow
            .enabled_executors
            .iter()
            .filter(|key| key.as_str() != crate::workflow::PROVIDER_EXECUTOR_KEY)
            .cloned()
            .collect()
    }
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
        generate: GenerateConfig::default(),
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
        // Both, because an example that named only the local one would refuse
        // every generation node the moment somebody copied it.
        assert_eq!(
            config.workflow.enabled_executors,
            vec!["deterministic".to_string(), "provider".to_string()]
        );
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
    fn generate_section_is_optional() {
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
        assert_eq!(config.generate, GenerateConfig::default());
        assert_eq!(config.generate.text_timeout_seconds, 120);
        assert_eq!(config.generate.image_timeout_seconds, 300);
        assert_eq!(config.generate.video_poll_timeout_seconds, 30);
        assert_eq!(config.generate.max_attempts, 3);
        assert_eq!(config.generate.max_concurrent_runs, 2);
        assert!(
            !config.generate.offline,
            "reaching a provider is the default"
        );
        assert_eq!(config.generate.max_output_bytes, 256 * 1024 * 1024);
        assert_eq!(config.generate.video_max_polls, 120);
    }

    #[test]
    fn an_offline_switch_takes_the_provider_out_of_the_list() {
        let root = tempfile::tempdir().unwrap();
        let mut config = parse_test_config(root.path());
        assert_eq!(
            config.active_executors(),
            vec!["deterministic".to_string(), "provider".to_string()]
        );

        config.generate.offline = true;
        assert_eq!(
            config.active_executors(),
            vec!["deterministic".to_string()],
            "a generation node is refused at validation rather than mid-run"
        );
        // What was configured is left alone: switching back on restores the list
        // rather than needing it written again.
        assert_eq!(config.workflow.enabled_executors.len(), 2);
    }

    #[test]
    fn a_ceiling_of_none_is_read_as_one() {
        let budgets = GenerateConfig::default();
        // The piece ceiling is the number of cards a node can point at, so an
        // answer that fits is an answer the canvas can show.
        assert_eq!(
            budgets.max_output_items,
            crate::domain::validate::MAX_RESULT_SLOTS
        );

        let none = GenerateConfig {
            max_concurrent_runs: 0,
            video_max_polls: 0,
            ..GenerateConfig::default()
        };
        assert_eq!(
            none.concurrent_runs(),
            1,
            "a queue nothing ever leaves is a typo"
        );
        assert_eq!(none.poll_ceiling(), 1, "a job is asked about at least once");
    }

    #[test]
    fn a_reply_is_allowed_to_carry_the_biggest_answer_one_may_keep() {
        let budgets = GenerateConfig::default();
        // An answer arrives encoded, so the reply holding it is bigger than the
        // answer inside it. A reply ceiling the other way round would be the one
        // that actually bites, and the ceiling on an answer would never be
        // reached at all.
        assert!(
            budgets.max_response_bytes > budgets.max_output_bytes,
            "{} has to carry {}",
            budgets.max_response_bytes,
            budgets.max_output_bytes
        );
    }

    #[test]
    fn each_capability_gets_its_own_budget() {
        let budgets = GenerateConfig::default();
        use crate::domain::Capability;
        assert_eq!(budgets.timeout_for(Capability::Text).as_secs(), 120);
        assert_eq!(budgets.timeout_for(Capability::Image).as_secs(), 300);
        assert_eq!(budgets.timeout_for(Capability::Audio).as_secs(), 120);
        // Starting a job answers at once, so it gets the short budget; waiting
        // for the job itself is the caller's polling loop, not one request.
        assert_eq!(budgets.timeout_for(Capability::Video).as_secs(), 60);
        assert_eq!(budgets.poll_timeout().as_secs(), 30);
        assert_eq!(
            budgets.input_cap_for(Capability::Image),
            budgets.max_image_input_bytes
        );
        assert_eq!(
            budgets.input_cap_for(Capability::Video),
            budgets.max_media_input_bytes
        );
    }

    #[test]
    fn one_generate_key_does_not_disturb_the_others() {
        let tuned = r#"
version: 1
server:
  bind: "127.0.0.1:3000"
  staticDir: "./dist"
projects:
  maxMokaFileBytes: 33554432
public:
  productName: "Moka Canvas"
generate:
  imageTimeoutSeconds: 60
  maxAttempts: 1
"#;
        let config = parse_config(tuned).expect("tuned config must parse");
        assert_eq!(config.generate.image_timeout_seconds, 60);
        assert_eq!(config.generate.max_attempts, 1);
        assert_eq!(
            config.generate.text_timeout_seconds,
            default_text_timeout_seconds()
        );
        assert_eq!(
            config.generate.max_response_bytes,
            default_max_response_bytes()
        );
    }

    #[test]
    fn budgets_are_picked_per_capability() {
        use crate::domain::Capability;
        let config = GenerateConfig::default();
        assert_eq!(config.timeout_for(Capability::Text).as_secs(), 120);
        assert_eq!(config.timeout_for(Capability::Image).as_secs(), 300);
        assert_eq!(config.timeout_for(Capability::Audio).as_secs(), 120);
        assert_eq!(config.timeout_for(Capability::Video).as_secs(), 60);
        assert_eq!(config.input_cap_for(Capability::Image), 20 * 1024 * 1024);
        assert_eq!(config.input_cap_for(Capability::Video), 200 * 1024 * 1024);
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
