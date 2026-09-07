//! Bounded, allocation-free-ish parsers that extract display metadata from
//! already-sniffed audio/video bytes. Every parser is total: malformed input
//! yields `None` fields, never an error — a broken file must still import so
//! the user can see and remove it.

/// Metadata fields a probe may fill; all optional.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct MediaFields {
    pub duration_ms: Option<i64>,
    pub sample_rate: Option<i32>,
    pub channels: Option<i32>,
    pub codec_summary: Option<String>,
    pub width: Option<i32>,
    pub height: Option<i32>,
}

pub fn probe_media(mime: &str, bytes: &[u8]) -> MediaFields {
    match mime {
        "audio/x-wav" | "audio/wav" | "audio/wave" => probe_wav(bytes),
        "audio/mpeg" => probe_mp3(bytes),
        "video/mp4" | "video/quicktime" | "audio/mp4" | "audio/x-m4a" | "video/x-m4v" => {
            probe_mp4(bytes)
        }
        _ => MediaFields::default(),
    }
}

fn be_u32(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes([
        *bytes.get(at)?,
        *bytes.get(at + 1)?,
        *bytes.get(at + 2)?,
        *bytes.get(at + 3)?,
    ]))
}

fn be_u64(bytes: &[u8], at: usize) -> Option<u64> {
    Some(u64::from_be_bytes([
        *bytes.get(at)?,
        *bytes.get(at + 1)?,
        *bytes.get(at + 2)?,
        *bytes.get(at + 3)?,
        *bytes.get(at + 4)?,
        *bytes.get(at + 5)?,
        *bytes.get(at + 6)?,
        *bytes.get(at + 7)?,
    ]))
}

fn le_u16(bytes: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes([*bytes.get(at)?, *bytes.get(at + 1)?]))
}

fn le_u32(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes([
        *bytes.get(at)?,
        *bytes.get(at + 1)?,
        *bytes.get(at + 2)?,
        *bytes.get(at + 3)?,
    ]))
}

/// RIFF/WAVE: `fmt ` chunk carries channels/sample-rate/byte-rate, `data`
/// chunk size divided by byte-rate yields the duration.
fn probe_wav(bytes: &[u8]) -> MediaFields {
    let mut fields = MediaFields::default();
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return fields;
    }
    let mut offset = 12usize;
    let mut data_size: Option<u32> = None;
    let mut byte_rate: Option<u32> = None;
    // Chunks are word-aligned; sizes above the remaining buffer end the walk.
    while offset + 8 <= bytes.len() {
        let id = &bytes[offset..offset + 4];
        let Some(size) = le_u32(bytes, offset + 4) else {
            break;
        };
        let body = offset + 8;
        if id == b"fmt " && body + 16 <= bytes.len() {
            fields.channels = le_u16(bytes, body + 2).map(|v| v as i32);
            fields.sample_rate = le_u32(bytes, body + 4).map(|v| v as i32);
            byte_rate = le_u32(bytes, body + 8);
        } else if id == b"data" {
            data_size = Some(size);
        }
        let advance = 8usize + size as usize + (size as usize % 2);
        match offset.checked_add(advance) {
            Some(next) if next <= bytes.len() => offset = next,
            _ => break,
        }
    }
    if let (Some(data), Some(rate)) = (data_size, byte_rate) {
        if rate > 0 {
            fields.duration_ms = Some((data as u64 * 1000 / rate as u64) as i64);
        }
    }
    fields.codec_summary = Some("PCM".to_string());
    fields
}

const MP3_BITRATES: [u32; 16] = [
    0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
];
const MP3_SAMPLE_RATES: [u32; 4] = [44100, 48000, 32000, 0];

