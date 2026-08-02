# Porting Guide — apply these 5 changes to another dashboard

> **How to use this file:** drop it into the target repo and tell Claude Code:
> "Read PORTING-GUIDE.md and apply these changes to this codebase." Each section
> explains exactly what was done, why, the key code, and the gotchas we hit so
> they don't have to be rediscovered. Reference implementation lives in the
> `client-demo` repo (this repo).

Scope: (1) discarding Supabase, (2) the data-freshness/accuracy audit,
(3) the curated experts panel, (4) forcing Western numerals, (5) the
notifications system + breaking-news bar. Nothing else (no login page, fonts,
or stat boxes are covered here).

---

## 1. Discarding Supabase (self-hosted API + Postgres)

**Goal:** the frontend only ever talks to `/api/*` on its own origin. No
Supabase project, no vendor SDK, all provider keys server-side.

### Architecture

```
browser ──► web  (nginx: serves the SPA build, proxies /api)
            └──► api (Node + Hono: routes ported from edge functions, caching, cost log)
                  └──► db (PostgreSQL, persistent volume)
```

### Backend (`server/` directory)

- **Stack:** Hono + `@hono/node-server`, `pg`, run with `tsx` (no build step).
  Hono was chosen because Supabase edge functions are fetch-style handlers —
  each `Deno.serve(async (req) => ...)` ports almost mechanically to
  `async (c: Context) => c.json(...)`.
- **Porting pattern per function:** `Deno.env.get("X")` → central `env.ts`
  reading `process.env`; the `esm.sh` Supabase client → a `pg` Pool; CORS
  helpers dropped (same-origin behind nginx); request parsing via
  `await c.req.json().catch(() => ({}))`.
- **`cache.ts`** replaces the `api_cache` table access: `getCached(name, maxAgeMs)`
  (default TTL 60 min, payload carries its own `cached_at`), `setCache` via
  `INSERT ... ON CONFLICT (function_name) DO UPDATE`, plus `deleteCacheKeys`,
  `getCacheRows`, `getStaleCached` (fallback when upstream fails).
- **`costs.ts`** replaces `api_cost_log`: fire-and-forget insert
  (`pool.query(...).catch(console.error)` — never await, never fail a request).
- **Schema:** created on startup with `CREATE TABLE IF NOT EXISTS api_cache /
  api_cost_log` — no migration tooling needed. The admin "summary" view became
  a plain aggregate query in the route (`COUNT(*) FILTER (WHERE cache_hit = ...)`,
  cast `::int` / `::float8` because `pg` returns numerics as strings).
- **Resilience (all learned the hard way):**
  - Auto-load `.env`: a tiny no-dependency parser that reads `./.env` and
    `../.env`, real env always wins. Without this, local `npm run dev` sees no
    config and the dev proxy returns opaque 500s.
  - **Don't await the DB before listening.** `initDb()` retries in the
    background; cache reads are wrapped in try/catch returning `null`. Auth and
    upstream AI calls work without Postgres — only caching/cost logging pause.
    Also `pool.on("error", ...)` so idle-client errors don't crash the process.
  - Trim keys: `(v ?? "").trim().replace(/^["']|["']$/g, "")` on every API key —
    env UIs (Coolify etc.) love to smuggle whitespace/quotes in.
  - `GET /api/health` returns `{ ok, keys: { perplexity: bool, ... } }`
    (presence booleans only) and `GET /api/admin/diagnostics` (auth-protected)
    live-tests each provider with a minimal real call and returns exact status
    codes + truncated error bodies. These two endpoints turned "all panels are
    down, why?" from guesswork into a one-click answer (in our case: two
    invalid keys, visible as upstream 401s).
- **Auth note (adapt, not copy):** every data route goes through a
  `requireAuth` middleware and admin routes additionally through `requireAdmin`
  (JWT in an httpOnly cookie). Wire whatever auth the target dashboard uses —
  the point is that routes are middleware-protected server-side.

### Frontend

- Delete `src/integrations/supabase/` and the `@supabase/supabase-js` dep.
- One tiny client, `src/lib/api.ts`:

```ts
export function invokeFn<T = unknown>(name: string, body?: unknown): Promise<T> {
  return request<T>(name, { method: "POST", body: JSON.stringify(body ?? {}) });
}
// request() = fetch(`${API_BASE}/api/${path}`, { credentials: "include", ... })
// throws ApiError(status, message) on non-2xx
```

- Mechanical swap at every call site:
  `const { data, error } = await supabase.functions.invoke("x", { body })` →
  `const data = await invokeFn<T>("x", body)` (errors now throw — React Query
  handles them naturally).
- Table reads from the frontend (admin pages) become dedicated API endpoints.

### Plumbing

