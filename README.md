# minimi chat agent

A streaming chat agent with **one tool, web search**, and **time-aware memory** of every past conversation. Ask it something current and it searches, then answers with numbered citations. Ask "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?" and it finds that exact exchange by date, re-searches only what was published since, and tells you what changed.

Built for the minimi Software Engineering Intern challenge. Architecture and trade-offs: **[DESIGN.md](DESIGN.md)**.

## Run it

Requires **Node.js 22.13 or newer** (it uses the built-in `node:sqlite`).

```bash
npm install
cp .env.example .env      # then add your keys
npm run dev               # → http://localhost:3000
```

Keys (all listed in [.env.example](.env.example)):

| Variable | Needed | Notes |
|---|---|---|
| `TAVILY_API_KEY` | yes | The web search tool. Free tier at tavily.com. |
| `ANTHROPIC_API_KEY` | one LLM key | Default provider: `claude-opus-5-5`, `ANTHROPIC_EFFORT=medium`. |
| `OPENAI_API_KEY` | one LLM key | Set `LLM_PROVIDER=openai` to use it (`OPENAI_MODEL=gpt-6.1-terra`). |

Without keys the server still starts, and the page tells you what is missing. Editing `.env` restarts the dev server.

## Try these

- `Which managed Postgres hosts have the cheapest entry plan right now?`
- Then, in a **new chat**: `What did I ask you earlier today? Is your answer still correct?`
- `What did I ask you on 3 November?` On a fresh install it should say it has no record, not invent one.

To try the brief's "last Tuesday / on Monday" prompts without waiting a week, either:

- **Seed history:** `npm run seed` asks the real agent two questions as if on the most recent Tuesday (Postgres hosting) and Monday (5 CRM tools for a 20-person sales team). Then ask *"On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?"*
- **Time-travel:** chat today, then restart with `AGENT_NOW=2026-11-17T10:00:00` in `.env` and refer back to "last Tuesday".

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Server + UI with reload on change |
| `npm test` | Unit tests: date resolution, memory store and recall, agent loop with a scripted model and fake search (no keys or network) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run seed` | Optional demo history (uses real API calls) |

## Layout

```
src/
  main.ts                composition root: config → store, model, search → HTTP server
  config.ts              typed env parsing
  agent/agent.ts         the turn loop: recall → prompt → model ⇄ web_search → persist, as an event stream
  agent/prompt.ts        static system prompt + per-turn <context>/<memory> envelope
  agent/webSearchTool.ts the single tool: schema, argument validation, numbered sources
  memory/temporal.ts     "last Tuesday" → date range (chrono-node, local time)
  memory/retriever.ts    date + BM25 recall, explicit "no record" notes
  memory/store.ts        SQLite (node:sqlite) + FTS5
  llm/                   ChatModel interface, Anthropic and OpenAI adapters
  search/tavily.ts       search provider
  server/http.ts         REST + Server-Sent Events
public/                  static chat UI (no build step)
test/                    vitest
```

Memory is stored in `./data/minimi.db`. Delete it to start fresh.
