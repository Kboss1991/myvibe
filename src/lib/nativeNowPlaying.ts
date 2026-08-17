import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'

type PlaybackState = 'none' | 'paused' | 'playing'

export type NowPlayingRemoteAction =
  | 'play'
  | 'pause'
  | 'nexttrack'
  | 'previoustrack'
  | 'seekto'
  | 'seekforward'
  | 'seekbackward'
  | 'like'
  | 'bookmark'

export type NowPlayingRemoteEvent = {
  action: NowPlayingRemoteAction
  seekTime?: number
  seekOffset?: number
}

type NowPlayingPluginApi = {
  setMetadata(options: {
    title?: string
    artist?: string
    album?: string
    artwork?: MediaImage[]
  }): Promise<void>
  setPlaybackState(options: { playbackState: PlaybackState }): Promise<void>
  setPositionState(options: {
    duration?: number
    position?: number
    playbackRate?: number
  }): Promise<void>
  setFeedbackState(options: { liked: boolean }): Promise<void>
  setSeekSkipEnabled(options: { enabled: boolean; seconds?: number }): Promise<void>
  clear(): Promise<void>
  addListener(
    eventName: 'remote',
    listenerFunc: (event: NowPlayingRemoteEvent) => void,
  ): Promise<PluginListenerHandle>
}

const NowPlaying = registerPlugin<NowPlayingPluginApi>('NowPlaying')

export function isNativeNowPlayingAvailable(): boolean {
  try {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios'
  } catch {
    return false
  }
}

/** Preferir JPEG data-URL (el nativo no puede leer blob:). */
export function pickNativeArtwork(artwork: MediaImage[] | undefined | null): MediaImage[] {
  if (!artwork?.length) return []
  const data = artwork.filter((a) => typeof a.src === 'string' && a.src.startsWith('data:'))
  if (data.length) {
    const best =
      data.find((a) => (a.sizes || '').includes('300')) ||
      data.find((a) => (a.sizes || '').includes('600')) ||
      data[0]!
    return [best]
  }
  const http = artwork.filter(
    (a) => typeof a.src === 'string' && /^https?:\/\//i.test(a.src),
  )
  return http.slice(0, 1)
}

export async function nativeSetMetadata(opts: {
  title: string
  artist: string
  album: string
  artwork?: MediaImage[]
}): Promise<void> {
  if (!isNativeNowPlayingAvailable()) return
  try {
    await NowPlaying.setMetadata({
      title: opts.title,
      artist: opts.artist,
      album: opts.album,
      artwork: pickNativeArtwork(opts.artwork),
    })
  } catch (err) {
    console.warn('[NowPlaying] setMetadata failed', err)
  }
}

export async function nativeSetPlaybackState(playing: boolean | 'none'): Promise<void> {
  if (!isNativeNowPlayingAvailable()) return
  const playbackState: PlaybackState =
    playing === 'none' ? 'none' : playing ? 'playing' : 'paused'
  try {
    await NowPlaying.setPlaybackState({ playbackState })
  } catch (err) {
    console.warn('[NowPlaying] setPlaybackState failed', err)
  }
}

export async function nativeSetPositionState(
  position: number,
  duration: number,
  playbackRate = 1,
): Promise<void> {
  if (!isNativeNowPlayingAvailable()) return
  if (!Number.isFinite(duration) || duration <= 0) return
  if (!Number.isFinite(position) || position < 0) return
  try {
    await NowPlaying.setPositionState({
      duration,
      position: Math.min(position, duration),
      playbackRate,
    })
  } catch (err) {
    console.warn('[NowPlaying] setPositionState failed', err)
  }
}

export async function nativeSetLikeState(liked: boolean): Promise<void> {
  if (!isNativeNowPlayingAvailable()) return
  try {
    await NowPlaying.setFeedbackState({ liked })
  } catch (err) {
    console.warn('[NowPlaying] setFeedbackState failed', err)
  }
}

