import { db } from '../db'
import {
  createId,
  getAudioDuration,
  isAudioFile,
  isMp3File,
  readTagsEnriched,
} from './fileImport'
import { enrichFromInternet, fetchCoverBlob, isDoubtfulMetadata, isLowQualityRelease, isWrongKnownArtist, refineGenre, coreSongTitle } from './enrich'
import type { OnlineTrackInfo } from './enrich'
import { deleteBinary, readBinary, writeBinary } from './opfs'
import type { Playlist, Track } from '../types'

export async function saveAudioBlob(id: string, blob: Blob): Promise<void> {
  const mode = await writeBinary('audio', id, blob)
  if (mode === 'fallback') {
    await db.audio.put({ id, blob })
  } else {
    await db.audio.delete(id)
  }
}

export async function saveCoverBlob(id: string, blob: Blob): Promise<void> {
  const mode = await writeBinary('covers', id, blob)
  if (mode === 'fallback') {
    await db.covers.put({ id, blob })
  } else {
    await db.covers.delete(id)
  }
}

export async function getAudioBlob(id: string): Promise<Blob | null> {
  const fromOpfs = await readBinary('audio', id)
  if (fromOpfs) return fromOpfs
  const record = await db.audio.get(id)
  return record?.blob ?? null
}

export async function getCoverBlob(id: string): Promise<Blob | null> {
  const fromOpfs = await readBinary('covers', id)
  if (fromOpfs) return fromOpfs
  const record = await db.covers.get(id)
  return record?.blob ?? null
}

const objectUrlCache = new Map<string, string>()

export async function getAudioObjectUrl(id: string): Promise<string | null> {
  const cached = objectUrlCache.get(`audio:${id}`)
  if (cached) return cached
  const blob = await getAudioBlob(id)
  if (!blob) return null
  const url = URL.createObjectURL(blob)
  objectUrlCache.set(`audio:${id}`, url)
  return url
}

export async function getCoverObjectUrl(id: string): Promise<string | null> {
  const cached = objectUrlCache.get(`cover:${id}`)
  if (cached) return cached
  const blob = await getCoverBlob(id)
  if (!blob) return null
  const url = URL.createObjectURL(blob)
  objectUrlCache.set(`cover:${id}`, url)
  return url
}

export function revokeCachedUrls(id: string): void {
  for (const key of [`audio:${id}`, `cover:${id}`]) {
    const url = objectUrlCache.get(key)
    if (url) {
      URL.revokeObjectURL(url)
      objectUrlCache.delete(key)
    }
  }
}

export async function importAudioFiles(
  files: File[],
  onProgress?: (done: number, total: number, name: string) => void,
  options?: { mp3Only?: boolean; enrich?: boolean },
): Promise<Track[]> {
  const audioFiles = options?.mp3Only ? files.filter(isMp3File) : files.filter(isAudioFile)
  const imported: Track[] = []

  for (let i = 0; i < audioFiles.length; i++) {
    const file = audioFiles[i]
    onProgress?.(i, audioFiles.length, file.name)

    const id = createId()
    const tags = await readTagsEnriched(file)
    const duration = await getAudioDuration(file)

    await saveAudioBlob(id, file)
    let hasCover = false
    if (tags.coverBlob) {
      await saveCoverBlob(id, tags.coverBlob)
      hasCover = true
    }

    const track: Track = {
      id,
      title: tags.title,
      artist: tags.artist,
      album: tags.album,
      genre: tags.genre,
      year: tags.year,
      duration,
      mimeType: file.type || 'audio/mpeg',
      fileName: file.name,
      hasCover,
      liked: false,
      playCount: 0,
      lastPlayedAt: null,
      createdAt: Date.now(),
      enriched: tags.enriched,
      externalUrl: tags.externalUrl,
    }

    await db.tracks.put(track)
    imported.push(track)
  }

  onProgress?.(audioFiles.length, audioFiles.length, '')
  return imported
}

