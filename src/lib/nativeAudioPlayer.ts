import { Directory, Filesystem } from '@capacitor/filesystem'
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import { buildLockScreenArtwork } from './mediaSession'
import { isNativeApp } from './nativeAudioFs'

type NativeAudioPluginApi = {
  play(options: {
    url: string
    title?: string
    artist?: string
    album?: string
    artwork?: string
    position?: number
  }): Promise<void>
  pause(): Promise<void>
  resume(): Promise<void>
  stop(): Promise<void>
  seek(options: { position: number }): Promise<void>
  setMetadata(options: {
    title?: string
    artist?: string
    album?: string
    artwork?: string
  }): Promise<void>
  getStatus(): Promise<{
    playing: boolean
    position: number
    duration: number
    url?: string
  }>
  addListener(
    eventName: 'time' | 'ended' | 'state' | 'remote',
    listenerFunc: (event: Record<string, unknown>) => void,
  ): Promise<PluginListenerHandle>
}

const NativeAudio = registerPlugin<NativeAudioPluginApi>('NativeAudio')

export function isNativeAvPlayerAvailable(): boolean {
  return isNativeApp() && Capacitor.getPlatform() === 'ios'
}

function audioPath(id: string): string {
  return `myvibe/audio/${id}.bin`
}

function playCachePath(id: string): string {
  return `myvibe/play/${id}.mp3`
}

/** file:// URI para AVPlayer (no capacitor://). */
export async function resolveNativePlayFileUrl(trackId: string): Promise<string | null> {
  // Preferir copia en Documents (transfer Wi‑Fi / nativo)
  try {
    await Filesystem.stat({ path: audioPath(trackId), directory: Directory.Documents })
    const { uri } = await Filesystem.getUri({
      path: audioPath(trackId),
      directory: Directory.Documents,
    })
    if (uri) return uri
  } catch {
    /* fall through */
  }

  // Fallback: volcar blob a Cache como .mp3 para que AVPlayer lo lea
  const { getAudioBlob } = await import('./library')
  const blob = await getAudioBlob(trackId)
  if (!blob || blob.size < 64) return null

  const path = playCachePath(trackId)
  try {
    await Filesystem.mkdir({
      path: 'myvibe/play',
      directory: Directory.Cache,
      recursive: true,
    })
  } catch {
    /* exists */
  }
  try {
    await Filesystem.deleteFile({ path, directory: Directory.Cache })
  } catch {
    /* ignore */
  }

  const buf = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  const step = 0x8000
  for (let i = 0; i < buf.length; i += step) {
    binary += String.fromCharCode(...buf.subarray(i, Math.min(i + step, buf.length)))
  }
  await Filesystem.writeFile({
    path,
    data: btoa(binary),
    directory: Directory.Cache,
    recursive: true,
  })
  const { uri } = await Filesystem.getUri({ path, directory: Directory.Cache })
  return uri || null
}

function pickArtworkDataUrl(artwork: MediaImage[] | undefined): string | undefined {
  if (!artwork?.length) return undefined
  const data = artwork.find((a) => a.src?.startsWith('data:'))
  return data?.src
}

let listenersReady = false
let timeHandle: PluginListenerHandle | null = null
let endedHandle: PluginListenerHandle | null = null
let stateHandle: PluginListenerHandle | null = null
let remoteHandle: PluginListenerHandle | null = null

export type NativeAudioHandlers = {
  onTime?: (position: number, duration: number, playing: boolean) => void
  onEnded?: () => void
  onState?: (playing: boolean) => void
  onRemote?: (action: string, seekTime?: number) => void
}

export async function bindNativeAudioListeners(handlers: NativeAudioHandlers): Promise<void> {
  if (!isNativeAvPlayerAvailable()) return
  if (listenersReady) {
    await timeHandle?.remove().catch(() => undefined)
    await endedHandle?.remove().catch(() => undefined)
    await stateHandle?.remove().catch(() => undefined)
    await remoteHandle?.remove().catch(() => undefined)
  }
  timeHandle = await NativeAudio.addListener('time', (e) => {
    handlers.onTime?.(
      Number(e.position) || 0,
      Number(e.duration) || 0,
      Boolean(e.playing),
    )
  })
  endedHandle = await NativeAudio.addListener('ended', () => {
    handlers.onEnded?.()
  })
  stateHandle = await NativeAudio.addListener('state', (e) => {
    handlers.onState?.(Boolean(e.playing))
  })
  remoteHandle = await NativeAudio.addListener('remote', (e) => {
    handlers.onRemote?.(
      String(e.action || ''),
      typeof e.seekTime === 'number' ? e.seekTime : undefined,
    )
  })
  listenersReady = true
}

export async function nativeAvPlay(opts: {
  trackId: string
  title: string
  artist: string
  album: string
  position?: number
}): Promise<boolean> {
  if (!isNativeAvPlayerAvailable()) return false
  const url = await resolveNativePlayFileUrl(opts.trackId)
  if (!url) return false

  let artwork: string | undefined
  try {
    const images = await buildLockScreenArtwork(opts.trackId)
    artwork = pickArtworkDataUrl(images)
  } catch {
    /* ignore */
  }

  try {
    await NativeAudio.play({
      url,
      title: opts.title,
      artist: opts.artist || 'MyVibe',
      album: opts.album || 'MyVibe',
      artwork,
      position: opts.position ?? 0,
    })
    return true
  } catch (err) {
    console.warn('[NativeAudio] play failed', err)
    return false
  }
}

export async function nativeAvPause(): Promise<void> {
  if (!isNativeAvPlayerAvailable()) return
  try {
    await NativeAudio.pause()
  } catch (err) {
    console.warn('[NativeAudio] pause failed', err)
  }
}

export async function nativeAvResume(): Promise<void> {
  if (!isNativeAvPlayerAvailable()) return
  try {
    await NativeAudio.resume()
  } catch (err) {
    console.warn('[NativeAudio] resume failed', err)
  }
}

export async function nativeAvStop(): Promise<void> {
  if (!isNativeAvPlayerAvailable()) return
  try {
    await NativeAudio.stop()
  } catch (err) {
    console.warn('[NativeAudio] stop failed', err)
  }
}

export async function nativeAvSeek(position: number): Promise<void> {
  if (!isNativeAvPlayerAvailable()) return
  try {
    await NativeAudio.seek({ position })
  } catch (err) {
    console.warn('[NativeAudio] seek failed', err)
  }
}
