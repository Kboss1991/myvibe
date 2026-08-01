import { db } from '../db'
import type { Playlist, Track } from '../types'
import { isCloudAuthEnabled, getSupabase } from './supabase'
import { deleteTrack, getAudioBlob } from './library'
import { isLibraryHostDevice } from './devices'
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
  const removeToKeep = new Map<string, string>()
  for (const group of groups) {
    // Preferir el que está en este dispositivo
    const keep =
      group.find((t) => localIds.has(t.id)) || pickCanonicalTrack(group)
    for (const t of group) {
      if (t.id !== keep.id) {
        removeIds.push(t.id)
        removeToKeep.set(t.id, keep.id)
      }
    }
  }

  const uniqueRemove = [...new Set(removeIds)]
  if (!uniqueRemove.length) return 0

  // Antes de borrar ids del catálogo: reasignar me gusta al id canónico
  await remapCloudLikes(userId, removeToKeep)

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

type CloudLikeRow = {
  local_id: string
  liked: boolean
  updated_at: string
  title?: string | null
  artist?: string | null
  duration?: number | null
  file_name?: string | null
}

/** Fusiona me gusta de ids duplicados al id que se conserva (LWW). */
async function remapCloudLikes(
  userId: string,
  removeToKeep: Map<string, string>,
): Promise<void> {
  if (!removeToKeep.size || !isCloudAuthEnabled()) return
  const supabase = getSupabase()
  const removeIds = [...removeToKeep.keys()]
  const keepIds = [...new Set(removeToKeep.values())]
  const allIds = [...new Set([...removeIds, ...keepIds])]

  const { data, error } = await supabase
    .from('library_likes')
    .select('local_id,liked,updated_at')
    .eq('user_id', userId)
    .in('local_id', allIds)
  if (error) {
    console.warn('Remap likes', error.message)
    return
  }
  const byId = new Map(
    ((data || []) as CloudLikeRow[]).map((r) => [r.local_id, r]),
  )

  for (const [removeId, keepId] of removeToKeep) {
    const removedLike = byId.get(removeId)
    if (!removedLike) continue
    const keepLike = byId.get(keepId)
    const removedTs = Date.parse(removedLike.updated_at) || 0
    const keepTs = keepLike ? Date.parse(keepLike.updated_at) || 0 : 0

    if (!keepLike || removedTs >= keepTs) {
      const { error: upErr } = await supabase.from('library_likes').upsert(
        {
          user_id: userId,
          local_id: keepId,
          liked: removedLike.liked,
          updated_at: removedLike.updated_at,
        },
        { onConflict: 'user_id,local_id' },
      )
      if (upErr) console.warn('Remap like upsert', upErr.message)
      else {
        byId.set(keepId, {
          local_id: keepId,
          liked: removedLike.liked,
          updated_at: removedLike.updated_at,
        })
      }
    }

    const { error: delErr } = await supabase
      .from('library_likes')
      .delete()
      .eq('user_id', userId)
      .eq('local_id', removeId)
    if (delErr) console.warn('Remap like delete', delErr.message)
    byId.delete(removeId)
  }
}

