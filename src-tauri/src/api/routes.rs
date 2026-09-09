use super::dto::{
    ApplyCommandsRequest, AssetChangeResponse, CapabilitiesResponse, ChannelKeyRequest,
    CreateProjectRequest, DefaultsPatch, ExportRequest, GenerateResponse, GenerationPreviewRequest,
    GenerationPreviewResponse, ImportChannelRequest, ImportProjectRequest, ModelListResponse,
    OpenProjectRequest, OpenProjectResponse, PackageResponse, PreferencesPatch, PreviewInput,
    PublicConfigResponse, RevisionQuery, RunStreamQuery, SaveResponse, StartRunRequest,
    UpsertChannelRequest,
};
use super::problem::{json_or_problem, Problem};
use super::ApiState;
use crate::domain::{now_iso, DocumentCommand, ResourceRegistry, RunRecord, RunStatus};
use crate::generate::providers::{ChannelImport, ProbeReport, ProvidersView};
use crate::generate::{
    collect_generation_inputs, Cancel, DeltaSink, GenerateInput, GenerateRequest, GenerateResult,
    ProviderError, TaskState,
};
use crate::metadata::RecentProject;
use crate::project::{
    ByteRange, CreateProject, OpenProject, PackageScope, ProjectStore, StagedAsset,
};
use crate::workflow::events::RunEvent;
use axum::{
    body::Body,
    extract::{rejection::JsonRejection, FromRequest, Multipart, Path, Query, Request, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use std::path::Path as FsPath;
use std::path::PathBuf;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::{broadcast, mpsc};
use tokio_util::io::ReaderStream;

fn problem_from_io(error: std::io::Error) -> Problem {
    Problem::from(error)
}

fn multipart_problem(error: axum::extract::multipart::MultipartError) -> Problem {
    Problem::new(
        error.status(),
        "VALIDATION_FAILED",
        format!("Multipart body is not valid: {}", error.body_text()),
    )
}

fn open_response(opened: OpenProject) -> OpenProjectResponse {
    OpenProjectResponse {
        root: opened.root.to_string_lossy().into_owned(),
        moka: opened.moka,
        self_check: opened.self_check,
    }
}

/// Records an opened project in the recent list.
///
/// A failure here is logged rather than returned: the project is already open,
/// and turning that into a failed request would trade a stale recent list for
/// an unusable editor. `/api/ready` is what reports a metadata directory that
/// has stopped accepting writes.
async fn upsert_recent(state: &ApiState, opened: &OpenProject) {
    let entry = RecentProject {
        id: opened.moka.metadata.id.clone(),
        name: opened.moka.metadata.name.clone(),
        path: opened.root.clone(),
        last_opened: now_iso(),
    };
    if let Err(error) = state.metadata.upsert_recent(&entry).await {
        tracing::warn!(
            target: "moka::metadata",
            code = error.code(),
            error = %error,
            "could not record the project in the recent list"
        );
    }
}

fn project_not_open() -> Problem {
    Problem::new(
        StatusCode::CONFLICT,
        "PROJECT_NOT_OPEN",
        "No project is open",
    )
}

async fn current_root(state: &ApiState) -> Result<PathBuf, Problem> {
    let current = state.store.current().await?;
    current
        .map(|opened| opened.root)
        .ok_or_else(project_not_open)
}

pub async fn public_config(State(state): State<ApiState>) -> Json<PublicConfigResponse> {
    let config = &state.config;
    Json(PublicConfigResponse {
        product_name: config.public.product_name.clone(),
        max_upload_bytes: config.public.max_upload_bytes,
        allowed_media_types: config.public.allowed_media_types.clone(),
        limits: config.limits.clone(),
        capabilities: CapabilitiesResponse {
            mode: state.mode.as_str().to_string(),
            // The list a run is validated against rather than the one that was
            // configured, so what a client is told and what it gets cannot
            // disagree about which executors are switched off.
            executors: config.active_executors(),
            asset_categories: crate::project::package::asset_categories()
                .iter()
                .map(|category| category.to_string())
                .collect(),
        },
    })
}

pub async fn list_recent(
    State(state): State<ApiState>,
) -> Result<Json<Vec<RecentProject>>, Problem> {
    Ok(Json(state.metadata.list_recent().await?))
}

pub async fn remove_recent(
    State(state): State<ApiState>,
    Path(id): Path<String>,
) -> Result<StatusCode, Problem> {
    state.metadata.remove_recent(&id).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn create_project(
    State(state): State<ApiState>,
    json: Result<Json<CreateProjectRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<OpenProjectResponse>), Problem> {
    let Json(request) = json_or_problem(json)?;
    let name = request.name.trim();
    if name.is_empty() || request.directory.trim().is_empty() {
        return Err(Problem::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "VALIDATION_FAILED",
            "Project name and directory are required",
        ));
    }
    let root = FsPath::new(request.directory.trim()).join(crate::assets::slugify(name));
    let opened = state
        .store
        .create_project(
            &root,
            CreateProject {
                name: name.to_string(),
            },
        )
        .await?;
    upsert_recent(&state, &opened).await;
    Ok((StatusCode::CREATED, Json(open_response(opened))))
}

pub async fn open_project(
    State(state): State<ApiState>,
    json: Result<Json<OpenProjectRequest>, JsonRejection>,
) -> Result<Json<OpenProjectResponse>, Problem> {
    let Json(request) = json_or_problem(json)?;
    if request.path.trim().is_empty() {
        return Err(Problem::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "VALIDATION_FAILED",
            "A project path is required",
        ));
    }
    let opened = state
        .store
        .open_project(FsPath::new(request.path.trim()))
        .await?;
    upsert_recent(&state, &opened).await;
    // The project is open, so there is somewhere for an answer to go again. The
    // sweep on open has already failed whatever cannot be picked up, and what is
    // left is waiting on a job a provider is still running.
    state.runs.resume_interrupted().await;
    Ok(Json(open_response(opened)))
}

pub async fn current_project(
    State(state): State<ApiState>,
) -> Result<Json<OpenProjectResponse>, Problem> {
    let Some(opened) = state.store.current().await? else {
        return Err(Problem::new(
            StatusCode::CONFLICT,
            "PROJECT_NOT_OPEN",
            "No project is open",
        ));
    };
    Ok(Json(open_response(opened)))
}

pub async fn apply_commands(
    State(state): State<ApiState>,
    json: Result<Json<ApplyCommandsRequest>, JsonRejection>,
) -> Result<Json<SaveResponse>, Problem> {
    let Json(request) = json_or_problem(json)?;
    if request.commands.is_empty() {
        return Err(Problem::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "VALIDATION_FAILED",
            "At least one command is required",
        ));
    }
    let commands: Vec<DocumentCommand> = request.commands;
    let result = state
        .store
        .apply_commands(request.expected_revision, commands)
        .await?;
    Ok(Json(SaveResponse {
        revision: result.revision,
        updated_at: result.updated_at,
    }))
}

