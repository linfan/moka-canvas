/**
 * SRT as pure data: a subtitle file read in, written back out, and asked
 * where its cues collide.
 *
 * The format is a sequence of blocks — an optional number line, a time line,
 * and the words — separated by blank lines. What a file in the wild says about
 * itself is not always what the format promises, so the reading is tolerant
 * where tolerance costs nothing: a byte-order mark, either line ending, dotted
 * milliseconds, a number line that is missing or wrong, coordinates pinned to
 * the time line, and the styling tags a subtitle tool leaves in the words. A
 * block that still makes no sense is skipped and counted rather than taking
 * the rest of the file down with it, and a file that yields no cue at all is
 * not a subtitle file.
 *
 * A cue carries only what the timeline needs: when it starts, when it ends,
 * and what it says. Nothing here touches a document or a store — the rules
 * are read and tested on their own.
 */

export interface SrtCue {
  startMs: number;
  endMs: number;
  text: string;
}

export type SrtParseResult =
  | { ok: true; cues: SrtCue[]; skipped: number }
  | { ok: false; message: string };

/** What a file with nothing to say is told. */
export const NO_CUES_MESSAGE = "No subtitles found in the file.";

/** `HH:MM:SS,mmm`, with dotted milliseconds accepted for the comma. */
const TIME_LINE =
  /(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})/;

/** Whitespace on its own separates blocks, however a file spelled it. */
const BLANK = /^[ \t]*$/;

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/** Milliseconds as a clock reading; hours grow past two digits rather than wrap. */
export function srtTime(ms: number): string {
  const total = Math.max(0, Math.round(Number.isFinite(ms) ? ms : 0));
  const seconds = Math.floor(total / 1_000);
  return `${pad(Math.floor(seconds / 3_600), 2)}:${pad(Math.floor(seconds / 60) % 60, 2)}:${pad(seconds % 60, 2)},${pad(total % 1_000, 3)}`;
}

/** A whole number of milliseconds out of the fields of one timestamp. */
function timestampMs(
  hours: string,
  minutes: string,
  seconds: string,
  fraction: string,
): number {
  const scale = 10 ** (3 - fraction.length);
  return (
    ((Number(hours) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1_000 +
    Number(fraction) * scale
  );
}

/** The words of a block with the styling tags taken out. */
function stripTags(line: string): string {
  return line.replace(/<[^>]*>/g, "");
}

/**
 * Every cue a subtitle file holds, and how many blocks were dropped.
 *
 * Blocks are read between blank lines; within one, the first line that reads
 * as a time line is the cue's, everything before it is the (ignored) number
 * line, and the lines after it are the words. A block with no time line, or
 * with no words left once the tags are off, is skipped and counted.
 */
export function parseSrt(text: string): SrtParseResult {
  // A BOM is the file's business, not the first cue's.
  const withoutBom = text.replace(/^\uFEFF/, "");
  const lines = withoutBom.split(/\r\n|\r|\n/);
  const cues: SrtCue[] = [];
  let skipped = 0;
  let block: string[] = [];

  const readBlock = (): void => {
    if (block.length === 0) return;
    const times = block.findIndex((line) => TIME_LINE.test(line));
    if (times < 0) {
      skipped += 1;
      return;
    }
    const match = TIME_LINE.exec(block[times]);
    if (!match) {
      skipped += 1;
      return;
    }
    const startMs = timestampMs(match[1], match[2], match[3], match[4]);
    const endMs = timestampMs(match[5], match[6], match[7], match[8]);
    const content = block
      .slice(times + 1)
      .map(stripTags)
      .join("\n")
      .trim();
    if (content.length === 0) {
      skipped += 1;
      return;
    }
    cues.push({ startMs, endMs, text: content });
  };

  for (const line of lines) {
    if (BLANK.test(line)) {
      readBlock();
      block = [];
    } else {
      block.push(line);
    }
  }
  readBlock();

  if (cues.length === 0) return { ok: false, message: NO_CUES_MESSAGE };
  return { ok: true, cues, skipped };
}

/**
 * The first two cues that hold the same moment, in start order, or null.
 *
 * Touching end-to-start is not an overlap: two cues that meet hold different
 * moments, which is how a subtitle track is normally laid out. Only adjacent
 * cues in start order are compared — one that overlaps a later cue always
 * overlaps the one between them first.
 */
export function firstOverlap(cues: readonly SrtCue[]): [SrtCue, SrtCue] | null {
  const ordered = [...cues].sort((a, b) => a.startMs - b.startMs);
  for (let i = 0; i + 1 < ordered.length; i += 1) {
    const a = ordered[i];
    const b = ordered[i + 1];
    if (a.startMs < b.endMs && b.startMs < a.endMs) return [a, b];
  }
  return null;
}

/**
 * The cues written back out: sorted by their start, numbered from one,
 * `HH:MM:SS,mmm` on both sides of the arrow, and a cue's own newlines kept.
 */
export function serializeSrt(cues: readonly SrtCue[]): string {
  return [...cues]
    .sort((a, b) => a.startMs - b.startMs)
    .map(
      (cue, index) =>
        `${index + 1}\n${srtTime(cue.startMs)} --> ${srtTime(cue.endMs)}\n${cue.text}`,
    )
    .join("\n\n")
    .concat("\n");
}

/** The first cue of a clip: its own times are what a timeline clip knows. */
export function cueOfClip(clip: {
  startMs: number;
  durationMs: number;
  text?: { content: string };
}): SrtCue {
  return {
    startMs: clip.startMs,
    endMs: clip.startMs + clip.durationMs,
    text: clip.text?.content ?? "",
  };
}
