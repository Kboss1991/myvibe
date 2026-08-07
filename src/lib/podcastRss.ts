import type { PodcastEpisode, PodcastShow } from './podcasts'

function textOf(el: Element | null): string {
  return (el?.textContent || '').trim()
}

function attr(el: Element | null, name: string): string {
  return (el?.getAttribute(name) || '').trim()
}

function firstChild(parent: Element, names: string[]): Element | null {
  for (const name of names) {
    const local = name.includes(':') ? name.split(':')[1]! : name
    const found =
      parent.querySelector(`:scope > ${name}`) ||
      [...parent.children].find(
        (c) => c.localName === local || c.tagName.toLowerCase() === name.toLowerCase(),
      )
    if (found) return found
  }
  return null
}

function parseDuration(raw: string): number {
  const t = raw.trim()
  if (!t) return 0
  if (/^\d+$/.test(t)) return Number(t)
  const parts = t.split(':').map((p) => Number(p))
  if (parts.some((n) => !Number.isFinite(n))) return 0
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!
  return 0
}

function episodeId(showId: string, audioUrl: string, title: string, pubDate: string): string {
  const key = `${audioUrl}|${title}|${pubDate}`
  let hash = 0
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0
  return `${showId}_${Math.abs(hash).toString(36)}`
}