/// MPEG audio: skip an ID3v2 tag, read the first synced frame header for
/// sample rate/channels, and estimate duration from size and bitrate.
fn probe_mp3(bytes: &[u8]) -> MediaFields {
    let mut fields = MediaFields::default();
    let mut offset = 0usize;
    if bytes.len() >= 10 && &bytes[0..3] == b"ID3" {
        let size = bytes[6..10]
            .iter()
            .fold(0usize, |acc, b| (acc << 7) | (b & 0x7f) as usize);
        offset = 10 + size;
    }
    // Scan a bounded window for a frame sync to tolerate stray bytes.
    let scan_end = bytes.len().saturating_sub(4).min(offset + 4096);
    let mut header = None;
    let mut at = offset;
    while at < scan_end {
        if bytes[at] == 0xff && bytes[at + 1] & 0xe0 == 0xe0 {
            header = be_u32(bytes, at);
            break;
        }
        at += 1;
    }
    let Some(header) = header else { return fields };
    let version = (header >> 19) & 0x3;
    let layer = (header >> 17) & 0x3;
    let bitrate_index = ((header >> 12) & 0xf) as usize;
    let rate_index = ((header >> 10) & 0x3) as usize;
    let mode = (header >> 6) & 0x3;
    if version == 1 || layer == 0 {
        return fields;
    }
    let mut sample_rate = MP3_SAMPLE_RATES[rate_index];
    if sample_rate == 0 {
        return fields;
    }
    // MPEG 2/2.5 halve/quarter the rate; Layer III bitrate table is shared
    // here as an estimate — display metadata, not a decoder.
    if version == 2 {
        sample_rate /= 2;
    } else if version == 0 {
        sample_rate /= 4;
    }
    let bitrate = MP3_BITRATES[bitrate_index];
    fields.sample_rate = Some(sample_rate as i32);
    fields.channels = Some(if mode == 3 { 1 } else { 2 });
    fields.codec_summary = Some(format!(
        "MPEG{} Layer {}",
        match version {
            3 => 1,
            2 => 2,
            _ => 25,
        },
        4 - layer
    ));
    if bitrate > 0 {
        let payload = bytes.len().saturating_sub(offset) as u64;
        fields.duration_ms = Some((payload * 8 * 1000 / (bitrate as u64 * 1000)) as i64);
    }
    fields
}

fn fourcc(bytes: &[u8], at: usize) -> Option<&str> {
    let raw = bytes.get(at..at + 4)?;
    std::str::from_utf8(raw).ok()
}

