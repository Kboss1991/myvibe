import type { PodcastShow } from './podcasts'

type ITunesPodcastResult = {
  collectionId?: number
  trackId?: number
  collectionName?: string
  trackName?: string
  artistName?: string
  feedUrl?: string
  artworkUrl600?: string
  artworkUrl100?: string
  primaryGenreName?: string
}

function artworkOf(item: ITunesPodcastResult): string {
  return (item.artworkUrl600 || item.artworkUrl100 || '').trim()
}

export function showFromITunes(item: ITunesPodcastResult): PodcastShow | null {
  const feedUrl = (item.feedUrl || '').trim()
  if (!feedUrl) return null
  const id = String(item.collectionId || item.trackId || '')
  if (!id) return null
  const name = (item.collectionName || item.trackName || 'Podcast').trim()
  return {
    id,
    name,
    artist: (item.artistName || '').trim(),
    feedUrl,
    artworkUrl: artworkOf(item),
    genre: (item.primaryGenreName || '').trim() || undefined,
  }
}

/** Busca podcasts por nombre vía iTunes Search API (store España). */
export async function searchPodcasts(term: string, limit = 24): Promise<PodcastShow[]> {
  const q = term.trim()
  if (!q) return []
  const url =
    `https://itunes.apple.com/search?term=${encodeURIComponent(q)}` +
    `&media=podcast&entity=podcast&country=ES&limit=${Math.min(50, Math.max(1, limit))}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`iTunes HTTP ${res.status}`)
  const data = (await res.json()) as { results?: ITunesPodcastResult[] }
  const out: PodcastShow[] = []
  const seenIds = new Set<string>()
  const seenFeeds = new Set<string>()
  for (const item of data.results ?? []) {
    const show = showFromITunes(item)
    if (!show) continue
    const feedKey = show.feedUrl.replace(/\/+$/, '').toLowerCase()
    if (seenIds.has(show.id) || seenFeeds.has(feedKey)) continue
    seenIds.add(show.id)
    seenFeeds.add(feedKey)
    out.push(show)
  }
  return out
}
