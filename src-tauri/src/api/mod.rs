use crate::config::{AppConfig, RuntimeMode};
use crate::project::recent::RecentRegistry;
use crate::project::store::FsProjectStore;
use crate::workflow::executor::DeterministicExecutor;
use crate::workflow::runner::RunManager;
use crate::workflow::WorkflowExecutor;
use std::sync::{Arc, Mutex};

pub mod dto;
pub mod problem;
pub mod routes;

#[derive(Clone)]
pub struct ApiState {
    pub mode: RuntimeMode,
    pub config: Arc<AppConfig>,
    pub store: Arc<FsProjectStore>,
    pub recent: Arc<Mutex<RecentRegistry>>,
    pub runs: Arc<RunManager>,
}

impl ApiState {
    pub fn new(config: AppConfig, mode: RuntimeMode) -> Self {
        let config = Arc::new(config);
        let recent = RecentRegistry::load(&config.projects.recent_registry_path);
        let store = Arc::new(FsProjectStore::new(Arc::clone(&config)));
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
            recent: Arc::new(Mutex::new(recent)),
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
        .route(
            "/api/v1/projects/current/runs/{id}",
            get(routes::get_run),
        )
        .route(
            "/api/v1/projects/current/runs/{id}/cancel",
            post(routes::cancel_run),
        )
        .route(
            "/api/v1/projects/current/runs/{id}/retry",
            post(routes::retry_run),
        )
}
