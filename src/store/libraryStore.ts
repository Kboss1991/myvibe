import { create } from 'zustand'
import { liveQuery } from 'dexie'
import { db, ensurePlaybackSnapshot, PLAYBACK_KEY } from '../db'
import type { Playlist, Track } from '../types'
import * as library from '../lib/library'
import { isCloudAuthEnabled } from '../lib/auth'
import {
  getCloudCatalogCount,
  getDevicePeer,
  pruneCloudDuplicateTracks,
  pullLibraryCatalog,
  pushLibraryMetadata,
  pushLibraryLikes,
  pushLibraryPlaylists,
  removeCloudPlaylist,
  removeCloudTracks,
  syncLibraryTaste,
} from '../lib/cloudLibrary'
import { isLibraryHostDevice } from '../lib/devices'
import { downloadTracksFromPc } from '../lib/libraryHost'
import { useAuthStore } from './authStore'

let tasteSyncTimer: number | null = null

function scheduleTasteSync() {
  if (!isCloudAuthEnabled()) return
  const userId = useAuthStore.getState().user?.id
  if (!userId) return
  if (tasteSyncTimer != null) window.clearTimeout(tasteSyncTimer)
  tasteSyncTimer = window.setTimeout(() => {
    tasteSyncTimer = null
    void syncLibraryTaste(userId).catch((e) => {
      console.warn('Sync me gusta/playlists', e)
    })
  }, 800)
}

async function pushLikeNow(trackId: string) {
  if (!isCloudAuthEnabled()) return
  const userId = useAuthStore.getState().user?.id
  if (!userId) return
  try {
    await pushLibraryLikes(userId, trackId)
  } catch (e) {
    console.warn('Push like', e)
    scheduleTasteSync()
  }
}

async function pushPlaylistNow(playlistId?: string) {
  if (!isCloudAuthEnabled()) return
  const userId = useAuthStore.getState().user?.id
  if (!userId) return
  try {
    await pushLibraryPlaylists(userId, playlistId)
  } catch (e) {
    console.warn('Push playlist', e)
    scheduleTasteSync()
  }
}

interface LibraryState {
  tracks: Track[]
  playlists: Playlist[]
  ready: boolean
  importProgress: { done: number; total: number; name: string } | null
  enrichProgress: { done: number; total: number; name: string } | null
  pcOnline: boolean | null
  downloadProgress: {
    done: number
    total: number
    name: string
    trackId: string | null
    percent: number
    ids: string[]
  } | null
  lastSyncMessage: string | null
  lastSyncAt: number | null
  init: () => () => void
  importFiles: (files: File[], options?: { mp3Only?: boolean; enrich?: boolean }) => Promise<Track[]>
  enrichTrack: (id: string, options?: { force?: boolean }) => Promise<{ found: boolean; coverUpdated: boolean }>
  enrichMissingCovers: () => Promise<{ ok: number; fail: number }>
  enrichSelected: (ids: string[]) => Promise<{ ok: number; fail: number }>
  shareTrack: (id: string) => Promise<'shared' | 'downloaded'>
  sharePlaylist: (id: string) => Promise<'shared' | 'downloaded'>
  shareLiked: () => Promise<'shared' | 'downloaded'>
  shareLibrary: () => Promise<'shared' | 'downloaded'>
  exportLibraryFolder: () => Promise<{ count: number; folderHint: string }>
  exportLibraryPacks: () => Promise<{ packs: number; tracks: number }>
  exportToDownloads: () => Promise<{ saved: number; message: string }>
  syncCloudCatalog: () => Promise<{ pushed: number; pulled: number }>
  downloadFromPc: (ids: string[]) => Promise<{ imported: number; visibleFiles: import('../lib/visibleStorage').VisibleFile[] }>
  importShare: (file: File) => Promise<{
    trackIds: string[]
    playlistId: string | null
    playlistCount: number
  }>
  setLiked: (ids: string[], liked: boolean) => Promise<void>
  deleteTracks: (ids: string[]) => Promise<void>
  deleteTrack: (id: string) => Promise<void>
  clearLocalMusic: () => Promise<{ tracks: number }>
  purgeOrphanStorage: () => Promise<{ audio: number; covers: number; bytesApprox: number }>
  countOrphanStorage: () => Promise<{ audio: number; covers: number }>
  previewClearLocalMusic: () => Promise<{ summary: string; tracks: number }>
  previewOrphanPurge: () => Promise<{ summary: string; audio: number; covers: number }>
  updateTrack: (
    id: string,
    patch: Partial<Pick<Track, 'title' | 'artist' | 'album' | 'genre'>>,
  ) => Promise<void>
  setCover: (id: string, file: File) => Promise<void>
  replaceTrackAudio: (id: string, file: File) => Promise<void>
  replaceMissingAudio: (
    files: File[],
    trackIds?: string[],
  ) => Promise<{ replaced: number; unmatched: string[] }>
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
  reorderPlaylistTracks: (playlistId: string, trackIds: string[]) => Promise<void>
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
  pcOnline: null,
  downloadProgress: null,
  lastSyncMessage: null,
  lastSyncAt: null,

