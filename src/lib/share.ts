import { db } from '../db'
import type { Playlist, Track } from '../types'
import { createId } from './fileImport'
import {
  addTracksToPlaylist,
  createPlaylist,
  getAudioBlob,
  getCoverBlob,
  saveAudioBlob,
  saveCoverBlob,
  updatePlaylistInfo,
} from './library'

const SHARE_VERSION = 1 as const
export const MYVIBE_EXT = '.myvibe'
export const MYVIBE_MIME = 'application/x-myvibe+json'

export interface SharedTrackPayload {
  title: string
  artist: string
  album: string
  genre: string
  year: string
  duration: number
  mimeType: string
  fileName: string
  audioBase64: string
  coverBase64: string | null
  externalUrl?: string
  liked?: boolean
}

export interface SharedPlaylistPayload {
  name: string
  description: string
  /** Índices en `tracks` del paquete */
  trackIndices: number[]
}

export interface MyVibeSharePackage {
  v: typeof SHARE_VERSION
  kind: 'track' | 'playlist' | 'library'
  exportedAt: number
  from?: string
  playlist?: { name: string; description: string }
  /** Solo kind === 'library': playlists con referencias a tracks */
  playlists?: SharedPlaylistPayload[]
  tracks: SharedTrackPayload[]
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result || '')
      const i = result.indexOf(',')
      resolve(i >= 0 ? result.slice(i + 1) : result)
    }
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsDataURL(blob)
  })
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mimeType || 'application/octet-stream' })
}

function safeFileName(name: string): string {
  return (name.replace(/[^\w\- áéíóúüñÁÉÍÓÚÜÑ]+/gi, '').trim() || 'myvibe').slice(
    0,
    80,
  )
}

async function packTrack(track: Track): Promise<SharedTrackPayload | null> {
  const audio = await getAudioBlob(track.id)
  if (!audio) return null
  const cover = track.hasCover ? await getCoverBlob(track.id) : null
  return {
    title: track.title,
    artist: track.artist,
    album: track.album,
    genre: track.genre,
    year: track.year,
    duration: track.duration,
    mimeType: track.mimeType || audio.type || 'audio/mpeg',
    fileName: track.fileName || `${track.title}.mp3`,
    audioBase64: await blobToBase64(audio),
    coverBase64: cover ? await blobToBase64(cover) : null,
    externalUrl: track.externalUrl,
    liked: track.liked,
  }
}

export async function buildTrackSharePackage(
  trackId: string,
  from?: string,
): Promise<MyVibeSharePackage> {
  const track = await db.tracks.get(trackId)
  if (!track) throw new Error('Canción no encontrada')
  const packed = await packTrack(track)
  if (!packed) throw new Error('No hay archivo de audio para compartir')
  return {
    v: SHARE_VERSION,
    kind: 'track',
    exportedAt: Date.now(),
    from,
    tracks: [packed],
  }
}

export async function buildPlaylistSharePackage(
  playlistId: string,
  from?: string,
  onProgress?: (done: number, total: number, name: string) => void,
): Promise<MyVibeSharePackage> {
  const playlist = await db.playlists.get(playlistId)
  if (!playlist) throw new Error('Playlist no encontrada')
  const tracks: SharedTrackPayload[] = []
  const total = playlist.trackIds.length
  for (let i = 0; i < playlist.trackIds.length; i++) {
    const id = playlist.trackIds[i]
    const track = await db.tracks.get(id)
    onProgress?.(i, total, track?.title || '')
    if (!track) continue
    const packed = await packTrack(track)
    if (packed) tracks.push(packed)
  }
  onProgress?.(total, total, '')
  if (!tracks.length) throw new Error('La playlist no tiene canciones con audio')
  return {
    v: SHARE_VERSION,
    kind: 'playlist',
    exportedAt: Date.now(),
    from,
    playlist: {
      name: playlist.name,
      description: playlist.description || '',
    },
    tracks,
  }
}

export async function buildLikedSharePackage(
  tracks: Track[],
  from?: string,
  onProgress?: (done: number, total: number, name: string) => void,
): Promise<MyVibeSharePackage> {
  const packed: SharedTrackPayload[] = []
  for (let i = 0; i < tracks.length; i++) {
    onProgress?.(i, tracks.length, tracks[i].title)
    const item = await packTrack(tracks[i])
    if (item) packed.push(item)
  }
  onProgress?.(tracks.length, tracks.length, '')
  if (!packed.length) throw new Error('No hay canciones con audio para compartir')
  return {
    v: SHARE_VERSION,
    kind: 'playlist',
    exportedAt: Date.now(),
    from,
    playlist: {
      name: 'Canciones que te gustan',
      description: 'Compartido desde Me gusta',
    },
    tracks: packed,
  }
}

