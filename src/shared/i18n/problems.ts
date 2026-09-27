import { i18n } from ".";

/**
 * The values a Chinese problem message is written with.
 *
 * The server sends some of these as `details`, as when a capability mismatch
 * names the model it found; the client supplies the rest, as when a transport
 * failure carries the reason underneath it. A value nobody filled in is left
 * out rather than interpolated as nothing, so a placeholder is never left bare.
 */
export type ProblemValues = Record<string, unknown>;

/** The namespace both problem catalogues live under. */
const NAMESPACE = "problems";

/**
 * A placeholder i18next could not fill in, which it leaves standing as it was
 * written. A sentence with a hole in it is worse than the English it replaced,
 * so one is refused rather than shown.
 */
const UNFILLED = /\{\{\s*[\w.]+/;

/**
 * The name a code is filed under in the catalogues: `PROVIDER_AUTH` is
 * `providerAuth`, which is what a message author writes down and what this
 * lookup reads back.
 */
export function problemKey(code: string): string {
  return code
    .toLowerCase()
    .replace(/_([a-z0-9])/g, (_whole, letter: string) => letter.toUpperCase());
}

function filledIn(values: ProblemValues | undefined): ProblemValues {
  const kept: ProblemValues = {};
  for (const [name, value] of Object.entries(values ?? {})) {
    if (value !== undefined) kept[name] = value;
  }
  return kept;
}

/**
 * The words to show for a problem: the Chinese catalogue's when the interface
 * is Chinese and it knows the code, and the server's own English message
 * otherwise.
 *
 * English is left exactly as the server wrote it, on purpose: that message is
 * the fuller one — it carries the ids, the counts, and the provider's own
 * explanation — and English is the language it was written in. A Chinese
 * interface reads the catalogue first so a trouble whose words are known is
 * not shown in a language its reader may not have, and falls back to that same
 * English rather than to a bare key when a code has no words yet, or to a
 * sentence with a placeholder left standing in it.
 */
export function problemMessage(
  code: string,
  fallback: string,
  values?: ProblemValues,
): string {
  // A body that arrived without these is not a problem this can dress up.
  if (typeof code !== "string" || typeof fallback !== "string") return fallback;
  if (i18n.resolvedLanguage !== "zh") return fallback;
  const key = `${NAMESPACE}:${problemKey(code)}`;
  if (!i18n.exists(key)) return fallback;
  const said = i18n.t(key, { code, message: fallback, ...filledIn(values) });
  return UNFILLED.test(said) ? fallback : said;
}

/**
 * What a piece of work that failed has to say for itself, in the reader's
 * language.
 *
 * The same fields a job's piece and a run's step both carry: what was said,
 * and — when the writer knew — what kind of trouble it was and the values
 * behind it. A record written before the codes existed says what it says and
 * is taken as it is; one that names its trouble is said the reader's way, and
 * falls back to the writer's English when the words are not known yet.
 *
 * Null for a piece with nothing to report, which is a piece that was not the
 * reader's to hear about.
 */
export function failureText(failure: {
  error?: string;
  errorCode?: string;
  errorDetails?: Record<string, unknown>;
}): string | null {
  const said = failure.error;
  if (said === undefined || said === "") return null;
  const code = failure.errorCode;
  if (code === undefined) return said;
  return problemMessage(code, said, failure.errorDetails);
}
