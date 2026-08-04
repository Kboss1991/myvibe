-- Catálogo en la nube (solo metadatos) + peer del PC para descargas Wi‑Fi
-- Ejecutar en SQL Editor del proyecto MyVibe

create table if not exists public.library_tracks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  local_id text not null,
  title text not null default '',
  artist text not null default '',
  album text not null default '',
  genre text not null default '',
  year text not null default '',
  duration double precision not null default 0,
  mime_type text not null default 'audio/mpeg',
  file_name text not null default '',
  updated_at timestamptz not null default now(),
  unique (user_id, local_id)
);

create index if not exists library_tracks_user_idx on public.library_tracks (user_id);

-- Versión del audio en el PC (para avisar al móvil y ofrecer “Actualizar”)
alter table public.library_tracks
  add column if not exists audio_updated_at timestamptz;

update public.library_tracks
set audio_updated_at = updated_at
where audio_updated_at is null;

alter table public.library_tracks enable row level security;

drop policy if exists "library_tracks_select_own" on public.library_tracks;
drop policy if exists "library_tracks_insert_own" on public.library_tracks;
drop policy if exists "library_tracks_update_own" on public.library_tracks;
drop policy if exists "library_tracks_delete_own" on public.library_tracks;

create policy "library_tracks_select_own"
  on public.library_tracks for select using (auth.uid() = user_id);
create policy "library_tracks_insert_own"
  on public.library_tracks for insert with check (auth.uid() = user_id);
create policy "library_tracks_update_own"
  on public.library_tracks for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "library_tracks_delete_own"
  on public.library_tracks for delete using (auth.uid() = user_id);

create table if not exists public.device_peers (
  user_id uuid primary key references auth.users (id) on delete cascade,
  peer_id text not null,
  device_label text not null default 'PC',
  updated_at timestamptz not null default now()
);

alter table public.device_peers enable row level security;

drop policy if exists "device_peers_select_own" on public.device_peers;
drop policy if exists "device_peers_upsert_own" on public.device_peers;
drop policy if exists "device_peers_update_own" on public.device_peers;
drop policy if exists "device_peers_delete_own" on public.device_peers;

create policy "device_peers_select_own"
  on public.device_peers for select using (auth.uid() = user_id);
create policy "device_peers_insert_own"
  on public.device_peers for insert with check (auth.uid() = user_id);
create policy "device_peers_update_own"
  on public.device_peers for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "device_peers_delete_own"
  on public.device_peers for delete using (auth.uid() = user_id);

-- Me gusta (perfil): sync PC ↔ móvil
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

-- Contenido para emparejar me gusta entre PC y móvil (ids locales distintos)
alter table public.library_likes
  add column if not exists title text not null default '';
alter table public.library_likes
  add column if not exists artist text not null default '';
alter table public.library_likes
  add column if not exists duration double precision not null default 0;
alter table public.library_likes
  add column if not exists file_name text not null default '';

-- Playlists (perfil): sync PC ↔ móvil
create table if not exists public.library_playlists (
  user_id uuid not null references auth.users (id) on delete cascade,
  local_id text not null,
  name text not null default '',
  description text not null default '',
  track_ids jsonb not null default '[]'::jsonb,
  has_cover boolean not null default false,
  theme_color text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, local_id)
);

alter table public.library_playlists
  add column if not exists theme_color text;

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

-- Tiempo real PC ↔ móvil (me gusta / playlists sin pulsar Actualizar)
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
