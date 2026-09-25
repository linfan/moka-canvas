/**
 * Cutting an uploaded manuscript into the parts a chapter is written from.
 *
 * A whole novel cannot be handed to a model in one ask, and asking for the
 * chapters up front from a text nobody has read produces an outline of the
 * text's beginning. So the manuscript is cut here first — by its own chapter
 * headings when it has them, by its own breaks when it has those, and by
 * arithmetic when it has neither — and each part is written into one chapter on
 * its own. What is cut is never written into the document: the manuscript stays
 * an asset on the shelf, and the story keeps the one premise its reader stands
 * behind.
 *
 * Cutting is measured in code points rather than in the string's own units, so
 * a break never lands between the halves of a character that is written with
 * two.
 */

/** One part of a manuscript, with the heading its own text gave it. */
export interface SourceChunk {
  title?: string;
  text: string;
}

export interface SplitOptions {
  /** How many chapters the telling is meant to have. */
  targetChapters: number;
  /** The longest a part may be; longer ones are cut to fit. */
  maxChars: number;
}

/**
 * The headings a manuscript writes its own chapters with, in the two orders
 * this app is read in: `第一章`, `第 12 回`, `Chapter 3`, `3、`.
 */
const HEADING =
  /^[ \t]*(第[一二三四五六七八九十百千零两0-9]+[章回节卷]|Chapter\s+[0-9IVXLCivxlc]+|CHAPTER\s+[0-9IVXLCivxlc]+|[0-9]{1,3}\s*[、.．]\s*\S)/;

/** The marks a manuscript makes a break with, without saying anything. */
const BREAK_MARKS = ["\\*\\s*\\*\\s*\\*", "---", "===", "◇◇◇", "◆◆◆"];
const BREAK_LINE = new RegExp(`^[ \\t]*(?:${BREAK_MARKS.join("|")})[ \\t]*$`);
const BREAK_JOIN = new RegExp(
  `\\n[ \\t]*(?:${BREAK_MARKS.join("|")})[ \\t]*\\n`,
);

/**
 * A manuscript cut into the parts a chapter is written from.
 *
 * At least one part always comes back, even for an empty text: a part with no
 * words in it is a chapter the model will be asked to write from nothing, which
 * is the same answer as not asking at all, and the caller decides what to do
 * with it.
 */
export function splitSource(
  text: string,
  options: SplitOptions,
): SourceChunk[] {
  const target = Math.max(1, Math.floor(options.targetChapters));
  const source = text.replace(/\r\n/g, "\n").trim();
  if (source === "") return [{ text: "" }];

  const byHeading = splitAtHeadings(source, target);
  const parts =
    byHeading ??
    packIntoParts(scenesOf(source), target) ??
    evenParts(source, target);

  return parts.map((part) => ({
    ...(part.title !== undefined ? { title: part.title } : {}),
    text: fit(part.text.trim(), options.maxChars),
  }));
}

/**
 * How many chapters a manuscript writes of its own, or none when it writes too
 * few to be a structure rather than a line that happened to start with a
 * number.
 *
 * Read before the manuscript is cut, so the number the telling is divided into
 * can be the number it already has rather than the one the running time
 * suggests.
 */
export function sourceHeadings(text: string): number {
  const found = text.split("\n").filter((line) => HEADING.test(line)).length;
  return found >= 2 ? found : 0;
}

/**
 * The manuscript cut at its own chapter headings, when it has any and they
 * agree with how many chapters were asked for.
 *
 * Headings are only trusted when there are enough of them to be a structure
 * rather than a line that happened to start with a number, and when they do not
 * cut the telling into meaningfully more pieces than were asked for — a novel
 * with a hundred and twenty headings is not one with twelve.
 */
function splitAtHeadings(
  text: string,
  target: number,
): SourceChunk[] | undefined {
  const lines = text.split("\n");
  const at: number[] = [];
  lines.forEach((line, index) => {
    if (HEADING.test(line)) at.push(index);
  });
  if (at.length < 2 || at.length > target * 2) return undefined;

  return at.map((start, position) => {
    const end = at[position + 1] ?? lines.length;
    const heading = lines[start].trim();
    const body = lines
      .slice(start + 1, end)
      .join("\n")
      .trim();
    return { title: heading, text: body };
  });
}

