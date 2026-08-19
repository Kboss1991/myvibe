export type RepeatMode = 'off' | 'all' | 'one'

/** Origen de la cola actual (solo UI MyVibe; no va a CarPlay). */
export type PlaybackSource =
  | { kind: 'playlist'; id: string; title: string }
  | { kind: 'liked'; title: string }

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
  /** Cuándo se guardó el audio en este dispositivo (ms). */
  audioUpdatedAt?: number
  /**
   * El PC tiene una versión más nueva del audio (según nube).
   * El móvil sigue reproduciendo la copia vieja hasta pulsar Actualizar.
   */
  needsAudioUpdate?: boolean
  /** Último audio_updated_at de la nube que este móvil ya ha tenido en cuenta. */
  cloudAudioSeenAt?: number
  /** Tamaño del MP3 local (bytes); se compara con la nube. */
  audioBytes?: number
  /** Última edición manual de título/artista/álbum/género (ms). LWW vs nube. */
  metaUpdatedAt?: number
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
  currentRadioId?: string | null
  currentPodcastEpisodeId?: string | null
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
  /** Lista / Me gusta desde la que se lanzó la cola (Now Playing). */
  playbackSource?: PlaybackSource | null
  /** Show del podcast para poder restaurar el mini reproductor al reabrir. */
  podcastShow?: {
    id: string
    name: string
    artist: string
    feedUrl: string
    artworkUrl: string
    genre?: string
  } | null
  /** Cola de episodios actual para seguir sin repetir al reabrir. */
  podcastQueue?: Array<{
    id: string
    showId: string
    title: string
    description: string
    audioUrl: string
    pubDate: string
    durationSec: number
    artworkUrl: string
  }>
  coverUrl?: string | null
  duration?: number
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
