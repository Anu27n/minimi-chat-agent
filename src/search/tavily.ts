import { z } from "zod";
import type { SearchHit, SearchProvider, SearchRequest } from "./types.js";

const TavilyResponse = z.object({
  results: z.array(
    z.object({
      title: z.string().catch(""),
      url: z.string(),
      content: z.string().catch(""),
      published_date: z.string().nullish(),
    }),
  ),
});

/**
 * Tavily is built for LLM agents: it returns cleaned page extracts rather than
 * 160-character SERP snippets, so one call usually carries enough text to answer
 * from, and it supports a start_date filter we use for "has anything changed since".
 */
export class TavilySearch implements SearchProvider {
  readonly name = "tavily";

  constructor(
    private apiKey: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async search(req: SearchRequest, signal?: AbortSignal): Promise<SearchHit[]> {
    const body: Record<string, unknown> = {
      query: req.query,
      topic: req.topic ?? "general",
      search_depth: "basic",
      chunks_per_source: 3,
      max_results: req.maxResults ?? 6,
      include_published_date: true,
    };
    if (req.since) body.start_date = req.since;

    const res = await this.fetchImpl("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Tavily ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = TavilyResponse.parse(await res.json());
    return data.results.map((r) => ({
      title: r.title || r.url,
      url: r.url,
      content: r.content,
      publishedDate: r.published_date ?? undefined,
    }));
  }
}
