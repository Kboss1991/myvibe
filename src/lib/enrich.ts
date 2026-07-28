export interface OnlineTrackInfo {
  title: string
  artist: string
  album: string
  genre: string
  year: string
  coverUrl: string | null
  externalUrl: string
}

function cleanQuery(name: string): string {
  return name
    .replace(/\.[^.]+$/, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s*[-–—]\s*/g, ' - ')
    .replace(/\b(official|lyrics|audio|video|hd|hq|remaster(ed)?|prod\.?|ft\.?|feat\.?)\b/gi, ' ')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Quita sufijos tipo " - De 'La Bella y la Bestia'" para buscar el tema. */
export function coreSongTitle(name: string): string {
  return cleanQuery(
    name
      .replace(/\s*[-–—]\s*de\s+['«"][^'»"]+['»"]/gi, ' ')
      .replace(/\s+de\s+['«"][^'»"]+['»"]/gi, ' '),
  )
}

export function extractQuotedMovie(name: string): string {
  const m =
    name.match(/de\s+['«"]([^'»"]+)['»"]/i) ||
    name.match(/\(([^)]+)\)\s*$/)
  return m?.[1]?.trim() || ''
}

const DISNEY_MOVIE_EN: Record<string, string> = {
  'bella y la bestia': 'Beauty and the Beast',
  'la bella y la bestia': 'Beauty and the Beast',
  'rey leon': 'The Lion King',
  'el rey leon': 'The Lion King',
  'little mermaid': 'The Little Mermaid',
  'la sirenita': 'The Little Mermaid',
  frozen: 'Frozen',
  encanto: 'Encanto',
  moana: 'Moana',
  vaiana: 'Moana',
  mulan: 'Mulan',
  aladdin: 'Aladdin',
  coco: 'Coco',
  'toy story': 'Toy Story',
  intensemente: 'Inside Out',
  'inside out': 'Inside Out',
}

/** Títulos ES → EN frecuentes (OST Disney). */
const DISNEY_SONG_EN: Record<string, string> = {
  bella: 'Beauty and the Beast',
  'la bella y la bestia': 'Beauty and the Beast',
  'algo ahi': 'Something There',
  'algo ahí': 'Something There',
  gaston: 'Gaston',
  gastón: 'Gaston',
  'human again': 'Human Again',
  'haz de cuenta': 'Be Our Guest',
  'nuestra invitacion': 'Be Our Guest',
  'se nuestra invitada': 'Be Our Guest',
  'ciclo de la vida': 'Circle of Life',
  'el ciclo de la vida': 'Circle of Life',
  'hakuna matata': 'Hakuna Matata',
  'siento el amor': 'Can You Feel the Love Tonight',
  'un mundo ideal': 'A Whole New World',
  'bajo el mar': 'Under the Sea',
  'part of your world': 'Part of Your World',
  'reflejo': 'Reflection',
  'how far ill go': 'How Far Ill Go',
  'no hablare de eso': 'We Dont Talk About Bruno',
  'un poco loco': 'Un Poco Loco',
  'recuerda me': 'Remember Me',
  'let it go': 'Let It Go',
  'libre soy': 'Let It Go',
}

function disneyEnglishTitle(songName: string): string | null {
  const core = norm(coreSongTitle(songName))
  if (DISNEY_SONG_EN[core]) return DISNEY_SONG_EN[core]
  // Preferir coincidencia exacta / más larga (evitar que "bella" coma otros títulos)
  let best: string | null = null
  let bestLen = 0
  for (const [es, en] of Object.entries(DISNEY_SONG_EN)) {
    if (es.length < 5) {
      if (core === es && es.length > bestLen) {
        best = en
        bestLen = es.length
      }
      continue
    }
    if ((core === es || core.includes(es)) && es.length > bestLen) {
      best = en
      bestLen = es.length
    }
  }
  return best
}

function disneyEnglishMovie(movieOrText: string): string | null {
  const n = norm(movieOrText)
  for (const [es, en] of Object.entries(DISNEY_MOVIE_EN)) {
    if (n === es || n.includes(es)) return en
  }
  return null
}

