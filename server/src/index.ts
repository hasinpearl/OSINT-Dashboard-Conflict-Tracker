import "./env";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { initDb } from "./db";
import { envKey } from "./env";
import { refreshConflictSettings } from "./conflicts";
import { conflictGate } from "./conflictGate";
import {
  conflictsRoute,
  costsSummaryRoute,
  diagnosticsRoute,
  healthRoute,
  requireAdmin,
  setConflictEnabledRoute,
} from "./routes/admin";
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

// The enabled/disabled registry is read from Postgres on a TTL, and every
// route below decides what to reveal from it. Refreshing here rather than in
// each route means a route cannot be added that forgets to: a toggle applied
// through another container is picked up within the TTL by every endpoint at
// once. The call is a no-op while the cached map is fresh.
app.use("*", async (c, next) => {
  await refreshConflictSettings();
  await next();
});

// A panel asked for a conflict that is currently switched off answers with an
// empty list and an explicit marker, never with another conflict's rows. This
// sits directly after the registry refresh, so the decision is made against
// the same map every route below reads, and it is registered ONCE here rather
// than in each of the six panel routes. It is a no-op for "all", for a request
// naming no conflict, and for an enabled one: those reach their route
// untouched.
app.use("*", conflictGate);

app.get("/api/health", healthRoute);

// Which conflicts the API reveals. Unauthenticated like /api/sources: it is
// what the dashboard reads to know which tabs exist, and it carries labels and
// flags only, never content.
app.get("/api/conflicts", conflictsRoute);

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

// Reveal or hide a conflict without an edit and a redeploy. Admin-only: it
// changes what the whole dashboard shows. It never touches stored rows.
app.post("/api/conflicts/:key/enabled", requireAdmin, setConflictEnabledRoute);

app.notFound((c) => c.json({ error: "Not found" }, 404));

const port = Number(envKey("PORT") || 8787);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`API listening on http://localhost:${info.port}`);
});

// Start listening first; the DB connects (and retries) in the background so
// upstream AI calls keep working even when Postgres is down. The conflict
// registry is loaded once the schema exists, so the first request answers from
// Postgres rather than the code defaults; until then the code defaults stand,
// which is the safe direction.
initDb()
  .then(() => refreshConflictSettings(true))
  .then(() => bootstrapCollectors());
