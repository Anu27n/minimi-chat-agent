import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { offsetClock, systemClock } from "./core/clock.js";
import { formatDateTime, timeZoneName } from "./core/time.js";
import { createChatModel } from "./llm/index.js";
import { MemoryStore } from "./memory/store.js";
import { TavilySearch } from "./search/tavily.js";
import { createApp } from "./server/http.js";
import type { AgentDeps } from "./agent/agent.js";

/** Composition root: the only place that knows which concrete pieces are plugged together. */
try {
  process.loadEnvFile(".env");
} catch {
  // No .env file: fall back to the real environment.
}

const config = loadConfig();
const clock = config.agentNow ? offsetClock(config.agentNow) : systemClock;
const store = new MemoryStore(config.dbPath);
const model = createChatModel(config);
const agent: AgentDeps | undefined =
  model && config.tavilyApiKey ? { store, model, search: new TavilySearch(config.tavilyApiKey), clock } : undefined;

const app = createApp({ config, store, agent });
const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`minimi chat agent → http://localhost:${info.port}`);
  console.log(`  model:  ${model?.id ?? "(not configured)"}`);
  console.log(`  memory: ${config.dbPath}`);
  console.log(`  clock:  ${formatDateTime(clock.now())} ${timeZoneName()}${config.agentNow ? "  (AGENT_NOW override)" : ""}`);
  if (config.missing.length) console.warn(`  ⚠ missing: ${config.missing.join(", ")} — copy .env.example to .env and fill it in.`);
});

function shutdown() {
  server.close();
  store.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
