import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'

type PlaybackState = 'none' | 'paused' | 'playing'

export type NowPlayingRemoteAction =
  | 'play'
  | 'pause'
  | 'nexttrack'
  | 'previoustrack'
  | 'seekto'

export type NowPlayingRemoteEvent = {
  action: NowPlayingRemoteAction
  seekTime?: number
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
  clear(): Promise<void>
  addListener(
    eventName: 'remote',
    listenerFunc: (event: NowPlayingRemoteEvent) => void,
  ): Promise<PluginListenerHandle>
}

const NowPlaying = registerPlugin<NowPlayingPluginApi>('NowPlaying')

export function isNativeNowPlayingAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios'
}

/** Preferir JPEG data-URL (el nativo no puede leer blob:). */
export function pickNativeArtwork(artwork: MediaImage[] | undefined | null): MediaImage[] {
  if (!artwork?.length) return []
  const data = artwork.filter((a) => typeof a.src === 'string' && a.src.startsWith('data:'))
  if (data.length) {
    // Una sola imagen ~300–600px basta para Dynamic Island / bloqueo
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
  } catch {
    /* ignore */
  }
}

export async function nativeSetPlaybackState(playing: boolean | 'none'): Promise<void> {
  if (!isNativeNowPlayingAvailable()) return
  const playbackState: PlaybackState =
    playing === 'none' ? 'none' : playing ? 'playing' : 'paused'
  try {
    await NowPlaying.setPlaybackState({ playbackState })
  } catch {
    /* ignore */
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
  } catch {
    /* ignore */
  }
}

export async function nativeClearNowPlaying(): Promise<void> {
  if (!isNativeNowPlayingAvailable()) return
  try {
    await NowPlaying.clear()
  } catch {
    /* ignore */
  }
}

let remoteHandle: PluginListenerHandle | null = null

/** Enlaza botones de Dynamic Island / bloqueo a callbacks de la app. */
export async function bindNativeRemoteControls(handlers: {
  play?: () => void
  pause?: () => void
  nexttrack?: () => void
  previoustrack?: () => void
  seekto?: (time: number) => void
}): Promise<void> {
  if (!isNativeNowPlayingAvailable()) return
  try {
    await remoteHandle?.remove()
  } catch {
    /* ignore */
  }
  remoteHandle = null
  try {
    remoteHandle = await NowPlaying.addListener('remote', (event) => {
      switch (event.action) {
        case 'play':
          handlers.play?.()
          break
        case 'pause':
          handlers.pause?.()
          break
        case 'nexttrack':
          handlers.nexttrack?.()
          break
        case 'previoustrack':
          handlers.previoustrack?.()
          break
        case 'seekto':
          if (typeof event.seekTime === 'number') handlers.seekto?.(event.seekTime)
          break
      }
    })
  } catch {
    /* ignore */
  }
}
