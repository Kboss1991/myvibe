export type PodcastShow = {
  id: string
  name: string
  artist: string
  feedUrl: string
  artworkUrl: string
  genre?: string
}

export type PodcastEpisode = {
  id: string
  showId: string
  title: string
  description: string
  audioUrl: string
  pubDate: string
  durationSec: number
  artworkUrl: string
}

const MY_PODCASTS_KEY = 'myvibe_my_podcasts'

const showCache = new Map<string, PodcastShow>()
const episodeCache = new Map<string, PodcastEpisode>()

function readMyPodcasts(): PodcastShow[] {
  try {
    const raw = localStorage.getItem(MY_PODCASTS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as PodcastShow[]
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (s) =>
        s &&
        typeof s.id === 'string' &&
        typeof s.name === 'string' &&
        typeof s.feedUrl === 'string',
    )
  } catch {
    return []
  }
}

function writeMyPodcasts(list: PodcastShow[]) {
  localStorage.setItem(MY_PODCASTS_KEY, JSON.stringify(list))
}

export function getMyPodcasts(): PodcastShow[] {
  return readMyPodcasts()
}

export function isMyPodcast(id: string): boolean {
  return readMyPodcasts().some((s) => s.id === id)
}

export function addMyPodcast(show: PodcastShow): PodcastShow[] {
  const list = readMyPodcasts()
  if (list.some((s) => s.id === show.id)) return list
  const next = [show, ...list]
  writeMyPodcasts(next)
  showCache.set(show.id, show)
  return next
}

export function removeMyPodcast(id: string): PodcastShow[] {
  const next = readMyPodcasts().filter((s) => s.id !== id)
  writeMyPodcasts(next)
  return next
}

export function rememberPodcastShow(show: PodcastShow) {
  showCache.set(show.id, show)
}

export function rememberPodcastEpisode(episode: PodcastEpisode) {
  episodeCache.set(episode.id, episode)
}

export function getPodcastShow(id: string | null | undefined): PodcastShow | null {
  if (!id) return null
  return readMyPodcasts().find((s) => s.id === id) ?? showCache.get(id) ?? null
}

export function getPodcastEpisode(id: string | null | undefined): PodcastEpisode | null {
  if (!id) return null
  return episodeCache.get(id) ?? null
}

export function formatEpisodeDate(isoOrRss: string): string {
  if (!isoOrRss) return ''
  const d = new Date(isoOrRss)
  if (Number.isNaN(d.getTime())) return isoOrRss
  return d.toLocaleDateString('es-ES', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

export function formatEpisodeDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return ''
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  if (h > 0) return `${h} h ${m} min`
  if (m > 0) return `${m} min`
  return `${r} s`
}

/** Progreso de escucha por episodio (localStorage). */
export type PodcastProgress = {
  position: number
  duration: number
  completed: boolean
  updatedAt: number
}

const PROGRESS_KEY = 'myvibe_podcast_progress'
/** Completado si quedan ≤15 s o ≥95 % del episodio. */
const COMPLETE_REMAIN_SEC = 15
const COMPLETE_RATIO = 0.95

type ProgressMap = Record<string, PodcastProgress>

function readProgressMap(): ProgressMap {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as ProgressMap
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed
  } catch {
    return {}
  }
}

function writeProgressMap(map: ProgressMap) {
  localStorage.setItem(PROGRESS_KEY, JSON.stringify(map))
}

export function getPodcastProgress(episodeId: string): PodcastProgress | null {
  const entry = readProgressMap()[episodeId]
  if (!entry || typeof entry !== 'object') return null
  return {
    position: Number(entry.position) || 0,
    duration: Number(entry.duration) || 0,
    completed: Boolean(entry.completed),
    updatedAt: Number(entry.updatedAt) || 0,
  }
}

export function isPodcastCompleted(episodeId: string): boolean {
  return Boolean(getPodcastProgress(episodeId)?.completed)
}

export type PodcastListenState = 'unplayed' | 'in_progress' | 'completed'

export function getPodcastListenState(episodeId: string): PodcastListenState {
  const p = getPodcastProgress(episodeId)
  if (!p) return 'unplayed'
  if (p.completed) return 'completed'
  if (p.position >= 5) return 'in_progress'
  return 'unplayed'
}

/** 0–1 para la barra de progreso (0 si no hay avance o está completado). */
export function getPodcastProgressRatio(
  episodeId: string,
  fallbackDuration = 0,
): number {
  const p = getPodcastProgress(episodeId)
  if (!p || p.completed) return 0
  const dur =
    p.duration > 0 ? p.duration : fallbackDuration > 0 ? fallbackDuration : 0
  if (dur <= 0 || p.position < 5) return 0
  return Math.min(1, Math.max(0, p.position / dur))
}

/** Segundos desde los que reanudar (0 si no hay o ya está escuchado). */
export function getPodcastResumeAt(episodeId: string): number {
  const p = getPodcastProgress(episodeId)
  if (!p || p.completed) return 0
  if (!Number.isFinite(p.position) || p.position < 5) return 0
  // Si estaba casi al final, no reanudar ahí
  if (p.duration > 0 && p.position >= p.duration - COMPLETE_REMAIN_SEC) return 0
  return p.position
}

function isCompletePosition(position: number, duration: number): boolean {
  if (!Number.isFinite(position) || position <= 0) return false
  if (Number.isFinite(duration) && duration > 30) {
    if (position >= duration - COMPLETE_REMAIN_SEC) return true
    if (position / duration >= COMPLETE_RATIO) return true
  }
  return false
}

/** Guarda progreso; marca completed si corresponde. */
export function savePodcastProgress(
  episodeId: string,
  position: number,
  duration: number,
): PodcastProgress {
  const map = readProgressMap()
  const prev = map[episodeId]
  const dur = Number.isFinite(duration) && duration > 0 ? duration : prev?.duration || 0
  const pos = Math.max(0, Number.isFinite(position) ? position : 0)
  const completed = Boolean(prev?.completed) || isCompletePosition(pos, dur)
  const next: PodcastProgress = {
    position: completed ? 0 : pos,
    duration: dur,
    completed,
    updatedAt: Date.now(),
  }
  map[episodeId] = next
  writeProgressMap(map)
  return next
}

export function markPodcastCompleted(episodeId: string): PodcastProgress {
  const map = readProgressMap()
  const prev = map[episodeId]
  const next: PodcastProgress = {
    position: 0,
    duration: prev?.duration || 0,
    completed: true,
    updatedAt: Date.now(),
  }
  map[episodeId] = next
  writeProgressMap(map)
  return next
}

/** Texto corto para la lista (p. ej. «12 min restantes»). */
export function formatPodcastProgressHint(episodeId: string): string {
  const p = getPodcastProgress(episodeId)
  if (!p) return ''
  if (p.completed) return 'Escuchado'
  if (p.position < 5) return ''
  if (p.duration > p.position) {
    const left = Math.max(0, p.duration - p.position)
    const hint = formatEpisodeDuration(left)
    return hint ? `${hint} restantes` : ''
  }
  return 'En curso'
}
