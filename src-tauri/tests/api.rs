use axum::body::{to_bytes, Body};
use axum::http::{header, Request, StatusCode};
use moka_canvas::api::ApiState;
use moka_canvas::config::{parse_test_config, RuntimeMode};
use serde_json::{json, Value};
use std::path::Path;
use tower::ServiceExt;

fn test_app(root: &Path) -> axum::Router {
    let config = parse_test_config(root);
    let state = ApiState::new(config, RuntimeMode::Web);
    moka_canvas::server::router(state)
}

async fn body_json(response: axum::http::Response<Body>) -> Value {
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    serde_json::from_slice(&bytes).expect("response body must be JSON")
}

fn json_request(method: &str, uri: &str, payload: Value) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(serde_json::to_vec(&payload).unwrap()))
        .unwrap()
}

fn multipart_request(
    uri: &str,
    file_field: (&str, &[u8]),
    text_fields: &[(&str, &str)],
) -> Request<Body> {
    let boundary = "X-MOKA-TEST-BOUNDARY";
    let mut body = Vec::new();
    for (name, value) in text_fields {
        body.extend_from_slice(
            format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n")
                .as_bytes(),
        );
    }
    let (filename, bytes) = file_field;
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: application/octet-stream\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    Request::builder()
        .method("POST")
        .uri(uri)
        .header(
            header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(Body::from(body))
        .unwrap()
}

fn make_test_png() -> Vec<u8> {
    let mut png = image::RgbaImage::new(64, 64);
    for pixel in png.pixels_mut() {
        *pixel = image::Rgba([200, 120, 60, 255]);
    }
    let mut bytes = Vec::new();
    image::DynamicImage::ImageRgba8(png)
        .write_to(
            &mut std::io::Cursor::new(&mut bytes),
            image::ImageFormat::Png,
        )
        .unwrap();
    bytes
}

async fn create_project(app: &axum::Router, directory: &Path, name: &str) -> Value {
    let response = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/projects",
            json!({
                "directory": directory.to_string_lossy(),
                "name": name,
            }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    body_json(response).await
}

#[tokio::test]
async fn config_is_sanitized() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/config")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let raw = String::from_utf8(bytes.to_vec()).unwrap();
    let body: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(body["productName"], "Moka Canvas");
    assert_eq!(body["capabilities"]["mode"], "web");
    assert!(body["capabilities"]["assetCategories"].is_array());
    assert!(body["limits"]["maxNodesPerCanvas"].is_number());
    // Server internals and filesystem paths must never leak.
    assert!(!raw.contains("recentRegistryPath"));
    assert!(!raw.contains("staticDir"));
    assert!(!raw.contains("bind"));
    assert!(!raw.contains(temp.path().to_string_lossy().as_ref()));
}

#[tokio::test]
async fn current_project_is_a_problem_when_nothing_is_open() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/projects/current")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert_eq!(
        response.headers().get(header::CONTENT_TYPE).unwrap(),
        "application/problem+json"
    );
    let body = body_json(response).await;
    assert_eq!(body["code"], "PROJECT_NOT_OPEN");
    assert_eq!(body["status"], 409);
}