export async function enrichTrackOnline(
  id: string,
  options?: { force?: boolean },
): Promise<{ track: Track; found: boolean; coverUpdated: boolean } | null> {
  const track = await db.tracks.get(id)
  if (!track) return null

  const doubtful = isDoubtfulMetadata(track)
  const junkLocal = isLowQualityRelease(track.artist, track.album, track.title)
  const knownWrong = isWrongKnownArtist(track.title, track.artist, track.album)
  const force = Boolean(options?.force) || doubtful || junkLocal || knownWrong
  const hintArtist = force ? '' : track.artist
  const searchTitle = track.title || track.fileName
  const core = coreSongTitle(searchTitle)
  const n = searchTitle.toLowerCase()

  let online: OnlineTrackInfo | null =
    (await enrichFromInternet(searchTitle, hintArtist)) ||
    (core ? await enrichFromInternet(core, '') : null) ||
    (track.fileName && track.fileName !== track.title
      ? await enrichFromInternet(track.fileName, '')
      : null)

  const stillBad =
    !online ||
    isLowQualityRelease(online.artist, online.album, online.title) ||
    isWrongKnownArtist(searchTitle, online.artist, online.album) ||
    (options?.force &&
      online &&
      normArtistAlbum(online) === normArtistAlbum(track))

  if (stillBad || options?.force) {
    const retries = [
      /waka/i.test(n) ? 'Shakira Waka Waka This Time for Africa' : '',
      /waka/i.test(n) ? 'Waka Waka Shakira' : '',
      /mundo ideal|whole new world/i.test(n)
        ? 'A Whole New World Aladdin original soundtrack'
        : '',
      /mundo ideal|whole new world/i.test(n) ? 'A Whole New World Brad Kane Lea Salonga' : '',
      /mundo ideal|aladdin/i.test(n) ? `${core} Aladdin Disney` : '',
      /bella|bestia|beauty/i.test(n)
        ? 'Beauty and the Beast original motion picture soundtrack'
        : '',
      /hakuna|ciclo de la vida|rey leon|lion king/i.test(n)
        ? `${core} The Lion King original soundtrack`
        : '',
      `${core} Disney original soundtrack`,
      `${core} original soundtrack`,
      searchTitle,
    ].filter(Boolean)

    for (const q of retries) {
      const alt = await enrichFromInternet(q, '')
      if (
        alt &&
        !isLowQualityRelease(alt.artist, alt.album, alt.title) &&
        !isWrongKnownArtist(searchTitle, alt.artist, alt.album)
      ) {
        online = alt
        break
      }
    }
  }

  if (!online) {
    return { track, found: false, coverUpdated: false }
  }

  if (
    !options?.force &&
    (isLowQualityRelease(online.artist, online.album, online.title) ||
      isWrongKnownArtist(searchTitle, online.artist, online.album))
  ) {
    return { track, found: false, coverUpdated: false }
  }

  // En modo force aceptamos el mejor resultado no basura
  if (
    options?.force &&
    isLowQualityRelease(online.artist, online.album, online.title)
  ) {
    return { track, found: false, coverUpdated: false }
  }

  let hasCover = track.hasCover
  let coverUpdated = false
  const coverCandidates = [
    online.coverUrl,
    online.coverUrl?.replace('/1000x1000-', '/500x500-'),
    online.coverUrl?.replace('/1000x1000-', '/250x250-'),
    online.coverUrl?.replace('600x600bb', '300x300bb'),
  ].filter(Boolean) as string[]

  for (const coverUrl of [...new Set(coverCandidates)]) {
    const blob = await fetchCoverBlob(coverUrl)
    if (blob) {
      revokeCachedUrls(id)
      objectUrlCache.delete(`cover:${id}`)
      await saveCoverBlob(id, blob)
      hasCover = true
      coverUpdated = true
      break
    }
  }

  const patch: Partial<Track> = {
    title: track.title,
    artist: online.artist,
    album: online.album,
    genre: refineGenre({
      title: track.title,
      artist: online.artist,
      album: online.album,
      genre: online.genre || track.genre,
      fileName: track.fileName,
    }),
    year: online.year || track.year,
    hasCover,
    enriched: true,
    externalUrl: `${online.externalUrl || 'myvibe'}:e${Date.now()}`,
  }
  await db.tracks.update(id, patch)
  return { track: { ...track, ...patch }, found: true, coverUpdated }
}

function normArtistAlbum(t: { artist: string; album: string }): string {
  return `${t.artist}|${t.album}`.toLowerCase()
}

export async function enrichTracksMissingCover(
  onProgress?: (done: number, total: number, name: string) => void,
): Promise<{ ok: number; fail: number }> {
  const tracks = await db.tracks
    .filter((t) => isDoubtfulMetadata(t))
    .toArray()
  let ok = 0
  let fail = 0
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i]
    onProgress?.(i, tracks.length, t.title)
    const result = await enrichTrackOnline(t.id)
    if (result?.found) ok++
    else fail++
  }
  onProgress?.(tracks.length, tracks.length, '')
  return { ok, fail }
}

