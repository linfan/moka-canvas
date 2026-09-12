import { MAX_MODEL_ID_LENGTH } from "../../shared/domain";

/**
 * Identifiers a node can store.
 *
 * A model configuration's id is the reference a node keeps, so it outlives the
 * form that made it and shows up in project files, logs, and the message that
 * says a model is gone. Nobody should have to invent one: the display name
 * already carries the meaning, and a random tail is what keeps two models both
 * called "Writer" apart. The result stays something a person can read.
 */

/** The random tail's length. 36^6 is far more room than a model list needs. */
const SUFFIX_LENGTH = 6;

/** What the tail is written in: lowercase letters and digits, like the rest. */
const SUFFIX_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** The stem a display name that is all symbols still produces. */
const FALLBACK_STEM = "model";

/**
 * How far a display name may reach into the identifier, leaving room for the
 * separator and the tail without going over the ceiling the server enforces.
 */
const STEM_LENGTH = MAX_MODEL_ID_LENGTH - SUFFIX_LENGTH - 1;

/**
 * The readable part of an identifier: lowercased, whitespace collapsed to a
 * single underscore, hyphens kept because that is how the identifiers already
 * in the wild are written (`gpt-4o-mini`, `writer-copy`), and every other
 * symbol dropped. Runs of separators left behind by a dropped symbol collapse
 * into one, so "Writer - the best" does not become `writer_-_the_best`.
 */
export function identifierStem(displayName: string): string {
  const stem = displayName
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/[_-]{2,}/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "");
  return stem.slice(0, STEM_LENGTH).replace(/[_-]+$/g, "");
}

/** A random tail, drawn from the platform's own source rather than Math.random. */
export function identifierSuffix(): string {
  const bytes = new Uint8Array(SUFFIX_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => SUFFIX_ALPHABET[byte % 36]).join("");
}

/**
 * The identifier a display name suggests. Never empty: a name made only of
 * symbols still yields the fallback stem plus a tail.
 */
export function suggestedModelId(displayName: string): string {
  const stem = identifierStem(displayName);
  const head = stem === "" ? FALLBACK_STEM : stem;
  return `${head}_${identifierSuffix()}`;
}

/**
 * A suggested identifier that no stored model is using yet.
 *
 * A collision needs the same name and the same six characters, so one draw is
 * what happens in practice; the retries are here so that the rare case ends in
 * an identifier rather than in a form that refuses to save. Giving up returns
 * the last candidate, which the duplicate warning then reports — inventing a
 * second scheme for an event that has not happened would only hide it.
 */
export function uniqueModelId(
  displayName: string,
  taken: (id: string) => boolean,
  attempts = 8,
): string {
  let candidate = suggestedModelId(displayName);
  for (let attempt = 1; attempt < attempts && taken(candidate); attempt += 1) {
    candidate = suggestedModelId(displayName);
  }
  return candidate;
}
