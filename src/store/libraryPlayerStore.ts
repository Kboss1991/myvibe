/**
 * Reproductor de biblioteca NUEVO (desde cero).
 * No usa playerStore, ni loadAndMaybePlay, ni el laberinto CarPlay/Media Session anterior.
 * Audio propio + Media Session mínima (metadata + play/pause/next/prev + playbackState).
 */
import { create } from 'zustand'
import { db, ensurePlaybackSnapshot, PLAYBACK_KEY } from '../db'
import { getAudioObjectUrl, getCoverObjectUrl, recordPlay } from '../lib/library'
import type { PlaybackSource, RepeatMode, Track } from '../types'
import { persistRecent } from './libraryStore'

type LibraryPlayerState = {
  queue: string[]
  originalQueue: string[]
  index: number
  currentTrackId: string | null
  isPlaying: boolean
  shuffle: boolean
  repeat: RepeatMode
  position: number
  duration: number
  coverUrl: string | null
  playbackSource: PlaybackSource | null
  hydrated: boolean
  nowPlayingOpen: boolean
  queueOpen: boolean

  hydrate: () => Promise<void>
  playTracks: (
    trackIds: string[],
    startId?: string,
    options?: { shuffle?: boolean; source?: PlaybackSource | null },
  ) => Promise<void>
  toggle: () => Promise<void>
  play: () => Promise<void>
  pause: () => void
  next: () => Promise<void>
  previous: () => Promise<void>
  seek: (time: number) => void
  toggleShuffle: () => void
  cycleRepeat: () => void
  addToQueue: (trackId: string) => void
  playNext: (trackId: string) => void
  removeFromQueue: (queueIndex: number) => void
  clearQueue: () => void
  stop: () => void
  setNowPlayingOpen: (open: boolean) => void
  setQueueOpen: (open: boolean) => void
}

const audio = new Audio()
audio.preload = 'auto'
audio.setAttribute('playsinline', 'true')
audio.setAttribute('webkit-playsinline', 'true')
audio.setAttribute('x-webkit-airplay', 'allow')
audio.crossOrigin = 'anonymous'
audio.style.cssText =
  'position:fixed;width:1px;height:1px;opacity:0.01;pointer-events:none;left:0;bottom:0;z-index:-1'

let audioMounted = false
let loadEpoch = 0
let persistTimer: number | null = null
let pendingPersist: Partial<{
  queue: string[]
  originalQueue: string[]
  index: number
  currentTrackId: string | null
  shuffle: boolean
  repeat: RepeatMode
  position: number
  playbackSource: PlaybackSource | null
}> = {}

function ensureAudioMounted() {
  if (audioMounted || typeof document === 'undefined') return
  document.body.appendChild(audio)
  audioMounted = true
}

function shuffleArray(items: string[], stayIndex?: number): string[] {
  const arr = [...items]
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j]!, arr[i]!]
  }
  if (stayIndex !== undefined && stayIndex >= 0 && stayIndex < items.length) {
    const stay = items[stayIndex]!
    const at = arr.indexOf(stay)
    if (at > 0) {
      arr.splice(at, 1)
      arr.unshift(stay)
    }
  }
  return arr
}

function persistSoon(partial: typeof pendingPersist) {
  Object.assign(pendingPersist, partial)
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = window.setTimeout(() => {
    void flushPersist()
  }, 400)
}

async function flushPersist() {
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  const patch = pendingPersist
  pendingPersist = {}
  if (!Object.keys(patch).length) return
  try {
    await db.playback.update(PLAYBACK_KEY, patch)
  } catch {
    /* ignore */
  }
}

