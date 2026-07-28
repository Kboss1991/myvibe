import { db } from '../db'
import type { Playlist, Track } from '../types'
import { isCloudAuthEnabled, getSupabase } from './supabase'
import { deleteTrack, getAudioBlob } from './library'
import { isLibraryHostDevice } from './folderImport'
import { groupDuplicateTracks, pickCanonicalTrack, trackContentKeys, tracksLookSame } from './trackDedupe'

export type CloudTrackRow = {
  local_id: string
  title: string
  artist: string
  album: string
  genre: string
  year: string
  duration: number
  mime_type: string
  file_name: string
  updated_at: string
}

async function deleteCloudLocalIds(userId: string, localIds: string[]): Promise<number> {
  if (!localIds.length) return 0
  const supabase = getSupabase()
  const unique = [...new Set(localIds)]
  const chunk = 80
  let removed = 0
  for (let i = 0; i < unique.length; i += chunk) {
    const slice = unique.slice(i, i + chunk)
    const { error } = await supabase
      .from('library_tracks')
      .delete()
      .eq('user_id', userId)
      .in('local_id', slice)
    if (error) throw new Error(error.message || 'Error al borrar catálogo')
    removed += slice.length
  }
  return removed
}

/** Borra ids concretos de la nube (tras eliminar canciones en el PC). */
export async function removeCloudTracks(userId: string, localIds: string[]): Promise<number> {
  if (!isCloudAuthEnabled() || !localIds.length) return 0
  return deleteCloudLocalIds(userId, localIds)
}

/**
 * En el PC (host): el catálogo cloud debe reflejar exactamente las canciones
 * con audio local. Borra en Supabase lo que ya no está aquí.
 */
async function reconcileCloudWithLocalLibrary(
  userId: string,
  keepIds: Set<string>,
): Promise<number> {
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from('library_tracks')
    .select('local_id')
    .eq('user_id', userId)
  if (error) throw new Error(error.message)
  const stale = ((data || []) as { local_id: string }[])
    .map((r) => r.local_id)
    .filter((id) => !keepIds.has(id))
  return deleteCloudLocalIds(userId, stale)
}

/**
 * Sube metadatos de canciones locales a Supabase (no sube el audio).
 * En el PC también elimina de la nube lo que ya no existe localmente.
 */
export async function pushLibraryMetadata(userId: string): Promise<number> {
  if (!isCloudAuthEnabled()) return 0
  const supabase = getSupabase()
  const tracks = await db.tracks.toArray()
  // Todo lo que no sea stub remoto cuenta como “en este dispositivo”
  const localTracks = tracks.filter((t) => t.hasLocalAudio !== false)
  const keepIds = new Set(localTracks.map((t) => t.id))

  if (localTracks.length) {
    const rows = localTracks.map((t) => ({
      user_id: userId,
      local_id: t.id,
      title: t.title || '',
      artist: t.artist || '',
      album: t.album || '',
      genre: t.genre || '',
      year: t.year || '',
      duration: t.duration || 0,
      mime_type: t.mimeType || 'audio/mpeg',
      file_name: t.fileName || `${t.title}.mp3`,
      updated_at: new Date().toISOString(),
    }))

    const chunk = 80
    for (let i = 0; i < rows.length; i += chunk) {
      const slice = rows.slice(i, i + chunk)
      const { error } = await supabase.from('library_tracks').upsert(slice, {
        onConflict: 'user_id,local_id',
      })
      if (error) throw new Error(error.message || 'Error al subir catálogo')
    }
  }

  // Solo el PC espeja borrados (el móvil no debe vaciar la nube)
  if (isLibraryHostDevice()) {
    await reconcileCloudWithLocalLibrary(userId, keepIds)
  }

  return localTracks.length
}

/**
 * Elimina en la nube filas duplicadas (mismo archivo/título con distinto local_id).
 * Conserva el id que exista en este dispositivo, o el más reciente.
 */
