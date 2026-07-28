import { create } from 'zustand'
import { db, ensurePlaybackSnapshot, PLAYBACK_KEY } from '../db'
import { audioEngine } from '../lib/audioEngine'
import { getAudioObjectUrl, getCoverObjectUrl, recordPlay } from '../lib/library'
import { setMediaPlaybackState, shuffleArray, updateMediaSession } from '../lib/mediaSession'
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
  const url = await getAudioObjectUrl(trackId)
  if (!url) return

  const coverUrl = await getCoverObjectUrl(trackId)
  set({ coverUrl, currentTrackId: trackId })
  await audioEngine.load(url, resumeAt)

  if (shouldPlay) {
    await audioEngine.play()
    set({ isPlaying: !audioEngine.paused })
    await recordPlay(trackId)
    await persistRecent(trackId)
  } else {
    set({ isPlaying: false })
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
    set({
      position: audioEngine.currentTime,
      duration: audioEngine.duration,
      isPlaying: playing,
      volume: audioEngine.volume,
      muted: audioEngine.muted,
    })
    setMediaPlaybackState(playing)
    persistSoon({ position: audioEngine.currentTime })
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
    await loadAndMaybePlay(trackId, 0, true, set)
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
    const trackId = queue[index]
    set({
      queue,
      originalQueue,
      index,
      currentTrackId: trackId,
      shuffle: shuffleOn,
    })
    persistSoon({
      queue,
      index,
      currentTrackId: trackId,
      shuffle: shuffleOn,
      position: 0,
    })
    await loadAndMaybePlay(trackId, 0, true, set)
  },

  toggle: async () => {
    if (audioEngine.paused) await get().play()
    else get().pause()
  },

  pause: () => {
    audioEngine.pause()
    set({ isPlaying: false })
  },

  play: async () => {
    const { currentTrackId, queue, index } = get()
    if (!currentTrackId && queue.length) {
      await loadAndMaybePlay(queue[index] ?? queue[0], 0, true, set)
      return
    }
    if (!currentTrackId) return
    await audioEngine.play()
    set({ isPlaying: !audioEngine.paused })
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
    await loadAndMaybePlay(trackId, 0, true, set)
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
