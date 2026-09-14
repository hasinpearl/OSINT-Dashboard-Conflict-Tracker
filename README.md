# OSINT Conflict Tracker

Real-time OSINT intelligence dashboard tracking Iran/U.S., Ukraine/Russia, and China/Taiwan conflicts.

## Stack

React 18, TypeScript, Vite, Tailwind CSS, Node (Hono) API, PostgreSQL, OpenRouter (AI gateway), and a set of free collection workers (Telegram web preview, RSS).

**No paid scraping service is required.** See [Zero paid dependencies](#zero-paid-dependencies).

## Architecture

The frontend only ever talks to `/api/*` on its own origin. All provider keys live server-side.

```
sources ──► workers (Telegram public preview, RSS: append-only ingest)
              │
browser ──► web  (nginx: serves the SPA build, proxies /api)
            └──► api (Node + Hono: reads the DB, optional read-through cache, cost log)
                  └──► db (PostgreSQL, persistent volume)
```

- **Collection workers**: Long-lived processes that write every item to Postgres with the
  timestamp the *source* published, deduped on `(source, external_id)`. Sources are the
  Telegram web preview and RSS feeds. Nothing is generated or inferred at ingest time.
- **PostgreSQL is the source of truth.** Panels read `items`; the response cache is an
  optional read-through layer, never the origin.
- **AI gateway (OpenRouter)**: Enrichment and analysis: classification, summaries, Arabic
  translation. Optional. The dashboard runs and displays real data without it.

- **API server** (`server/`): Serves events and statistics from Postgres (`items` ordered by the source's own `published_at`, keyset-paginated). Logs per-call costs. Filters analyst commentary to a curated per-conflict expert roster.
- **Frontend**: React dashboard with breaking-news ticker, notifications, and multi-language support (Western digits enforced everywhere)

## Zero paid dependencies

This project is meant to be deployed by anyone, for free. **PostgreSQL is the only hard
requirement.** Everything else either costs nothing or is optional.

| Concern | Solution | Cost |
|---|---|---|
| Telegram collection | Public web preview (`t.me/s/<channel>`), parsed directly | Free |
| Telegram, upgraded | MTProto (GramJS / Telethon): live push, private channels | Free |
| RSS collection | `rss-parser` / `feedparser` | Free |
| Article text extraction | `@mozilla/readability` + `jsdom` (the engine behind Firefox Reader Mode) | Free |
| Bot-walled outlets | Wayback Machine CDX API fallback | Free |
| Search | Self-hosted SearXNG | Free |
| Storage | Self-hosted PostgreSQL | Free |
| AI enrichment | OpenRouter, **optional** | Paid, opt-in |

### What used to require payment, and why it no longer does

This project previously depended on Firecrawl, a paid HTML-to-markdown scraping API. It has
been removed entirely, for a reason worth recording:

**The markdown conversion was destroying the data.** Telegram's public preview carries the
real publish time in the HTML: `<time datetime="2026-09-13T08:21:50+00:00">` and
`data-post="channel/30654"`. Markdown has no syntax for attributes, so that conversion threw
both away. The model downstream then received only the visible `08:21` label with no date,
was asked for an ISO-8601 timestamp, and produced a plausible invention. The information was
never missing. It was discarded and hallucinated back.

Two rules follow, and they are load-bearing:

1. **Never let a model generate a timestamp.** If the source does not provide one, store
   `NULL`. An invented time is worse than a missing one, because no staleness check can
   detect it.
2. **Parse the source, not a conversion of it.** Read attributes from the markup directly.

### Optional: AI enrichment

Classification, summarisation and Arabic translation are the only things here that can cost
money, and the pipeline is built to work without them:

- `event_type` and `severity` classification can be **rules-based** (keyword mapping in SQL)
  at zero cost. Start there.
- Model-backed summaries and translation are opt-in. Set `AI_GATEWAY_KEY` to enable;
  leave it unset and the dashboard still shows real, correctly-timed data.

## Setup

### Prerequisites

Nothing to buy. You need:

- **PostgreSQL 16+** (or just use the bundled `db` service in `docker-compose.yml`)
- **Docker**, for the compose deployment

Optional, only if you want AI enrichment:
- An [OpenRouter](https://openrouter.ai) key, set as `AI_GATEWAY_KEY`


### Local Development

```bash
cp .env.example .env    # fill in your API keys
npm install
npm --prefix server install

npm run dev:api         # API on http://localhost:8787 (Postgres optional; caching pauses without it)
npm run dev             # http://localhost:8080 (proxies /api to :8787)
```

### Environment Variables

All configuration lives in the root `.env` (see `.env.example` for the full list).

**Required:**

- `DATABASE_URL` - Postgres connection for local dev (docker-compose wires its own)

**Collection:**

- `RSS_FEEDS` - comma-separated feed URLs. Ships with a validated default list.
- `RSS_POLL_SECONDS` - seconds between RSS polling rounds (default 120)
- `TG_PREVIEW_CHANNELS` - comma-separated public channel usernames for the Telegram web-preview collector
- `TG_PREVIEW_POLL_SECONDS` - seconds between Telegram polling rounds (default 120)
- `TG_PREVIEW_MAX_PAGES` - how many history pages to backfill per channel per run (default 25)
- `TG_API_ID` / `TG_API_HASH` / `TG_SESSION` - **optional**, only for the MTProto collector.

**Optional (AI enrichment):**

- `AI_GATEWAY_URL` / `AI_GATEWAY_KEY` - OpenRouter gateway. Leave `AI_GATEWAY_KEY` unset to run without AI; every panel still shows real data.
- `OPENROUTER_LIGHT_MODEL` / `OPENROUTER_MID_MODEL` - override the default model pair
- `TIMELINE_MAX_EVENTS` - cap on events returned per conflict timeline, default 40

**Admin:**

- `ADMIN_TOKEN` - bearer token for `/api/audit-refresh`, `/api/admin/diagnostics`, `/api/admin/costs`

No scraping-service key is needed. If you find `FIRECRAWL_API_KEY` in an older `.env`,
it is no longer read.


### Health & Diagnostics

- `GET /api/health` - key presence booleans + DB status (public)
- `GET /api/admin/diagnostics` - live-tests each provider with a minimal real call; returns exact upstream status codes (requires admin token)
- `GET /api/admin/costs` - aggregated API cost log (requires admin token)

## Deploy (Docker Compose)

```bash
cp .env.example .env    # set API keys, ADMIN_TOKEN and a real POSTGRES_PASSWORD
docker compose up -d --build
# dashboard on http://localhost:${WEB_PORT:-8081}
```

Four services: `db` (postgres:16 + volume), `api` (build of `server/`), `workers` (the same image, running the collection processes with no HTTP port), and `web` (frontend build behind nginx, which proxies `/api` to the api container).

The `workers` service is what keeps the dashboard current. It is a long-lived process, not
request-triggered. Panels read whatever the workers have already stored, so a page load
never waits on an upstream fetch and never depends on a scrape succeeding at that moment.

Collection does not depend on that container existing. On start the API waits
`WORKERS_IN_API_GRACE_SECONDS` (default 90) for a worker heartbeat in `source_status`; if
none appears it runs the same collector loops in-process, so an api-only deployment still
ingests. The logs always name the path taken, either `standalone worker detected, not
starting in-process collectors` or `no worker heartbeat after 90s, starting collectors
in-process`. Two guards stop a double run: the workers entrypoint never runs the API's
bootstrap at all, and collection is held under a Postgres session advisory lock that only one
process per database can hold, so even two API containers cannot both collect. If the workers
container starts later, the in-process copy sees its heartbeat, stops its loops, and drops the
lease. Setting `WORKERS_IN_API=false` on the `workers` service in `docker-compose.yml` is
worth adding as a third, explicit guard.

Port publishing lives in `docker-compose.override.yml` (local runs only). On Coolify the override file is not loaded and no host port is bound. Point the application's domain at the `web` service (port 80); Coolify's reverse proxy routes to the container directly, so it can never collide with ports already allocated on the host.

## License

MIT - Hessa Alhammadi
