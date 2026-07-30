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

async function fetchFeedXml(feedUrl: string): Promise<string> {
  try {
    const res = await fetch(feedUrl)
    if (res.ok) {
      const text = await res.text()
      if (text.trim()) return text
    }
  } catch {
    /* CORS u otro → proxy */
  }
  const proxied = `/api/rss-proxy?url=${encodeURIComponent(feedUrl)}`
  const res = await fetch(proxied)
  if (!res.ok) throw new Error(`No se pudo cargar el feed (${res.status})`)
  const text = await res.text()
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
