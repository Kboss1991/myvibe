/**
 * Reproductor de biblioteca — reglas estrictas iOS PWA / Media Session:
 * 1) Una sola instancia <audio> (audioEngine.element). Nunca `new Audio()` al cambiar pista.
 * 2) nexttrack + previoustrack SIEMPRE registrados; seekbackward/seekforward NUNCA.
 * 3) En pause: solo audio.pause() + playbackState='paused' (no limpiar metadata/handlers).
 * 4) En next/prev: estado global + audio.play() en la misma pila (URL prefetch).
 * 5) setPositionState solo con números finitos ≥ 0.
 */
import { create } from 'zustand'
import { db, ensurePlaybackSnapshot, PLAYBACK_KEY } from '../db'
import { audioEngine } from '../lib/audioEngine'
import {
  getAudioObjectUrl,
  getCoverObjectUrl,
  peekAudioObjectUrl,
  recordPlay,
} from '../lib/library'
import { setLibraryOwnsMediaSession } from '../lib/mediaSession'
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

/** Única instancia de audio de la app (compartida con radio/podcasts). */
function audio(): HTMLAudioElement {
  return audioEngine.element
}

let loadEpoch = 0
let elementWired: HTMLAudioElement | null = null
let persistTimer: number | null = null
let visibilityWired = false
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

function setPlaybackState(playing: boolean) {
  if (!('mediaSession' in navigator)) return
  try {
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused'
  } catch {
    /* ignore */
  }
}

/** setPositionState con valores válidos (requisito iOS). */
function pushPositionState() {
  if (!('mediaSession' in navigator)) return
  if (!useLibraryPlayerStore.getState().currentTrackId) return
  const el = audio()
  const duration = el.duration
  const position = el.currentTime
  const rate = el.playbackRate
  if (!Number.isFinite(duration) || duration < 0) return
  if (!Number.isFinite(position) || position < 0) return
  if (!Number.isFinite(rate) || rate <= 0) return
  try {
    navigator.mediaSession.setPositionState({
      duration,
      playbackRate: rate,
      position: Math.min(position, duration),
    })
  } catch {
    /* Safari a veces rechaza estados inconsistentes */
  }
}

function prefetchId(trackId: string | null) {
  if (!trackId) return
  if (peekAudioObjectUrl(trackId)) return
  void getAudioObjectUrl(trackId)
}

function prefetchNeighbors() {
  const { queue, index, repeat } = useLibraryPlayerStore.getState()
  if (!queue.length) return
  const nextIndex =
    index + 1 < queue.length ? index + 1 : repeat === 'all' ? 0 : -1
  const prevIndex =
    index - 1 >= 0 ? index - 1 : repeat === 'all' ? queue.length - 1 : -1
  if (nextIndex >= 0) prefetchId(queue[nextIndex] ?? null)
  if (prevIndex >= 0) prefetchId(queue[prevIndex] ?? null)
}

function resolveSkipTarget(dir: 1 | -1): { trackId: string; index: number } | null {
  const { queue, index, position, repeat, currentTrackId } = useLibraryPlayerStore.getState()
  if (!queue.length || !currentTrackId) return null

  if (dir < 0 && position > 3) {
    return { trackId: currentTrackId, index }
  }

  let nextIndex = index + dir
  if (nextIndex < 0) {
    nextIndex = repeat === 'all' || repeat === 'one' ? queue.length - 1 : 0
  } else if (nextIndex >= queue.length) {
    if (repeat === 'all' || repeat === 'one') nextIndex = 0
    else return null
  }
  const trackId = queue[nextIndex]
  if (!trackId) return null
  return { trackId, index: nextIndex }
}

/**
 * Cambia de pista en el MISMO <audio>: solo src + play().
 * Nunca new Audio().
 */
function applySrcAndPlay(url: string): void {
  const el = audio()
  el.muted = false
  el.volume = 1
  try {
    el.playbackRate = 1
  } catch {
    /* ignore */
  }
  // Misma instancia: cambiar src (sin crear elemento nuevo)
  el.src = url
  const playPromise = el.play()
  void Promise.resolve(playPromise).catch(() => {
    /* NotAllowedError / AbortError en background */
  })
}

