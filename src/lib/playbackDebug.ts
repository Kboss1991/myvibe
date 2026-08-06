/** Log de pause/play (bloqueo) para diagnosticar en el móvil. */

export type AudibleVerdict = 'yes' | 'no' | 'likely' | 'unknown'

export type PlaybackDebugEntry = {
  t: number
  event: string
  paused?: boolean
  muted?: boolean
  rate?: number
  suspended?: boolean
  isPlaying?: boolean
  podcast?: boolean
  /** ¿Hay señal de audio real? (medidor o heurística) */
  audible?: AudibleVerdict
  detail?: string
}

const KEY = 'myvibe_playback_debug'
const MAX = 40

/** Debe coincidir con workbox cacheId — confirma que el móvil tiene el build nuevo. */
export const PLAYBACK_DEBUG_BUILD = 'myvibe-ms-stripped-20260806u'

export function logPlayback(
  event: string,
  extra?: {
    paused?: boolean
    muted?: boolean
    rate?: number
    suspended?: boolean
    isPlaying?: boolean
    podcast?: boolean
    audible?: AudibleVerdict
    detail?: string
  },
) {
  try {
    const entry: PlaybackDebugEntry = {
      t: Date.now(),
      event,
      ...extra,
    }
    const raw = localStorage.getItem(KEY)
    const prev: PlaybackDebugEntry[] = raw ? (JSON.parse(raw) as PlaybackDebugEntry[]) : []
    prev.unshift(entry)
    localStorage.setItem(KEY, JSON.stringify(prev.slice(0, MAX)))
  } catch {
    /* ignore */
  }
}

export function getPlaybackDebugLog(): PlaybackDebugEntry[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as PlaybackDebugEntry[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function clearPlaybackDebugLog() {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
}

export function formatPlaybackDebugLine(e: PlaybackDebugEntry): string {
  const time = new Date(e.t).toLocaleTimeString('es-ES', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const flags = [
    e.paused == null ? null : e.paused ? 'paused' : 'playing',
    e.muted ? 'muted' : null,
    e.suspended ? 'soft' : null,
    e.podcast ? 'pod' : null,
    e.rate != null ? `rate=${e.rate}` : null,
    e.isPlaying == null ? null : e.isPlaying ? 'uiPlay' : 'uiPause',
    e.audible ? `sounds=${e.audible}` : null,
  ]
    .filter(Boolean)
    .join(' ')
  return `${time} ${e.event}${flags ? ` [${flags}]` : ''}${e.detail ? ` — ${e.detail}` : ''}`
}
