use axum::body::{to_bytes, Body};
use axum::http::{header, Request, StatusCode};
use moka_canvas::api::ApiState;
use moka_canvas::config::{parse_test_config, AppConfig, RuntimeMode};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tower::ServiceExt;

fn test_app(root: &Path) -> axum::Router {
    moka_canvas::server::router(open_state(parse_test_config(root)))
}

fn test_app_with(root: &Path, tweak: impl FnOnce(&mut AppConfig)) -> axum::Router {
    let mut config = parse_test_config(root);
    tweak(&mut config);
    moka_canvas::server::router(open_state(config))
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

fn multipart_request(uri: &str, file_field: (&str, &[u8])) -> Request<Body> {
    let boundary = "X-MOKA-TEST-BOUNDARY";
    let (filename, bytes) = file_field;
    let mut body = Vec::new();
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

async fn export_open_project(app: &axum::Router, payload: Value) -> Value {
    let response = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/projects/current/export",
            payload,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    body_json(response).await
}

async fn try_import(app: &axum::Router, archive: &Path, directory: &Path) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/projects/import",
            json!({
                "archivePath": archive.to_string_lossy(),
                "directory": directory.to_string_lossy(),
            }),
        ))
        .await
        .unwrap();
    let status = response.status();
    let body = body_json(response).await;
    (status, body)
}

fn read_zip_entries(path: &Path) -> Vec<(String, Vec<u8>)> {
    let file = std::fs::File::open(path).unwrap();
    let mut archive = zip::ZipArchive::new(file).unwrap();
    let mut entries = Vec::new();
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).unwrap();
        if entry.is_dir() {
            continue;
        }
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes).unwrap();
        entries.push((entry.name().replace('\\', "/"), bytes));
    }
    entries
}

fn write_zip(path: &Path, entries: &[(String, Vec<u8>)]) {
    let file = std::fs::File::create(path).unwrap();
    let mut writer = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for (name, bytes) in entries {
        writer.start_file(name, options).unwrap();
        writer.write_all(bytes).unwrap();
    }
    writer.finish().unwrap();
}

/// A failed import must not leave a target directory or staging tree behind.
fn assert_import_left_no_trace(directory: &Path, target_name: &str) {
    assert!(
        !directory.join(target_name).exists(),
        "target directory must not exist after a rejected import"
    );
    if directory.exists() {
        for entry in std::fs::read_dir(directory).unwrap() {
            let name = entry.unwrap().file_name().to_string_lossy().into_owned();
            assert!(
                !name.starts_with(".moka-import-"),
                "staging directory leaked: {name}"
            );
        }
    }
}

/// Builds a valid exported package of a project holding one image asset.
async fn stage_valid_package(root: &Path) -> (axum::Router, PathBuf) {
    let app = test_app(root);
    create_project(&app, &root.join("projects"), "Pack").await;
    let response = app
        .clone()
        .oneshot(multipart_request(
            "/api/v1/projects/current/assets",
            ("lake.png", &make_test_png()),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let report = export_open_project(&app, json!({})).await;
    let destination = PathBuf::from(report["destination"].as_str().unwrap());
    assert!(destination.is_file());
    (app, destination)
}

#[tokio::test]
async fn import_rejects_a_non_zip_file() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    let archive = temp.path().join("not-a-package.zip");
    std::fs::write(&archive, b"this is not a zip archive").unwrap();

    let imports = temp.path().join("imports");
    let (status, body) = try_import(&app, &archive, &imports).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["code"], "PACKAGE_INVALID");
    assert_import_left_no_trace(&imports, "not-a-package");
}

#[tokio::test]
async fn import_rejects_entries_that_escape_the_target() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());

    for (label, evil_name) in [("dotdot", "../evil.txt"), ("absolute", "/abs/evil.txt")] {
        let archive = temp.path().join(format!("slip-{label}.zip"));
        write_zip(
            &archive,
            &[
                (evil_name.to_string(), b"pwned".to_vec()),
                ("canvas.moka".to_string(), b"placeholder".to_vec()),
            ],
        );
        let imports = temp.path().join(format!("imports-{label}"));
        let (status, body) = try_import(&app, &archive, &imports).await;
        assert_eq!(
            status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{label} entry must be rejected"
        );
        assert_eq!(body["code"], "PACKAGE_INVALID");
        assert!(
            !temp.path().join("evil.txt").exists(),
            "zip-slip entry must not be written outside the target"
        );
        assert!(
            !Path::new("/abs/evil.txt").exists(),
            "absolute entry must not be written"
        );
        assert_import_left_no_trace(&imports, &format!("slip-{label}"));
    }
}

#[tokio::test]
async fn import_rejects_entries_that_fail_manifest_verification() {
    let temp = tempfile::tempdir().unwrap();
    let (app, valid) = stage_valid_package(temp.path()).await;

    let mut entries = read_zip_entries(&valid);
    let asset = entries
        .iter_mut()
        .find(|(name, _)| name.starts_with("assets/"))
        .expect("package holds an asset");
    asset.1.extend_from_slice(b"tampered");

    let tampered = temp.path().join("tampered.zip");
    write_zip(&tampered, &entries);

    let imports = temp.path().join("imports");
    let (status, body) = try_import(&app, &tampered, &imports).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["code"], "PACKAGE_INVALID");
    assert!(
        body["message"]
            .as_str()
            .unwrap()
            .contains("failed verification"),
        "unexpected message: {}",
        body["message"]
    );
    assert_import_left_no_trace(&imports, "tampered");
}