function charsetFromContentType(ct: string | null): string | null {
  if (!ct) return null
  const m = /charset\s*=\s*["']?([^"';\s]+)/i.exec(ct)
  return m ? m[1]!.trim().toLowerCase() : null
}

function charsetFromXmlHead(bytes: Uint8Array): string | null {
  const head = new TextDecoder('ascii', { fatal: false }).decode(bytes.subarray(0, 256))
  const m = /encoding\s*=\s*["']\s*([^"']+)\s*["']/i.exec(head)
  return m ? m[1]!.trim().toLowerCase() : null
}

function normalizeCharset(raw: string | null | undefined): string {
  if (!raw) return 'utf-8'
  const c = raw.toLowerCase().replace(/_/g, '-')
  if (c === 'utf8') return 'utf-8'
  if (c === 'iso-8859-1' || c === 'latin1' || c === 'latin-1' || c === 'iso8859-1') {
    return 'iso-8859-1'
  }
  if (c === 'windows-1252' || c === 'cp1252' || c === 'win-1252') {
    return 'windows-1252'
  }
  return c
}

/** Decodifica el XML respetando ISO-8859-1 / Windows-1252 (feeds 3Cat, etc.). */
async function decodeFeedResponse(res: Response): Promise<string> {
  const buf = new Uint8Array(await res.arrayBuffer())
  if (!buf.byteLength) return ''
  const label = normalizeCharset(
    charsetFromContentType(res.headers.get('content-type')) ||
      charsetFromXmlHead(buf) ||
      'utf-8',
  )
  try {
    return new TextDecoder(label).decode(buf)
  } catch {
    return new TextDecoder('utf-8').decode(buf)
  }
}

async function fetchFeedXml(feedUrl: string): Promise<string> {
  try {
    const res = await fetch(feedUrl)
    if (res.ok) {
      const text = await decodeFeedResponse(res)
      if (text.trim()) return text
    }
  } catch {
    /* CORS u otro → proxy */
  }
  const proxied = `/api/rss-proxy?url=${encodeURIComponent(feedUrl)}`
  const res = await fetch(proxied)
  if (!res.ok) throw new Error(`No se pudo cargar el feed (${res.status})`)
  // El proxy ya reenvía UTF-8; decodeFeedResponse sigue siendo seguro
  const text = await decodeFeedResponse(res)
  if (!text.trim()) throw new Error('Feed vacío')
  return text
}

function parseRssItems(doc: Document, show: PodcastShow): PodcastEpisode[] {
  const channel = doc.querySelector('channel')
  const channelArt =
    attr(channel?.querySelector('image url') || null, '') ||
    textOf(channel?.querySelector('image url') || null) ||
    attr(doc.querySelector('itunes\\:image, image'), 'href') ||
    show.artworkUrl

  const items = [...doc.querySelectorAll('channel > item, rss item')]
  const out: PodcastEpisode[] = []
  const seen = new Set<string>()

  for (const item of items) {
    const title = textOf(firstChild(item, ['title']))
    const enclosure =
      firstChild(item, ['enclosure']) || item.querySelector('enclosure')
    let audioUrl = attr(enclosure, 'url')
    if (!audioUrl) {
      const media = item.querySelector('media\\:content, content[url]')
      audioUrl = attr(media, 'url')
    }
    if (!audioUrl) continue
    if (!/^https?:\/\//i.test(audioUrl)) continue

    const pubDate = textOf(firstChild(item, ['pubDate', 'published']))
    const description =
      textOf(firstChild(item, ['description', 'content:encoded', 'summary'])) || ''
    const durationEl = [...item.children].find(
      (c) => c.localName === 'duration' || c.tagName.toLowerCase().endsWith(':duration'),
    )
    const durationRaw = textOf(durationEl || null) || attr(enclosure, 'length')
    const durationSec = parseDuration(durationRaw)
    const imageEl = [...item.children].find(
      (c) => c.localName === 'image' || c.tagName.toLowerCase().endsWith(':image'),
    )
    const thumbEl = [...item.children].find(
      (c) =>
        c.localName === 'thumbnail' || c.tagName.toLowerCase().endsWith(':thumbnail'),
    )
    const art =
      attr(imageEl || null, 'href') ||
      attr(thumbEl || null, 'url') ||
      channelArt ||
      show.artworkUrl

    const id = episodeId(show.id, audioUrl, title, pubDate)
    if (seen.has(id)) continue
    seen.add(id)

    out.push({
      id,
      showId: show.id,
      title: title || 'Episodio',
      description,
      audioUrl,
      pubDate,
      durationSec,
      artworkUrl: art,
    })
  }
  return out
}

function parseAtomEntries(doc: Document, show: PodcastShow): PodcastEpisode[] {
  const entries = [...doc.querySelectorAll('entry')]
  const out: PodcastEpisode[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    const title = textOf(firstChild(entry, ['title']))
    const links = [...entry.querySelectorAll('link')]
    const audio =
      links.find((l) => /^audio\//i.test(attr(l, 'type'))) ||
      links.find((l) => /enclosure/i.test(attr(l, 'rel')))
    const audioUrl = attr(audio ?? null, 'href')
    if (!audioUrl || !/^https?:\/\//i.test(audioUrl)) continue
    const pubDate = textOf(firstChild(entry, ['published', 'updated']))
    const description = textOf(firstChild(entry, ['summary', 'content'])) || ''
    const id = episodeId(show.id, audioUrl, title, pubDate)
    if (seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      showId: show.id,
      title: title || 'Episodio',
      description,
      audioUrl,
      pubDate,
      durationSec: 0,
      artworkUrl: show.artworkUrl,
    })
  }
  return out
}

/** Carga y parsea el RSS/Atom de un podcast. */
export async function fetchPodcastEpisodes(show: PodcastShow): Promise<PodcastEpisode[]> {
  const xml = await fetchFeedXml(show.feedUrl)
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.querySelector('parsererror')) {
    throw new Error('Feed RSS no válido')
  }
  const rss = parseRssItems(doc, show)
  if (rss.length) return rss
  return parseAtomEntries(doc, show)
}

export type LatestPodcastItem = {
  episode: PodcastEpisode
  show: PodcastShow
}

const HOME_LATEST_CACHE_KEY = 'myvibe_home_podcast_latest'
const HOME_LATEST_TTL_MS = 12 * 60 * 1000

function pubTime(isoOrRss: string): number {
  const t = Date.parse(isoOrRss)
  return Number.isFinite(t) ? t : 0
}

/**
 * Episodios más nuevos de los podcasts guardados (1–2 por show), ordenados por fecha.
 * Cache corto en sessionStorage para no martillar feeds en cada visita a Inicio.
 */
export async function fetchLatestFromMyPodcasts(
  shows: PodcastShow[],
  limit = 12,
): Promise<LatestPodcastItem[]> {
  if (!shows.length) return []

  try {
    const raw = sessionStorage.getItem(HOME_LATEST_CACHE_KEY)
    if (raw) {
      const cached = JSON.parse(raw) as {
        at: number
        showIds: string[]
        items: LatestPodcastItem[]
      }
      const ids = shows.map((s) => s.id).join(',')
      if (
        cached &&
        Array.isArray(cached.items) &&
        cached.showIds?.join(',') === ids &&
        Date.now() - cached.at < HOME_LATEST_TTL_MS
      ) {
        return cached.items.slice(0, limit)
      }
    }
  } catch {
    /* ignore */
  }

  const perShow = Math.max(1, Math.ceil(limit / Math.max(1, shows.length)))
  const settled = await Promise.allSettled(
    shows.map(async (show) => {
      const eps = await fetchPodcastEpisodes(show)
      return eps.slice(0, Math.min(3, perShow + 1)).map((episode) => ({ episode, show }))
    }),
  )

  const merged: LatestPodcastItem[] = []
  for (const r of settled) {
    if (r.status === 'fulfilled') merged.push(...r.value)
  }

  merged.sort((a, b) => pubTime(b.episode.pubDate) - pubTime(a.episode.pubDate))
  const items = merged.slice(0, limit)

  try {
    sessionStorage.setItem(
      HOME_LATEST_CACHE_KEY,
      JSON.stringify({
        at: Date.now(),
        showIds: shows.map((s) => s.id),
        items,
      }),
    )
  } catch {
    /* ignore */
  }

  return items
}
