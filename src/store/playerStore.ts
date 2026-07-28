import { create } from 'zustand'
import { db, ensurePlaybackSnapshot, PLAYBACK_KEY } from '../db'
import { audioEngine } from '../lib/audioEngine'
import { getAudioObjectUrl, getCoverObjectUrl, recordPlay, getAudioBlobSources, getAudioBlob, revokeCachedUrls, ensureAudioMime } from '../lib/library'
import { deleteBinary } from '../lib/opfs'
import { setMediaPlaybackState, setMediaPositionState, shuffleArray, updateMediaSession } from '../lib/mediaSession'
import type { RepeatMode, Track } from '../types'
import { persistRecent } from './libraryStore'

interface PlayerState {
  queue: string[]
  originalQueue: string[]
  index: number
  currentTrackId: string | null
  isPlaying: boolean
  shuffle: boolean
  repeat: RepeatMode
  position: number
  duration: number
  volume: number
  muted: boolean
  nowPlayingOpen: boolean
  queueOpen: boolean
  carMode: boolean
  coverUrl: string | null
  hydrated: boolean

  hydrate: () => Promise<void>
  playTrack: (trackId: string, queue?: string[]) => Promise<void>
  playTracks: (
    trackIds: string[],
    startId?: string,
    options?: { shuffle?: boolean },
  ) => Promise<void>
  toggle: () => Promise<void>
  pause: () => void
  play: () => Promise<void>
  next: () => Promise<void>
  previous: () => Promise<void>
  seek: (time: number) => void
  setVolume: (v: number) => void
  toggleMute: () => void
  toggleShuffle: () => void
  cycleRepeat: () => void
  addToQueue: (trackId: string) => void
  playNext: (trackId: string) => void
  removeFromQueue: (queueIndex: number) => void
  clearQueue: () => void
  setNowPlayingOpen: (open: boolean) => void
  setQueueOpen: (open: boolean) => void
  setCarMode: (open: boolean) => void
  syncFromEngine: () => void
  getCurrentTrack: (tracks: Track[]) => Track | null
}

let persistTimer: ReturnType<typeof setTimeout> | null = null
let endedUnsub: (() => void) | null = null
let engineUnsub: (() => void) | null = null

function persistSoon(partial: Partial<{
  currentTrackId: string | null
  queue: string[]
  index: number
  shuffle: boolean
  repeat: RepeatMode
  position: number
  volume: number
}>) {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    void db.playback.update(PLAYBACK_KEY, partial)
  }, 400)
}

async function loadAndMaybePlay(
  trackId: string,
  resumeAt: number,
  shouldPlay: boolean,
  set: (partial: Partial<PlayerState>) => void,
) {
  let url = await getAudioObjectUrl(trackId)
  if (!url) {
    // Solo marcar remota si realmente no hay blob
    try {
      await db.tracks.update(trackId, { hasLocalAudio: false })
    } catch {
      // ignore
    }
    return false
  }

  const coverUrl = await getCoverObjectUrl(trackId)
  set({ coverUrl, currentTrackId: trackId })
  try {
    await audioEngine.load(url, resumeAt)
  } catch {
    // Fallo al cargar: probar copia alternativa antes de rendirse
    const retried = await retryAlternateAudioSource(trackId, resumeAt)
    if (!retried) return false
  }

  if (shouldPlay) {
    audioEngine.applyPlaybackSession()
    await audioEngine.play()
    if (audioEngine.element.error || audioEngine.paused) {
      // Reintentar con la otra copia (IDB ↔ OPFS) si el decode falló
      if (audioEngine.element.error) {
        const ok = await retryAlternateAudioSource(trackId, resumeAt)
        if (ok) await audioEngine.play()
      }

      if (audioEngine.element.error) {
        const sources = await getAudioBlobSources(trackId)
        const stillThere = Boolean(
          (sources.idb && sources.idb.size >= 1024) || (sources.opfs && sources.opfs.size >= 1024),
        )
        if (!stillThere) {
          try {
            await db.tracks.update(trackId, { hasLocalAudio: false })
          } catch {
            // ignore
          }
        }
        set({ isPlaying: false })
        setMediaPlaybackState(false)
        return false
      }
    }
    set({ isPlaying: !audioEngine.paused })
    setMediaPlaybackState(!audioEngine.paused)
    if (!audioEngine.paused) {
      await recordPlay(trackId)
      await persistRecent(trackId)
    }
  } else {
    set({ isPlaying: false })
    setMediaPlaybackState(false)
  }
  return true
}