export async function pruneCloudDuplicateTracks(userId: string): Promise<number> {
  if (!isCloudAuthEnabled()) return 0
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from('library_tracks')
    .select(
      'local_id,title,artist,album,genre,year,duration,mime_type,file_name,updated_at',
    )
    .eq('user_id', userId)
  if (error) throw new Error(error.message)
  const rows = (data || []) as CloudTrackRow[]
  if (rows.length < 2) return 0

  const localIds = new Set((await db.tracks.toArray()).map((t) => t.id))
  const asTracks: Track[] = rows.map((r) => ({
    id: r.local_id,
    title: r.title,
    artist: r.artist,
    album: r.album,
    genre: r.genre,
    year: r.year,
    duration: r.duration,
    mimeType: r.mime_type,
    fileName: r.file_name,
    hasCover: false,
    liked: false,
    playCount: 0,
    lastPlayedAt: null,
    createdAt: Date.parse(r.updated_at) || 0,
    enriched: false,
    hasLocalAudio: localIds.has(r.local_id),
  }))

  const groups = groupDuplicateTracks(asTracks)
  const removeIds: string[] = []
  for (const group of groups) {
    // Preferir el que está en este dispositivo
    const keep =
      group.find((t) => localIds.has(t.id)) || pickCanonicalTrack(group)
    for (const t of group) {
      if (t.id !== keep.id) removeIds.push(t.id)
    }
  }

  const uniqueRemove = [...new Set(removeIds)]
  if (!uniqueRemove.length) return 0

  const chunk = 80
  for (let i = 0; i < uniqueRemove.length; i += chunk) {
    const slice = uniqueRemove.slice(i, i + chunk)
    const { error: delErr } = await supabase
      .from('library_tracks')
      .delete()
      .eq('user_id', userId)
      .in('local_id', slice)
    if (delErr) throw new Error(delErr.message)
  }
  return uniqueRemove.length
}

