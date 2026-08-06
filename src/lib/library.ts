import { db } from '../db'
import {
  createId,
  getAudioDuration,
  guessAudioMime,
  isAudioFile,
  isMp3File,
  materializeAudioFile,
  readTags,
} from './fileImport'
import { enrichFromInternet, fetchCoverBlob, isDoubtfulMetadata, isDisneyOrAnimeSearchContext, isLowQualityRelease, isWrongKnownArtist, refineGenre, coreSongTitle, titlesCompatible, artistsCompatible, knownTrackQueries } from './enrich'
import type { OnlineTrackInfo } from './enrich'
import { isAppleMobile } from './folderImport'
import { deleteBinary, readBinary, writeBinary, clearOpfsFolder, listOpfsIds } from './opfs'
import { groupDuplicateTracks, pickCanonicalTrack, tracksLookSame, findBestTrackMatch } from './trackDedupe'
import { pickDefaultThemeColor } from './playlistThemes'
import type { Playlist, Track } from '../types'

function pickBestBlob(...blobs: Array<Blob | null | undefined>): Blob | null {
  const valid = blobs.filter((b): b is Blob => Boolean(b && b.size > 0))
  if (!valid.length) return null
  // Preferir la copia más grande: en iOS OPFS a veces deja audio truncado
  // mientras IndexedDB tiene el archivo completo.
  valid.sort((a, b) => b.size - a.size)
  return valid[0] ?? null
}

/** Safari falla a decodificar blobs OPFS/File con type vacío. */
export function ensureAudioMime(blob: Blob, mimeHint?: string): Blob {
  const type = (blob.type || mimeHint || 'audio/mpeg').trim() || 'audio/mpeg'
  if (blob.type === type) return blob
  return blob.slice(0, blob.size, type)
}

export async function saveAudioBlob(id: string, blob: Blob): Promise<void> {
  // Copia independiente: evita que Share/File detache el buffer
  const safe = blob.slice(0, blob.size, blob.type || 'audio/mpeg')
  revokeCachedUrls(id)
  objectUrlCache.delete(`audio:${id}`)
  // En iPhone/iPad OPFS es poco fiable con MP3 grandes: la carátula sí,
  // el audio a veces queda truncado y luego tapa la copia buena de IDB.
  if (!isAppleMobile()) {
    await writeBinary('audio', id, safe)
  } else {
    await deleteBinary('audio', id).catch(() => undefined)
  }
  await db.audio.put({ id, blob: safe })
  // Sincronizar tamaño en metadatos si la pista ya existe
  try {
    const row = await db.tracks.get(id)
    if (row) {
      await db.tracks.update(id, { audioBytes: safe.size })
    }
  } catch {
    // ignore
  }
}

/** Marca el audio local como fresco (tras importar / reemplazar / descargar). */
export async function markLocalAudioFresh(
  id: string,
  at: number = Date.now(),
  bytes?: number,
): Promise<void> {
  const patch: Partial<Track> = {
    hasLocalAudio: true,
    audioUpdatedAt: at,
    needsAudioUpdate: false,
    cloudAudioSeenAt: at,
  }
  if (typeof bytes === 'number' && bytes > 0) patch.audioBytes = bytes
  await db.tracks.update(id, patch)
}

export async function saveCoverBlob(id: string, blob: Blob): Promise<void> {
  const safe = blob.slice(0, blob.size, blob.type || 'image/jpeg')
  revokeCachedUrls(id)
  objectUrlCache.delete(`cover:${id}`)
  await writeBinary('covers', id, safe)
  await db.covers.put({ id, blob: safe })
  try {
    const { clearMediaArtworkCache } = await import('./mediaSession')
    clearMediaArtworkCache(id)
  } catch {
    // ignore
  }
}

export async function getAudioBlob(id: string): Promise<Blob | null> {
  const record = await db.audio.get(id)
  const fromIdb = record?.blob ?? null
  if (isAppleMobile()) {
    // En Apple priorizar IndexedDB; OPFS solo si IDB no tiene nada usable
    if (fromIdb && fromIdb.size > 0) return fromIdb
    return pickBestBlob(await readBinary('audio', id))
  }
  const fromOpfs = await readBinary('audio', id)
  return pickBestBlob(fromIdb, fromOpfs)
}

export async function getCoverBlob(id: string): Promise<Blob | null> {
  const record = await db.covers.get(id)
  const fromIdb = record?.blob ?? null
  const fromOpfs = await readBinary('covers', id)
  return pickBestBlob(fromIdb, fromOpfs)
}

const objectUrlCache = new Map<string, string>()
/** IDs pendientes de revoke — solo en primer plano y fuera de uso. */
const pendingAudioRevoke = new Set<string>()
/** IDs cuya URL no debe revocarse (cola caliente del reproductor). */
const protectedAudioIds = new Set<string>()

