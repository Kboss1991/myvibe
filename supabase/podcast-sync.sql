-- Ejecutar en Supabase → SQL Editor
-- Sync de podcasts seguidos + progreso de episodios (PC ↔ móvil)

create table if not exists public.podcast_subscriptions (
  user_id uuid not null references auth.users (id) on delete cascade,
  show_id text not null,
  name text not null default '',
  artist text not null default '',
  feed_url text not null default '',
  artwork_url text not null default '',
  genre text not null default '',
  updated_at timestamptz not null default now(),
  primary key (user_id, show_id)
);

create index if not exists podcast_subscriptions_user_idx
  on public.podcast_subscriptions (user_id);

alter table public.podcast_subscriptions enable row level security;

drop policy if exists "podcast_subscriptions_select_own" on public.podcast_subscriptions;
drop policy if exists "podcast_subscriptions_insert_own" on public.podcast_subscriptions;
drop policy if exists "podcast_subscriptions_update_own" on public.podcast_subscriptions;
drop policy if exists "podcast_subscriptions_delete_own" on public.podcast_subscriptions;

create policy "podcast_subscriptions_select_own"
  on public.podcast_subscriptions for select using (auth.uid() = user_id);
create policy "podcast_subscriptions_insert_own"
  on public.podcast_subscriptions for insert with check (auth.uid() = user_id);
create policy "podcast_subscriptions_update_own"
  on public.podcast_subscriptions for update using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy "podcast_subscriptions_delete_own"
  on public.podcast_subscriptions for delete using (auth.uid() = user_id);

create table if not exists public.podcast_progress (
  user_id uuid not null references auth.users (id) on delete cascade,
  episode_id text not null,
  show_id text not null default '',
  position double precision not null default 0,
  duration double precision not null default 0,
  completed boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, episode_id)
);

create index if not exists podcast_progress_user_idx
  on public.podcast_progress (user_id);
create index if not exists podcast_progress_show_idx
  on public.podcast_progress (user_id, show_id);

alter table public.podcast_progress enable row level security;

drop policy if exists "podcast_progress_select_own" on public.podcast_progress;
drop policy if exists "podcast_progress_insert_own" on public.podcast_progress;
drop policy if exists "podcast_progress_update_own" on public.podcast_progress;
drop policy if exists "podcast_progress_delete_own" on public.podcast_progress;

create policy "podcast_progress_select_own"
  on public.podcast_progress for select using (auth.uid() = user_id);
create policy "podcast_progress_insert_own"
  on public.podcast_progress for insert with check (auth.uid() = user_id);
create policy "podcast_progress_update_own"
  on public.podcast_progress for update using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy "podcast_progress_delete_own"
  on public.podcast_progress for delete using (auth.uid() = user_id);

do $$
begin
  alter publication supabase_realtime add table public.podcast_subscriptions;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.podcast_progress;
exception when duplicate_object then null;
end $$;