/** Id de catálogo canónico para una pista local (mismo contenido, distinto id). */
function pickCloudLocalIdForTrack(
  track: Track,
  cloud: Array<{
    local_id: string
    title: string
    artist: string
    duration: number
    file_name: string
  }>,
  localIds: Set<string>,
): string {
  const matches = cloud.filter((c) =>
    tracksLookSame(track, {
      title: c.title,
      artist: c.artist,
      duration: c.duration,
      fileName: c.file_name,
    }),
  )
  if (!matches.length) return track.id
  const self = matches.find((m) => m.local_id === track.id)
  if (self) return self.local_id
  const onThisDevice = matches.find((m) => localIds.has(m.local_id))
  if (onThisDevice) return onThisDevice.local_id
  return matches[0]!.local_id
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
function resolveLocalTrackId(
  preferredId: string,
  cloud: CloudTrackLite[],
  locals: Track[],
): string | null {
  if (locals.some((t) => t.id === preferredId)) return preferredId

  const meta = cloud.find((c) => c.local_id === preferredId)
  if (!meta) return null
  const match = locals.find((t) =>
    tracksLookSame(t, {
      title: meta.title,
      artist: meta.artist,
      duration: meta.duration,
      fileName: meta.file_name,
    }),
  )
  return match?.id ?? null
}

type CloudTrackLite = {
  local_id: string
  title: string
  artist: string
  duration: number
  file_name: string
}

async function fetchCloudTrackLite(userId: string): Promise<CloudTrackLite[]> {
  const { data, error } = await getSupabase()
    .from('library_tracks')
    .select('local_id,title,artist,duration,file_name')
    .eq('user_id', userId)
  if (error) throw new Error(error.message)
  return (data || []) as CloudTrackLite[]
}

/**
 * Reasigna me gusta huérfanos (id de otro dispositivo) al id canónico del catálogo / local.
 */
async function consolidateCloudLikes(userId: string): Promise<void> {
  if (!isCloudAuthEnabled()) return
  const supabase = getSupabase()
  const [{ data, error }, cloud, locals] = await Promise.all([
    supabase
      .from('library_likes')
      .select('local_id,liked,updated_at,title,artist,duration,file_name')
      .eq('user_id', userId),
    fetchCloudTrackLite(userId),
    db.tracks.toArray(),
  ])
  // Select con columnas nuevas puede fallar si no se ejecutó el ALTER
  let likes: CloudLikeRow[] = []
  if (error && /title|artist|file_name|duration|column|schema/i.test(error.message)) {
    const bare = await supabase
      .from('library_likes')
      .select('local_id,liked,updated_at')
      .eq('user_id', userId)
    if (bare.error) {
      console.warn('Consolidate likes', bare.error.message)
      return
    }
    likes = (bare.data || []) as CloudLikeRow[]
  } else if (error) {
    console.warn('Consolidate likes', error.message)
    return
  } else {
    likes = (data || []) as CloudLikeRow[]
  }
  if (!likes.length) return

  const localIds = new Set(locals.map((t) => t.id))
  const cloudById = new Map(cloud.map((c) => [c.local_id, c]))
  const removeToKeep = new Map<string, string>()

  for (const like of likes) {
    const meta = cloudById.get(like.local_id)
    const probe = meta
      ? {
          title: meta.title,
          artist: meta.artist,
          duration: meta.duration,
          fileName: meta.file_name,
        }
      : like.title || like.file_name
        ? {
            title: like.title || '',
            artist: like.artist || '',
            duration: Number(like.duration) || 0,
            fileName: like.file_name || '',
          }
        : null
    if (!probe) continue

    const localMatch = locals.find((t) => tracksLookSame(t, probe))
    if (!localMatch) continue
    const preferred = pickCloudLocalIdForTrack(localMatch, cloud, localIds)
    if (preferred && preferred !== like.local_id) {
      removeToKeep.set(like.local_id, preferred)
    }
  }

  if (removeToKeep.size) await remapCloudLikes(userId, removeToKeep)
}

/**
 * Sube me gusta al perfil (Supabase).
 * Usa el local_id canónico del catálogo (mismo contenido entre PC y móvil).
 * No pisa filas remotas más recientes (LWW).
 */
export async function pushLibraryLikes(
  userId: string,
  trackId?: string,
): Promise<number> {
  if (!isCloudAuthEnabled()) return 0
  const supabase = getSupabase()
  const allLocal = await db.tracks.toArray()
  const tracks = trackId
    ? allLocal.filter((t) => t.id === trackId)
    : allLocal
  const cloud = await fetchCloudTrackLite(userId)
  const localIds = new Set(allLocal.map((t) => t.id))

  const candidates: Array<{
    user_id: string
    local_id: string
    liked: boolean
    updated_at: string
    title: string
    artist: string
    duration: number
    file_name: string
    localTs: number
  }> = []
  const staleIds: string[] = []

  for (const t of tracks) {
    if (!(t.liked || typeof t.likedUpdatedAt === 'number')) continue
    const local_id = pickCloudLocalIdForTrack(t, cloud, localIds)
    if (local_id !== t.id) staleIds.push(t.id)
    const localTs = t.likedUpdatedAt || t.createdAt || Date.now()
    candidates.push({
      user_id: userId,
      local_id,
      liked: Boolean(t.liked),
      updated_at: new Date(localTs).toISOString(),
      title: t.title || '',
      artist: t.artist || '',
      duration: t.duration || 0,
      file_name: t.fileName || '',
      localTs,
    })
  }

  if (!candidates.length) return 0

  // No sobrescribir me gusta más nuevos hechos en otro dispositivo
  const remoteIds = [...new Set(candidates.map((c) => c.local_id))]
  const remoteById = new Map<string, number>()
  const chunkMeta = 80
  for (let i = 0; i < remoteIds.length; i += chunkMeta) {
    const slice = remoteIds.slice(i, i + chunkMeta)
    const { data, error } = await supabase
      .from('library_likes')
      .select('local_id,updated_at')
      .eq('user_id', userId)
      .in('local_id', slice)
    if (error) {
      console.warn('Push likes remote check', error.message)
      break
    }
    for (const row of (data || []) as { local_id: string; updated_at: string }[]) {
      remoteById.set(row.local_id, Date.parse(row.updated_at) || 0)
    }
  }

  const rows = candidates
    .filter((c) => c.localTs >= (remoteById.get(c.local_id) ?? 0))
    .map(({ localTs: _ts, ...row }) => row)

  if (!rows.length) return 0

  const chunk = 80
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk)
    let { error } = await supabase.from('library_likes').upsert(slice, {
      onConflict: 'user_id,local_id',
    })
    // Si aún no se ejecutó el ALTER de columnas de contenido, reintentar sin ellas
    if (error && /title|artist|file_name|duration|column|schema/i.test(error.message)) {
      const bare = slice.map(({ user_id, local_id, liked, updated_at }) => ({
        user_id,
        local_id,
        liked,
        updated_at,
      }))
      ;({ error } = await supabase.from('library_likes').upsert(bare, {
        onConflict: 'user_id,local_id',
      }))
    }
    if (error) throw new Error(error.message || 'Error al sincronizar me gusta')
  }

  // Quitar likes bajo el id del otro dispositivo si ya están en el canónico
  const kept = new Set(rows.map((r) => r.local_id))
  const toDelete = [...new Set(staleIds)].filter((id) => !kept.has(id))
  if (toDelete.length) {
    for (let i = 0; i < toDelete.length; i += chunk) {
      const slice = toDelete.slice(i, i + chunk)
      await supabase
        .from('library_likes')
        .delete()
        .eq('user_id', userId)
        .in('local_id', slice)
    }
  }

  return rows.length
}

