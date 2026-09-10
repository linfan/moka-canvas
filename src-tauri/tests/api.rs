use axum::body::{to_bytes, Body};
use axum::http::{header, Request, StatusCode};
use moka_canvas::api::ApiState;
use moka_canvas::config::{parse_test_config, AppConfig, RuntimeMode};
use moka_canvas::domain::commands::make_node;
use moka_canvas::domain::NodeKind;
use serde_json::{json, Value};
use std::path::Path;
use tower::ServiceExt;

fn test_app(root: &Path) -> axum::Router {
    moka_canvas::server::router(open_state(parse_test_config(root)))
}

fn open_state(config: AppConfig) -> ApiState {
    let root = config
        .metadata
        .dir
        .clone()
        .expect("the test configuration sets a metadata directory");
    ApiState::new(config, RuntimeMode::Web, &root).expect("the metadata store opens")
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
    assert!(!raw.contains("maxDocumentBytes"));
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
async fn canvas_settings_change_a_part_and_keep_the_rest() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    let created = create_project(&app, &temp.path().join("projects"), "View").await;
    let canvas_id = created["moka"]["canvas"][0]["id"].as_str().unwrap();
    let revision = created["moka"]["metadata"]["revision"].as_i64().unwrap();

    // Only the background is named, so the minimap preference stays where it was.
    let response = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/projects/current/commands",
            json!({
                "expectedRevision": revision,
                "commands": [
                    {
                        "type": "setCanvasSettings",
                        "canvasId": canvas_id,
                        "settings": { "background": "blank" }
                    }
                ]
            }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

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
    let current = body_json(response).await;
    let settings = &current["moka"]["canvas"][0]["settings"];
    assert_eq!(settings["background"], "blank");
    assert_eq!(settings["showMinimap"], true);
    assert_eq!(settings["snapToGrid"], true);

    // A background nothing recognises is refused before it reaches the document.
    let response = app
        .oneshot(json_request(
            "POST",
            "/api/v1/projects/current/commands",
            json!({
                "expectedRevision": revision + 1,
                "commands": [
                    {
                        "type": "setCanvasSettings",
                        "canvasId": canvas_id,
                        "settings": { "background": "stripes" }
                    }
                ]
            }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let problem = body_json(response).await;
    assert_eq!(problem["code"], "VALIDATION_FAILED");
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
async fn an_asset_takes_what_a_reader_says_about_it() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    create_project(&app, &temp.path().join("projects"), "Shelf").await;
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
    let asset_id = body_json(response).await["entry"]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let shelf_uri = format!("/api/v1/projects/current/assets/{asset_id}");

    let response = app
        .clone()
        .oneshot(json_request(
            "PATCH",
            &shelf_uri,
            json!({
                "tags": ["lake", "dusk"],
                "note": "Kept for the opening shot.",
                "favorite": true,
                "keyword": "A lantern floats over a quiet lake at dusk.",
            }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let change = body_json(response).await;
    let entry = &change["entry"];
    assert_eq!(entry["tags"][0], "lake");
    assert_eq!(entry["tags"][1], "dusk");
    assert_eq!(entry["note"], "Kept for the opening shot.");
    assert_eq!(entry["favorite"], true);
    assert_eq!(
        entry["keyword"],
        "A lantern floats over a quiet lake at dusk."
    );
    assert_eq!(entry["origin"], "brought");
    assert!(change["revision"].is_number());

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(shelf_uri.clone())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    assert_eq!(&bytes[..], &png[..]);

    let response = app
        .clone()
        .oneshot(json_request(
            "PATCH",
            &shelf_uri,
            json!({ "note": "x".repeat(2001) }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body_json(response).await["code"], "VALIDATION_FAILED");

    let response = app
        .oneshot(json_request(
            "PATCH",
            "/api/v1/projects/current/assets/no-such-asset",
            json!({ "note": "said of something not on the shelf" }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_text_node_is_filed_once_and_its_words_come_back() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    let created = create_project(&app, &temp.path().join("projects"), "Filed").await;
    let canvas_id = created["moka"]["canvas"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    let revision = created["moka"]["metadata"]["revision"].as_i64().unwrap();

    let mut node = make_node(NodeKind::Text, "Filed line".into(), 0.0, 0.0);
    node.data.content = Some("Filed from the document.".into());
    let node_id = node.id.clone();

    let response = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/projects/current/commands",
            json!({
                "expectedRevision": revision,
                "commands": [
                    {
                        "type": "addNode",
                        "canvasId": canvas_id.clone(),
                        "node": serde_json::to_value(&node).unwrap(),
                    }
                ]
            }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let filed = json!({ "canvasId": canvas_id.clone(), "nodeId": node_id.clone() });
    let response = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/projects/current/assets/from-node",
            filed.clone(),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let body = body_json(response).await;
    assert_eq!(body["created"], true);
    let entry = &body["entry"];
    assert_eq!(entry["origin"], "filed");
    assert_eq!(entry["favorite"], true);
    assert_eq!(entry["name"], "Filed line.md");
    assert_eq!(entry["mime"], "text/markdown");
    assert_eq!(entry["provenance"]["operationNodeId"], node_id);
    assert!(entry["path"].as_str().unwrap().starts_with("assets/texts/"));
    let asset_id = entry["id"].as_str().unwrap().to_string();

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
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    assert_eq!(&bytes[..], b"Filed from the document.");

    // Filing the same words from the same node answers with the entry it made
    // the first time rather than a second copy of it.
    let response = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/projects/current/assets/from-node",
            filed,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let again = body_json(response).await;
    assert_eq!(again["created"], false);
    assert_eq!(again["entry"]["id"], asset_id);

    let response = app
        .oneshot(json_request(
            "POST",
            "/api/v1/projects/current/assets/from-node",
            json!({ "canvasId": canvas_id, "nodeId": "no-such-node" }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(body_json(response).await["code"], "NOT_FOUND");
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

#[tokio::test]
async fn readiness_reports_metadata_and_config_checks() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/ready")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = body_json(response).await;
    assert_eq!(body["status"], "ready");
    assert_eq!(body["checks"]["config"], true);
    assert_eq!(body["checks"]["metadata"], true);
    assert_eq!(body["checks"]["projectDirectory"], true);
}

#[tokio::test]
async fn api_responses_carry_request_ids_and_problem_codes() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let request_id = response
        .headers()
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .expect("x-request-id header");
    assert_eq!(request_id.len(), 12);
    assert!(request_id.chars().all(|c| c.is_ascii_hexdigit()));

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
    assert_eq!(response.headers().get("x-request-id").unwrap().len(), 12);
    assert_eq!(
        response.headers().get("x-error-code").unwrap(),
        "PROJECT_NOT_OPEN"
    );
}

#[tokio::test]
async fn a_picture_tool_answers_with_what_it_filed_and_not_with_the_picture() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    create_project(&app, &temp.path().join("projects"), "Tools").await;

    let response = app
        .clone()
        .oneshot(multipart_request(
            "/api/v1/projects/current/assets",
            ("lake.png", &make_test_png()),
            &[],
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let subject = body_json(response).await["entry"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let response = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/projects/current/tools",
            json!({
                "tool": "crop",
                "assetId": subject,
                "params": { "region": { "x": 4, "y": 4, "width": 32, "height": 16 } },
            }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let report = body_json(response).await;
    assert!(report["revision"].is_number());
    let entries = report["entries"].as_array().expect("what was filed");
    assert_eq!(entries.len(), 1);
    let made = &entries[0];
    // Named the way an imported picture is: the registry reads an ending off a
    // name to decide how to store the file, so one without it would leave this
    // the only picture in the project whose name does not say what it is.
    assert_eq!(made["name"], "lake-32x16.png");
    assert_eq!(made["probe"]["width"], 32);
    assert_eq!(made["probe"]["height"], 16);
    // Nothing was asked of anybody, so there is no run behind this and nothing
    // for it to have come with.
    assert!(report.get("prompt").is_none());
    assert_eq!(made["provenance"]["runId"], Value::Null);
    assert_eq!(made["provenance"]["operationNodeId"], Value::Null);
    assert_eq!(made["provenance"]["inputAssetIds"], json!([subject]));
    assert_eq!(
        made["provenance"]["parameterSnapshot"]["tool"],
        json!("crop")
    );

    // The answer names the asset rather than carrying it, so the picture is
    // asked for the way any other asset in the project is.
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/v1/projects/current/assets/{}",
                    made["id"].as_str().unwrap()
                ))
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
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    assert!(!bytes.is_empty(), "the result is a picture, not a promise");
}

#[tokio::test]
async fn a_picture_tool_that_cannot_be_done_is_refused_as_a_problem() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    create_project(&app, &temp.path().join("projects"), "Tools").await;

    let response = app
        .clone()
        .oneshot(multipart_request(
            "/api/v1/projects/current/assets",
            ("lake.png", &make_test_png()),
            &[],
        ))
        .await
        .unwrap();
    let picture = body_json(response).await["entry"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    let response = app
        .clone()
        .oneshot(multipart_request(
            "/api/v1/projects/current/assets",
            ("note.txt", b"a sentence, which has no picture in it"),
            &[],
        ))
        .await
        .unwrap();
    let words = body_json(response).await["entry"]["id"]
        .as_str()
        .unwrap()
        .to_string();

    // A tool nobody has is not guessed at, and the refusal names what was asked
    // for so a reader can see which word was the problem.
    let response = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/projects/current/tools",
            json!({ "tool": "prettify", "assetId": picture }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        response.headers().get("x-error-code").unwrap(),
        "VALIDATION_FAILED"
    );
    let problem = body_json(response).await;
    assert_eq!(problem["code"], "VALIDATION_FAILED");
    assert!(
        problem["message"].as_str().unwrap().contains("prettify"),
        "{problem}"
    );

    // A field this tool does not have is refused rather than quietly dropped,
    // because dropping it would answer a different question and call it this one.
    let response = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/projects/current/tools",
            json!({
                "tool": "crop",
                "assetId": picture,
                "params": { "region": { "x": 0, "y": 0, "width": 8, "height": 8 }, "sharpen": true },
            }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        body_json(response).await["code"],
        Value::String("VALIDATION_FAILED".into())
    );

    // A subject with no picture in it is a different refusal from a bad ask:
    // the ask was fine, the thing it was pointed at cannot be worked on.
    let response = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/projects/current/tools",
            json!({
                "tool": "crop",
                "assetId": words,
                "params": { "ratio": "1:1" },
            }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    assert_eq!(
        response.headers().get("x-error-code").unwrap(),
        "UNSUPPORTED_MEDIA_TYPE"
    );

    // And a subject the project does not hold is simply not there.
    let response = app
        .oneshot(json_request(
            "POST",
            "/api/v1/projects/current/tools",
            json!({
                "tool": "crop",
                "assetId": "asset-nobody-has",
                "params": { "ratio": "1:1" },
            }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}
