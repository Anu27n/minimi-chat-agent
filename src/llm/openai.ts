import OpenAI from "openai";
import type { ResponseInputItem, Tool } from "openai/resources/responses/responses";
import type { ChatModel, ModelEvent, ModelTurn, StepInput, StepResult, StepStop, TurnRequest } from "./types.js";

type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * OpenAI via the Responses API (current OpenAI models only support function
 * calling there). Runs with `store: false` so conversations stay on this machine;
 * reasoning items come back encrypted and are replayed between tool calls.
 */
export class OpenAIChatModel implements ChatModel {
  readonly id: string;

  constructor(
    private client: OpenAI,
    private model: string,
    private effort: ReasoningEffort,
  ) {
    this.id = `openai:${model}`;
  }

  startTurn(req: TurnRequest): ModelTurn {
    return new OpenAITurn(this.client, this.model, this.effort, req);
  }
}

class OpenAITurn implements ModelTurn {
  private input: ResponseInputItem[];
  private tools: Tool[];

  constructor(
    private client: OpenAI,
    private model: string,
    private effort: ReasoningEffort,
    private req: TurnRequest,
  ) {
    this.input = req.messages.map((m) => ({ role: m.role, content: m.content }));
    this.tools = req.tools.map((t) => ({
      type: "function" as const,
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      strict: false,
    }));
  }

  async *step(input: StepInput): AsyncGenerator<ModelEvent, StepResult> {
    for (const r of input.toolResults ?? []) {
      this.input.push({ type: "function_call_output", call_id: r.callId, output: r.content });
    }

    const stream = this.client.responses.stream(
      {
        model: this.model,
        instructions: this.req.system,
        input: this.input,
        tools: this.tools,
        tool_choice: input.allowTools ? "auto" : "none",
        reasoning: { effort: this.effort },
        store: false,
        include: ["reasoning.encrypted_content"],
      },
      { signal: input.signal },
    );

    for await (const event of stream) {
      if (event.type === "response.output_text.delta") yield { type: "text", delta: event.delta };
    }
    const response = await stream.finalResponse();

    // Output items (reasoning, messages, function calls) are valid input items for the next step.
    this.input.push(...(response.output as ResponseInputItem[]));

    const toolCalls = response.output
      .filter((o) => o.type === "function_call")
      .map((o) => ({ id: o.call_id, name: o.name, args: parseJson(o.arguments) }));

    let stop: StepStop;
    const incomplete = response.incomplete_details?.reason;
    if (incomplete === "max_output_tokens") stop = "max_tokens";
    else if (incomplete === "content_filter") stop = "refusal";
    else stop = toolCalls.length ? "tool_calls" : "end";

    return { text: response.output_text ?? "", toolCalls: stop === "tool_calls" ? toolCalls : [], stop };
  }
}

function parseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return { __unparseable: s };
  }
}