export function protectAudioUrls(ids: Array<string | null | undefined>) {
  protectedAudioIds.clear()
  for (const id of ids) {
    if (id) protectedAudioIds.add(id)
  }
  flushPendingAudioRevokes()
}

export function scheduleRevokeAudioUrl(id: string) {
  if (!id) return
  pendingAudioRevoke.add(id)
  flushPendingAudioRevokes()
}

function isDocumentVisible(): boolean {
  try {
    return typeof document === 'undefined' || document.visibilityState === 'visible'
  } catch {
    return true
  }
}

/** Revoca blob: URLs solo en foreground y si el id ya no está protegido. */
export function flushPendingAudioRevokes() {
  if (!isDocumentVisible()) return
  for (const id of [...pendingAudioRevoke]) {
    if (protectedAudioIds.has(id)) continue
    revokeCachedUrls(id)
    pendingAudioRevoke.delete(id)
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') flushPendingAudioRevokes()
  })
}

export async function getAudioObjectUrl(id: string): Promise<string | null> {
  const cached = objectUrlCache.get(`audio:${id}`)
  if (cached) return cached
  const blob = await getAudioBlob(id)
  if (!blob) return null
  let mimeHint = blob.type
  if (!mimeHint) {
    try {
      const track = await db.tracks.get(id)
      mimeHint =
        track?.mimeType ||
        (track?.fileName ? guessAudioMime(track.fileName) : '') ||
        'audio/mpeg'
    } catch {
      mimeHint = 'audio/mpeg'
    }
  }
  const playable = ensureAudioMime(blob, mimeHint)
  // Blob URL en memoria — sin rutas sintéticas del Service Worker
  const url = URL.createObjectURL(playable)
  objectUrlCache.set(`audio:${id}`, url)
  return url
}

/** Cache hit síncrono (nexttrack/previoustrack en bloqueo — sin IndexedDB). */
export function peekAudioObjectUrl(id: string): string | null {
  return objectUrlCache.get(`audio:${id}`) ?? null
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
      if (url.startsWith('blob:')) {
        try {
          URL.revokeObjectURL(url)
        } catch {
          /* ignore */
        }
      }
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
  const errors: string[] = []
  const existingTracks = await db.tracks.toArray()
  const shouldEnrich = options?.enrich !== false

  // 1) Carga primero: audio + tags locales (rápido, la canción ya aparece)
  for (let i = 0; i < audioFiles.length; i++) {
    const original = audioFiles[i]!
    onProgress?.(i, audioFiles.length, original.name)

    try {
      // iPhone/iCloud: hay que leer el archivo entero antes de usarlo
      const file = await materializeAudioFile(original)
      const tags = await readTags(file)
      const duration = await getAudioDuration(file)

      const candidate = {
        title: tags.title,
        artist: tags.artist,
        duration,
        fileName: file.name,
      }
      const dup = existingTracks.find((t) => tracksLookSame(t, candidate))
      const id = dup?.id ?? createId()

      await saveAudioBlob(id, file)
      let hasCover = Boolean(dup?.hasCover)
      if (tags.coverBlob) {
        try {
          await saveCoverBlob(id, tags.coverBlob)
          hasCover = true
        } catch {
          // portada opcional
        }
      }

      const now = Date.now()
      const track: Track = {
        id,
        title: tags.title || dup?.title || file.name,
        artist: tags.artist || dup?.artist || 'Artista desconocido',
        album: tags.album || dup?.album || 'Sin álbum',
        genre: tags.genre || dup?.genre || '',
        year: tags.year || dup?.year || '',
        duration,
        mimeType: file.type || dup?.mimeType || 'audio/mpeg',
        fileName: file.name,
        hasCover,
        liked: dup?.liked ?? false,
        playCount: dup?.playCount ?? 0,
        lastPlayedAt: dup?.lastPlayedAt ?? null,
        createdAt: dup?.createdAt ?? now,
        enriched: Boolean(dup?.enriched),
        externalUrl: dup?.externalUrl,
        hasLocalAudio: true,
        origin: dup?.origin === 'cloud' ? 'cloud' : 'local',
        audioUpdatedAt: now,
        needsAudioUpdate: false,
        cloudAudioSeenAt: now,
        audioBytes: file.size,
      }

      await db.tracks.put(track)
      const idx = existingTracks.findIndex((t) => t.id === id)
      if (idx >= 0) existingTracks[idx] = track
      else existingTracks.push(track)
      imported.push(track)
    } catch (e) {
      const reason = e instanceof Error ? e.message : 'error'
      errors.push(`${original.name}: ${reason}`)
      // Quota / memoria: paramos para no perder más
      if (/quota|memory|allocation|NotReadableError|NotFoundError/i.test(reason)) {
        break
      }
    }

    if (i % 2 === 0) await new Promise((r) => setTimeout(r, 0))
  }

  onProgress?.(audioFiles.length, audioFiles.length, '')

  if (!imported.length && errors.length) {
    throw new Error(
      errors.length === 1
        ? errors[0]
        : `No se pudo importar. Ejemplos: ${errors.slice(0, 2).join(' · ')}`,
    )
  }

  // 2) Después: carátula + metadatos online (actualiza cada pista ya cargada)
  if (shouldEnrich && imported.length) {
    for (let i = 0; i < imported.length; i++) {
      const t = imported[i]!
      onProgress?.(i, imported.length, `${t.title} · carátula y datos…`)
      try {
        const result = await enrichTrackOnline(t.id)
        if (result?.track) imported[i] = result.track
      } catch {
        // la canción ya está; el enrich es best-effort
      }
    }
    onProgress?.(imported.length, imported.length, '')
  }

  return imported
}