/**
 * The manuscript's scenes: what its break marks and its blank stretches cut it
 * into, in order. One scene is what a manuscript with no breaks at all is.
 */
function scenesOf(text: string): Array<{ text: string }> {
  const atBreaks = pieces(text.split(BREAK_JOIN));
  const atParagraphs = pieces(text.split(/\n[ \t]*\n+/));
  const scenes = atBreaks.length > 1 ? atBreaks : atParagraphs;
  return (scenes.length > 0 ? scenes : [text.trim()]).map((scene) => ({
    text: scene,
  }));
}

/** The pieces of a split that hold words, without the marks they were cut at. */
function pieces(parts: string[]): string[] {
  return parts
    .map((part) =>
      part
        .split("\n")
        .filter((line) => !BREAK_LINE.test(line))
        .join("\n")
        .trim(),
    )
    .filter((part) => part !== "");
}

/**
 * Scenes packed into the number of parts that was asked for.
 *
 * Packed by weight rather than by count, so a part holding three short scenes
 * and one holding a long one come out about the same length: what a chapter is
 * written from is a share of the telling, not a share of its paragraphs. Once
 * the parts are used up the rest is laid on the last one.
 */
function packIntoParts(
  scenes: Array<{ text: string }>,
  target: number,
): SourceChunk[] | undefined {
  if (scenes.length < target) return undefined;
  const total = scenes.reduce((sum, scene) => sum + scene.text.length, 0);
  const per = Math.ceil(total / target);
  const parts: SourceChunk[] = [];
  let held: string[] = [];
  let length = 0;
  const flush = () => {
    if (held.length === 0) return;
    parts.push({ text: held.join("\n\n") });
    held = [];
    length = 0;
  };
  for (const scene of scenes) {
    // Once the parts that were asked for are used up, everything left is the
    // last of them: a manuscript cut into one more part than was asked for is
    // a chapter the telling has no room for.
    if (
      parts.length < target - 1 &&
      held.length > 0 &&
      length + scene.text.length > per
    ) {
      flush();
    }
    held.push(scene.text);
    length += scene.text.length;
  }
  flush();
  return parts;
}

/**
 * The manuscript cut into equal shares, for one that has no seams to cut at.
 *
 * The breaks are looked for near where the share ends — a sentence end, a line
 * end, a space — so a part ends where a reader would pause, and no part is left
 * with nothing in it.
 */
function evenParts(text: string, target: number): SourceChunk[] {
  const points = Array.from(text);
  if (points.length <= target) return [{ text }];
  const parts: SourceChunk[] = [];
  const share = Math.ceil(points.length / target);
  let start = 0;
  while (start < points.length) {
    const wanted = Math.min(points.length, start + share);
    const end =
      wanted >= points.length ? points.length : nearestBreak(points, wanted);
    parts.push({ text: points.slice(start, end).join("") });
    start = end;
  }
  return parts;
}

/** How far past the wanted break a better one is still worth taking. */
const BREAK_REACH = 120;

function nearestBreak(points: string[], wanted: number): number {
  const reach = Math.min(BREAK_REACH, Math.floor(wanted / 2));
  for (let step = 0; step <= reach; step += 1) {
    for (const at of [wanted + step, wanted - step]) {
      if (at <= 0 || at >= points.length) continue;
      const before = points[at - 1];
      if (before === "\n" || /[。！？!?；;]/.test(before)) return at;
    }
  }
  return wanted;
}

/** The text cut to fit, at a break if one is near the cut. */
function fit(text: string, maxChars: number): string {
  const points = Array.from(text);
  if (points.length <= maxChars) return text;
  const end = nearestBreak(points, maxChars);
  return points.slice(0, Math.max(1, end)).join("");
}