/** Canciones muy buscadas: queries fijas + artistas preferidos. */
const KNOWN_TRACKS: {
  pattern: RegExp
  queries: string[]
  artists: string[]
  albums?: string[]
}[] = [
  {
    pattern: /\bwaka waka\b/,
    queries: [
      'Shakira Waka Waka This Time for Africa',
      'Waka Waka This Time for Africa Shakira',
      'Shakira Waka Waka',
    ],
    artists: ['shakira'],
  },
  {
    pattern: /\bun mundo ideal\b|\ba whole new world\b/,
    queries: [
      'A Whole New World Aladdin original soundtrack',
      'A Whole New World Brad Kane Lea Salonga',
      'Un Mundo Ideal Aladdin Disney',
      'A Whole New World Peabo Bryson Regina Belle',
    ],
    artists: ['brad kane', 'lea salonga', 'peabo bryson', 'regina belle'],
    albums: ['aladdin'],
  },
  {
    pattern: /\bhakuna matata\b/,
    queries: [
      'Hakuna Matata The Lion King original soundtrack',
      'Hakuna Matata El Rey Leon Disney',
    ],
    artists: ['nathan lane', 'erskine', 'jason rinker', 'joseph williams'],
    albums: ['lion king', 'rey leon'],
  },
  {
    pattern: /\b(el )?ciclo de la vida\b|\bcircle of life\b/,
    queries: [
      'Circle of Life The Lion King original soundtrack',
      'Circle of Life Carmen Twillie',
      'El Ciclo de la Vida El Rey Leon Disney',
    ],
    artists: ['carmen twillie', 'lebo m', 'lebom'],
    albums: ['lion king', 'rey leon'],
  },
  {
    pattern: /\bbella\b.*\bbestia\b|\bbeauty and the beast\b/,
    queries: [
      'Beauty and the Beast original motion picture soundtrack',
      'Beauty and the Beast Celine Dion Peabo Bryson',
      'La Bella y la Bestia Disney banda sonora',
    ],
    artists: ['celine dion', 'peabo bryson', 'angela lansbury', 'paige o hara'],
    albums: ['beauty and the beast', 'bella y la bestia'],
  },
]

function findKnownTrack(songName: string) {
  const n = norm(songName)
  return KNOWN_TRACKS.find((k) => k.pattern.test(n)) ?? null
}

export function isWrongKnownArtist(title: string, artist: string, album = ''): boolean {
  const known = findKnownTrack(title)
  if (!known) return false
  const blob = norm(`${artist} ${album}`)
  if (known.artists.some((a) => blob.includes(a))) return false
  // Álbum OST oficial de la película cuenta como válido
  if (
    known.albums?.some((al) => blob.includes(al)) &&
    /\b(soundtrack|banda sonora|walt disney|motion picture|original)\b/.test(blob)
  ) {
    return false
  }
  return true
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function isLowQualityRelease(artist: string, album: string, title = ''): boolean {
  const blob = norm(`${artist} ${album} ${title}`)
  if (
    /\b(karaoke|tribute|tributo|kids|ninos|nino|infantil|nursery|baby|bebes|super banda|banda de ninos|banda infantil|sing along|toddlers|children'?s? (choir|songs?|music)|musica para ninos|para dormir|canciones infantiles|cover band|piano tribute|castillo encantado|canciones de disney|canciones de peliculas|peliculas infantiles|exitos infantiles|super exitos|disney en espanol|disney kids|kids disney|bedtime songs|party kids|various artists kids|lo mejor de disney|disney para ninos|canciones disney|disney hits for kids|disney lullaby|lullaby|nanas|cuento musical|version infantil|cover infantil|kids party|baby shark|lo mejor de|exitos de oro|recopilacion|recopilatorio|temazos|para cantar|canta conmigo|sing with me|music for kids|kids hits)\b/.test(
      blob,
    )
  ) {
    return true
  }
  // “Canciones de …” genérico, salvo banda sonora oficial
  if (
    /\bcanciones de\b/.test(blob) &&
    !/\b(original (motion picture )?soundtrack|banda sonora original|walt disney records)\b/.test(
      blob,
    )
  ) {
    return true
  }
  return false
}

/**
 * Metadatos dudosos: portada/falta info, recopilatorios, o desajuste
 * título↔álbum (p. ej. “De 'El Rey León'” con álbum genérico).
 */
export function isDoubtfulMetadata(track: {
  title: string
  artist: string
  album: string
  genre?: string
  year?: string
  hasCover?: boolean
}): boolean {
  if (!track.hasCover) return true
  if (isLowQualityRelease(track.artist, track.album, track.title)) return true
  if (isWrongKnownArtist(track.title, track.artist, track.album)) return true

  const artist = norm(track.artist)
  const album = norm(track.album)
  const title = norm(track.title)
  const genre = norm(track.genre || '')
  const blob = `${artist} ${album}`

  // Recopilatorios / packs genéricos aunque no digan “infantil”
  if (
    /\b(canciones de|lo mejor de|grandes exitos|best of|greatest hits|hit collection|music collection|la mejor musica|temas de|versiones de|covers? de|exitos de|playlist oficial no oficial)\b/.test(
      blob,
    )
  ) {
    return true
  }

  // Artista = marca del álbum (típico de packs)
  if (artist && album && artist === album && artist.length > 12) return true

  // Varios artistas + álbum genérico
  if (
    /\b(various artists|varios artistas|varios|various)\b/.test(artist) &&
    /\b(canciones|exitos|hits|disney|infantil|kids|anime|serie|peliculas|movies)\b/.test(album)
  ) {
    return true
  }

  // El título cita película/serie y el álbum/artista no la reflejan
  const quoted =
    track.title.match(/de\s+['«"]([^'»"]+)['»"]/i) ||
    track.title.match(/\(([^)]*(?:rey|frozen|encanto|moana|naruto|piece|disney)[^)]*)\)/i)
  if (quoted?.[1]) {
    const movie = norm(quoted[1])
      .replace(/^(de|from|banda sonora|soundtrack)\s+/i, '')
      .trim()
    const tokens = movie.split(' ').filter((w) => w.length > 2)
    const meaningful = tokens.filter(
      (w) => !/^(the|el|la|los|las|de|del|una|un|and|y)$/.test(w),
    )
    if (meaningful.length > 0) {
      const mirrored = meaningful.filter((w) => blob.includes(w) || title.includes(w))
      // Si casi ninguna palabra de la película está en artista/álbum → dudoso
      if (mirrored.length < Math.ceil(meaningful.length * 0.5)) {
        // Excepción: OST oficial genérico Walt Disney Records
        if (!/\b(walt disney|original soundtrack|motion picture)\b/.test(blob)) {
          return true
        }
      }
    }
  }

  // Etiquetado Anime/Disney/Serie pero álbum suena a pack
  if (
    (genre === 'disney' || genre === 'anime' || genre === 'serie') &&
    /\b(canciones|exitos|hits|pack|mix|volumen|vol\b|infantil|kids|varios|various)\b/.test(blob)
  ) {
    return true
  }

  // Sin año tras enriquecer con artista vacío/genérico
  if (
    !track.year &&
    (!artist ||
      /\b(desconocido|unknown|various|varios)\b/.test(artist) ||
      artist === album)
  ) {
    return true
  }

  return false
}

