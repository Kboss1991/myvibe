import { create } from 'zustand'
import { liveQuery } from 'dexie'
import { db, ensurePlaybackSnapshot, PLAYBACK_KEY } from '../db'
import type { Playlist, Track } from '../types'
import * as library from '../lib/library'

interface LibraryState {
  tracks: Track[]
  playlists: Playlist[]
  ready: boolean
  importProgress: { done: number; total: number; name: string } | null
  enrichProgress: { done: number; total: number; name: string } | null
  init: () => () => void
  importFiles: (files: File[], options?: { mp3Only?: boolean }) => Promise<Track[]>
  enrichTrack: (id: string, options?: { force?: boolean }) => Promise<{ found: boolean; coverUpdated: boolean }>
  enrichMissingCovers: () => Promise<{ ok: number; fail: number }>
  enrichSelected: (ids: string[]) => Promise<{ ok: number; fail: number }>
  shareTrack: (id: string) => Promise<'shared' | 'downloaded'>
  sharePlaylist: (id: string) => Promise<'shared' | 'downloaded'>
  shareLiked: () => Promise<'shared' | 'downloaded'>
  shareLibrary: () => Promise<'shared' | 'downloaded'>
  importShare: (file: File) => Promise<{
    trackIds: string[]
    playlistId: string | null
    playlistCount: number
  }>
  setLiked: (ids: string[], liked: boolean) => Promise<void>
  deleteTracks: (ids: string[]) => Promise<void>
  deleteTrack: (id: string) => Promise<void>
  updateTrack: (
    id: string,
    patch: Partial<Pick<Track, 'title' | 'artist' | 'album' | 'genre'>>,
  ) => Promise<void>
  setCover: (id: string, file: File) => Promise<void>
  toggleLike: (id: string) => Promise<void>
  createPlaylist: (name: string) => Promise<Playlist>
  renamePlaylist: (id: string, name: string) => Promise<void>
  updatePlaylistInfo: (
    id: string,
    patch: Partial<Pick<Playlist, 'name' | 'description'>>,
  ) => Promise<void>
  setPlaylistCover: (id: string, file: File) => Promise<void>
  deletePlaylist: (id: string) => Promise<void>
  addToPlaylist: (playlistId: string, trackIds: string[]) => Promise<void>
  removeFromPlaylist: (playlistId: string, trackId: string) => Promise<void>
  getLiked: () => Track[]
  getRecent: () => Track[]
  search: (q: string) => Track[]
  artists: () => { name: string; tracks: Track[] }[]
  albums: () => { name: string; artist: string; tracks: Track[] }[]
  genres: () => { name: string; tracks: Track[] }[]
}