function commitTrackChange(trackId: string, index: number, url: string) {
  loadEpoch += 1
  // Estado global YA (misma pila que play())
  useLibraryPlayerStore.setState({
    currentTrackId: trackId,
    index,
    position: 0,
    isPlaying: true,
  })
  persistSoon({ currentTrackId: trackId, index, position: 0 })
  setLibraryOwnsMediaSession(true)
  ensureLibraryMediaHandlers()
  setPlaybackState(true)
  applySrcAndPlay(url)
  void db.tracks.get(trackId).then((track) => {
    if (track && useLibraryPlayerStore.getState().currentTrackId === trackId) {
      void publishMetadata(track, true)
    }
  })
  void getCoverObjectUrl(trackId).then((coverUrl) => {
    if (coverUrl && useLibraryPlayerStore.getState().currentTrackId === trackId) {
      useLibraryPlayerStore.setState({ coverUrl })
    }
  })
  void recordPlay(trackId)
  void persistRecent(trackId)
  prefetchNeighbors()
}

/**
 * OBLIGATORIO en iOS: nexttrack + previoustrack SIEMPRE definidos,
 * y seekbackward/seekforward NUNCA. Si no, la lock screen muestra ±10s
 * y Play puede caer en Apple Podcasts.
 * Se re-registran en cada publish/pause/play (no "once"): radio/podcast
 * pueden haber pisado los handlers.
 */
function ensureLibraryMediaHandlers() {
  if (!('mediaSession' in navigator)) return

  navigator.mediaSession.setActionHandler('play', () => {
    setLibraryOwnsMediaSession(true)
    ensureLibraryMediaHandlers()
    // 1) playbackState YA  2) play() síncrono — sin tocar metadata
    setPlaybackState(true)
    const el = audio()
    el.muted = false
    el.volume = 1
    const resumeAt = useLibraryPlayerStore.getState().position
    if (resumeAt > 0.25) {
      try {
        if (Math.abs((el.currentTime || 0) - resumeAt) > 0.5) {
          el.currentTime = resumeAt
        }
      } catch {
        /* ignore */
      }
    }
    const playPromise = el.play()
    void Promise.resolve(playPromise).catch(() => {})
    useLibraryPlayerStore.getState().syncFromAudio(true)
  })

  navigator.mediaSession.setActionHandler('pause', () => {
    // Solo pause + playbackState. NO desregistrar handlers ni limpiar metadata.
    setPlaybackState(false)
    audio().pause()
    useLibraryPlayerStore.getState().syncFromAudio(false)
    persistSoon({ position: Math.max(0, audio().currentTime || 0) })
    ensureLibraryMediaHandlers()
  })

  navigator.mediaSession.setActionHandler('previoustrack', () => {
    setLibraryOwnsMediaSession(true)
    setPlaybackState(true)
    const target = resolveSkipTarget(-1)
    if (!target) {
      setPlaybackState(useLibraryPlayerStore.getState().isPlaying)
      return
    }
    // Reinicio de la misma pista: estado + play() en la misma pila
    if (
      target.trackId === useLibraryPlayerStore.getState().currentTrackId &&
      target.index === useLibraryPlayerStore.getState().index
    ) {
      const el = audio()
      try {
        el.currentTime = 0
      } catch {
        /* ignore */
      }
      useLibraryPlayerStore.setState({ position: 0, isPlaying: true })
      const playPromise = el.play()
      void Promise.resolve(playPromise).catch(() => {})
      return
    }
    const url = peekAudioObjectUrl(target.trackId)
    if (url) {
      commitTrackChange(target.trackId, target.index, url)
      return
    }
    // Sin URL en cache: actualizar estado YA; play cuando esté lista
    useLibraryPlayerStore.setState({
      currentTrackId: target.trackId,
      index: target.index,
      position: 0,
      isPlaying: true,
    })
    void getAudioObjectUrl(target.trackId).then((u) => {
      if (!u) return
      if (useLibraryPlayerStore.getState().queue[target.index] !== target.trackId) return
      setPlaybackState(true)
      applySrcAndPlay(u)
      void db.tracks.get(target.trackId).then((track) => {
        if (track && useLibraryPlayerStore.getState().currentTrackId === target.trackId) {
          void publishMetadata(track, true)
        }
      })
      prefetchNeighbors()
    })
  })

  navigator.mediaSession.setActionHandler('nexttrack', () => {
    setLibraryOwnsMediaSession(true)
    setPlaybackState(true)
    const target = resolveSkipTarget(1)
    if (!target) {
      setPlaybackState(false)
      return
    }
    const url = peekAudioObjectUrl(target.trackId)
    if (url) {
      // Estado + src + play() en la misma pila del handler
      commitTrackChange(target.trackId, target.index, url)
      return
    }
    useLibraryPlayerStore.setState({
      currentTrackId: target.trackId,
      index: target.index,
      position: 0,
      isPlaying: true,
    })
    void getAudioObjectUrl(target.trackId).then((u) => {
      if (!u) return
      if (useLibraryPlayerStore.getState().queue[target.index] !== target.trackId) return
      setPlaybackState(true)
      applySrcAndPlay(u)
      void db.tracks.get(target.trackId).then((track) => {
        if (track && useLibraryPlayerStore.getState().currentTrackId === target.trackId) {
          void publishMetadata(track, true)
        }
      })
      prefetchNeighbors()
    })
  })

  // Eliminar seek± (si podcast los registró, iOS muestra ±10s en vez de saltar pista)
  try {
    navigator.mediaSession.setActionHandler('seekto', null)
    navigator.mediaSession.setActionHandler('seekbackward', null)
    navigator.mediaSession.setActionHandler('seekforward', null)
  } catch {
    /* ignore */
  }
}

