import * as chrono from "chrono-node";
import { addDays, formatDay, formatMonth, startOfDay } from "../core/time.js";

/**
 * Turns phrases like "last Tuesday", "on 3 November", "on Monday", "yesterday",
 * "last week" into concrete local-time ranges, relative to `now`.
 *
 * This runs deterministically *before* the model sees the message, so memory
 * lookup by date never depends on the model doing calendar arithmetic. Anything
 * the parser misses is still covered: the model gets a two-week calendar and
 * timestamps on every recalled exchange (see agent/prompt.ts).
 */
export interface TimeReference {
  /** The words in the user's message, e.g. "Last Tuesday". */
  phrase: string;
  /** Inclusive start, local time. */
  start: Date;
  /** Exclusive end, local time. */
  end: Date;
  /** Human label for the range, e.g. "Tue 3 Nov 2026" or "week of Mon 2 Nov 2026". */
  label: string;
}

export function resolveTimeReferences(text: string, now: Date): TimeReference[] {
  // forwardDate: false → a bare "Monday" or "3 November" means the most recent one,
  // which is what people mean when talking about the past.
  const results = chrono.parse(text, { instant: now }, { forwardDate: false });
  const refs: TimeReference[] = [];

  for (const r of results) {
    const phrase = r.text;
    const startPoint = r.start.date();
    let start: Date;
    let end: Date;
    let label: string;

    if (r.end) {
      start = startOfDay(startPoint);
      end = addDays(startOfDay(r.end.date()), 1);
      label = `${formatDay(start)} – ${formatDay(addDays(end, -1))}`;
    } else if (/\bweek\b/i.test(phrase)) {
      start = startOfWeek(startPoint);
      end = addDays(start, 7);
      label = `week of ${formatDay(start)}`;
    } else if (/\bmonth\b/i.test(phrase) || (r.start.isCertain("month") && !r.start.isCertain("day"))) {
      start = new Date(startPoint.getFullYear(), startPoint.getMonth(), 1);
      end = new Date(startPoint.getFullYear(), startPoint.getMonth() + 1, 1);
      label = formatMonth(start);
    } else if (/\byear\b/i.test(phrase)) {
      start = new Date(startPoint.getFullYear(), 0, 1);
      end = new Date(startPoint.getFullYear() + 1, 0, 1);
      label = String(startPoint.getFullYear());
    } else {
      start = startOfDay(startPoint);
      end = addDays(start, 1);
      label = formatDay(start);
    }

    // Memory only holds the past: drop ranges entirely in the future, clip the rest.
    if (start.getTime() > now.getTime()) continue;
    if (end.getTime() > now.getTime()) end = new Date(now.getTime() + 1);

    if (!refs.some((x) => x.start.getTime() === start.getTime() && x.end.getTime() === end.getTime())) {
      refs.push({ phrase, start, end, label });
    }
  }
  return refs;
}

/** Monday 00:00 of the week containing `d` (ISO weeks, as used in India and Europe). */
function startOfWeek(d: Date): Date {
  const day = startOfDay(d);
  const offset = (day.getDay() + 6) % 7; // Monday → 0 … Sunday → 6
  return addDays(day, -offset);
}
