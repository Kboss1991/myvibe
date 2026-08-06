import { getCoverBlob } from './library'
import type { RadioStation } from './radios'
import type { Track } from '../types'
import { logPlayback } from './playbackDebug'

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const s = Math.floor(seconds)
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${r.toString().padStart(2, '0')}`
}

export function shuffleArray<T>(items: T[], stayIndex?: number): T[] {
  const arr = [...items]
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  if (stayIndex !== undefined && stayIndex >= 0 && stayIndex < items.length) {
    const stay = items[stayIndex]
    const newIndex = arr.indexOf(stay)
    if (newIndex > 0) {
      ;[arr[0], arr[newIndex]] = [arr[newIndex], arr[0]]
    }
  }
  return arr
}

/** Cache de carátulas ya convertidas para la pantalla de bloqueo. */
const artworkCache = new Map<string, MediaImage[]>()

/** Última carátula publicada — iOS borra Now Playing si reescribimos artwork: []. */
let lastPublishedArtwork: MediaImage[] = []
let lastPublishedMeta: { title: string; artist: string; album: string } | null = null
let softPauseGuardTimer: number | null = null
let softPauseHandlers: {
  play: () => void
  pause: () => void
  previoustrack: () => void
  nexttrack: () => void
  seekto?: (time: number) => void
  getPosition?: () => number
  seekSkip?: boolean
} | null = null
/** Si iOS pone playbackState=playing sin llamar al handler play */
let ghostPlayHandler: (() => void) | null = null

export function setGhostPlayHandler(fn: (() => void) | null) {
  ghostPlayHandler = fn
}

export function clearMediaArtworkCache(trackId?: string) {
  if (trackId) artworkCache.delete(trackId)
  else artworkCache.clear()
}

/** Carátula ya convertida (evita await antes del primer write en skip/CarPlay). */
export function peekCachedLockScreenArtwork(trackId: string): MediaImage[] {
  const cached = artworkCache.get(trackId)
  if (cached?.length) return cached
  return lastPublishedArtwork
}

/** Evita ghost-play justo después de un play real del usuario. */
let lastMediaPlayGestureAt = 0

export function markMediaPlayGesture() {
  lastMediaPlayGestureAt = Date.now()
}

async function resizeCoverToJpeg(blob: Blob, size: number, quality: number): Promise<string> {
  let bitmap: ImageBitmap | null = null
  try {
    bitmap = await createImageBitmap(blob)
  } catch {
    // Fallback Image()
    const url = URL.createObjectURL(blob)
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image()
        el.onload = () => resolve(el)
        el.onerror = () => reject(new Error('cover'))
        el.src = url
      })
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('canvas')
      const scale = Math.max(size / img.naturalWidth, size / img.naturalHeight)
      const w = img.naturalWidth * scale
      const h = img.naturalHeight * scale
      ctx.fillStyle = '#111'
      ctx.fillRect(0, 0, size, size)
      ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h)
      return canvas.toDataURL('image/jpeg', quality)
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  try {
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas')
    const scale = Math.max(size / bitmap.width, size / bitmap.height)
    const w = bitmap.width * scale
    const h = bitmap.height * scale
    ctx.fillStyle = '#111'
    ctx.fillRect(0, 0, size, size)
    ctx.drawImage(bitmap, (size - w) / 2, (size - h) / 2, w, h)
    return canvas.toDataURL('image/jpeg', quality)
  } finally {
    bitmap.close()
  }
}

/**
 * Genera artwork grande para iOS (lock screen / Now Playing).
 * Sin esto, iPhone muestra el icono de MyVibe en pequeño.
 */
async function mediaImagesFromBlob(blob: Blob, cacheKey: string): Promise<MediaImage[]> {
  if (!blob || blob.size < 32) return []
  try {
    // iOS elige el tamaño más grande disponible para la carátula a pantalla completa
    const [xl, lg, md] = await Promise.all([
      resizeCoverToJpeg(blob, 1200, 0.88),
      resizeCoverToJpeg(blob, 600, 0.86),
      resizeCoverToJpeg(blob, 300, 0.84),
    ])
    const images: MediaImage[] = [
      { src: xl, sizes: '1200x1200', type: 'image/jpeg' },
      { src: lg, sizes: '600x600', type: 'image/jpeg' },
      { src: md, sizes: '300x300', type: 'image/jpeg' },
      { src: lg, sizes: '512x512', type: 'image/jpeg' },
      { src: md, sizes: '256x256', type: 'image/jpeg' },
    ]
    artworkCache.set(cacheKey, images)
    return images
  } catch {
    return []
  }
}

export async function buildLockScreenArtwork(trackId: string): Promise<MediaImage[]> {
  const cached = artworkCache.get(trackId)
  if (cached?.length) return cached

  const blob = await getCoverBlob(trackId)
  if (!blob || blob.size < 32) return []
  return mediaImagesFromBlob(blob, trackId)
}

/** Descarga una imagen remota (proxy primero: muchos CDN de podcasts bloquean CORS). */
async function fetchRemoteImageBlob(url: string): Promise<Blob | null> {
  const tryFetch = async (src: string) => {
    const res = await fetch(src, { mode: 'cors', credentials: 'omit', cache: 'force-cache' })
    if (!res.ok) return null
    const blob = await res.blob()
    if (blob.size < 32) return null
    // Algunos proxies/CDN devuelven JSON de error con 200
    if (/json|text\/|html/i.test(blob.type)) return null
    return blob
  }

  if (/^https?:\/\//i.test(url)) {
    try {
      const proxied = `/api/image-proxy?url=${encodeURIComponent(url)}`
      const viaProxy = await tryFetch(proxied)
      if (viaProxy) return viaProxy
    } catch {
      /* direct */
    }
  }

  try {
    const direct = await tryFetch(url)
    if (direct) return direct
  } catch {
    /* ignore */
  }

  return null
}

/**
 * Portadas remotas (podcasts / radio): iOS no usa bien URLs http(s) en
 * MediaMetadata; hay que pasar data URLs JPEG como con la música local.
 */
export async function buildLockScreenArtworkFromUrl(
  url: string,
  cacheKey: string,
): Promise<MediaImage[]> {
  const key = cacheKey || `url:${url}`
  const cached = artworkCache.get(key)
  if (cached?.length) return cached

  const blob = await fetchRemoteImageBlob(url)
  if (!blob) return []
  return mediaImagesFromBlob(blob, key)
}

/** Resuelve carátula local o remota → data URLs para iOS. */
async function resolveLockScreenArtwork(
  track: Track,
  coverUrl: string | null | undefined,
): Promise<MediaImage[]> {
  const url = typeof coverUrl === 'string' ? coverUrl.trim() : ''
  const isRemote =
    url.startsWith('http://') ||
    url.startsWith('https://') ||
    url.startsWith('/api/') ||
    url.startsWith('blob:') ||
    url.startsWith('data:')

  // Podcasts / stubs: siempre convertir URL remota (nunca pasar http crudo a iOS)
  if (isRemote) {
    if (url.startsWith('data:')) {
      return [
        { src: url, sizes: '1200x1200', type: 'image/jpeg' },
        { src: url, sizes: '512x512', type: 'image/jpeg' },
      ]
    }
    try {
      const remote = await buildLockScreenArtworkFromUrl(
        url,
        `remote:${track.id}:${url}`,
      )
      if (remote.length) return remote
    } catch {
      /* fall through to local */
    }
  }

  if (track.hasLocalAudio !== false && track.hasCover !== false) {
    try {
      const local = await buildLockScreenArtwork(track.id)
      if (local.length) return local
    } catch {
      /* ignore */
    }
  }

  if (url && !isRemote) {
    try {
      return await buildLockScreenArtworkFromUrl(url, `remote:${track.id}:${url}`)
    } catch {
      return []
    }
  }

  return []
}

function bindMediaHandlers(handlers: {
  play: () => void
  pause: () => void
  previoustrack: () => void
  nexttrack: () => void
  seekto?: (time: number) => void
  getPosition?: () => number
  /** ±15 s en pantalla de bloqueo — solo podcasts */
  seekSkip?: boolean
}) {
  softPauseHandlers = handlers
  // play/pause: invocar en el mismo turno del gesto de Media Session
  navigator.mediaSession.setActionHandler('play', () => {
    markMediaPlayGesture()
    logPlayback('ms-play-fired')
    try {
      handlers.play()
      logPlayback('ms-play-dispatched')
    } catch (err) {
      logPlayback('ms-play-handler-error', {
        detail: err instanceof Error ? err.message : 'unknown',
      })
    }
  })
  navigator.mediaSession.setActionHandler('pause', () => {
    logPlayback('ms-pause-fired')
    handlers.pause()
  })
  navigator.mediaSession.setActionHandler('previoustrack', () => {
    handlers.previoustrack()
  })
  navigator.mediaSession.setActionHandler('nexttrack', () => {
    handlers.nexttrack()
  })

  try {
    if (handlers.seekto) {
      if (handlers.seekSkip && handlers.getPosition) {
        navigator.mediaSession.setActionHandler('seekbackward', (details) => {
          const offset = details.seekOffset ?? 15
          const pos = handlers.getPosition?.() ?? 0
          handlers.seekto?.(Math.max(0, pos - offset))
        })
        navigator.mediaSession.setActionHandler('seekforward', (details) => {
          const offset = details.seekOffset ?? 15
          const pos = handlers.getPosition?.() ?? 0
          handlers.seekto?.(pos + offset)
        })
      } else {
        navigator.mediaSession.setActionHandler('seekbackward', null)
        navigator.mediaSession.setActionHandler('seekforward', null)
      }
      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (typeof details.seekTime === 'number') handlers.seekto?.(details.seekTime)
      })
    } else {
      navigator.mediaSession.setActionHandler('seekbackward', null)
      navigator.mediaSession.setActionHandler('seekforward', null)
      navigator.mediaSession.setActionHandler('seekto', null)
    }
  } catch {
    // some handlers unsupported on older browsers
  }
}

function artworkOrLast(artwork: MediaImage[]): MediaImage[] {
  if (artwork.length) {
    lastPublishedArtwork = artwork
    return artwork
  }
  return lastPublishedArtwork
}

function publishMetadata(opts: {
  title: string
  artist: string
  album: string
  artwork: MediaImage[]
}) {
  const artwork = artworkOrLast(opts.artwork)
  lastPublishedMeta = {
    title: opts.title,
    artist: opts.artist,
    album: opts.album,
  }
  navigator.mediaSession.metadata = new MediaMetadata({
    title: opts.title,
    artist: opts.artist,
    album: opts.album,
    artwork,
  })
}

/**
 * Reafirma ficha + handlers sin borrar artwork.
 * Importante: con playing=true NO reescribir MediaMetadata (CarPlay vuelve a Play).
 * Solo reescribe metadata en paused (evita "Sin contenido" / handoff a Podcasts).
 */
export function reaffirmMediaSession(opts?: { playing?: boolean }) {
  if (!('mediaSession' in navigator)) return
  try {
    if (opts?.playing !== true) {
      const meta = navigator.mediaSession.metadata
      const title = meta?.title || lastPublishedMeta?.title
      if (title) {
        publishMetadata({
          title,
          artist: meta?.artist || lastPublishedMeta?.artist || 'MyVibe',
          album: meta?.album || lastPublishedMeta?.album || 'MyVibe',
          artwork: meta?.artwork?.length
            ? Array.from(meta.artwork)
            : lastPublishedArtwork,
        })
      }
    }
    if (softPauseHandlers) bindMediaHandlers(softPauseHandlers)
  } catch {
    /* ignore */
  }
  if (opts?.playing === false) {
    setMediaPlaybackState(false)
    refreshMediaPlaybackState(false)
  } else if (opts?.playing === true) {
    stopSoftPauseSessionGuard()
    setMediaPlaybackState(true)
    refreshMediaPlaybackState(true, { strong: true })
  }
}

/**
 * Tras soft-pause: reafirmar la misma ficha (sin artwork vacío) y estado paused.
 * Si no, iOS a veces deja "Sin contenido" y el Play de bloqueo no llega.
 */
export function keepMediaSessionAlivePaused() {
  reaffirmMediaSession({ playing: false })
}

/** Mientras estamos en pause de usuario: mantener ficha + detectar play fantasma de iOS. */
export function startSoftPauseSessionGuard() {
  stopSoftPauseSessionGuard()
  if (typeof window === 'undefined') return
  softPauseGuardTimer = window.setInterval(() => {
    try {
      const msPlaying = navigator.mediaSession.playbackState === 'playing'
      let weThinkPlaying = false
      try {
        weThinkPlaying = Boolean(playbackStateResolver?.())
      } catch {
        /* ignore */
      }

      // iOS cambió el icono a Play sin llamar a nuestro handler
      if (
        msPlaying &&
        !weThinkPlaying &&
        ghostPlayHandler &&
        Date.now() - lastMediaPlayGestureAt > 900
      ) {
        logPlayback('ghost-play-detected', {
          detail: 'mediaSession=playing sin handler',
        })
        ghostPlayHandler()
        return
      }

      if (weThinkPlaying) {
        stopSoftPauseSessionGuard()
        return
      }

      const title = navigator.mediaSession.metadata?.title
      if (!title && lastPublishedMeta) {
        keepMediaSessionAlivePaused()
        return
      }
      setMediaPlaybackState(false)
    } catch {
      /* ignore */
    }
  }, 300)
}

export function stopSoftPauseSessionGuard() {
  if (softPauseGuardTimer != null) {
    try {
      window.clearInterval(softPauseGuardTimer)
    } catch {
      /* ignore */
    }
    softPauseGuardTimer = null
  }
}

/**
 * Now Playing / CarPlay.
 * Handlers YA (antes de artwork): si esperamos la carátula, pause/play de
 * bloqueo no tienen handler y el icono cambia sin audio.
 * Luego UNA escritura de MediaMetadata con carátula (iOS ignora http(s)).
 */
export async function updateMediaSession(
  track: Track | null,
  _coverUrl: string | null,
  handlers: {
    play: () => void
    pause: () => void
    previoustrack: () => void
    nexttrack: () => void
    seekto?: (time: number) => void
    getPosition?: () => number
    seekSkip?: boolean
  },
  opts?: { playing?: boolean; skipArtworkUpgrade?: boolean },
) {
  if (!('mediaSession' in navigator)) return

  if (!track) {
    // NUNCA borrar metadata: en iOS eso quita el reproductor de la pantalla de bloqueo
    return
  }

  // Crítico: registrar play/pause antes de cualquier await
  bindMediaHandlers(handlers)

  const playingHint = opts?.playing
  let samePublishedTrack = false
  try {
    const meta = navigator.mediaSession.metadata
    samePublishedTrack =
      Boolean(meta) &&
      String(meta?.title || '') === track.title &&
      String(meta?.artist || '') === track.artist &&
      String(meta?.album || '') === track.album
  } catch {
    /* ignore */
  }

  // Si ya es la misma pista y solo queremos mantener "playing",
  // NO reescribir MediaMetadata: en CarPlay eso vuelve el botón a Play.
  if (playingHint === true && samePublishedTrack) {
    stopSoftPauseSessionGuard()
    setMediaPlaybackState(true)
    refreshMediaPlaybackState(true, { strong: true })
    return
  }

  const cachedArt = peekCachedLockScreenArtwork(track.id)

  publishMetadata({
    title: track.title,
    artist: track.artist,
    album: track.album,
    artwork: cachedArt,
  })
  if (playingHint === true) {
    stopSoftPauseSessionGuard()
    setMediaPlaybackState(true)
    refreshMediaPlaybackState(true, { strong: true })
  }

  if (opts?.skipArtworkUpgrade) {
    return
  }

  const artwork = await resolveLockScreenArtwork(track, _coverUrl)

  publishMetadata({
    title: track.title,
    artist: track.artist,
    album: track.album,
    artwork,
  })
  bindMediaHandlers(handlers)

  if (playingHint === true) {
    stopSoftPauseSessionGuard()
    setMediaPlaybackState(true)
    refreshMediaPlaybackState(true, { strong: true })
  } else if (playingHint === false) {
    setMediaPlaybackState(false)
    refreshMediaPlaybackState(false)
  } else {
    refreshMediaPlaybackState(playingHint)
  }
}

export async function updateRadioMediaSession(
  station: RadioStation,
  handlers: {
    play: () => void
    pause: () => void
    previoustrack: () => void
    nexttrack: () => void
  },
) {
  if (!('mediaSession' in navigator)) return

  bindMediaHandlers({
    ...handlers,
    seekto: undefined,
    getPosition: undefined,
    seekSkip: false,
  })

  // No publicar artwork vacío primero (borra Now Playing en iOS)
  publishMetadata({
    title: station.name,
    artist: 'En directo',
    album: station.tagline || 'Radio',
    artwork: lastPublishedArtwork,
  })

  let artwork: MediaImage[] = []
  if (station.logoUrl) {
    artwork = await buildLockScreenArtworkFromUrl(
      station.logoUrl,
      `radio:${station.id}:${station.logoUrl}`,
    )
  }

  try {
    const currentTitle = navigator.mediaSession.metadata?.title
    if (currentTitle && currentTitle !== station.name) return
  } catch {
    /* ignore */
  }

  publishMetadata({
    title: station.name,
    artist: 'En directo',
    album: station.tagline || 'Radio',
    artwork,
  })

  bindMediaHandlers({
    ...handlers,
    seekto: undefined,
    getPosition: undefined,
    seekSkip: false,
  })
  refreshMediaPlaybackState()
}

export function setMediaPlaybackState(playing: boolean) {
  if (!('mediaSession' in navigator)) return
  if (playing) stopSoftPauseSessionGuard()
  try {
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused'
  } catch {
    // ignore
  }
}

/** Estado vivo play/pause (el store lo registra). Evita que reintentos tardíos pisen un pause del usuario. */
let playbackStateResolver: (() => boolean) | null = null
let playbackRefreshTimers: number[] = []

export function setPlaybackStateResolver(fn: (() => boolean) | null) {
  playbackStateResolver = fn
}

function resolvePlaybackState(fallback?: boolean): boolean {
  // Pause explícito: no dejar que el resolver / pending finge "playing"
  if (fallback === false) return false
  try {
    if (playbackStateResolver) {
      const live = playbackStateResolver()
      // Play explícito solo si de verdad suena o el resolver lo afirma
      if (fallback === true) return live || false
      return live
    }
  } catch {
    /* ignore */
  }
  return Boolean(fallback)
}

/** Cancela reintentos de playbackState (p. ej. al pasar de pause → play). */
export function clearMediaPlaybackRefresh() {
  try {
    for (const t of playbackRefreshTimers) window.clearTimeout(t)
    playbackRefreshTimers = []
  } catch {
    /* ignore */
  }
}

/**
 * Tras actualizar metadatos, iOS/CarPlay a menudo deja el botón en Play aunque suene.
 * Reaplica el estado real en varias pasadas.
 */
export function refreshMediaPlaybackState(
  playing?: boolean,
  opts?: { strong?: boolean },
) {
  const apply = () => setMediaPlaybackState(resolvePlaybackState(playing))
  apply()
  try {
    queueMicrotask(apply)
  } catch {
    /* ignore */
  }
  try {
    clearMediaPlaybackRefresh()
    const delays = opts?.strong
      ? [0, 16, 50, 100, 200, 400, 700, 1100, 1800, 2800, 4000, 6000, 8000]
      : [0, 40, 120, 280, 600, 1200, 2200]
    for (const delay of delays) {
      playbackRefreshTimers.push(window.setTimeout(apply, delay))
    }
  } catch {
    // ignore
  }
}

/**
 * Reclama Now Playing / CarPlay frente a Spotify u otras apps.
 * Por defecto solo reafirma playbackState (reescribir metadata resetea el botón a Play).
 * Usa `reclaim: true` solo si se perdió la ficha (tras llamada / otra app).
 * Con playing=true nunca reescribe MediaMetadata.
 */
export function claimNowPlaying(
  playing?: boolean,
  opts?: { reclaim?: boolean },
) {
  if (!('mediaSession' in navigator)) return
  const reclaim = Boolean(opts?.reclaim) && playing !== true
  if (reclaim) {
    try {
      const meta = navigator.mediaSession.metadata
      if (meta?.title || lastPublishedMeta) {
        publishMetadata({
          title: meta?.title || lastPublishedMeta?.title || 'MyVibe',
          artist: meta?.artist || lastPublishedMeta?.artist || 'MyVibe',
          album: meta?.album || lastPublishedMeta?.album || 'MyVibe',
          artwork: meta?.artwork?.length
            ? Array.from(meta.artwork)
            : lastPublishedArtwork,
        })
      }
      // Sin metadata previa: no publicar ficha vacía (iOS → "Sin contenido")
    } catch {
      // ignore
    }
  }
  if (playing === true) stopSoftPauseSessionGuard()
  refreshMediaPlaybackState(playing)
}

/** Progreso en pantalla de bloqueo / Centro de control. */
export function setMediaPositionState(position: number, duration: number, playing: boolean) {
  if (!('mediaSession' in navigator)) return
  setMediaPlaybackState(playing)
  if (!Number.isFinite(duration) || duration <= 0) {
    if (playing) setMediaPlaybackState(true)
    return
  }
  const pos = Math.max(0, Math.min(position, duration))
  try {
    navigator.mediaSession.setPositionState({
      duration,
      playbackRate: 1,
      position: pos,
    })
  } catch {
    // Safari a veces falla si position > duration momentáneamente
  }
  // setPositionState en CarPlay a veces deja el botón en Play otra vez
  if (playing) setMediaPlaybackState(true)
}
