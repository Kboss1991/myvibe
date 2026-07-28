import type { RadioStation } from './radios'

const UA = 'MyVibe/1.0'
const FALLBACK_SERVERS = [
  'https://de1.api.radio-browser.info',
  'https://nl1.api.radio-browser.info',
  'https://at1.api.radio-browser.info',
]

type RbStation = {
  stationuuid?: string
  name?: string
  url?: string
  url_resolved?: string
  favicon?: string
  country?: string
  countrycode?: string
  state?: string
  tags?: string
  language?: string
  bitrate?: number
  codec?: string
}

let cachedBase: string | null = null

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      // User-Agent no se puede forzar en el navegador; el servidor usa el UA del browser.
      'X-Radio-Browser-Client': UA,
    },
  })
  if (!res.ok) throw new Error(`Radio Browser HTTP ${res.status}`)
  return (await res.json()) as T
}

/** Elige un mirror de Radio Browser (cacheado). */
export async function getRadioBrowserBase(): Promise<string> {
  if (cachedBase) return cachedBase

  for (const base of FALLBACK_SERVERS) {
    try {
      await fetchJson<unknown>(`${base}/json/stats`)
      cachedBase = base
      return base
    } catch {
      // probar siguiente
    }
  }

  cachedBase = FALLBACK_SERVERS[0]!
  return cachedBase
}

function deriveGroup(countrycode?: string, tags?: string, state?: string): RadioStation['group'] {
  const code = (countrycode ?? '').toUpperCase()
  const tagStr = `${tags ?? ''} ${state ?? ''}`.toLowerCase()
  if (
    code === 'AD' ||
    /\bcatal(?:unya|an|à|a)\b/.test(tagStr) ||
    /\bcatalan\b/.test(tagStr) ||
    /\bcatalà\b/.test(tagStr)
  ) {
    return 'catalunya'
  }
  if (code === 'ES') return 'espana'
  return 'world'
}

function buildTagline(s: RbStation): string {
  const bits: string[] = []
  if (s.country) bits.push(s.country)
  const tags = (s.tags ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 2)
  if (tags.length) bits.push(tags.join(' · '))
  if (!bits.length && s.language) bits.push(s.language)
  return bits.join(' · ') || 'En directo'
}

export function mapRbStation(s: RbStation): RadioStation | null {
  const id = (s.stationuuid ?? '').trim()
  const streamUrl = (s.url_resolved || s.url || '').trim()
  const name = (s.name ?? '').trim()
  if (!id || !streamUrl || !name) return null
  if (!/^https?:\/\//i.test(streamUrl)) return null

  return {
    id,
    name,
    tagline: buildTagline(s),
    streamUrl,
    logoUrl: (s.favicon ?? '').trim(),
    group: deriveGroup(s.countrycode, s.tags, s.state),
  }
}

/** Busca emisoras por nombre en Radio Browser. */
export async function searchStations(query: string, limit = 30): Promise<RadioStation[]> {
  const q = query.trim()
  if (q.length < 2) return []

  const base = await getRadioBrowserBase()
  const params = new URLSearchParams({
    name: q,
    limit: String(limit),
    hidebroken: 'true',
    order: 'clickcount',
    reverse: 'true',
  })

  const raw = await fetchJson<RbStation[]>(`${base}/json/stations/search?${params}`)
  const seen = new Set<string>()
  const out: RadioStation[] = []
  for (const row of raw) {
    const mapped = mapRbStation(row)
    if (!mapped || seen.has(mapped.id)) continue
    seen.add(mapped.id)
    out.push(mapped)
  }
  return out
}

/** Cuenta un click (ayuda al ranking de Radio Browser). */
export function reportStationClick(stationuuid: string): void {
  const id = stationuuid.trim()
  if (!id) return
  void getRadioBrowserBase()
    .then((base) => fetch(`${base}/json/url/${encodeURIComponent(id)}`, { method: 'GET' }))
    .catch(() => {
      // ignore
    })
}
