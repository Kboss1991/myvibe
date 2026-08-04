import { isLibraryHostCapable } from './folderImport'

/** MIME interno para arrastrar ids de canciones (PC). */
export const TRACK_DRAG_MIME = 'application/x-myvibe-track-ids'

/** Solo escritorio: arrastrar selección a playlists. */
export function canDragTracksToPlaylists(): boolean {
  return isLibraryHostCapable()
}

export function setTrackDragData(
  dataTransfer: DataTransfer,
  ids: string[],
): void {
  const unique = [...new Set(ids.filter(Boolean))]
  const payload = JSON.stringify(unique)
  dataTransfer.setData(TRACK_DRAG_MIME, payload)
  dataTransfer.setData('text/plain', payload)
  dataTransfer.effectAllowed = 'copy'
}

export function getTrackDragIds(dataTransfer: DataTransfer): string[] {
  const raw =
    dataTransfer.getData(TRACK_DRAG_MIME) ||
    dataTransfer.getData('text/plain') ||
    ''
  if (!raw.trim()) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((x): x is string => typeof x === 'string' && Boolean(x))
  } catch {
    return []
  }
}

export function dataTransferHasTracks(dataTransfer: DataTransfer): boolean {
  const types = dataTransfer.types
  if (!types) return false
  const list = Array.from(types as ArrayLike<string>)
  return (
    list.includes(TRACK_DRAG_MIME) ||
    list.includes('text/plain') ||
    list.includes('Text')
  )
}
