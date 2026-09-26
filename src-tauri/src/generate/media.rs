//! Turning a reference to a stored asset into bytes a provider can accept.
//!
//! These are the rules a provider would otherwise enforce with an opaque
//! complaint of its own: how large a reference may be, and which image formats
//! travel as they are. Paths stay here — an adapter is handed bytes, a mime
//! type, and the name a multipart part needs.

use std::path::Path;

use crate::config::GenerateConfig;
use crate::domain::{AssetId, Capability, ResourceEntry};
use crate::project::ProjectStore;

use super::error::ProviderError;
use super::{GenerateInput, GenerateRequest, InputRole, InputWindow};

/// Formats sent as they are. Anything else that still decodes is re-encoded,
/// because a provider that cannot read a format rarely says which one it wanted.
const ACCEPTED_IMAGE_MIMES: [&str; 4] = ["image/png", "image/jpeg", "image/webp", "image/gif"];

const FALLBACK_MIME: &str = "application/octet-stream";

/// One piece of reference media, loaded and ready to go into a payload.
#[derive(Debug, Clone, PartialEq)]
pub struct MediaInput {
    pub role: InputRole,
    pub asset_id: AssetId,
    /// The name the user gave the asset, not where it lives.
    pub name: String,
    pub bytes: Vec<u8>,
    pub mime: String,
}

impl MediaInput {
    pub fn is_image(&self) -> bool {
        self.mime.starts_with("image/")
    }

    /// The bytes as a data URL, which is how a JSON body carries media.
    pub fn data_url(&self) -> String {
        use base64::Engine;
        format!(
            "data:{};base64,{}",
            self.mime,
            base64::engine::general_purpose::STANDARD.encode(&self.bytes)
        )
    }

    /// A name for a multipart part. The extension follows the bytes, which
    /// after a conversion is not the one the asset was stored with.
    pub fn filename(&self) -> String {
        // An empty name has no extension of its own, so the mime decides.
        let extension = crate::assets::extension_for("", &self.mime);
        format!("{}.{}", crate::assets::slugify(&self.name), extension)
    }
}

/// A request body in named parts.
///
/// Assembled here rather than by the HTTP client, which is built without that
/// feature: the only endpoint needing it takes a handful of fields, and the
/// alternative is a dependency enabled for one call.
pub struct MultipartBody {
    boundary: String,
    body: Vec<u8>,
}

impl MultipartBody {
    pub fn new() -> Self {
        Self {
            // Chosen per body, so a part whose bytes happen to contain the
            // delimiter cannot end the body early.
            boundary: format!("----moka{}", crate::domain::new_id()),
            body: Vec::new(),
        }
    }

    /// A named setting, which is how everything but the media travels.
    pub fn field(mut self, name: &str, value: &str) -> Self {
        self.open_part(name, None, None);
        self.body.extend_from_slice(value.as_bytes());
        self.end_part();
        self
    }

    /// A named piece of media, carrying the name and mime a provider reads
    /// rather than the one the asset was stored under.
    pub fn file(mut self, name: &str, media: &MediaInput) -> Self {
        self.open_part(name, Some(&media.filename()), Some(&media.mime));
        self.body.extend_from_slice(&media.bytes);
        self.end_part();
        self
    }

    /// The finished body and the content type that names its boundary.
    pub fn finish(mut self) -> (Vec<u8>, String) {
        self.body
            .extend_from_slice(format!("--{}--\r\n", self.boundary).as_bytes());
        (
            self.body,
            format!("multipart/form-data; boundary={}", self.boundary),
        )
    }

    fn open_part(&mut self, name: &str, filename: Option<&str>, mime: Option<&str>) {
        let mut head = format!(
            "--{}\r\nContent-Disposition: form-data; name=\"{}\"",
            self.boundary, name
        );
        if let Some(filename) = filename {
            head.push_str(&format!("; filename=\"{filename}\""));
        }
        if let Some(mime) = mime {
            head.push_str(&format!("\r\nContent-Type: {mime}"));
        }
        self.body
            .extend_from_slice(format!("{head}\r\n\r\n").as_bytes());
    }

    fn end_part(&mut self) {
        self.body.extend_from_slice(b"\r\n");
    }
}

