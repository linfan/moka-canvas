use crate::domain::{AssetProbe, ASSET_CATEGORIES};
use crate::project::ProjectError;
use sha2::Digest;
use std::path::{Path, PathBuf};

pub mod probe;

/// Maps a sniffed MIME type to its asset category directory.
pub fn category_for_mime(mime: &str) -> Option<&'static str> {
    if mime.starts_with("image/") {
        Some("images")
    } else if mime.starts_with("video/") {
        Some("videos")
    } else if mime.starts_with("audio/") {
        Some("music")
    } else if mime == "text/plain" || mime == "text/markdown" || mime == "application/json" {
        Some("texts")
    } else {
        None
    }
}

pub fn is_allowed_media(mime: &str, allowed: &[String]) -> bool {
    allowed
        .iter()
        .any(|prefix| mime.starts_with(&format!("{prefix}/")) || mime == *prefix)
}

pub struct StagedAnalysis {
    pub mime: String,
    pub bytes: u64,
    pub sha256: String,
    pub probe: AssetProbe,
}

/// Sniffs the MIME type from bytes, hashes the file, and probes cheap
/// metadata: image dimensions, and duration/sample details for WAV, MP3,
/// and MP4-family media. Probing is best-effort — malformed media still
/// imports, just without the missing fields.
pub fn analyze_staged(path: &Path) -> Result<StagedAnalysis, ProjectError> {
    let bytes = std::fs::read(path)?;
    if bytes.is_empty() {
        return Err(ProjectError::domain("ASSET_INVALID", "The file is empty"));
    }
    let sniffed = infer::get(&bytes).map(|kind| kind.mime_type().to_string());
    let mime = sniffed.unwrap_or_else(|| {
        if std::str::from_utf8(&bytes[..bytes.len().min(8192)]).is_ok() {
            "text/plain".to_string()
        } else {
            "application/octet-stream".to_string()
        }
    });

    let mut hasher = sha2::Sha256::new();
    hasher.update(&bytes);
    let sha256 = hex::encode(hasher.finalize());

    let mut probe = AssetProbe {
        mime: mime.clone(),
        bytes: bytes.len() as i64,
        sha256: sha256.clone(),
        width: None,
        height: None,
        duration_ms: None,
        sample_rate: None,
        channels: None,
        codec_summary: None,
        poster_asset_id: None,
    };
    if mime.starts_with("image/") {
        if let Ok(reader) = image::ImageReader::open(path) {
            if let Ok(reader) = reader.with_guessed_format().map_err(|_| ()) {
                if let Ok((width, height)) = reader.into_dimensions() {
                    probe.width = Some(width as i32);
                    probe.height = Some(height as i32);
                }
            }
        }
    } else if mime.starts_with("audio/") || mime.starts_with("video/") {
        let media = probe::probe_media(&mime, &bytes);
        probe.duration_ms = media.duration_ms;
        probe.sample_rate = media.sample_rate;
        probe.channels = media.channels;
        probe.codec_summary = media.codec_summary;
        if probe.width.is_none() {
            probe.width = media.width;
            probe.height = media.height;
        }
    }

    Ok(StagedAnalysis {
        mime,
        bytes: bytes.len() as u64,
        sha256,
        probe,
    })
}

pub fn slugify(name: &str) -> String {
    let stem = Path::new(name)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("asset");
    let mut slug = String::with_capacity(stem.len());
    for ch in stem.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
        } else if ch == '-' || ch == '_' {
            slug.push(ch);
        } else if ch == ' ' || ch == '.' {
            slug.push('-');
        }
    }
    let slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        "asset".to_string()
    } else {
        slug.chars().take(60).collect()
    }
}

pub fn extension_for(name: &str, mime: &str) -> String {
    if let Some(ext) = Path::new(name)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .filter(|ext| ext.chars().all(|c| c.is_ascii_alphanumeric()) && ext.len() <= 8)
    {
        return ext;
    }
    match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        "audio/mpeg" => "mp3",
        "audio/wav" | "audio/x-wav" => "wav",
        "audio/ogg" => "ogg",
        "audio/mp4" => "m4a",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        "video/quicktime" => "mov",
        "text/plain" => "txt",
        "text/markdown" => "md",
        "application/json" => "json",
        _ => "bin",
    }
    .to_string()
}

/// Collision-safe filename: slug derived from the display name plus a short
/// id suffix, never the raw user-supplied path.
pub fn asset_filename(name: &str, mime: &str, id: &str) -> String {
    let short: String = id.chars().take(8).collect();
    format!("{}-{}.{}", slugify(name), short, extension_for(name, mime))
}

/// Atomically promotes a staged tmp file into its category directory.
/// Returns the project-relative POSIX path.
pub fn promote(
    project_root: &Path,
    tmp_path: &Path,
    category: &str,
    filename: &str,
) -> Result<String, ProjectError> {
    if !ASSET_CATEGORIES.contains(&category) {
        return Err(ProjectError::domain(
            "ASSET_INVALID",
            format!("Unknown asset category: {category}"),
        ));
    }
    let category_dir = project_root.join("assets").join(category);
    std::fs::create_dir_all(&category_dir)?;
    let target = category_dir.join(filename);
    std::fs::rename(tmp_path, &target)?;
    Ok(format!("assets/{category}/{filename}"))
}

pub fn tmp_dir(project_root: &Path) -> PathBuf {
    project_root.join("tmp")
}

pub fn new_tmp_path(project_root: &Path) -> std::io::Result<PathBuf> {
    let dir = tmp_dir(project_root);
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join(format!("upload-{}.bin", uuid::Uuid::now_v7())))
}