/// ISO BMFF (MP4/MOV): walk the box tree for `mvhd` (duration), the first
/// video `tkhd` (dimensions), and `stsd` sample entries (codec summary).
/// Depth and box count are bounded so hostile size fields cannot loop us.
fn probe_mp4(bytes: &[u8]) -> MediaFields {
    let mut fields = MediaFields::default();
    let mut stack: Vec<(usize, usize, u32)> = vec![(0, bytes.len(), 0)];
    let mut visited = 0usize;
    let mut mvhd: Option<(u64, u64)> = None;
    let mut codecs: Vec<String> = Vec::new();
    let mut dims: Option<(i32, i32)> = None;
    let mut tkhd_is_video = false;

    while let Some((mut at, end, depth)) = stack.pop() {
        while at + 8 <= end && visited < 512 {
            visited += 1;
            let Some(size32) = be_u32(bytes, at) else {
                break;
            };
            let Some(kind) = fourcc(bytes, at + 4) else {
                break;
            };
            let (size, header) = if size32 == 1 {
                match be_u64(bytes, at + 8) {
                    Some(ext) => (ext, 16usize),
                    None => break,
                }
            } else if size32 == 0 {
                ((end - at) as u64, 8usize)
            } else {
                (size32 as u64, 8usize)
            };
            if size < header as u64 || at + size as usize > end {
                break;
            }
            let body = at + header;
            match kind {
                "moov" | "trak" | "mdia" | "minf" | "stbl" if depth < 6 => {
                    stack.push((body, at + size as usize, depth + 1));
                }
                "mvhd" if body + 4 <= end => {
                    let version = bytes[body];
                    let parsed = if version == 1 {
                        be_u32(bytes, body + 20).zip(be_u64(bytes, body + 24))
                    } else {
                        be_u32(bytes, body + 12).zip(be_u32(bytes, body + 16).map(|v| v as u64))
                    };
                    if let Some((timescale, duration)) = parsed {
                        mvhd = Some((timescale as u64, duration));
                    }
                }
                "tkhd" if body + 4 <= end => {
                    let version = bytes[body];
                    let wh_at = if version == 1 { body + 88 } else { body + 76 };
                    if let (Some(w), Some(h)) = (
                        be_u32(bytes, wh_at).map(|v| v >> 16),
                        be_u32(bytes, wh_at + 4).map(|v| v >> 16),
                    ) {
                        if w > 0 && h > 0 && dims.is_none() {
                            dims = Some((w as i32, h as i32));
                            tkhd_is_video = true;
                        }
                    }
                }
                "stsd" if body + 16 <= end => {
                    if let Some(codec) = fourcc(bytes, body + 12) {
                        if !codec.trim_matches('\0').is_empty() && codecs.len() < 4 {
                            codecs.push(codec.to_string());
                        }
                    }
                }
                _ => {}
            }
            at += size as usize;
        }
    }

    if let Some((timescale, duration)) = mvhd {
        fields.duration_ms = duration
            .checked_mul(1000)
            .and_then(|ms| ms.checked_div(timescale))
            .map(|ms| ms as i64);
    }
    if tkhd_is_video {
        fields.width = dims.map(|d| d.0);
        fields.height = dims.map(|d| d.1);
    }
    if !codecs.is_empty() {
        fields.codec_summary = Some(codecs.join(", "));
    }
    fields
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wav_bytes(channels: u16, sample_rate: u32, byte_rate: u32, data_size: u32) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36u32 + data_size).to_le_bytes());
        bytes.extend_from_slice(b"WAVE");
        bytes.extend_from_slice(b"fmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes()); // PCM tag
        bytes.extend_from_slice(&channels.to_le_bytes());
        bytes.extend_from_slice(&sample_rate.to_le_bytes());
        bytes.extend_from_slice(&byte_rate.to_le_bytes());
        bytes.extend_from_slice(&4u16.to_le_bytes()); // block align
        bytes.extend_from_slice(&16u16.to_le_bytes()); // bits
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&data_size.to_le_bytes());
        bytes.resize(bytes.len() + data_size as usize, 0);
        bytes
    }

    #[test]
    fn wav_probe_reads_fmt_and_duration() {
        // 1 second of 16-bit stereo 44.1kHz audio: byte_rate * 1s of data.
        let bytes = wav_bytes(2, 44100, 176400, 176400);
        let fields = probe_wav(&bytes);
        assert_eq!(fields.channels, Some(2));
        assert_eq!(fields.sample_rate, Some(44100));
        assert_eq!(fields.duration_ms, Some(1000));
        assert_eq!(fields.codec_summary.as_deref(), Some("PCM"));
    }

    #[test]
    fn wav_probe_tolerates_truncation() {
        let bytes = wav_bytes(2, 44100, 176400, 1000);
        let truncated = &bytes[..20];
        let fields = probe_wav(truncated);
        assert_eq!(fields.duration_ms, None);
    }

    fn mp3_frame_header() -> Vec<u8> {
        // MPEG1 Layer III, 128 kbps, 44100 Hz, stereo.
        let header: u32 = 0xff000000
            | (0x7 << 21) // sync continuation
            | (0x3 << 19) // MPEG1
            | (0x1 << 17) // Layer III
            | (1 << 16) // no CRC
            | (9 << 12); // 128 kbps; 44100 Hz + channel-mode bits stay zero
        let mut bytes = header.to_be_bytes().to_vec();
        bytes.resize(4 + 128_000, 0); // 8s at 128 kbps after the header
        bytes
    }

    #[test]
    fn mp3_probe_reads_header_and_estimates_duration() {
        let bytes = mp3_frame_header();
        let fields = probe_mp3(&bytes);
        assert_eq!(fields.sample_rate, Some(44100));
        assert_eq!(fields.channels, Some(2));
        assert_eq!(fields.codec_summary.as_deref(), Some("MPEG1 Layer 3"));
        let duration = fields.duration_ms.expect("duration estimated");
        assert!((7900..=8100).contains(&duration), "duration {duration}");
    }

    #[test]
    fn mp3_probe_skips_id3_tag() {
        let mut bytes = b"ID3\x04\x00\x00\x00\x00\x00\x05".to_vec();
        bytes.extend_from_slice(&[0u8; 5]);
        bytes.extend_from_slice(&mp3_frame_header());
        let fields = probe_mp3(&bytes);
        assert_eq!(fields.sample_rate, Some(44100));
    }

    fn mp4_box(kind: &str, body: &[u8]) -> Vec<u8> {
        let mut bytes = ((body.len() + 8) as u32).to_be_bytes().to_vec();
        bytes.extend_from_slice(kind.as_bytes());
        bytes.extend_from_slice(body);
        bytes
    }

    #[test]
    fn mp4_probe_reads_mvhd_tkhd_and_stsd() {
        let mut mvhd = vec![0u8; 4]; // version 0 + flags
        mvhd.extend_from_slice(&0u32.to_be_bytes()); // created
        mvhd.extend_from_slice(&0u32.to_be_bytes()); // modified
        mvhd.extend_from_slice(&1000u32.to_be_bytes()); // timescale
        mvhd.extend_from_slice(&5420u32.to_be_bytes()); // duration → 5.42s

        let mut tkhd = vec![0u8; 4];
        tkhd.extend_from_slice(&0u32.to_be_bytes()); // created
        tkhd.extend_from_slice(&0u32.to_be_bytes()); // modified
        tkhd.extend_from_slice(&0u32.to_be_bytes()); // track id
        tkhd.extend_from_slice(&0u32.to_be_bytes()); // reserved
        tkhd.extend_from_slice(&0u32.to_be_bytes()); // duration
        tkhd.extend_from_slice(&0u64.to_be_bytes()); // reserved
        tkhd.extend_from_slice(&[0u8; 8]); // layer, alt group, volume, reserved
        tkhd.extend_from_slice(&[0u8; 36]); // matrix
        tkhd.extend_from_slice(&(1920u32 << 16).to_be_bytes());
        tkhd.extend_from_slice(&(1080u32 << 16).to_be_bytes());

        let mut stsd = vec![0u8; 8]; // version/flags + entry count
        stsd.extend_from_slice(&16u32.to_be_bytes());
        stsd.extend_from_slice(b"avc1");

        let trak = mp4_box("trak", &mp4_box("tkhd", &tkhd));
        let mut moov_body = mp4_box("mvhd", &mvhd);
        moov_body.extend_from_slice(&trak);
        moov_body.extend_from_slice(&mp4_box(
            "mdia",
            &mp4_box("minf", &mp4_box("stbl", &mp4_box("stsd", &stsd))),
        ));
        let mut file = mp4_box("ftyp", b"isom\x00\x00\x00\x01isom");
        file.extend_from_slice(&mp4_box("moov", &moov_body));

        let fields = probe_mp4(&file);
        assert_eq!(fields.duration_ms, Some(5420));
        assert_eq!(fields.width, Some(1920));
        assert_eq!(fields.height, Some(1080));
        assert_eq!(fields.codec_summary.as_deref(), Some("avc1"));
    }

    #[test]
    fn mp4_probe_survives_garbage() {
        let fields = probe_mp4(b"not a real mp4 at all");
        assert_eq!(fields, MediaFields::default());
    }
}