function isOfficialDisneyOst(artist: string, album: string, title = ''): boolean {
  const blob = norm(`${artist} ${album} ${title}`)
  if (isLowQualityRelease(artist, album, title)) return false
  return /\b(original (motion picture )?soundtrack|walt disney records|disney|pixar|el rey leon|the lion king|frozen|encanto|moana)\b/.test(
    blob,
  ) && /\b(soundtrack|ost|motion picture|el rey leon|the lion king|walt disney)\b/.test(blob)
}

function scoreMatch(
  candidateTitle: string,
  candidateArtist: string,
  candidateAlbum: string,
  wantTitle: string,
  wantArtist: string,
  wantContext = '',
): number {
  const t = norm(candidateTitle)
  const a = norm(candidateArtist)
  const alb = norm(candidateAlbum)
  const wt = norm(wantTitle)
  const wa = norm(wantArtist)
  const ctx = norm(`${wantTitle} ${wantArtist} ${wantContext}`)
  const blob = `${t} ${a} ${alb}`
  if (!t || !wt) return 0

  let score = 0
  const junk = isLowQualityRelease(candidateArtist, candidateAlbum, candidateTitle)

  // Título: exacto > contenido > palabras (ignora palabras muy cortas)
  if (t === wt) score += 120
  else if (t.startsWith(wt) || wt.startsWith(t)) score += 90
  else if (t.includes(wt) || wt.includes(t)) score += 70
  else {
    const enWant =
      disneyEnglishTitle(wantTitle) ||
      disneyEnglishTitle(wantContext) ||
      disneyEnglishTitle(ctx)
    const ne = enWant ? norm(enWant) : ''
    if (ne && (t === ne || t.includes(ne) || ne.includes(t))) {
      score += 120
    } else {
      const tw = wt.split(' ').filter((w) => w.length > 2)
      if (!tw.length) return 0
      const hit = tw.filter((w) => t.includes(w)).length
      score += (hit / tw.length) * 60
      if (hit < Math.ceil(tw.length * 0.6)) score -= 40
    }
  }

  const known = findKnownTrack(`${wantTitle} ${wantContext}`)
  if (known) {
    if (known.artists.some((a) => blob.includes(a))) {
      score += 160
    } else {
      score -= 90
    }
    if (known.albums?.some((al) => alb.includes(al) || blob.includes(al))) {
      score += 60
    }
  }

  // Extrae "De 'El Rey León'" del título deseado como pista de álbum
  const fromMovie =
    wantTitle.match(/de\s+['"]([^'"]+)['"]/i) ||
    wantContext.match(/de\s+['"]([^'"]+)['"]/i)
  const movieHint = fromMovie ? norm(fromMovie[1]) : ''

  if (wa && !/desconocido|unknown|sin album/i.test(wa) && !isLowQualityRelease(wa, '', '')) {
    if (a === wa) score += 55
    else if (a.includes(wa) || wa.includes(a)) score += 35
    else score -= 25
  }

  // Recopilatorios infantiles / covers basura: rechazo fuerte
  if (junk) {
    score -= 220
  }

  // Bonus OST oficial (no compilaciones “canciones de Disney”)
  if (!junk && isOfficialDisneyOst(candidateArtist, candidateAlbum, candidateTitle)) {
    score += 50
  } else if (
    !junk &&
    /\b(original (motion picture )?soundtrack|ost|walt disney records|broadway|music from)\b/.test(blob)
  ) {
    score += 35
  }

  const lionKingCtx =
    /\b(rey leon|lion king|ciclo de la vida|circle of life|hakuna matata|siento el amor|can you feel the love|he lives in you|be prepared|nants ingonyama)\b/.test(
      ctx,
    ) || /\brey leon\b|\blion king\b/.test(movieHint)

  if (lionKingCtx) {
    if (
      !junk &&
      /\b(el rey leon|the lion king|original.*soundtrack|walt disney|carmen twillie|lebo m|lebom|elton john|hans zimmer|jason rinker|nathan lane|erskine walcott|matthew wilder|tim rice)\b/.test(
        blob,
      )
    ) {
      score += 110
    }
    if (/\b(el rey leon|the lion king)\b/.test(alb)) score += 40
    if (junk || /\b(castillo encantado|canciones de|peliculas infantiles)\b/.test(blob)) {
      score -= 180
    }
  }

  const beautyCtx =
    /\b(bella y la bestia|beauty and the beast|be our guest|algo ahi|something there|gaston)\b/.test(
      ctx,
    ) || /\bbella y la bestia\b|\bbeauty and the beast\b/.test(movieHint)

  if (beautyCtx) {
    if (
      !junk &&
      /\b(beauty and the beast|bella y la bestia|original.*soundtrack|walt disney|angela lansbury|celine dion|peabo bryson|paige o hara|robby benson|howard ashman|alan menken)\b/.test(
        blob,
      )
    ) {
      score += 110
    }
    if (/\b(beauty and the beast|bella y la bestia)\b/.test(alb)) score += 40
    if (junk) score -= 180
  }

  const aladdinCtx =
    /\b(aladdin|aladin|un mundo ideal|whole new world|mundo ideal)\b/.test(ctx) ||
    /\baladdin\b|\baladin\b/.test(movieHint)

  if (aladdinCtx) {
    if (
      !junk &&
      /\b(aladdin|a whole new world|brad kane|lea salonga|peabo bryson|regina belle|walt disney|original.*soundtrack)\b/.test(
        blob,
      )
    ) {
      score += 110
    }
    if (/\baladdin\b/.test(alb)) score += 40
    if (junk) score -= 180
  }

  const wakaCtx = /\bwaka waka\b/.test(ctx)
  if (wakaCtx) {
    if (/\bshakira\b/.test(blob)) score += 180
    else score -= 120
  }

  if (movieHint && !junk) {
    if (alb.includes(movieHint) || blob.includes(movieHint)) score += 45
    const enMovie = disneyEnglishMovie(movieHint)
    if (enMovie && blob.includes(norm(enMovie))) score += 50
  }

  if (!junk && /\bdisney\b|\bpixar\b/.test(ctx) && /\bdisney\b|\bpixar\b/.test(blob)) {
    score += 25
  }

  return score
}

