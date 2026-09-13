# SPEC: The Map (the one new widget)

**Constraint from Hessa:** no new widgets except this one. RSS, WAM and Telegram feed the
existing news scraping and the existing panels. This is the only addition to the UI.

Style rules: never commit or push. No em dashes. Comments only where the code needs
explaining. Tag every tunable with `//TUNE: Control the (X)`.

---

## Part 1: Geocoding (backend, free, no key)

Nothing can be pinned yet because `items.primary_location` is empty. Fill it.

Use **OpenStreetMap Nominatim**. Free, no API key, no quota beyond a polite request rate.

- `https://nominatim.openstreetmap.org/search?q=<place>&format=json&limit=1`
- **Send a real User-Agent** identifying the app. Nominatim blocks generic agents.
- **Respect 1 request per second.** OSM's usage policy requires it. Enforce with a sleep
  between calls and make the delay a tunable.
- Store into `items.primary_location` as jsonb:
  ```json
  { "lat": 31.5, "lng": 34.47, "country": "PS", "region": "Gaza", "precision": "approximate", "confidence": 0.7, "normalized": "Gaza City" }
  ```
- Add a `location_precision` and geocode confidence so the map can render honest pins.

**Never guess a pin.** This is the rule that matters. If the item does not name a
resolvable place, leave `primary_location` null. A missing pin is correct; an invented one
is a lie on a map. Geocode only places actually named in the title or content, not inferred
from context.

Run it as a worker alongside the others, pacing itself, resumable, and only over items that
have no location yet.

## Part 2: The map widget (frontend, one component)

Add exactly one component: `src/components/dashboard/MapView.tsx`.

### Placement, as instructed by Hessa

`src/pages/Index.tsx` currently renders the dashboard as a `grid-cols-1 lg:grid-cols-3`
grid. Row 3 is a full-width banner:

```tsx
{/* Row 3 */}
<div className="lg:col-span-3">
  <LiveCoverage />
</div>
```

Change **only that row** so the map sits beside LiveCoverage in the same row, rather than
the map going anywhere on its own or LiveCoverage keeping the whole width:

- LiveCoverage keeps the larger share: `lg:col-span-2`
- MapView takes the remaining column: `lg:col-span-1`, full height of the row
- The map is **clean and vertically centred** against LiveCoverage, so the two read as a
  pair. They should be equal in height, not one floating short beside a tall one.
- On small screens they stack, map below LiveCoverage.

Do not reorder, resize or restyle any other row. Every other panel keeps its current cell.

- `mapbox-gl` with `react-map-gl`. Use the style and token from the private `.env`:
  - `VITE_MAPBOX_STYLE=mapbox://styles/hammadihessa/cmtzq5jim00e301qy9uz19lhy`
  - `VITE_MAPBOX_TOKEN=` (the public pk. token, in the private .env only, never committed)
- If either env var is missing, render a clear placeholder instead of a broken map. It must
  not throw or blank the dashboard.
- Pins come from `GET /api/events/pins`, which returns only rows with real coordinates.
- **Colour pins by `severity`** using the existing design tokens.
- **`precision: approximate` must look different from `exact`.** Do not let an approximate
  circle read as a fixed point.
- No pin where precision is unknown, because those rows never had coordinates.
- Mount it into the existing dashboard layout as the single new panel. Do not add any other
  panel, tab, card or widget.

Design: sharp rectangles, no border radius, no shadows. Light background. Navy `#20264C`
and Teal `#00A7B5` from the brand. Match the existing panels exactly.

## Part 3: Env documentation

Add `VITE_MAPBOX_STYLE` and `VITE_MAPBOX_TOKEN` to `.env.example` with a comment that the
token is public by design but belongs in the private `.env`, and that it should be
URL-restricted in the Mapbox account.

---

## Do NOT

- Do not touch `docker-compose.yml`.
- Do not add any widget, panel or card other than `MapView.tsx`.
- Do not change the response shape of any existing endpoint.
- Do not invent a location for any item.

## Verification (paste real output)

1. `cd server && npx tsc --noEmit` redirected to a file, then read the file. Never check
   `$?` after a pipe.
2. `npm run build` must pass.
3. Run the geocoder over the real ingested rows and paste: how many items got a location,
   how many were correctly left null, and 3 sample `primary_location` values.
4. `curl /api/events/pins` and paste the real JSON.
5. Confirm the request rate honoured Nominatim's 1 per second.
