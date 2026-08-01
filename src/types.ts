export type RepeatMode = 'off' | 'all'

export interface Track {
  id: string
  title: string
  artist: string
  album: string
  genre: string
  year: string
  duration: number
  mimeType: string
  fileName: string
  hasCover: boolean
  liked: boolean
  /** Timestamp del último cambio de me gusta (sync LWW) */
  likedUpdatedAt?: number
  playCount: number
  lastPlayedAt: number | null
  createdAt: number
  enriched: boolean
  externalUrl?: string
  /** Cambia al subir/cambiar portada manualmente (cache-bust CoverArt) */
  coverUpdatedAt?: number
  /** false = solo metadatos en la nube; falta MP3 local */
  hasLocalAudio?: boolean
  /**
   * Origen de la pista:
   * - local = importada en este dispositivo
   * - cloud = llegó desde el catálogo/PC (stub o descarga)
   * Sirve para borrar en el iPhone lo que se borre en el PC.
   */
  origin?: 'local' | 'cloud'
}

export interface Playlist {
  id: string
  name: string
  description: string
  trackIds: string[]
  hasCover: boolean
  /** Color de fondo del hero (#rrggbb). */
  themeColor?: string
  createdAt: number
  updatedAt: number
}

export interface PlaybackSnapshot {
  id: string
  currentTrackId: string | null
  /** Cola de reproducción actual (puede estar mezclada). */
  queue: string[]
  /** Orden original antes del shuffle (para restaurar). */
  originalQueue: string[]
  /** Índice en `queue` de la canción actual (las anteriores ya sonaron). */
  index: number
  shuffle: boolean
  repeat: RepeatMode
  position: number
  volume: number
  recentIds: string[]
}

export interface CoverRecord {
  id: string
  blob: Blob
}

export interface AudioRecord {
  id: string
  blob: Blob
}

export interface User {
  id: string
  email: string
  /** @deprecated kept for migraciones; usar email */
  username: string
  displayName: string
  passwordHash: string
  salt: string
  avatarHue: number
  hasAvatar?: boolean
  /** Fuerza recarga de la imagen al cambiar el avatar */
  avatarUpdatedAt?: number
  createdAt: number
  bio: string
}