/** Baja el catálogo de la nube y crea stubs grises si no hay audio local. */
export async function pullLibraryCatalog(userId: string): Promise<number> {
  if (!isCloudAuthEnabled()) return 0
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from('library_tracks')
    .select(
      'local_id,title,artist,album,genre,year,duration,mime_type,file_name,updated_at',
    )
    .eq('user_id', userId)
  if (error) throw new Error(error.message)
  const rows = (data || []) as CloudTrackRow[]
  let added = 0
  let locals = await db.tracks.toArray()
  const seenKeys = new Set<string>()
  const cloudIds = new Set(rows.map((r) => r.local_id))

  for (const row of rows) {
    const rowLike = {
      title: row.title,
      artist: row.artist,
      duration: row.duration,
      fileName: row.file_name,
    }
    const keys = trackContentKeys(rowLike)

    // Ya aceptamos otra fila cloud con el mismo contenido
    if (keys.some((k) => seenKeys.has(k))) continue

    const existing = await db.tracks.get(row.local_id)
    const hasBlob = existing ? Boolean(await getAudioBlob(row.local_id)) : false

    if (existing && hasBlob) {
      await db.tracks.update(row.local_id, {
        title: row.title || existing.title,
        artist: row.artist || existing.artist,
        album: row.album || existing.album,
        genre: row.genre || existing.genre,
        year: row.year || existing.year,
        duration: row.duration || existing.duration,
        mimeType: row.mime_type || existing.mimeType,
        fileName: row.file_name || existing.fileName,
        hasLocalAudio: true,
        origin: 'cloud',
      })
      for (const k of keys) seenKeys.add(k)
      continue
    }

    // Misma canción ya local con audio → no crear stub
    const localWithAudio = locals.find(
      (t) =>
        t.id !== row.local_id &&
        t.hasLocalAudio !== false &&
        tracksLookSame(t, rowLike),
    )
    if (localWithAudio) {
      for (const k of keys) seenKeys.add(k)
      continue
    }

    // Stub con id antiguo (post-dedupe): bórralo y crea el canónico
    const staleStub = locals.find(
      (t) =>
        t.id !== row.local_id &&
        t.hasLocalAudio === false &&
        tracksLookSame(t, rowLike),
    )
    if (staleStub) {
      await db.tracks.delete(staleStub.id)
      locals = locals.filter((t) => t.id !== staleStub.id)
    }

    if (existing && !hasBlob) {
      await db.tracks.update(row.local_id, {
        title: row.title,
        artist: row.artist,
        album: row.album,
        genre: row.genre,
        year: row.year,
        duration: row.duration,
        mimeType: row.mime_type,
        fileName: row.file_name,
        hasLocalAudio: false,
        origin: 'cloud',
      })
      for (const k of keys) seenKeys.add(k)
      continue
    }

    const stub: Track = {
      id: row.local_id,
      title: row.title || 'Sin título',
      artist: row.artist || 'Artista desconocido',
      album: row.album || 'Sin álbum',
      genre: row.genre || '',
      year: row.year || '',
      duration: row.duration || 0,
      mimeType: row.mime_type || 'audio/mpeg',
      fileName: row.file_name || `${row.title}.mp3`,
      hasCover: false,
      liked: staleStub?.liked ?? false,
      playCount: staleStub?.playCount ?? 0,
      lastPlayedAt: staleStub?.lastPlayedAt ?? null,
      createdAt: row.updated_at ? Date.parse(row.updated_at) : Date.now(),
      enriched: false,
      hasLocalAudio: false,
      origin: 'cloud',
    }
    await db.tracks.put(stub)
    locals.push(stub)
    for (const k of keys) seenKeys.add(k)
    added += 1
  }

  // Fuera del catálogo en la nube: quitar stubs y copias descargadas del PC
  locals = await db.tracks.toArray()
  for (const local of locals) {
    const inCloudById = cloudIds.has(local.id)
    const inCloudByContent = rows.some((r) =>
      tracksLookSame(local, {
        title: r.title,
        artist: r.artist,
        duration: r.duration,
        fileName: r.file_name,
      }),
    )
    if (inCloudById || inCloudByContent) continue

    const isStub = local.hasLocalAudio === false
    const fromCloud = local.origin === 'cloud'
    // En el PC no borramos audio local solo porque falló el push; solo móvil limpia nubes
    if (isLibraryHostDevice() && !isStub) continue

    if (isStub || fromCloud) {
      try {
        await deleteTrack(local.id)
      } catch (e) {
        console.warn('No se pudo borrar pista sincronizada', local.id, e)
      }
    }
  }

  return added
}

export async function publishDevicePeer(
  userId: string,
  peerId: string,
  deviceLabel = 'PC',
): Promise<void> {
  if (!isCloudAuthEnabled()) return
  const supabase = getSupabase()
  const { error } = await supabase.from('device_peers').upsert({
    user_id: userId,
    peer_id: peerId,
    device_label: deviceLabel,
    updated_at: new Date().toISOString(),
  })
  if (error) throw new Error(error.message)
}

export async function clearDevicePeer(userId: string): Promise<void> {
  if (!isCloudAuthEnabled()) return
  try {
    await getSupabase().from('device_peers').delete().eq('user_id', userId)
  } catch {
    // ignore
  }
}

export async function getDevicePeer(
  userId: string,
): Promise<{ peerId: string; updatedAt: string; label: string } | null> {
  if (!isCloudAuthEnabled()) return null
  const { data, error } = await getSupabase()
    .from('device_peers')
    .select('peer_id,updated_at,device_label')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data?.peer_id) return null
  return {
    peerId: data.peer_id as string,
    updatedAt: data.updated_at as string,
    label: (data.device_label as string) || 'PC',
  }
}

export async function getCloudCatalogCount(userId: string): Promise<number> {
  if (!isCloudAuthEnabled()) return 0
  const { count, error } = await getSupabase()
    .from('library_tracks')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
  if (error) throw new Error(error.message)
  return count ?? 0
}

type CloudLikeRow = {
  local_id: string
  liked: boolean
  updated_at: string
}

type CloudPlaylistRow = {
  local_id: string
  name: string
  description: string
  track_ids: string[] | unknown
  has_cover: boolean
  created_at: string
  updated_at: string
}

