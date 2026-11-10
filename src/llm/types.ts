/**
 * The seam between the agent and any LLM provider.
 *
 * Across turns the agent keeps a provider-neutral, text-only history (that's what
 * gets stored and replayed). *Within* a turn, each adapter keeps its own native
 * transcript — Anthropic thinking blocks, OpenAI reasoning items — and replays it
 * verbatim between tool calls, because both APIs require that and the agent loop
 * has no business knowing about it. Hence `startTurn()` returns a stateful ModelTurn.
 */

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
}

export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Parsed but unvalidated arguments; the tool validates them. */
  args: unknown;
}

export interface ToolResult {
  callId: string;
  content: string;
  isError: boolean;
}

export type StepStop = "end" | "tool_calls" | "max_tokens" | "refusal";

export interface StepResult {
  text: string;
  toolCalls: ToolCall[];
  stop: StepStop;
}

export type ModelEvent = { type: "text"; delta: string };

export interface StepInput {
  /** Results for the tool calls the previous step asked for. */
  toolResults?: ToolResult[];
  /** false on the last allowed step: the model must answer with what it has. */
  allowTools: boolean;
  signal?: AbortSignal;
}

export interface ModelTurn {
  /** One model call. Streams text as it arrives, returns what the model wants next. */
  step(input: StepInput): AsyncGenerator<ModelEvent, StepResult>;
}

export interface TurnRequest {
  system: string;
  /** Prior turns plus the new user message last. */
  messages: HistoryMessage[];
  tools: ToolSpec[];
}

export interface ChatModel {
  /** e.g. "anthropic:claude-opus-5-5"; stored with every exchange. */
  readonly id: string;
  startTurn(req: TurnRequest): ModelTurn;
}
