/**
 * How long ago something was, in the words a reader says it in.
 *
 * The interface's own language does the talking: `Intl.RelativeTimeFormat`
 * knows both catalogues, so nothing here is a sentence that would have to be
 * written twice. Day and month are not turned into "3 天前" from a division
 * alone — the calendar decides when a day is a day, since a run that began at
 * eleven at night and finished at one in the morning began yesterday.
 */
const DIVISIONS: Array<{ amount: number; unit: Intl.RelativeTimeFormatUnit }> =
  [
    { amount: 60, unit: "second" },
    { amount: 60, unit: "minute" },
    { amount: 24, unit: "hour" },
    { amount: 7, unit: "day" },
    { amount: 4.34524, unit: "week" },
    { amount: 12, unit: "month" },
    { amount: Number.POSITIVE_INFINITY, unit: "year" },
  ];

export function relativeTime(
  iso: string,
  now: Date = new Date(),
  locale: string = "en",
): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  let delta = (then.getTime() - now.getTime()) / 1000;
  for (const division of DIVISIONS) {
    if (Math.abs(delta) < division.amount) {
      return format.format(Math.round(delta), division.unit);
    }
    delta /= division.amount;
  }
  return "";
}