function contextSearchHints(songName: string, hintArtist: string): string[] {
  const t = norm(`${songName} ${hintArtist}`)
  const hints: string[] = []
  const core = coreSongTitle(songName)
  const movie = extractQuotedMovie(songName)
  const enMovie = movie ? disneyEnglishMovie(movie) : disneyEnglishMovie(songName)
  const enSong = disneyEnglishTitle(songName)

  if (movie) {
    hints.push(`Disney ${movie} soundtrack`)
    hints.push(`${movie} original soundtrack`)
    if (enMovie) {
      hints.push(`${enMovie} original motion picture soundtrack`)
      hints.push(`Disney ${enMovie}`)
    }
  }

  if (enSong && enMovie) {
    hints.push(`${enSong} ${enMovie} Disney`)
    hints.push(`${enSong} original soundtrack`)
  } else if (enSong) {
    hints.push(`${enSong} Disney soundtrack`)
  }

  if (core && core !== cleanQuery(songName)) {
    hints.push(`${core} Disney soundtrack`)
  }

  if (
    /\b(rey leon|lion king|ciclo de la vida|circle of life|hakuna matata|siento el amor)\b/.test(t)
  ) {
    hints.push(
      'El Rey León original soundtrack Disney',
      'The Lion King original motion picture soundtrack',
    )
  }

  if (/\b(bella y la bestia|beauty and the beast)\b/.test(t)) {
    hints.push(
      'La Bella y la Bestia banda sonora original Disney',
      'Beauty and the Beast original motion picture soundtrack',
    )
  }

  if (/\b(un mundo ideal|whole new world|aladdin|aladin)\b/.test(t)) {
    hints.push(
      'A Whole New World Aladdin original soundtrack',
      'Un Mundo Ideal Aladdin Disney',
    )
  }

  if (/\bwaka waka\b/.test(t)) {
    hints.push('Shakira Waka Waka This Time for Africa')
  }

  if (
    /\b(frozen|encanto|moana|mulan|aladdin|coco|toy story|intensamente|inside out|sirenita|little mermaid)\b/.test(
      t,
    )
  ) {
    hints.push('Disney original soundtrack')
  } else if (/\bdisney\b|\bpixar\b/.test(t)) {
    hints.push('Disney original soundtrack')
  }

  if (/\banime\b|\bopening\b|\bending\b|\bost\b/.test(t)) {
    hints.push('anime soundtrack')
  }

  return hints
}

