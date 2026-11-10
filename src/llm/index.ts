import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { Config } from "../config.js";
import type { ChatModel } from "./types.js";
import { AnthropicChatModel } from "./anthropic.js";
import { OpenAIChatModel } from "./openai.js";

/** Returns the configured model, or undefined when its API key is missing. */
export function createChatModel(config: Config): ChatModel | undefined {
  if (config.provider === "anthropic") {
    if (!config.anthropic.apiKey) return undefined;
    return new AnthropicChatModel(new Anthropic({ apiKey: config.anthropic.apiKey }), config.anthropic.model, config.anthropic.effort);
  }
  if (!config.openai.apiKey) return undefined;
  return new OpenAIChatModel(new OpenAI({ apiKey: config.openai.apiKey }), config.openai.model, config.openai.reasoningEffort);
}
