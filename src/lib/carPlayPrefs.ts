import { db } from '../db'
import { createPlaylist } from './library'

const STORAGE_KEY = 'myvibe.carPlayPlaylistId'
export const CAR_PLAY_DEFAULT_PLAYLIST_NAME = 'Desde el coche'

export function getCarPlayPlaylistId(): string | null {
  try {
    const id = localStorage.getItem(STORAGE_KEY)
    return id && id.trim() ? id.trim() : null
  } catch {
    return null
  }
}

export function setCarPlayPlaylistId(id: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, id)
  } catch {
    /* ignore */
  }
}

/**
 * Devuelve la playlist destino para el botón “Añadir a lista” de CarPlay.
 * Si no hay preferencia válida, crea/reutiliza “Desde el coche”.
 */
export async function ensureCarPlayPlaylist(): Promise<string> {
  const preferred = getCarPlayPlaylistId()
  if (preferred) {
    const row = await db.playlists.get(preferred)
    if (row) return preferred
  }

  const existing = (await db.playlists.toArray()).find(
    (p) => p.name.trim().toLowerCase() === CAR_PLAY_DEFAULT_PLAYLIST_NAME.toLowerCase(),
  )
  if (existing) {
    setCarPlayPlaylistId(existing.id)
    return existing.id
  }

  const created = await createPlaylist(CAR_PLAY_DEFAULT_PLAYLIST_NAME)
  setCarPlayPlaylistId(created.id)
  return created.id
}
