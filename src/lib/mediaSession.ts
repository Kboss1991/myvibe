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

export async function updateMediaSession(
  track: Track | null,
  coverUrl: string | null,
  handlers: {
    play: () => void
    pause: () => void
    previoustrack: () => void
    nexttrack: () => void
    seekto?: (time: number) => void
    getPosition?: () => number
  },
) {
  if (!('mediaSession' in navigator)) return

  if (!track) {
    navigator.mediaSession.metadata = null
    return
  }

  const artwork: MediaImage[] = coverUrl
    ? [
        { src: coverUrl, sizes: '512x512', type: 'image/jpeg' },
        { src: coverUrl, sizes: '256x256', type: 'image/jpeg' },
      ]
    : []

  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title,
    artist: track.artist,
    album: track.album,
    artwork,
  })

  navigator.mediaSession.setActionHandler('play', handlers.play)
  navigator.mediaSession.setActionHandler('pause', handlers.pause)
  navigator.mediaSession.setActionHandler('previoustrack', handlers.previoustrack)
  navigator.mediaSession.setActionHandler('nexttrack', handlers.nexttrack)

  try {
    navigator.mediaSession.setActionHandler('seekbackward', (details) => {
      const offset = details.seekOffset ?? 10
      const pos = handlers.getPosition?.() ?? 0
      handlers.seekto?.(Math.max(0, pos - offset))
    })
    navigator.mediaSession.setActionHandler('seekforward', (details) => {
      const offset = details.seekOffset ?? 10
      const pos = handlers.getPosition?.() ?? 0
      handlers.seekto?.(pos + offset)
    })
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (typeof details.seekTime === 'number') handlers.seekto?.(details.seekTime)
    })
  } catch {
    // some handlers unsupported on older browsers
  }
}

export function setMediaPlaybackState(playing: boolean) {
  if (!('mediaSession' in navigator)) return
  navigator.mediaSession.playbackState = playing ? 'playing' : 'paused'
}
