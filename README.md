# OSINT Conflict Tracker

Real-time OSINT intelligence dashboard tracking Iran/U.S., Ukraine/Russia, and China/Taiwan conflicts.

## Stack

React 18, TypeScript, Vite, Tailwind CSS, Node (Hono) API, PostgreSQL, OpenRouter (Perplexity Sonar models), Firecrawl.

## Architecture

The frontend only ever talks to `/api/*` on its own origin. All provider keys live server-side.

```
browser ──► web  (nginx: serves the SPA build, proxies /api)
            └──► api (Node + Hono: data routes, caching, cost log)
                  └──► db (PostgreSQL, persistent volume)
```

- **Firecrawl**: Scrapes news sources and Telegram channels to markdown
- **OpenRouter (Perplexity Sonar / Sonar Pro)**: Analyzes scraped content and generates intelligence summaries. Single gateway for every AI panel, including Arabic translation.
- **API server** (`server/`): Persists timeline events in Postgres (`stories`/`items`, merge on refresh, a refresh never wipes prior history). Caches short-lived responses (60 min TTL; `force_refresh` shrinks the acceptable age to 5 min instead of bypassing, so refresh-spam can't multiply paid calls). Logs per-call costs. Filters analyst commentary to a curated per-conflict expert roster.
- **Frontend**: React dashboard with breaking-news ticker, notifications, and multi-language support (Western digits enforced everywhere)

## Setup

### Prerequisites

Create accounts and get API keys from:
- [Firecrawl](https://firecrawl.dev) - Web scraping API
- [OpenRouter](https://openrouter.ai) - AI gateway for every AI panel (analysis + Arabic translation). Defaults to Perplexity's `sonar` / `sonar-pro` models, same models this dashboard always used, now billed through one key instead of a separate Perplexity account.

### Local Development

```bash
cp .env.example .env    # fill in your API keys
npm install
npm --prefix server install

npm run dev:api         # API on http://localhost:8787 (Postgres optional; caching pauses without it)
npm run dev             # http://localhost:8080 (proxies /api to :8787)
```

### Environment Variables

All configuration lives in the root `.env` (see `.env.example` for the full list):

- `FIRECRAWL_API_KEY` - used by `firecrawl-news`, `telegram-feed`, `ai-summarize`
- `AI_GATEWAY_URL` / `AI_GATEWAY_KEY` - OpenRouter gateway, powers every AI panel (analysis routes + Arabic translation). Key required, URL optional.
- `OPENROUTER_LIGHT_MODEL` / `OPENROUTER_MID_MODEL` - override the default `perplexity/sonar` / `perplexity/sonar-pro` model pair (optional)
- `TIMELINE_MAX_EVENTS` - cap on events returned per conflict timeline, default 40 (optional)
- `ADMIN_TOKEN` - bearer token for `/api/audit-refresh`, `/api/admin/diagnostics`, `/api/admin/costs`
- `DATABASE_URL` - Postgres connection for local dev (docker-compose wires its own)

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

Three services: `db` (postgres:16 + volume), `api` (build of `server/`), `web` (frontend build behind nginx, which proxies `/api` to the api container).

Port publishing lives in `docker-compose.override.yml` (local runs only). On Coolify the override file is not loaded and no host port is bound. Point the application's domain at the `web` service (port 80); Coolify's reverse proxy routes to the container directly, so it can never collide with ports already allocated on the host.

## License

MIT - Hessa Alhammadi
