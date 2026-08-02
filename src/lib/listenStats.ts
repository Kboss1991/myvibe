import type { Track } from '../types'

export type TopArtistStat = {
  name: string
  plays: number
  minutes: number
  /** Pista representativa para portada */
  coverTrackId: string | null
  hasCover: boolean
  coverUpdatedAt?: number
}

export type TopTrackStat = {
  id: string
  title: string
  artist: string
  plays: number
  hasCover: boolean
  coverUpdatedAt?: number
}

export type ListenStats = {
  totalPlays: number
  uniqueTracksPlayed: number
  uniqueArtists: number
  estimatedMinutes: number
  topArtists: TopArtistStat[]
  topTracks: TopTrackStat[]
  streakDays: number
  lastListenAt: number | null
}

function dayKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

function artistKey(name: string): string {
  return name.trim().toLocaleLowerCase('es')
}

/** Prefiere el nombre con más plays; en empate, el que tenga mayúsculas. */
function preferArtistLabel(current: string, candidate: string, candidatePlays: number, currentBest: number): string {
  if (candidatePlays > currentBest) return candidate
  if (candidatePlays < currentBest) return current
  const score = (s: string) => (/[A-ZÁÉÍÓÚÑ]/.test(s) ? 1 : 0) + (s !== s.toLowerCase() ? 1 : 0)
  return score(candidate) >= score(current) ? candidate : current
}

export function computeListenStats(tracks: Track[]): ListenStats {
  const played = tracks.filter((t) => t.playCount > 0 || t.lastPlayedAt)
  let totalPlays = 0
  let estimatedSec = 0
  const artistMap = new Map<
    string,
    {
      name: string
      plays: number
      seconds: number
      coverTrackId: string | null
      hasCover: boolean
      coverUpdatedAt?: number
      bestPlays: number
      labelBestPlays: number
    }
  >()

  for (const t of played) {
    const plays = Math.max(0, t.playCount || 0)
    const duration = t.duration > 0 ? t.duration : 180
    totalPlays += plays
    estimatedSec += plays * duration
    const artist = (t.artist || 'Desconocido').trim() || 'Desconocido'
    const key = artistKey(artist)
    const prev = artistMap.get(key)
    const seconds = plays * duration
    if (!prev) {
      artistMap.set(key, {
        name: artist,
        plays,
        seconds,
        coverTrackId: t.id,
        hasCover: Boolean(t.hasCover),
        coverUpdatedAt: t.coverUpdatedAt,
        bestPlays: plays,
        labelBestPlays: plays,
      })
    } else {
      prev.name = preferArtistLabel(prev.name, artist, plays, prev.labelBestPlays)
      if (plays >= prev.labelBestPlays) prev.labelBestPlays = plays
      prev.plays += plays
      prev.seconds += seconds
      if (plays > prev.bestPlays || (plays === prev.bestPlays && t.hasCover && !prev.hasCover)) {
        prev.coverTrackId = t.id
        prev.hasCover = Boolean(t.hasCover)
        prev.coverUpdatedAt = t.coverUpdatedAt
        prev.bestPlays = plays
      }
    }
  }

  const topArtists = [...artistMap.values()]
    .map((a) => {
      const minutes =
        a.plays <= 0 ? 0 : Math.max(1, Math.round(a.seconds / 60))
      return {
        name: a.name,
        plays: a.plays,
        minutes,
        coverTrackId: a.coverTrackId,
        hasCover: a.hasCover,
        coverUpdatedAt: a.coverUpdatedAt,
      }
    })
    .sort((a, b) => b.plays - a.plays || b.minutes - a.minutes)
    .slice(0, 5)

  const topTracks = [...played]
    .sort((a, b) => b.playCount - a.playCount)
    .slice(0, 5)
    .map((t) => ({
      id: t.id,
      title: t.title,
      artist: t.artist,
      plays: t.playCount,
      hasCover: Boolean(t.hasCover),
      coverUpdatedAt: t.coverUpdatedAt,
    }))

  const listenDays = new Set(
    played
      .map((t) => t.lastPlayedAt)
      .filter((x): x is number => typeof x === 'number' && x > 0)
      .map(dayKey),
  )

  let streakDays = 0
  const cursor = new Date()
  for (;;) {
    const key = dayKey(cursor.getTime())
    if (!listenDays.has(key)) {
      if (streakDays === 0) {
        // permitir que hoy aún no haya plays: mira ayer
        cursor.setDate(cursor.getDate() - 1)
        if (!listenDays.has(dayKey(cursor.getTime()))) break
        streakDays = 1
        cursor.setDate(cursor.getDate() - 1)
        continue
      }
      break
    }
    streakDays += 1
    cursor.setDate(cursor.getDate() - 1)
    if (streakDays > 365) break
  }

  const lastListenAt =
    played.reduce<number | null>((max, t) => {
      if (!t.lastPlayedAt) return max
      return max == null || t.lastPlayedAt > max ? t.lastPlayedAt : max
    }, null)

  return {
    totalPlays,
    uniqueTracksPlayed: played.length,
    uniqueArtists: artistMap.size,
    estimatedMinutes: Math.round(estimatedSec / 60),
    topArtists,
    topTracks,
    streakDays,
    lastListenAt,
  }
}

export function formatListenMinutes(mins: number): string {
  if (mins < 60) return `${mins} min`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m ? `${h} h ${m} min` : `${h} h`
}

export function formatStatsMonthLabel(date = new Date()): string {
  const raw = new Intl.DateTimeFormat('es-ES', { month: 'long', year: 'numeric' }).format(date)
  return raw.charAt(0).toUpperCase() + raw.slice(1)
}

export function formatPlayCountLabel(plays: number): string {
  return plays === 1 ? '1 reproducción' : `${plays} reproducciones`
}