/// Streams a multipart file field into the project's tmp directory.
async fn stage_field(
    mut field: axum::extract::multipart::Field<'_>,
    tmp_path: &FsPath,
    max_bytes: u64,
) -> Result<(), Problem> {
    let mut file = tokio::fs::File::create(tmp_path)
        .await
        .map_err(problem_from_io)?;
    let mut written: u64 = 0;
    let outcome = async {
        while let Some(chunk) = field.chunk().await.map_err(multipart_problem)? {
            written += chunk.len() as u64;
            if written > max_bytes {
                return Err(Problem::new(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "PAYLOAD_TOO_LARGE",
                    "The upload exceeds the configured size limit",
                ));
            }
            file.write_all(&chunk).await.map_err(problem_from_io)?;
        }
        file.flush().await.map_err(problem_from_io)?;
        Ok(())
    }
    .await;
    if outcome.is_err() {
        drop(file);
        let _ = std::fs::remove_file(tmp_path);
    }
    outcome
}

struct UploadFields {
    name: String,
    declared_mime: Option<String>,
    tmp_path: PathBuf,
    category_hint: Option<String>,
}

async fn read_upload(
    multipart: &mut Multipart,
    tmp_dir_root: &FsPath,
    max_bytes: u64,
) -> Result<UploadFields, Problem> {
    let mut file: Option<(String, Option<String>, PathBuf)> = None;
    let mut category_hint = None;
    while let Some(field) = multipart.next_field().await.map_err(multipart_problem)? {
        let field_name = field.name().map(str::to_owned);
        match field_name.as_deref() {
            Some("file") => {
                let name = field
                    .file_name()
                    .map(str::to_owned)
                    .unwrap_or_else(|| "upload.bin".to_string());
                let declared = field.content_type().map(str::to_owned);
                let tmp_path =
                    crate::assets::new_tmp_path(tmp_dir_root).map_err(problem_from_io)?;
                stage_field(field, &tmp_path, max_bytes).await?;
                file = Some((name, declared, tmp_path));
            }
            Some("categoryHint") => {
                let text = field.text().await.map_err(multipart_problem)?;
                if !text.trim().is_empty() {
                    category_hint = Some(text.trim().to_string());
                }
            }
            _ => {}
        }
    }
    let (name, declared_mime, tmp_path) = file.ok_or_else(|| {
        Problem::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "VALIDATION_FAILED",
            "Multipart field \"file\" is required",
        )
    })?;
    Ok(UploadFields {
        name,
        declared_mime,
        tmp_path,
        category_hint,
    })
}

pub async fn upload_asset(
    State(state): State<ApiState>,
    mut multipart: Multipart,
) -> Result<(StatusCode, Json<AssetChangeResponse>), Problem> {
    let root = current_root(&state).await?;
    let max = state.config.server.max_upload_bytes;
    let upload = read_upload(&mut multipart, &root, max).await?;
    let change = state
        .store
        .add_asset(StagedAsset {
            name: upload.name,
            tmp_path: upload.tmp_path,
            declared_mime: upload.declared_mime,
            category_hint: upload.category_hint,
            provenance: None,
        })
        .await?;
    Ok((
        StatusCode::CREATED,
        Json(AssetChangeResponse {
            entry: change.entry,
            revision: change.revision,
            updated_at: change.updated_at,
        }),
    ))
}

