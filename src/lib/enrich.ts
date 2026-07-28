export interface OnlineTrackInfo {
  title: string
  artist: string
  album: string
  genre: string
  year: string
  coverUrl: string | null
  externalUrl: string
  /** Puntuación interna del emparejamiento (mayor = mejor). */
  matchScore?: number
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
  'mi reflejo': 'Reflection',
  'how far ill go': 'How Far Ill Go',
  'he sabido esperar': 'How Far Ill Go',
  'no me dare por vencida': 'How Far Ill Go',
  'no hablare de eso': 'We Dont Talk About Bruno',
  'un poco loco': 'Un Poco Loco',
  'recuerda me': 'Remember Me',
  'let it go': 'Let It Go',
  'libre soy': 'Let It Go',
  'sueltato': 'Let It Go',
  'sueltalo': 'Let It Go',
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

/** Idioma del artista OST: inglés / español España / español latino. */
export type OstArtistLang = 'en' | 'es' | 'es-lat'

/**
 * Cast original por idioma (Disney). Solo con contexto Disney.
 * en = inglés, es = España, lat = Latinoamérica.
 */
const DISNEY_LANG_CAST: {
  match: RegExp
  en: string[]
  es: string[]
  lat: string[]
  queries: { en: string[]; es: string[]; lat: string[] }
}[] = [
  {
    match: /\breflejo\b|\breflection\b|\bmi reflejo\b/,
    en: ['christina aguilera', 'lea salonga'],
    es: ['malu', 'maria caneda'],
    lat: ['lucero'],
    queries: {
      en: [
        'Reflection Christina Aguilera Mulan',
        'Reflection Lea Salonga Mulan original soundtrack',
      ],
      es: [
        'Reflejo Malú Mulán Disney España',
        'Reflejo María Caneda Mulán banda sonora',
      ],
      lat: ['Reflejo Lucero Mulán Disney', 'Reflejo Lucero Mulan banda sonora'],
    },
  },
  {
    match: /\blet it go\b|\blibre soy\b|\bsueltato\b|\bsueltalo\b/,
    en: ['idina menzel'],
    es: ['gisela'],
    lat: ['martina stoessel', 'tini'],
    queries: {
      en: ['Let It Go Idina Menzel Frozen original soundtrack'],
      es: ['Suéltalo Gisela Frozen Disney España', 'Sueltato Gisela Frozen'],
      lat: ['Libre Soy Martina Stoessel Frozen', 'Libre Soy TINI Frozen Disney'],
    },
  },
  {
    match: /\bun mundo ideal\b|\ba whole new world\b/,
    en: ['brad kane', 'lea salonga', 'peabo bryson', 'regina belle'],
    es: ['miguel morant'],
    lat: ['demian bichir', 'analy'],
    queries: {
      en: [
        'A Whole New World Brad Kane Lea Salonga Aladdin',
        'A Whole New World Peabo Bryson Regina Belle',
      ],
      es: ['Un Mundo Ideal Aladdín Disney España banda sonora'],
      lat: ['Un Mundo Ideal Aladdín Disney Latino'],
    },
  },
  {
    match: /\b(el )?ciclo de la vida\b|\bcircle of life\b/,
    en: ['carmen twillie', 'lebo m', 'lebom'],
    es: ['miguel morant'],
    lat: ['renato lopez'],
    queries: {
      en: ['Circle of Life Carmen Twillie The Lion King'],
      es: ['El Ciclo de la Vida El Rey León Disney España'],
      lat: ['El Ciclo de la Vida El Rey León Disney Latino'],
    },
  },
  {
    match: /\bhow far ill go\b|\bhe sabido esperar\b|\bno me dare por vencida\b/,
    en: ['auli i cravalho', 'aulii cravalho'],
    es: ['maria parrado'],
    lat: ['sara paula', 'gomez arias'],
    queries: {
      en: ["How Far I'll Go Auli'i Cravalho Moana original soundtrack"],
      es: ['He Sabido Esperar María Parrado Vaiana Disney'],
      lat: ['No Me Daré por Vencida Moana Disney Latino'],
    },
  },
  {
    match: /\bno hablare de eso\b|\bwe dont talk about bruno\b/,
    en: ['carolina gaitan', 'mauro castillo', 'adassa', 'rhenzy'],
    es: ['gisela'],
    lat: ['carolina gaitan', 'mauro castillo', 'adassa'],
    queries: {
      en: ['We Dont Talk About Bruno Encanto original soundtrack'],
      es: ['No Hablaré de Bruno Encanto Disney España'],
      lat: ['No Hablaré de Bruno Encanto Disney'],
    },
  },
]

function findDisneyLangCast(text: string) {
  const n = norm(text)
  return DISNEY_LANG_CAST.find((k) => k.match.test(n)) ?? null
}

/**
 * Detecta artista en inglés, español (España) o español latino
 * a partir del título/archivo (p. ej. Reflejo → latino, Reflection → inglés).
 */
export function detectOstArtistLang(text: string): OstArtistLang {
  const n = norm(text)
  if (
    /\b(latino|latin america|america latina|español latino|espanol latino|version latina|doblaje latino|latam|mexico|mexicana|argentin|colombian|chilean)\b/.test(
      n,
    )
  ) {
    return 'es-lat'
  }
  if (
    /\b(castellano|espana|version española|version espanola|español de espana|doblaje español|doblaje espanol|spain|european spanish)\b/.test(
      n,
    )
  ) {
    return 'es'
  }
  if (
    /\b(english|ingles|original english|us version|english version|version inglesa|doblaje ingles)\b/.test(
      n,
    )
  ) {
    return 'en'
  }

  if (/\b(libre soy)\b/.test(n)) return 'es-lat'
  if (/\b(sueltato|sueltalo)\b/.test(n)) return 'es'

  const core = norm(coreSongTitle(text) || text)
  if (DISNEY_SONG_EN[core]) {
    return norm(DISNEY_SONG_EN[core]) === core ? 'en' : 'es-lat'
  }
  for (const [es, en] of Object.entries(DISNEY_SONG_EN)) {
    if (es.length < 4) continue
    if (core === es || (es.length >= 5 && core.includes(es))) {
      return norm(en) === core ? 'en' : 'es-lat'
    }
  }
  for (const en of Object.values(DISNEY_SONG_EN)) {
    if (norm(en) === core) return 'en'
  }
  if (/\b(reflection|let it go|circle of life|whole new world|how far ill go)\b/.test(n)) {
    return 'en'
  }
  if (/\b(reflejo|libre soy|ciclo de la vida|mundo ideal)\b/.test(n)) {
    return 'es-lat'
  }
  return 'en'
}

function preferredArtistsForLang(
  cast: (typeof DISNEY_LANG_CAST)[0],
  lang: OstArtistLang,
): string[] {
  if (lang === 'es') return cast.es
  if (lang === 'es-lat') return cast.lat
  return cast.en
}

function otherLangArtists(
  cast: (typeof DISNEY_LANG_CAST)[0],
  lang: OstArtistLang,
): string[] {
  if (lang === 'en') return [...cast.es, ...cast.lat]
  if (lang === 'es') return [...cast.en, ...cast.lat]
  return [...cast.en, ...cast.es]
}

function itunesCountriesForLang(lang: OstArtistLang, franchise: boolean): string[] {
  if (!franchise) return ['es', 'us', 'mx', 'ar', 'co']
  if (lang === 'es-lat') return ['mx', 'ar', 'co', 'es', 'us', 'jp']
  if (lang === 'es') return ['es', 'mx', 'us', 'ar', 'co', 'jp']
  return ['us', 'gb', 'es', 'mx', 'jp', 'ar', 'co']
}

/** Canciones muy buscadas: queries fijas + artistas preferidos. */
const KNOWN_TRACKS: {
  pattern: RegExp
  queries: string[]
  artists: string[]
  albums?: string[]
}[] = [
  {
    pattern: /\bsense tu\b/,
    queries: [
      'Teràpia de Shock Sense tu',
      'Terapia de Shock Sense tu',
      'Sense tu Terapia de Shock Escapa\'t amb mi',
      'Sense tu Teràpia de Shock',
    ],
    artists: ['terapia de shock', 'terapia de xoc'],
    albums: ['escapat amb mi', 'escapa t amb mi'],
  },
  {
    pattern: /\breflejo\b|\breflection\b|\bmi reflejo\b/,
    queries: [
      'Reflection Christina Aguilera Mulan',
      'Reflection Lea Salonga Mulan original soundtrack',
      'Reflejo Lucero Mulán Disney',
      'Reflejo Malú Mulán Disney España',
      'Reflejo María Caneda Mulán',
    ],
    artists: [
      'christina aguilera',
      'lea salonga',
      'lucero',
      'malu',
      'maria caneda',
    ],
    albums: ['mulan'],
  },
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
  {
    pattern: /\blet it go\b|\blibre soy\b|\bsueltato\b|\bsueltalo\b/,
    queries: [
      'Let It Go Idina Menzel Frozen',
      'Libre Soy Martina Stoessel Frozen',
      'Suéltalo Gisela Frozen Disney',
    ],
    artists: ['idina menzel', 'martina stoessel', 'tini', 'gisela'],
    albums: ['frozen'],
  },
  {
    pattern: /\b(baby )?one more time\b/,
    queries: [
      'Britney Spears Baby One More Time',
      'Britney Spears ...Baby One More Time',
      '...Baby One More Time Britney Spears',
    ],
    artists: ['britney spears'],
    albums: ['baby one more time', '...baby one more time'],
  },
  {
    pattern: /\boops[! ]*i did it again\b/,
    queries: [
      'Britney Spears Oops I Did It Again',
      'Oops!...I Did It Again Britney Spears',
    ],
    artists: ['britney spears'],
    albums: ['oops i did it again'],
  },
  {
    pattern: /\bbackstreet'?s?\s*back\b|\beverybody\b.*\bbackstreet/,
    queries: [
      "Backstreet Boys Everybody Backstreet's Back",
      'Everybody Backstreets Back Backstreet Boys',
      'Backstreet Boys Backstreets Back',
    ],
    artists: ['backstreet boys', 'back street boys'],
    albums: ['backstreet boys', 'millennium'],
  },
  {
    pattern: /\bsolo se vive una vez\b/,
    queries: [
      'Azúcar Moreno Solo Se Vive Una Vez',
      'Azucar Moreno Solo Se Vive Una Vez',
      'Sólo Se Vive Una Vez Azúcar Moreno',
    ],
    artists: ['azucar moreno', 'azúcar moreno'],
    albums: ['mambo'],
  },
]

function findKnownTrack(songName: string) {
  const n = norm(songName)
  return KNOWN_TRACKS.find((k) => k.pattern.test(n)) ?? null
}

/** Queries fijas para canciones famosas (reintentos de enrich). */
export function knownTrackQueries(songName: string): string[] {
  return findKnownTrack(songName)?.queries ?? []
}

export function isWrongKnownArtist(title: string, artist: string, album = ''): boolean {
  const known = findKnownTrack(title)
  const langCast = findDisneyLangCast(`${title} ${album}`)
  if (!known && !langCast) return false
  const blob = norm(`${artist} ${album}`)
  const lang = detectOstArtistLang(`${title} ${album} ${artist}`)

  if (langCast) {
    const preferred = preferredArtistsForLang(langCast, lang)
    if (preferred.some((a) => blob.includes(a))) return false
    // Cast de otro idioma → forzar re-búsqueda al idioma correcto
    if (otherLangArtists(langCast, lang).some((a) => blob.includes(a))) return true
  }

  if (known?.artists.some((a) => blob.includes(a))) return false
  if (
    known?.albums?.some((al) => blob.includes(al)) &&
    /\b(soundtrack|banda sonora|walt disney|motion picture|original)\b/.test(blob)
  ) {
    // Sin cantante del idioma pedido: seguir considerando desajuste si hay cast preferido
    if (langCast && preferredArtistsForLang(langCast, lang).length) return true
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

/** Alias de títulos cortos / mal parseados → título oficial. */
const TITLE_ALIASES: { local: RegExp; online: RegExp }[] = [
  { local: /\b(baby )?one more time\b/, online: /\bbaby one more time\b|\bone more time\b/ },
  {
    local: /\bbackstreet'?s?\s*back\b|\bbackstreet back\b/,
    online: /\beverybody\b.*\bbackstreet|\bbackstreet'?s?\s*back\b/,
  },
  { local: /\bsolo se vive una vez\b/, online: /\bsolo se vive una vez\b/ },
]

/** ¿El título online parece la misma canción que la local? */
export function titlesCompatible(localTitle: string, onlineTitle: string): boolean {
  const a = norm(coreSongTitle(localTitle) || localTitle)
  const b = norm(coreSongTitle(onlineTitle) || onlineTitle)
  if (!a || !b) return false
  if (a === b) return true
  for (const alias of TITLE_ALIASES) {
    if (alias.local.test(a) && alias.online.test(b)) return true
  }
  // ES → EN (p. ej. Reflejo ↔ Reflection)
  const aEn = disneyEnglishTitle(localTitle)
  if (aEn && norm(aEn) === b) return true
  if (aEn && (b.includes(norm(aEn)) || norm(aEn).includes(b))) return true
  const bEn = disneyEnglishTitle(onlineTitle)
  if (bEn && a === norm(bEn)) return true
  if (a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a))) return true
  const aw = a.split(' ').filter((w) => w.length > 2)
  if (!aw.length) return false
  const hit = aw.filter((w) => b.includes(w)).length
  return hit / aw.length >= 0.75
}

export function artistsCompatible(localArtist: string, onlineArtist: string): boolean {
  const a = norm(localArtist)
  const b = norm(onlineArtist)
  if (!a || !b) return true
  if (/desconocido|unknown|various|varios/.test(a)) return true
  if (a === b) return true
  if (a.includes(b) || b.includes(a)) return true
  // "Back Street Boys" ↔ "Backstreet Boys"
  const ac = a.replace(/\s+/g, '')
  const bc = b.replace(/\s+/g, '')
  return ac === bc || ac.includes(bc) || bc.includes(ac)
}

export function isLowQualityRelease(artist: string, album: string, title = ''): boolean {
  const blob = norm(`${artist} ${album} ${title}`)
  // No usar \bbaby\b solo: rechazaría «...Baby One More Time», «Baby» (Bieber), etc.
  if (
    /\b(karaoke|tribute|tributo|kids|ninos|nino|infantil|nursery|bebes|babies|baby songs?|baby music|for babies|super banda|banda de ninos|banda infantil|sing along|toddlers|children'?s? (choir|songs?|music)|musica para ninos|para dormir|canciones infantiles|cover band|piano tribute|castillo encantado|canciones de disney|canciones de peliculas|peliculas infantiles|exitos infantiles|super exitos|disney en espanol|disney kids|kids disney|bedtime songs|party kids|various artists kids|lo mejor de disney|disney para ninos|canciones disney|disney hits for kids|disney lullaby|lullaby|nanas|cuento musical|version infantil|cover infantil|kids party|baby shark|lo mejor de|exitos de oro|recopilacion|recopilatorio|temazos|para cantar|canta conmigo|sing with me|music for kids|kids hits)\b/.test(
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

function isGenericWeirdArtistOrAlbum(artist: string, album: string, title = ''): boolean {
  const blob = norm(`${artist} ${album} ${title}`)
  return /\b(original soundtrack|motion picture|music from|various artists|varios artistas|official soundtrack|banda sonora original|soundtrack from|tv soundtrack)\b/.test(
    blob,
  )
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
  if (isLowQualityRelease(artist, album, title) || isNonOriginalFranchiseCover(artist, album, title)) {
    return false
  }
  return /\b(original (motion picture )?soundtrack|walt disney records|disney|pixar|el rey leon|the lion king|frozen|encanto|moana|mulan)\b/.test(
    blob,
  ) && /\b(soundtrack|ost|motion picture|el rey leon|the lion king|walt disney|banda sonora)\b/.test(blob)
}

/**
 * ¿La búsqueda es claramente Disney o Anime?
 * Solo en ese caso aplicamos el filtro de “versión original / OST”.
 */
export function isDisneyOrAnimeSearchContext(text: string, genre = ''): boolean {
  const n = norm(text)
  const g = norm(genre)
  if (!n && !g) return false
  if (isDisney(n, g) || isAnime(n, g)) return true
  if (disneyEnglishTitle(text) || disneyEnglishMovie(text)) return true
  return false
}

/**
 * Covers, karaoke, tributos, packs infantiles, etc. (NO originales).
 * Usar solo si el contexto es Disney/Anime.
 */
function isNonOriginalFranchiseCover(artist: string, album: string, title = ''): boolean {
  const blob = norm(`${artist} ${album} ${title}`)
  if (isLowQualityRelease(artist, album, title)) return true
  return /\b(cover|covers|cover version|acoustic cover|metal cover|punk cover|rock cover|guitar cover|violin cover|piano cover|piano version|music box|tribute|tributo|karaoke|sing.?along|nightcore|8 ?bit|chiptune|bootleg|fan ?made|unofficial|not official|version acustica|orchestra tribute|disney go|disney junior|disney hits|disney party|disney sing|disney for kids|just dance|kidz bop|lo mejor de disney|canciones de disney|anime cover|anison cover|anime piano|glee|the voice|american idol|x factor|star academy|super stars|all star kids|sleep babies|lullaby|bedtime)\b/.test(
    blob,
  )
}

/** Señales de OST Disney/Pixar original (no recopilatorio). */
function looksLikeOriginalDisneyOst(
  artist: string,
  album: string,
  title = '',
  wantContext = '',
): boolean {
  if (isNonOriginalFranchiseCover(artist, album, title)) return false
  const blob = norm(`${artist} ${album} ${title}`)
  if (
    /\b(walt disney records|original (motion picture )?soundtrack|original broadway cast|pixar animation)\b/.test(
      blob,
    )
  ) {
    return true
  }
  // Película + banda sonora
  const filmOst =
    /\b(mulan|frozen|encanto|aladdin|moana|coco|tangled|brave|wish|zootopia|toy story|lion king|rey leon|beauty and the beast|bella y la bestia|little mermaid|sirenita|pocahontas|hercules|tarzan|nightmare before christmas)\b/.test(
      blob,
    ) && /\b(soundtrack|ost|motion picture|banda sonora|music from|walt disney)\b/.test(blob)
  if (filmOst) return true
  // Artistas / compositores del cast original
  if (
    /\b(alan menken|howard ashman|tim rice|lin[- ]?manuel|idina menzel|christina aguilera|lea salonga|brad kane|carmen twillie|lebo m|paige o'?hara|angela lansbury|phil collins|randy newman|celine dion|peabo bryson|regina belle|samuel e wright|jodi benson|audrey hepburn|emma watson|bill condon|nathan lane|jason rinker|joseph williams|erskine|matthew wilder|jonathan groff|kristen bell|josh gad|stephanie beatriz|carolina gaitan|mauro castillo|auli'?i cravalho|dwayne johnson|benjamin bratt|anthony gonzalez|lucero|malu|maria caneda|martina stoessel|gisela|demian bichir|renato lopez|maria parrado|sara paula)\b/.test(
      blob,
    )
  ) {
    return true
  }
  // Canciones conocidas: artista/álbum OST de la lista fija
  const known = findKnownTrack(`${title} ${wantContext}`)
  if (known?.artists.some((a) => blob.includes(a))) return true
  if (
    known?.albums?.some((al) => blob.includes(al)) &&
    /\b(soundtrack|banda sonora|walt disney|motion picture|original|disney|mulan|aladdin|lion king|rey leon)\b/.test(
      blob,
    )
  ) {
    return true
  }
  // Misma película en el nombre del archivo y en el álbum/artista
  const ctx = norm(wantContext)
  const filmInCtx =
    ctx.match(
      /\b(mulan|frozen|encanto|aladdin|moana|coco|tangled|brave|wish|zootopia|toy story|lion king|rey leon|bella y la bestia|beauty and the beast|little mermaid|sirenita|pocahontas|hercules|tarzan)\b/g,
    ) || []
  if (
    filmInCtx.some((f) => blob.includes(f)) &&
    /\b(disney|walt|soundtrack|ost|banda sonora|pixar)\b/.test(blob)
  ) {
    return true
  }
  return false
}

/** Señales de OST / opening / ending anime original. */
function looksLikeOriginalAnimeOst(
  artist: string,
  album: string,
  title = '',
  wantContext = '',
): boolean {
  if (isNonOriginalFranchiseCover(artist, album, title)) return false
  const blob = norm(`${artist} ${album} ${title}`)
  if (
    /\b(original soundtrack|original animation soundtrack|o\.?\s?s\.?\s?t\.?|tv size|opening theme|ending theme|official opening|official ending)\b/.test(
      blob,
    )
  ) {
    return true
  }
  if (
    /\b(aniplex|toho animation|sony music|flying dog|lantis|pony canyon|king records|sacra music|toei|bones|ufotable|mappa|studio ghibli|joe hisaishi|hiroyuki sawano|yoko kanno)\b/.test(
      blob,
    )
  ) {
    return true
  }
  // Artistas anison frecuentes (no covers)
  if (
    /\b(lisa|yoasobi|ado|yui|radwimps|hikaru utada|kenshi yonezu|aimer|milet|king gnu|official hige|linked horizon|man with a mission|asian kung|masaaki endoh|hiroshi kitadani|poke'?mon|pokémon)\b/.test(
      blob,
    )
  ) {
    return true
  }
  // Misma serie anime en el archivo y en el hit
  const ctx = norm(wantContext)
  const seriesInCtx =
    ctx.match(
      /\b(naruto|one piece|bleach|dragon ball|attack on titan|shingeki|demon slayer|kimetsu|jujutsu kaisen|my hero academia|boku no hero|evangelion|sailor moon|pokemon|hunter x hunter|spy x family|chainsaw man|death note|fullmetal|tokyo ghoul|sword art online|fairy tale|black clover|haikyuu|your name|spirited away|chihiro|princess mononoke|totoro|violet evergarden|oshi no ko|bocchi|re zero|konosuba|solo leveling|jojo|one punch|mob psycho|steins gate|clannad|toradora)\b/g,
    ) || []
  if (seriesInCtx.some((s) => blob.includes(s))) return true
  return false
}

function acceptsFranchiseOriginal(
  hit: OnlineTrackInfo,
  wantContext: string,
  disneyCtx: boolean,
  animeCtx: boolean,
): boolean {
  if (isNonOriginalFranchiseCover(hit.artist, hit.album, hit.title)) return false
  if (disneyCtx) {
    return looksLikeOriginalDisneyOst(hit.artist, hit.album, hit.title, wantContext)
  }
  if (animeCtx) {
    return looksLikeOriginalAnimeOst(hit.artist, hit.album, hit.title, wantContext)
  }
  // Contexto Disney/Anime por título de canción (p. ej. Reflejo) sin película en el nombre
  return (
    looksLikeOriginalDisneyOst(hit.artist, hit.album, hit.title, wantContext) ||
    looksLikeOriginalAnimeOst(hit.artist, hit.album, hit.title, wantContext)
  )
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
      // Título EN cuando el archivo está en ES: coincide, pero no tanto como el idioma pedido
      const wantLangEarly = detectOstArtistLang(wantContext)
      score += wantLangEarly === 'en' ? 120 : 45
    } else {
      const tw = wt.split(' ').filter((w) => w.length > 2)
      if (!tw.length) return 0
      const hit = tw.filter((w) => t.includes(w)).length
      score += (hit / tw.length) * 60
      if (hit < Math.ceil(tw.length * 0.6)) score -= 40
    }
  }

  const known = findKnownTrack(`${wantTitle} ${wantContext}`)
  const langCastForKnown = findDisneyLangCast(`${wantTitle} ${wantContext}`)
  const wantLangForKnown = detectOstArtistLang(wantContext)
  if (known) {
    if (langCastForKnown && isDisneyOrAnimeSearchContext(wantContext)) {
      const preferred = preferredArtistsForLang(langCastForKnown, wantLangForKnown)
      const others = otherLangArtists(langCastForKnown, wantLangForKnown)
      if (preferred.some((name) => blob.includes(name))) score += 200
      else if (others.some((name) => blob.includes(name))) score -= 220
      else score -= 100
    } else if (known.artists.some((name) => blob.includes(name))) {
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
    if (a === wa) score += 100
    else if (a.includes(wa) || wa.includes(a)) score += 70
    else {
      // Artista conocido y distinto → casi seguro canción equivocada (p. ej. Sense tu)
      score -= 160
    }
  }

  // Recopilatorios infantiles / covers basura: rechazo fuerte
  if (junk) {
    score -= 220
  }

  // SOLO Disney/Anime: exigir OST original; penalizar covers/cantantes no oficiales
  const franchiseCtx = isDisneyOrAnimeSearchContext(wantContext)
  if (franchiseCtx) {
    if (isNonOriginalFranchiseCover(candidateArtist, candidateAlbum, candidateTitle)) {
      return -999
    }
    const disneySide = isDisney(ctx, '')
    const animeSide = isAnime(ctx, '')
    const original = disneySide
      ? looksLikeOriginalDisneyOst(
          candidateArtist,
          candidateAlbum,
          candidateTitle,
          wantContext,
        )
      : animeSide
        ? looksLikeOriginalAnimeOst(
            candidateArtist,
            candidateAlbum,
            candidateTitle,
            wantContext,
          )
        : looksLikeOriginalDisneyOst(
            candidateArtist,
            candidateAlbum,
            candidateTitle,
            wantContext,
          ) ||
          looksLikeOriginalAnimeOst(
            candidateArtist,
            candidateAlbum,
            candidateTitle,
            wantContext,
          )
    if (original) score += 140
    else score -= 200

    // Idioma del artista: inglés / español España / español latino
    const wantLang = detectOstArtistLang(wantContext)
    const langCast = findDisneyLangCast(wantContext)
    if (langCast) {
      const preferred = preferredArtistsForLang(langCast, wantLang)
      const others = otherLangArtists(langCast, wantLang)
      if (preferred.some((a) => blob.includes(a))) score += 200
      else if (others.some((a) => blob.includes(a))) score -= 160
    }
    if (wantLang === 'es-lat') {
      if (/\b(latino|latin|mexico|doblaje latino|espanol latino)\b/.test(blob)) score += 50
      if (/\b(castellano|spain|españa)\b/.test(blob)) score -= 40
      // Preferir título en español si el archivo está en ES
      if (/\b(reflejo|libre soy|mundo ideal|ciclo de la vida)\b/.test(t)) score += 40
      if (/\b(reflection|let it go|whole new world|circle of life)\b/.test(t) && !/\b(reflejo|libre|mundo|ciclo)\b/.test(wt)) {
        score -= 30
      }
    } else if (wantLang === 'es') {
      if (/\b(castellano|spain|españa|disney españa)\b/.test(blob)) score += 50
      if (/\b(latino|latin america)\b/.test(blob)) score -= 40
    } else if (wantLang === 'en') {
      if (/\b(original (motion picture )?soundtrack|english)\b/.test(blob)) score += 25
      if (/\b(latino|castellano|español|espanol)\b/.test(blob)) score -= 50
    }
  }

  // Bonus OST oficial (no compilaciones “canciones de Disney”) — SOLO si es Disney/Anime
  if (franchiseCtx) {
    if (!junk && isOfficialDisneyOst(candidateArtist, candidateAlbum, candidateTitle)) {
      score += 50
    } else if (
      !junk &&
      /\b(original (motion picture )?soundtrack|ost|walt disney records|broadway|music from)\b/.test(blob)
    ) {
      score += 35
    }
  } else if (
    !junk &&
    /\b(original (motion picture )?soundtrack|various artists|varios artistas)\b/.test(blob)
  ) {
    // Canciones normales: penalizar packs / OST genéricos
    score -= 80
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

  const mulanCtx =
    /\b(mulan|reflejo|reflection|mi reflejo)\b/.test(ctx) || /\bmulan\b/.test(movieHint)
  if (mulanCtx) {
    const wantLangMulan = detectOstArtistLang(wantContext)
    if (wantLangMulan === 'es-lat' && /\blucero\b/.test(blob)) score += 160
    else if (wantLangMulan === 'es' && /\b(malu|maria caneda)\b/.test(blob)) score += 160
    else if (wantLangMulan === 'en' && /\b(christina aguilera|lea salonga)\b/.test(blob)) {
      score += 160
    }
    if (/\bmulan\b/.test(alb) && /\b(soundtrack|banda sonora|walt disney|motion picture)\b/.test(blob)) {
      score += 50
    }
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

function buildQueries(songName: string, hintArtist: string, extraContext = ''): string[] {
  const q = cleanQuery(songName)
  const core = coreSongTitle(songName)
  if (!q && !core) return []
  const queries: string[] = []
  const fullCtx = `${songName} ${hintArtist} ${extraContext}`
  const known = findKnownTrack(fullCtx)
  const artistOk = Boolean(
    hintArtist &&
      !/desconocido|unknown|sin álbum/i.test(hintArtist) &&
      !isLowQualityRelease(hintArtist, '', songName) &&
      !isWrongKnownArtist(songName, hintArtist, extraContext),
  )
  const hints = contextSearchHints(songName, artistOk ? hintArtist : '')
  const enSong = disneyEnglishTitle(songName)
  const movie = extractQuotedMovie(songName) || disneyEnglishMovie(extraContext)
  const enMovie = movie ? disneyEnglishMovie(movie) || (disneyEnglishMovie(extraContext) ? disneyEnglishMovie(extraContext) : null) : disneyEnglishMovie(extraContext)
  const wantLang = detectOstArtistLang(fullCtx)
  const langCast = findDisneyLangCast(fullCtx)
  const franchise = isDisneyOrAnimeSearchContext(fullCtx)

  // Sin artista + Disney: buscar primero con el cantante del idioma correcto
  if (franchise && langCast && !artistOk) {
    for (const a of preferredArtistsForLang(langCast, wantLang)) {
      queries.push(`${a} ${core || q}`)
      queries.push(`${core || q} ${a}`)
      if (enMovie || extraContext) {
        queries.push(`${a} ${core || q} ${enMovie || cleanQuery(extraContext)}`)
      }
    }
  }

  // Prioridad: queries del idioma detectado (cast original)
  if (langCast) {
    const qKey = wantLang === 'es-lat' ? 'lat' : wantLang
    queries.push(...langCast.queries[qKey])
  }

  // Queries fijas conocidas: solo si no hay cast por idioma (evita mezclar EN/ES)
  if (known && !langCast) {
    queries.push(...known.queries)
  }

  // Artista conocido: siempre buscar “artista + título” antes que el título solo
  if (artistOk) {
    queries.push(`${cleanQuery(hintArtist)} ${core || q}`)
    queries.push(`${core || q} ${cleanQuery(hintArtist)}`)
  }

  // Sufijos de idioma para Disney (sin hardcodear Lucero en todo)
  if (franchise) {
    const base = core || q
    if (wantLang === 'es-lat') {
      queries.push(`${base} español latino Disney`, `${base} doblaje latino`)
      if (extraContext) queries.push(`${base} ${cleanQuery(extraContext)} Disney latino`)
    } else if (wantLang === 'es') {
      queries.push(`${base} castellano Disney España`, `${base} doblaje español España`)
    } else {
      queries.push(
        `${base} original soundtrack English`,
        `${base} original motion picture soundtrack`,
      )
    }
  }

  for (const hint of hints) {
    if (core) queries.push(`${core} ${hint}`)
    if (q) queries.push(`${q} ${hint}`)
  }

  if (enSong && wantLang === 'en') {
    queries.push(enSong)
    if (enMovie) queries.push(`${enSong} ${enMovie}`)
    queries.push(`${enSong} Disney`)
  } else if (enSong && wantLang !== 'en' && langCast) {
    // Respaldo EN solo con artista preferido del idioma (no título EN suelto)
    for (const a of preferredArtistsForLang(langCast, wantLang)) {
      queries.push(`${a} ${enSong}`)
    }
  } else if (enSong && wantLang !== 'en') {
    queries.push(enSong)
  }

  // Título solo al final (muy suelto); en Disney/Anime evitarlo si ya hay cast
  if (!franchise || !langCast) {
    if (core) queries.push(core)
    if (q) queries.push(q)
  } else {
    // Con película en álbum: título + película
    if (extraContext) {
      if (core) queries.push(`${core} ${cleanQuery(extraContext)}`)
      if (q) queries.push(`${q} ${cleanQuery(extraContext)}`)
    }
  }

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

  // Umbral alto: evita covers / coincidencias flojas de título
  if (!best || bestScore < 85) return null

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
    matchScore: bestScore,
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
  if (!best?.trackName || bestScore < 85) return null

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
    matchScore: bestScore,
  }
}

function isJunkCoverArtist(info: OnlineTrackInfo): boolean {
  return isLowQualityRelease(info.artist, info.album, info.title)
}

export async function enrichFromInternet(
  songName: string,
  hintArtist = '',
  extraContext = '',
): Promise<OnlineTrackInfo | null> {
  const wantTitle = coreSongTitle(songName) || cleanQuery(songName)
  if (!wantTitle) return null
  const wantArtist = cleanQuery(hintArtist)
  const wantContext = `${songName} ${hintArtist} ${extraContext}`
  const queries = buildQueries(songName, hintArtist, extraContext)
  const franchiseCtx = isDisneyOrAnimeSearchContext(wantContext)
  const ctxNorm = norm(wantContext)
  const disneyCtx =
    franchiseCtx &&
    (isDisney(ctxNorm, '') ||
      Boolean(disneyEnglishTitle(songName) || disneyEnglishMovie(wantContext)))
  const animeCtx = franchiseCtx && isAnime(ctxNorm, '') && !disneyCtx
  const wantLang = detectOstArtistLang(wantContext)
  const langCast = findDisneyLangCast(wantContext)
  const preferred =
    disneyCtx && langCast ? preferredArtistsForLang(langCast, wantLang) : []
  const otherLang =
    disneyCtx && langCast ? otherLangArtists(langCast, wantLang) : []
  const strictNonFranchise = !franchiseCtx

  let best: OnlineTrackInfo | null = null
  let bestScore = -1

  const consider = (hit: OnlineTrackInfo | null, strictLang: boolean) => {
    if (!hit || isJunkCoverArtist(hit)) return
    if (wantArtist && !artistsCompatible(wantArtist, hit.artist)) return

    if (strictNonFranchise) {
      if (isGenericWeirdArtistOrAlbum(hit.artist, hit.album, hit.title)) return
      if (
        !wantArtist &&
        /\b(various artists|varios artistas|original soundtrack|motion picture|walt disney|anime|ost)\b/.test(
          norm(`${hit.artist} ${hit.album}`),
        )
      ) {
        return
      }
    }

    // Solo Disney/Anime: filtrar covers y quedarse con OST / cast original
    if (franchiseCtx && !acceptsFranchiseOriginal(hit, wantContext, disneyCtx, animeCtx)) {
      return
    }

    // Sin artista local + Disney conocido: exigir cantante del idioma (1ª pasada)
    if (disneyCtx && langCast && preferred.length) {
      const blob = norm(`${hit.artist} ${hit.album} ${hit.title}`)
      if (otherLang.some((a) => blob.includes(a)) && !preferred.some((a) => blob.includes(a))) {
        return
      }
      if (strictLang && !preferred.some((a) => blob.includes(a))) {
        return
      }
    }

    if (isDoubtfulMetadata({ ...hit, hasCover: true })) {
      if (
        !/\b(soundtrack|banda sonora|walt disney|motion picture|animation soundtrack)\b/i.test(
          `${hit.album} ${hit.artist}`,
        )
      ) {
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
    if (score < 0) return
    if (strictNonFranchise && !wantArtist && score < 100) return
    // Disney sin artista: umbral más alto si no es el cast preferido
    if (disneyCtx && !wantArtist && preferred.length) {
      const blob = norm(`${hit.artist} ${hit.album} ${hit.title}`)
      if (!preferred.some((a) => blob.includes(a)) && score < 160) return
    }
    if (score > bestScore) {
      bestScore = score
      best = hit
    }
  }

  const itunesCountries = itunesCountriesForLang(wantLang, franchiseCtx)

  const runSearch = async (strictLang: boolean) => {
    if (franchiseCtx) {
      for (const country of itunesCountries) {
        for (const term of queries.slice(0, 12)) {
          try {
            consider(
              await searchITunes(term, wantTitle, wantArtist, country, wantContext),
              strictLang,
            )
          } catch {
            // siguiente
          }
        }
        // Con cast preferido exigir más puntuación antes de parar
        if (bestScore >= (preferred.length && strictLang ? 220 : 180)) break
      }
    } else {
      for (const country of itunesCountries.slice(0, wantArtist ? 3 : 2)) {
        for (const term of queries.slice(0, wantArtist ? 8 : 6)) {
          try {
            consider(
              await searchITunes(term, wantTitle, wantArtist, country, wantContext),
              strictLang,
            )
          } catch {
            // siguiente
          }
        }
        if (bestScore >= (wantArtist ? 150 : 130)) break
      }
    }

    for (const term of queries) {
      try {
        consider(await searchDeezer(term, wantTitle, wantArtist, wantContext), strictLang)
      } catch {
        // siguiente
      }
    }

    if (!best || !(best as OnlineTrackInfo).year || !(best as OnlineTrackInfo).genre || bestScore < 120) {
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
            consider(itunes, strictLang)
            const b = best as OnlineTrackInfo | null
            if (b && b.year && b.genre && bestScore >= 180) break
          } catch {
            // siguiente
          }
        }
        const b = best as OnlineTrackInfo | null
        if (b && b.year && b.genre && bestScore >= 180) break
      }
    }
  }

  // 1ª pasada: solo cantante del idioma (cuando no hay artista en el archivo)
  await runSearch(Boolean(disneyCtx && !wantArtist && preferred.length))
  // 2ª: OST original mismo idioma-película, pero NUNCA cast de otro idioma
  if (!best && disneyCtx && preferred.length) {
    await runSearch(false)
  }

  if (best) {
    const b = best as OnlineTrackInfo
    b.matchScore = bestScore
    b.genre = refineGenre({
      title: b.title,
      artist: b.artist,
      album: b.album,
      genre: b.genre,
      fileName: songName,
    })
  }

  if (best && !titlesCompatible(wantTitle, (best as OnlineTrackInfo).title)) {
    return null
  }
  if (wantArtist && best && !artistsCompatible(wantArtist, (best as OnlineTrackInfo).artist)) {
    return null
  }
  // Disney conocido sin artista: no aceptar si sigue siendo otro idioma
  if (best && disneyCtx && langCast && preferred.length && !wantArtist) {
    const blob = norm(
      `${(best as OnlineTrackInfo).artist} ${(best as OnlineTrackInfo).album}`,
    )
    if (otherLang.some((a) => blob.includes(a)) && !preferred.some((a) => blob.includes(a))) {
      return null
    }
  }

  const minScore =
    disneyCtx && preferred.length && !wantArtist
      ? 120
      : knownTrackQueries(`${wantTitle} ${wantArtist} ${wantContext}`).length && wantArtist
        ? 70
        : strictNonFranchise && !wantArtist
          ? 100
          : 85
  return best && bestScore >= minScore ? best : null
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
