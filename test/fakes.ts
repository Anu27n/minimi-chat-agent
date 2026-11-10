import type { ChatModel, ModelEvent, ModelTurn, StepInput, StepResult, ToolCall, TurnRequest } from "../src/llm/types.js";
import type { SearchHit, SearchProvider, SearchRequest } from "../src/search/types.js";

/** One scripted model step: optional streamed text, optional tool calls. */
export interface ScriptedStep {
  text?: string;
  toolCalls?: ToolCall[];
}

/**
 * A ChatModel that plays back a script and records what it was given,
 * so agent tests run without network or API keys.
 */
export class ScriptedModel implements ChatModel {
  readonly id = "fake:scripted";
  requests: TurnRequest[] = [];
  stepInputs: StepInput[] = [];

  constructor(private script: ScriptedStep[]) {}

  startTurn(req: TurnRequest): ModelTurn {
    this.requests.push(req);
    const script = [...this.script];
    const inputs = this.stepInputs;
    return {
      async *step(input: StepInput): AsyncGenerator<ModelEvent, StepResult> {
        inputs.push(input);
        const next = script.shift() ?? { text: "(script exhausted)" };
        if (next.text) {
          for (const word of next.text.split(/(?<= )/)) yield { type: "text", delta: word };
        }
        const toolCalls = input.allowTools ? (next.toolCalls ?? []) : [];
        return { text: next.text ?? "", toolCalls, stop: toolCalls.length ? "tool_calls" : "end" };
      },
    };
  }
}

export class FakeSearch implements SearchProvider {
  readonly name = "fake";
  requests: SearchRequest[] = [];

  constructor(private results: (req: SearchRequest) => SearchHit[]) {}

  async search(req: SearchRequest): Promise<SearchHit[]> {
    this.requests.push(req);
    return this.results(req);
  }
}
