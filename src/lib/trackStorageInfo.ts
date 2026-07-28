import { db } from '../db'
import { isAppleMobile, isLibraryHostDevice } from './folderImport'
import { readBinary, supportsOpfs } from './opfs'
import type { Track } from '../types'

export type TrackStorageInfo = {
  deviceLabel: string
  /** Resumen corto para el botón */
  summary: string
  lines: string[]
  trackId: string
  hasAudio: boolean
  hasCover: boolean
}

/**
 * Dónde guarda MyVibe esta canción en ESTE dispositivo
 * (no es Explorador/Archivos: es almacenamiento privado del navegador).
 */
export async function getTrackLocalStorageInfo(track: Track): Promise<TrackStorageInfo> {
  const id = track.id
  const deviceLabel = isLibraryHostDevice()
    ? 'Este PC'
    : isAppleMobile()
      ? 'Este iPhone'
      : 'Este dispositivo'

  if (track.hasLocalAudio === false) {
    return {
      deviceLabel,
      summary: 'Solo en el PC · sin audio aquí',
      trackId: id,
      hasAudio: false,
      hasCover: false,
      lines: [
        'Esta pista es un acceso al catálogo del PC.',
        'Aún no hay MP3 ni carátula guardados en este dispositivo.',
        'Descárgala desde Biblioteca para copiar audio + portada aquí.',
        '',
        `ID: ${id}`,
        'Metadatos nube: Supabase (library_tracks)',
      ],
    }
  }

  const opfsOk = supportsOpfs()
  const audioOpfs = opfsOk ? await readBinary('audio', id) : null
  const coverOpfs = opfsOk ? await readBinary('covers', id) : null
  const audioIdb = await db.audio.get(id)
  const coverIdb = await db.covers.get(id)
  const meta = await db.tracks.get(id)

  const hasAudio = Boolean(audioOpfs || audioIdb?.blob)
  const hasCover = Boolean(coverOpfs || coverIdb?.blob || track.hasCover)

  const lines: string[] = [
    'MyVibe guarda dos tipos de datos:',
    '',
    '1) App / navegador (para reproducir):',
    '   IndexedDB “myvibe” + OPFS (/audio, /covers).',
    '   Borrar: Perfil → “Borrar música de este dispositivo”.',
    '',
    '2) Carpeta visible (si la guardaste):',
    '   PC/iPhone → Descargas → MyVibe → “MyVibe - …mp3”.',
    '   Eso se borra en el Explorador / app Archivos.',
    '',
    `Dispositivo: ${deviceLabel}`,
    `Base de datos: IndexedDB → “myvibe”`,
    '',
    '· Metadatos (título, artista, álbum…)',
    `  tabla tracks → id ${id}`,
  ]

  if (meta) {
    lines.push(
      `  título: ${meta.title}`,
      `  artista: ${meta.artist}`,
      `  álbum: ${meta.album || '—'}`,
    )
  }

  lines.push('', '· Audio (MP3)')
  if (audioOpfs) {
    lines.push(
      `  OPFS → /audio/${id}`,
      `  tamaño ≈ ${Math.round(audioOpfs.size / 1024)} KB`,
    )
  } else if (audioIdb?.blob) {
    lines.push(
      `  IndexedDB → tabla audio → id ${id}`,
      `  tamaño ≈ ${Math.round(audioIdb.blob.size / 1024)} KB`,
    )
  } else {
    lines.push('  (no encontrado en este dispositivo)')
  }

  lines.push('', '· Carátula')
  if (coverOpfs) {
    lines.push(
      `  OPFS → /covers/${id}`,
      `  tamaño ≈ ${Math.round(coverOpfs.size / 1024)} KB`,
    )
  } else if (coverIdb?.blob) {
    lines.push(
      `  IndexedDB → tabla covers → id ${id}`,
      `  tamaño ≈ ${Math.round(coverIdb.blob.size / 1024)} KB`,
    )
  } else {
    lines.push('  (sin carátula local)')
  }

  if (track.fileName) {
    lines.push('', `Nombre original del archivo: ${track.fileName}`)
  }

  lines.push(
    '',
    'En Chrome (PC): DevTools → Application → IndexedDB → myvibe',
    'y Storage → File System (OPFS) si está disponible.',
  )

  const whereAudio = audioOpfs ? 'OPFS/audio' : audioIdb ? 'IndexedDB/audio' : '—'
  const whereCover = coverOpfs ? 'OPFS/covers' : coverIdb ? 'IndexedDB/covers' : 'sin carátula'

  return {
    deviceLabel,
    summary: `${deviceLabel} · ${whereAudio} · ${whereCover}`,
    lines,
    trackId: id,
    hasAudio,
    hasCover,
  }
}
