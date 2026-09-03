use std::{net::SocketAddr, path::PathBuf, sync::Mutex};

use anyhow::{ensure, Context, Result};
use axum::{
    extract::State,
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

#[derive(Clone)]
struct AppState {
    mode: String,
}

pub struct LocalServer {
    address: SocketAddr,
    shutdown: Mutex<Option<oneshot::Sender<()>>>,
}

impl LocalServer {
    pub async fn start(static_dir: PathBuf, mode: impl Into<String>) -> Result<Self> {
        Self::start_on(static_dir, 0, mode).await
    }

    pub async fn start_on(static_dir: PathBuf, port: u16, mode: impl Into<String>) -> Result<Self> {
        ensure!(
            static_dir.is_dir(),
            "static directory does not exist: {}",
            static_dir.display()
        );

        let listener = TcpListener::bind(("127.0.0.1", port))
            .await
            .context("failed to bind the local HTTP server")?;
        let address = listener.local_addr()?;
        let (shutdown_sender, shutdown_receiver) = oneshot::channel();
        let router = router(static_dir, mode.into());

        tauri::async_runtime::spawn(async move {
            if let Err(error) = axum::serve(listener, router)
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

fn router(static_dir: PathBuf, mode: String) -> Router {
    let index = static_dir.join("index.html");
    let static_service = ServeDir::new(static_dir).fallback(ServeFile::new(index));

    Router::new()
        .route("/api/health", get(health))
        .route("/api/runtime", get(runtime))
        .fallback_service(static_service)
        .layer(SetResponseHeaderLayer::if_not_present(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .with_state(AppState { mode })
}

async fn health() -> impl IntoResponse {
    Json(json!({ "status": "ok" }))
}

async fn runtime(State(state): State<AppState>) -> impl IntoResponse {
    Json(json!({
        "delivery": "localhost",
        "mode": state.mode,
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
        let response = runtime(State(AppState {
            mode: "test".into(),
        }))
        .await
        .into_response();
        assert_eq!(response.status(), 200);
    }
}