pub async fn replace_asset(
    State(state): State<ApiState>,
    Path(id): Path<String>,
    mut multipart: Multipart,
) -> Result<Json<AssetChangeResponse>, Problem> {
    let root = current_root(&state).await?;
    let max = state.config.server.max_upload_bytes;
    let upload = read_upload(&mut multipart, &root, max).await?;
    let change = state
        .store
        .replace_asset_bytes(
            &id,
            StagedAsset {
                name: upload.name,
                tmp_path: upload.tmp_path,
                declared_mime: upload.declared_mime,
                category_hint: upload.category_hint,
                provenance: None,
            },
        )
        .await?;
    Ok(Json(AssetChangeResponse {
        entry: change.entry,
        revision: change.revision,
        updated_at: change.updated_at,
    }))
}

pub async fn delete_asset(
    State(state): State<ApiState>,
    Path(id): Path<String>,
) -> Result<Json<SaveResponse>, Problem> {
    let saved = state.store.remove_asset(&id).await?;
    Ok(Json(SaveResponse {
        revision: saved.revision,
        updated_at: saved.updated_at,
    }))
}

pub async fn reveal_asset(
    State(state): State<ApiState>,
    Path(id): Path<String>,
) -> Result<StatusCode, Problem> {
    let asset = state.store.asset_file(&id, None).await?;
    reveal_in_folder(&asset.path)?;
    Ok(StatusCode::NO_CONTENT)
}

/// Opens the platform file manager with the asset selected. The path is
/// passed as a plain argv entry — no shell is involved.
#[cfg(target_os = "macos")]
fn reveal_in_folder(path: &std::path::Path) -> Result<(), Problem> {
    spawn_reveal("open", &[std::ffi::OsStr::new("-R"), path.as_os_str()])
}

#[cfg(target_os = "windows")]
fn reveal_in_folder(path: &std::path::Path) -> Result<(), Problem> {
    let select = format!("/select,{}", path.display());
    spawn_reveal("explorer", &[std::ffi::OsStr::new(&select)])
}

#[cfg(all(unix, not(target_os = "macos")))]
fn reveal_in_folder(path: &std::path::Path) -> Result<(), Problem> {
    let parent = path.parent().unwrap_or(path);
    spawn_reveal("xdg-open", &[parent.as_os_str()])
}

#[cfg(any(unix, target_os = "windows"))]
fn spawn_reveal(program: &str, args: &[&std::ffi::OsStr]) -> Result<(), Problem> {
    std::process::Command::new(program)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| {
            Problem::new(
                StatusCode::BAD_GATEWAY,
                "REVEAL_FAILED",
                format!("Could not open the file manager: {error}"),
            )
        })
}

fn parse_range_header(value: Option<&str>, total: u64) -> Result<Option<ByteRange>, Problem> {
    let Some(value) = value else {
        return Ok(None);
    };
    let Some(spec) = value.strip_prefix("bytes=") else {
        return Ok(None);
    };
    let Some((start_raw, end_raw)) = spec.split_once('-') else {
        return Ok(None);
    };
    let range = if start_raw.is_empty() {
        // Suffix range: the last N bytes.
        let Ok(suffix) = end_raw.parse::<u64>() else {
            return Ok(None);
        };
        if suffix == 0 || total == 0 {
            return Ok(None);
        }
        let start = total.saturating_sub(suffix.min(total));
        ByteRange {
            start,
            end: Some(total - 1),
        }
    } else {
        let Ok(start) = start_raw.parse::<u64>() else {
            return Ok(None);
        };
        let end = if end_raw.is_empty() {
            None
        } else {
            match end_raw.parse::<u64>() {
                Ok(end) => Some(end),
                Err(_) => return Ok(None),
            }
        };
        ByteRange { start, end }
    };
    if range.start >= total {
        return Err(Problem::new(
            StatusCode::RANGE_NOT_SATISFIABLE,
            "VALIDATION_FAILED",
            format!(
                "Range start {} is beyond the asset length {}",
                range.start, total
            ),
        ));
    }
    Ok(Some(range))
}

pub async fn stream_asset(
    State(state): State<ApiState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, Problem> {
    let asset = state.store.asset_file(&id, None).await?;
    let mut file = tokio::fs::File::open(&asset.path)
        .await
        .map_err(problem_from_io)?;
    let total = file.metadata().await.map_err(problem_from_io)?.len();
    let range = parse_range_header(
        headers
            .get(header::RANGE)
            .and_then(|value| value.to_str().ok()),
        total,
    )?;

    let (status, content_range, length) = match range {
        None => (StatusCode::OK, None, total),
        Some(ByteRange { start, end }) => {
            let end = end
                .unwrap_or_else(|| total.saturating_sub(1))
                .min(total.saturating_sub(1));
            let length = end.saturating_sub(start).saturating_add(1);
            file.seek(std::io::SeekFrom::Start(start))
                .await
                .map_err(problem_from_io)?;
            (
                StatusCode::PARTIAL_CONTENT,
                Some(format!("bytes {start}-{end}/{total}")),
                length,
            )
        }
    };

    let body = Body::from_stream(ReaderStream::new(file.take(length)));
    let mime = asset
        .entry
        .mime
        .clone()
        .unwrap_or_else(|| "application/octet-stream".to_string());
    let mut response = Response::builder()
        .status(status)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, length.to_string())
        .header(
            header::CONTENT_TYPE,
            HeaderValue::from_str(&mime)
                .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
        )
        .body(body)
        .map_err(|error| {
            Problem::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "INTERNAL",
                error.to_string(),
            )
        })?;
    if let Some(content_range) = content_range {
        if let Ok(value) = HeaderValue::from_str(&content_range) {
            response.headers_mut().insert(header::CONTENT_RANGE, value);
        }
    }
    Ok(response)
}