- **nginx:** `location /api/ { proxy_pass http://api:8787; ... }` and pass
  `X-Forwarded-Proto` through from the outer proxy:
  `map $http_x_forwarded_proto $client_proto { default $http_x_forwarded_proto; "" $scheme; }`
  (without the map, nginx overwrites the original `https` and the API can't
  detect TLS for secure cookies).
- **Vite dev:** `server.proxy = { "/api": { target: "http://localhost:8787" } }`.
- **docker-compose:** three services — `db` (postgres:16-alpine + volume +
  `pg_isready` healthcheck), `api` (build `./server`, `depends_on: db:
  service_healthy`), `web` (frontend build, publishes `${WEB_PORT:-8081}:80` —
  NOT 80, which collides with the host's reverse proxy). Give every env var a
  `${VAR:-default}` so the operator only sets API keys + secrets.

---

## 2. The data-freshness ("accuracy") audit

**Target behavior:** every panel is fresh **on hard refresh** and at most
~1 hour old otherwise — with a cost guard so refresh-spam can't multiply paid
upstream calls.

**Bugs found in the original design (check for the same ones):**

1. Several routes silently **ignored `force_refresh`** (only some honored it).
2. The dashboard fired a fire-and-forget `force_refresh` loop on mount whose
   fresh results were **thrown away**, while the panels' own queries raced
   ahead and displayed stale cache — double cost, zero benefit.
3. Hourly client refetch × 60-min server TTL compounded to ~2h worst-case
   staleness on screen.

**The model that replaced it:**

- **Server:** one shared constant `FORCE_MIN_AGE_MS = 5 * 60 * 1000`. Every
  route parses `force_refresh` (body or query) and reads cache as
  `getCached(KEY, forceRefresh ? FORCE_MIN_AGE_MS : undefined)` — i.e. force
  shrinks the acceptable cache age to 5 minutes instead of bypassing entirely.
  Hard refreshes are effectively fresh; F5-spam is free.
- **Client:** a per-page-load force tracker:

```ts
// src/lib/freshness.ts
const forced = new Set<string>();
export function shouldForceRefresh(key: string): boolean {
  if (forced.has(key)) return false;
  forced.add(key);
  return true;
}
```

  Each panel's `queryFn` sends
  `...(shouldForceRefresh(`${panel}:${conflict}`) ? { force_refresh: true } : {})`.
  A hard refresh resets the module → every panel forces once per
  panel×conflict per session. Delete any old on-mount force loops.
- **Intervals:** client `refetchInterval` 15 min (refetches inside the server
  TTL are cheap cache hits) against the 60-min server cache → fresh server
  data reaches the screen within ~15 min of existing instead of up to an hour.
  Slow-moving panels (bias analysis) keep their longer cycle (12 h).

---

## 3. Curated experts panel (no more random commentators)

**Problem:** the analyst panel asked the AI for "recent expert commentary" —
whoever it found is who appeared.

**Fix — two enforcement layers:**

1. **Data:** each conflict config gains a fixed roster:

```ts
interface Expert { name: string; title: string; kind: "official" | "analyst" }
// e.g. { name: "Rafael Grossi", title: "Director General, IAEA", kind: "official" }
```

   ~5 officials + ~5 analysts per conflict; the "all conflicts" view uses the
   union (`all.flatMap(c => c.experts)`).

2. **Prompt:** list the roster (grouped OFFICIALS / EXPERT ANALYSTS, each as
   `- Name (Title)`) with strict rules: ONLY people on the list; only include
   someone if a real recent statement exists (prefer 2 weeks, up to 1 month —
   set `search_recency_filter: "month"`); never invent quotes; use the
   affiliation exactly as given; return the name exactly as listed.

3. **Server-side filter — never trust the model to obey:**

```ts
function normName(s: string) {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z\s]/g, " ")
          .replace(/\s+/g, " ").trim();
}
// keep a comment only if normalized names contain each other either way:
const match = allowed.find(a => n.includes(a.norm) || a.norm.includes(n));
// on match, overwrite: analyst = canonical name, affiliation = canonical title
```

   Two-way `includes` handles "Secretary of State Marco Rubio" vs "Marco
   Rubio" vs plain "Rubio".

**Gotcha — cache poisoning:** old cached "random people" responses live under
the old cache key. Change the cache key base (we used `analyst-curated` instead
of `perplexity-analyst`) **and** update the audit/cleanup job's known-key list
to include the new base and drop the old one, so stale entries get cleaned as
orphans instead of the new ones being deleted.

---

## 4. Western numerals everywhere (no ٠١٢٣ anywhere)

Arabic-Indic digits leak in from **three independent sources** — fix all three:

1. **Browser locale formatting.** Any `Intl.DateTimeFormat()` /
   `toLocaleString()` without an explicit locale renders ٠-٩ for users with an
   Arabic browser locale. Fix: post-process every date formatter through a
   digit map, and pin incidental calls to `"en-GB"`.

```ts
const EASTERN_DIGITS: Record<string, string> = {
  "٠":"0","١":"1","٢":"2","٣":"3","٤":"4","٥":"5","٦":"6","٧":"7","٨":"8","٩":"9",
  "۰":"0","۱":"1","۲":"2","۳":"3","۴":"4","۵":"5","۶":"6","۷":"7","۸":"8","۹":"9",
};
export function toLatinDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹]/g, (d) => EASTERN_DIGITS[d] ?? d);
}
// return toLatinDigits(new Intl.DateTimeFormat(...).format(d)) in every formatter
```

   (Covers both Arabic-Indic ٠-٩ and Extended/Persian ۰-۹.)

2. **Hand-written i18n strings.** Grep translation dictionaries for
   `[٠-٩۰-۹]` and rewrite with 0-9 (we had "كل ١٢ ساعة", "٦ أحرف").

3. **AI translation output.** Belt and suspenders: add a prompt rule
   ("Always write numbers with Western digits (0-9), NEVER Arabic-Indic
   digits") **and** run `toLatinDigits()` over every translated string in the
   translation endpoint before returning — the prompt alone is not reliable.

---

## 5. Urgent notifications + breaking-news bar

**Design principle:** both features are pure consumers of the panels' existing
React Query data — **zero additional API calls or cost**. Create shared hooks
whose `queryKey` + options exactly match the panels' own queries (or refactor
panels onto the shared hooks); React Query then serves all consumers from one
cache entry.

```ts
// src/hooks/usePanelData.ts — same queryKey as the news panel = shared cache
export function useNewsStories() {
  const { conflict } = useConflictFilter();
  return useQuery({ queryKey: ["news-feed", conflict], queryFn: ..., staleTime: ..., refetchInterval: ... });
}
```

Conflict scoping is automatic: everything keys off the same conflict-filter
context as the panels ("all" when nothing selected, the specific conflict
otherwise).

### Breaking-news scrolling bar

- Filter stories to severity `critical`/`high` (match both English and Arabic
  severity values if data may be translated); fall back to all stories so the
  bar is never empty; render `null` while there's no data.
- Marquee: duplicate the content **twice** inside a `w-max inline-flex` track
  and animate `translateX(0 → -50%)`, `linear infinite`; duration scaled by
  item count. Pad short lists (`while (padded.length < 6) padded.push(...items)`)
  so the track is always wider than the viewport.
- **Gotcha (hover-pause):** the animation MUST live in a stylesheet, with only
  the duration as a CSS variable — an inline `style={{ animation: ... }}`
  wins over any `:hover { animation-play-state: paused }` rule and the pause
  silently never works:

```css
.ticker-track { animation: ticker-scroll var(--ticker-duration, 40s) linear infinite; }
.ticker-wrap:hover .ticker-track { animation-play-state: paused; }
```

- Keep the track `dir="ltr"` for a stable scroll direction; put `dir="auto"`
  on each headline span so Arabic text still renders correctly.
- Each story is an `<a target="_blank" rel="noopener noreferrer">` when it has
  a valid `http(s)` URL. **Gotcha:** our news-extraction prompt literally said
  `"url":""` — update it to extract the article URL from the scraped content
  (with "never invent URLs"), otherwise every link is dead.

### Notifications (bell + panel + toasts)

- **Store:** a `NotificationsContext` persisted to `localStorage` (cap ~50):
  `{ id, headline, source?, url?, addedAt, read }`. `addNotifications(items)`
  dedupes by trimmed headline against everything already stored and **returns
  only the newly added ones**; also `markAllRead()`, `clearAll()`,
  `unreadCount`. Persistence is what makes "track what's new" survive
  refreshes.
- **Feeder:** a headless component watches the shared news query, pushes every
  `critical` story into the store, and fires toasts **only for the items the
  store reports as new** (capped at ~3 per update so a bad news day can't spam)
  — store and toasts can never disagree because the store's return value drives
  the toasts.
- **Bell UI:** button with unread-count badge; dropdown lists items newest
  first with unread dots, source, arrival time, clickable headlines; opening
  marks all read.
- **Gotcha (clipping):** if the header has `overflow-hidden` and/or any
  `backdrop-filter`/`transform`, a dropdown positioned inside it gets clipped —
  `backdrop-filter` creates a containing block, so even `position: fixed`
  children are trapped. Render the dropdown through
  `createPortal(..., document.body)` with `position: fixed`, computing
  placement from the bell's `getBoundingClientRect()` (clamp the horizontal
  position to the viewport — in RTL the bell sits near the screen edge). Set
  `dir` explicitly on the portal content; it no longer inherits from the app
  container.