export const useLibraryStore = create<LibraryState>((set, get) => ({
  tracks: [],
  playlists: [],
  ready: false,
  importProgress: null,
  enrichProgress: null,

  init: () => {
    void ensurePlaybackSnapshot()
    const subTracks = liveQuery(() => db.tracks.orderBy('createdAt').reverse().toArray()).subscribe({
      next: (tracks) => set({ tracks, ready: true }),
      error: () => set({ ready: true }),
    })
    const subPlaylists = liveQuery(() =>
      db.playlists.orderBy('updatedAt').reverse().toArray(),
    ).subscribe({
      next: (playlists) => set({ playlists }),
    })
    return () => {
      subTracks.unsubscribe()
      subPlaylists.unsubscribe()
    }
  },

  importFiles: async (files, options) => {
    set({ importProgress: { done: 0, total: files.length, name: '' } })
    const imported = await library.importAudioFiles(
      files,
      (done, total, name) => {
        set({ importProgress: { done, total, name } })
      },
      options,
    )
    set({ importProgress: null })
    return imported
  },

  enrichTrack: async (id, options) => {
    const result = await library.enrichTrackOnline(id, options)
    return {
      found: result?.found ?? false,
      coverUpdated: result?.coverUpdated ?? false,
    }
  },

  enrichMissingCovers: async () => {
    set({ enrichProgress: { done: 0, total: 1, name: '' } })
    const result = await library.enrichTracksMissingCover((done, total, name) => {
      set({ enrichProgress: { done, total, name } })
    })
    set({ enrichProgress: null })
    return result
  },

  enrichSelected: async (ids) => {
    set({ enrichProgress: { done: 0, total: ids.length, name: '' } })
    const result = await library.enrichTracksByIds(ids, (done, total, name) => {
      set({ enrichProgress: { done, total, name } })
    })
    set({ enrichProgress: null })
    return result
  },

  shareTrack: async (id) => {
    const { buildTrackSharePackage, packageToFile, sharePackageFile } = await import(
      '../lib/share'
    )
    set({ importProgress: { done: 0, total: 1, name: 'Preparando…' } })
    try {
      const pack = await buildTrackSharePackage(id)
      const file = packageToFile(pack)
      return await sharePackageFile(file, pack.tracks[0]?.title || 'Canción')
    } finally {
      set({ importProgress: null })
    }
  },

  sharePlaylist: async (id) => {
    const { buildPlaylistSharePackage, packageToFile, sharePackageFile } = await import(
      '../lib/share'
    )
    set({ importProgress: { done: 0, total: 1, name: 'Preparando…' } })
    try {
      const pack = await buildPlaylistSharePackage(id, undefined, (done, total, name) => {
        set({ importProgress: { done, total, name } })
      })
      const file = packageToFile(pack)
      return await sharePackageFile(file, pack.playlist?.name || 'Playlist')
    } finally {
      set({ importProgress: null })
    }
  },

  shareLiked: async () => {
    const { buildLikedSharePackage, packageToFile, sharePackageFile } = await import(
      '../lib/share'
    )
    const liked = get().tracks.filter((t) => t.liked)
    set({ importProgress: { done: 0, total: liked.length, name: 'Preparando…' } })
    try {
      const pack = await buildLikedSharePackage(liked, undefined, (done, total, name) => {
        set({ importProgress: { done, total, name } })
      })
      const file = packageToFile(pack)
      return await sharePackageFile(file, 'Me gusta')
    } finally {
      set({ importProgress: null })
    }
  },

  shareLibrary: async () => {
    const { downloadLibraryZip } = await import('../lib/share')
    const { useAuthStore } = await import('./authStore')
    const userId = useAuthStore.getState().user?.id
    const total = get().tracks.length
    set({ importProgress: { done: 0, total: Math.max(total, 1), name: 'Preparando…' } })
    try {
      return await downloadLibraryZip(userId, (done, t, name) => {
        set({ importProgress: { done, total: t, name } })
      })
    } finally {
      set({ importProgress: null })
    }
  },

  importShare: async (file) => {
    const { importSharePackage } = await import('../lib/share')
    set({ importProgress: { done: 0, total: 1, name: '' } })
    try {
      const result = await importSharePackage(file, (done, total, name) => {
        set({ importProgress: { done, total, name } })
      })
      return {
        trackIds: result.trackIds,
        playlistId: result.playlist?.id ?? null,
        playlistCount: result.playlistCount,
      }
    } finally {
      set({ importProgress: null })
    }
  },

  setLiked: (ids, liked) => library.setTracksLiked(ids, liked),
  deleteTracks: (ids) => library.deleteTracks(ids),

  deleteTrack: (id) => library.deleteTrack(id),
  updateTrack: (id, patch) => library.updateTrackMeta(id, patch),
  setCover: (id, file) => library.setTrackCover(id, file),
  toggleLike: async (id) => {
    await library.toggleLike(id)
  },
  createPlaylist: (name) => library.createPlaylist(name),
  renamePlaylist: (id, name) => library.renamePlaylist(id, name),
  updatePlaylistInfo: (id, patch) => library.updatePlaylistInfo(id, patch),
  setPlaylistCover: (id, file) => library.setPlaylistCover(id, file),
  deletePlaylist: (id) => library.deletePlaylist(id),
  addToPlaylist: (playlistId, trackIds) => library.addTracksToPlaylist(playlistId, trackIds),
  removeFromPlaylist: (playlistId, trackId) =>
    library.removeTrackFromPlaylist(playlistId, trackId),

  getLiked: () => get().tracks.filter((t) => t.liked),
  getRecent: () =>
    [...get().tracks]
      .filter((t) => t.lastPlayedAt)
      .sort((a, b) => (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0))
      .slice(0, 30),
  search: (q) => {
    const query = q.trim().toLowerCase()
    if (!query) return []
    return get().tracks.filter(
      (t) =>
        t.title.toLowerCase().includes(query) ||
        t.artist.toLowerCase().includes(query) ||
        t.album.toLowerCase().includes(query) ||
        t.genre.toLowerCase().includes(query),
    )
  },
  artists: () => {
    const map = new Map<string, Track[]>()
    for (const t of get().tracks) {
      const key = t.artist || 'Artista desconocido'
      const list = map.get(key) ?? []
      list.push(t)
      map.set(key, list)
    }
    return [...map.entries()]
      .map(([name, tracks]) => ({ name, tracks }))
      .sort((a, b) => a.name.localeCompare(b.name, 'es'))
  },
  albums: () => {
    const map = new Map<string, { name: string; artist: string; tracks: Track[] }>()
    for (const t of get().tracks) {
      const key = `${t.album}::${t.artist}`
      const existing = map.get(key)
      if (existing) existing.tracks.push(t)
      else map.set(key, { name: t.album || 'Sin álbum', artist: t.artist, tracks: [t] })
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'es'))
  },
  genres: () => {
    const map = new Map<string, Track[]>()
    for (const t of get().tracks) {
      const key = t.genre?.trim() || 'Sin género'
      const list = map.get(key) ?? []
      list.push(t)
      map.set(key, list)
    }
    return [...map.entries()]
      .map(([name, tracks]) => ({ name, tracks }))
      .sort((a, b) => {
        if (a.name === 'Sin género') return 1
        if (b.name === 'Sin género') return -1
        return a.name.localeCompare(b.name, 'es')
      })
  },
}))

export async function persistRecent(trackId: string) {
  const snap = await db.playback.get(PLAYBACK_KEY)
  if (!snap) return
  const recentIds = [trackId, ...snap.recentIds.filter((id) => id !== trackId)].slice(0, 50)
  await db.playback.update(PLAYBACK_KEY, { recentIds })
}