/** Toda la biblioteca local: canciones, me gusta y playlists */
export async function buildLibrarySharePackage(
  from?: string,
  onProgress?: (done: number, total: number, name: string) => void,
): Promise<MyVibeSharePackage> {
  const allTracks = await db.tracks.toArray()
  const allPlaylists = await db.playlists.orderBy('updatedAt').reverse().toArray()
  if (!allTracks.length) throw new Error('No hay canciones en la biblioteca')

  const idToIndex = new Map<string, number>()
  const packed: SharedTrackPayload[] = []
  for (let i = 0; i < allTracks.length; i++) {
    const track = allTracks[i]
    onProgress?.(i, allTracks.length, track.title)
    const item = await packTrack(track)
    if (!item) continue
    idToIndex.set(track.id, packed.length)
    packed.push(item)
  }
  onProgress?.(allTracks.length, allTracks.length, '')
  if (!packed.length) throw new Error('No hay canciones con audio para transferir')

  const playlists: SharedPlaylistPayload[] = []
  for (const pl of allPlaylists) {
    const trackIndices = pl.trackIds
      .map((id) => idToIndex.get(id))
      .filter((idx): idx is number => idx !== undefined)
    if (!trackIndices.length) continue
    playlists.push({
      name: pl.name,
      description: pl.description || '',
      trackIndices,
    })
  }

  return {
    v: SHARE_VERSION,
    kind: 'library',
    exportedAt: Date.now(),
    from,
    playlists,
    tracks: packed,
  }
}