#[tokio::test]
async fn create_open_and_recent_flow() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    let projects_dir = temp.path().join("projects");

    let created = create_project(&app, &projects_dir, "My Film").await;
    assert_eq!(created["moka"]["metadata"]["name"], "My Film");
    assert!(created["root"].as_str().unwrap().ends_with("my-film"));
    assert_eq!(created["selfCheck"]["ok"], true);
    let root = created["root"].as_str().unwrap().to_string();
    assert!(Path::new(&root).join("canvas.moka").is_file());

    // The created project is now current.
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/projects/current")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let current = body_json(response).await;
    assert_eq!(current["root"], json!(root));

    // Recent registry picked it up and can forget it again.
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/recent-projects")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let recent = body_json(response).await;
    assert_eq!(recent.as_array().unwrap().len(), 1);
    let recent_id = recent[0]["id"].as_str().unwrap().to_string();
    assert_eq!(recent[0]["name"], "My Film");

    // Reopening by path is idempotent and keeps one recent entry.
    let response = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/projects/open",
            json!({ "path": root }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/api/v1/recent-projects/{recent_id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/recent-projects")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(body_json(response).await.as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn commands_apply_and_revision_conflicts_surface() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    let created = create_project(&app, &temp.path().join("projects"), "Cmd").await;
    let canvas_id = created["moka"]["canvas"][0]["id"].as_str().unwrap();
    let revision = created["moka"]["metadata"]["revision"].as_i64().unwrap();

    let rename = json!({
        "expectedRevision": revision,
        "commands": [
            { "type": "renameCanvas", "canvasId": canvas_id, "name": "Storyboard" }
        ]
    });
    let response = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/projects/current/commands",
            rename.clone(),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let saved = body_json(response).await;
    assert_eq!(saved["revision"], revision + 1);

    // Replaying with the stale revision is a 409 conflict.
    let response = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/projects/current/commands",
            rename,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let problem = body_json(response).await;
    assert_eq!(problem["code"], "REVISION_CONFLICT");

    // An invalid command is rejected with a problem body.
    let response = app
        .oneshot(json_request(
            "POST",
            "/api/v1/projects/current/commands",
            json!({
                "expectedRevision": revision + 1,
                "commands": [
                    { "type": "renameCanvas", "canvasId": "missing", "name": "Nope" }
                ]
            }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let problem = body_json(response).await;
    assert_eq!(problem["code"], "CANVAS_NOT_FOUND");
}

#[tokio::test]
async fn asset_upload_stream_range_and_delete() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    create_project(&app, &temp.path().join("projects"), "Assets").await;
    let png = make_test_png();

    let response = app
        .clone()
        .oneshot(multipart_request(
            "/api/v1/projects/current/assets",
            ("lake.png", &png),
            &[],
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let change = body_json(response).await;
    assert!(change["revision"].is_number());
    let entry = &change["entry"];
    assert_eq!(entry["mime"], "image/png");
    assert_eq!(entry["probe"]["width"], 64);
    let asset_id = entry["id"].as_str().unwrap().to_string();

    // Full download.
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/projects/current/assets/{asset_id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get(header::CONTENT_TYPE).unwrap(),
        "image/png"
    );
    assert_eq!(
        response.headers().get(header::ACCEPT_RANGES).unwrap(),
        "bytes"
    );
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    assert_eq!(&bytes[..], &png[..]);

    // Ranged download.
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/projects/current/assets/{asset_id}"))
                .header(header::RANGE, "bytes=0-9")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(
        response.headers().get(header::CONTENT_RANGE).unwrap(),
        &format!("bytes 0-9/{}", png.len())
    );
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    assert_eq!(&bytes[..], &png[..10]);

    // Delete and confirm the asset is gone.
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/api/v1/projects/current/assets/{asset_id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let deleted = body_json(response).await;
    assert!(deleted["revision"].is_number());
    let response = app
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/projects/current/assets/{asset_id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn reveal_unknown_asset_is_not_found() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    create_project(&app, &temp.path().join("projects"), "Reveal").await;

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/projects/current/assets/nope/reveal")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn export_then_import_roundtrip() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    create_project(&app, &temp.path().join("projects"), "Pack").await;
    let png = make_test_png();
    let response = app
        .clone()
        .oneshot(multipart_request(
            "/api/v1/projects/current/assets",
            ("lake.png", &png),
            &[],
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);

    let response = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/projects/current/export",
            json!({}),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let report = body_json(response).await;
    let destination = report["destination"].as_str().unwrap().to_string();
    assert!(Path::new(&destination).is_file());
    assert!(report["entries"].as_u64().unwrap() >= 2);
    assert_eq!(report["incomplete"], false);

    let imports_dir = temp.path().join("imports");
    std::fs::create_dir_all(&imports_dir).unwrap();
    let response = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/projects/import",
            json!({
                "archivePath": destination,
                "directory": imports_dir.to_string_lossy(),
            }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let opened = body_json(response).await;
    assert_eq!(opened["moka"]["metadata"]["name"], "Pack");
    let imported_root = opened["root"].as_str().unwrap();
    assert!(Path::new(imported_root).join("canvas.moka").is_file());

    // Runs endpoint serves the (empty) run history of the open project.
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/projects/current/runs")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body_json(response).await.as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn malformed_json_is_a_problem() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/projects")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from("{not json"))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let problem = body_json(response).await;
    assert_eq!(problem["code"], "VALIDATION_FAILED");
}