/** iOS dispara un pause remoto al reconfigurar Now Playing justo tras un play local. */
let ignoreRemotePauseUntil = 0

export function suppressRemotePause(ms = 1500) {
  ignoreRemotePauseUntil = Date.now() + Math.max(0, ms)
}

export function shouldIgnoreRemotePause() {
  return Date.now() < ignoreRemotePauseUntil
}

/** Podcasts: ±N s y sin next/prev. Música/radio: al revés. */
export async function nativeSetSeekSkipEnabled(
  enabled: boolean,
  seconds = 10,
): Promise<void> {
  if (!isNativeNowPlayingAvailable()) return
  try {
    await NowPlaying.setSeekSkipEnabled({ enabled, seconds })
  } catch (err) {
    console.warn('[NowPlaying] setSeekSkipEnabled failed', err)
  }
}

export async function nativeClearNowPlaying(): Promise<void> {
  if (!isNativeNowPlayingAvailable()) return
  try {
    await nativeSetSeekSkipEnabled(false)
    await NowPlaying.clear()
  } catch (err) {
    console.warn('[NowPlaying] clear failed', err)
  }
}

let remoteHandle: PluginListenerHandle | null = null
let remoteHandlers: {
  play?: () => void
  pause?: () => void
  nexttrack?: () => void
  previoustrack?: () => void
  seekto?: (time: number) => void
  seekForward?: (seconds: number) => void
  seekBackward?: (seconds: number) => void
  like?: () => void
  bookmark?: () => void
} = {}

/** Enlaza botones de CarPlay / bloqueo / Centro de Control. */
export async function bindNativeRemoteControls(handlers: {
  play?: () => void
  pause?: () => void
  nexttrack?: () => void
  previoustrack?: () => void
  seekto?: (time: number) => void
  seekForward?: (seconds: number) => void
  seekBackward?: (seconds: number) => void
  like?: () => void
  bookmark?: () => void
}): Promise<void> {
  if (!isNativeNowPlayingAvailable()) return
  Object.keys(remoteHandlers).forEach((key) => {
    delete remoteHandlers[key as keyof typeof remoteHandlers]
  })
  remoteHandlers.play = handlers.play
  remoteHandlers.pause = handlers.pause
  remoteHandlers.nexttrack = handlers.nexttrack
  remoteHandlers.previoustrack = handlers.previoustrack
  remoteHandlers.seekto = handlers.seekto
  remoteHandlers.seekForward = handlers.seekForward
  remoteHandlers.seekBackward = handlers.seekBackward
  remoteHandlers.like = handlers.like
  remoteHandlers.bookmark = handlers.bookmark
  if (remoteHandle) return
  try {
    remoteHandle = await NowPlaying.addListener('remote', (event) => {
      switch (event.action) {
        case 'play':
          remoteHandlers.play?.()
          break
        case 'pause':
          if (shouldIgnoreRemotePause()) return
          remoteHandlers.pause?.()
          break
        case 'nexttrack':
          remoteHandlers.nexttrack?.()
          break
        case 'previoustrack':
          remoteHandlers.previoustrack?.()
          break
        case 'seekto':
          if (typeof event.seekTime === 'number') remoteHandlers.seekto?.(event.seekTime)
          break
        case 'seekforward': {
          const sec =
            typeof event.seekOffset === 'number' && event.seekOffset > 0
              ? event.seekOffset
              : 10
          remoteHandlers.seekForward?.(sec)
          break
        }
        case 'seekbackward': {
          const sec =
            typeof event.seekOffset === 'number' && event.seekOffset > 0
              ? event.seekOffset
              : 10
          remoteHandlers.seekBackward?.(sec)
          break
        }
        case 'like':
          remoteHandlers.like?.()
          break
        case 'bookmark':
          remoteHandlers.bookmark?.()
          break
      }
    })
  } catch {
    /* ignore */
  }
}
