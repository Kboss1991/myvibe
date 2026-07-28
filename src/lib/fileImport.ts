import { parseBlob } from 'music-metadata'
import {
  enrichFromInternet,
  fetchCoverBlob,
  isLowQualityRelease,
  isWrongKnownArtist,
  refineGenre,
  titlesCompatible,
  artistsCompatible,
} from './enrich'

export interface ParsedTags {
  title: string
  artist: string
  album: string
  genre: string
  year: string
  coverBlob: Blob | null
}

/** "Mulán - Reflejo" / "Artista - Título" → separa partes. */
export function splitDashName(raw: string): { left: string; right: string } | null {
  const base = raw.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim()
  const parts = base.split(/\s*[-–—]\s*/).map((p) => p.trim()).filter(Boolean)
  if (parts.length !== 2) return null
  const [left, right] = parts
  if (!left || !right) return null
  if (left.length > 60 || right.length > 80) return null
  return { left, right }
}

function isUnknownArtist(artist: string): boolean {
  return (
    !artist.trim() ||
    /^(artista desconocido|unknown artist|unknown|desconocido)$/i.test(artist.trim())
  )
}

function isUnknownAlbum(album: string): boolean {
  return !album.trim() || /^(sin álbum|sin album|unknown album|unknown|n\/a)$/i.test(album.trim())
}

export async function readTags(file: File): Promise<ParsedTags> {
  const fallbackTitle = file.name.replace(/\.[^.]+$/, '')

  try {
    const metadata = await parseBlob(file, { duration: false })
    const { common } = metadata
    let coverBlob: Blob | null = null
    const picture = common.picture?.[0]
    if (picture?.data) {
      const copy = new Uint8Array(picture.data.byteLength)
      copy.set(picture.data)
      coverBlob = new Blob([copy.buffer], {
        type: picture.format || 'image/jpeg',
      })
    }

    const year =
      common.year?.toString() ||
      (common.date ? String(common.date).slice(0, 4) : '') ||
      ''

    let title = common.title || fallbackTitle
    let artist = common.artist || common.albumartist || 'Artista desconocido'
    let album = common.album || 'Sin álbum'

    // Sin artista: "Mulán - Reflejo" → título Reflejo, álbum Mulán
    if (isUnknownArtist(artist)) {
      const split = splitDashName(title) || splitDashName(file.name)
      if (split) {
        title = split.right
        if (isUnknownAlbum(album)) album = split.left
      }
    }

    return {
      title,
      artist,
      album,
      genre: common.genre?.[0] || '',
      year,
      coverBlob,
    }
  } catch {
    const split = splitDashName(file.name)
    return {
      title: split?.right || fallbackTitle,
      artist: 'Artista desconocido',
      album: split?.left || 'Sin álbum',
      genre: '',
      year: '',
      coverBlob: null,
    }
  }
}

/**
 * Al subir: lee tags del archivo y completa automáticamente
 * carátula + artista/álbum/año/género desde internet (sin pasos extra).
 */
