export type RepeatMode = 'off' | 'all' | 'one'

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
  playCount: number
  lastPlayedAt: number | null
  createdAt: number
  enriched: boolean
  externalUrl?: string
}

export interface Playlist {
  id: string
  name: string
  description: string
  trackIds: string[]
  hasCover: boolean
  createdAt: number
  updatedAt: number
}

export interface PlaybackSnapshot {
  id: string
  currentTrackId: string | null
  queue: string[]
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