function buildQueries(songName: string, hintArtist: string): string[] {
  const q = cleanQuery(songName)
  const core = coreSongTitle(songName)
  if (!q && !core) return []
  const queries: string[] = []
  const known = findKnownTrack(songName)
  const artistOk = Boolean(
    hintArtist &&
      !/desconocido|unknown|sin álbum/i.test(hintArtist) &&
      !isLowQualityRelease(hintArtist, '', songName) &&
      !isWrongKnownArtist(songName, hintArtist),
  )
  const hints = contextSearchHints(songName, artistOk ? hintArtist : '')
  const enSong = disneyEnglishTitle(songName)
  const movie = extractQuotedMovie(songName)
  const enMovie = movie ? disneyEnglishMovie(movie) : null

  // Queries fijas de canciones conocidas (máxima prioridad)
  if (known) {
    queries.push(...known.queries)
  }

  for (const hint of hints) {
    if (core) queries.push(`${core} ${hint}`)
    if (q) queries.push(`${q} ${hint}`)
  }

  if (enSong) {
    queries.push(enSong)
    if (enMovie) queries.push(`${enSong} ${enMovie}`)
    queries.push(`${enSong} Disney`)
  }
  if (core) queries.push(core)

  if (artistOk) {
    queries.push(`${cleanQuery(hintArtist)} ${core || q}`)
  }

  if (q) queries.push(q)

  const parts = q.split(/\s+-\s+/)
  if (parts.length >= 2) {
    queries.push(parts[0].trim())
  }

  return [...new Set(queries.map((x) => x.trim()).filter(Boolean))]
}