export async function readTagsEnriched(
  file: File,
): Promise<ParsedTags & { enriched: boolean; externalUrl?: string }> {
  const local = await readTags(file)
  const searchName = local.title || file.name.replace(/\.[^.]+$/, '')
  const localJunk = isLowQualityRelease(local.artist, local.album, local.title)
  const artistUnknown =
    !local.artist || /desconocido|unknown/i.test(local.artist) || localJunk
  const albumUnknown =
    !local.album || /sin álbum|sin album|unknown/i.test(local.album) || localJunk
  const needsCover = !local.coverBlob || localJunk

  let online =
    // Primero artista+título si el archivo ya trae artista (evita otro “Sense tu” distinto)
    (!artistUnknown
      ? await enrichFromInternet(
          `${local.artist} ${searchName}`,
          local.artist,
          local.album,
        )
      : null) ||
    (await enrichFromInternet(
      searchName,
      artistUnknown ? '' : local.artist,
      local.album,
    )) ||
    (file.name.replace(/\.[^.]+$/, '') !== local.title
      ? await enrichFromInternet(
          file.name.replace(/\.[^.]+$/, ''),
          artistUnknown ? '' : local.artist,
          local.album,
        )
      : null)

  // Cast de otro idioma / cover conocido → descartar
  if (
    online &&
    isWrongKnownArtist(searchName, online.artist, online.album || local.album)
  ) {
    online = null
  }

  if (!online) {
    return {
      ...local,
      genre: refineGenre({
        title: local.title,
        artist: local.artist,
        album: local.album,
        genre: local.genre,
        fileName: file.name,
      }),
      enriched: false,
    }
  }

  const score = online.matchScore ?? 0
  const titleOk = titlesCompatible(searchName, online.title)
  const artistOk = artistUnknown || artistsCompatible(local.artist, online.artist)
  // Sin artista compatible no tocamos nada online (evita Rebels Punk en “Sense tu”)
  if (!titleOk || !artistOk) {
    return {
      ...local,
      genre: refineGenre({
        title: local.title,
        artist: local.artist,
        album: local.album,
        genre: local.genre,
        fileName: file.name,
      }),
      enriched: false,
    }
  }

  const goodEnough = score >= 80
  const strongMatch = score >= 95

  let coverBlob = local.coverBlob
  if (needsCover && online.coverUrl && goodEnough) {
    const remote = await fetchCoverBlob(online.coverUrl)
    if (remote) coverBlob = remote
  }

  // Conservar título local. Completar huecos solo con artista compatible.
  const title = local.title
  const artist = artistUnknown && goodEnough ? online.artist : local.artist
  const album = albumUnknown && (strongMatch || goodEnough) ? online.album : local.album
  const genre = refineGenre({
    title,
    artist,
    album,
    genre: local.genre || (goodEnough ? online.genre : ''),
    fileName: file.name,
  })
  const year = local.year || (goodEnough ? online.year : '')

  return {
    title,
    artist,
    album,
    genre,
    year,
    coverBlob,
    enriched: Boolean(coverBlob !== local.coverBlob) || artist !== local.artist || album !== local.album,
    externalUrl: online.externalUrl,
  }
}

export function getAudioDuration(file: Blob): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const audio = new Audio()
    let done = false
    const finish = (value: number) => {
      if (done) return
      done = true
      URL.revokeObjectURL(url)
      resolve(value)
    }
    const timer = window.setTimeout(() => finish(0), 8000)
    audio.preload = 'metadata'
    audio.onloadedmetadata = () => {
      window.clearTimeout(timer)
      finish(Number.isFinite(audio.duration) ? audio.duration : 0)
    }
    audio.onerror = () => {
      window.clearTimeout(timer)
      finish(0)
    }
    audio.src = url
  })
}

export function isAudioFile(file: File): boolean {
  const name = (file.name || '').toLowerCase()
  const type = (file.type || '').toLowerCase()
  if (type.startsWith('audio/')) return true
  if (type === 'video/mp4' && /\.(m4a|mp4|aac)$/i.test(name)) return true
  return /\.(mp3|m4a|aac|wav|ogg|flac|mpeg|mp4)$/i.test(name)
}

export function isMp3File(file: File): boolean {
  const name = (file.name || '').toLowerCase()
  const type = (file.type || '').toLowerCase()
  return type === 'audio/mpeg' || type === 'audio/mp3' || name.endsWith('.mp3')
}

export function guessAudioMime(fileName: string): string {
  const n = fileName.toLowerCase()
  if (n.endsWith('.mp3')) return 'audio/mpeg'
  if (n.endsWith('.m4a') || n.endsWith('.aac')) return 'audio/mp4'
  if (n.endsWith('.wav')) return 'audio/wav'
  if (n.endsWith('.flac')) return 'audio/flac'
  if (n.endsWith('.ogg')) return 'audio/ogg'
  return 'audio/mpeg'
}

export async function materializeAudioFile(file: File): Promise<File> {
  // iCloud: forzar lectura completa antes de parsear
  try {
    const buf = await file.arrayBuffer()
    return new File([buf], file.name, {
      type: file.type || guessAudioMime(file.name),
      lastModified: file.lastModified,
    })
  } catch {
    return file
  }
}

export function createId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}
