use moka_canvas::config::{parse_test_config, AppConfig};
use moka_canvas::domain::commands::{apply_commands, make_node};
use moka_canvas::domain::{new_id, DocumentCommand, NodeKind, PointValue};
use moka_canvas::project::store::FsProjectStore;
use moka_canvas::project::{CreateProject, ProjectStore, StagedAsset};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tempfile::TempDir;

fn test_config(root: &Path) -> AppConfig {
    parse_test_config(root)
}

fn scaffold_ok(root: &Path) {
    assert!(root.join("canvas.moka").is_file());
    for category in ["images", "music", "voice", "texts", "videos"] {
        assert!(root.join("assets").join(category).is_dir(), "{category}");
    }
    assert!(root.join("output").is_dir());
    assert!(root.join("history/runs").is_dir());
    assert!(root.join("tmp").is_dir());
}

async fn create_store(tmp: &TempDir) -> (Arc<FsProjectStore>, PathBuf) {
    let config = Arc::new(test_config(tmp.path()));
    let store = Arc::new(FsProjectStore::new(config));
    let project_root = tmp.path().join("demo-project");
    store
        .create_project(
            &project_root,
            CreateProject {
                name: "Demo".into(),
            },
        )
        .await
        .unwrap();
    (store, project_root)
}

#[tokio::test]
async fn create_scaffolds_the_project_tree_and_reopen_is_idempotent() {
    let tmp = TempDir::new().unwrap();
    let (store, root) = create_store(&tmp).await;
    scaffold_ok(&root);

    // Opening the directory again keeps the same project identity.
    let first = store.current().await.unwrap().unwrap();
    let reopened = store
        .create_project(
            &root,
            CreateProject {
                name: "Ignored".into(),
            },
        )
        .await
        .unwrap();
    assert_eq!(reopened.moka.metadata.id, first.moka.metadata.id);
    assert_eq!(reopened.moka.metadata.name, "Demo");
}

#[tokio::test]
async fn canvas_moka_round_trips_through_disk() {
    let tmp = TempDir::new().unwrap();
    let (store, root) = create_store(&tmp).await;
    let current = store.current().await.unwrap().unwrap();
    let canvas_id = current.moka.canvas[0].id.clone();
    let node = make_node(NodeKind::Text, "Note".into(), 10.0, 20.0);

    let saved = store
        .apply_commands(
            0,
            vec![DocumentCommand::AddNode {
                canvas_id: canvas_id.clone(),
                node: node.clone(),
            }],
        )
        .await
        .unwrap();
    assert_eq!(saved.revision, 1);

    // Re-open from disk and verify the node survived.
    let reopened = store.open_project(&root).await.unwrap();
    assert_eq!(reopened.moka.canvas[0].nodes.len(), 1);
    assert_eq!(reopened.moka.canvas[0].nodes[0].id, node.id);
    assert_eq!(reopened.moka.metadata.revision, 1);
}

#[tokio::test]
async fn stale_revision_is_rejected() {
    let tmp = TempDir::new().unwrap();
    let (store, _root) = create_store(&tmp).await;
    let current = store.current().await.unwrap().unwrap();
    let canvas_id = current.moka.canvas[0].id.clone();
    let node = make_node(NodeKind::Text, "Note".into(), 0.0, 0.0);
    let result = store
        .apply_commands(41, vec![DocumentCommand::AddNode { canvas_id, node }])
        .await;
    assert_eq!(result.unwrap_err().code(), "REVISION_CONFLICT");
}

#[tokio::test]
async fn external_edit_is_detected_as_conflict() {
    let tmp = TempDir::new().unwrap();
    let (store, root) = create_store(&tmp).await;
    let current = store.current().await.unwrap().unwrap();
    let canvas_id = current.moka.canvas[0].id.clone();

    // Simulate another process rewriting canvas.moka.
    std::thread::sleep(std::time::Duration::from_millis(50));
    let moka_path = root.join("canvas.moka");
    let bytes = std::fs::read(&moka_path).unwrap();
    std::fs::write(&moka_path, &bytes).unwrap();

    let node = make_node(NodeKind::Text, "Note".into(), 0.0, 0.0);
    let result = store
        .apply_commands(0, vec![DocumentCommand::AddNode { canvas_id, node }])
        .await;
    assert_eq!(result.unwrap_err().code(), "REVISION_CONFLICT");
}