/** Media Session mínima — sin setPositionState (iOS lo usa para volver a Play). */
async function publishNowPlaying(track: Track, playing: boolean) {
  if (!('mediaSession' in navigator)) return

  let artwork: MediaImage[] = []
  try {
    const url = await getCoverObjectUrl(track.id)
    if (url) {
      artwork = [
        { src: url, sizes: '512x512', type: 'image/jpeg' },
        { src: url, sizes: '256x256', type: 'image/jpeg' },
      ]
    }
  } catch {
    /* sin portada */
  }

  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist || 'MyVibe',
      album: track.album || 'MyVibe',
      artwork,
    })
  } catch {
    /* ignore */
  }

  try {
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused'
  } catch {
    /* ignore */
  }

  const store = () => useLibraryPlayerStore.getState()

  try {
    // play: gesto síncrono → audio.play() en el mismo turno (requisito iOS)
    navigator.mediaSession.setActionHandler('play', () => {
      void audio.play().then(
        () => {
          store().syncFromAudio(true)
          try {
            navigator.mediaSession.playbackState = 'playing'
          } catch {
            /* ignore */
          }
        },
        () => {
          void store().play()
        },
      )
    })
    navigator.mediaSession.setActionHandler('pause', () => {
      audio.pause()
      store().syncFromAudio(false)
      try {
        navigator.mediaSession.playbackState = 'paused'
      } catch {
        /* ignore */
      }
    })
    navigator.mediaSession.setActionHandler('previoustrack', () => {
      void store().previous()
    })
    navigator.mediaSession.setActionHandler('nexttrack', () => {
      void store().next()
    })
    // En iOS, seekto/seek± hace que salgan ±10s en vez de saltar canción
    try {
      navigator.mediaSession.setActionHandler('seekto', null)
      navigator.mediaSession.setActionHandler('seekbackward', null)
      navigator.mediaSession.setActionHandler('seekforward', null)
    } catch {
      /* ignore */
    }
  } catch {
    /* handlers no soportados */
  }
}

function setPlaybackStateOnly(playing: boolean) {
  if (!('mediaSession' in navigator)) return
  try {
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused'
  } catch {
    /* ignore */
  }
}

async function stopRivalPlayers() {
  try {
    const { usePlayerStore } = await import('./playerStore')
    usePlayerStore.getState().yieldToLibraryPlayer()
  } catch {
    /* ignore */
  }
  try {
    const { audioEngine } = await import('../lib/audioEngine')
    audioEngine.markIntentionalPause(1500)
    audioEngine.pause()
  } catch {
    /* ignore */
  }
}

async function loadTrack(trackId: string, autoplay: boolean): Promise<boolean> {
  ensureAudioMounted()
  const epoch = ++loadEpoch
  const url = await getAudioObjectUrl(trackId)
  if (!url || epoch !== loadEpoch) return false

  audio.pause()
  audio.src = url
  try {
    audio.load()
  } catch {
    /* ignore */
  }

  const track = await db.tracks.get(trackId)
  if (!track || epoch !== loadEpoch) return false

  void getCoverObjectUrl(trackId).then((coverUrl) => {
    if (useLibraryPlayerStore.getState().currentTrackId === trackId) {
      useLibraryPlayerStore.setState({ coverUrl })
    }
  })

  if (!autoplay) {
    useLibraryPlayerStore.setState({
      isPlaying: false,
      position: audio.currentTime || 0,
      duration: Number.isFinite(audio.duration) ? audio.duration : track.duration || 0,
    })
    await publishNowPlaying(track, false)
    return true
  }

  try {
    await audio.play()
  } catch {
    useLibraryPlayerStore.setState({ isPlaying: false })
    await publishNowPlaying(track, false)
    return false
  }

  if (epoch !== loadEpoch) return false

  const playing = !audio.paused
  useLibraryPlayerStore.setState({
    isPlaying: playing,
    position: audio.currentTime || 0,
    duration: Number.isFinite(audio.duration) ? audio.duration : track.duration || 0,
  })
  await publishNowPlaying(track, playing)
  void recordPlay(trackId)
  void persistRecent(trackId)
  return playing
}