function safeZipEntryName(name: string, ext: string): string {
  const base = (name.replace(/[<>:"/\\|?*\x00-\x1f]+/g, '').trim() || 'cancion').slice(0, 80)
  const cleanExt = ext.startsWith('.') ? ext : `.${ext}`
  return `${base}${cleanExt}`
}

function extFromMime(mime: string, fileName: string): string {
  const fromName = fileName.match(/\.[a-z0-9]+$/i)?.[0]
  if (fromName) return fromName.toLowerCase()
  if (mime.includes('wav')) return '.wav'
  if (mime.includes('ogg')) return '.ogg'
  if (mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac')) return '.m4a'
  return '.mp3'
}

/**
 * Descarga la biblioteca como ZIP de MP3 + cuenta (para el móvil).
 * En el móvil: Subir → Importar ZIP (sin descomprimir).
 */
export async function downloadLibraryZip(
  userId?: string,
  onProgress?: (done: number, total: number, name: string) => void,
): Promise<'downloaded'> {
  const allTracks = await db.tracks.toArray()
  if (!allTracks.length) throw new Error('No hay canciones en la biblioteca')

  const { buildZipBlob } = await import('./zip')
  const entries: { name: string; data: Uint8Array }[] = []
  const usedNames = new Map<string, number>()

  if (userId) {
    onProgress?.(0, Math.max(allTracks.length, 1), 'Incluyendo cuenta…')
    const { accountZipEntries } = await import('./accountTransfer')
    const accountEntries = await accountZipEntries(userId)
    entries.push(...accountEntries)
  }

  for (let i = 0; i < allTracks.length; i++) {
    const track = allTracks[i]
    onProgress?.(i, allTracks.length, track.title)
    const audio = await getAudioBlob(track.id)
    if (!audio) continue
    const buf = new Uint8Array(await audio.arrayBuffer())
    const ext = extFromMime(track.mimeType || audio.type, track.fileName || '')
    const label = `${track.artist || 'Artista'} - ${track.title || 'Canción'}`
    let name = safeZipEntryName(label, ext)
    const count = usedNames.get(name) ?? 0
    usedNames.set(name, count + 1)
    if (count > 0) {
      name = safeZipEntryName(`${label} (${count + 1})`, ext)
    }
    entries.push({ name: `canciones/${name}`, data: buf })
  }
  onProgress?.(allTracks.length, allTracks.length, 'Creando ZIP…')

  if (!entries.length) throw new Error('No hay canciones con audio para descargar')

  const zipBlob = buildZipBlob(entries)
  const file = new File([zipBlob], `mi-biblioteca-myvibe.zip`, {
    type: 'application/zip',
  })
  downloadFile(file)
  return 'downloaded'
}

export function packageToFile(pack: MyVibeSharePackage): File {
  const label =
    pack.kind === 'library'
      ? 'mi-biblioteca-myvibe'
      : pack.kind === 'playlist'
        ? pack.playlist?.name || 'playlist'
        : pack.tracks[0]?.title || 'cancion'
  const json = JSON.stringify(pack)
  return new File([json], `${safeFileName(label)}${MYVIBE_EXT}`, {
    type: MYVIBE_MIME,
  })
}

function downloadFile(file: File): void {
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = file.name
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revocar demasiado pronto cancela la descarga en Chrome
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** Comparte por Web Share si se puede; si no, descarga el .myvibe */
export async function sharePackageFile(
  file: File,
  title: string,
  options?: { preferDownload?: boolean },
): Promise<'shared' | 'downloaded'> {
  const preferDownload = options?.preferDownload ?? file.size > 4 * 1024 * 1024
  if (!preferDownload) {
    const data: ShareData = {
      files: [file],
      title: `MyVibe · ${title}`,
      text: 'Abre este archivo en MyVibe (Subir → Importar MyVibe) para añadirlo a tu biblioteca.',
    }
    try {
      if (typeof navigator !== 'undefined' && navigator.canShare?.({ files: [file] })) {
        await navigator.share(data)
        return 'shared'
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e
      // fallback download
    }
  }
  downloadFile(file)
  return 'downloaded'
}

export function isMyVibeShareFile(file: File): boolean {
  return file.name.toLowerCase().endsWith(MYVIBE_EXT)
}

export function parseSharePackage(raw: unknown): MyVibeSharePackage {
  if (!raw || typeof raw !== 'object') throw new Error('Archivo MyVibe inválido')
  const data = raw as Partial<MyVibeSharePackage>
  if (data.v !== SHARE_VERSION) throw new Error('Versión de archivo MyVibe no soportada')
  if (data.kind !== 'track' && data.kind !== 'playlist' && data.kind !== 'library') {
    throw new Error('Tipo de paquete desconocido')
  }
  if (!Array.isArray(data.tracks) || !data.tracks.length) {
    throw new Error('El archivo no contiene canciones')
  }
  for (const t of data.tracks) {
    if (!t?.audioBase64 || !t.title) throw new Error('Canción incompleta en el archivo')
  }
  return data as MyVibeSharePackage
}

export async function importSharePackage(
  file: File,
  onProgress?: (done: number, total: number, name: string) => void,
): Promise<{ trackIds: string[]; playlist: Playlist | null; playlistCount: number }> {
  const text = await file.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('No se pudo leer el archivo .myvibe')
  }
  const pack = parseSharePackage(parsed)
  const trackIds: string[] = []
  const total = pack.tracks.length

  for (let i = 0; i < pack.tracks.length; i++) {
    const item = pack.tracks[i]
    onProgress?.(i, total, item.title)
    const id = createId()
    const audio = base64ToBlob(item.audioBase64, item.mimeType || 'audio/mpeg')
    await saveAudioBlob(id, audio)

    let hasCover = false
    if (item.coverBase64) {
      const cover = base64ToBlob(item.coverBase64, 'image/jpeg')
      await saveCoverBlob(id, cover)
      hasCover = true
    }

    const track: Track = {
      id,
      title: item.title,
      artist: item.artist || 'Artista desconocido',
      album: item.album || 'Sin álbum',
      genre: item.genre || '',
      year: item.year || '',
      duration: item.duration || 0,
      mimeType: item.mimeType || 'audio/mpeg',
      fileName: item.fileName || `${item.title}.mp3`,
      hasCover,
      liked: Boolean(item.liked),
      playCount: 0,
      lastPlayedAt: null,
      createdAt: Date.now(),
      enriched: true,
      externalUrl: item.externalUrl,
    }
    await db.tracks.put(track)
    trackIds.push(id)
  }

  onProgress?.(total, total, '')

  let playlist: Playlist | null = null
  let playlistCount = 0

  if (pack.kind === 'playlist') {
    playlist = await createPlaylist(pack.playlist?.name || 'Playlist compartida')
    if (pack.playlist?.description) {
      await updatePlaylistInfo(playlist.id, {
        name: playlist.name,
        description: pack.playlist.description,
      })
    }
    await addTracksToPlaylist(playlist.id, trackIds)
    playlist = (await db.playlists.get(playlist.id)) ?? playlist
    playlistCount = 1
  } else if (pack.kind === 'library') {
    for (const pl of pack.playlists || []) {
      const ids = pl.trackIndices
        .filter((idx) => idx >= 0 && idx < trackIds.length)
        .map((idx) => trackIds[idx])
      if (!ids.length) continue
      let created = await createPlaylist(pl.name || 'Playlist')
      if (pl.description) {
        await updatePlaylistInfo(created.id, {
          name: created.name,
          description: pl.description,
        })
      }
      await addTracksToPlaylist(created.id, ids)
      created = (await db.playlists.get(created.id)) ?? created
      if (!playlist) playlist = created
      playlistCount += 1
    }
  }

  return { trackIds, playlist, playlistCount }
}