#[tokio::test]
async fn import_rejects_a_package_without_manifest() {
    let temp = tempfile::tempdir().unwrap();
    let (app, valid) = stage_valid_package(temp.path()).await;

    let entries: Vec<(String, Vec<u8>)> = read_zip_entries(&valid)
        .into_iter()
        .filter(|(name, _)| name != "moka-package.json")
        .collect();
    let no_manifest = temp.path().join("no-manifest.zip");
    write_zip(&no_manifest, &entries);

    let imports = temp.path().join("imports");
    let (status, body) = try_import(&app, &no_manifest, &imports).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["code"], "PACKAGE_INVALID");
    assert!(
        body["message"].as_str().unwrap().contains("manifest"),
        "unexpected message: {}",
        body["message"]
    );
    assert_import_left_no_trace(&imports, "no-manifest");
}

#[tokio::test]
async fn import_rejects_an_unsupported_format_version() {
    let temp = tempfile::tempdir().unwrap();
    let (app, valid) = stage_valid_package(temp.path()).await;

    let mut entries = read_zip_entries(&valid);
    let manifest = entries
        .iter_mut()
        .find(|(name, _)| name == "moka-package.json")
        .expect("package holds a manifest");
    let mut parsed: Value = serde_json::from_slice(&manifest.1).unwrap();
    parsed["formatVersion"] = json!(999);
    manifest.1 = serde_json::to_vec_pretty(&parsed).unwrap();

    let future = temp.path().join("future.zip");
    write_zip(&future, &entries);

    let imports = temp.path().join("imports");
    let (status, body) = try_import(&app, &future, &imports).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["code"], "MOKA_VERSION_UNSUPPORTED");
    assert_import_left_no_trace(&imports, "future");
}

#[tokio::test]
async fn import_rejects_packages_beyond_the_configured_limits() {
    let source = tempfile::tempdir().unwrap();
    let (app, valid) = stage_valid_package(source.path()).await;
    drop(app);

    // Entry-count limit.
    let temp = tempfile::tempdir().unwrap();
    let app = test_app_with(temp.path(), |config| {
        config.limits.max_package_entries = 1;
    });
    let imports = temp.path().join("imports");
    let (status, body) = try_import(&app, &valid, &imports).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(body["code"], "PAYLOAD_TOO_LARGE");
    assert_import_left_no_trace(&imports, valid.file_stem().unwrap().to_str().unwrap());

    // Byte limit: every real entry exceeds a 64-byte ceiling.
    let temp = tempfile::tempdir().unwrap();
    let app = test_app_with(temp.path(), |config| {
        config.limits.max_package_bytes = 64;
    });
    let imports = temp.path().join("imports");
    let (status, body) = try_import(&app, &valid, &imports).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(body["code"], "PAYLOAD_TOO_LARGE");
    assert_import_left_no_trace(&imports, valid.file_stem().unwrap().to_str().unwrap());
}

#[tokio::test]
async fn import_conflicts_when_the_target_directory_is_not_empty() {
    let temp = tempfile::tempdir().unwrap();
    let (app, valid) = stage_valid_package(temp.path()).await;

    let imports = temp.path().join("imports");
    std::fs::create_dir_all(&imports).unwrap();
    let (status, _) = try_import(&app, &valid, &imports).await;
    assert_eq!(status, StatusCode::CREATED);

    let (status, body) = try_import(&app, &valid, &imports).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["code"], "CONFLICT");
}

#[tokio::test]
async fn export_blocks_missing_assets_until_explicitly_allowed() {
    let temp = tempfile::tempdir().unwrap();
    let app = test_app(temp.path());
    let created = create_project(&app, &temp.path().join("projects"), "Gone").await;
    let root = PathBuf::from(created["root"].as_str().unwrap());

    let response = app
        .clone()
        .oneshot(multipart_request(
            "/api/v1/projects/current/assets",
            ("gone.png", &make_test_png()),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let change = body_json(response).await;
    let asset_path = change["entry"]["path"].as_str().unwrap().to_string();
    std::fs::remove_file(root.join(&asset_path)).unwrap();

    // Default: refuse to export an incomplete project.
    let response = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/projects/current/export",
            json!({}),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(body_json(response).await["code"], "ASSET_MISSING");

    // Explicit opt-in exports with the manifest flagged incomplete.
    let report = export_open_project(&app, json!({ "allowIncomplete": true })).await;
    assert_eq!(report["incomplete"], true);
    let destination = PathBuf::from(report["destination"].as_str().unwrap());
    let entries = read_zip_entries(&destination);
    assert!(
        entries
            .iter()
            .all(|(name, _)| !name.starts_with("tmp/") && name != &asset_path),
        "temporary files and the missing asset must be excluded"
    );
    let manifest = entries
        .iter()
        .find(|(name, _)| name == "moka-package.json")
        .expect("export carries a manifest");
    let manifest: Value = serde_json::from_slice(&manifest.1).unwrap();
    assert_eq!(manifest["incomplete"], true);
}
