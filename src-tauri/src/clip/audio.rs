//! Cutting a window out of a recording.
//!
//! The cutting room already knows where the renderer is and how to run it;
//! what this adds is the one job a caller outside the room needs: hearing a
//! minute of a file without reading the rest of it.
//!
//! What comes out is 16 kHz mono PCM in a WAV container, which is what a
//! speech recognizer is built to read and what keeps an hour of speech under
//! two hundred megabytes. Both halves matter: a video's audio track is what
//! this is usually asked for, and no recognizer takes a video container.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use crate::generate::error::ProviderError;
use crate::generate::media::AudioWindow;
use crate::generate::InputWindow;

use super::locate::CapabilityProbe;
use super::runner::{tail_message, MESSAGE_LIMIT};

/// How long one cut may take. Generous for a window of seconds, because the
/// seek into a long file still has to find the frame it starts at.
const CUT_TIMEOUT: Duration = Duration::from_secs(300);

/// What a recognizer reads: one channel at sixteen thousand samples a second.
const SAMPLE_RATE: u32 = 16_000;

const FORMAT: &str = "wav";
const MIME: &str = "audio/wav";

/// The cutting room's answer to [`AudioWindow`], placed with the renderer the
/// deployment already uses.
pub struct Windows {
    probe: Arc<CapabilityProbe>,
}

impl Windows {
    pub fn new(probe: Arc<CapabilityProbe>) -> Self {
        Self { probe }
    }
}

#[async_trait::async_trait]
impl AudioWindow for Windows {
    async fn cut(
        &self,
        source: &Path,
        window: InputWindow,
    ) -> Result<(Vec<u8>, String), ProviderError> {
        let program = self.probe.program().ok_or_else(|| {
            ProviderError::Rejected(
                "no ffmpeg is available to cut the audio out of this recording; \
                 attach its audio to a track first, or install ffmpeg"
                    .to_string(),
            )
        })?;
        // A file of this process's own making, in the temp directory, named
        // after nothing the caller chose.
        let cut =
            std::env::temp_dir().join(format!("moka-window-{}.{FORMAT}", crate::domain::new_id()));
        let outcome = run(program, source, window, &cut).await;
        // Read before the file is removed, and removed either way: a failed
        // cut must not leave a file behind any more than a good one may.
        let bytes = outcome.and_then(|()| {
            std::fs::read(&cut).map_err(|error| {
                ProviderError::Rejected(format!(
                    "the audio cut out of {} could not be read: {error}",
                    source.display()
                ))
            })
        });
        let _ = std::fs::remove_file(&cut);
        Ok((bytes?, MIME.to_string()))
    }
}

/// Runs one cut and waits for it.
async fn run(
    program: &Path,
    source: &Path,
    window: InputWindow,
    into: &Path,
) -> Result<(), ProviderError> {
    let args = cut_args(source, window, into);
    let output = tokio::time::timeout(
        CUT_TIMEOUT,
        tokio::process::Command::new(program)
            .args(&args)
            .stdin(std::process::Stdio::null())
            .output(),
    )
    .await
    .map_err(|_| {
        ProviderError::Rejected(format!(
            "cutting the audio out of {} took longer than {} seconds",
            source.display(),
            CUT_TIMEOUT.as_secs()
        ))
    })?
    .map_err(|error| ProviderError::Unreachable(format!("could not run ffmpeg: {error}")))?;
    if output.status.success() {
        return Ok(());
    }
    let said = String::from_utf8_lossy(&output.stderr);
    Err(ProviderError::Rejected(format!(
        "ffmpeg could not cut the audio out of {}: {}",
        source.display(),
        tail_message(said.trim(), MESSAGE_LIMIT)
    )))
}

/// The command one cut is placed with.
///
/// The seek comes before the input, which is what keeps ffmpeg from decoding a
/// long recording from its head to reach a window near the end of it. The
/// output format is named outright rather than left to the file's extension,
/// because the file this writes is a temporary one this process named.
pub fn cut_args(source: &Path, window: InputWindow, into: &Path) -> Vec<String> {
    vec![
        "-nostdin".into(),
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-y".into(),
        "-ss".into(),
        seconds(window.start_ms),
        "-t".into(),
        seconds(window.duration_ms),
        "-i".into(),
        source.to_string_lossy().into_owned(),
        // No picture: the file may be a video, and what is wanted is its
        // sound. Mono at sixteen thousand, which is what speech needs.
        "-vn".into(),
        "-ac".into(),
        "1".into(),
        "-ar".into(),
        SAMPLE_RATE.to_string(),
        "-c:a".into(),
        "pcm_s16le".into(),
        "-f".into(),
        FORMAT.into(),
        into.to_string_lossy().into_owned(),
    ]
}

/// A millisecond count as ffmpeg reads it: seconds, with a decimal point when
/// there is a fraction of one to keep.
fn seconds(ms: u64) -> String {
    let whole = ms / 1_000;
    let part = ms % 1_000;
    if part == 0 {
        whole.to_string()
    } else {
        format!("{whole}.{part:03}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window() -> InputWindow {
        InputWindow {
            start_ms: 1_500,
            duration_ms: 2_250,
        }
    }

    #[test]
    fn a_window_is_asked_for_by_seeking_before_the_input() {
        let args = cut_args(
            Path::new("/projects/a/clip.mp4"),
            window(),
            Path::new("/tmp/cut.wav"),
        );
        let seek = args.iter().position(|arg| arg == "-ss").expect("a seek");
        let input = args.iter().position(|arg| arg == "-i").expect("an input");
        assert!(
            seek < input,
            "seeking after the input would decode the whole recording first: {args:?}"
        );
        assert_eq!(args[seek + 1], "1.500");
        assert_eq!(args[input + 1], "/projects/a/clip.mp4");
        assert_eq!(
            args[args.iter().position(|a| a == "-t").unwrap() + 1],
            "2.250"
        );
    }

    #[test]
    fn the_sound_is_taken_and_the_picture_is_not() {
        let args = cut_args(Path::new("in.mov"), window(), Path::new("out.wav"));
        assert!(args.contains(&"-vn".to_string()));
        assert_eq!(args[args.iter().position(|a| a == "-ac").unwrap() + 1], "1");
        assert_eq!(
            args[args.iter().position(|a| a == "-ar").unwrap() + 1],
            "16000"
        );
        assert_eq!(
            args[args.iter().position(|a| a == "-c:a").unwrap() + 1],
            "pcm_s16le"
        );
        assert_eq!(args.last().unwrap(), "out.wav");
    }

    #[test]
    fn a_time_is_written_with_the_milliseconds_ffmpeg_reads_as_milliseconds() {
        assert_eq!(seconds(0), "0");
        assert_eq!(seconds(2_000), "2");
        // Three digits always: "2.25" would be read as a fraction of a second
        // just the same, and saying so plainly costs nothing.
        assert_eq!(seconds(2_250), "2.250");
        assert_eq!(seconds(7), "0.007");
    }
}