/** Carga la copia alternativa (IDB ↔ OPFS) con MIME forzado. */
async function retryAlternateAudioSource(trackId: string, resumeAt: number): Promise<boolean> {
  const sources = await getAudioBlobSources(trackId)
  const preferred = await getAudioBlob(trackId)
  const preferredSize = preferred?.size ?? 0
  const alternate =
    sources.idb && sources.idb.size !== preferredSize
      ? sources.idb
      : sources.opfs && sources.opfs.size !== preferredSize
        ? sources.opfs
        : sources.idb && sources.opfs
          ? sources.idb.size >= sources.opfs.size
            ? sources.opfs
            : sources.idb
          : null

  if (!alternate || alternate.size < 1024) return false

  // Si OPFS estaba truncado, borrarlo para no volver a preferirlo en no-Apple
  if (sources.opfs && sources.idb && sources.opfs.size < sources.idb.size) {
    await deleteBinary('audio', trackId).catch(() => undefined)
  }

  let mimeHint = alternate.type
  if (!mimeHint) {
    try {
      const track = await db.tracks.get(trackId)
      mimeHint = track?.mimeType || 'audio/mpeg'
    } catch {
      mimeHint = 'audio/mpeg'
    }
  }

  revokeCachedUrls(trackId)
  const playable = ensureAudioMime(alternate, mimeHint)
  // Guardar la copia buena en IDB para próximas veces
  try {
    await db.audio.put({ id: trackId, blob: playable })
  } catch {
    // ignore
  }
  const stable = await getAudioObjectUrl(trackId)
  if (!stable) return false
  try {
    await audioEngine.load(stable, resumeAt)
    return true
  } catch {
    return false
  }
}