  init: () => {
    void ensurePlaybackSnapshot()
    void library.repairMissingLocalAudio().catch(() => {})
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
    set({ importProgress: { done: 0, total: files.length, name: '' }, enrichProgress: null })
    const enrich = options?.enrich !== false
    let phase: 'import' | 'enrich' = 'import'
    const imported = await library.importAudioFiles(
      files,
      (done, total, name) => {
        if (name.includes('carátula y datos')) phase = 'enrich'
        if (phase === 'enrich') {
          set({
            importProgress: null,
            enrichProgress: { done, total, name },
          })
        } else {
          set({
            importProgress: {
              done,
              total,
              name: name || 'Guardando…',
            },
          })
        }
      },
      { ...options, enrich },
    )
    set({ importProgress: null, enrichProgress: null })

    // Copia visible siempre que se pueda (PC: carpeta MyVibe; iPhone: Archivos)
    if (imported.length) {
      try {
        const { myVibeDownloadName, saveFilesVisibly } = await import('../lib/visibleStorage')
        const visible: { fileName: string; blob: Blob }[] = []
        for (const t of imported) {
          const blob = await library.getAudioBlob(t.id)
          if (!blob) continue
          visible.push({
            fileName: myVibeDownloadName(t.artist, t.title, t.fileName),
            blob: blob.slice(0, blob.size, blob.type || 'audio/mpeg'),
          })
        }
        if (visible.length) {
          set({
            importProgress: {
              done: 0,
              total: visible.length,
              name: isLibraryHostDevice()
                ? 'Copiando a Descargas/MyVibe…'
                : 'Guardando en Archivos…',
            },
          })
          await saveFilesVisibly(visible, {
            interactive: true,
            onProgress: (done, total, name) => {
              set({ importProgress: { done, total, name } })
            },
          })
        }
      } catch (e) {
        if (!(e instanceof DOMException && e.name === 'AbortError')) {
          console.warn('Copia visible', e)
        }
      } finally {
        set({ importProgress: null })
      }
    }

    void get()
      .syncCloudCatalog()
      .catch(() => {})
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

  exportLibraryFolder: async () => {
    const { exportLibraryToFolder } = await import('../lib/transfer')
    const userId = useAuthStore.getState().user?.id
    const total = get().tracks.length
    set({ importProgress: { done: 0, total: Math.max(total, 1), name: 'Preparando…' } })
    try {
      return await exportLibraryToFolder(userId, (done, t, name) => {
        set({ importProgress: { done, total: t, name } })
      })
    } finally {
      set({ importProgress: null })
    }
  },

  exportLibraryPacks: async () => {
    const { downloadLibraryPacks } = await import('../lib/transfer')
    const userId = useAuthStore.getState().user?.id
    const total = get().tracks.length
    set({ importProgress: { done: 0, total: Math.max(total, 1), name: 'Preparando…' } })
    try {
      return await downloadLibraryPacks(userId, (done, t, name) => {
        set({ importProgress: { done, total: t, name } })
      })
    } finally {
      set({ importProgress: null })
    }
  },

  exportToDownloads: async () => {
    const { getAudioBlob } = await import('../lib/library')
    const { myVibeDownloadName, saveFilesVisibly } = await import('../lib/visibleStorage')
    const tracks = get().tracks.filter((t) => t.hasLocalAudio !== false)
    if (!tracks.length) throw new Error('No hay canciones locales')
    set({ importProgress: { done: 0, total: tracks.length, name: 'Preparando…' } })
    try {
      const files = []
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i]!
        set({ importProgress: { done: i, total: tracks.length, name: t.title } })
        const blob = await getAudioBlob(t.id)
        if (!blob) continue
        files.push({
          fileName: myVibeDownloadName(t.artist, t.title, t.fileName),
          blob,
        })
      }
      const result = await saveFilesVisibly(files, {
        interactive: true,
        onProgress: (done, total, name) => {
          set({ importProgress: { done, total, name } })
        },
      })
      return { saved: result.saved, message: result.message }
    } finally {
      set({ importProgress: null })
    }
  },

  syncCloudCatalog: async () => {
    if (!isCloudAuthEnabled()) {
      set({ lastSyncMessage: 'Supabase no configurado' })
      return { pushed: 0, pulled: 0 }
    }
    const userId = useAuthStore.getState().user?.id
    if (!userId) {
      set({ lastSyncMessage: 'Sin sesión' })
      return { pushed: 0, pulled: 0 }
    }

    let pushed = 0
    let pulled = 0
    let deduped = 0
    let pruned = 0
    try {
      // Quita duplicados locales antes de subir, limpia la nube, baja catálogo y vuelve a fusionar
      deduped += await library.dedupeLibraryTracks()
      pushed = await pushLibraryMetadata(userId)
      pruned = await pruneCloudDuplicateTracks(userId)
      pulled = await pullLibraryCatalog(userId)
      deduped += await library.dedupeLibraryTracks()
      let taste = { likesIn: 0, likesOut: 0, playlistsIn: 0, playlistsOut: 0 }
      let tasteError: string | null = null
      try {
        taste = await syncLibraryTaste(userId)
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Error sync perfil'
        console.warn('Sync me gusta/playlists', e)
        tasteError =
          /relation|does not exist|schema cache|library_likes|library_playlists/i.test(msg)
            ? ' · Falta ejecutar library.sql / taste-sync.sql en Supabase'
            : ` · Perfil: ${msg}`
      }
      const cloudCount = await getCloudCatalogCount(userId)
      const peer = await getDevicePeer(userId)
      const age = peer ? Date.now() - Date.parse(peer.updatedAt) : Infinity
      const localCount = get().tracks.filter((t) => t.hasLocalAudio !== false).length
      const likedCount = get().tracks.filter((t) => t.liked).length
      const playlistCount = get().playlists.length
      set({
        pcOnline: Boolean(peer && age < 3 * 60 * 1000),
        lastSyncAt: Date.now(),
        lastSyncMessage:
          `Local: ${localCount} · Nube: ${cloudCount}` +
          ` · Me gusta: ${likedCount} · Listas: ${playlistCount}` +
          (pushed ? ` · Subidas ahora: ${pushed}` : '') +
          (pulled ? ` · Nuevas aquí: ${pulled}` : '') +
          (taste.likesIn || taste.playlistsIn
            ? ` · Perfil ↓ likes ${taste.likesIn} / listas ${taste.playlistsIn}`
            : '') +
          (taste.likesOut || taste.playlistsOut
            ? ` · Perfil ↑ likes ${taste.likesOut} / listas ${taste.playlistsOut}`
            : '') +
          (tasteError || '') +
          (deduped ? ` · Duplicados quitados: ${deduped}` : '') +
          (pruned ? ` · Nube limpia: −${pruned}` : '') +
          (localCount === 0 && cloudCount === 0
            ? ' · Biblioteca vacía (PC y nube)'
            : localCount === 0 && cloudCount > 0
              ? ' · En el PC pulsa Actualizar para vaciar la nube, o importa música'
              : ''),
      })
      return { pushed, pulled }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Error de sincronización'
      set({ lastSyncMessage: msg, pcOnline: false })
      throw e
    }
  },

  downloadFromPc: async (ids) => {
    const userId = useAuthStore.getState().user?.id
    if (!userId) throw new Error('Inicia sesión')
    const uniqueIds = [...new Set(ids)]
    set({
      downloadProgress: {
        done: 0,
        total: uniqueIds.length,
        name: 'Conectando…',
        trackId: null,
        percent: 0,
        ids: uniqueIds,
      },
    })
    try {
      return await downloadTracksFromPc(userId, uniqueIds, {
        onStatus: (msg) => {
          const prev = get().downloadProgress
          if (!prev) return
          set({ downloadProgress: { ...prev, name: msg } })
        },
        onProgress: (done, total, name, detail) => {
          const prev = get().downloadProgress
          set({
            downloadProgress: {
              done,
              total,
              name,
              trackId: detail?.trackId ?? prev?.trackId ?? null,
              percent: detail?.percent ?? prev?.percent ?? 0,
              ids: prev?.ids ?? uniqueIds,
            },
          })
        },
        onError: () => {},
      })
    } finally {
      set({ downloadProgress: null })
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

  deleteTracks: async (ids) => {
    await library.deleteTracks(ids)
    const userId = useAuthStore.getState().user?.id
    if (!userId || !isCloudAuthEnabled()) return
    if (isLibraryHostDevice()) {
      try {
        await removeCloudTracks(userId, ids)
      } catch (e) {
        console.warn('Borrar en nube', e)
      }
    }
    void get()
      .syncCloudCatalog()
      .catch(() => {})
  },

  deleteTrack: async (id) => {
    await library.deleteTrack(id)
    const userId = useAuthStore.getState().user?.id
    if (!userId || !isCloudAuthEnabled()) return
    if (isLibraryHostDevice()) {
      try {
        await removeCloudTracks(userId, [id])
      } catch (e) {
        console.warn('Borrar en nube', e)
      }
    }
    void get()
      .syncCloudCatalog()
      .catch(() => {})
  },

  clearLocalMusic: async () => {
    const { usePlayerStore } = await import('./playerStore')
    usePlayerStore.getState().clearQueue()
    const result = await library.clearLocalMusicLibrary()
    // En el PC, sincronizar catálogo vacío vaciaría la nube: solo avisamos vía UI.
    // En el móvil, el próximo sync trae stubs grises otra vez.
    if (!isLibraryHostDevice() && isCloudAuthEnabled()) {
      void get()
        .syncCloudCatalog()
        .catch(() => {})
    }
    return { tracks: result.tracks }
  },

  purgeOrphanStorage: () => library.purgeOrphanLocalStorage(),
  countOrphanStorage: () => library.countOrphanLocalStorage(),
  previewClearLocalMusic: async () => {
    const p = await library.previewClearLocalMusic()
    return { summary: p.summary, tracks: p.tracks }
  },
  previewOrphanPurge: async () => {
    const p = await library.previewOrphanPurge()
    return { summary: p.summary, audio: p.audio, covers: p.covers }
  },

  updateTrack: (id, patch) => library.updateTrackMeta(id, patch),
  setCover: (id, file) => library.setTrackCover(id, file),
  replaceTrackAudio: async (id, file) => {
    await library.replaceTrackAudio(id, file)
  },
  replaceMissingAudio: async (files, trackIds) => {
    set({ importProgress: { done: 0, total: files.length, name: 'Restaurando audio…' } })
    try {
      return await library.replaceMissingAudioFromFiles(files, trackIds, (done, total, name) => {
        set({ importProgress: { done, total, name: name || 'Restaurando audio…' } })
      })
    } finally {
      set({ importProgress: null })
    }
  },
  toggleLike: async (id) => {
    await library.toggleLike(id)
    void pushLikeNow(id)
  },
  setLiked: async (ids, liked) => {
    await library.setTracksLiked(ids, liked)
    scheduleTasteSync()
  },
  createPlaylist: async (name) => {
    const p = await library.createPlaylist(name)
    void pushPlaylistNow(p.id)
    return p
  },
  renamePlaylist: async (id, name) => {
    await library.renamePlaylist(id, name)
    void pushPlaylistNow(id)
  },
  updatePlaylistInfo: async (id, patch) => {
    await library.updatePlaylistInfo(id, patch)
    void pushPlaylistNow(id)
  },
  setPlaylistCover: async (id, file) => {
    await library.setPlaylistCover(id, file)
    void pushPlaylistNow(id)
  },
  deletePlaylist: async (id) => {
    await library.deletePlaylist(id)
    const userId = useAuthStore.getState().user?.id
    if (userId && isCloudAuthEnabled()) {
      void removeCloudPlaylist(userId, id).catch((e) => console.warn('Delete cloud playlist', e))
    }
  },
  addToPlaylist: async (playlistId, trackIds) => {
    await library.addTracksToPlaylist(playlistId, trackIds)
    void pushPlaylistNow(playlistId)
  },
  removeFromPlaylist: async (playlistId, trackId) => {
    await library.removeTrackFromPlaylist(playlistId, trackId)
    void pushPlaylistNow(playlistId)
  },
  reorderPlaylistTracks: async (playlistId, trackIds) => {
    await library.reorderPlaylistTracks(playlistId, trackIds)
    void pushPlaylistNow(playlistId)
  },

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