function wireAudioEvents() {
  audio.addEventListener('timeupdate', () => {
    const s = useLibraryPlayerStore.getState()
    if (!s.currentTrackId) return
    const position = audio.currentTime || 0
    const duration = Number.isFinite(audio.duration) ? audio.duration : s.duration
    useLibraryPlayerStore.setState({ position, duration })
    persistSoon({ position })
  })
  audio.addEventListener('durationchange', () => {
    if (!useLibraryPlayerStore.getState().currentTrackId) return
    if (Number.isFinite(audio.duration)) {
      useLibraryPlayerStore.setState({ duration: audio.duration })
    }
  })
  audio.addEventListener('play', () => {
    if (!useLibraryPlayerStore.getState().currentTrackId) return
    useLibraryPlayerStore.setState({ isPlaying: true })
    setPlaybackStateOnly(true)
  })
  audio.addEventListener('pause', () => {
    if (!useLibraryPlayerStore.getState().currentTrackId) return
    // ended también dispara pause; next() lo gestiona
    if (audio.ended) return
    useLibraryPlayerStore.setState({ isPlaying: false })
    setPlaybackStateOnly(false)
  })
  audio.addEventListener('ended', () => {
    void useLibraryPlayerStore.getState().onEnded()
  })
}

wireAudioEvents()

export const useLibraryPlayerStore = create<
  LibraryPlayerState & {
    syncFromAudio: (playing: boolean) => void
    onEnded: () => Promise<void>
  }