pub async fn export_package(
    State(state): State<ApiState>,
    json: Option<Json<ExportRequest>>,
) -> Result<Json<PackageResponse>, Problem> {
    let request = json.map(|Json(request)| request).unwrap_or_default();
    let report = state
        .store
        .export_package(
            request.destination.as_deref().map(FsPath::new),
            request.allow_incomplete,
            PackageScope {
                personal_history: request.include_personal_history,
                referenced_assets_only: request.only_referenced_assets,
            },
        )
        .await?;
    Ok(Json(PackageResponse {
        destination: report.destination.to_string_lossy().into_owned(),
        entries: report.entries,
        bytes: report.bytes,
        incomplete: report.incomplete,
    }))
}

fn import_target(
    directory: &str,
    name: Option<&str>,
    fallback_stem: &str,
) -> Result<PathBuf, Problem> {
    if directory.trim().is_empty() {
        return Err(Problem::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "VALIDATION_FAILED",
            "A target directory is required",
        ));
    }
    let name = name
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(fallback_stem);
    Ok(FsPath::new(directory.trim()).join(crate::assets::slugify(name)))
}

fn archive_stem(path: &FsPath) -> String {
    let stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("imported-project");
    stem.strip_suffix(".mokapkg").unwrap_or(stem).to_string()
}

async fn finish_import(
    state: &ApiState,
    archive: &FsPath,
    directory: &str,
    name: Option<&str>,
) -> Result<(StatusCode, Json<OpenProjectResponse>), Problem> {
    let target = import_target(directory, name, &archive_stem(archive))?;
    let opened = state.store.import_package(archive, &target).await?;
    upsert_recent(state, &opened).await;
    Ok((StatusCode::CREATED, Json(open_response(opened))))
}

pub async fn import_project(
    State(state): State<ApiState>,
    headers: HeaderMap,
    request: Request,
) -> Result<(StatusCode, Json<OpenProjectResponse>), Problem> {
    let is_multipart = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.starts_with("multipart/form-data"))
        .unwrap_or(false);

    if !is_multipart {
        let json = Json::<ImportProjectRequest>::from_request(request, &state)
            .await
            .map_err(|rejection| {
                Problem::new(
                    rejection.status(),
                    "VALIDATION_FAILED",
                    format!("Request body is not valid: {}", rejection.body_text()),
                )
            })?;
        return finish_import(
            &state,
            FsPath::new(json.archive_path.trim()),
            &json.directory,
            json.name.as_deref(),
        )
        .await;
    }

    let mut multipart = Multipart::from_request(request, &state)
        .await
        .map_err(|rejection| {
            Problem::new(
                rejection.status(),
                "VALIDATION_FAILED",
                format!("Multipart body is not valid: {}", rejection.body_text()),
            )
        })?;
    let max = state.config.server.max_upload_bytes;
    let mut archive: Option<(String, PathBuf)> = None;
    let mut directory = None;
    let mut name = None;
    while let Some(field) = multipart.next_field().await.map_err(multipart_problem)? {
        let field_name = field.name().map(str::to_owned);
        match field_name.as_deref() {
            Some("file") => {
                let original = field
                    .file_name()
                    .map(str::to_owned)
                    .unwrap_or_else(|| "package.mokapkg.zip".to_string());
                let tmp_path =
                    std::env::temp_dir().join(format!("moka-import-{}.zip", uuid::Uuid::now_v7()));
                stage_field(field, &tmp_path, max).await?;
                archive = Some((original, tmp_path));
            }
            Some("directory") => {
                directory = Some(field.text().await.map_err(multipart_problem)?);
            }
            Some("name") => {
                let text = field.text().await.map_err(multipart_problem)?;
                if !text.trim().is_empty() {
                    name = Some(text.trim().to_string());
                }
            }
            _ => {}
        }
    }
    let (original, tmp_path) = archive.ok_or_else(|| {
        Problem::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "VALIDATION_FAILED",
            "Multipart field \"file\" is required",
        )
    })?;
    let stem = archive_stem(FsPath::new(&original));
    let result = finish_import(
        &state,
        &tmp_path,
        directory.as_deref().unwrap_or(""),
        name.as_deref().or(Some(stem.as_str())),
    )
    .await;
    let _ = std::fs::remove_file(&tmp_path);
    result
}

