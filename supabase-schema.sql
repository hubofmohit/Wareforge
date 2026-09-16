-- ============================================================
-- Warehouse Designer — Supabase schema (link-based access, no login)
-- Run this once in Supabase Dashboard → SQL Editor → New query.
--
-- ACCESS MODEL: there are no user accounts. Every visitor gets a
-- random token embedded in their URL (?key=...). That token is sent
-- as a custom "x-workspace-id" header on every request, and Postgres
-- Row Level Security only allows a row through when its workspace_id
-- matches that header. Whoever holds a URL with a given token can
-- fully read/write that workspace's data — same trust model as a
-- "anyone with this link" Google Doc. It is NOT identity-based auth:
-- access can't be revoked per-person, only by generating a new link
-- and stopping use of the old one. Don't use this for sensitive data
-- you need to audit per-individual.
-- ============================================================

create extension if not exists pgcrypto;

-- ---------- tables ----------

create table if not exists locations (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  name text not null,
  length int not null default 1000,
  breadth int not null default 600,
  created_at timestamptz default now()
);

create table if not exists zones (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  location_id uuid references locations(id) on delete cascade not null,
  name text not null,
  x int not null default 0,
  y int not null default 0,
  width int not null default 100,
  height int not null default 100,
  created_at timestamptz default now()
);

create table if not exists items (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  zone_id uuid references zones(id) on delete cascade not null,
  name text not null,
  qty int not null default 0,
  min_qty int not null default 2,
  created_at timestamptz default now()
);

create table if not exists history (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  location_id uuid references locations(id) on delete set null,
  text text not null,
  category text not null default 'other',
  ts timestamptz default now()
);

-- helpful indexes
create index if not exists locations_workspace_idx on locations(workspace_id);
create index if not exists zones_workspace_idx on zones(workspace_id);
create index if not exists zones_location_id_idx on zones(location_id);
create index if not exists items_workspace_idx on items(workspace_id);
create index if not exists items_zone_id_idx on items(zone_id);
create index if not exists history_workspace_ts_idx on history(workspace_id, ts desc);

-- ---------- row level security ----------
-- Reads the "x-workspace-id" HTTP header PostgREST forwards on every
-- request (Supabase sets this GUC automatically, even for anon-key
-- requests — no login required) and only allows rows whose
-- workspace_id matches it.

alter table locations enable row level security;
alter table zones     enable row level security;
alter table items     enable row level security;
alter table history   enable row level security;

create policy "workspace scoped" on locations
  for all
  using (workspace_id = (current_setting('request.headers', true)::json ->> 'x-workspace-id'))
  with check (workspace_id = (current_setting('request.headers', true)::json ->> 'x-workspace-id'));

create policy "workspace scoped" on zones
  for all
  using (workspace_id = (current_setting('request.headers', true)::json ->> 'x-workspace-id'))
  with check (workspace_id = (current_setting('request.headers', true)::json ->> 'x-workspace-id'));

create policy "workspace scoped" on items
  for all
  using (workspace_id = (current_setting('request.headers', true)::json ->> 'x-workspace-id'))
  with check (workspace_id = (current_setting('request.headers', true)::json ->> 'x-workspace-id'));

create policy "workspace scoped" on history
  for all
  using (workspace_id = (current_setting('request.headers', true)::json ->> 'x-workspace-id'))
  with check (workspace_id = (current_setting('request.headers', true)::json ->> 'x-workspace-id'));

-- ---------- realtime ----------
-- Lets connected clients receive live INSERT/UPDATE/DELETE events so
-- one teammate's changes show up on another teammate's screen. The
-- client subscribes with a workspace_id=eq.<token> filter (see
-- script.js) so it only ever receives events for its own workspace.

alter publication supabase_realtime add table locations, zones, items;

create table if not exists members (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants(id) on delete cascade not null,
  access_token text unique not null,
  name text,
  role text not null default 'editor' check (role in ('admin', 'editor', 'viewer')),
  created_at timestamptz default now()
);

