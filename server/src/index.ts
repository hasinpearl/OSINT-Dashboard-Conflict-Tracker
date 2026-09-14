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
import { enhancedOnError } from "./errors";
import { eventsRoute, eventsPinsRoute, statsRoute } from "./routes/events";
import { sourcesRoute } from "./routes/sources";
import { bootstrapCollectors } from "./workers/bootstrap";
import { generateRequestId } from "./errors";

const app = new Hono();

// Node's default on an unhandled rejection is to exit, which is how a single
// rejection in a collector loop turned every /api/* route into a 502. The
// collectors are out of this process now, but the API must survive its own
// stray rejections too: a dashboard with broken collectors is degraded, a
// dashboard answering 502 is dead, and degraded is always the better of the
// two. Nothing here exits.
function logFatal(kind: string, err: unknown): void {
  const detail =
    err instanceof Error
      ? { error_message: err.message, stack: err.stack }
      : { error_message: String(err) };
  console.error(
    JSON.stringify({
      error_code: kind,
      request_id: generateRequestId(),
      retryable: false,
      survived: true,
      ...detail,
    }),
  );
}

process.on("unhandledRejection", (reason) => logFatal("unhandled_rejection", reason));
process.on("uncaughtException", (err) => logFatal("uncaught_exception", err));

app.onError(enhancedOnError);

app.get("/api/health", healthRoute);

// Data routes. Same-origin behind nginx, so no CORS handling needed.
app.post("/api/firecrawl-news", newsRoute);
app.post("/api/analyst", analystRoute);
app.post("/api/osint", osintRoute);
app.post("/api/telegram-feed", telegramRoute);
app.post("/api/ai-summarize", hotTopicsRoute);
app.post("/api/bias-tracker", biasTrackerRoute);
app.post("/api/translate", translateRoute);

// New events routes
app.get("/api/events", eventsRoute);
app.get("/api/events/pins", eventsPinsRoute);
app.get("/api/stats", statsRoute);

// Worker health. Unauthenticated on purpose: the panels read it to tell an
// empty store apart from an unreachable source.
app.get("/api/sources", sourcesRoute);

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
initDb().then(() => bootstrapCollectors());