/** JSONP: Deezer no permite fetch CORS desde el navegador. */
function jsonp<T>(url: string, timeoutMs = 10000): Promise<T> {
  return new Promise((resolve, reject) => {
    const cb = `__myvibe_dz_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const script = document.createElement('script')
    const timer = window.setTimeout(() => {
      cleanup()
      reject(new Error('timeout'))
    }, timeoutMs)

    function cleanup() {
      window.clearTimeout(timer)
      delete (window as unknown as Record<string, unknown>)[cb]
      script.remove()
    }

    ;(window as unknown as Record<string, unknown>)[cb] = (data: T) => {
      cleanup()
      resolve(data)
    }

    const sep = url.includes('?') ? '&' : '?'
    script.src = `${url}${sep}output=jsonp&callback=${cb}`
    script.onerror = () => {
      cleanup()
      reject(new Error('jsonp failed'))
    }
    document.head.appendChild(script)
  })
}

interface DeezerTrack {
  id?: number
  title?: string
  title_short?: string
  link?: string
  release_date?: string
  artist?: { name?: string }
  album?: {
    id?: number
    title?: string
    cover_xl?: string
    cover_big?: string
    cover_medium?: string
    release_date?: string
  }
}

async function fetchDeezerJson<T>(path: string): Promise<T | null> {
  try {
    const proxied = `/api/deezer${path}`
    const res = await fetch(proxied)
    if (res.ok) return (await res.json()) as T
  } catch {
    // continuar
  }
  try {
    return await jsonp<T>(`https://api.deezer.com${path}`)
  } catch {
    return null
  }
}

function yearFromDate(value?: string | null): string {
  if (!value) return ''
  const m = value.match(/(\d{4})/)
  return m?.[1] ?? ''
}

async function resolveDeezerAlbumMeta(
  track: DeezerTrack,
): Promise<{ year: string; genre: string }> {
  let year =
    yearFromDate(track.release_date) || yearFromDate(track.album?.release_date)
  let genre = ''

  if (track.album?.id) {
    const album = await fetchDeezerJson<{
      release_date?: string
      genres?: { data?: { name?: string }[] }
    }>(`/album/${track.album.id}`)
    if (!year) year = yearFromDate(album?.release_date)
    genre = album?.genres?.data?.map((g) => g.name).filter(Boolean).join(', ') || ''
  }

  if ((!year || !genre) && track.id) {
    const full = await fetchDeezerJson<{
      release_date?: string
      album?: { release_date?: string; genre_id?: number }
    }>(`/track/${track.id}`)
    if (!year) {
      year =
        yearFromDate(full?.release_date) ||
        yearFromDate(full?.album?.release_date)
    }
  }

  return { year, genre }
}

/** Etiquetas especiales: Anime, Disney, Serie; si no, género musical. */
export function refineGenre(input: {
  title: string
  artist: string
  album: string
  genre: string
  fileName?: string
}): string {
  const text = norm(
    [input.title, input.artist, input.album, input.genre, input.fileName]
      .filter(Boolean)
      .join(' '),
  )
  const rawGenre = norm(input.genre)

  if (isDisney(text, rawGenre)) return 'Disney'
  if (isAnime(text, rawGenre)) return 'Anime'
  if (isSeries(text, rawGenre)) return 'Serie'

  return normalizeMusicGenre(input.genre)
}

function isDisney(text: string, genre: string): boolean {
  if (/\bdisney\b|\bpixar\b|\bwalt disney\b/.test(text)) return true
  if (/\bdisney\b/.test(genre)) return true
  return (
    /\b(frozen|encanto|moana|mulan|aladdin|tangled|coco|wish|zootopia|brave|rapunzel|ariel|little mermaid|beauty and the beast|la bella y la bestia|el rey leon|lion king|toy story|cars|inside out|intensamente|luca|turning red|elemental|descendants|high school musical|hsm|camp rock|hanna montana|phineas|gravity falls|big hero 6|wreck it ralph|soul|onward|raya|strange world|tiana|princess and the frog)\b/.test(
      text,
    ) || /\b(alan menken|lin manuel miranda|idina menzel)\b/.test(text)
  )
}

function isAnime(text: string, genre: string): boolean {
  if (/\banime\b|\banison\b|\bghibli\b|\bstudio ghibli\b/.test(text)) return true
  if (/\banime\b/.test(genre)) return true
  if (
    /\b(opening|ending|op\b|ed\b|tv size|official opening|official ending)\b/.test(text) &&
    (/\b(ost|soundtrack|original soundtrack|music collection)\b/.test(text) ||
      /\bj pop\b|\bjpop\b|\bj rock\b/.test(genre + ' ' + text))
  ) {
    return true
  }
  return /\b(naruto|one piece|bleach|dragon ball|attack on titan|shingeki|demon slayer|kimetsu|jujutsu kaisen|my hero academia|boku no hero|evangelion|sailor moon|pokemon|pokémon|hunter x hunter|spy x family|chainsaw man|death note|fullmetal|fma|tokyo ghoul|sword art online|sao|fairy tail|black clover|haikyuu|given|your name|kimi no na wa|spirited away|el viaje de chihiro|princess mononoke|howl|totoro|violet evergarden|oshi no ko|bocchi|franxx|darling in the franxx|re zero|konosuba|overlord|solo leveling|vinland|berserk|neon genesis|jojo|jojos|one punch|mob psycho|steins gate|clannad|toradora|horimiya|fruits basket|inuyasha|yu gi oh|digimon|beyblade|slam dunk|blue lock|dandadan|kaiju no 8|wind breaker)\b/.test(
    text,
  )
}

function isSeries(text: string, genre: string): boolean {
  if (/\bdisney\b|\banime\b/.test(text) || /\bdisney\b|\banime\b/.test(genre)) {
    return false
  }
  if (
    /\b(from the series|from the show|tv theme|theme song|main title|opening theme|end credits|netflix|hbo|hulu|prime video|disney\+|serie de television|banda sonora de la serie)\b/.test(
      text,
    )
  ) {
    return true
  }
  if (
    /\b(stranger things|game of thrones|the witcher|bridgerton|wednesday|euphoria|the boys|house of the dragon|peaky blinders|breaking bad|the office|friends|greys anatomy|grey s anatomy|la casa de papel|elite|dark|loki|wandavision|the mandalorian|arcane|invincible|rick and morty|simpsons|the simpsons)\b/.test(
      text,
    )
  ) {
    return true
  }
  // Soundtrack genérico de TV/cine sin Disney/Anime → Serie solo si hay pista TV
  if (
    /\b(soundtrack|banda sonora|score)\b/.test(genre + ' ' + text) &&
    /\b(tv|television|series|serie|episode|episodio|season|temporada)\b/.test(text)
  ) {
    return true
  }
  return false
}

function normalizeMusicGenre(genre: string): string {
  const g = genre.trim()
  if (!g) return ''
  const lower = g.toLowerCase()
  const map: Record<string, string> = {
    soundtrack: 'Banda sonora',
    'original soundtrack': 'Banda sonora',
    'children\'s music': 'Infantil',
    'childrens music': 'Infantil',
    'kids music': 'Infantil',
    pop: 'Pop',
    rock: 'Rock',
    'hip-hop/rap': 'Hip-Hop',
    'hip hop': 'Hip-Hop',
    'hip-hop': 'Hip-Hop',
    electronic: 'Electrónica',
    dance: 'Dance',
    latin: 'Latino',
    'latin music': 'Latino',
    'r&b/soul': 'R&B',
    'r&b': 'R&B',
    jazz: 'Jazz',
    classical: 'Clásica',
    metal: 'Metal',
    alternative: 'Alternativa',
    indie: 'Indie',
    folk: 'Folk',
    country: 'Country',
    reggae: 'Reggae',
    anime: 'Anime',
  }
  return map[lower] || g
}

async function searchDeezer(
  term: string,
  wantTitle: string,
  wantArtist: string,
  wantContext = '',
): Promise<OnlineTrackInfo | null> {
  const list = await fetchDeezerResults(term)
  if (!list.length) return null

  let best: DeezerTrack | null = null
  let bestScore = -1
  for (const item of list) {
    const title = item.title_short || item.title || ''
    const artist = item.artist?.name || ''
    const album = item.album?.title || ''
    const s = scoreMatch(title, artist, album, wantTitle, wantArtist, wantContext)
    const remixPenalty = /remix|karaoke|tribute|version/i.test(
      `${item.title || ''} ${artist} ${album}`,
    )
      ? -40
      : 0
    const total = s + remixPenalty
    if (total > bestScore) {
      bestScore = total
      best = item
    }
  }

  // Umbral más alto: evita covers infantiles con solo coincidencia parcial de título
  if (!best || bestScore < 45) return null

  const cover =
    best.album?.cover_xl ||
    best.album?.cover_big ||
    best.album?.cover_medium ||
    null

  const meta = await resolveDeezerAlbumMeta(best)
  const title = best.title_short || best.title || wantTitle
  const artist = best.artist?.name || wantArtist || 'Artista desconocido'
  const album = best.album?.title || 'Sin álbum'

  return {
    title,
    artist,
    album,
    genre: refineGenre({ title, artist, album, genre: meta.genre }),
    year: meta.year,
    coverUrl: cover,
    externalUrl: best.link || '',
  }
}

async function fetchDeezerResults(term: string): Promise<DeezerTrack[]> {
  // 1) Proxy local Vite (sin CORS) en desarrollo
  try {
    const proxied = `/api/deezer/search?q=${encodeURIComponent(term)}&limit=25`
    const res = await fetch(proxied)
    if (res.ok) {
      const data = (await res.json()) as { data?: DeezerTrack[] }
      if (data.data?.length) return data.data
    }
  } catch {
    // continuar
  }

  // 2) JSONP directo a Deezer (producción / si el proxy no existe)
  try {
    const url = `https://api.deezer.com/search?q=${encodeURIComponent(term)}&limit=25`
    const data = await jsonp<{ data?: DeezerTrack[] }>(url)
    return data.data ?? []
  } catch {
    return []
  }
}

interface ITunesResult {
  trackName?: string
  artistName?: string
  collectionName?: string
  primaryGenreName?: string
  releaseDate?: string
  artworkUrl100?: string
  artworkUrl60?: string
  trackViewUrl?: string
  collectionViewUrl?: string
}

async function searchITunes(
  term: string,
  wantTitle: string,
  wantArtist: string,
  country: string,
  wantContext = '',
): Promise<OnlineTrackInfo | null> {
  // Evitar comillas tipo Deezer en iTunes
  const cleanTerm = term.replace(/["']/g, ' ').replace(/\s+/g, ' ').trim()
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(cleanTerm)}&media=music&entity=song&limit=25&country=${country}`
  const res = await fetch(url)
  if (!res.ok) return null
  const text = await res.text()
  if (!text?.trim()) return null
  const data = JSON.parse(text) as { results?: ITunesResult[] }
  const list = data.results ?? []
  if (!list.length) return null

  let best: ITunesResult | null = null
  let bestScore = -1
  for (const item of list) {
    const s = scoreMatch(
      item.trackName || '',
      item.artistName || '',
      item.collectionName || '',
      wantTitle,
      wantArtist,
      wantContext,
    )
    if (s > bestScore) {
      bestScore = s
      best = item
    }
  }
  if (!best?.trackName || bestScore < 45) return null

  const art = best.artworkUrl100 || best.artworkUrl60 || null
  const coverUrl = art
    ? art.replace('100x100bb', '600x600bb').replace('60x60bb', '600x600bb')
    : null

  return {
    title: best.trackName,
    artist: best.artistName || 'Artista desconocido',
    album: best.collectionName || 'Sin álbum',
    genre: refineGenre({
      title: best.trackName,
      artist: best.artistName || '',
      album: best.collectionName || '',
      genre: best.primaryGenreName || '',
    }),
    year: best.releaseDate ? best.releaseDate.slice(0, 4) : '',
    coverUrl,
    externalUrl: best.trackViewUrl || best.collectionViewUrl || '',
  }
}

function isJunkCoverArtist(info: OnlineTrackInfo): boolean {
  return isLowQualityRelease(info.artist, info.album, info.title)
}

export async function enrichFromInternet(
  songName: string,
  hintArtist = '',
): Promise<OnlineTrackInfo | null> {
  const wantTitle = coreSongTitle(songName) || cleanQuery(songName)
  if (!wantTitle) return null
  const wantArtist = cleanQuery(hintArtist)
  const wantContext = `${songName} ${hintArtist}`
  const queries = buildQueries(songName, hintArtist)
  const disneyCtx =
    Boolean(extractQuotedMovie(songName)) ||
    Boolean(disneyEnglishTitle(songName)) ||
    /\b(disney|rey leon|bella y la bestia|frozen|encanto|moana|hakuna|ciclo de la vida)\b/i.test(
      songName,
    )

  let best: OnlineTrackInfo | null = null
  let bestScore = -1

  const consider = (hit: OnlineTrackInfo | null) => {
    if (!hit || isJunkCoverArtist(hit)) return
    if (isDoubtfulMetadata({ ...hit, hasCover: true })) {
      // Permitir OST oficiales aunque el heurístico de “canciones de” no aplique
      if (!/\b(soundtrack|banda sonora|walt disney|motion picture)\b/i.test(`${hit.album} ${hit.artist}`)) {
        return
      }
    }
    const score = scoreMatch(
      hit.title,
      hit.artist,
      hit.album,
      wantTitle,
      wantArtist,
      wantContext,
    )
    if (score > bestScore) {
      bestScore = score
      best = hit
    }
  }

  // Disney: iTunes US primero (mejor catálogo OST)
  const itunesCountries = disneyCtx
    ? ['us', 'es', 'mx', 'ar', 'co']
    : ['es', 'us', 'mx', 'ar', 'co']

  if (disneyCtx) {
    for (const country of itunesCountries) {
      for (const term of queries.slice(0, 8)) {
        try {
          consider(
            await searchITunes(term, wantTitle, wantArtist, country, wantContext),
          )
        } catch {
          // siguiente
        }
      }
      if (bestScore >= 120) break
    }
  }

  for (const term of queries) {
    try {
      consider(await searchDeezer(term, wantTitle, wantArtist, wantContext))
    } catch {
      // siguiente
    }
  }

  if (!best || !(best as OnlineTrackInfo).year || !(best as OnlineTrackInfo).genre || bestScore < 100) {
    for (const country of itunesCountries) {
      for (const term of queries) {
        try {
          const itunes = await searchITunes(
            term,
            wantTitle,
            wantArtist,
            country,
            wantContext,
          )
          if (!itunes) continue
          consider(itunes)
          const b = best as OnlineTrackInfo | null
          if (b && b.year && b.genre && bestScore >= 120) break
        } catch {
          // siguiente
        }
      }
      const b = best as OnlineTrackInfo | null
      if (b && b.year && b.genre && bestScore >= 120) break
    }
  }

  if (best) {
    const b = best as OnlineTrackInfo
    b.genre = refineGenre({
      title: b.title,
      artist: b.artist,
      album: b.album,
      genre: b.genre,
      fileName: songName,
    })
  }

  return best && bestScore >= 45 ? best : null
}

export async function fetchCoverBlob(coverUrl: string): Promise<Blob | null> {
  // 1) Intento directo
  try {
    const res = await fetch(coverUrl, { mode: 'cors', credentials: 'omit' })
    if (res.ok) {
      const blob = await res.blob()
      if (blob.size > 0) return blob
    }
  } catch {
    // fallback
  }

  // 2) Image + canvas (si el CDN manda CORS en <img>)
  try {
    const blob = await loadImageAsJpegBlob(coverUrl)
    if (blob) return blob
  } catch {
    // ignore
  }

  // 3) Tamaños alternativos Deezer
  const alts = [
    coverUrl.replace('/1000x1000-', '/500x500-'),
    coverUrl.replace('/1000x1000-', '/250x250-'),
    coverUrl.replace('600x600bb', '300x300bb'),
  ].filter((u) => u !== coverUrl)

  for (const alt of alts) {
    try {
      const blob = await loadImageAsJpegBlob(alt)
      if (blob) return blob
    } catch {
      // next
    }
  }

  return null
}

function loadImageAsJpegBlob(src: string): Promise<Blob | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth || 600
        canvas.height = img.naturalHeight || 600
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          resolve(null)
          return
        }
        ctx.drawImage(img, 0, 0)
        canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.92)
      } catch {
        resolve(null)
      }
    }
    img.onerror = () => resolve(null)
    img.src = src
  })
}
