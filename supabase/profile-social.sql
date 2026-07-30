-- Dispositivos, círculo cercano y presencia.
-- Ejecutar en SQL Editor del proyecto MyVibe (después de schema.sql + library.sql)

-- Perfil: código de invitación al círculo
alter table public.profiles
  add column if not exists invite_code text;

create unique index if not exists profiles_invite_code_uidx
  on public.profiles (invite_code)
  where invite_code is not null;

-- Dispositivos de la cuenta (varios PC/móvil)
create table if not exists public.user_devices (
  id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  label text not null default 'Dispositivo',
  kind text not null default 'pc' check (kind in ('pc', 'mobile', 'tablet')),
  is_library_host boolean not null default false,
  last_seen timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists user_devices_user_idx on public.user_devices (user_id);

alter table public.user_devices enable row level security;

drop policy if exists "user_devices_select_own" on public.user_devices;
drop policy if exists "user_devices_insert_own" on public.user_devices;
drop policy if exists "user_devices_update_own" on public.user_devices;
drop policy if exists "user_devices_delete_own" on public.user_devices;

create policy "user_devices_select_own"
  on public.user_devices for select using (auth.uid() = user_id);
create policy "user_devices_insert_own"
  on public.user_devices for insert with check (auth.uid() = user_id);
create policy "user_devices_update_own"
  on public.user_devices for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "user_devices_delete_own"
  on public.user_devices for delete using (auth.uid() = user_id);

-- Amistades (círculo cercano): fila simétrica por usuario
create table if not exists public.friendships (
  user_id uuid not null references auth.users (id) on delete cascade,
  friend_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, friend_id),
  check (user_id <> friend_id)
);

create index if not exists friendships_friend_idx on public.friendships (friend_id);

alter table public.friendships enable row level security;

drop policy if exists "friendships_select_own" on public.friendships;
drop policy if exists "friendships_insert_own" on public.friendships;
drop policy if exists "friendships_delete_own" on public.friendships;

create policy "friendships_select_own"
  on public.friendships for select using (auth.uid() = user_id);
create policy "friendships_insert_own"
  on public.friendships for insert with check (auth.uid() = user_id);
create policy "friendships_delete_own"
  on public.friendships for delete using (auth.uid() = user_id);

-- Escuchando ahora (visible al círculo)
create table if not exists public.friend_presence (
  user_id uuid primary key references auth.users (id) on delete cascade,
  title text not null default '',
  artist text not null default '',
  playlist_name text not null default '',
  updated_at timestamptz not null default now()
);

alter table public.friend_presence enable row level security;

drop policy if exists "friend_presence_select_circle" on public.friend_presence;
drop policy if exists "friend_presence_upsert_own" on public.friend_presence;
drop policy if exists "friend_presence_update_own" on public.friend_presence;
drop policy if exists "friend_presence_delete_own" on public.friend_presence;

create policy "friend_presence_select_circle"
  on public.friend_presence for select using (
    auth.uid() = user_id
    or exists (
      select 1 from public.friendships f
      where f.user_id = auth.uid() and f.friend_id = friend_presence.user_id
    )
  );
create policy "friend_presence_insert_own"
  on public.friend_presence for insert with check (auth.uid() = user_id);
create policy "friend_presence_update_own"
  on public.friend_presence for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "friend_presence_delete_own"
  on public.friend_presence for delete using (auth.uid() = user_id);

-- Playlists compartidas con un amigo (metadatos, sin audio)
create table if not exists public.shared_playlists (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  friend_id uuid not null references auth.users (id) on delete cascade,
  playlist_local_id text not null default '',
  playlist_name text not null default '',
  track_titles jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists shared_playlists_friend_idx on public.shared_playlists (friend_id);
create index if not exists shared_playlists_owner_idx on public.shared_playlists (owner_id);

alter table public.shared_playlists enable row level security;

drop policy if exists "shared_playlists_select" on public.shared_playlists;
drop policy if exists "shared_playlists_insert_own" on public.shared_playlists;
drop policy if exists "shared_playlists_delete" on public.shared_playlists;

create policy "shared_playlists_select"
  on public.shared_playlists for select using (
    auth.uid() = owner_id or auth.uid() = friend_id
  );
create policy "shared_playlists_insert_own"
  on public.shared_playlists for insert with check (auth.uid() = owner_id);
create policy "shared_playlists_delete"
  on public.shared_playlists for delete using (
    auth.uid() = owner_id or auth.uid() = friend_id
  );

-- RPC: añadir amigo por código de invitación
create or replace function public.add_friend_by_code(p_code text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_friend uuid;
  v_name text;
  v_code text := upper(trim(p_code));
begin
  if v_me is null then
    raise exception 'No autenticado';
  end if;
  if v_code is null or length(v_code) < 4 then
    raise exception 'Código inválido';
  end if;

  select id, display_name into v_friend, v_name
  from public.profiles
  where invite_code = v_code
  limit 1;

  if v_friend is null then
    raise exception 'Código no encontrado';
  end if;
  if v_friend = v_me then
    raise exception 'No puedes añadirte a ti mismo';
  end if;

  insert into public.friendships (user_id, friend_id)
  values (v_me, v_friend)
  on conflict do nothing;

  insert into public.friendships (user_id, friend_id)
  values (v_friend, v_me)
  on conflict do nothing;

  return json_build_object('friend_id', v_friend, 'display_name', coalesce(v_name, 'Amigo'));
end;
$$;

revoke all on function public.add_friend_by_code(text) from public;
grant execute on function public.add_friend_by_code(text) to authenticated;

-- RPC: añadir amigo por correo
create or replace function public.add_friend_by_email(p_email text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_friend uuid;
  v_name text;
  v_email text := lower(trim(p_email));
begin
  if v_me is null then
    raise exception 'No autenticado';
  end if;
  if v_email is null or position('@' in v_email) = 0 then
    raise exception 'Correo inválido';
  end if;

  select id, display_name into v_friend, v_name
  from public.profiles
  where lower(email) = v_email
  limit 1;

  if v_friend is null then
    raise exception 'No hay ninguna cuenta con ese correo';
  end if;
  if v_friend = v_me then
    raise exception 'No puedes añadirte a ti mismo';
  end if;

  insert into public.friendships (user_id, friend_id)
  values (v_me, v_friend)
  on conflict do nothing;

  insert into public.friendships (user_id, friend_id)
  values (v_friend, v_me)
  on conflict do nothing;

  return json_build_object('friend_id', v_friend, 'display_name', coalesce(v_name, 'Amigo'));
end;
$$;

revoke all on function public.add_friend_by_email(text) from public;
grant execute on function public.add_friend_by_email(text) to authenticated;

-- Lectura mínima de perfiles amigos (nombre + avatar)
create or replace function public.get_circle_profiles()
returns table (
  id uuid,
  display_name text,
  avatar_hue int,
  has_avatar boolean,
  avatar_updated_at timestamptz,
  invite_code text
)
language sql
security definer
set search_path = public
as $$
  select p.id, p.display_name, p.avatar_hue, p.has_avatar, p.avatar_updated_at, p.invite_code
  from public.profiles p
  where p.id = auth.uid()
     or p.id in (select friend_id from public.friendships where user_id = auth.uid());
$$;

revoke all on function public.get_circle_profiles() from public;
grant execute on function public.get_circle_profiles() to authenticated;
