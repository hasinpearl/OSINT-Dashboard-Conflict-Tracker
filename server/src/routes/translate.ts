import type { Context } from "hono";
import { logCost, PRICES } from "../costs";
import { toLatinDigits } from "../digits";
import { envKey } from "../env";
import { extractJson } from "../request";

const ALLOWED_LANGS = ["ar"] as const;
const MAX_PAYLOAD_BYTES = 50_000; // 50 KB cap on translation input
const CHUNK_SIZE = 6; // number of leaf string values per AI call
const MODEL = "google/gemini-2.5-flash";

const PROTECTED_KEYS = new Set([
  "severity", "confidence", "mode", "conflict", "key", "type", "status",
  "source", "coverage_spectrum",
  "left_label", "center_label", "right_label",
  "biasLeftLabel", "biasRightLabel", "biasCenterLabel",
  "timestamp", "last_updated", "cached_at", "url",
]);

type Path = (string | number)[];
interface Leaf {
  path: Path;
  value: string;
}

function looksLikeUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}
function looksLikeIso(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}([T\s]\d{2}:\d{2})?/.test(s);
}
function isTranslatable(s: string): boolean {
  if (!s || s.length === 0) return false;
  if (looksLikeUrl(s) || looksLikeIso(s)) return false;
  if (/^[\d\s\-_./:#]+$/.test(s)) return false;
  if (!/[A-Za-z]/.test(s)) return false;
  return true;
}

function collectLeaves(node: unknown, path: Path, out: Leaf[]): void {
  if (typeof node === "string") {
    if (isTranslatable(node)) out.push({ path, value: node });
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => collectLeaves(v, [...path, i], out));
    return;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (PROTECTED_KEYS.has(k)) continue;
      collectLeaves(v, [...path, k], out);
    }
  }
}