alter table members enable row level security;
-- Same pattern as tenants: no anon policies. Only service-role (admin
-- functions) and the security-definer function below can read this.

insert into members (tenant_id, access_token, name, role)
select id, access_token, email, 'admin' from tenants
on conflict (access_token) do nothing;


create or replace function current_tenant_id() returns uuid
language sql stable security definer
set search_path = public
as $$
  select tenant_id from members
  where access_token = (current_setting('request.headers', true)::json ->> 'x-access-token')
  limit 1;
$$;

create or replace function current_member_id() returns uuid
language sql stable security definer
set search_path = public
as $$
  select id from members
  where access_token = (current_setting('request.headers', true)::json ->> 'x-access-token')
  limit 1;
$$;

create or replace function current_member_role() returns text
language sql stable security definer
set search_path = public
as $$
  select role from members
  where access_token = (current_setting('request.headers', true)::json ->> 'x-access-token')
  limit 1;
$$;



drop policy "tenant scoped" on warehouses;

create policy "tenant read" on warehouses
  for select using (tenant_id = current_tenant_id());

create policy "tenant write" on warehouses
  for insert with check (
    tenant_id = current_tenant_id() and current_member_role() in ('admin', 'editor')
  );

create policy "tenant update" on warehouses
  for update using (
    tenant_id = current_tenant_id() and current_member_role() in ('admin', 'editor')
  ) with check (
    tenant_id = current_tenant_id() and current_member_role() in ('admin', 'editor')
  );

create policy "tenant delete" on warehouses
  for delete using (
    tenant_id = current_tenant_id() and current_member_role() in ('admin', 'editor')
  );




-- Extend role-gated policies to the tables that actually matter —
-- zones and items are where nearly all real writes happen, and they
-- were still running under the old blanket "tenant scoped" policy
-- with no role check at all.

do $$
declare
  t text;
begin
  foreach t in array array['zones', 'items', 'history'] loop
    execute format('drop policy if exists "tenant scoped" on %I', t);

    execute format($f$
      create policy "tenant read" on %I
        for select using (tenant_id = current_tenant_id())
    $f$, t);

    execute format($f$
      create policy "tenant write" on %I
        for insert with check (
          tenant_id = current_tenant_id() and current_member_role() in ('admin','editor')
        )
    $f$, t);

    execute format($f$
      create policy "tenant update" on %I
        for update using (
          tenant_id = current_tenant_id() and current_member_role() in ('admin','editor')
        ) with check (
          tenant_id = current_tenant_id() and current_member_role() in ('admin','editor')
        )
    $f$, t);

    execute format($f$
      create policy "tenant delete" on %I
        for delete using (
          tenant_id = current_tenant_id() and current_member_role() in ('admin','editor')
        )
    $f$, t);
  end loop;
end $$;

-- ============================================================
-- Adds activate/deactivate for both tenants and members.
--
-- Enforcement lives in ONE place: the three security-definer
-- resolver functions (current_tenant_id, current_member_id,
-- current_member_role) now return NULL whenever either the member
-- row or its parent tenant row is inactive. Every RLS policy on
-- warehouses/zones/items/history filters by
-- "tenant_id = current_tenant_id()" — so if that resolves to NULL,
-- no row can ever match, and the deactivated link loses ALL read
-- and write access automatically. No policy changes needed.
--
-- Client-side, script.js's boot() calls current_tenant_id() first,
-- before anything else loads — so a deactivated link gets redirected
-- to no-access.html immediately, the same as an invalid token.
-- ============================================================

alter table tenants add column if not exists is_active boolean not null default true;
alter table members add column if not exists is_active boolean not null default true;

create or replace function current_tenant_id() returns uuid
language sql stable security definer
set search_path = public
as $$
  select m.tenant_id
  from members m
  join tenants t on t.id = m.tenant_id
  where m.access_token = (current_setting('request.headers', true)::json ->> 'x-access-token')
    and m.is_active
    and t.is_active
  limit 1;