impl Default for MultipartBody {
    fn default() -> Self {
        Self::new()
    }
}

/// Turning a window of a stored asset into audio.
///
/// The cutting room owns how a window becomes audio — which program runs, what
/// form it is asked for, where the result lands — and this module asks for a
/// cut rather than knowing any of it. A caller that has none refuses a window
/// rather than sending the file whole: a request that asked about a minute of
/// a recording and was sent two hours of it would be answered about audio
/// nobody asked about.
#[async_trait::async_trait]
pub trait AudioWindow: Send + Sync {
    /// Cuts `window` out of `source`, answering with the audio itself: the
    /// bytes and the mime type that names them. Bytes rather than a path,
    /// because a window may be seconds out of a file of gigabytes, and nothing
    /// beyond the cut has any use for the rest of it.
    async fn cut(
        &self,
        source: &Path,
        window: InputWindow,
    ) -> Result<(Vec<u8>, String), ProviderError>;
}

/// Reads every reference a request names, in the request's own order, so an
/// adapter can rely on position where a role does not tell two inputs apart.
pub async fn load_inputs(
    store: &dyn ProjectStore,
    request: &GenerateRequest,
    budgets: &GenerateConfig,
    audio: Option<&dyn AudioWindow>,
) -> Result<Vec<MediaInput>, ProviderError> {
    let mut loaded = Vec::with_capacity(request.inputs.len());
    for input in &request.inputs {
        let file = store.asset_file(&input.asset_id, None).await?;
        if let Some(window) = input.window {
            loaded.push(cut(input, &file.entry, &file.path, window, budgets, audio).await?);
            continue;
        }
        // Checked against the size recorded at upload, before the read: a
        // reference that cannot be sent should not be copied into memory to
        // discover that. A window is not checked here because what travels is
        // the cut rather than the file, so the file's own weight says nothing
        // about it.
        if let (Some(mime), Some(size)) = (recorded_mime(&file.entry), recorded_size(&file.entry)) {
            refuse_if_over(&file.entry.name, mime, size, budgets)?;
        }
        let bytes = tokio::fs::read(&file.path).await?;
        loaded.push(prepare(input, &file.entry, bytes, budgets)?);
    }
    Ok(loaded)
}

/// One reference that names a window: the window is cut out, and the cut is
/// what travels.
async fn cut(
    input: &GenerateInput,
    entry: &ResourceEntry,
    source: &Path,
    window: InputWindow,
    budgets: &GenerateConfig,
    audio: Option<&dyn AudioWindow>,
) -> Result<MediaInput, ProviderError> {
    let audio = audio.ok_or_else(|| {
        ProviderError::Rejected(format!(
            "{} has to be cut to the window that was asked for, and this machine has no \
             renderer to cut it — install ffmpeg, or detach its sound first",
            entry.name
        ))
    })?;
    let (bytes, mime) = audio.cut(source, window).await?;
    // Bounded after the cut rather than before it, because the file the cut
    // came out of may be far larger than what was asked for.
    let media = MediaInput {
        role: input.role,
        asset_id: input.asset_id.clone(),
        name: entry.name.clone(),
        bytes,
        mime,
    };
    refuse_if_over(&media.name, &media.mime, media.bytes.len() as u64, budgets)?;
    Ok(media)
}

/// Applies the format and size rules to one loaded asset.
fn prepare(
    input: &GenerateInput,
    entry: &ResourceEntry,
    bytes: Vec<u8>,
    budgets: &GenerateConfig,
) -> Result<MediaInput, ProviderError> {
    let mime = send_mime(entry, &bytes);
    let mut media = MediaInput {
        role: input.role,
        asset_id: input.asset_id.clone(),
        name: entry.name.clone(),
        bytes,
        mime,
    };
    // A mask exported from an editor as tiff is still the mask the user meant,
    // so the format is fixed here rather than refused.
    if media.is_image() && !ACCEPTED_IMAGE_MIMES.contains(&media.mime.as_str()) {
        let (converted, mime) = to_png(&media.name, &media.bytes)?;
        media.bytes = converted;
        media.mime = mime;
    }
    // Conversion can grow the payload, so the ceiling is met afterwards too.
    refuse_if_over(&media.name, &media.mime, media.bytes.len() as u64, budgets)?;
    Ok(media)
}

