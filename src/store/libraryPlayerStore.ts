/**
 * Reproductor de biblioteca NUEVO (desde cero).
 * Audio propio + Media Session mínima.
 *
 * iOS PWA: un `audio.pause()` real en bloqueo hace que el Play posterior
 * “avance el reloj” sin sonido. En Apple usamos soft-pause (mute + congelar
 * posición) y reclamamos `navigator.audioSession.type = 'playback'`.
 */
import { create } from 'zustand'
import { db, ensurePlaybackSnapshot, PLAYBACK_KEY } from '../db'
import { isAppleMobile } from '../lib/folderImport'
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
let handlersBound = false
/** Soft-pause iOS: el elemento sigue “playing” muteado; la UI cree que está en pause. */
let softPaused = false
let softFreezeAt = 0
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

function claimPlaybackSession() {
  try {
    const nav = navigator as Navigator & { audioSession?: { type: string } }
    if (nav.audioSession) nav.audioSession.type = 'playback'
  } catch {
    /* API no disponible */
  }
}

/** Despierta la ruta de audio en el mismo gesto (Media Session). */
function unlockAudioRouteInGesture() {
  claimPlaybackSession()
  try {
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (!AC) return
    const ctx = new AC()
    void ctx.resume().catch(() => {})
    const buf = ctx.createBuffer(1, 1, ctx.sampleRate || 22050)
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(ctx.destination)
    src.start(0)
    window.setTimeout(() => {
      try {
        void ctx.close()
      } catch {
        /* ignore */
      }
    }, 300)
  } catch {
    /* ignore */
  }
}

function forceAudible() {
  audio.muted = false
  audio.volume = 1
  try {
    audio.playbackRate = 1
  } catch {
    /* ignore */
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

function clearSoftPause() {
  softPaused = false
  softFreezeAt = 0
  forceAudible()
}

/** Pause que no rompe el resume de bloqueo en iOS PWA. */
function enterSoftPause() {
  softFreezeAt = Number.isFinite(audio.currentTime) ? audio.currentTime : softFreezeAt
  softPaused = true
  audio.muted = true
  // Mantener el elemento en play (si se pausa de verdad, iOS no reanuda con sonido)
  if (audio.paused) {
    claimPlaybackSession()
    void audio.play().catch(() => {})
  }
  useLibraryPlayerStore.setState({
    isPlaying: false,
    position: softFreezeAt,
  })
  setPlaybackStateOnly(false)
  persistSoon({ position: softFreezeAt })
}

function exitSoftPauseInGesture() {
  const freeze = softFreezeAt
  clearSoftPause()
  unlockAudioRouteInGesture()
  forceAudible()
  if (freeze > 0.25) {
    try {
      audio.currentTime = freeze
    } catch {
      /* ignore */
    }
  }
  if (audio.paused) {
    void audio.play().catch(() => {})
  }
  useLibraryPlayerStore.setState({
    isPlaying: !audio.paused,
    position: Number.isFinite(audio.currentTime) ? audio.currentTime : freeze,
  })
  setPlaybackStateOnly(!audio.paused)
}

function playFromRemoteGesture() {
  ensureAudioMounted()
  if (softPaused) {
    exitSoftPauseInGesture()
    return
  }
  unlockAudioRouteInGesture()
  forceAudible()
  const resumeAt = useLibraryPlayerStore.getState().position
  if (resumeAt > 0.25) {
    try {
      audio.currentTime = resumeAt
    } catch {
      /* ignore */
    }
  }
  // play() síncrono en el turno del gesto — sin await antes
  try {
    const p = audio.play()
    void Promise.resolve(p)
      .then(() => {
        forceAudible()
        claimPlaybackSession()
        const playing = !audio.paused
        useLibraryPlayerStore.getState().syncFromAudio(playing)
        setPlaybackStateOnly(playing)
      })
      .catch(() => {
        useLibraryPlayerStore.getState().syncFromAudio(false)
        setPlaybackStateOnly(false)
      })
  } catch {
    useLibraryPlayerStore.getState().syncFromAudio(false)
    setPlaybackStateOnly(false)
  }
}

function pauseFromRemoteOrUi() {
  if (isAppleMobile()) {
    enterSoftPause()
    return
  }
  audio.pause()
  useLibraryPlayerStore.setState({
    isPlaying: false,
    position: audio.currentTime || 0,
  })
  setPlaybackStateOnly(false)
  persistSoon({ position: audio.currentTime || 0 })
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

function bindMediaHandlersOnce() {
  if (handlersBound || !('mediaSession' in navigator)) return
  handlersBound = true
  const store = () => useLibraryPlayerStore.getState()
  try {
    navigator.mediaSession.setActionHandler('play', () => {
      playFromRemoteGesture()
    })
    navigator.mediaSession.setActionHandler('pause', () => {
      pauseFromRemoteOrUi()
    })
    navigator.mediaSession.setActionHandler('previoustrack', () => {
      void store().previous()
    })
    navigator.mediaSession.setActionHandler('nexttrack', () => {
      void store().next()
    })
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (typeof details.seekTime === 'number') store().seek(details.seekTime)
    })
  } catch {
    /* handlers no soportados */
  }
}

/** Media Session: metadata + playbackState. Handlers se bindean una sola vez. */
async function publishNowPlaying(track: Track, playing: boolean) {
  if (!('mediaSession' in navigator)) return
  bindMediaHandlersOnce()

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

  setPlaybackStateOnly(playing)
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
    audioEngine.yieldPlaybackRoute()
  } catch {
    /* ignore */
  }
}

