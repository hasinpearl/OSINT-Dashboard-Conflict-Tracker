import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Tiny no-dependency .env loader. Reads ./.env and ../.env so that running
// `npm run dev` from either the repo root or server/ picks up config.
// Real environment variables always win over file values.
function loadDotEnv(file: string): void {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    if (process.env[key] !== undefined) continue;
    process.env[key] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

loadDotEnv(resolve(process.cwd(), ".env"));
loadDotEnv(resolve(process.cwd(), "../.env"));

// Env UIs (Coolify etc.) love to smuggle whitespace/quotes into values —
// always trim keys before use.
export function envKey(name: string): string {
  return (process.env[name] ?? "").trim().replace(/^["']|["']$/g, "");
}