function playlistIdsKey(userId: string) {
  return `mv-cloud-playlists:${userId}`
}

function readKnownPlaylistIds(userId: string): Set<string> {
  try {
    const raw = localStorage.getItem(playlistIdsKey(userId))
    if (!raw) return new Set()
    const arr = JSON.parse(raw) as string[]
    return new Set(Array.isArray(arr) ? arr : [])
  } catch {
    return new Set()
  }
}

function writeKnownPlaylistIds(userId: string, ids: Set<string>) {
  try {
    localStorage.setItem(playlistIdsKey(userId), JSON.stringify([...ids]))
  } catch {
    // ignore
  }
}

/** Resuelve un id de canción local (mismo contenido, distinto id entre dispositivos). */
async function resolveLocalTrackId(preferredId: string): Promise<string | null> {
  const direct = await db.tracks.get(preferredId)
  if (direct) return preferredId
  return null
}

/**
 * Sube me gusta al perfil (Supabase).
 * Si se pasa trackId, solo esa canción; si no, todas las que tienen likedUpdatedAt o liked.
 */
export async function pushLibraryLikes(
  userId: string,
  trackId?: string,
): Promise<number> {
  if (!isCloudAuthEnabled()) return 0
  const supabase = getSupabase()
  const tracks = trackId
    ? ([await db.tracks.get(trackId)].filter(Boolean) as Track[])
    : await db.tracks.toArray()

  const rows = tracks
    .filter((t) => t.liked || typeof t.likedUpdatedAt === 'number')
    .map((t) => ({
      user_id: userId,
      local_id: t.id,
      liked: Boolean(t.liked),
      updated_at: new Date(
        t.likedUpdatedAt || t.createdAt || Date.now(),
      ).toISOString(),
    }))

  if (!rows.length) return 0

  const chunk = 80
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk)
    const { error } = await supabase.from('library_likes').upsert(slice, {
      onConflict: 'user_id,local_id',
    })
    if (error) throw new Error(error.message || 'Error al sincronizar me gusta')
  }
  return rows.length
}

/** Baja me gusta del perfil y aplica LWW sobre las pistas locales. */
export async function pullLibraryLikes(userId: string): Promise<number> {
  if (!isCloudAuthEnabled()) return 0
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from('library_likes')
    .select('local_id,liked,updated_at')
    .eq('user_id', userId)
  if (error) throw new Error(error.message)

  const rows = (data || []) as CloudLikeRow[]
  let applied = 0
  const locals = await db.tracks.toArray()

  for (const row of rows) {
    let track = await db.tracks.get(row.local_id)
    if (!track) {
      // Misma canción con otro id local (contenido)
      const cloudMeta = await supabase
        .from('library_tracks')
        .select('title,artist,duration,file_name')
        .eq('user_id', userId)
        .eq('local_id', row.local_id)
        .maybeSingle()
      const meta = cloudMeta.data as
        | { title: string; artist: string; duration: number; file_name: string }
        | null
      if (meta) {
        track =
          locals.find((t) =>
            tracksLookSame(t, {
              title: meta.title,
              artist: meta.artist,
              duration: meta.duration,
              fileName: meta.file_name,
            }),
          ) || undefined
      }
    }
    if (!track) continue

    const remoteTs = Date.parse(row.updated_at) || 0
    const localTs = track.likedUpdatedAt || 0
    if (remoteTs < localTs) continue
    if (track.liked === row.liked && localTs >= remoteTs) continue

    await db.tracks.update(track.id, {
      liked: row.liked,
      likedUpdatedAt: remoteTs,
    })
    applied += 1
  }
  return applied
}

