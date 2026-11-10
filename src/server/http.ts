import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { serveStatic } from "@hono/node-server/serve-static";
import { z } from "zod";
import type { Config } from "../config.js";
import type { AgentDeps } from "../agent/agent.js";
import { runTurn } from "../agent/agent.js";
import type { MemoryStore } from "../memory/store.js";

export interface ServerDeps {
  config: Config;
  store: MemoryStore;
  /** Undefined when API keys are missing; the UI then explains what to set. */
  agent?: AgentDeps;
}

const ChatBody = z.object({
  conversationId: z.string().max(100).optional(),
  message: z.string().trim().min(1).max(8000),
});

/** Thin HTTP layer: JSON for reads, Server-Sent Events for the chat stream. */
export function createApp({ config, store, agent }: ServerDeps): Hono {
  const app = new Hono();

  app.get("/api/status", (c) =>
    c.json({
      ready: Boolean(agent),
      model: agent?.model.id ?? null,
      search: agent?.search.name ?? null,
      missing: config.missing,
      now: (agent?.clock.now() ?? new Date()).toISOString(),
    }),
  );

  app.get("/api/conversations", (c) =>
    c.json(store.listConversations().map((cv) => ({ id: cv.id, title: cv.title, updatedAt: cv.updatedAt.toISOString() }))),
  );

  app.get("/api/conversations/:id", (c) => {
    const conversation = store.getConversation(c.req.param("id"));
    if (!conversation) return c.json({ error: "not found" }, 404);
    const exchanges = store.recentExchanges(conversation.id, 200);
    return c.json({
      id: conversation.id,
      title: conversation.title,
      exchanges: exchanges.map((e) => ({
        id: e.id,
        askedAt: e.askedAt.toISOString(),
        question: e.question,
        answer: e.answer,
        sources: e.sources,
        searches: e.searches,
      })),
    });
  });

  app.post("/api/chat", async (c) => {
    const parsed = ChatBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Body must be { message: string, conversationId?: string }" }, 400);
    if (!agent) return c.json({ error: `Missing configuration: ${config.missing.join(", ")}. Add it to .env and restart.` }, 503);

    return streamSSE(c, async (stream) => {
      const controller = new AbortController();
      stream.onAbort(() => controller.abort());
      for await (const event of runTurn(agent, { ...parsed.data, signal: controller.signal })) {
        await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
      }
    });
  });

  app.use("/*", serveStatic({ root: "./public" }));
  return app;
}
