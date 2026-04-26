# HH Dashboards — OSINT Conflict Tracker

Real-time OSINT intelligence dashboard tracking conflict developments in the Middle East, built by Hessa Alhammadi.

## Features

- **Live News Feed** — aggregated from reputable international outlets
- **AI Analyst Panel** — Perplexity-powered intelligence briefings
- **Telegram Monitor** — tracks 8 geopolitical Telegram channels
- **Hot Topics Timeline** — scrape-verified major developments with source attribution
- **OSINT Panel** — verified intelligence with mandatory source links
- **Bias Tracker** — content narrative analysis updated every 12 hours
- **Live Coverage** — embedded YouTube live streams (EN/AR)
- **Bilingual (EN/AR)** — chunked Arabic translation with retry logic
- **Admin Cost Tracker** — role-protected API spend monitoring
- **Auth & RBAC** — Supabase auth with admin/user roles and Row Level Security
- **Smart Caching** — TTL-based with force-refresh support
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