#[tokio::test]
async fn apply_commands_validates_edges() {
    let tmp = TempDir::new().unwrap();
    let (store, _root) = create_store(&tmp).await;
    let current = store.current().await.unwrap().unwrap();
    let canvas_id = current.moka.canvas[0].id.clone();
    let text = make_node(NodeKind::Text, "A".into(), 0.0, 0.0);
    let image = make_node(NodeKind::Image, "B".into(), 300.0, 0.0);

    store
        .apply_commands(
            0,
            vec![
                DocumentCommand::AddNode {
                    canvas_id: canvas_id.clone(),
                    node: text.clone(),
                },
                DocumentCommand::AddNode {
                    canvas_id: canvas_id.clone(),
                    node: image.clone(),
                },
            ],
        )
        .await
        .unwrap();

    // text.out → image.out is not a valid edge (output to output).
    let result = store
        .apply_commands(
            1,
            vec![DocumentCommand::AddEdge {
                canvas_id: canvas_id.clone(),
                edge: moka_canvas::domain::WorkflowEdge {
                    id: new_id(),
                    source: moka_canvas::domain::EdgeEndpoint {
                        node_id: text.id.clone(),
                        port_id: "out".into(),
                    },
                    target: moka_canvas::domain::EdgeEndpoint {
                        node_id: image.id.clone(),
                        port_id: "out".into(),
                    },
                    created_at: moka_canvas::domain::now_iso(),
                },
            }],
        )
        .await;
    assert_eq!(result.unwrap_err().code(), "PORT_TYPE_MISMATCH");
}

#[tokio::test]
async fn move_nodes_round_trip_with_inverse() {
    let tmp = TempDir::new().unwrap();
    let (store, _root) = create_store(&tmp).await;
    let current = store.current().await.unwrap().unwrap();
    let canvas_id = current.moka.canvas[0].id.clone();
    let node = make_node(NodeKind::Text, "Draggable".into(), 5.0, 6.0);
    store
        .apply_commands(
            0,
            vec![DocumentCommand::AddNode {
                canvas_id: canvas_id.clone(),
                node: node.clone(),
            }],
        )
        .await
        .unwrap();

    let mut positions = BTreeMap::new();
    positions.insert(node.id.clone(), PointValue { x: 100.0, y: 200.0 });
    store
        .apply_commands(
            1,
            vec![DocumentCommand::MoveNodes {
                canvas_id: canvas_id.clone(),
                positions,
            }],
        )
        .await
        .unwrap();

    let after = store.current().await.unwrap().unwrap();
    let moved = &after.moka.canvas[0].nodes[0];
    assert_eq!((moved.bounds.x, moved.bounds.y), (100.0, 200.0));
}

#[tokio::test]
async fn asset_upload_registers_and_streams_back() {
    let tmp = TempDir::new().unwrap();
    let (store, root) = create_store(&tmp).await;

    // A real 64x64 PNG so the probe records dimensions.
    let png = make_test_png();
    let staging = root.join("tmp").join("upload-test.bin");
    std::fs::write(&staging, &png).unwrap();

    let entry = store
        .add_asset(StagedAsset {
            name: "pixel.png".into(),
            tmp_path: staging,
            declared_mime: Some("image/png".into()),
            category_hint: None,
        })
        .await
        .unwrap();
    assert_eq!(entry.mime.as_deref(), Some("image/png"));
    assert!(entry.path.starts_with("assets/images/"));
    assert!(root.join(&entry.path).is_file());
    assert_eq!(entry.probe.as_ref().unwrap().width, Some(64));

    let file = store.asset_file(&entry.id, None).await.unwrap();
    assert!(file.path.is_file());

    // Registry persisted: reopen and verify the entry survives.
    let reopened = store.open_project(&root).await.unwrap();
    assert_eq!(reopened.moka.resources.images.len(), 1);
    assert!(reopened.self_check.ok);
}

#[tokio::test]
async fn invalid_upload_leaves_no_orphans() {
    let tmp = TempDir::new().unwrap();
    let (store, root) = create_store(&tmp).await;
    let staging = root.join("tmp").join("upload-empty.bin");
    std::fs::write(&staging, b"").unwrap();
    let result = store
        .add_asset(StagedAsset {
            name: "empty.png".into(),
            tmp_path: staging,
            declared_mime: Some("image/png".into()),
            category_hint: None,
        })
        .await;
    assert_eq!(result.unwrap_err().code(), "ASSET_INVALID");
    assert!(store
        .current()
        .await
        .unwrap()
        .unwrap()
        .moka
        .resources
        .images
        .is_empty());
    let orphans = std::fs::read_dir(root.join("assets/images"))
        .unwrap()
        .count();
    assert_eq!(orphans, 0);
}

#[tokio::test]
async fn removing_a_referenced_asset_is_rejected() {
    let tmp = TempDir::new().unwrap();
    let (store, root) = create_store(&tmp).await;
    let png = make_test_png();
    let staging = root.join("tmp").join("upload-ref.bin");
    std::fs::write(&staging, &png).unwrap();
    let entry = store
        .add_asset(StagedAsset {
            name: "ref.png".into(),
            tmp_path: staging,
            declared_mime: None,
            category_hint: None,
        })
        .await
        .unwrap();

    let current = store.current().await.unwrap().unwrap();
    let canvas_id = current.moka.canvas[0].id.clone();
    let mut node = make_node(NodeKind::Image, "Uses asset".into(), 0.0, 0.0);
    node.data.asset_id = Some(entry.id.clone());
    store
        .apply_commands(1, vec![DocumentCommand::AddNode { canvas_id, node }])
        .await
        .unwrap();

    let result = store.remove_asset(&entry.id).await;
    assert_eq!(result.unwrap_err().code(), "ASSET_IN_USE");
}