>((set, get) => ({
  queue: [],
  originalQueue: [],
  index: 0,
  currentTrackId: null,
  isPlaying: false,
  shuffle: false,
  repeat: 'off',
  position: 0,
  duration: 0,
  coverUrl: null,
  playbackSource: null,
  hydrated: false,
  nowPlayingOpen: false,
  queueOpen: false,

  syncFromAudio: (playing) => {
    set({
      isPlaying: playing,
      position: audio.currentTime || 0,
      duration: Number.isFinite(audio.duration) ? audio.duration : get().duration,
    })
  },

  hydrate: async () => {
    const snap = await ensurePlaybackSnapshot()
    let queue = Array.isArray(snap.queue) ? [...snap.queue] : []
    let originalQueue =
      Array.isArray(snap.originalQueue) && snap.originalQueue.length
        ? [...snap.originalQueue]
        : [...queue]
    let index = Number.isFinite(snap.index) ? snap.index : 0
    let currentTrackId = snap.currentTrackId

    if (queue.length) {
      if (currentTrackId) {
        if (queue[index] !== currentTrackId) {
          const found = queue.indexOf(currentTrackId)
          index = found >= 0 ? found : Math.max(0, Math.min(index, queue.length - 1))
          if (found < 0) currentTrackId = queue[index] ?? null
        }
      } else {
        index = Math.max(0, Math.min(index, queue.length - 1))
        currentTrackId = queue[index] ?? null
      }
    } else {
      index = 0
      currentTrackId = null
    }

    const repeat: RepeatMode =
      snap.repeat === 'all' || snap.repeat === 'one' ? snap.repeat : 'off'

    set({
      queue,
      originalQueue,
      index,
      currentTrackId,
      shuffle: Boolean(snap.shuffle),
      repeat,
      position: snap.position || 0,
      playbackSource: null,
      hydrated: true,
      isPlaying: false,
    })

    if (currentTrackId && queue.length) {
      await loadTrack(currentTrackId, false)
      if (snap.position > 0.5) {
        try {
          audio.currentTime = snap.position
        } catch {
          /* ignore */
        }
        set({ position: snap.position })
      }
    }
  },

  playTracks: async (trackIds, startId, options) => {
    if (!trackIds.length) return
    await stopRivalPlayers()

    const forceShuffle = options?.shuffle
    const source =
      options && 'source' in options ? (options.source ?? null) : null
    const shuffleOn =
      forceShuffle === true
        ? true
        : forceShuffle === false
          ? false
          : get().shuffle

    let queue = [...trackIds]
    let index = startId ? Math.max(0, queue.indexOf(startId)) : 0
    if (index < 0) index = 0
    const originalQueue = [...queue]

    if (shuffleOn) {
      const stay = startId ? index : undefined
      queue = shuffleArray(queue, stay)
      index = 0
    }

    const trackId = queue[index]!
    set({
      queue,
      originalQueue,
      index,
      currentTrackId: trackId,
      shuffle: shuffleOn,
      playbackSource: source,
      position: 0,
    })
    persistSoon({
      queue,
      originalQueue,
      index,
      currentTrackId: trackId,
      shuffle: shuffleOn,
      position: 0,
      playbackSource: source,
    })

    for (let i = index; i < queue.length; i++) {
      const id = queue[i]!
      set({ index: i, currentTrackId: id })
      if (await loadTrack(id, true)) return
    }
  },

  toggle: async () => {
    if (!get().currentTrackId) return
    if (!audio.paused || get().isPlaying) {
      get().pause()
      return
    }
    await get().play()
  },

  play: async () => {
    const { currentTrackId } = get()
    if (!currentTrackId) return
    await stopRivalPlayers()
    ensureAudioMounted()

    if (!audio.src) {
      await loadTrack(currentTrackId, true)
      return
    }

    try {
      await audio.play()
      set({ isPlaying: true })
      setPlaybackStateOnly(true)
      const track = await db.tracks.get(currentTrackId)
      if (track) await publishNowPlaying(track, true)
    } catch {
      await loadTrack(currentTrackId, true)
    }
  },

  pause: () => {
    audio.pause()
    set({ isPlaying: false, position: audio.currentTime || 0 })
    setPlaybackStateOnly(false)
    persistSoon({ position: audio.currentTime || 0 })
  },

  onEnded: async () => {
    const { repeat, currentTrackId, queue, index } = get()
    if (!currentTrackId || !queue.length) return

    if (repeat === 'one') {
      try {
        audio.currentTime = 0
        await audio.play()
        set({ isPlaying: true, position: 0 })
        setPlaybackStateOnly(true)
      } catch {
        await loadTrack(currentTrackId, true)
      }
      return
    }

    let nextIndex = index + 1
    if (nextIndex >= queue.length) {
      if (repeat === 'all') nextIndex = 0
      else {
        set({ isPlaying: false, position: 0 })
        setPlaybackStateOnly(false)
        try {
          audio.currentTime = 0
        } catch {
          /* ignore */
        }
        return
      }
    }

    const nextId = queue[nextIndex]
    if (!nextId) return
    set({ index: nextIndex, currentTrackId: nextId, position: 0 })
    persistSoon({ index: nextIndex, currentTrackId: nextId, position: 0 })
    await loadTrack(nextId, true)
  },

  next: async () => {
    const { queue, index, repeat, currentTrackId } = get()
    if (!queue.length || !currentTrackId) return

    let nextIndex = index + 1
    if (nextIndex >= queue.length) {
      if (repeat === 'all' || repeat === 'one') nextIndex = 0
      else return
    }
    const nextId = queue[nextIndex]
    if (!nextId) return
    set({ index: nextIndex, currentTrackId: nextId, position: 0 })
    persistSoon({ index: nextIndex, currentTrackId: nextId, position: 0 })
    await loadTrack(nextId, true)
  },

  previous: async () => {
    const { queue, index, position, repeat } = get()
    if (!queue.length) return
    if (position > 3) {
      get().seek(0)
      return
    }
    const prevIndex =
      index <= 0 ? (repeat === 'all' || repeat === 'one' ? queue.length - 1 : 0) : index - 1
    const trackId = queue[prevIndex]
    if (!trackId) return
    set({ index: prevIndex, currentTrackId: trackId, position: 0 })
    persistSoon({ index: prevIndex, currentTrackId: trackId, position: 0 })
    await loadTrack(trackId, true)
  },

  seek: (time) => {
    if (!get().currentTrackId) return
    const t = Math.max(0, time)
    try {
      audio.currentTime = t
    } catch {
      /* ignore */
    }
    set({ position: t })
    persistSoon({ position: t })
  },

  toggleShuffle: () => {
    const { shuffle, queue, originalQueue, currentTrackId } = get()
    if (!shuffle) {
      const base = originalQueue.length ? originalQueue : queue
      const currentIndex = currentTrackId ? base.indexOf(currentTrackId) : -1
      const shuffled = shuffleArray(base, currentIndex >= 0 ? currentIndex : undefined)
      set({
        shuffle: true,
        originalQueue: base,
        queue: shuffled,
        index: currentIndex >= 0 ? 0 : get().index,
      })
      persistSoon({
        shuffle: true,
        queue: shuffled,
        originalQueue: base,
        index: currentIndex >= 0 ? 0 : get().index,
      })
    } else {
      const base = originalQueue.length ? originalQueue : queue
      const idx = Math.max(0, base.indexOf(currentTrackId ?? ''))
      set({ shuffle: false, queue: base, index: idx })
      persistSoon({ shuffle: false, queue: base, originalQueue: base, index: idx })
    }
  },

  cycleRepeat: () => {
    const cur = get().repeat
    const next: RepeatMode = cur === 'off' ? 'all' : cur === 'all' ? 'one' : 'off'
    set({ repeat: next })
    persistSoon({ repeat: next })
  },

  addToQueue: (trackId) => {
    const queue = [...get().queue, trackId]
    const originalQueue = get().shuffle ? get().originalQueue : queue
    set({ queue, originalQueue })
    persistSoon({ queue, originalQueue })
  },

  playNext: (trackId) => {
    const { queue, index } = get()
    const next = [...queue]
    next.splice(index + 1, 0, trackId)
    const originalQueue = get().shuffle ? get().originalQueue : next
    set({ queue: next, originalQueue })
    persistSoon({ queue: next, originalQueue })
  },

  removeFromQueue: (queueIndex) => {
    const { queue, index, currentTrackId, shuffle, originalQueue, isPlaying } = get()
    const next = queue.filter((_, i) => i !== queueIndex)
    const nextOriginal = shuffle ? originalQueue : next
    let nextIndex = index
    if (queueIndex < index) nextIndex = Math.max(0, index - 1)
    if (queueIndex === index) {
      const newId = next[nextIndex] ?? next[0] ?? null
      set({
        queue: next,
        originalQueue: nextOriginal,
        index: nextIndex,
        currentTrackId: newId,
      })
      persistSoon({
        queue: next,
        originalQueue: nextOriginal,
        index: nextIndex,
        currentTrackId: newId,
      })
      if (newId) void loadTrack(newId, isPlaying)
      else get().stop()
      return
    }
    set({
      queue: next,
      originalQueue: nextOriginal,
      index: nextIndex,
      currentTrackId,
    })
    persistSoon({
      queue: next,
      originalQueue: nextOriginal,
      index: nextIndex,
    })
  },

  clearQueue: () => {
    get().stop()
  },

  stop: () => {
    loadEpoch += 1
    audio.pause()
    try {
      audio.removeAttribute('src')
      audio.load()
    } catch {
      /* ignore */
    }
    set({
      currentTrackId: null,
      queue: [],
      originalQueue: [],
      index: 0,
      isPlaying: false,
      position: 0,
      duration: 0,
      coverUrl: null,
      playbackSource: null,
    })
    persistSoon({
      currentTrackId: null,
      queue: [],
      originalQueue: [],
      index: 0,
      position: 0,
      playbackSource: null,
    })
    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.playbackState = 'none'
        navigator.mediaSession.metadata = null
      } catch {
        /* ignore */
      }
    }
  },

  setNowPlayingOpen: (open) => set({ nowPlayingOpen: open }),
  setQueueOpen: (open) => set({ queueOpen: open }),
}))
