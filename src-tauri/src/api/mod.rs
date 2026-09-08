use crate::config::{AppConfig, RuntimeMode};
use crate::generate::ProviderRepo;
use crate::metadata::{self, MetadataStore};
use crate::project::store::FsProjectStore;
use crate::workflow::executor::DeterministicExecutor;
use crate::workflow::runner::RunManager;
use crate::workflow::WorkflowExecutor;
use std::path::Path;
use std::sync::Arc;

pub mod dto;
pub mod problem;
pub mod routes;

#[derive(Clone)]
pub struct ApiState {
    pub mode: RuntimeMode,
    pub config: Arc<AppConfig>,
    pub store: Arc<FsProjectStore>,
    pub metadata: Arc<dyn MetadataStore>,
    pub providers: Arc<ProviderRepo>,
    pub runs: Arc<RunManager>,
}

impl ApiState {
    /// Opens the metadata directory before anything can serve a request.
    ///
    /// `root` is the location startup validation already resolved and checked
    /// for isolation, so the store never resolves it a second time.
    ///
    /// Fails when the directory is locked by another process, was written by a
    /// newer format version, or holds credentials with no master key available
    /// to open them.
    pub fn new(config: AppConfig, mode: RuntimeMode, root: &Path) -> anyhow::Result<Self> {
        let metadata = metadata::open(root, &config.metadata, mode)?;
        Ok(Self::with_metadata(config, mode, metadata))
    }

    pub fn with_metadata(
        config: AppConfig,
        mode: RuntimeMode,
        metadata: Arc<dyn MetadataStore>,
    ) -> Self {
        let config = Arc::new(config);
        let store = Arc::new(FsProjectStore::new(Arc::clone(&config)));
        let providers = Arc::new(ProviderRepo::new(Arc::clone(&metadata)));
        let executors: Vec<Arc<dyn WorkflowExecutor>> =
            vec![Arc::new(DeterministicExecutor::new())];
        let runs = RunManager::new(
            Arc::clone(&store),
            executors,
            config.workflow.enabled_executors.clone(),
        );
        Self {
            mode,
            store,
            metadata,
            providers,
            config,
            runs,
        }
    }
}

pub fn router() -> axum::Router<ApiState> {
    use axum::routing::{delete, get, post, put};
    axum::Router::new()
        .route("/api/v1/config", get(routes::public_config))
        .route("/api/v1/recent-projects", get(routes::list_recent))
        .route(
            "/api/v1/recent-projects/{id}",
            delete(routes::remove_recent),
        )
        .route("/api/v1/projects", post(routes::create_project))
        .route("/api/v1/projects/open", post(routes::open_project))
        .route("/api/v1/projects/import", post(routes::import_project))
        .route("/api/v1/projects/current", get(routes::current_project))
        .route(
            "/api/v1/projects/current/commands",
            post(routes::apply_commands),
        )
        .route(
            "/api/v1/projects/current/assets",
            post(routes::upload_asset),
        )
        .route(
            "/api/v1/projects/current/assets/{id}",
            get(routes::stream_asset).delete(routes::delete_asset),
        )
        .route(
            "/api/v1/projects/current/assets/{id}/content",
            put(routes::replace_asset),
        )
        .route(
            "/api/v1/projects/current/assets/{id}/reveal",
            post(routes::reveal_asset),
        )
        .route(
            "/api/v1/projects/current/export",
            post(routes::export_package),
        )
        .route(
            "/api/v1/projects/current/runs",
            get(routes::list_runs).post(routes::start_run),
        )
        .route("/api/v1/projects/current/runs/{id}", get(routes::get_run))
        .route(
            "/api/v1/projects/current/runs/{id}/cancel",
            post(routes::cancel_run),
        )
        .route(
            "/api/v1/projects/current/runs/{id}/retry",
            post(routes::retry_run),
        )
}
