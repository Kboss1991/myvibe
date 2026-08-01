/** SQL para crear me gusta / playlists en Supabase (copiar desde el perfil). */
export const TASTE_SYNC_SQL = `-- MyVibe: me gusta + playlists (PC ↔ móvil)
-- Pegar en Supabase → SQL Editor → Run

create table if not exists public.library_likes (
  user_id uuid not null references auth.users (id) on delete cascade,
  local_id text not null,
  liked boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (user_id, local_id)
);

create index if not exists library_likes_user_idx on public.library_likes (user_id);

alter table public.library_likes enable row level security;

drop policy if exists "library_likes_select_own" on public.library_likes;
drop policy if exists "library_likes_insert_own" on public.library_likes;
drop policy if exists "library_likes_update_own" on public.library_likes;
drop policy if exists "library_likes_delete_own" on public.library_likes;

create policy "library_likes_select_own"
  on public.library_likes for select using (auth.uid() = user_id);
create policy "library_likes_insert_own"
  on public.library_likes for insert with check (auth.uid() = user_id);
create policy "library_likes_update_own"
  on public.library_likes for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "library_likes_delete_own"
  on public.library_likes for delete using (auth.uid() = user_id);

alter table public.library_likes
  add column if not exists title text not null default '';
alter table public.library_likes
  add column if not exists artist text not null default '';
alter table public.library_likes
  add column if not exists duration double precision not null default 0;
alter table public.library_likes
  add column if not exists file_name text not null default '';

create table if not exists public.library_playlists (
  user_id uuid not null references auth.users (id) on delete cascade,
  local_id text not null,
  name text not null default '',
  description text not null default '',
  track_ids jsonb not null default '[]'::jsonb,
  has_cover boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, local_id)
);

create index if not exists library_playlists_user_idx on public.library_playlists (user_id);

alter table public.library_playlists enable row level security;

drop policy if exists "library_playlists_select_own" on public.library_playlists;
drop policy if exists "library_playlists_insert_own" on public.library_playlists;
drop policy if exists "library_playlists_update_own" on public.library_playlists;
drop policy if exists "library_playlists_delete_own" on public.library_playlists;

create policy "library_playlists_select_own"
  on public.library_playlists for select using (auth.uid() = user_id);
create policy "library_playlists_insert_own"
  on public.library_playlists for insert with check (auth.uid() = user_id);
create policy "library_playlists_update_own"
  on public.library_playlists for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "library_playlists_delete_own"
  on public.library_playlists for delete using (auth.uid() = user_id);

do $$
begin
  alter publication supabase_realtime add table public.library_likes;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.library_playlists;
exception when duplicate_object then null;
end $$;
`
