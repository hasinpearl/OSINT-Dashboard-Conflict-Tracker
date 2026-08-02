# OSINT Conflict Tracker

Real-time OSINT intelligence dashboard tracking Iran/U.S., Ukraine/Russia, and China/Taiwan conflicts.

## Stack

React 18, TypeScript, Vite, Tailwind CSS, Node (Hono) API, PostgreSQL, Perplexity AI, Firecrawl.

## Architecture

The frontend only ever talks to `/api/*` on its own origin. All provider keys live server-side.

```
browser ──► web  (nginx: serves the SPA build, proxies /api)
            └──► api (Node + Hono: data routes, caching, cost log)
                  └──► db (PostgreSQL, persistent volume)
```

- **Firecrawl**: Scrapes news sources and Telegram channels to markdown
- **Perplexity AI**: Analyzes scraped content and generates intelligence summaries
- **API server** (`server/`): Caches responses in Postgres (60 min TTL; `force_refresh` shrinks the acceptable age to 5 min instead of bypassing, so refresh-spam can't multiply paid calls), logs per-call costs, and filters analyst commentary to a curated per-conflict expert roster
- **Frontend**: React dashboard with breaking-news ticker, notifications, and multi-language support (Western digits enforced everywhere)

## Setup

### Prerequisites

Create accounts and get API keys from:
- [Firecrawl](https://firecrawl.dev) - Web scraping API
- [Perplexity API](https://www.perplexity.ai/api/) - AI analysis API
- (Optional) An OpenRouter-compatible AI gateway key for Arabic translation

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

- `FIRECRAWL_API_KEY` — used by `firecrawl-news`, `telegram-feed`, `ai-summarize`
- `PERPLEXITY_API_KEY` — used by all analysis routes
- `AI_GATEWAY_URL` / `AI_GATEWAY_KEY` — Arabic translation gateway (optional)
- `ADMIN_TOKEN` — bearer token for `/api/audit-refresh`, `/api/admin/diagnostics`, `/api/admin/costs`
- `DATABASE_URL` — Postgres connection for local dev (docker-compose wires its own)

### Health & Diagnostics

- `GET /api/health` — key presence booleans + DB status (public)
- `GET /api/admin/diagnostics` — live-tests each provider with a minimal real call; returns exact upstream status codes (requires `Authorization: Bearer $ADMIN_TOKEN`)
- `GET /api/admin/costs` — aggregated API cost log (requires admin token)

## Deploy (Docker Compose)

```bash
cp .env.example .env    # set API keys, ADMIN_TOKEN and a real POSTGRES_PASSWORD
docker compose up -d --build
# dashboard on http://localhost:${WEB_PORT:-8081}
```

Three services: `db` (postgres:16 + volume), `api` (build of `server/`), `web` (frontend build behind nginx, which proxies `/api` to the api container).

Port publishing lives in `docker-compose.override.yml` (local runs only). On
**Coolify** the override file is not loaded and no host port is bound — point
the application's domain at the `web` service (port 80) and Coolify's reverse
proxy routes to the container directly, so it can never collide with ports
already allocated on the host.

## License

MIT - Hessa Alhammadi