export const usePlayerStore = create<PlayerState>((set, get) => ({
  queue: [],
  originalQueue: [],
  index: 0,
  currentTrackId: null,
  isPlaying: false,
  shuffle: false,
  repeat: 'off',
  position: 0,
  duration: 0,
  volume: 1,
  muted: false,
  nowPlayingOpen: false,
  queueOpen: false,
  carMode: false,
  coverUrl: null,
  hydrated: false,

  hydrate: async () => {
    const snap = await ensurePlaybackSnapshot()
    audioEngine.setVolume(snap.volume)
    set({
      queue: snap.queue,
      originalQueue: snap.queue,
      index: snap.index,
      currentTrackId: snap.currentTrackId,
      shuffle: snap.shuffle,
      repeat: snap.repeat,
      position: snap.position,
      volume: snap.volume,
      hydrated: true,
    })

    if (!engineUnsub) {
      engineUnsub = audioEngine.subscribe(() => get().syncFromEngine())
    }
    if (!endedUnsub) {
      endedUnsub = audioEngine.onEnded(() => {
        void get().next()
      })
    }

    if (snap.currentTrackId && snap.queue.length) {
      await loadAndMaybePlay(snap.currentTrackId, snap.position, false, set)
    }
  },

  syncFromEngine: () => {
    const playing = !audioEngine.paused
    const position = audioEngine.currentTime
    const duration = audioEngine.duration
    set({
      position,
      duration,
      isPlaying: playing,
      volume: audioEngine.volume,
      muted: audioEngine.muted,
    })
    setMediaPositionState(position, duration, playing)
    persistSoon({ position })
  },

  getCurrentTrack: (tracks) => {
    const id = get().currentTrackId
    if (!id) return null
    return tracks.find((t) => t.id === id) ?? null
  },

  playTrack: async (trackId, queue) => {
    const q = queue ?? get().queue
    const nextQueue = q.includes(trackId) ? q : [...q, trackId]
    const index = Math.max(0, nextQueue.indexOf(trackId))
    set({
      queue: nextQueue,
      originalQueue: nextQueue,
      index,
      shuffle: false,
    })
    persistSoon({
      queue: nextQueue,
      index,
      currentTrackId: trackId,
      shuffle: false,
      position: 0,
    })
    const ok = await loadAndMaybePlay(trackId, 0, true, set)
    if (!ok) {
      // Saltar a la siguiente con audio real
      for (let i = index + 1; i < nextQueue.length; i++) {
        const nextId = nextQueue[i]!
        set({ index: i, currentTrackId: nextId })
        if (await loadAndMaybePlay(nextId, 0, true, set)) return
      }
    }
  },

  playTracks: async (trackIds, startId, options) => {
    if (!trackIds.length) return
    const forceShuffle = options?.shuffle
    const shuffleOn = forceShuffle === true ? true : forceShuffle === false ? false : get().shuffle
    let queue = [...trackIds]
    let index = startId ? Math.max(0, queue.indexOf(startId)) : 0
    if (index < 0) index = 0
    const originalQueue = [...queue]
    if (shuffleOn) {
      queue = shuffleArray(queue, index >= 0 ? index : undefined)
      index = 0
    }
    set({
      queue,
      originalQueue,
      index,
      currentTrackId: queue[index] ?? null,
      shuffle: shuffleOn,
    })
    persistSoon({
      queue,
      index,
      currentTrackId: queue[index] ?? null,
      shuffle: shuffleOn,
      position: 0,
    })
    for (let i = index; i < queue.length; i++) {
      const trackId = queue[i]!
      set({ index: i, currentTrackId: trackId })
      if (await loadAndMaybePlay(trackId, 0, true, set)) return
    }
    for (let i = 0; i < index; i++) {
      const trackId = queue[i]!
      set({ index: i, currentTrackId: trackId })
      if (await loadAndMaybePlay(trackId, 0, true, set)) return
    }
  },

  toggle: async () => {
    if (audioEngine.paused) await get().play()
    else get().pause()
  },

  pause: () => {
    audioEngine.pause()
    set({ isPlaying: false })
    setMediaPlaybackState(false)
  },

  play: async () => {
    const { currentTrackId, queue, index } = get()
    if (!currentTrackId && queue.length) {
      await loadAndMaybePlay(queue[index] ?? queue[0], 0, true, set)
      return
    }
    if (!currentTrackId) return
    audioEngine.applyPlaybackSession()
    await audioEngine.play()
    set({ isPlaying: !audioEngine.paused })
    setMediaPlaybackState(!audioEngine.paused)
  },

  next: async () => {
    const { queue, index, repeat, currentTrackId } = get()
    if (!queue.length) return

    if (repeat === 'one' && currentTrackId) {
      audioEngine.seek(0)
      await audioEngine.play()
      return
    }

    let nextIndex = index + 1
    if (nextIndex >= queue.length) {
      if (repeat === 'all') nextIndex = 0
      else {
        get().pause()
        audioEngine.seek(0)
        return
      }
    }
    const trackId = queue[nextIndex]
    set({ index: nextIndex, currentTrackId: trackId })
    persistSoon({ index: nextIndex, currentTrackId: trackId, position: 0 })
    const ok = await loadAndMaybePlay(trackId, 0, true, set)
    if (!ok) {
      // Evitar quedarse en silencio en una pista rota
      for (let i = nextIndex + 1; i < queue.length; i++) {
        const id = queue[i]!
        set({ index: i, currentTrackId: id })
        if (await loadAndMaybePlay(id, 0, true, set)) return
      }
      if (repeat === 'all') {
        for (let i = 0; i < nextIndex; i++) {
          const id = queue[i]!
          set({ index: i, currentTrackId: id })
          if (await loadAndMaybePlay(id, 0, true, set)) return
        }
      }
    }
  },

  previous: async () => {
    const { queue, index, position } = get()
    if (!queue.length) return
    if (position > 3) {
      audioEngine.seek(0)
      return
    }
    const prevIndex = index <= 0 ? (get().repeat === 'all' ? queue.length - 1 : 0) : index - 1
    const trackId = queue[prevIndex]
    set({ index: prevIndex, currentTrackId: trackId })
    persistSoon({ index: prevIndex, currentTrackId: trackId, position: 0 })
    await loadAndMaybePlay(trackId, 0, true, set)
  },

  seek: (time) => {
    audioEngine.seek(time)
    persistSoon({ position: time })
  },

  setVolume: (v) => {
    audioEngine.setVolume(v)
    if (v > 0) audioEngine.setMuted(false)
    set({ volume: v, muted: v === 0 ? get().muted : false })
    persistSoon({ volume: v })
  },

  toggleMute: () => {
    const next = !get().muted
    audioEngine.setMuted(next)
    set({ muted: next })
  },

  toggleShuffle: () => {
    const { shuffle, queue, originalQueue, currentTrackId } = get()
    if (!shuffle) {
      const base = originalQueue.length ? originalQueue : queue
      const currentIndex = Math.max(0, base.indexOf(currentTrackId ?? ''))
      const shuffled = shuffleArray(base, currentIndex >= 0 ? currentIndex : undefined)
      set({
        shuffle: true,
        originalQueue: base,
        queue: shuffled,
        index: 0,
      })
      persistSoon({ shuffle: true, queue: shuffled, index: 0 })
    } else {
      const base = originalQueue.length ? originalQueue : queue
      const idx = Math.max(0, base.indexOf(currentTrackId ?? ''))
      set({
        shuffle: false,
        queue: base,
        index: idx,
      })
      persistSoon({ shuffle: false, queue: base, index: idx })
    }
  },

  cycleRepeat: () => {
    const order: RepeatMode[] = ['off', 'all', 'one']
    const next = order[(order.indexOf(get().repeat) + 1) % order.length]
    set({ repeat: next })
    persistSoon({ repeat: next })
  },

  addToQueue: (trackId) => {
    const queue = [...get().queue, trackId]
    set({ queue, originalQueue: get().shuffle ? get().originalQueue : queue })
    persistSoon({ queue })
  },

  playNext: (trackId) => {
    const { queue, index } = get()
    const next = [...queue]
    next.splice(index + 1, 0, trackId)
    set({ queue: next, originalQueue: get().shuffle ? get().originalQueue : next })
    persistSoon({ queue: next })
  },

  removeFromQueue: (queueIndex) => {
    const { queue, index, currentTrackId } = get()
    const next = queue.filter((_, i) => i !== queueIndex)
    let nextIndex = index
    if (queueIndex < index) nextIndex = Math.max(0, index - 1)
    if (queueIndex === index) {
      const newId = next[nextIndex] ?? next[0] ?? null
      set({ queue: next, index: nextIndex, currentTrackId: newId })
      persistSoon({ queue: next, index: nextIndex, currentTrackId: newId })
      if (newId) void loadAndMaybePlay(newId, 0, get().isPlaying, set)
      return
    }
    set({ queue: next, index: nextIndex, currentTrackId })
    persistSoon({ queue: next, index: nextIndex })
  },

  clearQueue: () => {
    get().pause()
    set({ queue: [], originalQueue: [], index: 0, currentTrackId: null, coverUrl: null })
    persistSoon({ queue: [], index: 0, currentTrackId: null, position: 0 })
  },

  setNowPlayingOpen: (open) => set({ nowPlayingOpen: open, ...(open ? {} : {}) }),
  setQueueOpen: (open) => set({ queueOpen: open }),
  setCarMode: (open) => set({ carMode: open }),
}))

export async function bindMediaSession(tracks: Track[]) {
  const state = usePlayerStore.getState()
  const track = tracks.find((t) => t.id === state.currentTrackId) ?? null
  await updateMediaSession(track, state.coverUrl, {
    play: () => void usePlayerStore.getState().play(),
    pause: () => usePlayerStore.getState().pause(),
    previoustrack: () => void usePlayerStore.getState().previous(),
    nexttrack: () => void usePlayerStore.getState().next(),
    seekto: (time) => usePlayerStore.getState().seek(time),
    getPosition: () => usePlayerStore.getState().position,
  })
}
