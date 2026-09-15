/**
 * The clock the timeline reads in.
 *
 * Frames come from rounding rather than truncating: a playhead parked at
 * 1.016s is on the frame that is 1.016s, which at 30fps is the next second's
 * first frame and not the one before it. Ruler labels only ever show what a
 * tick is on: whole seconds as `mm:ss` (hours added past an hour), anything
 * finer as the frame it falls on.
 */

/** The rate a document's clock is counted at, held to whole frames. */
function frameRate(fps: number): number {
  return Number.isFinite(fps) && fps > 0 ? Math.round(fps) : 30;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** A moment as `hh:mm:ss:ff`. */
export function formatTimecode(ms: number, fps: number): string {
  const rate = frameRate(fps);
  const total = Math.max(0, Math.round((ms / 1_000) * rate));
  const frames = total % rate;
  const seconds = Math.floor(total / rate);
  return [
    pad(Math.floor(seconds / 3_600)),
    pad(Math.floor(seconds / 60) % 60),
    pad(seconds % 60),
    pad(frames),
  ].join(":");
}

/**
 * A reading of the clock turned back into a moment.
 *
 * The mirror of `formatTimecode`, and the fields of a shorter reading are the
 * ones on the right with the frames left off: `1:5` is a minute and five
 * seconds, and frames are only read when all four fields are written, since a
 * cut's clock is read from its seconds outwards. A reading that is not a
 * timecode - letters, frames past the rate, a minute or second past the one
 * above it - answers null rather than a guess, so a typist is shown the field
 * going red instead of a clip jumping somewhere they did not ask for.
 */
export function parseTimecode(text: string, fps: number): number | null {
  const rate = frameRate(fps);
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const fields = trimmed.split(":");
  if (fields.length > 4) return null;
  const numbers: number[] = [];
  for (const field of fields) {
    if (!/^\d{1,4}$/.test(field)) return null;
    numbers.push(Number(field));
  }
  if (numbers.length === 4) {
    const [hh, mm, ss, ff] = numbers;
    if (ff >= rate || ss >= 60 || mm >= 60) return null;
    return ((hh * 60 + mm) * 60 + ss) * 1_000 + Math.round((ff / rate) * 1_000);
  }
  // Shorter readings carry no frames: the fields given are the seconds,
  // minutes and hours, and the ones left off the left are zero.
  const [ss = 0, mm = 0, hh = 0] = [...numbers].reverse();
  if (ss >= 60 || mm >= 60) return null;
  return ((hh * 60 + mm) * 60 + ss) * 1_000;
}

/**
 * The frame a moment falls on, by rounding, as whole milliseconds.
 *
 * The clock `formatTimecode` reads a moment with: rounding rather than
 * truncating, so a click at 1.016s is the next second's first frame and not
 * the one before it. Clicks and playheads are put on this clock before they
 * become clip geometry, and the document's times are whole milliseconds, so
 * the answer is rounded to one.
 */
export function frameAligned(ms: number, fps: number): number {
  const rate = frameRate(fps);
  const frame = Math.max(0, Math.round((ms / 1_000) * rate));
  return Math.round((frame / rate) * 1_000);
}

/** A tick's label: a second reads as a clock, part of one as its frame. */
export function formatTickLabel(ms: number, fps: number): string {
  const rate = frameRate(fps);
  const total = Math.max(0, Math.round((ms / 1_000) * rate));
  if (total % rate !== 0) return `${total % rate}f`;
  const seconds = total / rate;
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor(seconds / 60) % 60;
  const rest = seconds % 60;
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(rest)}`
    : `${pad(minutes)}:${pad(rest)}`;
}

/**
 * A moment a whole number of frames from another, on the frame clock.
 *
 * The arrow keys walk by these: the frame a moment rounds to is stepped and
 * the answer put back on the clock, so a run of steps lands frame by frame
 * rather than drifting on the millisecond. A step before the head is the head.
 */
export function stepFrames(ms: number, fps: number, frames: number): number {
  const rate = frameRate(fps);
  const current = Math.max(0, Math.round((ms / 1_000) * rate));
  const next = Math.max(0, current + frames);
  return Math.round((next / rate) * 1_000);
}

/** The next frame's moment. */
export function nextFrameMs(ms: number, fps: number): number {
  return stepFrames(ms, fps, 1);
}

/** The frame before this one. */
export function prevFrameMs(ms: number, fps: number): number {
  return stepFrames(ms, fps, -1);
}
