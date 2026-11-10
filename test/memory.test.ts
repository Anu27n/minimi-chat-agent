import { beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../src/memory/store.js";
import { extractKeywords, recall } from "../src/memory/retriever.js";

const NOW = new Date(2026, 10, 10, 15, 0); // Tue 10 Nov 2026

function seed(store: MemoryStore) {
  const c1 = store.createConversation("Postgres", new Date(2026, 10, 3, 14, 0));
  const c2 = store.createConversation("CRM", new Date(2026, 10, 9, 11, 0));
  const base = { sources: [], searches: [], model: "fake" };
  const pg = store.addExchange({
    ...base,
    conversationId: c1.id,
    askedAt: new Date(2026, 10, 3, 14, 5),
    answeredAt: new Date(2026, 10, 3, 14, 6),
    question: "Cheapest managed Postgres hosting for a startup?",
    answer: "Neon's free tier and Supabase Pro at $25/month are the cheapest.",
  });
  const recipe = store.addExchange({
    ...base,
    conversationId: c1.id,
    askedAt: new Date(2026, 10, 3, 19, 0),
    answeredAt: new Date(2026, 10, 3, 19, 1),
    question: "A quick dal recipe?",
    answer: "Rinse lentils, boil with turmeric…",
  });
  const crm = store.addExchange({
    ...base,
    conversationId: c2.id,
    askedAt: new Date(2026, 10, 9, 11, 30),
    answeredAt: new Date(2026, 10, 9, 11, 31),
    question: "Compare HubSpot, Salesforce, Pipedrive, Zoho and Close CRM pricing for 20 reps.",
    answer: "Pipedrive is cheapest per seat; Salesforce is the most expensive.",
  });
  return { pg, recipe, crm, c1, c2 };
}

describe("MemoryStore", () => {
  let store: MemoryStore;
  beforeEach(() => {
    store = new MemoryStore(":memory:");
  });

  it("finds exchanges by date range, topic matches first", () => {
    const { pg, recipe } = seed(store);
    const found = store.exchangesBetween(new Date(2026, 10, 3), new Date(2026, 10, 4), { terms: ["postgres"] });
    expect(found.map((e) => e.id)).toEqual([pg.id, recipe.id]);
  });

  it("searches by topic with BM25 and ignores FTS syntax in user text", () => {
    const { crm } = seed(store);
    expect(store.searchExchanges(["pipedrive"]).map((e) => e.id)).toEqual([crm.id]);
    expect(() => store.searchExchanges(['"); DROP TABLE exchanges; --', "NEAR(", "*"])).not.toThrow();
  });

  it("keeps per-conversation history in order", () => {
    const { c1, pg, recipe } = seed(store);
    expect(store.recentExchanges(c1.id, 10).map((e) => e.id)).toEqual([pg.id, recipe.id]);
    expect(store.recentExchanges(c1.id, 1).map((e) => e.id)).toEqual([recipe.id]);
  });
});

describe("recall", () => {
  let store: MemoryStore;
  beforeEach(() => {
    store = new MemoryStore(":memory:");
  });

  it("recalls by date phrase across conversations", () => {
    const { pg } = seed(store);
    const r = recall(store, "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?", NOW);
    expect(r.recalled[0]).toMatchObject({ reason: "date", matched: "Last Tuesday" });
    expect(r.recalled[0]!.exchange.id).toBe(pg.id);
    expect(r.notes).toEqual([]);
  });

  it("says so explicitly when nothing was said on that date", () => {
    seed(store);
    const r = recall(store, "What did I ask you on 5 November?", NOW);
    expect(r.notes).toEqual(['No saved conversations from Thu 5 Nov 2026 (the user said "on 5 November").']);
  });

  it("falls back to topic when there is no date", () => {
    const { crm } = seed(store);
    const r = recall(store, "Has Pipedrive changed its pricing?", NOW);
    expect(r.recalled.map((x) => [x.reason, x.exchange.id])).toEqual([["topic", crm.id]]);
  });

  it("treats 'still correct today' as the present, not a memory lookup", () => {
    seed(store);
    const r = recall(store, "What did I ask you on 3 November? Is your answer still correct today?", NOW);
    expect(r.timeRefs.map((t) => t.phrase)).toEqual(["on 3 November"]);
    expect(r.recalled.every((x) => x.exchange.askedAt.getDate() === 3)).toBe(true);
  });

  it("does not repeat exchanges already in the prompt", () => {
    const { pg } = seed(store);
    const r = recall(store, "postgres hosting", NOW, { excludeIds: new Set([pg.id]) });
    expect(r.recalled.map((x) => x.exchange.id)).not.toContain(pg.id);
  });
});

describe("extractKeywords", () => {
  it("drops dates and filler, keeps content words", () => {
    expect(extractKeywords("Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?")).toEqual([
      "postgres",
      "hosting",
      "pricing",
    ]);
  });
});
