import { describe, expect, it } from "vitest";
import { runTurn, type AgentDeps } from "../src/agent/agent.js";
import { ManualClock } from "../src/core/clock.js";
import type { AgentEvent } from "../src/core/types.js";
import { MemoryStore } from "../src/memory/store.js";
import { FakeSearch, ScriptedModel } from "./fakes.js";

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

const neonHit = { title: "Neon pricing", url: "https://neon.com/pricing", content: "Launch plan $19/month", publishedDate: "2026-11-06" };

describe("runTurn", () => {
  it("searches, streams a cited answer and saves it with its sources", async () => {
    const store = new MemoryStore(":memory:");
    const clock = new ManualClock(new Date(2026, 10, 10, 15, 0));
    const model = new ScriptedModel([
      { toolCalls: [{ id: "t1", name: "web_search", args: { query: "Neon pricing", since: "2026-11-03" } }] },
      { text: "Neon's Launch plan is now $19/month [1]." },
    ]);
    const search = new FakeSearch(() => [neonHit]);
    const deps: AgentDeps = { store, model, search, clock };

    const events = await collect(runTurn(deps, { message: "Has Neon changed pricing since last Tuesday?" }));

    const types = events.map((e) => e.type).filter((t, i, all) => t !== all[i - 1]);
    expect(types).toEqual(["turn_start", "memory", "search_start", "search_done", "text", "done"]);
    expect(search.requests[0]).toEqual({ query: "Neon pricing", since: "2026-11-03", topic: undefined });

    const done = events.at(-1) as Extract<AgentEvent, { type: "done" }>;
    expect(done.answer).toBe("Neon's Launch plan is now $19/month [1].");
    expect(done.sources.map((s) => s.url)).toEqual(["https://neon.com/pricing"]);

    // The tool result went back to the model with a numbered source.
    expect(model.stepInputs[1]!.toolResults![0]!.content).toContain("[1] Neon pricing (published 2026-11-06)");

    const saved = store.recentExchanges((events[0] as Extract<AgentEvent, { type: "turn_start" }>).conversationId, 5);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.searches).toEqual([{ query: "Neon pricing", since: "2026-11-03", topic: undefined }]);
  });

  it("puts date context and recalled memory in the user message, not the system prompt", async () => {
    const store = new MemoryStore(":memory:");
    const clock = new ManualClock(new Date(2026, 10, 3, 14, 5));
    const first = new ScriptedModel([{ text: "Supabase Pro is $25/month." }]);
    await collect(runTurn({ store, model: first, search: new FakeSearch(() => []), clock }, { message: "Postgres hosting prices?" }));

    clock.set(new Date(2026, 10, 10, 15, 0));
    const second = new ScriptedModel([{ text: "Still $25." }]);
    await collect(runTurn({ store, model: second, search: new FakeSearch(() => []), clock }, { message: "Last Tuesday I asked about Postgres hosting. Still right?" }));

    const req = second.requests[0]!;
    const userMsg = req.messages.at(-1)!.content;
    expect(req.system).not.toMatch(/2026/);
    expect(userMsg).toContain("Now: Tue 10 Nov 2026");
    expect(userMsg).toContain('asked="Tue 3 Nov 2026, 14:05" when="7 days ago" why="matches "Last Tuesday""');
    expect(userMsg).toContain("<answer>Supabase Pro is $25/month.</answer>");
  });

  it("replays this conversation's earlier turns with their timestamps", async () => {
    const store = new MemoryStore(":memory:");
    const clock = new ManualClock(new Date(2026, 10, 10, 9, 0));
    const m1 = new ScriptedModel([{ text: "Hi!" }]);
    const ev = await collect(runTurn({ store, model: m1, search: new FakeSearch(() => []), clock }, { message: "hello" }));
    const conversationId = (ev[0] as Extract<AgentEvent, { type: "turn_start" }>).conversationId;

    clock.set(new Date(2026, 10, 10, 9, 5));
    const m2 = new ScriptedModel([{ text: "You said hello." }]);
    await collect(runTurn({ store, model: m2, search: new FakeSearch(() => []), clock }, { conversationId, message: "what did I just say?" }));

    expect(m2.requests[0]!.messages.slice(0, 2)).toEqual([
      { role: "user", content: "[Sent Tue 10 Nov 2026, 09:00]\nhello" },
      { role: "assistant", content: "Hi!" },
    ]);
  });

  it("forces a final answer after maxSteps and never loops forever", async () => {
    const store = new MemoryStore(":memory:");
    const call = { id: "x", name: "web_search", args: { query: "again" } };
    const model = new ScriptedModel([{ toolCalls: [call] }, { toolCalls: [call] }, { text: "Best answer I have." }]);
    const events = await collect(
      runTurn({ store, model, search: new FakeSearch(() => []), clock: new ManualClock(new Date()), maxSteps: 3 }, { message: "loop" }),
    );
    expect(model.stepInputs.map((s) => s.allowTools)).toEqual([true, true, false]);
    expect(events.at(-1)).toMatchObject({ type: "done", answer: "Best answer I have." });
  });

  it("rejects invalid tool arguments back to the model instead of crashing", async () => {
    const store = new MemoryStore(":memory:");
    const model = new ScriptedModel([
      { toolCalls: [{ id: "bad", name: "web_search", args: { since: "last week" } }] },
      { text: "Sorry." },
    ]);
    const search = new FakeSearch(() => []);
    await collect(runTurn({ store, model, search, clock: new ManualClock(new Date()) }, { message: "x" }));
    expect(search.requests).toHaveLength(0);
    expect(model.stepInputs[1]!.toolResults![0]).toMatchObject({ isError: true });
  });

  it("does not save anything when the turn fails", async () => {
    const store = new MemoryStore(":memory:");
    const model = new ScriptedModel([{ toolCalls: [{ id: "t", name: "web_search", args: { query: "boom" } }] }]);
    model.startTurn = () => ({
      async *step() {
        throw new Error("provider down");
      },
    });
    const events = await collect(runTurn({ store, model, search: new FakeSearch(() => []), clock: new ManualClock(new Date()) }, { message: "x" }));
    expect(events.at(-1)).toEqual({ type: "error", message: "provider down" });
    expect(store.listConversations().flatMap((c) => store.recentExchanges(c.id, 10))).toHaveLength(0);
  });
});