async function publishMetadata(track: Track, playing: boolean) {
  if (!('mediaSession' in navigator)) return
  setLibraryOwnsMediaSession(true)
  // Handlers ANTES de cualquier await (y de nuevo después): next/prev siempre vivos
  ensureLibraryMediaHandlers()

  let artwork: MediaImage[] = []
  try {
    const cover = await getCoverObjectUrl(track.id)
    if (cover) {
      artwork = [
        { src: cover, sizes: '512x512', type: 'image/jpeg' },
        { src: cover, sizes: '256x256', type: 'image/jpeg' },
      ]
    }
  } catch {
    /* ignore */
  }

  // No borrar metadata si perdimos la pista durante el await
  if (useLibraryPlayerStore.getState().currentTrackId !== track.id) return

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

  ensureLibraryMediaHandlers()
  setPlaybackState(playing)
  pushPositionState()
}

async function stopRivalPlayers() {
  try {
    const { usePlayerStore } = await import('./playerStore')
    const ps = usePlayerStore.getState()
    const rivalActive = Boolean(ps.currentRadioId || ps.currentPodcastEpisodeId)
    ps.yieldToLibraryPlayer()
    // Solo pausar el motor si radio/podcast estaban activos.
    // Al reanudar biblioteca, NO pausar de nuevo (rompe la sesión iOS).
    if (rivalActive) {
      audioEngine.markIntentionalPause(1500)
      audioEngine.pause()
    }
  } catch {
    /* ignore */
  }
}

function wireVisibilityReclaim() {
  if (visibilityWired || typeof document === 'undefined') return
  visibilityWired = true
  const reclaim = () => {
    if (!useLibraryPlayerStore.getState().currentTrackId) return
    setLibraryOwnsMediaSession(true)
    ensureLibraryMediaHandlers()
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') reclaim()
  })
  window.addEventListener('pageshow', reclaim)
}

/**
 * Carga pista en el <audio> único. Si autoplay: src + play (misma instancia).
 */
async function loadTrack(trackId: string, autoplay: boolean): Promise<boolean> {
  ensureElementWired()
  setLibraryOwnsMediaSession(true)
  ensureLibraryMediaHandlers()
  const epoch = ++loadEpoch
  const url = await getAudioObjectUrl(trackId)
  if (!url || epoch !== loadEpoch) return false

  const el = audio()
  const track = await db.tracks.get(trackId)
  if (!track || epoch !== loadEpoch) return false

  void getCoverObjectUrl(trackId).then((coverUrl) => {
    if (useLibraryPlayerStore.getState().currentTrackId === trackId) {
      useLibraryPlayerStore.setState({ coverUrl })
    }
  })

  if (!autoplay) {
    el.src = url
    useLibraryPlayerStore.setState({
      isPlaying: false,
      position: 0,
      duration: Number.isFinite(el.duration) && el.duration > 0 ? el.duration : track.duration || 0,
    })
    await publishMetadata(track, false)
    return true
  }

  setPlaybackState(true)
  applySrcAndPlay(url)

  if (epoch !== loadEpoch) return false

  const playing = !el.paused
  useLibraryPlayerStore.setState({
    isPlaying: playing,
    position: Math.max(0, el.currentTime || 0),
    duration:
      Number.isFinite(el.duration) && el.duration > 0 ? el.duration : track.duration || 0,
  })
  await publishMetadata(track, playing)
  void recordPlay(trackId)
  void persistRecent(trackId)
  prefetchNeighbors()
  return playing
}

