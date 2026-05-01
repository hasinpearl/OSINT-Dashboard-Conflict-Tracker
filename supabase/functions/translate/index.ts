import { logCost, PRICES } from "../_shared/costs.ts";
import { corsHeadersFor, errorResponse } from "../_shared/cors.ts";

const ALLOWED_LANGS = ["ar"] as const;
const MAX_PAYLOAD_BYTES = 50_000; // 50 KB cap on translation input
const CHUNK_SIZE = 6; // number of leaf string values per AI call
const MODEL = "google/gemini-2.5-flash";

// Keys whose values must NEVER be translated (used as CSS classes, code identifiers, etc.)
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
  // skip pure numbers, hashes, codes
  if (/^[\d\s\-_./:#]+$/.test(s)) return false;
  // require at least one ascii letter
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

function extractJson(content: string): any {
  try { return JSON.parse(content); } catch { /* try fenced */ }
  const m = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m) {
    try { return JSON.parse(m[1]); } catch { /* fall */ }
  }
  // Try to grab the first {...}
  const first = content.indexOf("{");
  const last = content.lastIndexOf("}");
  if (first !== -1 && last > first) {
    try { return JSON.parse(content.slice(first, last + 1)); } catch { /* fall */ }
  }
  return null;
}

const SYSTEM_PROMPT = `You are a professional English-to-Arabic translator. Translate EVERY string value in the provided JSON object.

Rules:
- Translate EVERY value completely. No English words should remain in the Arabic output unless they are proper nouns (names of people, organizations, places).
- Keep ALL JSON keys exactly as they are in English.
- Proper nouns should stay in English with Arabic transliteration in parentheses, e.g. "Reuters (رويترز)".
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
  const AI_GATEWAY_URL = Deno.env.get("AI_GATEWAY_URL") || "https://openrouter.ai/api/v1/chat/completions";
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
  const aiData = await res.json();
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
        // Make sure every key is present, fall back to original for missing
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
  // Final fallback: return originals for this chunk only
  return { ...mapping };
}

Deno.serve(async (req) => {
  const cors = corsHeadersFor(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }
  if (req.method !== "POST") {
    return errorResponse(cors, 405, "Method not allowed");
  }

  try {
    const AI_GATEWAY_KEY = Deno.env.get("AI_GATEWAY_KEY");
    if (!AI_GATEWAY_KEY) {
      return errorResponse(cors, 500, "Service unavailable");
    }

    const contentLength = Number(req.headers.get("content-length") || "0");
    if (contentLength > MAX_PAYLOAD_BYTES) {
      return errorResponse(cors, 413, "Payload too large");
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return errorResponse(cors, 400, "Invalid JSON");
    }
    if (!body || typeof body !== "object") {
      return errorResponse(cors, 400, "Invalid request body");
    }
    const { data, targetLang } = body as { data?: unknown; targetLang?: unknown };
    if (typeof targetLang !== "string" || !ALLOWED_LANGS.includes(targetLang as typeof ALLOWED_LANGS[number])) {
      return errorResponse(cors, 400, "Unsupported targetLang");
    }
    if (data === undefined || data === null) {
      return errorResponse(cors, 400, "Missing data");
    }
    const dataStr = JSON.stringify(data);
    if (dataStr.length > MAX_PAYLOAD_BYTES) {
      return errorResponse(cors, 413, "Payload too large");
    }

    // 1) Collect translatable leaves
    const leaves: Leaf[] = [];
    collectLeaves(data, [], leaves);

    if (leaves.length === 0) {
      return new Response(JSON.stringify({ translated: data }), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // 2) Build small chunks with stable ids -> original strings
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
      if (status === 429) return errorResponse(cors, 429, "Rate limited, try again later");
      if (status === 402) return errorResponse(cors, 402, "AI credits exhausted");
      throw e;
    }

    // 3) Validation pass: any value identical to original gets a single retry as a tiny chunk
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

    // 4) Merge translations back into the cloned structure
    for (const id of ids) {
      const leaf = idToLeaf.get(id)!;
      const v = translations[id] ?? leaf.value;
      setAtPath(result, leaf.path, v);
    }

    return new Response(JSON.stringify({ translated: result }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (error) {
    return errorResponse(cors, 500, "Internal error", error);
  }
});