function isGenericArtist(artist: string): boolean {
  return (
    !artist.trim() ||
    /^(artista desconocido|unknown artist|unknown|desconocido|various artists|varios artistas|varios|various)$/i.test(
      artist.trim(),
    )
  )
}

function isGenericAlbum(album: string): boolean {
  return !album.trim() || /^(sin álbum|sin album|unknown album|unknown|n\/a)$/i.test(album.trim())
}

function hasOstContext(text: string): boolean {
  return isDisneyOrAnimeSearchContext(text)
}

export async function enrichTrackOnline(
  id: string,
  options?: { force?: boolean },
): Promise<{ track: Track; found: boolean; coverUpdated: boolean } | null> {
  const track = await db.tracks.get(id)
  if (!track) return null

  const junkLocal = isLowQualityRelease(track.artist, track.album, track.title)
  const knownWrong = isWrongKnownArtist(track.title, track.artist, track.album)
  const artistGeneric = isGenericArtist(track.artist)
  const albumGeneric = isGenericAlbum(track.album)
  const force = Boolean(options?.force)
  // Solo reescribir artista/álbum con fuerza explícita o basura clara
  const allowRewriteMeta = force || junkLocal || knownWrong

  const hintArtist =
    junkLocal || knownWrong || artistGeneric ? '' : track.artist
  const searchTitle = track.title || track.fileName
  const core = coreSongTitle(searchTitle)
  const n = `${searchTitle} ${track.fileName} ${track.album} ${track.artist}`.toLowerCase()
  const ostCtx = hasOstContext(n)
  // Álbum/archivo dan contexto Disney (p. ej. Mulán) cuando no hay artista
  const fromFile = (track.fileName || '').replace(/\.[^.]+$/, '')
  const extraCtx = [track.album, fromFile]
    .filter((x) => x && !isGenericAlbum(x))
    .join(' ')

  let online: OnlineTrackInfo | null =
    (await enrichFromInternet(searchTitle, hintArtist, extraCtx)) ||
    (hintArtist
      ? await enrichFromInternet(`${hintArtist} ${core || searchTitle}`, '', extraCtx)
      : null) ||
    (core && core !== searchTitle
      ? await enrichFromInternet(core, hintArtist, extraCtx)
      : null)

  const score = online?.matchScore ?? 0
  const titleOk = online ? titlesCompatible(searchTitle, online.title) : false
  const artistOk =
    !hintArtist || !online || artistsCompatible(hintArtist, online.artist)

  const stillBad =
    !online ||
    !titleOk ||
    isLowQualityRelease(online.artist, online.album, online.title) ||
    isWrongKnownArtist(searchTitle, online.artist, online.album) ||
    (force && online && normArtistAlbum(online) === normArtistAlbum(track))

  if ((stillBad || force) && ostCtx) {
    const retries = [
      /waka waka/i.test(n) ? 'Shakira Waka Waka This Time for Africa' : '',
      /\bun mundo ideal\b|\ba whole new world\b/i.test(n)
        ? 'A Whole New World Aladdin original soundtrack'
        : '',
      /\bbella\b.*\bbestia\b|\bbeauty and the beast\b/i.test(n)
        ? 'Beauty and the Beast original motion picture soundtrack'
        : '',
      /\bhakuna matata\b|\bciclo de la vida\b|\brey leon\b|\blion king\b/i.test(n)
        ? `${core} The Lion King original soundtrack`
        : '',
      /\breflejo\b|\breflection\b|\bmulan\b/i.test(n)
        ? 'Reflejo Lucero Mulán Disney'
        : '',
      /\breflejo\b|\bmulan\b/i.test(n) ? 'Reflejo Lucero Mulan banda sonora' : '',
      /\blibre soy\b|\bfrozen\b/i.test(n) ? 'Libre Soy Martina Stoessel Frozen Disney' : '',
      ostCtx && core ? `${core} ${track.album || ''} Disney banda sonora`.trim() : '',
    ].filter(Boolean)

    for (const q of retries) {
      const alt = await enrichFromInternet(q, '', extraCtx || track.album)
      if (
        alt &&
        titlesCompatible(searchTitle, alt.title) &&
        !isLowQualityRelease(alt.artist, alt.album, alt.title) &&
        !isWrongKnownArtist(searchTitle, alt.artist, alt.album || track.album)
      ) {
        online = alt
        break
      }
    }
  }

  // Canciones famosas (Britney, Backstreet…): reintento con queries fijas
  if (stillBad || force || !online?.coverUrl) {
    for (const q of knownTrackQueries(`${searchTitle} ${track.artist} ${track.fileName}`)) {
      const alt = await enrichFromInternet(q, hintArtist, extraCtx)
      if (
        alt &&
        titlesCompatible(searchTitle, alt.title) &&
        !isLowQualityRelease(alt.artist, alt.album, alt.title) &&
        (!hintArtist || artistsCompatible(hintArtist, alt.artist))
      ) {
        online = alt
        break
      }
    }
  }

  if (!online || !titlesCompatible(searchTitle, online.title)) {
    return { track, found: false, coverUpdated: false }
  }

  if (isLowQualityRelease(online.artist, online.album, online.title)) {
    return { track, found: false, coverUpdated: false }
  }

  const finalScore = online.matchScore ?? score
  const titleMatch = titlesCompatible(searchTitle, online.title)
  const knownHit = knownTrackQueries(`${searchTitle} ${track.artist}`).length > 0
  const artistMatchStrong =
    Boolean(hintArtist) && artistsCompatible(hintArtist, online.artist)
  // Carátula: buena coincidencia; canciones famosas / artista claro → más permisivo
  const canUseCover =
    titleMatch &&
    artistOk &&
    (force || !track.hasCover) &&
    (finalScore >= 80 || knownHit || artistMatchStrong)
  // Rellenar huecos (álbum/año/género) sin pisar datos buenos
  const canFillGaps =
    titleMatch && artistOk && (finalScore >= 80 || knownHit || artistMatchStrong)
  // Reescribir artista/álbum solo con fuerza o basura clara
  const canRewriteMeta =
    allowRewriteMeta &&
    titleMatch &&
    (force || artistGeneric || artistOk) &&
    (finalScore >= 100 || knownHit)

  if (!canUseCover && !canRewriteMeta && !canFillGaps) {
    return { track, found: false, coverUpdated: false }
  }

  let hasCover = track.hasCover
  let coverUpdated = false

  async function trySaveCover(coverUrl: string | null | undefined): Promise<boolean> {
    if (!coverUrl) return false
    const coverCandidates = [
      coverUrl,
      coverUrl.replace('/1000x1000-', '/500x500-'),
      coverUrl.replace('/1000x1000-', '/250x250-'),
      coverUrl.replace('600x600bb', '300x300bb'),
      coverUrl.replace('100x100bb', '600x600bb'),
    ]
    for (const url of [...new Set(coverCandidates)]) {
      const blob = await fetchCoverBlob(url)
      if (blob && blob.size > 500) {
        revokeCachedUrls(id)
        objectUrlCache.delete(`cover:${id}`)
        await saveCoverBlob(id, blob)
        return true
      }
    }
    return false
  }

  // Siempre intentar portada si falta (aunque el resto de meta ya esté)
  if ((canUseCover || (!track.hasCover && titleMatch && artistOk)) && online.coverUrl) {
    if (await trySaveCover(online.coverUrl)) {
      hasCover = true
      coverUpdated = true
    }
  }

  // Britney / famosas: si aún no hay icono, otra pasada solo para portada
  if (!hasCover) {
    const coverQueries = [
      ...knownTrackQueries(`${searchTitle} ${track.artist} ${track.fileName}`),
      `${track.artist} ${core || searchTitle}`.trim(),
    ].filter(Boolean)
    for (const q of [...new Set(coverQueries)]) {
      const alt = await enrichFromInternet(q, hintArtist || (artistGeneric ? '' : track.artist), '')
      if (!alt?.coverUrl) continue
      if (!titlesCompatible(searchTitle, alt.title)) continue
      if (
        !artistGeneric &&
        track.artist &&
        !artistsCompatible(track.artist, alt.artist)
      ) {
        continue
      }
      if (await trySaveCover(alt.coverUrl)) {
        hasCover = true
        coverUpdated = true
        online = alt
        break
      }
    }
  }

  // Por defecto NO tocar título; rellenar artista/álbum si faltan
  const nextTitle = track.title
  const nextArtist =
    artistGeneric && (canFillGaps || canRewriteMeta)
      ? online.artist
      : canRewriteMeta && (junkLocal || knownWrong || force)
        ? online.artist
        : track.artist
  const nextAlbum =
    (canRewriteMeta && (albumGeneric || junkLocal || knownWrong || force)) ||
    (albumGeneric && canFillGaps)
      ? online.album
      : track.album

  const patch: Partial<Track> = {
    title: nextTitle,
    artist: nextArtist,
    album: nextAlbum,
    genre: track.genre
      ? track.genre
      : refineGenre({
          title: nextTitle,
          artist: nextArtist,
          album: nextAlbum,
          genre: (canFillGaps || canRewriteMeta ? online.genre : '') || '',
          fileName: track.fileName,
        }),
    year: track.year || (canFillGaps || canRewriteMeta ? online.year : ''),
    hasCover,
    enriched: true,
    externalUrl: `${online.externalUrl || 'myvibe'}:e${Date.now()}`,
  }
  await db.tracks.update(id, patch)
  const metaChanged =
    patch.artist !== track.artist ||
    patch.album !== track.album ||
    Boolean(patch.year && patch.year !== track.year) ||
    Boolean(patch.genre && patch.genre !== track.genre)
  return {
    track: { ...track, ...patch },
    // Antes: si meta ya estaba bien y fallaba la portada, salía “no encontrado”
    found: coverUpdated || metaChanged || canRewriteMeta || canFillGaps || canUseCover,
    coverUpdated,
  }
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

/** Fusiona duplicados locales (mismo archivo/título) y deja una sola copia. */
export async function dedupeLibraryTracks(): Promise<number> {
  const tracks = await db.tracks.toArray()
  const groups = groupDuplicateTracks(tracks)
  let removed = 0

  for (const group of groups) {
    // Elegir canónica por blob real, no solo por el flag hasLocalAudio
    const ranked = await Promise.all(
      group.map(async (t) => {
        const blob = await getAudioBlob(t.id)
        return { track: t, audioSize: blob && blob.size >= 1024 ? blob.size : 0 }
      }),
    )
    ranked.sort((a, b) => {
      if (a.audioSize !== b.audioSize) return b.audioSize - a.audioSize
      return 0
    })
    const withAudio = ranked.filter((r) => r.audioSize > 0).map((r) => r.track)
    const keep =
      withAudio.length > 0
        ? pickCanonicalTrack(withAudio)
        : pickCanonicalTrack(group)
    const keepAudioEntry = ranked.find((r) => r.track.id === keep.id)
    let keepAudioSize = keepAudioEntry?.audioSize ?? 0
    const drop = group.filter((t) => t.id !== keep.id)
    if (!drop.length) continue

    let liked = keep.liked
    let playCount = keep.playCount || 0
    let lastPlayedAt = keep.lastPlayedAt
    let hasCover = keep.hasCover
    let hasLocalAudio = keepAudioSize > 0

    for (const other of drop) {
      liked = liked || other.liked
      playCount = Math.max(playCount, other.playCount || 0)
      if ((other.lastPlayedAt || 0) > (lastPlayedAt || 0)) {
        lastPlayedAt = other.lastPlayedAt
      }
      if (other.hasCover && !hasCover) {
        const cover = await getCoverBlob(other.id)
        if (cover) {
          await saveCoverBlob(keep.id, cover)
          hasCover = true
        }
      }
      const otherAudio = await getAudioBlob(other.id)
      const otherSize = otherAudio && otherAudio.size >= 1024 ? otherAudio.size : 0
      // Siempre migrar audio si keep no tiene blob, o si other es claramente más completo
      if (otherAudio && otherSize > 0 && (keepAudioSize <= 0 || otherSize > keepAudioSize * 1.02)) {
        await saveAudioBlob(keep.id, otherAudio)
        keepAudioSize = otherSize
        hasLocalAudio = true
      }

      const playlists = await db.playlists.toArray()
      for (const p of playlists) {
        if (!p.trackIds.includes(other.id)) continue
        const trackIds = p.trackIds.map((id) => (id === other.id ? keep.id : id))
        await db.playlists.update(p.id, {
          trackIds: [...new Set(trackIds)],
          updatedAt: Date.now(),
        })
      }

      await deleteTrack(other.id)
      removed += 1
    }

    await db.tracks.update(keep.id, {
      liked,
      playCount,
      lastPlayedAt,
      hasCover,
      hasLocalAudio,
    })
  }

  return removed
}

export async function updateTrackMeta(
  id: string,
  patch: Partial<Pick<Track, 'title' | 'artist' | 'album' | 'genre' | 'year' | 'liked'>>,
): Promise<void> {
  await db.tracks.update(id, patch)
}

/**
 * Sustituye el audio de una canción existente (stubs mudos / transferencia rota).
 * Conserva id, likes, playlists y metadatos; actualiza duración y MIME.
 */
export async function replaceTrackAudio(id: string, file: File): Promise<Track> {
  const existing = await db.tracks.get(id)
  if (!existing) throw new Error('Canción no encontrada')

  const audio = await materializeAudioFile(file)
  if (!isAudioFile(audio)) {
    throw new Error(`“${file.name}” no es un archivo de audio válido`)
  }
  if (audio.size < 1024) {
    throw new Error(`“${file.name}” está vacío o incompleto`)
  }

  const duration = await getAudioDuration(audio)
  await saveAudioBlob(id, audio)

  let hasCover = Boolean(existing.hasCover)
  try {
    const tags = await readTags(audio)
    if (tags.coverBlob && !hasCover) {
      await saveCoverBlob(id, tags.coverBlob)
      hasCover = true
    }
  } catch {
    // tags opcionales
  }

  const patch: Partial<Track> = {
    duration: duration > 0 ? duration : existing.duration,
    mimeType: audio.type || guessAudioMime(audio.name) || existing.mimeType || 'audio/mpeg',
    fileName: audio.name || existing.fileName,
    hasLocalAudio: true,
    hasCover,
    audioUpdatedAt: Date.now(),
    needsAudioUpdate: false,
    cloudAudioSeenAt: Date.now(),
    audioBytes: audio.size,
  }
  await db.tracks.update(id, patch)
  const updated = await db.tracks.get(id)
  if (!updated) throw new Error('No se pudo actualizar la canción')
  return updated
}

/**
 * Empareja archivos MP3 con canciones sin audio local y las rellena.
 * Si `trackIds` está vacío, usa todas las que tengan hasLocalAudio === false.
 */
export async function replaceMissingAudioFromFiles(
  files: File[],
  trackIds?: string[],
  onProgress?: (done: number, total: number, name: string) => void,
): Promise<{ replaced: number; unmatched: string[] }> {
  const all = await db.tracks.toArray()
  const targets = (
    trackIds?.length ? all.filter((t) => trackIds.includes(t.id)) : all
  ).filter((t) => t.hasLocalAudio === false)

  if (!targets.length) {
    return { replaced: 0, unmatched: files.map((f) => f.name) }
  }

  const audioFiles = files.filter(isAudioFile)
  const unmatched: string[] = []
  let replaced = 0
  const remaining = [...targets]

  for (let i = 0; i < audioFiles.length; i++) {
    const original = audioFiles[i]!
    onProgress?.(i, audioFiles.length, original.name)
    try {
      const file = await materializeAudioFile(original)
      const tags = await readTags(file)
      const duration = await getAudioDuration(file)
      const probe = {
        title: tags.title || file.name,
        artist: tags.artist || '',
        duration,
        fileName: file.name,
      }
      const match =
        remaining.find((t) => tracksLookSame(t, probe)) ||
        findBestTrackMatch(
          remaining.map((t) => ({ ...t, hasLocalAudio: true })),
          probe,
        )

      if (!match) {
        unmatched.push(original.name)
        continue
      }

      await replaceTrackAudio(match.id, file)
      const idx = remaining.findIndex((t) => t.id === match.id)
      if (idx >= 0) remaining.splice(idx, 1)
      replaced += 1
    } catch {
      unmatched.push(original.name)
    }
  }

  onProgress?.(audioFiles.length, audioFiles.length, '')
  return { replaced, unmatched }
}

export async function setTrackCover(id: string, file: File): Promise<void> {
  revokeCachedUrls(id)
  objectUrlCache.delete(`cover:${id}`)
  await saveCoverBlob(id, file)
  await db.tracks.update(id, {
    hasCover: true,
    enriched: true,
    coverUpdatedAt: Date.now(),
  })
}

export async function toggleLike(id: string): Promise<boolean> {
  const track = await db.tracks.get(id)
  if (!track) return false
  const liked = !track.liked
  await db.tracks.update(id, { liked, likedUpdatedAt: Date.now() })
  return liked
}

export async function setTracksLiked(ids: string[], liked: boolean): Promise<void> {
  const now = Date.now()
  await Promise.all(ids.map((id) => db.tracks.update(id, { liked, likedUpdatedAt: now })))
}

export async function deleteTracks(ids: string[]): Promise<void> {
  for (const id of ids) {
    await deleteTrack(id)
  }
}

/**
 * Sincroniza hasLocalAudio con la realidad del almacenamiento.
 * - Si hay blob usable → marca local (recupera canciones mal marcadas en el PC)
 * - Si no hay blob → marca remota
 */
export async function repairMissingLocalAudio(): Promise<number> {
  const tracks = await db.tracks.toArray()
  let fixed = 0
  for (const t of tracks) {
    const blob = await getAudioBlob(t.id)
    const has = Boolean(blob && blob.size >= 1024)
    if (has && t.hasLocalAudio === false) {
      await db.tracks.update(t.id, { hasLocalAudio: true })
      fixed += 1
      continue
    }
    if (!has && t.hasLocalAudio !== false) {
      await db.tracks.update(t.id, { hasLocalAudio: false })
      if (blob && blob.size > 0) {
        await db.audio.delete(t.id).catch(() => undefined)
        await deleteBinary('audio', t.id).catch(() => undefined)
        revokeCachedUrls(t.id)
      }
      fixed += 1
    }
  }
  return fixed
}

/** Devuelve las dos copias posibles (IDB / OPFS) para reintentar reproducción. */
export async function getAudioBlobSources(
  id: string,
): Promise<{ idb: Blob | null; opfs: Blob | null }> {
  const record = await db.audio.get(id)
  const idb = record?.blob && record.blob.size > 0 ? record.blob : null
  const opfsRaw = await readBinary('audio', id)
  const opfs = opfsRaw && opfsRaw.size > 0 ? opfsRaw : null
  return { idb, opfs }
}

/**
 * Borra toda la música de ESTE dispositivo (audio, carátulas, metadatos locales).
 * No cierra la sesión. En el móvil el catálogo del PC puede volver como stubs al sincronizar.
 */
export async function clearLocalMusicLibrary(): Promise<{ tracks: number; playlists: number }> {
  const tracks = await db.tracks.toArray()
  for (const t of tracks) {
    revokeCachedUrls(t.id)
    await deleteBinary('audio', t.id)
    await deleteBinary('covers', t.id)
    await db.audio.delete(t.id)
    await db.covers.delete(t.id)
    await db.tracks.delete(t.id)
  }
  // Huérfanos en OPFS
  await clearOpfsFolder('audio')
  await clearOpfsFolder('covers')
  // Vaciar tablas por si quedan restos
  await db.audio.clear()
  await db.covers.clear()

  const playlists = await db.playlists.toArray()
  for (const p of playlists) {
    await db.playlists.update(p.id, { trackIds: [], updatedAt: Date.now() })
  }

  return { tracks: tracks.length, playlists: playlists.length }
}

function formatBytes(n: number): string {
  if (n <= 0) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** Resumen de lo que borraría “Borrar música de este dispositivo”. */
export async function previewClearLocalMusic(): Promise<{
  tracks: number
  withAudio: number
  withCover: number
  playlists: number
  sampleTitles: string[]
  bytesApprox: number
  summary: string
}> {
  const tracks = await db.tracks.toArray()
  const playlists = await db.playlists.toArray()
  let withAudio = 0
  let withCover = 0
  let bytesApprox = 0

  for (const t of tracks) {
    if (t.hasLocalAudio !== false) withAudio += 1
    if (t.hasCover) withCover += 1
    const audio = await db.audio.get(t.id)
    if (audio?.blob) bytesApprox += audio.blob.size
    const cover = await db.covers.get(t.id)
    if (cover?.blob) bytesApprox += cover.blob.size
  }

  const sampleTitles = tracks
    .slice(0, 8)
    .map((t) => `${t.title || 'Sin título'} — ${t.artist || 'Desconocido'}`)

  const lines = [
    `Se borrará de MyVibe en este dispositivo:`,
    ``,
    `· ${tracks.length} canción${tracks.length === 1 ? '' : 'es'} (metadatos)`,
    `· ${withAudio} con audio/MP3 local`,
    `· ${withCover} con carátula`,
    `· Listas de reproducción: se vacían (${playlists.length})`,
    bytesApprox > 0 ? `· Espacio aprox. a liberar: ${formatBytes(bytesApprox)}` : null,
    ``,
    `No se cierra la sesión ni se borra la cuenta.`,
    `Las copias en Archivos/Descargas → MyVibe no se tocan.`,
  ].filter((x): x is string => x !== null)

  if (sampleTitles.length) {
    lines.push(``, `Ejemplos:`, ...sampleTitles.map((t) => `· ${t}`))
    if (tracks.length > sampleTitles.length) {
      lines.push(`· … y ${tracks.length - sampleTitles.length} más`)
    }
  }

  lines.push(``, `¿Continuar?`)

  return {
    tracks: tracks.length,
    withAudio,
    withCover,
    playlists: playlists.length,
    sampleTitles,
    bytesApprox,
    summary: lines.join('\n'),
  }
}

/**
 * Borra audio/carátulas huérfanas (IndexedDB + OPFS) sin pista en la biblioteca.
 * No toca canciones activas ni la cuenta.
 */
export async function purgeOrphanLocalStorage(): Promise<{
  audio: number
  covers: number
  bytesApprox: number
}> {
  const preview = await previewOrphanPurge()
  if (preview.audio + preview.covers === 0) {
    return { audio: 0, covers: 0, bytesApprox: 0 }
  }

  const trackIds = new Set((await db.tracks.toArray()).map((t) => t.id))
  let audio = 0
  let covers = 0
  let bytesApprox = 0

  const audioRows = await db.audio.toArray()
  for (const row of audioRows) {
    if (trackIds.has(row.id)) continue
    bytesApprox += row.blob?.size || 0
    await db.audio.delete(row.id)
    await deleteBinary('audio', row.id)
    audio += 1
  }

  const coverRows = await db.covers.toArray()
  for (const row of coverRows) {
    if (trackIds.has(row.id)) continue
    bytesApprox += row.blob?.size || 0
    await db.covers.delete(row.id)
    await deleteBinary('covers', row.id)
    covers += 1
  }

  // OPFS: entradas sin track (aunque IDB ya esté limpio)
  for (const id of await listOpfsIds('audio')) {
    if (trackIds.has(id)) continue
    await deleteBinary('audio', id)
    audio += 1
  }
  for (const id of await listOpfsIds('covers')) {
    if (trackIds.has(id)) continue
    await deleteBinary('covers', id)
    covers += 1
  }

  return { audio, covers, bytesApprox }
}

/** Resumen de lo que borraría “Limpiar datos sin usar”. */
export async function previewOrphanPurge(): Promise<{
  audio: number
  covers: number
  bytesApprox: number
  summary: string
}> {
  const trackIds = new Set((await db.tracks.toArray()).map((t) => t.id))
  const audioOrphans = new Set<string>()
  const coverOrphans = new Set<string>()
  let bytesApprox = 0

  for (const row of await db.audio.toArray()) {
    if (trackIds.has(row.id)) continue
    audioOrphans.add(row.id)
    bytesApprox += row.blob?.size || 0
  }
  for (const row of await db.covers.toArray()) {
    if (trackIds.has(row.id)) continue
    coverOrphans.add(row.id)
    bytesApprox += row.blob?.size || 0
  }
  for (const id of await listOpfsIds('audio')) {
    if (!trackIds.has(id)) audioOrphans.add(id)
  }
  for (const id of await listOpfsIds('covers')) {
    if (!trackIds.has(id)) coverOrphans.add(id)
  }

  const audio = audioOrphans.size
  const covers = coverOrphans.size

  if (audio + covers === 0) {
    return {
      audio: 0,
      covers: 0,
      bytesApprox: 0,
      summary:
        'No hay datos sin usar.\n\nNo se borrará ninguna canción de tu biblioteca.\n(Audio/carátulas huérfanos: 0)',
    }
  }

  const lines = [
    `Se borrarán solo restos huérfanos (sin canción en la lista):`,
    ``,
    `· ${audio} archivo${audio === 1 ? '' : 's'} de audio sin pista`,
    `· ${covers} carátula${covers === 1 ? '' : 's'} sin pista`,
    bytesApprox > 0 ? `· Espacio aprox.: ${formatBytes(bytesApprox)}` : null,
    ``,
    `Tu biblioteca actual (${trackIds.size} canciones) NO se toca.`,
    `La cuenta y las playlists se mantienen.`,
    ``,
    `¿Continuar?`,
  ].filter((x): x is string => x !== null)

  return {
    audio,
    covers,
    bytesApprox,
    summary: lines.join('\n'),
  }
}

/** Estimación de huérfanos sin borrarlos (para habilitar el botón en Perfil). */
export async function countOrphanLocalStorage(): Promise<{
  audio: number
  covers: number
}> {
  const preview = await previewOrphanPurge()
  return { audio: preview.audio, covers: preview.covers }
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
    themeColor: pickDefaultThemeColor(),
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
  patch: Partial<Pick<Playlist, 'name' | 'description' | 'themeColor'>>,
): Promise<void> {
  await db.playlists.update(id, { ...patch, updatedAt: Date.now() })
}

export function playlistCoverId(playlistId: string): string {
  return `playlist:${playlistId}`
}

/** Props de CoverArt para una playlist (portada custom o primera canción). */
export function playlistCoverArtProps(playlist: {
  id: string
  hasCover?: boolean
  trackIds: string[]
  updatedAt?: number
}): { trackId: string | undefined; hasCover: boolean; refreshKey: number } {
  if (playlist.hasCover) {
    return {
      trackId: playlistCoverId(playlist.id),
      hasCover: true,
      refreshKey: playlist.updatedAt || Date.now(),
    }
  }
  const first = playlist.trackIds[0]
  return {
    trackId: first,
    hasCover: Boolean(first),
    refreshKey: playlist.updatedAt || 0,
  }
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
