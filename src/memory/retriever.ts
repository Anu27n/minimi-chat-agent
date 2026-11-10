import type { RecalledExchange } from "../core/types.js";
import type { MemoryStore } from "./store.js";
import { resolveTimeReferences, type TimeReference } from "./temporal.js";
import { startOfDay } from "../core/time.js";

/**
 * Decides which past exchanges the model should see for this message.
 *
 * Memory is retrieved by the harness, not by the model through a tool: the brief
 * allows exactly one tool (web search), and pre-retrieval also saves a model
 * round trip on every memory question, which keeps answers fast.
 *
 * Two signals, merged:
 *   1. "when"  — date phrases resolved to ranges → every exchange in that range.
 *   2. "what"  — keywords → BM25 over all past questions and answers.
 * If a date phrase finds nothing, that is reported explicitly so the model says
 * "we didn't talk on 3 November" instead of inventing a conversation.
 */
export interface Recall {
  recalled: RecalledExchange[];
  /** Facts about the lookup the model must respect, e.g. "No conversations on Tue 3 Nov 2026". */
  notes: string[];
  timeRefs: TimeReference[];
}

export interface RecallOptions {
  /** Exchanges already in the prompt as recent history; don't repeat them. */
  excludeIds?: Set<number>;
  maxDateMatches?: number;
  maxTopicMatches?: number;
}

const MEMORY_CUE =
  /\b(i|we)\s+(asked|said|talked|discussed|mentioned|shortlisted|told)\b|\bdid i\b|\byou (said|told|answered|suggested|recommended)\b|\bremember\b|\bearlier\b|\bbefore\b/i;

export function recall(store: MemoryStore, message: string, now: Date, opts: RecallOptions = {}): Recall {
  const exclude = opts.excludeIds ?? new Set<number>();
  const terms = extractKeywords(message);
  const notes: string[] = [];
  const recalled: RecalledExchange[] = [];
  const seen = new Set<number>(exclude);

  const todayStart = startOfDay(now).getTime();
  let timeRefs = resolveTimeReferences(message, now);
  // "What did I ask on 3 Nov? Is it still correct today?" — that "today" is the present,
  // not a lookup. A today-only reference counts only when it is the sole date and the
  // user is clearly asking about something said earlier ("what did I ask you today?").
  const past = timeRefs.filter((r) => r.start.getTime() < todayStart);
  timeRefs = past.length > 0 ? past : timeRefs.filter(() => MEMORY_CUE.test(message));

  for (const ref of timeRefs) {
    const found = store
      .exchangesBetween(ref.start, ref.end, { terms, limit: opts.maxDateMatches ?? 6 })
      .filter((e) => !exclude.has(e.id));
    if (found.length === 0) {
      notes.push(`No saved conversations from ${ref.label} (the user said "${ref.phrase}").`);
      continue;
    }
    for (const e of found) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      recalled.push({ exchange: e, reason: "date", matched: ref.phrase });
    }
  }

  const byTopic = store.searchExchanges(terms, { limit: (opts.maxTopicMatches ?? 3) + seen.size, before: now });
  let added = 0;
  for (const e of byTopic) {
    if (added >= (opts.maxTopicMatches ?? 3)) break;
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    recalled.push({ exchange: e, reason: "topic" });
    added++;
  }

  recalled.sort((a, b) => a.exchange.askedAt.getTime() - b.exchange.askedAt.getTime());
  return { recalled, notes, timeRefs };
}

const STOPWORDS = new Set(
  `a about above after again against all am an and any are as at be because been before being below between both but by
  can could did do does doing down during each few for from further had has have having he her here hers him his how i if in
  into is it its itself just me more most my no nor not now of off on once only or other our ours out over own same she should
  so some such than that the their them then there these they this those through to too under until up very was we were what
  when where which while who whom why will with would you your yours ask asked tell told said say answer answered still correct
  right today yesterday tomorrow ago last next week weeks month months year years day days since then any anything something
  monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october
  november december jan feb mar apr jun jul aug sep sept oct nov dec morning evening night earlier later remember changed
  change new big shipped since has have please thanks hey hi`.split(/\s+/),
);

/** Content words for BM25. Dates and filler are removed; they say "when", not "what". */
export function extractKeywords(text: string, max = 12): string[] {
  const words = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}+#.-]+/u)
    .map((w) => w.replace(/^[.-]+|[.-]+$/g, ""))
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w) && !/^\d{1,2}(st|nd|rd|th)?$/.test(w));
  return [...new Set(words)].slice(0, max);
}