$$;

create or replace function current_member_id() returns uuid
language sql stable security definer
set search_path = public
as $$
  select m.id
  from members m
  join tenants t on t.id = m.tenant_id
  where m.access_token = (current_setting('request.headers', true)::json ->> 'x-access-token')
    and m.is_active
    and t.is_active
  limit 1;
$$;

create or replace function current_member_role() returns text
language sql stable security definer
set search_path = public
as $$
  select m.role
  from members m
  join tenants t on t.id = m.tenant_id
  where m.access_token = (current_setting('request.headers', true)::json ->> 'x-access-token')
    and m.is_active
    and t.is_active
  limit 1;
$$;


-- ============================================================
-- Individual accountability: attribute each history entry to the
-- member who actually made it.
--
-- Attribution is set by a BEFORE INSERT TRIGGER, not by whatever the
-- client sends — this is deliberate. If we trusted a client-supplied
-- member_id, anyone could spoof another member's identity in the
-- audit log by editing the request. The trigger always overwrites
-- member_id with current_member_id(), resolved server-side from the
-- caller's own access token, so the log stays trustworthy even if the
-- client is compromised or misbehaving.
--
-- on delete set null (not cascade): if a member is later deleted,
-- their PAST history entries stay — deleting someone's access
-- shouldn't erase the record of what they did while they had it.
-- ============================================================

alter table history add column if not exists member_id uuid references members(id) on delete set null;

create or replace function set_history_member_id() returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  new.member_id := current_member_id();
  return new;
end;
$$;

drop trigger if exists trg_set_history_member_id on history;
create trigger trg_set_history_member_id
  before insert on history
  for each row execute function set_history_member_id();

-- Lets any member of a tenant fetch a safe roster of their own
-- teammates (id/name/role only) to label history entries with —
-- WITHOUT exposing access_token, which is the actual credential and
-- must never be visible to anyone but the admin panel (service role).
-- Includes inactive/deactivated members too, on purpose: their past
-- actions should still show their name, not just disappear.
create or replace function tenant_members_public() returns table(id uuid, name text, role text)
language sql stable security definer
set search_path = public
as $$
  select m.id, m.name, m.role
  from members m
  where m.tenant_id = current_tenant_id();
$$;

revoke all on function set_history_member_id() from public;
revoke all on function tenant_members_public() from public;
grant execute on function tenant_members_public() to anon, authenticated;


-- ============================================================
-- Backup & disaster recovery.
--
-- Design: the `backups` table has a read policy scoped to the
-- caller's own tenant (same current_tenant_id() pattern as every
-- other table) — but deliberately NO insert/update/delete policy for
-- anon/authenticated at all. Snapshots can only ever be created by
-- server-side functions using the service role key
-- (scheduled-backup.js, create-backup.js), which bypass RLS entirely.
-- This means a compromised or malicious client can never forge a fake
-- backup row, inflate one with garbage data, or delete real ones —
-- the backup log itself can't be tampered with from the browser.
-- ============================================================

create table if not exists backups (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants(id) on delete cascade not null,
  created_at timestamptz default now(),
  data jsonb not null,
  triggered_by text not null default 'scheduled' check (triggered_by in ('scheduled', 'manual'))
);

create index if not exists backups_tenant_created_idx on backups(tenant_id, created_at desc);

alter table backups enable row level security;

create policy "tenant read backups" on backups
  for select using (tenant_id = current_tenant_id());

-- No write policies on purpose — see comment above.




