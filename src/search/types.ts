/** The search backend behind the agent's one tool. Tavily today; Brave or Exa would be another implementation. */
export interface SearchProvider {
  readonly name: string;
  search(req: SearchRequest, signal?: AbortSignal): Promise<SearchHit[]>;
}

export interface SearchRequest {
  query: string;
  /** Only results published on or after this local date (YYYY-MM-DD). */
  since?: string;
  topic?: "general" | "news";
  maxResults?: number;
}

export interface SearchHit {
  title: string;
  url: string;
  content: string;
  publishedDate?: string;
}