pub async fn list_runs(State(state): State<ApiState>) -> Result<Json<Vec<RunRecord>>, Problem> {
    let runs = state.store.list_runs().await?;
    Ok(Json(runs))
}

fn start_run_problem(error: crate::workflow::runner::StartRunError) -> Problem {
    use crate::workflow::runner::StartRunError;
    match error {
        StartRunError::Validation(issues) => Problem::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "RUN_VALIDATION_FAILED",
            "The requested run is not valid",
        )
        .with_details(serde_json::json!({ "issues": issues })),
        StartRunError::Store(error) => Problem::from(error),
    }
}

pub async fn start_run(
    State(state): State<ApiState>,
    json: Result<Json<StartRunRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<RunRecord>), Problem> {
    let Json(request) = json_or_problem(json)?;
    if request.canvas_id.trim().is_empty() || request.node_ids.is_empty() {
        return Err(Problem::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "VALIDATION_FAILED",
            "A canvas id and at least one node id are required",
        ));
    }
    let run = state
        .runs
        .start(&request.canvas_id, request.node_ids, None)
        .await
        .map_err(start_run_problem)?;
    Ok((StatusCode::CREATED, Json(run)))
}

pub async fn get_run(
    State(state): State<ApiState>,
    Path(id): Path<String>,
) -> Result<Json<RunRecord>, Problem> {
    let run = state.store.get_run(&id).await?;
    Ok(Json(run))
}

pub async fn cancel_run(
    State(state): State<ApiState>,
    Path(id): Path<String>,
) -> Result<Json<RunRecord>, Problem> {
    let run = state.runs.cancel(&id).await?;
    Ok(Json(run))
}

pub async fn retry_run(
    State(state): State<ApiState>,
    Path(id): Path<String>,
) -> Result<(StatusCode, Json<RunRecord>), Problem> {
    let run = state.runs.retry(&id).await.map_err(start_run_problem)?;
    Ok((StatusCode::CREATED, Json(run)))
}

/// What one node will send, answered by the same resolver a run uses.
///
/// The editor holds the document and could walk the graph itself, but then
/// there would be two answers to what a node feeds the model — the one on screen
/// and the one sent — and the disagreement between them is the hardest kind of
/// bug to find. So the walking happens here and the client only renders it.
pub async fn preview_generation(
    State(state): State<ApiState>,
    json: Result<Json<GenerationPreviewRequest>, JsonRejection>,
) -> Result<Json<GenerationPreviewResponse>, Problem> {
    let Json(request) = json_or_problem(json)?;
    let opened = state.store.current().await?.ok_or_else(project_not_open)?;
    let canvas = opened
        .moka
        .canvas
        .iter()
        .find(|canvas| canvas.id == request.canvas_id)
        .ok_or_else(|| {
            Problem::new(
                StatusCode::NOT_FOUND,
                "CANVAS_NOT_FOUND",
                format!("Canvas {} is not in the open project", request.canvas_id),
            )
        })?;
    let node = canvas.node(&request.node_id).ok_or_else(|| {
        Problem::new(
            StatusCode::NOT_FOUND,
            "NODE_NOT_FOUND",
            format!("Node {} is not on that canvas", request.node_id),
        )
    })?;
    if node.data.generation.is_none() {
        return Err(Problem::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "GENERATION_SPEC_MISSING",
            format!("Node \"{}\" has no generation to preview", node.title),
        ));
    }

    let resolved = collect_generation_inputs(canvas, node);
    let mut inputs = Vec::with_capacity(resolved.inputs.len());
    for (position, input) in resolved.inputs.iter().enumerate() {
        // Filled in the same pass, so a reference and the card behind it cannot
        // drift apart; a resolver that gave no source says so with an empty id
        // rather than borrowing a neighbour's.
        let source = resolved
            .input_sources
            .get(position)
            .cloned()
            .unwrap_or_default();
        inputs.push(preview_input(&state, &opened.moka.resources, input, source).await);
    }

    Ok(Json(GenerationPreviewResponse {
        prompt: resolved.prompt,
        inputs,
        truncated_chars: resolved.truncated_chars,
        unresolved: resolved.unresolved,
    }))
}

/// One reference, described from what the project recorded about its asset.
async fn preview_input(
    state: &ApiState,
    resources: &ResourceRegistry,
    input: &GenerateInput,
    node_id: String,
) -> PreviewInput {
    let recorded = resources.find(&input.asset_id);
    // Asked of the store rather than trusted from the registry: it resolves the
    // path inside the project root and says whether a file is there, which is
    // the same answer a run gets when it comes to load the bytes.
    let reachable = state.store.asset_file(&input.asset_id, None).await.is_ok();
    let probe = recorded.and_then(|entry| entry.probe.as_ref());
    PreviewInput {
        role: input.role,
        node_id,
        asset_id: input.asset_id.clone(),
        name: recorded.map(|entry| entry.name.clone()),
        // What was measured at upload wins over what the client declared.
        mime: probe
            .map(|probe| probe.mime.clone())
            .or_else(|| recorded.and_then(|entry| entry.mime.clone())),
        bytes: probe
            .map(|probe| probe.bytes)
            .or_else(|| recorded.and_then(|entry| entry.bytes)),
        width: probe.and_then(|probe| probe.width),
        height: probe.and_then(|probe| probe.height),
        duration_ms: probe.and_then(|probe| probe.duration_ms),
        missing: !reachable,
    }
}