#[tokio::test]
async fn self_check_reports_missing_and_changed_files() {
    let tmp = TempDir::new().unwrap();
    let (store, root) = create_store(&tmp).await;
    let png = make_test_png();
    let staging = root.join("tmp").join("upload-missing.bin");
    std::fs::write(&staging, &png).unwrap();
    let entry = store
        .add_asset(StagedAsset {
            name: "gone.png".into(),
            tmp_path: staging,
            declared_mime: None,
            category_hint: None,
        })
        .await
        .unwrap();

    // Delete the file externally; reopening must surface the exact path.
    std::fs::remove_file(root.join(&entry.path)).unwrap();
    let reopened = store.open_project(&root).await.unwrap();
    assert!(!reopened.self_check.ok);
    assert_eq!(reopened.self_check.issues.len(), 1);
    assert_eq!(reopened.self_check.issues[0].expected_path, entry.path);
    assert_eq!(
        reopened.self_check.issues[0].reason,
        moka_canvas::domain::SelfCheckReason::Missing
    );

    // Restore with different bytes: reported as changed.
    std::fs::write(root.join(&entry.path), make_test_png_alt()).unwrap();
    let reopened = store.open_project(&root).await.unwrap();
    assert_eq!(
        reopened.self_check.issues[0].reason,
        moka_canvas::domain::SelfCheckReason::Changed
    );
}

#[tokio::test]
async fn replace_asset_bytes_clears_missing_state() {
    let tmp = TempDir::new().unwrap();
    let (store, root) = create_store(&tmp).await;
    let png = make_test_png();
    let staging = root.join("tmp").join("upload-replace.bin");
    std::fs::write(&staging, &png).unwrap();
    let entry = store
        .add_asset(StagedAsset {
            name: "later.png".into(),
            tmp_path: staging,
            declared_mime: None,
            category_hint: None,
        })
        .await
        .unwrap();
    std::fs::remove_file(root.join(&entry.path)).unwrap();

    let staging2 = root.join("tmp").join("upload-replace2.bin");
    std::fs::write(&staging2, make_test_png()).unwrap();
    let updated = store
        .replace_asset_bytes(
            &entry.id,
            StagedAsset {
                name: "later.png".into(),
                tmp_path: staging2,
                declared_mime: None,
                category_hint: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(updated.id, entry.id);
    let reopened = store.open_project(&root).await.unwrap();
    assert!(reopened.self_check.ok);
}

#[tokio::test]
async fn path_escape_is_rejected_when_streaming() {
    let tmp = TempDir::new().unwrap();
    let (store, _root) = create_store(&tmp).await;
    let result = store.asset_file("../../etc/passwd", None).await;
    assert!(result.is_err());
}

#[tokio::test]
async fn commands_module_applies_group_dissolve() {
    let tmp = TempDir::new().unwrap();
    let (store, _root) = create_store(&tmp).await;
    let current = store.current().await.unwrap().unwrap();
    let canvas_id = current.moka.canvas[0].id.clone();

    let node_a = make_node(NodeKind::Text, "A".into(), 0.0, 0.0);
    let node_b = make_node(NodeKind::Text, "B".into(), 300.0, 0.0);
    let group = make_node(NodeKind::Group, "G".into(), 0.0, 0.0);

    let (next, _) = apply_commands(
        &current.moka,
        &[
            DocumentCommand::AddNode {
                canvas_id: canvas_id.clone(),
                node: node_a.clone(),
            },
            DocumentCommand::AddNode {
                canvas_id: canvas_id.clone(),
                node: node_b.clone(),
            },
            DocumentCommand::AddNode {
                canvas_id: canvas_id.clone(),
                node: group.clone(),
            },
            DocumentCommand::SetGroupMembership {
                canvas_id: canvas_id.clone(),
                group_id: group.id.clone(),
                child_node_ids: vec![node_a.id.clone(), node_b.id.clone()],
            },
        ],
    )
    .unwrap();
    assert_eq!(next.canvas[0].groups.len(), 1);

    let (dissolved, _) = apply_commands(
        &next,
        &[DocumentCommand::SetGroupMembership {
            canvas_id: canvas_id.clone(),
            group_id: group.id.clone(),
            child_node_ids: vec![node_a.id.clone()],
        }],
    )
    .unwrap();
    assert_eq!(dissolved.canvas[0].groups.len(), 0);
    assert!(!dissolved.canvas[0].nodes.iter().any(|n| n.id == group.id));
    assert!(dissolved.canvas[0].nodes.iter().any(|n| n.id == node_a.id));
}

/// Generates a deterministic 64x64 PNG without external fixtures.
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

fn make_test_png_alt() -> Vec<u8> {
    let mut png = image::RgbaImage::new(64, 64);
    for pixel in png.pixels_mut() {
        *pixel = image::Rgba([10, 220, 90, 255]);
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
