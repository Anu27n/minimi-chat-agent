/**
 * Date helpers. All of them work in the machine's local time zone: this is a
 * personal assistant that runs on the user's own computer, so "Tuesday" means
 * Tuesday where the user is.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d: Date, n: number): Date {
  // Use calendar arithmetic, not ms, so DST changes don't shift the day.
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes(), d.getSeconds());
}

/** Whole calendar days between two dates (b - a), ignoring time of day. */
export function calendarDaysBetween(a: Date, b: Date): number {
  return Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / DAY_MS);
}

/** "2026-11-03" in local time. */
export function isoDate(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Formatting is done by hand rather than with toLocaleString so the text the
// model sees is identical on every machine and ICU version.

/** "Tue 3 Nov 2026" */
export function formatDay(d: Date): string {
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** "Oct 2026" */
export function formatMonth(d: Date): string {
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** "Tue 3 Nov 2026, 14:05" */
export function formatDateTime(d: Date): string {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${formatDay(d)}, ${hh}:${mm}`;
}

/** "today", "yesterday", "7 days ago", "in 2 days" */
export function relativeDay(d: Date, now: Date): string {
  const diff = calendarDaysBetween(d, now);
  if (diff === 0) return "today";
  if (diff === 1) return "yesterday";
  if (diff > 1) return `${diff} days ago`;
  if (diff === -1) return "tomorrow";
  return `in ${-diff} days`;
}

export function timeZoneName(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * A small calendar of the last two weeks, handed to the model every turn.
 * Models are unreliable at weekday arithmetic; a lookup table removes the guesswork
 * when the user says something our parser didn't catch ("the Friday before").
 */
export function recentCalendar(now: Date, days = 14): string {
  const lines: string[] = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(now, -i);
    lines.push(`${isoDate(d)} ${formatDay(d).slice(0, 3)} (${relativeDay(d, now)})`);
  }
  return lines.join("\n");
}
