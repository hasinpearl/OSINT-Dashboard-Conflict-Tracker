# OSINT Conflict Tracker

Real-time OSINT intelligence dashboard tracking Iran/U.S., Ukraine/Russia, and China/Taiwan conflicts.

## Stack

React 18, TypeScript, Vite, Tailwind CSS, Supabase Edge Functions, Perplexity AI, Firecrawl.

## Setup

```bash
cp .env.example .env    # fill in your Supabase credentials
npm install
npm run dev             # http://localhost:8080
```

## Deploy (Docker)

```bash
docker build \
  --build-arg VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co \
  --build-arg VITE_SUPABASE_PUBLISHABLE_KEY=your-anon-key \
  -t osint-dashboard .
docker run -p 80:80 osint-dashboard
```

## Supabase Secrets

Set in your Supabase project (Settings > Edge Functions > Secrets):

- `PERPLEXITY_API_KEY`
- `FIRECRAWL_API_KEY`
- `AI_GATEWAY_URL`
- `AI_GATEWAY_KEY`

## License

MIT - Hessa Alhammadi