/// Refuses a reference that is too large to send, naming it: a request can
/// carry several, and "too large" alone does not say which one to replace.
fn refuse_if_over(
    name: &str,
    mime: &str,
    bytes: u64,
    budgets: &GenerateConfig,
) -> Result<(), ProviderError> {
    let ceiling = budgets.input_cap_for(modality(mime));
    if bytes > ceiling {
        return Err(ProviderError::Rejected(format!(
            "{name} is {bytes} bytes, over the {ceiling} byte limit for {mime} references"
        )));
    }
    Ok(())
}

/// The family a mime belongs to, which is what sets the ceiling: an image
/// reference inside a video request is still bounded as an image.
fn modality(mime: &str) -> Capability {
    if mime.starts_with("audio/") {
        Capability::Audio
    } else if mime.starts_with("video/") {
        Capability::Video
    } else if mime.starts_with("image/") {
        Capability::Image
    } else {
        Capability::Text
    }
}

/// The mime to send. The upload analysis already sniffed these bytes and
/// recorded the answer, so that record is the authority; the sniff here covers
/// a document that has none, which an imported entry can lack.
fn send_mime(entry: &ResourceEntry, bytes: &[u8]) -> String {
    recorded_mime(entry)
        .map(str::to_string)
        .or_else(|| infer::get(bytes).map(|kind| kind.mime_type().to_string()))
        .unwrap_or_else(|| FALLBACK_MIME.to_string())
}

fn recorded_mime(entry: &ResourceEntry) -> Option<&str> {
    entry
        .probe
        .as_ref()
        .map(|probe| probe.mime.as_str())
        .or(entry.mime.as_deref())
}

fn recorded_size(entry: &ResourceEntry) -> Option<u64> {
    entry
        .probe
        .as_ref()
        .map(|probe| probe.bytes)
        .or(entry.bytes)
        .and_then(|bytes| u64::try_from(bytes).ok())
}

fn to_png(name: &str, bytes: &[u8]) -> Result<(Vec<u8>, String), ProviderError> {
    let decoded = image::load_from_memory(bytes).map_err(|error| {
        ProviderError::Rejected(format!("{name} is not a readable image: {error}"))
    })?;
    let mut encoded: Vec<u8> = Vec::new();
    decoded
        .write_to(
            &mut std::io::Cursor::new(&mut encoded),
            image::ImageFormat::Png,
        )
        .map_err(|error| {
            ProviderError::Rejected(format!("{name} could not be re-encoded as png: {error}"))
        })?;
    Ok((encoded, "image/png".to_string()))
}

/// How a video request uses the images it was given: the frames the shot moves
/// between, and the pictures that ride beside them as references.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct VideoFrames<'a> {
    /// The frame the shot opens on, where one was given.
    pub opening: Option<&'a MediaInput>,
    /// The frame it closes on.
    pub closing: Option<&'a MediaInput>,
    /// What is in the shot rather than where it stands: a look to keep, a
    /// middle of an act to pass through.
    pub references: Vec<&'a MediaInput>,
}