/** Sube playlists del perfil a Supabase. */
export async function pushLibraryPlaylists(
  userId: string,
  playlistId?: string,
): Promise<number> {
  if (!isCloudAuthEnabled()) return 0
  const supabase = getSupabase()
  const playlists: Playlist[] = playlistId
    ? (([await db.playlists.get(playlistId)].filter(Boolean) as Playlist[]) )
    : await db.playlists.toArray()

  if (!playlists.length) return 0

  const rows = playlists.map((p) => ({
    user_id: userId,
    local_id: p.id,
    name: p.name || '',
    description: p.description || '',
    track_ids: p.trackIds || [],
    has_cover: Boolean(p.hasCover),
    created_at: new Date(p.createdAt || Date.now()).toISOString(),
    updated_at: new Date(p.updatedAt || Date.now()).toISOString(),
  }))

  const chunk = 40
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk)
    const { error } = await supabase.from('library_playlists').upsert(slice, {
      onConflict: 'user_id,local_id',
    })
    if (error) throw new Error(error.message || 'Error al sincronizar playlists')
  }

  const known = readKnownPlaylistIds(userId)
  for (const p of playlists) known.add(p.id)
  writeKnownPlaylistIds(userId, known)
  return rows.length
}

/** Borra una playlist del perfil en la nube. */
export async function removeCloudPlaylist(
  userId: string,
  playlistId: string,
): Promise<void> {
  if (!isCloudAuthEnabled()) return
  const { error } = await getSupabase()
    .from('library_playlists')
    .delete()
    .eq('user_id', userId)
    .eq('local_id', playlistId)
  if (error) throw new Error(error.message)
  const known = readKnownPlaylistIds(userId)
  known.delete(playlistId)
  writeKnownPlaylistIds(userId, known)
}

/** Baja playlists del perfil (LWW) y aplica borrados remotos. */
export async function pullLibraryPlaylists(userId: string): Promise<number> {
  if (!isCloudAuthEnabled()) return 0
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from('library_playlists')
    .select('local_id,name,description,track_ids,has_cover,created_at,updated_at')
    .eq('user_id', userId)
  if (error) throw new Error(error.message)

  const rows = (data || []) as CloudPlaylistRow[]
  const cloudIds = new Set(rows.map((r) => r.local_id))
  const previouslyKnown = readKnownPlaylistIds(userId)
  let applied = 0

  for (const row of rows) {
    const remoteTs = Date.parse(row.updated_at) || 0
    const existing = await db.playlists.get(row.local_id)
    const trackIdsRaw = row.track_ids
    const trackIds = Array.isArray(trackIdsRaw)
      ? trackIdsRaw.filter((id): id is string => typeof id === 'string')
      : []

    const resolvedIds: string[] = []
    for (const id of trackIds) {
      const resolved = await resolveLocalTrackId(id)
      resolvedIds.push(resolved || id)
    }

    if (!existing) {
      await db.playlists.put({
        id: row.local_id,
        name: row.name || 'Playlist',
        description: row.description || '',
        trackIds: resolvedIds,
        hasCover: Boolean(row.has_cover),
        createdAt: Date.parse(row.created_at) || Date.now(),
        updatedAt: remoteTs || Date.now(),
      })
      applied += 1
      continue
    }

    if ((existing.updatedAt || 0) > remoteTs) continue

    await db.playlists.update(row.local_id, {
      name: row.name || existing.name,
      description: row.description ?? existing.description,
      trackIds: resolvedIds,
      // No forzar hasCover desde nube (las fotos no se suben aún)
      updatedAt: remoteTs || existing.updatedAt,
    })
    applied += 1
  }

  // Playlists que estaban en la nube y ya no → borradas en otro dispositivo
  for (const id of previouslyKnown) {
    if (cloudIds.has(id)) continue
    await db.playlists.delete(id).catch(() => undefined)
  }

  writeKnownPlaylistIds(userId, cloudIds)
  return applied
}

/** Sync completo de me gusta + playlists (perfil). */
export async function syncLibraryTaste(userId: string): Promise<{
  likesIn: number
  likesOut: number
  playlistsIn: number
  playlistsOut: number
}> {
  const likesOut = await pushLibraryLikes(userId)
  const playlistsOut = await pushLibraryPlaylists(userId)
  const likesIn = await pullLibraryLikes(userId)
  const playlistsIn = await pullLibraryPlaylists(userId)
  return { likesIn, likesOut, playlistsIn, playlistsOut }
}
