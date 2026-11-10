import { loadConfig } from "../config.js";
import { ManualClock } from "../core/clock.js";
import { addDays, formatDateTime } from "../core/time.js";
import { createChatModel } from "../llm/index.js";
import { MemoryStore } from "../memory/store.js";
import { TavilySearch } from "../search/tavily.js";
import { runTurn } from "../agent/agent.js";

/**
 * Optional demo data. Asks the real agent two questions *as if* on earlier days
 * (by moving the injected clock back), so you can immediately try:
 *   "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"
 *   "On Monday we shortlisted 5 CRM tools. Has any of them changed pricing or shipped something big since?"
 *
 * The answers come from today's web (search can't travel in time), so expect
 * "no change found" when you re-check them. Usage: npm run seed
 */
try {
  process.loadEnvFile(".env");
} catch {}

const config = loadConfig();
const model = createChatModel(config);
if (!model || !config.tavilyApiKey) {
  console.error(`Seeding runs the real agent and needs keys. Missing: ${config.missing.join(", ")}`);
  process.exit(1);
}

const now = config.agentNow ?? new Date();
const store = new MemoryStore(config.dbPath);
const clock = new ManualClock(now);
const deps = { store, model, search: new TavilySearch(config.tavilyApiKey), clock };

const seeds = [
  {
    at: mostRecent(2 /* Tuesday */, now, 14, 10),
    message:
      "What are the cheapest managed Postgres hosting options for a small startup right now? Compare Neon, Supabase, AWS RDS and Render on entry-level pricing.",
  },
  {
    at: mostRecent(1 /* Monday */, now, 11, 30),
    message:
      "We're a 20-person sales team and we've shortlisted 5 CRM tools: HubSpot Sales Hub, Salesforce Sales Cloud, Pipedrive, Zoho CRM and Close. Compare their per-seat pricing and what each is best at.",
  },
];

for (const seed of seeds) {
  clock.set(seed.at);
  console.log(`\n▶ ${formatDateTime(seed.at)}  ${seed.message}`);
  for await (const event of runTurn(deps, { message: seed.message })) {
    if (event.type === "search_start") console.log(`  searching: ${event.query}`);
    if (event.type === "done") console.log(`  saved exchange #${event.exchangeId} (${event.answer.length} chars, ${event.sources.length} sources)`);
    if (event.type === "error") console.error(`  error: ${event.message}`);
  }
}
store.close();

/** The most recent given weekday strictly before `now` (0 = Sunday), at hh:mm local time. */
function mostRecent(weekday: number, now: Date, hh: number, mm: number): Date {
  let d = addDays(now, -1);
  while (d.getDay() !== weekday) d = addDays(d, -1);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm);
}
