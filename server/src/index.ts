import "./env";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { initDb } from "./db";
import { envKey } from "./env";
import { costsSummaryRoute, diagnosticsRoute, healthRoute, requireAdmin } from "./routes/admin";
import { analystRoute } from "./routes/analyst";
import { auditRefreshRoute } from "./routes/audit";
import { biasTrackerRoute } from "./routes/biasTracker";
import { hotTopicsRoute } from "./routes/hotTopics";
import { newsRoute } from "./routes/news";
import { osintRoute } from "./routes/osint";
import { telegramRoute } from "./routes/telegram";
import { translateRoute } from "./routes/translate";

const app = new Hono();

app.onError((err, c) => {
  console.error(`Unhandled error on ${c.req.path}:`, err);
  return c.json({ error: "Internal error" }, 500);
});

app.get("/api/health", healthRoute);

// Data routes. Same-origin behind nginx, so no CORS handling needed.
// The frontend keeps invoking the old edge-function names via /api/<name>.
app.post("/api/firecrawl-news", newsRoute);
app.post("/api/perplexity-analyst", analystRoute);
app.post("/api/perplexity-osint", osintRoute);
app.post("/api/telegram-feed", telegramRoute);
app.post("/api/ai-summarize", hotTopicsRoute);
app.post("/api/bias-tracker", biasTrackerRoute);
app.post("/api/translate", translateRoute);

// Admin routes.
app.post("/api/audit-refresh", requireAdmin, auditRefreshRoute);
app.get("/api/admin/diagnostics", requireAdmin, diagnosticsRoute);
app.get("/api/admin/costs", requireAdmin, costsSummaryRoute);

app.notFound((c) => c.json({ error: "Not found" }, 404));

const port = Number(envKey("PORT") || 8787);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`API listening on http://localhost:${info.port}`);
});

// Start listening first; the DB connects (and retries) in the background so
// upstream AI calls keep working even when Postgres is down.
initDb();
