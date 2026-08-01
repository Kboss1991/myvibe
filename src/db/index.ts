import Dexie, { type EntityTable } from 'dexie'
import type {
  AudioRecord,
  CoverRecord,
  PlaybackSnapshot,
  Playlist,
  Track,
  User,
} from '../types'

class MyVibeDB extends Dexie {
  tracks!: EntityTable<Track, 'id'>
  playlists!: EntityTable<Playlist, 'id'>
  covers!: EntityTable<CoverRecord, 'id'>
  audio!: EntityTable<AudioRecord, 'id'>
  playback!: EntityTable<PlaybackSnapshot, 'id'>
  users!: EntityTable<User, 'id'>

  constructor() {
    super('myvibe')
    this.version(1).stores({
      tracks: 'id, title, artist, album, liked, lastPlayedAt, createdAt',
      playlists: 'id, name, updatedAt',
      covers: 'id',
      audio: 'id',
      playback: 'id',
    })
    this.version(2)
      .stores({
        tracks: 'id, title, artist, album, liked, lastPlayedAt, createdAt',
        playlists: 'id, name, updatedAt',
        covers: 'id',
        audio: 'id',
        playback: 'id',
        users: 'id, username',
      })
      .upgrade(async (tx) => {
        const tracks = await tx.table('tracks').toArray()
        for (const t of tracks) {
          await tx.table('tracks').update(t.id, {
            year: t.year ?? '',
            enriched: t.enriched ?? false,
          })
        }
      })
    this.version(3)
      .stores({
        tracks: 'id, title, artist, album, liked, lastPlayedAt, createdAt',
        playlists: 'id, name, updatedAt',
        covers: 'id',
        audio: 'id',
        playback: 'id',
        users: 'id, email, username',
      })
      .upgrade(async (tx) => {
        const users = await tx.table('users').toArray()
        for (const u of users) {
          const email =
            (u.email as string | undefined) ||
            (typeof u.username === 'string' && u.username.includes('@')
              ? u.username.toLowerCase()
              : `${String(u.username || u.id).toLowerCase()}@local.myvibe`)
          await tx.table('users').update(u.id, {
            email,
            username: u.username || email.split('@')[0],
          })
        }
      })
    this.version(4).upgrade(async (tx) => {
      const playlists = await tx.table('playlists').toArray()
      for (const p of playlists) {
        await tx.table('playlists').update(p.id, {
          description: p.description ?? '',
          hasCover: p.hasCover ?? false,
        })
      }
    })
  }
}

export const db = new MyVibeDB()

export const PLAYBACK_KEY = 'main'
export const SESSION_KEY = 'myvibe_session'
export const REMEMBER_EMAIL_KEY = 'myvibe_remember_email'

export async function ensurePlaybackSnapshot(): Promise<PlaybackSnapshot> {
  const existing = await db.playback.get(PLAYBACK_KEY)
  if (existing) return existing

  const snapshot: PlaybackSnapshot = {
    id: PLAYBACK_KEY,
    currentTrackId: null,
    queue: [],
    index: 0,
    shuffle: true,
    repeat: 'off',
    position: 0,
    volume: 1,
    recentIds: [],
  }
  await db.playback.put(snapshot)
  return snapshot
}