async function loadTrack(trackId: string, autoplay: boolean): Promise<boolean> {
  ensureAudioMounted()
  clearSoftPause()
  claimPlaybackSession()
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

  forceAudible()
  claimPlaybackSession()
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
    if (softPaused) {
      // Congelar reloj real mientras soft-pause (iOS)
      if (Number.isFinite(softFreezeAt) && Math.abs(audio.currentTime - softFreezeAt) > 0.3) {
        try {
          audio.currentTime = softFreezeAt
        } catch {
          /* ignore */
        }
      }
      return
    }
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
    if (softPaused) return
    useLibraryPlayerStore.setState({ isPlaying: true })
    setPlaybackStateOnly(true)
  })
  audio.addEventListener('pause', () => {
    if (!useLibraryPlayerStore.getState().currentTrackId) return
    if (audio.ended) return
    if (softPaused) {
      // iOS a veces pausa solo: reanudar muteado para no perder la sesión
      claimPlaybackSession()
      void audio.play().catch(() => {})
      return
    }
    useLibraryPlayerStore.setState({ isPlaying: false })
    setPlaybackStateOnly(false)
  })
  audio.addEventListener('ended', () => {
    if (softPaused) return
    void useLibraryPlayerStore.getState().onEnded()
  })
}

wireAudioEvents()
bindMediaHandlersOnce()

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
      position: softPaused ? softFreezeAt : audio.currentTime || 0,
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
    clearSoftPause()

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
    if (softPaused || get().isPlaying || !audio.paused) {
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
    claimPlaybackSession()

    if (softPaused) {
      const freeze = softFreezeAt
      clearSoftPause()
      if (freeze > 0.25) {
        try {
          audio.currentTime = freeze
        } catch {
          /* ignore */
        }
      }
    }

    if (!audio.src) {
      await loadTrack(currentTrackId, true)
      return
    }

    forceAudible()
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
    pauseFromRemoteOrUi()
  },

  onEnded: async () => {
    if (softPaused) return
    const { repeat, currentTrackId, queue, index } = get()
    if (!currentTrackId || !queue.length) return

    if (repeat === 'one') {
      try {
        audio.currentTime = 0
        claimPlaybackSession()
        forceAudible()
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
    clearSoftPause()

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
    const pos = softPaused ? softFreezeAt : position
    if (pos > 3) {
      get().seek(0)
      return
    }
    clearSoftPause()
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
    if (softPaused) {
      softFreezeAt = t
      try {
        audio.currentTime = t
      } catch {
        /* ignore */
      }
      set({ position: t })
      persistSoon({ position: t })
      return
    }
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
      if (newId) void loadTrack(newId, isPlaying || softPaused)
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
    clearSoftPause()
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