export async function deleteTrack(id: string): Promise<void> {
  revokeCachedUrls(id)
  await deleteBinary('audio', id)
  await deleteBinary('covers', id)
  await db.audio.delete(id)
  await db.covers.delete(id)
  await db.tracks.delete(id)

  const playlists = await db.playlists.toArray()
  await Promise.all(
    playlists.map((p) => {
      if (!p.trackIds.includes(id)) return Promise.resolve()
      return db.playlists.update(p.id, {
        trackIds: p.trackIds.filter((t) => t !== id),
        updatedAt: Date.now(),
      })
    }),
  )
}

export async function updateTrackMeta(
  id: string,
  patch: Partial<Pick<Track, 'title' | 'artist' | 'album' | 'genre' | 'year' | 'liked'>>,
): Promise<void> {
  await db.tracks.update(id, patch)
}

export async function setTrackCover(id: string, file: File): Promise<void> {
  revokeCachedUrls(id)
  objectUrlCache.delete(`cover:${id}`)
  await saveCoverBlob(id, file)
  await db.tracks.update(id, { hasCover: true })
}

export async function toggleLike(id: string): Promise<boolean> {
  const track = await db.tracks.get(id)
  if (!track) return false
  const liked = !track.liked
  await db.tracks.update(id, { liked })
  return liked
}

export async function setTracksLiked(ids: string[], liked: boolean): Promise<void> {
  await Promise.all(ids.map((id) => db.tracks.update(id, { liked })))
}

export async function deleteTracks(ids: string[]): Promise<void> {
  for (const id of ids) {
    await deleteTrack(id)
  }
}

export async function enrichTracksByIds(
  ids: string[],
  onProgress?: (done: number, total: number, name: string) => void,
): Promise<{ ok: number; fail: number }> {
  let ok = 0
  let fail = 0
  for (let i = 0; i < ids.length; i++) {
    const track = await db.tracks.get(ids[i])
    onProgress?.(i, ids.length, track?.title ?? '')
    const result = await enrichTrackOnline(ids[i])
    if (result?.found) ok++
    else fail++
  }
  onProgress?.(ids.length, ids.length, '')
  return { ok, fail }
}

export async function createPlaylist(name: string): Promise<Playlist> {
  const playlist: Playlist = {
    id: createId(),
    name: name.trim() || 'Nueva playlist',
    description: '',
    trackIds: [],
    hasCover: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  await db.playlists.put(playlist)
  return playlist
}

export async function renamePlaylist(id: string, name: string): Promise<void> {
  await db.playlists.update(id, { name: name.trim(), updatedAt: Date.now() })
}

export async function updatePlaylistInfo(
  id: string,
  patch: Partial<Pick<Playlist, 'name' | 'description'>>,
): Promise<void> {
  await db.playlists.update(id, { ...patch, updatedAt: Date.now() })
}

export function playlistCoverId(playlistId: string): string {
  return `playlist:${playlistId}`
}

export async function setPlaylistCover(playlistId: string, file: File): Promise<void> {
  const id = playlistCoverId(playlistId)
  revokeCachedUrls(id)
  objectUrlCache.delete(`cover:${id}`)
  await saveCoverBlob(id, file)
  await db.playlists.update(playlistId, { hasCover: true, updatedAt: Date.now() })
}

export async function clearPlaylistCover(playlistId: string): Promise<void> {
  const id = playlistCoverId(playlistId)
  revokeCachedUrls(id)
  await deleteBinary('covers', id)
  await db.covers.delete(id)
  await db.playlists.update(playlistId, { hasCover: false, updatedAt: Date.now() })
}

export async function deletePlaylist(id: string): Promise<void> {
  await db.playlists.delete(id)
}

export async function addTracksToPlaylist(
  playlistId: string,
  trackIds: string[],
): Promise<void> {
  const playlist = await db.playlists.get(playlistId)
  if (!playlist) return
  const set = new Set(playlist.trackIds)
  for (const id of trackIds) set.add(id)
  await db.playlists.update(playlistId, {
    trackIds: [...set],
    updatedAt: Date.now(),
  })
}

export async function removeTrackFromPlaylist(
  playlistId: string,
  trackId: string,
): Promise<void> {
  const playlist = await db.playlists.get(playlistId)
  if (!playlist) return
  await db.playlists.update(playlistId, {
    trackIds: playlist.trackIds.filter((id) => id !== trackId),
    updatedAt: Date.now(),
  })
}

export async function reorderPlaylistTracks(
  playlistId: string,
  trackIds: string[],
): Promise<void> {
  await db.playlists.update(playlistId, {
    trackIds,
    updatedAt: Date.now(),
  })
}

export async function recordPlay(trackId: string): Promise<void> {
  const track = await db.tracks.get(trackId)
  if (!track) return
  await db.tracks.update(trackId, {
    playCount: track.playCount + 1,
    lastPlayedAt: Date.now(),
  })
}