function onLibraryTimeUpdate() {
  if (!useLibraryPlayerStore.getState().currentTrackId) return
  const el = audio()
  const position = Number.isFinite(el.currentTime) && el.currentTime >= 0 ? el.currentTime : 0
  const duration =
    Number.isFinite(el.duration) && el.duration >= 0
      ? el.duration
      : useLibraryPlayerStore.getState().duration
  useLibraryPlayerStore.setState({ position, duration })
  persistSoon({ position })
  pushPositionState()
  if (duration > 0 && duration - position < 30) prefetchNeighbors()
}

function onLibraryLoadedMetadata() {
  if (!useLibraryPlayerStore.getState().currentTrackId) return
  const el = audio()
  if (Number.isFinite(el.duration) && el.duration >= 0) {
    useLibraryPlayerStore.setState({ duration: el.duration })
  }
  pushPositionState()
}

function onLibraryPlay() {
  if (!useLibraryPlayerStore.getState().currentTrackId) return
  useLibraryPlayerStore.setState({ isPlaying: true })
  setPlaybackState(true)
  pushPositionState()
}

function onLibraryPause() {
  if (!useLibraryPlayerStore.getState().currentTrackId) return
  if (audio().ended) return
  useLibraryPlayerStore.setState({ isPlaying: false })
  // Mantener metadata + handlers; solo marcar paused
  setPlaybackState(false)
  ensureLibraryMediaHandlers()
}

function onLibraryEnded() {
  if (!useLibraryPlayerStore.getState().currentTrackId) return
  void useLibraryPlayerStore.getState().onEnded()
}

function ensureElementWired() {
  const el = audio()
  if (elementWired === el) return
  if (elementWired) {
    elementWired.removeEventListener('timeupdate', onLibraryTimeUpdate)
    elementWired.removeEventListener('loadedmetadata', onLibraryLoadedMetadata)
    elementWired.removeEventListener('durationchange', onLibraryLoadedMetadata)
    elementWired.removeEventListener('play', onLibraryPlay)
    elementWired.removeEventListener('pause', onLibraryPause)
    elementWired.removeEventListener('ended', onLibraryEnded)
  }
  el.addEventListener('timeupdate', onLibraryTimeUpdate)
  el.addEventListener('loadedmetadata', onLibraryLoadedMetadata)
  el.addEventListener('durationchange', onLibraryLoadedMetadata)
  el.addEventListener('play', onLibraryPlay)
  el.addEventListener('pause', onLibraryPause)
  el.addEventListener('ended', onLibraryEnded)
  elementWired = el
}

