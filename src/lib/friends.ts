import { getSupabase, isCloudAuthEnabled } from './supabase'

export type CircleFriend = {
  id: string
  displayName: string
  avatarHue: number
  hasAvatar: boolean
  avatarUpdatedAt?: number
  listening?: { title: string; artist: string; playlistName: string; updatedAt: number } | null
}

export type SharedPlaylistCard = {
  id: string
  ownerId: string
  friendId: string
  playlistName: string
  trackTitles: string[]
  createdAt: number
  fromMe: boolean
}

function makeInviteCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let out = ''
  for (let i = 0; i < 6; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return out
}

export async function ensureInviteCode(userId: string): Promise<string> {
  if (!isCloudAuthEnabled()) {
    const key = `myvibe_invite_code:${userId}`
    let code = localStorage.getItem(key)
    if (!code) {
      code = makeInviteCode()
      localStorage.setItem(key, code)
    }
    return code
  }
  const sb = getSupabase()
  const { data, error } = await sb
    .from('profiles')
    .select('invite_code')
    .eq('id', userId)
    .maybeSingle()
  if (error) throw error
  if (data?.invite_code) return data.invite_code as string

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = makeInviteCode()
    const { error: upErr } = await sb
      .from('profiles')
      .update({ invite_code: code })
      .eq('id', userId)
      .is('invite_code', null)
    if (!upErr) {
      const again = await sb.from('profiles').select('invite_code').eq('id', userId).maybeSingle()
      if (again.data?.invite_code) return again.data.invite_code as string
    }
  }
  throw new Error('No se pudo crear el código de invitación')
}

export async function addFriendByCode(code: string): Promise<{ friendId: string; displayName: string }> {
  if (!isCloudAuthEnabled()) throw new Error('El círculo requiere cuenta en la nube')
  const sb = getSupabase()
  const { data, error } = await sb.rpc('add_friend_by_code', { p_code: code.trim() })
  if (error) throw new Error(error.message)
  const row = data as { friend_id: string; display_name: string }
  return { friendId: row.friend_id, displayName: row.display_name }
}

export async function addFriendByEmail(email: string): Promise<{ friendId: string; displayName: string }> {
  if (!isCloudAuthEnabled()) throw new Error('El círculo requiere cuenta en la nube')
  const sb = getSupabase()
  const { data, error } = await sb.rpc('add_friend_by_email', { p_email: email.trim() })
  if (error) throw new Error(error.message)
  const row = data as { friend_id: string; display_name: string }
  return { friendId: row.friend_id, displayName: row.display_name }
}

export async function removeFriend(userId: string, friendId: string): Promise<void> {
  if (!isCloudAuthEnabled()) return
  const sb = getSupabase()
  await sb.from('friendships').delete().eq('user_id', userId).eq('friend_id', friendId)
  await sb.from('friendships').delete().eq('user_id', friendId).eq('friend_id', userId)
}

export async function listCircle(userId: string): Promise<CircleFriend[]> {
  if (!isCloudAuthEnabled()) return []
  const sb = getSupabase()
  const { data: profiles, error } = await sb.rpc('get_circle_profiles')
  if (error) throw error

  const friends = (profiles as {
    id: string
    display_name: string
    avatar_hue: number
    has_avatar: boolean
    avatar_updated_at: string | null
  }[]).filter((p) => p.id !== userId)

  if (!friends.length) return []

  const ids = friends.map((f) => f.id)
  const { data: presence } = await sb
    .from('friend_presence')
    .select('user_id, title, artist, playlist_name, updated_at')
    .in('user_id', ids)

  const presenceMap = new Map(
    (presence ?? []).map((p) => [
      p.user_id as string,
      {
        title: (p.title as string) || '',
        artist: (p.artist as string) || '',
        playlistName: (p.playlist_name as string) || '',
        updatedAt: Date.parse(p.updated_at as string) || 0,
      },
    ]),
  )

  return friends.map((f) => ({
    id: f.id,
    displayName: f.display_name || 'Amigo',
    avatarHue: f.avatar_hue ?? 200,
    hasAvatar: Boolean(f.has_avatar),
    avatarUpdatedAt: f.avatar_updated_at ? Date.parse(f.avatar_updated_at) : undefined,
    listening: presenceMap.get(f.id) ?? null,
  }))
}

export async function publishListeningNow(input: {
  title: string
  artist: string
  playlistName?: string
}): Promise<void> {
  if (!isCloudAuthEnabled()) return
  const sb = getSupabase()
  const userId = (await sb.auth.getUser()).data.user?.id
  if (!userId) return
  await sb.from('friend_presence').upsert({
    user_id: userId,
    title: input.title.slice(0, 200),
    artist: input.artist.slice(0, 200),
    playlist_name: (input.playlistName || '').slice(0, 200),
    updated_at: new Date().toISOString(),
  })
}

export async function sharePlaylistWithFriend(input: {
  friendId: string
  playlistLocalId: string
  playlistName: string
  trackTitles: string[]
}): Promise<void> {
  if (!isCloudAuthEnabled()) throw new Error('Compartir requiere la nube')
  const sb = getSupabase()
  const userId = (await sb.auth.getUser()).data.user?.id
  if (!userId) throw new Error('Sin sesión')
  const { error } = await sb.from('shared_playlists').insert({
    owner_id: userId,
    friend_id: input.friendId,
    playlist_local_id: input.playlistLocalId,
    playlist_name: input.playlistName,
    track_titles: input.trackTitles.slice(0, 80),
  })
  if (error) throw error
}

export async function listSharedPlaylists(userId: string): Promise<SharedPlaylistCard[]> {
  if (!isCloudAuthEnabled()) return []
  const sb = getSupabase()
  const { data, error } = await sb
    .from('shared_playlists')
    .select('id, owner_id, friend_id, playlist_name, track_titles, created_at')
    .or(`owner_id.eq.${userId},friend_id.eq.${userId}`)
    .order('created_at', { ascending: false })
    .limit(40)
  if (error) throw error
  return (data ?? []).map((r) => ({
    id: r.id as string,
    ownerId: r.owner_id as string,
    friendId: r.friend_id as string,
    playlistName: (r.playlist_name as string) || 'Playlist',
    trackTitles: Array.isArray(r.track_titles) ? (r.track_titles as string[]) : [],
    createdAt: Date.parse(r.created_at as string) || 0,
    fromMe: r.owner_id === userId,
  }))
}
