import type { Track } from '../types'

export type ListenStats = {
  totalPlays: number
  uniqueTracksPlayed: number
  estimatedMinutes: number
  topArtists: { name: string; plays: number }[]
  topTracks: { id: string; title: string; artist: string; plays: number }[]
  streakDays: number
  lastListenAt: number | null
}

function dayKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

export function computeListenStats(tracks: Track[]): ListenStats {
  const played = tracks.filter((t) => t.playCount > 0 || t.lastPlayedAt)
  let totalPlays = 0
  let estimatedSec = 0
  const artistMap = new Map<string, number>()

  for (const t of played) {
    const plays = Math.max(0, t.playCount || 0)
    totalPlays += plays
    estimatedSec += plays * (t.duration > 0 ? t.duration : 180)
    const artist = (t.artist || 'Desconocido').trim() || 'Desconocido'
    artistMap.set(artist, (artistMap.get(artist) || 0) + plays)
  }

  const topArtists = [...artistMap.entries()]
    .map(([name, plays]) => ({ name, plays }))
    .sort((a, b) => b.plays - a.plays)
    .slice(0, 5)

  const topTracks = [...played]
    .sort((a, b) => b.playCount - a.playCount)
    .slice(0, 5)
    .map((t) => ({
      id: t.id,
      title: t.title,
      artist: t.artist,
      plays: t.playCount,
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
