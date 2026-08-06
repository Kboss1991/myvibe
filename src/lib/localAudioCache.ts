/**
 * Audio local servido por same-origin URL + Service Worker (Range / 206).
 * iOS Safari silencia el decodificador si pause/resume no puede hacer Range.
 */
export const LOCAL_AUDIO_CACHE = 'myvibe-local-audio-v1'
export const LOCAL_AUDIO_PREFIX = '/local-audio/'

export function localAudioPath(trackId: string): string {
  return `${LOCAL_AUDIO_PREFIX}${encodeURIComponent(trackId)}`
}

export function localAudioUrl(trackId: string): string {
  if (typeof location === 'undefined') return localAudioPath(trackId)
  return `${location.origin}${localAudioPath(trackId)}`
}

/** Guarda el blob en Cache Storage para que el SW pueda responder Range. */
export async function putLocalAudioInCache(
  trackId: string,
  blob: Blob,
): Promise<string | null> {
  if (typeof caches === 'undefined') return null
  try {
    const cache = await caches.open(LOCAL_AUDIO_CACHE)
    const url = localAudioUrl(trackId)
    const type = (blob.type || 'audio/mpeg').trim() || 'audio/mpeg'
    const headers = new Headers({
      'Content-Type': type,
      'Content-Length': String(blob.size),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=31536000, immutable',
    })
    await cache.put(url, new Response(blob.slice(0, blob.size, type), { headers }))
    return localAudioPath(trackId)
  } catch {
    return null
  }
}

export async function deleteLocalAudioFromCache(trackId: string): Promise<void> {
  if (typeof caches === 'undefined') return
  try {
    const cache = await caches.open(LOCAL_AUDIO_CACHE)
    await cache.delete(localAudioUrl(trackId))
    await cache.delete(localAudioPath(trackId))
  } catch {
    /* ignore */
  }
}
