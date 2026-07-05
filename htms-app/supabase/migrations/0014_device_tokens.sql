-- ============================================================================
-- Migration 0014: FCM device registration tokens for push notifications.
-- One row per browser/app install. `platform` keeps it generic so a future
-- mobile app can register alongside web. Users manage only their own tokens;
-- the server (service role) reads all when sending.
-- ============================================================================

create table if not exists device_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references app_users(id) on delete cascade,
  token        text not null unique,
  platform     text not null default 'web',   -- 'web' | 'android' | 'ios'
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists idx_device_tokens_user on device_tokens (user_id);

alter table device_tokens enable row level security;

-- A user may see and manage only their own device tokens.
create policy device_tokens_own on device_tokens
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
