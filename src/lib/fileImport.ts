import { parseBlob } from 'music-metadata'
import { enrichFromInternet, fetchCoverBlob, isLowQualityRelease, refineGenre } from './enrich'

export interface ParsedTags {
  title: string
  artist: string
  album: string
  genre: string
  year: string
  coverBlob: Blob | null
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

    return {
      title: common.title || fallbackTitle,
      artist: common.artist || common.albumartist || 'Artista desconocido',
      album: common.album || 'Sin álbum',
      genre: common.genre?.[0] || '',
      year,
      coverBlob,
    }
  } catch {
    return {
      title: fallbackTitle,
      artist: 'Artista desconocido',
      album: 'Sin álbum',
      genre: '',
      year: '',
      coverBlob: null,
    }
  }
}

/** Lee tags locales y completa siempre con internet (portada, año, artista, álbum…). */
export async function readTagsEnriched(
  file: File,
): Promise<ParsedTags & { enriched: boolean; externalUrl?: string }> {
  const local = await readTags(file)

  const online =
    (await enrichFromInternet(local.title || file.name, local.artist)) ||
    (file.name.replace(/\.[^.]+$/, '') !== local.title
      ? await enrichFromInternet(file.name, local.artist)
      : null) ||
    (/desconocido/i.test(local.artist)
      ? null
      : await enrichFromInternet(`${local.artist} ${local.title}`, ''))

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

  let coverBlob = local.coverBlob
  const localJunk = isLowQualityRelease(local.artist, local.album, local.title)
  if ((!coverBlob || localJunk) && online.coverUrl) {
    const remote = await fetchCoverBlob(online.coverUrl)
    if (remote) coverBlob = remote
  }

  const artistUnknown =
    !local.artist || /desconocido/i.test(local.artist) || localJunk
  const albumUnknown =
    !local.album || /sin álbum/i.test(local.album) || localJunk
  const titleLooksWeak =
    !local.title ||
    local.title === file.name.replace(/\.[^.]+$/, '') ||
    /_|^\d+\s*-/.test(local.title)

  const title = titleLooksWeak && online.title ? online.title : local.title || online.title
  const artist = artistUnknown ? online.artist : local.artist
  const album = albumUnknown ? online.album : local.album

  return {
    title,
    artist,
    album,
    genre: refineGenre({
      title,
      artist,
      album,
      genre: localJunk ? online.genre || local.genre : local.genre || online.genre,
      fileName: file.name,
    }),
    year: local.year || online.year,
    coverBlob,
    enriched: true,
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

export const AUDIO_EXTENSIONS = [
  'mp3',
  'wav',
  'm4a',
  'aac',
  'ogg',
  'flac',
  'webm',
  'opus',
  'mpeg',
  'mp4',
]

export function isAudioFile(file: File): boolean {
  const name = (file.name || '').toLowerCase()
  const type = (file.type || '').toLowerCase()
  if (type.startsWith('audio/')) return true
  if (type === 'video/mp4' && /\.(m4a|mp4|aac)$/i.test(name)) return true
  if (
    (type === '' || type === 'application/octet-stream') &&
    /\.(mp3|m4a|aac|wav|flac|ogg|mpeg)$/i.test(name)
  ) {
    return true
  }
  const ext = name.split('.').pop() ?? ''
  return AUDIO_EXTENSIONS.includes(ext)
}

export function isMp3File(file: File): boolean {
  const name = file.name.toLowerCase()
  return name.endsWith('.mp3') || file.type === 'audio/mpeg' || file.type === 'audio/mp3'
}

export function guessAudioMime(fileName: string): string {
  const n = fileName.toLowerCase()
  if (n.endsWith('.m4a') || n.endsWith('.mp4') || n.endsWith('.aac')) return 'audio/mp4'
  if (n.endsWith('.wav')) return 'audio/wav'
  if (n.endsWith('.ogg')) return 'audio/ogg'
  if (n.endsWith('.flac')) return 'audio/flac'
  return 'audio/mpeg'
}

/** Fuerza descarga desde iCloud/Archivos y fija un MIME usable. */
export async function materializeAudioFile(file: File): Promise<File> {
  const buf = await file.arrayBuffer()
  const type =
    file.type && file.type !== 'application/octet-stream'
      ? file.type
      : guessAudioMime(file.name)
  return new File([buf], file.name || `cancion-${Date.now()}.mp3`, {
    type,
    lastModified: file.lastModified || Date.now(),
  })
}

export function createId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}
