# Waypoint API

Backend for Waypoint, a trip-planning app that lets travelers pin places on a
map, builds an optimized route from their hotel, hands off each leg to Uber,
and surfaces editorially curated "celebrity favorite" spots.

## Stack

- **Node.js / Express** — REST API
- **Supabase (Postgres)** — data store, row-level security for shared trips
- **OSRM + Nominatim** — free routing/geocoding by default; swap for Google
  Maps Platform or Mapbox at scale (see `.env.example`)
- **JWT** — auth

## Getting started

```bash
cp .env.example .env        # fill in SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, JWT_SECRET
npm install
psql < src/db/schema.sql    # or run schema.sql in the Supabase SQL editor
npm run dev
```

## API surface

| Area | Routes |
|---|---|
| Auth | `POST /api/auth/signup`, `POST /api/auth/login` |
| Trips | `POST/GET/PATCH/DELETE /api/trips`, `POST /api/trips/:id/base`, `POST /api/trips/:id/share` |
| Places | `POST/GET/PATCH/DELETE /api/trips/:tripId/places`, `POST /api/trips/:tripId/places/:id/notes` |
| Routing | `POST /api/trips/:tripId/routing/calculate`, `GET /api/trips/:tripId/routing/matrix` |
| Rides | `POST/GET /api/trips/:tripId/rides` |
| Celebrity guide | `GET /api/celebrity-picks` (public), admin write endpoints |
| Sharing | `GET /api/share/:code`, `POST /api/share/:code/join` |
| Admin | `/api/admin/*` — see ADMIN_FEATURES.md |

## Routing logic

`src/services/routingService.js` builds a distance/duration matrix (OSRM,
falling back to haversine if OSRM is unreachable), runs a nearest-neighbor
construction from the hotel, refines it with 2-opt, then splits the ordered
stops into days based on the trip's pace (relaxed/moderate/packed). This
mirrors a small-scale Traveling Salesman Problem — fine for the realistic
range of 3–25 stops a traveler would plan in a city.

## Ride handoff

`src/services/rideService.js` builds an Uber Universal Link
(`m.uber.com/ul/...`) with pickup/dropoff coordinates pre-filled — no Uber API
key required, opens the native app if installed. A production upgrade path is
the authenticated Uber Rides API for in-app fare estimates and ride-status
webhooks (requires an Uber developer account and OAuth).

## Production swaps to consider

- Geocoding: Nominatim → Google Geocoding API / Mapbox (higher rate limits, better POI matches)
- Routing: OSRM → Google Distance Matrix / Mapbox Matrix (live traffic, transit directions)
- Realtime collaboration: add Supabase Realtime channels on `places` and `trips` so collaborators see edits live instead of polling
