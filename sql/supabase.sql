-- Apply in Supabase SQL Editor. The server uses the service-role key through PostgREST.
create table if not exists public.personal_store (
  owner_id text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);

-- Personal data is never public. The API server is the only writer/reader.
alter table public.personal_store enable row level security;
revoke all on table public.personal_store from anon, authenticated;
create index if not exists personal_store_updated_at_idx on public.personal_store (updated_at);
