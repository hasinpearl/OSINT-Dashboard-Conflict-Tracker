# HH Dashboards — OSINT Conflict Tracker

Real-time OSINT intelligence dashboard tracking conflict developments across three major global conflicts, built by Hessa Alhammadi.

## Features

- **Multi-Conflict Tracking** — filter between Iran/U.S., Ukraine/Russia, China/Taiwan, or view all
- **Live News Feed** — aggregated from reputable international outlets per conflict region
- **AI Analyst Panel** — Perplexity-powered intelligence briefings
- **Telegram Monitor** — tracks 11 geopolitical Telegram channels
- **Hot Topics Timeline** — scrape-verified major developments with source attribution
- **OSINT Panel** — verified intelligence with mandatory source links
- **Bias Tracker** — content narrative analysis with per-conflict spectrum (updated every 12h)
- **Live Coverage** — embedded YouTube live streams (EN/AR)
- **Bilingual (EN/AR)** — chunked Arabic translation with retry logic
- **Hourly Audit** — automated cleanup of stale, duplicate, and superseded content
- **Admin Cost Tracker** — role-protected API spend monitoring
- **Auth & RBAC** — Supabase auth with admin/user roles and Row Level Security
- **Smart Caching** — TTL-based with force-refresh support and automatic cache cleanup
- **Local Timezone** — all timestamps rendered in user's device timezone

## Tech Stack

- **Frontend:** React 18, TypeScript, Vite, Tailwind CSS, shadcn/ui
- **Backend:** Supabase (Edge Functions, PostgreSQL, Auth, RLS)
- **APIs:** Perplexity AI, Firecrawl, OpenAI-compatible gateway (for translation)

## Getting Started

1. Clone the repo and install dependencies:
   ```bash
   git clone https://github.com/hasinpearl/OSINT-Dashboard-Conflict-Tracker.git
   cd OSINT-Dashboard-Conflict-Tracker
   npm install
   ```

2. Copy `.env.example` to `.env` and fill in your Supabase credentials:
   ```bash
   cp .env.example .env
   ```

3. Start the dev server:
   ```bash
   npm run dev
   ```

4. Open `http://localhost:8080` in your browser.

## Supabase Setup

Set these secrets in your Supabase project (Settings → Edge Functions → Secrets):

- `PERPLEXITY_API_KEY`
- `FIRECRAWL_API_KEY`
- `AI_GATEWAY_URL` (e.g. `https://openrouter.ai/api/v1/chat/completions`)
- `AI_GATEWAY_KEY`

## License

MIT