/// Reads a video request's images as the frames it lands on and the references
/// beside them.
///
/// A caller that labelled both ends said what those pictures are for, and the
/// labels are obeyed: the two it named are the frames, and everything given
/// beside them is a reference the shot is asked to keep — an act is filmed
/// this way, opening on its first board and closing on its last with the shots
/// in between travelling as references.
///
/// Where no such pair is labelled there is only the count to go on, and it is
/// the rule a canvas node's pictures follow: one image opens the shot, two
/// open and close it, and three or more are references rather than frames,
/// because no provider takes three frames. The `mode` parameter has the final
/// say either way — a request that asked for references is given references,
/// and nothing else.
pub fn video_frames<'a>(inputs: &'a [MediaInput], request: &GenerateRequest) -> VideoFrames<'a> {
    let images: Vec<&MediaInput> = inputs.iter().filter(|input| input.is_image()).collect();
    if request.text_param("mode").unwrap_or("auto") == "reference" {
        return VideoFrames {
            opening: None,
            closing: None,
            references: images,
        };
    }
    let mut opening: Option<usize> = None;
    let mut closing: Option<usize> = None;
    for (at, image) in images.iter().enumerate() {
        match image.role {
            InputRole::FirstFrame if opening.is_none() => opening = Some(at),
            InputRole::LastFrame if closing.is_none() => closing = Some(at),
            _ => {}
        }
    }
    if let (Some(first), Some(last)) = (opening, closing) {
        let references = images
            .iter()
            .enumerate()
            .filter(|(at, _)| *at != first && *at != last)
            .map(|(_, image)| *image)
            .collect();
        return VideoFrames {
            opening: Some(images[first]),
            closing: Some(images[last]),
            references,
        };
    }
    match images.len() {
        0 => VideoFrames::default(),
        1 => VideoFrames {
            opening: Some(images[0]),
            closing: None,
            references: Vec::new(),
        },
        2 => VideoFrames {
            opening: Some(images[0]),
            closing: Some(images[1]),
            references: Vec::new(),
        },
        _ => VideoFrames {
            opening: None,
            closing: None,
            references: images,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::AssetProbe;

    const ROOMY: u64 = 1024 * 1024;

    /// A registry entry as the upload analysis would have written it, with the
    /// recorded mime left off when the case is about an entry that has none.
    fn entry(name: &str, mime: Option<&str>, bytes: usize) -> ResourceEntry {
        ResourceEntry {
            id: "asset-1".into(),
            name: name.into(),
            path: format!("assets/images/{name}"),
            mime: mime.map(str::to_string),
            bytes: Some(bytes as i64),
            sha256: None,
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
            probe: mime.map(|mime| AssetProbe {
                mime: mime.into(),
                bytes: bytes as i64,
                sha256: String::new(),
                width: None,
                height: None,
                duration_ms: None,
                sample_rate: None,
                channels: None,
                codec_summary: None,
                poster_asset_id: None,
            }),
            provenance: None,
            tags: None,
            note: None,
            favorite: None,
            origin: None,
            keyword: None,
        }
    }

    fn budgets(image: u64, media: u64) -> GenerateConfig {
        GenerateConfig {
            max_image_input_bytes: image,
            max_media_input_bytes: media,
            ..GenerateConfig::default()
        }
    }

    fn reference(asset_id: &str, role: InputRole) -> GenerateInput {
        GenerateInput {
            role,
            asset_id: asset_id.into(),
            window: None,
        }
    }

    fn encoded(format: image::ImageFormat) -> Vec<u8> {
        let mut bytes = Vec::new();
        image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            4,
            3,
            image::Rgb([200, 30, 30]),
        ))
        .write_to(&mut std::io::Cursor::new(&mut bytes), format)
        .expect("the format encodes");
        bytes
    }

    fn prepare_with(
        name: &str,
        mime: Option<&str>,
        bytes: Vec<u8>,
        budget: &GenerateConfig,
    ) -> Result<MediaInput, ProviderError> {
        let size = bytes.len();
        prepare(
            &reference("asset-1", InputRole::Reference),
            &entry(name, mime, size),
            bytes,
            budget,
        )
    }

    #[test]
    fn an_oversized_reference_is_refused_by_name() {
        let png = encoded(image::ImageFormat::Png);
        let error = prepare_with(
            "poster.png",
            Some("image/png"),
            png.clone(),
            &budgets(4, ROOMY),
        )
        .expect_err("four bytes of ceiling cannot hold a png");
        assert_eq!(error.code(), "PROVIDER_BAD_REQUEST");
        // Which of several references to replace is the useful half.
        let message = error.to_string();
        assert!(message.contains("poster.png"), "{message}");
        assert!(message.contains(&png.len().to_string()), "{message}");
    }

    #[test]
    fn the_ceiling_follows_the_family_of_the_reference() {
        let budget = budgets(4, ROOMY);
        assert!(prepare_with(
            "poster.png",
            Some("image/png"),
            encoded(image::ImageFormat::Png),
            &budget
        )
        .is_err());
        // The same ceiling leaves an audio reference alone, which is the point
        // of setting it per reference rather than per request.
        let tone = b"RIFF\x24\x00\x00\x00WAVEfmt ".to_vec();
        let media = prepare_with("tone.wav", Some("audio/wav"), tone.clone(), &budget)
            .expect("an audio reference is not bounded as an image");
        assert_eq!(media.mime, "audio/wav");
        assert_eq!(media.bytes, tone);
    }

    #[test]
    fn a_format_a_provider_cannot_read_is_re_encoded() {
        let tiff = encoded(image::ImageFormat::Tiff);
        let media = prepare_with(
            "mask.tiff",
            Some("image/tiff"),
            tiff,
            &budgets(ROOMY, ROOMY),
        )
        .expect("a decodable image is converted rather than refused");
        assert_eq!(media.mime, "image/png");
        assert_eq!(
            infer::get(&media.bytes).map(|kind| kind.mime_type()),
            Some("image/png")
        );
        // The name still identifies the asset the user picked.
        assert_eq!(media.name, "mask.tiff");
        assert_eq!(media.asset_id, "asset-1");
    }

    #[test]
    fn an_accepted_format_is_sent_untouched() {
        let jpeg = encoded(image::ImageFormat::Jpeg);
        let media = prepare_with(
            "photo.jpg",
            Some("image/jpeg"),
            jpeg.clone(),
            &budgets(ROOMY, ROOMY),
        )
        .expect("a jpeg needs no conversion");
        assert_eq!(media.mime, "image/jpeg");
        assert_eq!(media.bytes, jpeg, "re-encoding would cost quality");
    }

    #[test]
    fn an_image_that_cannot_be_decoded_is_refused_rather_than_sent() {
        let error = prepare_with(
            "drawing.svg",
            Some("image/svg+xml"),
            b"<svg xmlns='http://www.w3.org/2000/svg'/>".to_vec(),
            &budgets(ROOMY, ROOMY),
        )
        .expect_err("a vector image has no pixels to send");
        assert_eq!(error.code(), "PROVIDER_BAD_REQUEST");
        assert!(error.to_string().contains("drawing.svg"));
        assert!(error.to_string().contains("not a readable image"));
    }

    #[test]
    fn a_document_without_a_recorded_mime_falls_back_to_the_bytes() {
        let png = encoded(image::ImageFormat::Png);
        let media = prepare_with("mystery", None, png, &budgets(ROOMY, ROOMY))
            .expect("the sniff supplies the mime");
        assert_eq!(media.mime, "image/png");

        // Neither a record nor a sniff: sent as it is, and bounded as the
        // smallest family.
        let media = prepare_with("notes", None, b"hello".to_vec(), &budgets(ROOMY, ROOMY))
            .expect("an unknown payload is still sendable");
        assert_eq!(media.mime, "application/octet-stream");
    }

    #[test]
    fn a_payload_is_shaped_for_the_body_it_travels_in() {
        let media = MediaInput {
            role: InputRole::Mask,
            asset_id: "asset-1".into(),
            name: "Mask Art.tiff".into(),
            bytes: vec![0x89, 0x50, 0x4e, 0x47],
            mime: "image/png".into(),
        };
        assert_eq!(media.data_url(), "data:image/png;base64,iVBORw==");
        // The extension follows the bytes rather than the stored name: after a
        // conversion the two disagree, and a part named .tiff carrying png is
        // refused by the endpoints that check.
        assert_eq!(media.filename(), "mask-art.png");
    }

    #[test]
    fn a_multipart_body_names_its_own_boundary() {
        let media = MediaInput {
            role: InputRole::Reference,
            asset_id: "asset-1".into(),
            name: "Cat Photo.png".into(),
            bytes: b"png-bytes".to_vec(),
            mime: "image/png".into(),
        };
        let (body, content_type) = MultipartBody::new()
            .field("model", "an-image-model")
            .file("image", &media)
            .finish();

        let boundary = content_type
            .strip_prefix("multipart/form-data; boundary=")
            .expect("the content type names the boundary");
        let text = String::from_utf8(body).expect("every part here is text");
        for expected in [
            format!("--{boundary}\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\nan-image-model\r\n"),
            format!("--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"cat-photo.png\"\r\nContent-Type: image/png\r\n\r\npng-bytes\r\n"),
            format!("--{boundary}--\r\n"),
        ] {
            assert!(text.contains(&expected), "missing {expected:?} in {text:?}");
        }
    }

    fn media_input(asset_id: &str, role: InputRole, mime: &str) -> MediaInput {
        MediaInput {
            role,
            asset_id: asset_id.into(),
            name: format!("{asset_id}.png"),
            bytes: vec![1],
            mime: mime.into(),
        }
    }

    fn video_request(mode: Option<&str>) -> GenerateRequest {
        let mut params = serde_json::Map::new();
        if let Some(mode) = mode {
            params.insert("mode".into(), mode.into());
        }
        GenerateRequest {
            capability: Capability::Video,
            params,
            ..GenerateRequest::default()
        }
    }

    /// The asset a frame names, for assertions that read like the request.
    fn named(frame: Option<&MediaInput>) -> Option<&str> {
        frame.map(|input| input.asset_id.as_str())
    }

    fn names<'a>(frames: &[&'a MediaInput]) -> Vec<&'a str> {
        frames.iter().map(|input| input.asset_id.as_str()).collect()
    }

    #[test]
    fn a_labelled_pair_of_ends_are_the_frames_a_shot_lands_on() {
        let inputs = vec![
            media_input("first", InputRole::FirstFrame, "image/png"),
            media_input("middle", InputRole::Reference, "image/png"),
            media_input("last", InputRole::LastFrame, "image/png"),
        ];
        let frames = video_frames(&inputs, &video_request(None));
        // An act is filmed this way: the shots in between are asked for as
        // references, and the ends stay the frames they were labelled as.
        assert_eq!(named(frames.opening), Some("first"));
        assert_eq!(named(frames.closing), Some("last"));
        assert_eq!(names(&frames.references), ["middle"]);
    }

    #[test]
    fn what_a_request_does_without_labelled_ends_is_settled_by_the_count() {
        let frame = |id: &str| media_input(id, InputRole::Reference, "image/png");
        assert_eq!(
            video_frames(&[], &video_request(None)),
            VideoFrames::default()
        );

        let only = [frame("a")];
        let one = video_frames(&only, &video_request(None));
        assert_eq!(named(one.opening), Some("a"));
        assert!(one.closing.is_none(), "one image is one end of the shot");

        let pair = [frame("a"), frame("b")];
        let two = video_frames(&pair, &video_request(None));
        assert_eq!(named(two.opening), Some("a"));
        assert_eq!(named(two.closing), Some("b"));
        assert!(two.references.is_empty());

        // No provider takes three frames, so three pictures with no end among
        // them are references rather than frames, in the order they were given.
        let several = [frame("a"), frame("b"), frame("c")];
        let referenced = video_frames(&several, &video_request(Some("frames")));
        assert!(referenced.opening.is_none() && referenced.closing.is_none());
        assert_eq!(names(&referenced.references), ["a", "b", "c"]);

        // An unrecognised mode is treated as the automatic one rather than
        // refused here; parameter values are the validator's business.
        let turbo = video_frames(&only, &video_request(Some("turbo")));
        assert_eq!(named(turbo.opening), Some("a"));
    }

    #[test]
    fn a_request_that_asked_for_references_is_given_references_only() {
        let inputs = vec![
            media_input("first", InputRole::FirstFrame, "image/png"),
            media_input("extra", InputRole::Reference, "image/png"),
            media_input("last", InputRole::LastFrame, "image/png"),
        ];
        let frames = video_frames(&inputs, &video_request(Some("reference")));
        assert!(frames.opening.is_none() && frames.closing.is_none());
        assert_eq!(names(&frames.references), ["first", "extra", "last"]);
    }

    #[test]
    fn a_piece_of_media_that_is_not_a_picture_is_no_frame_of_a_shot() {
        let inputs = vec![
            media_input("voice", InputRole::ControlAudio, "audio/wav"),
            media_input("first", InputRole::FirstFrame, "image/png"),
        ];
        let frames = video_frames(&inputs, &video_request(None));
        assert_eq!(named(frames.opening), Some("first"));
        assert!(frames.references.is_empty(), "{:?}", frames.references);
    }
}