-- ============================================================
-- Landing-page analytics (site_visits / site_clicks) — RUN THIS FILE
-- ON ITS OWN. It doesn't depend on anything in supabase-schema.sql
-- above the "Backup & disaster recovery" section, so there's no risk
-- of it touching the old workspace_id/locations draft that caused
-- the "column workspace_id does not exist" error.
--
-- It only reads from members/warehouses/zones/items (via
-- select count(*)) and creates two brand-new tables plus one new
-- function — nothing here alters or depends on any existing table's
-- structure.
--
-- Same trust model as `backups`: these two tables have RLS enabled
-- with NO policies at all for anon/authenticated — they can only be
-- written by the service role (the track-event.js / api/track-event.js
-- function) and can never be read row-by-row by a client.
--
-- Public reads go ONLY through site_public_stats() below, a
-- security-definer function in the same style as
-- tenant_members_public() — it returns pre-aggregated counts, never
-- individual rows.
--
-- Note on abuse: there is no CAPTCHA or rate limiting on the function
-- that writes to these tables — someone determined could inflate the
-- counters by calling it directly. Accepted trade-off for a simple
-- landing-page counter, not meant to be an authoritative metric.
-- ============================================================

create table if not exists site_visits (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  path text not null default '/'
);

create table if not exists site_clicks (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  target text not null
);

create index if not exists site_visits_created_idx on site_visits(created_at desc);
create index if not exists site_clicks_created_idx on site_clicks(created_at desc);

alter table site_visits enable row level security;
alter table site_clicks enable row level security;
-- No policies on purpose — see comment above.

create or replace function site_public_stats() returns table(
  total_visits bigint,
  total_clicks bigint,
  authorized_users bigint,
  active_warehouses bigint,
  configured_zones bigint,
  tracked_items bigint
)
language sql stable security definer
set search_path = public
as $$
  select
    (select count(*) from site_visits),
    (select count(*) from site_clicks),
    (select count(*) from members where is_active = true),
    (select count(*) from warehouses),
    (select count(*) from zones),
    (select count(*) from items);
$$;

revoke all on function site_public_stats() from public;
grant execute on function site_public_stats() to anon, authenticated;

-- ============================================================
-- Returns / reverse logistics — scoped to supplier returns, damaged
-- goods, and misdelivered stock (NOT customer order returns, since
-- this app doesn't do order fulfillment).
--
-- Item/zone/warehouse names are snapshotted at the time of the return
-- (not just referenced by id) so a return record stays meaningful
-- even after the underlying item is renamed or deleted later — same
-- reasoning as why history entries store rendered text, not just ids.
--
-- member_id is set by a trigger, not trusted from the client — same
-- tamper-proof pattern as history.member_id, for the same reason: a
-- return log is only useful for accountability if it can't be spoofed.
-- ============================================================

create table if not exists returns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants(id) on delete cascade not null,
  warehouse_id uuid references warehouses(id) on delete set null,
  zone_id uuid references zones(id) on delete set null,
  item_id uuid references items(id) on delete set null,
  item_name text not null,
  zone_name text,
  warehouse_name text,
  qty int not null default 1 check (qty > 0),
  reason text not null default 'other'
    check (reason in ('damaged', 'wrong_item', 'supplier_defect', 'expired', 'misdelivered', 'other')),
  disposition text not null default 'returned_to_supplier'
    check (disposition in ('returned_to_supplier', 'scrapped', 'restocked', 'other')),
  notes text,
  member_id uuid references members(id) on delete set null,
  created_at timestamptz default now()
);

create index if not exists returns_tenant_created_idx on returns(tenant_id, created_at desc);

alter table returns enable row level security;

create policy "tenant read returns" on returns
  for select using (tenant_id = current_tenant_id());

create policy "tenant write returns" on returns
  for insert with check (
    tenant_id = current_tenant_id() and current_member_role() in ('admin', 'editor')
  );

-- No update/delete policies — a logged return is a permanent record,
-- same reasoning as why `history` has no client update/delete either.

create or replace function set_returns_member_id() returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  new.member_id := current_member_id();
  return new;
end;
$$;

drop trigger if exists trg_set_returns_member_id on returns;
create trigger trg_set_returns_member_id
  before insert on returns
  for each row execute function set_returns_member_id();