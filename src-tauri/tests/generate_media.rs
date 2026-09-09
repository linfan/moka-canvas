//! Loading reference media for a generation, against a project on disk.
//!
//! The rules themselves are unit-tested beside the code; what needs a real
//! store is the part that touches the project: which asset is read, what
//! happens when one is missing, and what a caller is handed back.

use std::path::Path;
use std::sync::Arc;

use moka_canvas::config::{parse_test_config, GenerateConfig};
use moka_canvas::domain::Capability;
use moka_canvas::generate::media::load_inputs;
use moka_canvas::generate::{GenerateInput, GenerateRequest, InputRole};
use moka_canvas::project::store::FsProjectStore;
use moka_canvas::project::{CreateProject, ProjectStore, StagedAsset};
use tempfile::TempDir;

async fn open_project(tmp: &TempDir) -> (Arc<FsProjectStore>, std::path::PathBuf) {
    let config = Arc::new(parse_test_config(tmp.path()));
    let store = Arc::new(FsProjectStore::new(config));
    let root = tmp.path().join("demo-project");
    store
        .create_project(
            &root,
            CreateProject {
                name: "Demo".into(),
            },
        )
        .await
        .expect("the project scaffolds");
    (store, root)
}

/// Stores bytes the way an upload would and returns the asset's identifier.
async fn upload(
    store: &FsProjectStore,
    root: &Path,
    name: &str,
    mime: &str,
    bytes: &[u8],
) -> String {
    let staging = root.join("tmp").join(format!("staged-{name}"));
    std::fs::write(&staging, bytes).expect("the staging directory exists");
    store
        .add_asset(StagedAsset {
            name: name.into(),
            tmp_path: staging,
            declared_mime: Some(mime.into()),
            category_hint: None,
        })
        .await
        .expect("the asset is accepted")
        .entry
        .id
}

fn encoded(format: image::ImageFormat, width: u32, height: u32) -> Vec<u8> {
    let mut bytes = Vec::new();
    image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
        width,
        height,
        image::Rgb([40, 90, 160]),
    ))
    .write_to(&mut std::io::Cursor::new(&mut bytes), format)
    .expect("the format encodes");
    bytes
}

fn request_for(inputs: Vec<GenerateInput>) -> GenerateRequest {
    GenerateRequest {
        capability: Capability::Image,
        prompt: "a lantern over a lake".into(),
        inputs,
        ..GenerateRequest::default()
    }
}

fn reference(asset_id: &str, role: InputRole) -> GenerateInput {
    GenerateInput {
        role,
        asset_id: asset_id.into(),
    }
}

#[tokio::test]
async fn references_come_back_in_the_order_the_request_names_them() {
    let tmp = TempDir::new().unwrap();
    let (store, root) = open_project(&tmp).await;
    let poster = encoded(image::ImageFormat::Png, 2, 2);
    let mask = encoded(image::ImageFormat::Png, 3, 1);
    let poster_id = upload(&store, &root, "poster.png", "image/png", &poster).await;
    let mask_id = upload(&store, &root, "mask.png", "image/png", &mask).await;

    let request = request_for(vec![
        reference(&mask_id, InputRole::Mask),
        reference(&poster_id, InputRole::Reference),
    ]);
    let loaded = load_inputs(store.as_ref(), &request, &GenerateConfig::default())
        .await
        .expect("both assets are in the project");

    // The request's own order, because an adapter relies on position where a
    // role does not tell two inputs apart.
    let ids: Vec<&str> = loaded.iter().map(|input| input.asset_id.as_str()).collect();
    assert_eq!(ids, [mask_id.as_str(), poster_id.as_str()]);
    assert_eq!(loaded[0].role, InputRole::Mask);
    assert_eq!(loaded[0].mime, "image/png");
    assert_eq!(loaded[0].bytes, mask);
    // The display name, which is what a multipart filename is built from; the
    // location on disk stays inside the store.
    assert_eq!(loaded[0].name, "mask.png");
    assert_eq!(loaded[1].bytes, poster);
}

#[tokio::test]
async fn a_format_a_provider_cannot_read_is_converted_on_the_way_out() {
    let tmp = TempDir::new().unwrap();
    let (store, root) = open_project(&tmp).await;
    let tiff = encoded(image::ImageFormat::Tiff, 4, 3);
    let asset_id = upload(&store, &root, "scan.tiff", "image/tiff", &tiff).await;

    let request = request_for(vec![reference(&asset_id, InputRole::Reference)]);
    let loaded = load_inputs(store.as_ref(), &request, &GenerateConfig::default())
        .await
        .expect("the asset is in the project");
    assert_eq!(loaded[0].mime, "image/png");
    assert_ne!(loaded[0].bytes, tiff);
}

#[tokio::test]
async fn an_oversized_reference_is_refused_by_the_ceiling_for_its_family() {
    let tmp = TempDir::new().unwrap();
    let (store, root) = open_project(&tmp).await;
    let poster = encoded(image::ImageFormat::Png, 8, 8);
    let asset_id = upload(&store, &root, "poster.png", "image/png", &poster).await;

    let budgets = GenerateConfig {
        max_image_input_bytes: 4,
        ..GenerateConfig::default()
    };
    let request = request_for(vec![reference(&asset_id, InputRole::Reference)]);
    let error = load_inputs(store.as_ref(), &request, &budgets)
        .await
        .expect_err("four bytes of ceiling cannot hold a png");
    assert_eq!(error.code(), "PROVIDER_BAD_REQUEST");
    assert!(error.to_string().contains("poster.png"), "{error}");
}

#[tokio::test]
async fn a_reference_that_is_not_in_the_project_keeps_the_storage_code() {
    let tmp = TempDir::new().unwrap();
    let (store, _root) = open_project(&tmp).await;
    let request = request_for(vec![reference(
        "asset-that-was-never-added",
        InputRole::Mask,
    )]);
    let error = load_inputs(store.as_ref(), &request, &GenerateConfig::default())
        .await
        .expect_err("nothing is registered under that identifier");
    assert_eq!(error.code(), "NOT_FOUND");
}

#[tokio::test]
async fn a_reference_with_no_project_open_is_not_a_provider_failure() {
    let tmp = TempDir::new().unwrap();
    let store = Arc::new(FsProjectStore::new(Arc::new(parse_test_config(tmp.path()))));
    let request = request_for(vec![reference("asset-1", InputRole::Reference)]);
    let error = load_inputs(store.as_ref(), &request, &GenerateConfig::default())
        .await
        .expect_err("no project is open");
    // The code every other route gives for this, so a client reacts the same
    // way it does to a failed save.
    assert_eq!(error.code(), "PROJECT_NOT_OPEN");
}