/** Baja me gusta del perfil y aplica LWW sobre las pistas locales (por id o contenido). */
export async function pullLibraryLikes(userId: string): Promise<number> {
  if (!isCloudAuthEnabled()) return 0
  const supabase = getSupabase()
  let likes: CloudLikeRow[] = []
  const withMeta = await supabase
    .from('library_likes')
    .select('local_id,liked,updated_at,title,artist,duration,file_name')
    .eq('user_id', userId)
  if (withMeta.error && /title|artist|file_name|duration|column|schema/i.test(withMeta.error.message)) {
    const bare = await supabase
      .from('library_likes')
      .select('local_id,liked,updated_at')
      .eq('user_id', userId)
    if (bare.error) throw new Error(bare.error.message)
    likes = (bare.data || []) as CloudLikeRow[]
  } else if (withMeta.error) {
    throw new Error(withMeta.error.message)
  } else {
    likes = (withMeta.data || []) as CloudLikeRow[]
  }

  const cloud = await fetchCloudTrackLite(userId)
  if (!likes.length) return 0

  const locals = await db.tracks.toArray()
  const likesById = new Map(likes.map((r) => [r.local_id, r]))
  const cloudById = new Map(cloud.map((c) => [c.local_id, c]))

  let applied = 0

  for (const track of locals) {
    const candidateIds = new Set<string>([track.id])

    for (const ct of cloud) {
      if (
        tracksLookSame(track, {
          title: ct.title,
          artist: ct.artist,
          duration: ct.duration,
          fileName: ct.file_name,
        })
      ) {
        candidateIds.add(ct.local_id)
      }
    }

    for (const like of likes) {
      if (candidateIds.has(like.local_id)) continue
      const meta = cloudById.get(like.local_id)
      const probe = meta
        ? {
            title: meta.title,
            artist: meta.artist,
            duration: meta.duration,
            fileName: meta.file_name,
          }
        : like.title || like.file_name
          ? {
              title: like.title || '',
              artist: like.artist || '',
              duration: Number(like.duration) || 0,
              fileName: like.file_name || '',
            }
          : null
      if (!probe) continue
      if (tracksLookSame(track, probe)) candidateIds.add(like.local_id)
    }

    let best: CloudLikeRow | null = null
    let bestTs = -1
    for (const id of candidateIds) {
      const like = likesById.get(id)
      if (!like) continue
      const ts = Date.parse(like.updated_at) || 0
      if (ts >= bestTs) {
        best = like
        bestTs = ts
      }
    }
    if (!best) continue

    const remoteTs = Date.parse(best.updated_at) || 0
    const localTs = track.likedUpdatedAt || 0
    if (remoteTs < localTs) continue
    if (track.liked === best.liked && localTs >= remoteTs) continue

    await db.tracks.update(track.id, {
      liked: best.liked,
      likedUpdatedAt: remoteTs,
    })
    applied += 1
  }

  return applied
}

