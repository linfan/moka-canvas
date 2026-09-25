/**
 * Reading json out of an answer that was only asked to be json.
 *
 * A model told to answer with one fenced block usually does, and when it does
 * not it is rarely far off: an announcement before the block, a fence left open,
 * a trailing comma, a quote that came back curled. None of that is a wrong
 * answer, and throwing the whole thing away over it would cost the reader a
 * generation that was already paid for. So the text is read in the order of how
 * much is assumed about it — a fence, then the outermost braces, then the whole
 * answer — and each reading is tried as it is before the next one is reached.
 *
 * What is never done is guessing at meaning. An answer that no reading can make
 * json of comes back as a failure carrying the original words, which is the one
 * thing a reader can repair by hand.
 */

export type ParseResult<T> =
  | { ok: true; value: T; warnings: string[] }
  | { ok: false; error: string; raw: string };

/** Characters a paste may carry that mean nothing and are in the way. */
const DECORATION = /[\u200B-\u200D\u2060\uFEFF]/g;

/** A fenced block, with or without a language on the opening line. */
const FENCE = /```[ \t]*(?:json|JSON)?[ \t]*\r?\n([\s\S]*?)```/g;

/**
 * The json in this text, or a failure carrying the text itself.
 *
 * `raw` on the failure is the answer as it arrived rather than anything this
 * function did to it: it is what the reader is shown, and it is what they edit.
 */
export function parseStoryJson(text: string): ParseResult<unknown> {
  const cleaned = text.replace(DECORATION, "").trim();
  if (cleaned === "") {
    return { ok: false, error: "the answer was empty", raw: text };
  }

  for (const candidate of candidates(cleaned)) {
    const value = tryParse(candidate);
    if (value !== undefined) return { ok: true, value, warnings: [] };
  }
  return {
    ok: false,
    error: "the answer held no json this could read",
    raw: text,
  };
}

/**
 * The readings to try, most likely first.
 *
 * Every fence is offered, not only the first: an answer that shows the shape in
 * one block before answering in another is common enough that stopping at the
 * first would throw away the answer that came second.
 */
function candidates(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(FENCE)) {
    const block = match[1]?.trim();
    if (block !== undefined && block !== "") found.push(block);
  }
  const braced = outerStructure(text);
  if (braced !== undefined) found.push(braced);
  found.push(text);
  return found;
}

/** The first `{…}` or `[…]` region, ignoring braces that are inside strings. */
function outerStructure(text: string): string | undefined {
  const start = firstBrace(text);
  if (start === undefined) return undefined;
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === open) depth += 1;
    else if (character === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

function firstBrace(text: string): number | undefined {
  const brace = text.indexOf("{");
  const bracket = text.indexOf("[");
  if (brace === -1) return bracket === -1 ? undefined : bracket;
  if (bracket === -1) return brace;
  return Math.min(brace, bracket);
}

/**
 * The value this text holds, if any reading of it parses.
 *
 * The repairs are tried in order and only ever after the reading before them has
 * failed, since each one assumes more about the text than the last: a comma
 * dropped from the end of a list is a fault of the answer, and a quote
 * straightened could be a fault of the answer or a character the author meant.
 */
function tryParse(text: string): unknown {
  for (const attempt of readings(text)) {
    try {
      return JSON.parse(attempt);
    } catch {
      // try the next reading
    }
  }
  return undefined;
}

function readings(text: string): string[] {
  const trimmed = stripTrailingCommas(text);
  return [text, trimmed, straightenQuotes(trimmed)];
}

/** The same text with commas that end nothing taken out, outside strings only. */
function stripTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      out += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      out += character;
      continue;
    }
    if (character === ",") {
      // A comma with nothing after it before the object or list closes.
      let ahead = index + 1;
      while (ahead < text.length && /\s/.test(text[ahead])) ahead += 1;
      if (text[ahead] === "}" || text[ahead] === "]") continue;
    }
    out += character;
  }
  return out;
}

/** Quotes a keyboard did not type, which json does not know. */
function straightenQuotes(text: string): string {
  return text.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
}
