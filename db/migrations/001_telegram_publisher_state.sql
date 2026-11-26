-- Apply only after reviewing the migration against the target Supabase project.
-- These tables are internal bot state; no anon/authenticated access is granted.

create table if not exists public.telegram_publications (
  id uuid primary key default gen_random_uuid(),
  source_table text not null check (
    source_table in ('news_announcements', 'blog_posts', 'services_announcements')
  ),
  source_id uuid not null,
  chat_id text not null,
  message_id bigint,
  content_hash text not null,
  source_updated_at timestamptz,
  publication_status text not null default 'pending' check (
    publication_status in ('pending', 'published', 'expired', 'removed', 'failed', 'ignored')
  ),
  is_pinned boolean not null default false,
  first_published_at timestamptz,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_table, source_id, chat_id)
);

create table if not exists public.telegram_publish_queue (
  id uuid primary key default gen_random_uuid(),
  event_key text not null unique,
  source_table text not null check (
    source_table in ('news_announcements', 'blog_posts', 'services_announcements')
  ),
  source_id uuid not null,
  operation text not null check (operation in ('publish', 'edit', 'expire', 'remove')),
  payload jsonb not null,
  status text not null default 'pending' check (
    status in ('pending', 'processing', 'done', 'dead')
  ),
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists telegram_publish_queue_ready_idx
  on public.telegram_publish_queue (available_at, created_at)
  where status = 'pending';

create table if not exists public.telegram_publisher_meta (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.telegram_publish_logs (
  id bigint generated always as identity primary key,
  queue_id uuid references public.telegram_publish_queue(id) on delete set null,
  source_table text,
  source_id uuid,
  operation text,
  outcome text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.telegram_publications enable row level security;
alter table public.telegram_publish_queue enable row level security;
alter table public.telegram_publish_logs enable row level security;
alter table public.telegram_publisher_meta enable row level security;

revoke all on public.telegram_publications from anon, authenticated;
revoke all on public.telegram_publish_queue from anon, authenticated;
revoke all on public.telegram_publish_logs from anon, authenticated;
revoke all on public.telegram_publisher_meta from anon, authenticated;

grant all on public.telegram_publications to service_role;
grant all on public.telegram_publish_queue to service_role;
grant all on public.telegram_publish_logs to service_role;
grant all on public.telegram_publisher_meta to service_role;
grant usage, select on sequence public.telegram_publish_logs_id_seq to service_role;

-- Subscribe to source-table changes so new content is queued immediately.
-- Periodic reconciliation remains enabled as a recovery path for missed events.
do $$
declare
  source_table_name text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach source_table_name in array array[
      'news_announcements',
      'blog_posts',
      'services_announcements',
      'telegram_publish_queue'
    ] loop
      if not exists (
        select 1
        from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = source_table_name
      ) then
        execute format(
          'alter publication supabase_realtime add table public.%I',
          source_table_name
        );
      end if;
    end loop;
  end if;
end
$$;