/** Sube playlists del perfil a Supabase (ids canónicos; no pisa listas más nuevas). */
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

  const [cloud, locals] = await Promise.all([
    fetchCloudTrackLite(userId),
    db.tracks.toArray(),
  ])
  const localIds = new Set(locals.map((t) => t.id))
  const trackById = new Map(locals.map((t) => [t.id, t]))

  const candidates = playlists.map((p) => {
    const track_ids = (p.trackIds || []).map((id) => {
      const track = trackById.get(id)
      if (!track) return id
      return pickCloudLocalIdForTrack(track, cloud, localIds)
    })
    const updatedAt = p.updatedAt || p.createdAt || Date.now()
    return {
      user_id: userId,
      local_id: p.id,
      name: p.name || '',
      description: p.description || '',
      track_ids,
      has_cover: Boolean(p.hasCover),
      created_at: new Date(p.createdAt || Date.now()).toISOString(),
      updated_at: new Date(updatedAt).toISOString(),
      localTs: updatedAt,
    }
  })

  const remoteIds = candidates.map((c) => c.local_id)
  const remoteById = new Map<string, number>()
  if (remoteIds.length) {
    const { data, error } = await supabase
      .from('library_playlists')
      .select('local_id,updated_at')
      .eq('user_id', userId)
      .in('local_id', remoteIds)
    if (error) {
      // Tabla ausente u otro error: dejar que el upsert falle con mensaje claro
      if (!/column|schema|relation|does not exist/i.test(error.message)) {
        console.warn('Push playlists remote check', error.message)
      }
    } else {
      for (const row of (data || []) as { local_id: string; updated_at: string }[]) {
        remoteById.set(row.local_id, Date.parse(row.updated_at) || 0)
      }
    }
  }

  const rows = candidates
    .filter((c) => c.localTs >= (remoteById.get(c.local_id) ?? 0))
    .map(({ localTs: _ts, ...row }) => row)

  if (!rows.length) return 0

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
  const [{ data, error }, cloud, locals] = await Promise.all([
    supabase
      .from('library_playlists')
      .select('local_id,name,description,track_ids,has_cover,created_at,updated_at')
      .eq('user_id', userId),
    fetchCloudTrackLite(userId),
    db.tracks.toArray(),
  ])
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
      const resolved = resolveLocalTrackId(id, cloud, locals)
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

/** Sync completo de me gusta + playlists (perfil). Baja primero, luego sube. */
export async function syncLibraryTaste(userId: string): Promise<{
  likesIn: number
  likesOut: number
  playlistsIn: number
  playlistsOut: number
}> {
  // Unifica likes de distintos local_id (PC vs móvil) antes de fusionar
  await consolidateCloudLikes(userId).catch((e) =>
    console.warn('Consolidate likes', e),
  )
  // IMPORTANTE: bajar antes de subir. Si se sube primero, un dispositivo viejo
  // pisa me gusta/listas más nuevos del otro (PC ↔ móvil).
  const likesIn = await pullLibraryLikes(userId)
  const playlistsIn = await pullLibraryPlaylists(userId)
  const likesOut = await pushLibraryLikes(userId)
  const playlistsOut = await pushLibraryPlaylists(userId)
  return { likesIn, likesOut, playlistsIn, playlistsOut }
}
