use std::{net::SocketAddr, sync::Mutex, time::Instant};

use anyhow::{ensure, Context, Result};
use axum::{
    extract::{DefaultBodyLimit, Request, State},
    http::{header, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde_json::json;
use tokio::{net::TcpListener, sync::oneshot};
use tower_http::{
    services::{ServeDir, ServeFile},
    set_header::SetResponseHeaderLayer,
};

use crate::api::ApiState;
use crate::config::{AppConfig, RuntimeMode};
use crate::project::ProjectStore;

pub struct LocalServer {
    address: SocketAddr,
    shutdown: Mutex<Option<oneshot::Sender<()>>>,
}

impl LocalServer {
    pub async fn start(config: AppConfig, mode: RuntimeMode) -> Result<Self> {
        let address: SocketAddr = config
            .server
            .bind
            .parse()
            .context("server.bind is not a valid socket address")?;
        ensure!(
            config.server.static_dir.is_dir(),
            "static directory does not exist: {}",
            config.server.static_dir.display()
        );

        let state = ApiState::new(config, mode);
        let listener = TcpListener::bind(address)
            .await
            .context("failed to bind the local HTTP server")?;
        let address = listener.local_addr()?;
        let (shutdown_sender, shutdown_receiver) = oneshot::channel();
        let app = router(state);

        tauri::async_runtime::spawn(async move {
            if let Err(error) = axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    let _ = shutdown_receiver.await;
                })
                .await
            {
                eprintln!("local HTTP server stopped unexpectedly: {error}");
            }
        });

        Ok(Self {
            address,
            shutdown: Mutex::new(Some(shutdown_sender)),
        })
    }

    pub fn url(&self) -> String {
        format!("http://{}", self.address)
    }

    pub fn shutdown(&self) {
        if let Ok(mut sender) = self.shutdown.lock() {
            if let Some(sender) = sender.take() {
                let _ = sender.send(());
            }
        }
    }
}

impl Drop for LocalServer {
    fn drop(&mut self) {
        self.shutdown();
    }
}

pub fn router(state: ApiState) -> Router {
    let static_dir = state.config.server.static_dir.clone();
    let max_body = state.config.server.max_upload_bytes as usize;
    let index = static_dir.join("index.html");
    let static_service = ServeDir::new(static_dir).fallback(ServeFile::new(index));

    Router::new()
        .route("/api/health", get(health))
        .route("/api/ready", get(ready))
        .route("/api/runtime", get(runtime))
        .merge(crate::api::router())
        .fallback_service(static_service)
        .layer(middleware::from_fn(log_api_request))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .layer(DefaultBodyLimit::max(max_body))
        .with_state(state)
}

async fn health() -> impl IntoResponse {
    Json(json!({ "status": "ok" }))
}

/// Readiness probe: the loaded configuration's static directory exists, the
/// recent-project registry is writable, and the current project directory
/// (when one is open) is still accessible. Never inspects request payloads.
async fn ready(State(state): State<ApiState>) -> impl IntoResponse {
    let config_loaded = state.config.server.static_dir.is_dir();
    let registry = &state.config.projects.recent_registry_path;
    let registry_writable = registry
        .parent()
        .map(|dir| std::fs::create_dir_all(dir).is_ok())
        .unwrap_or(false)
        && std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(registry)
            .is_ok();
    let project_directory = match state.store.current().await {
        Ok(None) => true,
        Ok(Some(open)) => open.root.is_dir(),
        Err(_) => false,
    };
    let ready = config_loaded && registry_writable && project_directory;
    let status = if ready {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (
        status,
        Json(json!({
            "status": if ready { "ready" } else { "unavailable" },
            "checks": {
                "config": config_loaded,
                "recentRegistry": registry_writable,
                "projectDirectory": project_directory,
            },
        })),
    )
}

/// Emits one structured event per API request with a request id, duration,
/// status, and error code. Request bodies are never logged.
async fn log_api_request(req: Request, next: Next) -> Response {
    let path = req.uri().path().to_string();
    if !path.starts_with("/api/") {
        return next.run(req).await;
    }
    let method = req.method().clone();
    let request_id = uuid::Uuid::now_v7().simple().to_string()[..12].to_string();
    let started = Instant::now();
    let mut response = next.run(req).await;
    let status = response.status().as_u16();
    let error_code = response
        .headers()
        .get("x-error-code")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    if let Ok(value) = HeaderValue::from_str(&request_id) {
        response.headers_mut().insert("x-request-id", value);
    }
    macro_rules! log_event {
        ($level:path) => {
            tracing::event!(
                target: "moka::http",
                $level,
                request_id = %request_id,
                method = %method,
                path = %path,
                status,
                duration_ms = started.elapsed().as_millis() as u64,
                error_code = %error_code,
                "api request"
            )
        };
    }
    match status {
        500..=599 => log_event!(tracing::Level::ERROR),
        400..=499 => log_event!(tracing::Level::WARN),
        _ => log_event!(tracing::Level::INFO),
    }
    response
}

async fn runtime(State(state): State<ApiState>) -> impl IntoResponse {
    Json(json!({
        "delivery": "localhost",
        "mode": state.mode.as_str(),
        "renderer": "react + leafer-ui"
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn reports_healthy() {
        let response = health().await.into_response();
        assert_eq!(response.status(), 200);
    }

    #[tokio::test]
    async fn reports_runtime_mode() {
        let config =
            crate::config::parse_test_config(std::path::Path::new("/tmp/moka-server-runtime-test"));
        let state = ApiState::new(config, RuntimeMode::Web);
        let response = runtime(State(state)).await.into_response();
        assert_eq!(response.status(), 200);
    }

    #[tokio::test]
    async fn reports_ready_with_no_project_open() {
        let root = tempfile::tempdir().unwrap();
        let state = ApiState::new(
            crate::config::parse_test_config(root.path()),
            RuntimeMode::Web,
        );
        let response = ready(State(state)).await.into_response();
        assert_eq!(response.status(), 200);
    }

    #[tokio::test]
    async fn reports_not_ready_when_the_registry_is_unwritable() {
        let root = tempfile::tempdir().unwrap();
        let mut config = crate::config::parse_test_config(root.path());
        // A registry path whose parent is a regular file cannot be written.
        let blocker = root.path().join("blocker");
        std::fs::write(&blocker, b"file").unwrap();
        config.projects.recent_registry_path = blocker.join("recent-projects.json");
        let state = ApiState::new(config, RuntimeMode::Web);
        let response = ready(State(state)).await.into_response();
        assert_eq!(response.status(), 503);
    }
}