ensureElementWired()
ensureLibraryMediaHandlers()
wireVisibilityReclaim()

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
    const el = audio()
    set({
      isPlaying: playing,
      position: Number.isFinite(el.currentTime) && el.currentTime >= 0 ? el.currentTime : 0,
      duration:
        Number.isFinite(el.duration) && el.duration >= 0 ? el.duration : get().duration,
    })
  },

  hydrate: async () => {
    ensureElementWired()
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
      setLibraryOwnsMediaSession(true)
      ensureLibraryMediaHandlers()
      await loadTrack(currentTrackId, false)
      if (snap.position > 0.5) {
        try {
          audio().currentTime = snap.position
        } catch {
          /* ignore */
        }
        set({ position: snap.position })
      }
      prefetchNeighbors()
    }
  },

  playTracks: async (trackIds, startId, options) => {
    if (!trackIds.length) return
    await stopRivalPlayers()
    ensureElementWired()
    setLibraryOwnsMediaSession(true)
    ensureLibraryMediaHandlers()

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

    // Prefetch vecinos antes de play para que skip en bloqueo sea síncrono
    for (const id of queue.slice(index, index + 3)) {
      prefetchId(id)
    }

    for (let i = index; i < queue.length; i++) {
      const id = queue[i]!
      set({ index: i, currentTrackId: id })
      if (await loadTrack(id, true)) return
    }
  },

  toggle: async () => {
    if (!get().currentTrackId) return
    if (!audio().paused || get().isPlaying) {
      get().pause()
      return
    }
    await get().play()
  },

  play: async () => {
    const { currentTrackId } = get()
    if (!currentTrackId) return
    await stopRivalPlayers()
    ensureElementWired()
    setLibraryOwnsMediaSession(true)
    ensureLibraryMediaHandlers()

    const el = audio()
    if (!el.src && !el.currentSrc) {
      await loadTrack(currentTrackId, true)
      return
    }

    setPlaybackState(true)
    el.muted = false
    el.volume = 1
    try {
      await el.play()
      set({ isPlaying: true })
      setPlaybackState(true)
      pushPositionState()
      const track = await db.tracks.get(currentTrackId)
      if (track) await publishMetadata(track, true)
    } catch {
      await loadTrack(currentTrackId, true)
    }
  },

  pause: () => {
    // audio.pause() + playbackState paused. NO limpiar metadata ni handlers.
    setPlaybackState(false)
    audio().pause()
    const pos = Math.max(0, audio().currentTime || 0)
    set({ isPlaying: false, position: pos })
    persistSoon({ position: pos })
    ensureLibraryMediaHandlers()
    prefetchNeighbors()
  },

  onEnded: async () => {
    const { repeat, currentTrackId, queue } = get()
    if (!currentTrackId || !queue.length) return

    if (repeat === 'one') {
      setPlaybackState(true)
      const el = audio()
      try {
        el.currentTime = 0
      } catch {
        /* ignore */
      }
      const playPromise = el.play()
      void Promise.resolve(playPromise).catch(() => {})
      set({ isPlaying: true, position: 0 })
      return
    }

    const target = resolveSkipTarget(1)
    if (!target) {
      setPlaybackState(false)
      set({ isPlaying: false, position: 0 })
      return
    }
    const url = peekAudioObjectUrl(target.trackId)
    if (url) {
      setPlaybackState(true)
      commitTrackChange(target.trackId, target.index, url)
      return
    }
    set({ index: target.index, currentTrackId: target.trackId, position: 0 })
    await loadTrack(target.trackId, true)
  },

  next: async () => {
    const target = resolveSkipTarget(1)
    if (!target) return
    ensureElementWired()
    setPlaybackState(true)
    const url = peekAudioObjectUrl(target.trackId)
    if (url) {
      commitTrackChange(target.trackId, target.index, url)
      return
    }
    set({ index: target.index, currentTrackId: target.trackId, position: 0 })
    persistSoon({ index: target.index, currentTrackId: target.trackId, position: 0 })
    await loadTrack(target.trackId, true)
  },

  previous: async () => {
    const { position } = get()
    if (position > 3) {
      get().seek(0)
      return
    }
    const target = resolveSkipTarget(-1)
    if (!target) return
    ensureElementWired()
    setPlaybackState(true)
    const url = peekAudioObjectUrl(target.trackId)
    if (url) {
      commitTrackChange(target.trackId, target.index, url)
      return
    }
    set({ index: target.index, currentTrackId: target.trackId, position: 0 })
    persistSoon({ index: target.index, currentTrackId: target.trackId, position: 0 })
    await loadTrack(target.trackId, true)
  },

  seek: (time) => {
    if (!get().currentTrackId) return
    const t = Math.max(0, time)
    try {
      audio().currentTime = t
    } catch {
      /* ignore */
    }
    set({ position: t })
    persistSoon({ position: t })
    pushPositionState()
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
    prefetchNeighbors()
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
    prefetchId(trackId)
  },

  playNext: (trackId) => {
    const { queue, index } = get()
    const next = [...queue]
    next.splice(index + 1, 0, trackId)
    const originalQueue = get().shuffle ? get().originalQueue : next
    set({ queue: next, originalQueue })
    persistSoon({ queue: next, originalQueue })
    prefetchId(trackId)
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
    audio().pause()
    setLibraryOwnsMediaSession(false)
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
