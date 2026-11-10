import { z } from "zod";

/**
 * All configuration comes from the environment (see .env.example).
 * Parsing happens once at startup; the rest of the code receives a typed object
 * and never reads process.env directly.
 */
const Env = z.object({
  LLM_PROVIDER: z.enum(["anthropic", "openai"]).optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-opus-5-5"),
  ANTHROPIC_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-6.1-terra"),
  OPENAI_REASONING_EFFORT: z.enum(["none", "low", "medium", "high", "xhigh", "max"]).default("low"),
  TAVILY_API_KEY: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  DB_PATH: z.string().default("./data/minimi.db"),
  AGENT_NOW: z.string().optional(),
});

export type Config = {
  provider: "anthropic" | "openai";
  anthropic: { apiKey?: string; model: string; effort: z.infer<typeof Env>["ANTHROPIC_EFFORT"] };
  openai: { apiKey?: string; model: string; reasoningEffort: z.infer<typeof Env>["OPENAI_REASONING_EFFORT"] };
  tavilyApiKey?: string;
  port: number;
  dbPath: string;
  agentNow?: Date;
  /** Human-readable problems that stop chat from working (shown in the UI, not fatal). */
  missing: string[];
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Treat empty strings in .env ("KEY=") as unset.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ""));
  const e = Env.parse(cleaned);

  const provider = e.LLM_PROVIDER ?? (e.ANTHROPIC_API_KEY ? "anthropic" : e.OPENAI_API_KEY ? "openai" : "anthropic");

  const missing: string[] = [];
  if (provider === "anthropic" && !e.ANTHROPIC_API_KEY) missing.push("ANTHROPIC_API_KEY (or set LLM_PROVIDER=openai with OPENAI_API_KEY)");
  if (provider === "openai" && !e.OPENAI_API_KEY) missing.push("OPENAI_API_KEY");
  if (!e.TAVILY_API_KEY) missing.push("TAVILY_API_KEY");

  let agentNow: Date | undefined;
  if (e.AGENT_NOW) {
    agentNow = new Date(e.AGENT_NOW);
    if (Number.isNaN(agentNow.getTime())) throw new Error(`AGENT_NOW is not a valid date: ${e.AGENT_NOW}`);
  }

  return {
    provider,
    anthropic: { apiKey: e.ANTHROPIC_API_KEY, model: e.ANTHROPIC_MODEL, effort: e.ANTHROPIC_EFFORT },
    openai: { apiKey: e.OPENAI_API_KEY, model: e.OPENAI_MODEL, reasoningEffort: e.OPENAI_REASONING_EFFORT },
    tavilyApiKey: e.TAVILY_API_KEY,
    port: e.PORT,
    dbPath: e.DB_PATH,
    agentNow,
    missing,
  };
}
