/**
 * Provider-neutral types shared across the app. Nothing here knows about
 * Anthropic, OpenAI or Tavily.
 */

/** One web page the agent saw during a turn. `n` is the citation number shown to the user. */
export interface Source {
  n: number;
  title: string;
  url: string;
  publishedDate?: string;
  snippet: string;
}

/** A finished question/answer pair, as stored in memory. */
export interface Exchange {
  id: number;
  conversationId: string;
  askedAt: Date;
  question: string;
  answer: string;
  sources: Source[];
  searches: SearchRecord[];
  model: string;
}

export interface SearchRecord {
  query: string;
  since?: string;
  topic?: "general" | "news";
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
}

/** A past exchange pulled into the current turn, with the reason it was pulled. */
export interface RecalledExchange {
  exchange: Exchange;
  reason: "date" | "topic";
  /** The phrase that matched, e.g. "last Tuesday", for date recalls. */
  matched?: string;
}

/** Events streamed from the agent to the client during one turn. */
export type AgentEvent =
  | { type: "turn_start"; conversationId: string; askedAt: string }
  | {
      type: "memory";
      recalled: { id: number; askedAt: string; question: string; reason: "date" | "topic"; matched?: string }[];
      notes: string[];
    }
  | { type: "search_start"; callId: string; query: string; since?: string; topic?: string }
  | { type: "search_done"; callId: string; query: string; sources: Source[]; error?: string }
  | { type: "text"; delta: string }
  | { type: "done"; exchangeId: number; answer: string; sources: Source[] }
  | { type: "error"; message: string };
