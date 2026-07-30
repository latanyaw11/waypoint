-- ============================================================
-- WAYPOINT — Database Schema (PostgreSQL / Supabase)
-- Run this in the Supabase SQL Editor (New query → paste → Run)
-- ============================================================

-- pgcrypto gives us gen_random_uuid() — uuid-ossp is NOT needed
-- and can cause permission errors on Supabase free tier
create extension if not exists "pgcrypto";

-- ============================================================
-- TABLES
-- ============================================================

-- ---------- Users ----------
-- Waypoint manages its own user accounts with bcrypt + JWT.
-- This is separate from Supabase Auth (auth.users).
create table if not exists waypoint_users (
  id              uuid primary key default gen_random_uuid(),
  email           text unique not null,
  password_hash   text not null,
  display_name    text not null,
  avatar_color    text default '#E2654A',
  home_currency   text default 'USD',
  is_admin        boolean default false,
  is_suspended    boolean default false,
  created_at      timestamptz default now(),
  last_login_at   timestamptz
);

-- ---------- Trips ----------
create table if not exists trips (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid references waypoint_users(id) on delete cascade,
  name             text not null,
  destination_city text not null,
  destination_lat  double precision,
  destination_lng  double precision,
  start_date       date,
  end_date         date,
  pace             text check (pace in ('relaxed','moderate','packed')) default 'moderate',
  transport_mode   text check (transport_mode in ('walking','driving','transit')) default 'driving',
  budget_cap_cents integer default 0,
  emergency_number text,
  embassy_info     text,
  share_code       text unique,
  is_shared        boolean default false,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);
create index if not exists idx_trips_owner on trips(owner_id);
create index if not exists idx_trips_share_code on trips(share_code);

-- ---------- Trip members (collaborators) ----------
create table if not exists trip_members (
  id        uuid primary key default gen_random_uuid(),
  trip_id   uuid references trips(id) on delete cascade,
  user_id   uuid references waypoint_users(id) on delete cascade,
  role      text check (role in ('owner','editor','viewer')) default 'editor',
  color     text,
  joined_at timestamptz default now(),
  unique(trip_id, user_id)
);

-- ---------- Hotels / home bases ----------
create table if not exists bases (
  id         uuid primary key default gen_random_uuid(),
  trip_id    uuid references trips(id) on delete cascade,
  name       text not null,
  address    text,
  lat        double precision not null,
  lng        double precision not null,
  check_in   date,
  check_out  date,
  is_primary boolean default true
);

-- ---------- Celebrity / editorial guide library ----------
create table if not exists celebrity_picks (
  id                  uuid primary key default gen_random_uuid(),
  celebrity_name      text not null,
  city                text not null,
  country             text,
  place_name          text not null,
  category            text,
  lat                 double precision,
  lng                 double precision,
  note                text,
  source_url          text,
  is_published        boolean default true,
  sort_weight         integer default 0,
  created_by_admin_id uuid references waypoint_users(id),
  created_at          timestamptz default now()
);
create index if not exists idx_celeb_city on celebrity_picks(city);
create index if not exists idx_celeb_name on celebrity_picks(celebrity_name);

-- ---------- Places ----------
create table if not exists places (
  id                   uuid primary key default gen_random_uuid(),
  trip_id              uuid references trips(id) on delete cascade,
  added_by             uuid references waypoint_users(id),
  name                 text not null,
  category             text check (category in (
                         'museum','restaurant','bar','festival',
                         'landmark','shopping','nightlife','other'
                       )) default 'other',
  lat                  double precision not null,
  lng                  double precision not null,
  address              text,
  notes                text,
  reservation_url      text,
  visit_duration_min   integer default 60,
  estimated_cost_cents integer default 0,
  priority             integer default 3,
  status               text check (status in ('planned','visited','skipped')) default 'planned',
  celebrity_pick_id    uuid references celebrity_picks(id),
  day_assignment       integer,
  route_position       integer,
  source_place_id      text,
  created_at           timestamptz default now()
);
create index if not exists idx_places_trip on places(trip_id);

-- ---------- Ride requests (Uber / Lyft handoff log) ----------
create table if not exists ride_requests (
  id                   uuid primary key default gen_random_uuid(),
  trip_id              uuid references trips(id) on delete cascade,
  requested_by         uuid references waypoint_users(id),
  from_place_id        uuid references places(id),
  to_place_id          uuid references places(id),
  provider             text check (provider in ('uber','lyft','local_taxi')) default 'uber',
  deep_link            text,
  estimated_distance_m integer,
  estimated_duration_s integer,
  status               text check (status in ('initiated','completed','cancelled')) default 'initiated',
  requested_at         timestamptz default now()
);

-- ---------- Route cache ----------
create table if not exists route_cache (
  id               uuid primary key default gen_random_uuid(),
  trip_id          uuid references trips(id) on delete cascade,
  profile          text,
  origin_place_id  uuid,
  dest_place_id    uuid,
  distance_m       integer,
  duration_s       integer,
  geometry_geojson jsonb,
  computed_at      timestamptz default now()
);
create index if not exists idx_route_cache_trip on route_cache(trip_id);

-- ---------- Place notes / ratings ----------
create table if not exists place_notes (
  id         uuid primary key default gen_random_uuid(),
  place_id   uuid references places(id) on delete cascade,
  user_id    uuid references waypoint_users(id),
  rating     smallint check (rating between 1 and 5),
  comment    text,
  created_at timestamptz default now()
);

-- ---------- Affiliate / revenue event tracking ----------
create table if not exists affiliate_events (
  id           uuid primary key default gen_random_uuid(),
  trip_id      uuid references trips(id),
  user_id      uuid references waypoint_users(id),
  partner      text,
  place_id     uuid references places(id),
  event_type   text,
  payout_cents integer default 0,
  occurred_at  timestamptz default now()
);

-- ---------- Admin audit log ----------
create table if not exists admin_audit_log (
  id           uuid primary key default gen_random_uuid(),
  admin_id     uuid references waypoint_users(id),
  action       text not null,
  target_table text,
  target_id    uuid,
  detail       jsonb,
  created_at   timestamptz default now()
);

-- ============================================================
-- ROW LEVEL SECURITY
-- Waypoint uses its own JWT auth (not Supabase Auth), so the
-- backend's service-role key bypasses RLS for all queries.
-- RLS is enabled here as a defence-in-depth measure to prevent
-- direct anon/client-key access — the app never uses the anon key.
-- ============================================================

alter table waypoint_users  enable row level security;
alter table trips            enable row level security;
alter table trip_members     enable row level security;
alter table bases            enable row level security;
alter table places           enable row level security;
alter table ride_requests    enable row level security;
alter table celebrity_picks  enable row level security;
alter table place_notes      enable row level security;
alter table affiliate_events enable row level security;
alter table admin_audit_log  enable row level security;
alter table route_cache      enable row level security;

-- Block all direct anon/client-key access.
-- The backend always uses the service-role key which bypasses RLS.
-- No auth.uid() needed — intentionally no permissive policies.

