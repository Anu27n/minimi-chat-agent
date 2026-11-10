import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageParam, BetaToolUnion } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { ChatModel, ModelEvent, ModelTurn, StepInput, StepResult, StepStop, TurnRequest } from "./types.js";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Claude via the Messages API, streamed.
 *
 * - Adaptive thinking is on by default for Claude Opus 5.5; `effort` is the speed/depth dial.
 * - Server-side refusal fallback ("default") is enabled so a false-positive safety
 *   decline is retried on another model instead of ending the turn.
 * - The system prompt is static and cached; everything that changes per turn
 *   (date, recalled memory) goes in the user message, so the cached prefix survives.
 */
export class AnthropicChatModel implements ChatModel {
  readonly id: string;

  constructor(
    private client: Anthropic,
    private model: string,
    private effort: Effort,
  ) {
    this.id = `anthropic:${model}`;
  }

  startTurn(req: TurnRequest): ModelTurn {
    return new AnthropicTurn(this.client, this.model, this.effort, req);
  }
}

class AnthropicTurn implements ModelTurn {
  private messages: BetaMessageParam[];
  private tools: BetaToolUnion[];

  constructor(
    private client: Anthropic,
    private model: string,
    private effort: Effort,
    private req: TurnRequest,
  ) {
    this.messages = req.messages.map((m) => ({ role: m.role, content: m.content }));
    this.tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Tool.InputSchema,
    }));
  }

  async *step(input: StepInput): AsyncGenerator<ModelEvent, StepResult> {
    if (input.toolResults?.length) {
      // All results for one assistant message go back in a single user message.
      this.messages.push({
        role: "user",
        content: input.toolResults.map((r) => ({
          type: "tool_result" as const,
          tool_use_id: r.callId,
          content: r.content,
          is_error: r.isError,
        })),
      });
    }

    const stream = this.client.beta.messages.stream(
      {
        model: this.model,
        max_tokens: 32000,
        system: [{ type: "text", text: this.req.system, cache_control: { type: "ephemeral" } }],
        messages: this.messages,
        tools: this.tools,
        tool_choice: input.allowTools ? { type: "auto" } : { type: "none" },
        output_config: { effort: this.effort },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      },
      { signal: input.signal },
    );

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        yield { type: "text", delta: event.delta.text };
      }
    }
    const message = await stream.finalMessage();

    // Replay the assistant turn unchanged (thinking blocks included) on the next step.
    this.messages.push({ role: "assistant", content: message.content });

    const toolCalls = message.content
      .filter((b) => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, args: b.input }));
    const text = message.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");

    let stop: StepStop;
    switch (message.stop_reason) {
      case "tool_use":
        stop = "tool_calls";
        break;
      case "refusal":
        stop = "refusal";
        break;
      case "max_tokens":
        // Never run tools whose input may have been cut off.
        stop = "max_tokens";
        break;
      default:
        stop = toolCalls.length ? "tool_calls" : "end";
    }
    return { text, toolCalls: stop === "tool_calls" ? toolCalls : [], stop };
  }
}
