import type { Clock } from "../core/clock.js";
import type { AgentEvent, Conversation } from "../core/types.js";
import type { ChatModel, StepResult, ToolResult } from "../llm/types.js";
import type { MemoryStore } from "../memory/store.js";
import { recall } from "../memory/retriever.js";
import type { SearchProvider } from "../search/types.js";
import { buildTurnEnvelope, historyMessages, SYSTEM_PROMPT } from "./prompt.js";
import { runWebSearch, SourceRegistry, WEB_SEARCH_TOOL } from "./webSearchTool.js";

export interface AgentDeps {
  store: MemoryStore;
  model: ChatModel;
  search: SearchProvider;
  clock: Clock;
  /** Past exchanges of the current conversation replayed verbatim. */
  historyLimit?: number;
  /** Model calls per turn. The last one has tools disabled so the turn always ends with an answer. */
  maxSteps?: number;
}

export interface TurnInput {
  conversationId?: string;
  message: string;
  signal?: AbortSignal;
}

/**
 * One user turn, end to end:
 *
 *   recall memory → build prompt → [model ⇄ web_search]* → persist → done
 *
 * It is an async generator of AgentEvents, so the transport (SSE here, a CLI or
 * a Mac app elsewhere) just forwards events and the agent knows nothing about HTTP.
 * The exchange is written to memory only after the answer completes, so an
 * aborted or failed turn never becomes a "memory".
 */
export async function* runTurn(deps: AgentDeps, input: TurnInput): AsyncGenerator<AgentEvent> {
  const { store, model, search, clock } = deps;
  const maxSteps = deps.maxSteps ?? 5;
  const askedAt = clock.now();

  try {
    const conversation = resolveConversation(store, input.conversationId, input.message, askedAt);
    yield { type: "turn_start", conversationId: conversation.id, askedAt: askedAt.toISOString() };

    // 1. Memory: recent turns of this conversation + recalled exchanges from anywhere.
    const history = store.recentExchanges(conversation.id, deps.historyLimit ?? 10);
    const memory = recall(store, input.message, askedAt, { excludeIds: new Set(history.map((e) => e.id)) });
    yield {
      type: "memory",
      recalled: memory.recalled.map((r) => ({
        id: r.exchange.id,
        askedAt: r.exchange.askedAt.toISOString(),
        question: r.exchange.question,
        reason: r.reason,
        matched: r.matched,
      })),
      notes: memory.notes,
    };

    // 2. The model loop.
    const turn = model.startTurn({
      system: SYSTEM_PROMPT,
      messages: [...historyMessages(history), { role: "user", content: buildTurnEnvelope(input.message, askedAt, memory) }],
      tools: [WEB_SEARCH_TOOL],
    });
    const registry = new SourceRegistry();
    let answer = "";
    let toolResults: ToolResult[] | undefined;
    let last: StepResult | undefined;

    for (let step = 0; step < maxSteps; step++) {
      const gen = turn.step({ toolResults, allowTools: step < maxSteps - 1, signal: input.signal });
      let startedText = false;
      for (;;) {
        const next = await gen.next();
        if (next.done) {
          last = next.value;
          break;
        }
        // Separate text from different steps (e.g. a preamble before a search, then the answer).
        let delta = next.value.delta;
        if (!startedText && answer.trim()) delta = `\n\n${delta.trimStart()}`;
        startedText = true;
        answer += delta;
        yield { type: "text", delta };
      }

      if (last.stop !== "tool_calls") break;

      // 3. Run every tool call from this step concurrently.
      for (const call of last.toolCalls) {
        const args = call.args as { query?: string; since?: string; topic?: string };
        yield { type: "search_start", callId: call.id, query: String(args?.query ?? ""), since: args?.since, topic: args?.topic };
      }
      const outcomes = await Promise.all(
        last.toolCalls.map(async (call) => {
          if (call.name !== WEB_SEARCH_TOOL.name) {
            return { call, outcome: { sources: [], isError: true, resultText: `Unknown tool "${call.name}". The only tool is web_search.` } };
          }
          return { call, outcome: await runWebSearch(call.args, search, registry, input.signal) };
        }),
      );
      for (const { call, outcome } of outcomes) {
        const args = call.args as { query?: string };
        yield {
          type: "search_done",
          callId: call.id,
          query: String(args?.query ?? ""),
          sources: outcome.sources,
          error: outcome.isError ? outcome.resultText : undefined,
        };
      }
      toolResults = outcomes.map(({ call, outcome }) => ({ callId: call.id, content: outcome.resultText, isError: outcome.isError }));
    }

    answer = answer.trim();
    if (!answer) {
      answer =
        last?.stop === "refusal"
          ? "I can't help with that one."
          : "Sorry — I couldn't put an answer together for that. Could you rephrase or try again?";
      yield { type: "text", delta: answer };
    }

    // 4. Persist, then tell the client it is final.
    const sources = registry.cited(answer);
    const saved = store.addExchange({
      conversationId: conversation.id,
      askedAt,
      answeredAt: clock.now(),
      question: input.message,
      answer,
      sources,
      searches: registry.searches,
      model: model.id,
    });
    yield { type: "done", exchangeId: saved.id, answer, sources };
  } catch (err) {
    if (input.signal?.aborted) return;
    yield { type: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

function resolveConversation(store: MemoryStore, id: string | undefined, message: string, at: Date): Conversation {
  if (id) {
    const existing = store.getConversation(id);
    if (existing) return existing;
  }
  const title = message.replace(/\s+/g, " ").trim().slice(0, 60) + (message.length > 60 ? "…" : "");
  return store.createConversation(title, at);
}
