use std::{net::SocketAddr, sync::Mutex};

use anyhow::{ensure, Context, Result};
use axum::{
    extract::{DefaultBodyLimit, State},
    http::{header, HeaderValue},
    response::IntoResponse,
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
        .route("/api/runtime", get(runtime))
        .merge(crate::api::router())
        .fallback_service(static_service)
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
}