/// Every provider write answers with the whole redacted view. The client is
/// holding a revision it has to keep current anyway, so handing back the
/// state it just caused costs one read and saves it a reconciliation.
async fn providers_view(state: &ApiState) -> Result<Json<ProvidersView>, Problem> {
    Ok(Json(state.providers.view().await?))
}

pub async fn list_providers(State(state): State<ApiState>) -> Result<Json<ProvidersView>, Problem> {
    providers_view(&state).await
}

pub async fn upsert_channel(
    State(state): State<ApiState>,
    json: Result<Json<UpsertChannelRequest>, JsonRejection>,
) -> Result<Json<ProvidersView>, Problem> {
    let Json(request) = json_or_problem(json)?;
    let record = state.providers.upsert_channel(request.channel).await?;
    // Second, so a credential is never stored against a channel that was
    // refused. Blank counts as absent: the field arrives empty on every edit
    // that did not touch it, and treating that as a removal would destroy a
    // working key as a side effect of renaming a channel.
    let api_key = request
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty());
    if let Some(api_key) = api_key {
        state.providers.set_key(&record.id, Some(api_key)).await?;
    }
    providers_view(&state).await
}

pub async fn delete_channel(
    State(state): State<ApiState>,
    Path(id): Path<String>,
    Query(revision): Query<RevisionQuery>,
) -> Result<Json<ProvidersView>, Problem> {
    state
        .providers
        .delete_channel(&id, revision.revision)
        .await?;
    providers_view(&state).await
}

pub async fn set_channel_key(
    State(state): State<ApiState>,
    Path(id): Path<String>,
    json: Result<Json<ChannelKeyRequest>, JsonRejection>,
) -> Result<Json<ProvidersView>, Problem> {
    let Json(request) = json_or_problem(json)?;
    state
        .providers
        .set_key(&id, request.api_key.as_deref())
        .await?;
    providers_view(&state).await
}

pub async fn patch_defaults(
    State(state): State<ApiState>,
    json: Result<Json<DefaultsPatch>, JsonRejection>,
) -> Result<Json<ProvidersView>, Problem> {
    let Json(patch) = json_or_problem(json)?;
    let mut defaults = state.providers.snapshot().await?.defaults;
    if let Some(text) = patch.text {
        defaults.text = text;
    }
    if let Some(image) = patch.image {
        defaults.image = image;
    }
    if let Some(audio) = patch.audio {
        defaults.audio = audio;
    }
    if let Some(video) = patch.video {
        defaults.video = video;
    }
    state
        .providers
        .set_defaults(&defaults, patch.expected_revision)
        .await?;
    providers_view(&state).await
}

pub async fn patch_preferences(
    State(state): State<ApiState>,
    json: Result<Json<PreferencesPatch>, JsonRejection>,
) -> Result<Json<ProvidersView>, Problem> {
    let Json(patch) = json_or_problem(json)?;
    let mut preferences = state.providers.snapshot().await?.preferences;
    if let Some(system_prompt) = patch.system_prompt {
        preferences.system_prompt = system_prompt;
    }
    if let Some(reasoning_effort) = patch.reasoning_effort {
        preferences.reasoning_effort = reasoning_effort;
    }
    if let Some(image) = patch.image {
        preferences.image = image;
    }
    if let Some(video) = patch.video {
        preferences.video = video;
    }
    if let Some(audio) = patch.audio {
        preferences.audio = audio;
    }
    state
        .providers
        .set_preferences(&preferences, patch.expected_revision)
        .await?;
    providers_view(&state).await
}

/// Lists what a channel offers without storing it. The capability is a guess
/// for the form to start from; saving the channel is what makes it a decision.
pub async fn fetch_channel_models(
    State(state): State<ApiState>,
    Path(id): Path<String>,
) -> Result<Json<ModelListResponse>, Problem> {
    let models = state.providers.fetch_models(&id).await?;
    Ok(Json(ModelListResponse { models }))
}

/// Answers inside a successful response even when the channel is broken,
/// because the point of a probe is to show which one failed and why.
pub async fn probe_channel(
    State(state): State<ApiState>,
    Path(id): Path<String>,
) -> Result<Json<ProbeReport>, Problem> {
    Ok(Json(state.providers.probe(&id).await?))
}

pub async fn import_channel(
    State(state): State<ApiState>,
    json: Result<Json<ImportChannelRequest>, JsonRejection>,
) -> Result<Json<ProvidersView>, Problem> {
    let Json(request) = json_or_problem(json)?;
    state
        .providers
        .import_channel(ChannelImport {
            base_url: request.base_url,
            api_key: request.api_key,
            name: request.name,
            protocol: request.protocol,
            expected_revision: request.expected_revision,
        })
        .await?;
    providers_view(&state).await
}

// ---------------------------------------------------------------- generation

