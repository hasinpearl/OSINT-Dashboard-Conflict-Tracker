import type { Context } from "hono";

export async function readJsonBody(c: Context): Promise<any> {
  return await c.req.json().catch(() => ({}));
}

// Every data route honors force_refresh, from body or query string.
export function readForceRefresh(c: Context, body: any): boolean {
  return body?.force_refresh === true || c.req.query("force_refresh") === "true";
}

export function extractJson(content: string): any {
  try {
    return JSON.parse(content);
  } catch {
    /* try fenced */
  }
  const m = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m) {
    try {
      return JSON.parse(m[1]);
    } catch {
      /* fall through */
    }
  }
  const first = content.indexOf("{");
  const last = content.lastIndexOf("}");
  if (first !== -1 && last > first) {
    try {
      return JSON.parse(content.slice(first, last + 1));
    } catch {
      /* fall through */
    }
  }
  return null;
}
