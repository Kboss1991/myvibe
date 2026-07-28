import type { Track } from '../types'

export function normTrackText(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function baseFileName(fileName: string): string {
  let n = fileName.replace(/\.[a-z0-9]{2,5}$/i, '')
  n = n.replace(/^myvibe\s*[-–—]?\s*/i, '')
  return normTrackText(n)
}

export type TrackLike = {
  id?: string
  title: string
  artist: string
  duration?: number
  fileName?: string
  hasLocalAudio?: boolean
}

/** Claves de contenido para detectar la misma canción con distinto id. */
export function trackContentKeys(t: TrackLike): string[] {
  const dur = Math.round(Number(t.duration) || 0)
  const keys: string[] = []
  const file = baseFileName(t.fileName || '')
  if (file) {
    // Siempre sin duración (stubs a menudo tienen duration 0)
    keys.push(`file:${file}`)
    if (dur > 0) keys.push(`file:${file}|${dur}`)
  }
  const artist = normTrackText(t.artist || '')
  const title = normTrackText(t.title || '')
  if (title) {
    keys.push(`meta:${artist}|${title}`)
    keys.push(`title:${title}`)
    if (dur > 0) keys.push(`meta:${artist}|${title}|${dur}`)
  }
  return [...new Set(keys.filter(Boolean))]
}

export function tracksLookSame(a: TrackLike, b: TrackLike): boolean {
  const kb = new Set(trackContentKeys(b))
  return trackContentKeys(a).some((k) => kb.has(k))
}

/** Busca en una lista la mejor coincidencia por título/artista/archivo. */
export function findBestTrackMatch<T extends TrackLike>(
  list: T[],
  probe: TrackLike,
): T | null {
  if (!list.length) return null
  const exact = list.find((t) => tracksLookSame(t, probe))
  if (exact) return exact

  const wantTitle = normTrackText(probe.title || '')
  const wantArtist = normTrackText(probe.artist || '')
  const wantFile = baseFileName(probe.fileName || '')
  if (!wantTitle && !wantFile) return null

  let best: T | null = null
  let bestScore = 0
  for (const t of list) {
    if (t.hasLocalAudio === false) continue
    const title = normTrackText(t.title || '')
    const artist = normTrackText(t.artist || '')
    const file = baseFileName(t.fileName || '')
    let score = 0
    if (wantFile && file && (file === wantFile || file.includes(wantFile) || wantFile.includes(file))) {
      score += 80
    }
    if (wantTitle && title) {
      if (title === wantTitle) score += 70
      else if (title.includes(wantTitle) || wantTitle.includes(title)) score += 45
    }
    if (wantArtist && artist) {
      if (artist === wantArtist) score += 40
      else if (artist.includes(wantArtist) || wantArtist.includes(artist)) score += 20
    }
    if (score > bestScore) {
      bestScore = score
      best = t
    }
  }
  // Exige al menos título o archivo razonablemente igual
  return bestScore >= 70 ? best : null
}

/** Elige qué copia conservar: audio local > carátula > likes > más antigua. */
export function pickCanonicalTrack(group: Track[]): Track {
  return [...group].sort((a, b) => {
    const audioA = a.hasLocalAudio !== false ? 1 : 0
    const audioB = b.hasLocalAudio !== false ? 1 : 0
    if (audioA !== audioB) return audioB - audioA
    if (Number(a.hasCover) !== Number(b.hasCover)) return Number(b.hasCover) - Number(a.hasCover)
    if (Number(a.liked) !== Number(b.liked)) return Number(b.liked) - Number(a.liked)
    if ((a.playCount || 0) !== (b.playCount || 0)) return (b.playCount || 0) - (a.playCount || 0)
    return (a.createdAt || 0) - (b.createdAt || 0)
  })[0]!
}

export function groupDuplicateTracks(tracks: Track[]): Track[][] {
  const parent = new Map<string, string>()
  const find = (id: string): string => {
    const p = parent.get(id)
    if (!p || p === id) {
      parent.set(id, id)
      return id
    }
    const root = find(p)
    parent.set(id, root)
    return root
  }
  const union = (a: string, b: string) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(rb, ra)
  }

  for (const t of tracks) parent.set(t.id, t.id)

  const keyToId = new Map<string, string>()
  for (const t of tracks) {
    for (const key of trackContentKeys(t)) {
      // No unir solo por title: demasiado agresivo entre canciones homónimas
      if (key.startsWith('title:')) continue
      const prev = keyToId.get(key)
      if (prev) union(prev, t.id)
      else keyToId.set(key, t.id)
    }
  }

  const buckets = new Map<string, Track[]>()
  for (const t of tracks) {
    const root = find(t.id)
    const list = buckets.get(root) || []
    list.push(t)
    buckets.set(root, list)
  }
  return [...buckets.values()].filter((g) => g.length > 1)
}