/// How much of a stream is buffered before the writer waits for the reader.
/// Small enough that a client which stops reading cannot turn an answer into
/// memory, large enough that a fast provider is not stalled by one frame.
const STREAM_BUFFER_BYTES: usize = 64 * 1024;

/// Written text, sent whole or as it arrives.
///
/// The two paths answer differently — a document or a stream — so the return
/// type is the response itself rather than a result the router unwraps.
pub async fn generate_text(
    State(state): State<ApiState>,
    json: Result<Json<GenerateRequest>, JsonRejection>,
) -> Response {
    let request = match json_or_problem(json) {
        Ok(Json(request)) => request,
        Err(problem) => return problem.into_response(),
    };
    if request.wants_stream() {
        return stream_text(&state, request);
    }
    match state
        .gateway
        .text(request, &DeltaSink::default(), &Cancel::new())
        .await
    {
        Ok(result) => Json(GenerateResponse::succeeded(result)).into_response(),
        Err(error) => Problem::from(error).into_response(),
    }
}

pub async fn generate_image(
    State(state): State<ApiState>,
    json: Result<Json<GenerateRequest>, JsonRejection>,
) -> Result<Json<GenerateResponse>, Problem> {
    let Json(request) = json_or_problem(json)?;
    let result = state.gateway.image(request, &Cancel::new()).await?;
    Ok(Json(GenerateResponse::succeeded(result)))
}

pub async fn generate_audio(
    State(state): State<ApiState>,
    json: Result<Json<GenerateRequest>, JsonRejection>,
) -> Result<Json<GenerateResponse>, Problem> {
    let Json(request) = json_or_problem(json)?;
    let result = state.gateway.audio(request, &Cancel::new()).await?;
    Ok(Json(GenerateResponse::succeeded(result)))
}

/// A shot, started rather than waited out: the handle comes back at once and
/// is polled until the job ends.
pub async fn generate_video(
    State(state): State<ApiState>,
    json: Result<Json<GenerateRequest>, JsonRejection>,
) -> Result<Json<GenerateResponse>, Problem> {
    let Json(request) = json_or_problem(json)?;
    let task = state.gateway.video(request, &Cancel::new()).await?;
    Ok(Json(GenerateResponse::started(&task, None)))
}

/// One look at a job this server started.
pub async fn poll_generation_task(
    State(state): State<ApiState>,
    Path(id): Path<String>,
) -> Result<Json<GenerateResponse>, Problem> {
    match state.gateway.poll(&id, &Cancel::new()).await? {
        TaskState::Pending { retry_after_ms } => {
            // Still tracked, because a job that is running is the only kind
            // that answers with a wait; looked up here rather than up front so
            // a finished job does not pay for a handle it will not report.
            let tracked = state.gateway.tasks().get(&id)?;
            Ok(Json(GenerateResponse::started(
                &tracked,
                Some(retry_after_ms),
            )))
        }
        TaskState::Succeeded(result) => Ok(Json(GenerateResponse::succeeded(result))),
        // The job ended badly rather than this request failing, but the two
        // carry the same information and a client reads one shape either way:
        // what went wrong, and whether waiting could fix it.
        TaskState::Failed { message, retryable } => Err(Problem::from(if retryable {
            ProviderError::Unreachable(message)
        } else {
            ProviderError::Rejected(message)
        })),
    }
}

/// How often a quiet stream says it is still there, and how often it looks at
/// the record to check the run still is.
///
/// The comment is for anything sitting between the two that would otherwise
/// drop a connection with nothing on it. The look is for a run whose driver
/// stopped without saying so: a stream that never ends is worse than one that
/// ends a quarter of a minute late.
const FOLLOW_INTERVAL: Duration = Duration::from_secs(15);

/// A comment rather than an event, which is what the format calls the traffic
/// a listener is not meant to see.
const KEEP_ALIVE: &str = ": keep-alive\n\n";

