# OSINT Conflict Tracker

Real-time OSINT intelligence dashboard tracking Iran/U.S., Ukraine/Russia, and China/Taiwan conflicts.

## Stack

React 18, TypeScript, Vite, Tailwind CSS, Supabase Edge Functions, Perplexity AI, Firecrawl.

## Architecture

The dashboard uses **Supabase Edge Functions** (Deno) to orchestrate external APIs:

- **Firecrawl**: Scrapes news sources to extract conflict-related articles
- **Perplexity AI**: Analyzes scraped content and generates intelligence summaries
- **Supabase**: Hosts serverless functions, manages authentication, and tracks API costs
- **Frontend**: React dashboard displays real-time conflict intelligence with multi-language support

## Setup

### Prerequisites

Create accounts and get API keys from:
- [Supabase](https://supabase.com) - Backend & Edge Functions
- [Firecrawl](https://firecrawl.dev) - Web scraping API (converts websites to markdown/LLM-ready format)
- [Perplexity API](https://www.perplexity.ai/api/) - AI analysis API
- (Optional) [AI Gateway](https://ai-gateway.com) - For rate limiting & cost control

### Local Development

```bash
cp .env.example .env    # fill in your Supabase credentials
npm install
npm run dev             # http://localhost:8080
```

### Environment Variables

Edit `.env` with your Supabase project credentials:

```env
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your-anon-key-here
```

### Supabase Edge Function Secrets

Set these in your Supabase project (`Settings > Edge Functions > Secrets`):

- `FIRECRAWL_API_KEY` - Get from [firecrawl.dev](https://firecrawl.dev)
  - Used by: `firecrawl-news`, `telegram-feed`
  - Scrapes URLs and extracts markdown content
  
- `PERPLEXITY_API_KEY` - Get from [perplexity.ai/api](https://www.perplexity.ai/api/)
  - Used by: `firecrawl-news`, `perplexity-analyst`, `perplexity-osint`
  - Analyzes content and generates summaries

- `AI_GATEWAY_URL` (optional) - For cost control & rate limiting
  - Gateway endpoint URL

- `AI_GATEWAY_KEY` (optional) - Authentication for AI Gateway

## Deploy (Docker)

```bash
docker build \
  --build-arg VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co \
  --build-arg VITE_SUPABASE_PUBLISHABLE_KEY=your-anon-key \
  -t osint-dashboard .
docker run -p 80:80 osint-dashboard
```

## License

MIT - Hessa Alhammadi