function setAtPath(root: any, path: Path, value: string): void {
  let cur = root;
  for (let i = 0; i < path.length - 1; i++) cur = cur[path[i] as any];
  cur[path[path.length - 1] as any] = value;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

const SYSTEM_PROMPT = `You are a professional English-to-Arabic translator. Translate EVERY string value in the provided JSON object.

Rules:
- Translate EVERY value completely. No English words should remain in the Arabic output unless they are proper nouns (names of people, organizations, places).
- Keep ALL JSON keys exactly as they are in English.
- Proper nouns should stay in English with Arabic transliteration in parentheses, e.g. "Reuters (رويترز)".
- Always write numbers with Western digits (0-9), NEVER Arabic-Indic digits (٠-٩).
- Return ONLY valid JSON with the same keys, no markdown fences, no explanation.`;

async function translateMap(
  apiKey: string,
  mapping: Record<string, string>,
): Promise<Record<string, string> | null> {
  logCost({
    panel: "translate",
    provider: "google_ai",
    model: MODEL,
    costUsd: PRICES.google_ai_gemini_flash,
  });
  const AI_GATEWAY_URL = envKey("AI_GATEWAY_URL") || "https://openrouter.ai/api/v1/chat/completions";
  const res = await fetch(AI_GATEWAY_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Translate every value in this JSON object to Arabic. Keep the keys identical:\n\n${JSON.stringify(mapping)}`,
        },
      ],
    }),
  });
  if (!res.ok) {
    if (res.status === 429 || res.status === 402) {
      const err = new Error(`AI gateway ${res.status}`);
      (err as any).status = res.status;
      throw err;
    }
    console.error("AI Gateway error:", res.status, await res.text().catch(() => ""));
    return null;
  }
  const aiData: any = await res.json();
  const content = aiData.choices?.[0]?.message?.content || "";
  const parsed = extractJson(content);
  if (!parsed || typeof parsed !== "object") return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

async function translateChunkWithRetry(
  apiKey: string,
  mapping: Record<string, string>,
): Promise<Record<string, string>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await translateMap(apiKey, mapping);
      if (result) {
        const merged: Record<string, string> = {};
        for (const k of Object.keys(mapping)) {
          merged[k] = typeof result[k] === "string" && result[k].trim().length > 0
            ? result[k]
            : mapping[k];
        }
        return merged;
      }
    } catch (e) {
      if ((e as any).status === 429 || (e as any).status === 402) throw e;
      console.error("Chunk translation attempt failed:", e);
    }
  }
  return { ...mapping };
}

export async function translateRoute(c: Context) {
  const AI_GATEWAY_KEY = envKey("AI_GATEWAY_KEY");
  if (!AI_GATEWAY_KEY) {
    return c.json({ error: "Service unavailable" }, 500);
  }

  const contentLength = Number(c.req.header("content-length") || "0");
  if (contentLength > MAX_PAYLOAD_BYTES) {
    return c.json({ error: "Payload too large" }, 413);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  if (!body || typeof body !== "object") {
    return c.json({ error: "Invalid request body" }, 400);
  }
  const { data, targetLang } = body as { data?: unknown; targetLang?: unknown };
  if (typeof targetLang !== "string" || !ALLOWED_LANGS.includes(targetLang as (typeof ALLOWED_LANGS)[number])) {
    return c.json({ error: "Unsupported targetLang" }, 400);
  }
  if (data === undefined || data === null) {
    return c.json({ error: "Missing data" }, 400);
  }
  const dataStr = JSON.stringify(data);
  if (dataStr.length > MAX_PAYLOAD_BYTES) {
    return c.json({ error: "Payload too large" }, 413);
  }

  const leaves: Leaf[] = [];
  collectLeaves(data, [], leaves);

  if (leaves.length === 0) {
    return c.json({ translated: data });
  }

  const result = deepClone(data);
  const idToLeaf = new Map<string, Leaf>();
  leaves.forEach((leaf, i) => idToLeaf.set(`v${i}`, leaf));

  const ids = Array.from(idToLeaf.keys());
  const chunks = chunk(ids, CHUNK_SIZE);

  const translations: Record<string, string> = {};

  try {
    for (const ck of chunks) {
      const mapping: Record<string, string> = {};
      for (const id of ck) mapping[id] = idToLeaf.get(id)!.value;
      const translated = await translateChunkWithRetry(AI_GATEWAY_KEY, mapping);
      Object.assign(translations, translated);
    }
  } catch (e) {
    const status = (e as any).status;
    if (status === 429) return c.json({ error: "Rate limited, try again later" }, 429);
    if (status === 402) return c.json({ error: "AI credits exhausted" }, 402);
    throw e;
  }

  const stale: string[] = [];
  for (const id of ids) {
    const orig = idToLeaf.get(id)!.value;
    const got = translations[id];
    if (!got || got.trim() === orig.trim()) stale.push(id);
  }

  if (stale.length > 0) {
    console.log(`Retrying ${stale.length} untranslated values`);
    const retryChunks = chunk(stale, Math.min(CHUNK_SIZE, 4));
    for (const ck of retryChunks) {
      const mapping: Record<string, string> = {};
      for (const id of ck) mapping[id] = idToLeaf.get(id)!.value;
      try {
        const retried = await translateChunkWithRetry(AI_GATEWAY_KEY, mapping);
        for (const id of ck) {
          const orig = idToLeaf.get(id)!.value;
          const v = retried[id];
          if (v && v.trim() !== orig.trim()) translations[id] = v;
        }
      } catch (e) {
        console.error("Retry chunk failed:", e);
      }
    }
  }

  for (const id of ids) {
    const leaf = idToLeaf.get(id)!;
    const v = translations[id] ?? leaf.value;
    // Belt and suspenders: the prompt asks for Western digits, but the model
    // is not reliable about it — normalize every translated string here.
    setAtPath(result, leaf.path, toLatinDigits(v));
  }

  return c.json({ translated: result });
}
