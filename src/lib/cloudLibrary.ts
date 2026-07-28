import { db } from '../db'
import type { Track } from '../types'
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
