import { z } from "zod";
import type { SearchRecord, Source } from "../core/types.js";
import type { SearchProvider } from "../search/types.js";
import type { ToolSpec } from "../llm/types.js";

/**
 * The agent's single tool. Defined once here in provider-neutral JSON Schema;
 * each LLM adapter translates it to its own wire format.
 */
export const WEB_SEARCH_TOOL: ToolSpec = {
  name: "web_search",
  description:
    "Search the web for current information. Returns numbered sources with page extracts and publish dates. " +
    "Use it for anything that may have changed since your training data: prices, releases, news, people, versions. " +
    "Use `since` (YYYY-MM-DD) to look only at pages published after a date, e.g. when checking whether a past answer is still true. " +
    "Use topic 'news' for announcements and launches. Run several focused searches (one per product or question) rather than one vague one.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "A focused search query, like you would type into a search engine." },
      since: { type: "string", description: "Optional. Only pages published on or after this date (YYYY-MM-DD)." },
      topic: { type: "string", enum: ["general", "news"], description: "Optional. 'news' for recent announcements. Default 'general'." },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

/** Runtime validation of the model's arguments; the schema above is a request, not a guarantee. */
export const WebSearchArgs = z.object({
  query: z.string().trim().min(2).max(400),
  since: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "since must be YYYY-MM-DD")
    .optional()
    .nullable()
    .transform((v) => v ?? undefined),
  topic: z
    .enum(["general", "news"])
    .optional()
    .nullable()
    .transform((v) => v ?? undefined),
});
export type WebSearchArgs = z.infer<typeof WebSearchArgs>;

/**
 * Numbers sources across all searches in one turn, so the model can cite [1]…[n]
 * and the UI can link each number. The same URL found twice keeps its first number.
 */
export class SourceRegistry {
  private byUrl = new Map<string, Source>();
  readonly searches: SearchRecord[] = [];

  add(hit: Omit<Source, "n">): Source {
    const key = normalizeUrl(hit.url);
    const existing = this.byUrl.get(key);
    if (existing) return existing;
    const source: Source = { ...hit, n: this.byUrl.size + 1 };
    this.byUrl.set(key, source);
    return source;
  }

  all(): Source[] {
    return [...this.byUrl.values()];
  }

  /** Only the sources the answer actually cites, in citation order. */
  cited(answer: string): Source[] {
    const numbers = new Set([...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
    return this.all().filter((s) => numbers.has(s.n));
  }
}

export interface WebSearchOutcome {
  sources: Source[];
  /** Text handed back to the model as the tool result. */
  resultText: string;
  isError: boolean;
}

export async function runWebSearch(
  rawArgs: unknown,
  provider: SearchProvider,
  registry: SourceRegistry,
  signal?: AbortSignal,
): Promise<WebSearchOutcome> {
  const parsed = WebSearchArgs.safeParse(rawArgs);
  if (!parsed.success) {
    return { sources: [], isError: true, resultText: `Invalid arguments: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
  }
  const args = parsed.data;
  registry.searches.push({ query: args.query, since: args.since, topic: args.topic });
  try {
    const hits = await provider.search({ query: args.query, since: args.since, topic: args.topic }, signal);
    const sources = hits.map((h) =>
      registry.add({ title: h.title, url: h.url, publishedDate: h.publishedDate, snippet: h.content.slice(0, 300) }),
    );
    return { sources, isError: false, resultText: formatResults(args, hits, sources) };
  } catch (err) {
    if (signal?.aborted) throw err;
    const message = err instanceof Error ? err.message : String(err);
    return { sources: [], isError: true, resultText: `Search failed: ${message}. Try a different query or answer from what you have, saying the search failed.` };
  }
}

function formatResults(args: WebSearchArgs, hits: { content: string }[], sources: Source[]): string {
  const header = `Results for "${args.query}"${args.since ? ` published since ${args.since}` : ""}:`;
  if (sources.length === 0) return `${header}\nNo results. ${args.since ? "Nothing published in that window — that itself may mean nothing changed; try without `since` to confirm." : "Try another query."}`;
  const blocks = sources.map((s, i) => {
    const date = s.publishedDate ? ` (published ${s.publishedDate.slice(0, 10)})` : "";
    const content = (hits[i]?.content ?? "").replace(/\s+/g, " ").slice(0, 1800);
    return `[${s.n}] ${s.title}${date}\n${s.url}\n${content}`;
  });
  return `${header}\n\n${blocks.join("\n\n")}`;
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}
