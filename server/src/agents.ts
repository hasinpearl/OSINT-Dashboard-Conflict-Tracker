import { envKey } from "./env";
import { logCost, PRICES } from "./costs";

//TUNE: Control the AI model tier (mid = search, light = extraction)
const MID_MODEL = envKey("OPENROUTER_MID_MODEL") || "perplexity/sonar-pro";
const LIGHT_MODEL = envKey("OPENROUTER_LIGHT_MODEL") || "perplexity/sonar";

export const RESOLVED_MODELS = {
  mid: MID_MODEL,
  light: LIGHT_MODEL,
} as const;

export type AgentRole = "light" | "search";

export interface AgentMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

function gatewayUrl(): string {
  return envKey("AI_GATEWAY_URL") || "https://openrouter.ai/api/v1/chat/completions";
}

function modelFor(role: AgentRole): string {
  if (role === "search") return MID_MODEL;
  return LIGHT_MODEL;
}

function priceFor(role: AgentRole): number {
  if (role === "search") return PRICES.openrouter_mid;
  return PRICES.openrouter_light;
}

export async function callAgent(
  panel: string,
  role: AgentRole,
  messages: AgentMessage[],
  opts: { maxTokens?: number; temperature?: number } = {},
): Promise<string> {
  const key = envKey("AI_GATEWAY_KEY");
  if (!key) throw new Error("AI_GATEWAY_KEY not configured");

  const model = modelFor(role);
  logCost({ panel, provider: "openrouter", model, costUsd: priceFor(role) });

  const res = await fetch(gatewayUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "X-Title": "OSINT Conflict Tracker",
    },
    body: JSON.stringify({
      model,
      messages,
      //TUNE: Control the default temperature and max_tokens per call
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens ?? 2000,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.error(`OpenRouter error (${model}):`, res.status, errText.slice(0, 500));
    const err = new Error(`OpenRouter API error: ${res.status}`);
    (err as any).status = res.status;
    throw err;
  }

  const data: any = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

export function extractJsonOr<T>(content: string, fallback: T): T {
  try {
    return JSON.parse(content) as T;
  } catch {
    // fall through to fenced/brace extraction below
  }
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]) as T;
    } catch {
      // fall through to brace extraction below
    }
  }
  for (const [open, close] of [["{", "}"], ["[", "]"]] as const) {
    const first = content.indexOf(open);
    const last = content.lastIndexOf(close);
    if (first !== -1 && last > first) {
      try {
        return JSON.parse(content.slice(first, last + 1)) as T;
      } catch {
        // try the next bracket pair
      }
    }
  }
  return fallback;
}

export async function extractStructured<T>(
  panel: string,
  system: string,
  user: string,
  fallback: T,
  opts: { maxTokens?: number } = {},
): Promise<T> {
  const content = await callAgent(
    panel,
    "light",
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    opts,
  );
  return extractJsonOr(content, fallback);
}

// Perplexity's search_domain_filter / search_recency_filter have no
// OpenRouter equivalent. Restate those constraints in the prompt text
// passed to this function.
export async function searchStructured<T>(
  panel: string,
  system: string,
  user: string,
  fallback: T,
  opts: { maxTokens?: number } = {},
): Promise<T> {
  const content = await callAgent(
    panel,
    "search",
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    //TUNE: Control the default max_tokens for search-tier calls
    { maxTokens: opts.maxTokens ?? 3000 },
  );
  return extractJsonOr(content, fallback);
}
