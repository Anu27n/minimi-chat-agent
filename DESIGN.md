# DESIGN

A chat agent with one tool (web search) that answers from fresh sources with citations, streams, and remembers every past exchange **with its timestamp**, so it can answer "what did I ask you last Tuesday, and is that still true?"

## How it works

```
user message
  │
  ├─ 1. recall      chrono-node turns "last Tuesday" / "on 3 November" / "on Monday" into local date ranges
  │                 → SQLite: exchanges in those ranges (any conversation) + BM25 topic matches (FTS5)
  │                 → explicit notes when a date has no record ("No saved conversations from Thu 5 Nov")
  ├─ 2. prompt      static system prompt (cacheable) + one envelope in the user turn:
  │                 <context> now, time zone, 14-day calendar · <memory> timestamped past Q&A + their sources
  ├─ 3. loop        model ⇄ web_search, ≤5 model calls, searches in a step run in parallel,
  │                 last call has tools disabled so a turn always ends with an answer
  ├─ 4. persist     only a finished turn is saved: question, answer, cited sources, searches run, asked_at
  └─ 5. stream      the agent is an async generator of typed events → SSE → browser
                    (memory recalled · searching "x" since 2026-11-03 · text deltas · done)
```

Code map: `agent/agent.ts` (the loop), `memory/{temporal,retriever,store}.ts`, `agent/webSearchTool.ts`, `llm/{anthropic,openai}.ts`, `server/http.ts`, `main.ts` (composition root).

## Why it's built this way

1. **Memory is retrieved by the harness, not by a tool.** The rules allow one tool, and pre-retrieval saves a whole model round trip on every memory question. The model sees memory as data it can trust.
2. **Dates are resolved in code, before the model.** Models are bad at weekday arithmetic and confidently wrong about "last Tuesday". A deterministic parser (with `forwardDate: false`, local time zone) is instant, testable, and never hallucinates. The 14-day calendar and absolute timestamps on every memory cover phrases the parser misses.
3. **Absence is explicit.** If the user names a date with no record, the model is told so. Reviewers asking "what did I ask on 3 November?" on a fresh install should get "nothing on record", not an invented conversation.
4. **The unit of memory is the exchange, stored with its sources.** Re-checking an old answer needs three things together: what was said, what it was based on, and when. The `since` argument on `web_search` (Tavily `start_date`) then turns "has anything changed?" into "what was published after that date?". The prompt asks for a verdict per item and separates "no news found" from "the pricing page still says X".
5. **Citations are numbered by the harness.** A per-turn source registry numbers results across parallel searches and dedupes URLs. The model only writes `[n]`; the UI links them; only cited sources are saved.
6. **Streaming is the agent's interface, not an afterthought.** `runTurn()` yields typed events, so the transport (SSE, CLI, a Mac app) just forwards them. Status events arrive before the first token, so a 10-second researched answer still feels responsive.
7. **Provider-neutral across turns, provider-native within a turn.** History is plain text, so the store and the loop never see vendor types. Inside a turn each adapter replays its own transcript verbatim (Claude thinking blocks, OpenAI encrypted reasoning items), as both APIs require between tool calls. Claude Opus 5.5 is the default (adaptive thinking, `effort` as the speed knob, server-side refusal fallback). OpenAI runs on the Responses API with `store: false`, so conversations stay on the machine.
8. **The system prompt never changes.** Date and memory go in the last user message, so the long prefix is cached by the provider.
9. **One injected `Clock`.** Tests freeze time, `AGENT_NOW` time-travels the running app, and `npm run seed` writes real agent answers "on" last Monday and Tuesday.
10. **SQLite via built-in `node:sqlite`.** One file, FTS5 included, no native build to fail during `npm install`. Turns are saved only after they complete, so a crash never becomes a false memory.

## Considered and rejected

- **A `recall_memory` tool.** It breaks the one-tool rule and costs a round trip per memory question.
- **Embeddings or a vector DB.** That needs another key or service. At personal scale, a date filter plus BM25 covers the brief's prompts, and dates are the main key there. A hybrid is the first next step (below).
- **Putting all history in context.** Cost grows with every chat, precision drops, and you can't say "no record from that day".
- **Using the LLM to extract dates.** It adds an extra call, isn't deterministic, and is hard to test.
- **The provider's built-in web search (Anthropic server tool).** It's excellent, but it ties the agent to one vendor and hides `since` filtering and citation numbering inside someone else's loop.
- **Agent frameworks (LangChain, Vercel AI SDK, the SDK tool runner).** The loop is about 150 lines. Owning it makes the step cap, event stream, and save-only-on-success rule explicit.
- **`better-sqlite3`, React/Next.** Native builds and a bundler add install risk, and they don't change the architecture.

## With another week

- **Hybrid retrieval:** embeddings + BM25 + date, with reranking. Distil long histories into dated facts ("shortlisted CRMs: HubSpot, …, as of 9 Nov").
- **Proactive re-checks**, which is minimi's core idea: a background job re-runs searches for answers that contain volatile facts (prices, plans, launches) and nudges the user when something changes.
- **Claim-level storage:** keep each claim with its source and value, so "what changed" becomes a mechanical diff rather than a model judgement.
- **Page fetching** inside `web_search` when snippets are thin (full pricing pages).
- **Evals:** scripted multi-day conversations on a fake clock, scoring recall precision, date resolution, citation faithfulness (does [n] support the claim?) and latency to first token.
- **Production work:** per-user time zone from the client, auth, rate limits, resumable streams, and per-step token and latency tracing.