/// What a run is doing, while it is doing it.
///
/// A shortcut to the record rather than a second copy of it. The frames say
/// which words have arrived and how far along a step is; when the run ends the
/// stream says so and closes, and the listener goes and reads the record it
/// should have been reading all along. A client that never connects, or one
/// that drops half way, loses the typewriter and nothing else.
pub async fn stream_run_events(
    State(state): State<ApiState>,
    Query(query): Query<RunStreamQuery>,
) -> Response {
    let run_id = query.run_id.trim().to_string();
    // Joined before the record is read, so an ending cannot slip through the
    // gap between the two: a run that ends after this point says so on a
    // channel this listener is already on.
    let mut listener = state.runs.events().follow(&run_id);
    let run = match state.store.get_run(&run_id).await {
        Ok(run) => run,
        Err(error) => {
            // Closed only when there is no such run: a channel belonging to one
            // that is going would cut off every other listener joined to it,
            // and an unreadable store says nothing about whether it is.
            if error.code() == "RUN_NOT_FOUND" {
                state.runs.events().close(&run_id);
            }
            return Problem::from(error).into_response();
        }
    };

    let (mut writer, reader) = tokio::io::duplex(STREAM_BUFFER_BYTES);
    let store = state.store.clone();
    let following = run_id.clone();

    tokio::spawn(async move {
        // Already over, so already said everything it was going to: the frame
        // is built from the record, which is where the listener reads next.
        if !is_going(run.status) {
            let _ = frame(&mut writer, "done", &ending(&run)).await;
            return;
        }
        let mut ticker = tokio::time::interval(FOLLOW_INTERVAL);
        // The first tick is immediate, and spent here so the loop's are spaced.
        ticker.tick().await;
        loop {
            tokio::select! {
                event = listener.recv() => match event {
                    Ok(event) => {
                        let (name, body) = event.as_frame();
                        let last = event.is_done();
                        if frame(&mut writer, name, &body).await.is_err() {
                            // The listener has gone; nothing to say it to.
                            return;
                        }
                        if last {
                            return;
                        }
                    }
                    // Further behind than the channel holds. A display may lose
                    // a frame and catch up from the record, which is cheaper
                    // than keeping words for a listener that stopped reading.
                    Err(broadcast::error::RecvError::Lagged(_)) => {}
                    // Closed with nothing said, so the run ended without this
                    // stream hearing how: the record is asked instead.
                    Err(broadcast::error::RecvError::Closed) => break,
                },
                _ = ticker.tick() => match store.get_run(&following).await {
                    Ok(run) if is_going(run.status) => {
                        if writer.write_all(KEEP_ALIVE.as_bytes()).await.is_err() {
                            return;
                        }
                    }
                    Ok(run) => {
                        let _ = frame(&mut writer, "done", &ending(&run)).await;
                        return;
                    }
                    // Gone, which is an ending of a sort and nothing left to
                    // say about it.
                    Err(_) => return,
                },
            }
        }
        if let Ok(run) = store.get_run(&following).await {
            let _ = frame(&mut writer, "done", &ending(&run)).await;
        }
    });

    (
        [
            (header::CONTENT_TYPE, "text/event-stream"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        Body::from_stream(ReaderStream::new(reader)),
    )
        .into_response()
}

/// Whether a run still has something left to say.
fn is_going(status: RunStatus) -> bool {
    matches!(status, RunStatus::Queued | RunStatus::Running)
}

/// The frame that ends a run's stream, built from the record rather than from
/// what a driver remembered saying, so the two cannot disagree.
fn ending(run: &RunRecord) -> serde_json::Value {
    RunEvent::done(run.id.clone(), run.status, run.error.clone())
        .as_frame()
        .1
}

/// A text answer sent as it arrives.
///
/// The frames are written into one end of a pipe and served from the other,
/// which is where a delta callback that cannot wait meets a response body that
/// is a stream of bytes.
fn stream_text(state: &ApiState, request: GenerateRequest) -> Response {
    let (mut writer, reader) = tokio::io::duplex(STREAM_BUFFER_BYTES);
    let (deltas, mut received) = mpsc::unbounded_channel::<String>();
    let sink = DeltaSink::new(std::sync::Arc::new(move |chunk: &str| {
        // A send that fails means the writer has gone, which the task notices
        // when it tries the next frame.
        let _ = deltas.send(chunk.to_string());
    }));
    let cancel = Cancel::new();
    let watching = cancel.clone();
    let gateway = state.gateway.clone();

    tokio::spawn(async move {
        let mut pending = Box::pin(gateway.text(request, &sink, &watching));
        let outcome = loop {
            tokio::select! {
                Some(chunk) = received.recv() => {
                    if frame(&mut writer, "delta", &serde_json::json!({ "text": chunk }))
                        .await
                        .is_err()
                    {
                        watching.cancel();
                        return;
                    }
                }
                answered = &mut pending => break answered,
            }
        };
        // An answer can land with deltas still queued behind it, and the frame
        // that ends the stream has to be the last thing a caller reads.
        drop(pending);
        drop(sink);
        while let Some(chunk) = received.recv().await {
            if frame(&mut writer, "delta", &serde_json::json!({ "text": chunk }))
                .await
                .is_err()
            {
                return;
            }
        }
        let _ = frame(&mut writer, "done", &closing(outcome)).await;
    });

    (
        [
            (header::CONTENT_TYPE, "text/event-stream"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        Body::from_stream(ReaderStream::new(reader)),
    )
        .into_response()
}

/// The frame that ends a stream.
///
/// A failure travels inside it rather than as a problem body: the status line
/// went out with the first delta, and there is no second one to send.
fn closing(outcome: Result<GenerateResult, ProviderError>) -> serde_json::Value {
    match outcome {
        Ok(result) => serde_json::to_value(GenerateResponse::succeeded(result)).unwrap_or_default(),
        Err(error) => serde_json::json!({
            "error": {
                "code": error.code(),
                "message": error.to_string(),
                "retryable": error.retryable(),
            }
        }),
    }
}

/// One server-sent event. The body is compact JSON, which is what the format
/// needs: a raw newline would end the frame before the data did.
async fn frame(
    writer: &mut tokio::io::DuplexStream,
    event: &str,
    body: &serde_json::Value,
) -> std::io::Result<()> {
    writer
        .write_all(format!("event: {event}\ndata: {body}\n\n").as_bytes())
        .await
}
