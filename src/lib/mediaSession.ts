import { getCoverBlob } from './library'
import type { RadioStation } from './radios'
import type { Track } from '../types'

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

export function clearMediaArtworkCache(trackId?: string) {
  if (trackId) artworkCache.delete(trackId)
  else artworkCache.clear()
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
export async function buildLockScreenArtwork(trackId: string): Promise<MediaImage[]> {
  const cached = artworkCache.get(trackId)
  if (cached?.length) return cached

  const blob = await getCoverBlob(trackId)
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
    artworkCache.set(trackId, images)
    return images
  } catch {
    return []
  }
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
  navigator.mediaSession.setActionHandler('play', () => {
    handlers.play()
  })
  navigator.mediaSession.setActionHandler('pause', () => {
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
) {
  if (!('mediaSession' in navigator)) return

  if (!track) {
    // NUNCA borrar metadata: en iOS eso quita el reproductor de la pantalla de bloqueo
    return
  }

  // Primero metadatos; luego artwork asíncrono (para no retrasar controles)
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title,
    artist: track.artist,
    album: track.album,
    artwork: [],
  })

  bindMediaHandlers(handlers)
  // iOS pone Play al cambiar MediaMetadata
  refreshMediaPlaybackState()

  const artwork =
    track.hasLocalAudio !== false
      ? await buildLockScreenArtwork(track.id)
      : _coverUrl
        ? [{ src: _coverUrl, sizes: '512x512', type: 'image/jpeg' }]
        : []

  // Si ya cambió de pista mientras cargábamos artwork, no pisar
  try {
    const currentTitle = navigator.mediaSession.metadata?.title
    if (currentTitle && currentTitle !== track.title) return
  } catch {
    /* ignore */
  }

  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title,
    artist: track.artist,
    album: track.album,
    artwork,
  })

  bindMediaHandlers(handlers)
  // El 2º write (con carátula) vuelve a resetear el botón en CarPlay
  refreshMediaPlaybackState()
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

  navigator.mediaSession.metadata = new MediaMetadata({
    title: station.name,
    artist: 'En directo',
    album: station.tagline || 'Radio',
    artwork: station.logoUrl
      ? [{ src: station.logoUrl, sizes: '200x200', type: 'image/png' }]
      : [],
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
  try {
    if (playbackStateResolver) return playbackStateResolver()
  } catch {
    /* ignore */
  }
  return Boolean(fallback)
}

/**
 * Tras actualizar metadatos, iOS/CarPlay a menudo deja el botón en Play aunque suene.
 * Reaplica el estado real en varias pasadas (el artwork asíncrono también lo resetea).
 */
export function refreshMediaPlaybackState(playing?: boolean) {
  const apply = () => setMediaPlaybackState(resolvePlaybackState(playing))
  apply()
  try {
    for (const t of playbackRefreshTimers) window.clearTimeout(t)
    playbackRefreshTimers = []
    // CarPlay tarda más que el lock screen en “comerse” el playbackState
    for (const delay of [0, 40, 120, 280, 600, 1200, 2200]) {
      playbackRefreshTimers.push(window.setTimeout(apply, delay))
    }
  } catch {
    // ignore
  }
}

/**
 * Reclama Now Playing / CarPlay frente a Spotify u otras apps.
 * Reescribir metadata + playbackState es lo que iOS usa para decidir quién “manda”.
 */
export function claimNowPlaying(playing?: boolean) {
  if (!('mediaSession' in navigator)) return
  try {
    const meta = navigator.mediaSession.metadata
    if (meta) {
      const artwork = meta.artwork ? Array.from(meta.artwork) : []
      navigator.mediaSession.metadata = new MediaMetadata({
        title: meta.title || 'MyVibe',
        artist: meta.artist || 'MyVibe',
        album: meta.album || 'MyVibe',
        artwork,
      })
    } else {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: 'MyVibe',
        artist: 'MyVibe',
        album: 'MyVibe',
        artwork: [],
      })
    }
  } catch {
    // ignore
  }
  refreshMediaPlaybackState(playing)
}

/** Progreso en pantalla de bloqueo / Centro de control. */
export function setMediaPositionState(position: number, duration: number, playing: boolean) {
  if (!('mediaSession' in navigator)) return
  // Siempre el botón play/pause, aunque duration aún no esté lista
  setMediaPlaybackState(playing)
  if (!Number.isFinite(duration) || duration <= 0) return
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
}
