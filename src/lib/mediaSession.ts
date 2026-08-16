import { getCoverBlob } from './library'
import type { RadioStation } from './radios'
import type { Track } from '../types'
import {
  bindNativeRemoteControls,
  nativeSetMetadata,
  nativeSetPlaybackState,
  nativeSetPositionState,
  nativeSetSeekSkipEnabled,
} from './nativeNowPlaying'

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const s = Math.floor(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${r.toString().padStart(2, '0')}`
  }
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

/**
 * Cuando la biblioteca posee Now Playing, radio/podcast NO deben
 * pisar nexttrack/previoustrack ni registrar seek± (iOS muestra ±10s).
 */
let libraryOwnsMediaSession = false
export function setLibraryOwnsMediaSession(active: boolean) {
  libraryOwnsMediaSession = active
}
export function isLibraryOwnsMediaSession() {
  return libraryOwnsMediaSession
}

/** Última carátula publicada — iOS borra Now Playing si reescribimos artwork: []. */
let lastPublishedArtwork: MediaImage[] = []
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
    // 600 máx: data-URL más grande satura el bridge Capacitor → Dynamic Island
    const [lg, md] = await Promise.all([
      resizeCoverToJpeg(blob, 600, 0.82),
      resizeCoverToJpeg(blob, 300, 0.8),
    ])
    const images: MediaImage[] = [
      { src: lg, sizes: '600x600', type: 'image/jpeg' },
      { src: md, sizes: '300x300', type: 'image/jpeg' },
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


/**
 * Media Session handlers. Play/Pause remotos vuelven a controlar el audio
 * de forma mínima (sin soft-pause / ghost / reclaim).
 */
function bindMediaHandlers(handlers: {
  play?: () => void
  pause?: () => void
  previoustrack?: () => void
  nexttrack?: () => void
  seekto?: (time: number) => void
  getPosition?: () => number
  /** Podcasts: mostrar ±10s en bloqueo / CarPlay sin quitar next/prev episodio. */
  seekSkip?: boolean
  seekBackward?: (seconds: number) => void
  seekForward?: (seconds: number) => void
}) {
  // Biblioteca tiene el control: no pisar next/prev
  if (libraryOwnsMediaSession) return
  if (!('mediaSession' in navigator)) return

  navigator.mediaSession.setActionHandler('play', () => {
    try {
      handlers.play?.()
    } catch {
      /* ignore */
    }
  })
  navigator.mediaSession.setActionHandler('pause', () => {
    try {
      handlers.pause?.()
    } catch {
      /* ignore */
    }
  })
  // NUNCA poner next/prev a null (iOS muestra ±10s). Solo actualizar si hay handler.
  if (handlers.previoustrack) {
    navigator.mediaSession.setActionHandler('previoustrack', () => {
      try {
        handlers.previoustrack!()
      } catch {
        /* ignore */
      }
    })
  }
  if (handlers.nexttrack) {
    navigator.mediaSession.setActionHandler('nexttrack', () => {
      try {
        handlers.nexttrack!()
      } catch {
        /* ignore */
      }
    })
  }

  try {
    if (handlers.seekSkip) {
      navigator.mediaSession.setActionHandler('seekbackward', (details) => {
        const sec =
          typeof details.seekOffset === 'number' && details.seekOffset > 0
            ? details.seekOffset
            : 10
        try {
          handlers.seekBackward?.(sec)
        } catch {
          /* ignore */
        }
      })
      navigator.mediaSession.setActionHandler('seekforward', (details) => {
        const sec =
          typeof details.seekOffset === 'number' && details.seekOffset > 0
            ? details.seekOffset
            : 10
        try {
          handlers.seekForward?.(sec)
        } catch {
          /* ignore */
        }
      })
    } else {
      // Música: sin seek± (en iOS sustituyen las flechas de pista)
      navigator.mediaSession.setActionHandler('seekbackward', null)
      navigator.mediaSession.setActionHandler('seekforward', null)
    }
    if (handlers.seekto) {
      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (typeof details.seekTime === 'number') handlers.seekto?.(details.seekTime)
      })
    } else {
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
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: opts.title,
      artist: opts.artist,
      album: opts.album,
      artwork,
    })
  }
  void nativeSetMetadata({
    title: opts.title,
    artist: opts.artist,
    album: opts.album,
    artwork,
  })
}

/** Compat no-ops (APIs antiguas eliminadas). */
export function setGhostPlayHandler(_fn: (() => void) | null) {}
export function markMediaPlayGesture() {}
export function reaffirmMediaSession(_opts?: { playing?: boolean }) {}
export function keepMediaSessionAlivePaused() {}
export function startSoftPauseSessionGuard() {}
export function stopSoftPauseSessionGuard() {}
export function claimNowPlaying(_playing?: boolean, _opts?: { reclaim?: boolean }) {}
export function setPlaybackStateResolver(_fn: (() => boolean) | null) {}

let playbackRefreshTimers: number[] = []

export function clearMediaPlaybackRefresh() {
  try {
    for (const t of playbackRefreshTimers) window.clearTimeout(t)
    playbackRefreshTimers = []
  } catch {
    /* ignore */
  }
}

/**
 * Now Playing: ficha + playbackState. Una sola escritura de metadata.
 */
export async function updateMediaSession(
  track: Track | null,
  _coverUrl: string | null,
  handlers: {
    play?: () => void
    pause?: () => void
    previoustrack?: () => void
    nexttrack?: () => void
    seekto?: (time: number) => void
    getPosition?: () => number
    seekSkip?: boolean
    seekBackward?: (seconds: number) => void
    seekForward?: (seconds: number) => void
  },
  opts?: { playing?: boolean; skipArtworkUpgrade?: boolean },
) {
  if (!track) return
  if (libraryOwnsMediaSession) return

  // Handlers YA (antes de await artwork)
  bindMediaHandlers(handlers)
  void bindNativeRemoteControls({
    play: handlers.play,
    pause: handlers.pause,
    nexttrack: handlers.nexttrack,
    previoustrack: handlers.previoustrack,
    seekto: handlers.seekto,
    seekForward: handlers.seekForward,
    seekBackward: handlers.seekBackward,
  })
  void nativeSetSeekSkipEnabled(Boolean(handlers.seekSkip), 10)

  let artwork = peekCachedLockScreenArtwork(track.id)
  if (!opts?.skipArtworkUpgrade) {
    try {
      const full = await resolveLockScreenArtwork(track, _coverUrl)
      if (full.length) artwork = full
    } catch {
      /* keep cached */
    }
  }

  publishMetadata({
    title: track.title,
    artist: track.artist,
    album: track.album,
    artwork,
  })
  bindMediaHandlers(handlers)

  if (opts?.playing === true) {
    setMediaPlaybackState(true)
    refreshMediaPlaybackState(true, { strong: true })
  } else if (opts?.playing === false) {
    setMediaPlaybackState(false)
    refreshMediaPlaybackState(false)
  }
}

export async function updateRadioMediaSession(
  station: RadioStation,
  handlers: {
    play?: () => void
    pause?: () => void
    previoustrack?: () => void
    nexttrack?: () => void
  },
) {
  if (libraryOwnsMediaSession) return

  bindMediaHandlers({
    ...handlers,
    seekto: undefined,
    getPosition: undefined,
    seekSkip: false,
  })
  void bindNativeRemoteControls({
    play: handlers.play,
    pause: handlers.pause,
    nexttrack: handlers.nexttrack,
    previoustrack: handlers.previoustrack,
  })
  void nativeSetSeekSkipEnabled(false)

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
    const currentTitle = navigator.mediaSession?.metadata?.title
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
}

export function setMediaPlaybackState(playing: boolean) {
  if (libraryOwnsMediaSession) return
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.playbackState = playing ? 'playing' : 'paused'
    } catch {
      // ignore
    }
  }
  void nativeSetPlaybackState(playing)
}

/** Pocas pasadas — sin laberinto de 8s. */
export function refreshMediaPlaybackState(
  playing?: boolean,
  opts?: { strong?: boolean },
) {
  if (libraryOwnsMediaSession) return
  if (playing !== true && playing !== false) return
  const apply = () => setMediaPlaybackState(playing)
  apply()
  try {
    clearMediaPlaybackRefresh()
    const delays = opts?.strong ? [50, 200, 600, 1500, 3000] : [40, 200, 800]
    for (const delay of delays) {
      playbackRefreshTimers.push(window.setTimeout(apply, delay))
    }
  } catch {
    /* ignore */
  }
}

export function setMediaPositionState(position: number, duration: number, playing: boolean) {
  if (libraryOwnsMediaSession) return
  setMediaPlaybackState(playing)
  if (!Number.isFinite(duration) || duration <= 0) return
  const pos = Math.max(0, Math.min(position, duration))
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.setPositionState({
        duration,
        playbackRate: 1,
        position: pos,
      })
    } catch {
      // Safari a veces falla si position > duration momentáneamente
    }
  }
  void nativeSetPositionState(pos, duration, 1)
  if (playing) setMediaPlaybackState(true)
}
