/**
 * Reproductor de biblioteca — HTML5 Audio + Media Session.
 *
 * - <audio> propio (sin Web Audio).
 * - Blob/local-audio URLs precargadas (current/next/prev) en primer plano.
 * - nexttrack/previoustrack: solo URLs ya listas → src + play() (sin IndexedDB).
 * - Revoke de blobs solo en foreground cuando la pista ya no está caliente.
 */
import { create } from 'zustand'
import { db, ensurePlaybackSnapshot, PLAYBACK_KEY } from '../db'
import { audioEngine } from '../lib/audioEngine'
import {
  getAudioObjectUrl,
  getCoverObjectUrl,
  peekAudioObjectUrl,
  protectAudioUrls,
  reassignAudioObjectUrl,
  recordPlay,
  scheduleRevokeAudioUrl,
} from '../lib/library'
import { setLibraryOwnsMediaSession, buildLockScreenArtwork } from '../lib/mediaSession'
import {
  bindNativeRemoteControls,
  nativeClearNowPlaying,
  nativeSetMetadata,
  nativeSetPlaybackState,
  nativeSetPositionState,
} from '../lib/nativeNowPlaying'
import type { PlaybackSource, RepeatMode, Track } from '../types'
import { persistRecent } from './libraryStore'

type LibraryPlayerState = {
  queue: string[]
  originalQueue: string[]
  index: number
  currentTrackId: string | null
  /** URL lista para audio.src (local-audio o blob:) — nunca generar en bloqueo. */
  currentAudioUrl: string | null
  nextAudioUrl: string | null
  prevAudioUrl: string | null
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

/** <audio> exclusivo de biblioteca — nunca entra en el grafo Web Audio de radio. */
const libraryAudio: HTMLAudioElement = (() => {
  const el = new Audio()
  el.preload = 'auto'
  const media = el as HTMLAudioElement & { playsInline?: boolean }
  media.playsInline = true
  el.setAttribute('playsinline', 'true')
  el.setAttribute('webkit-playsinline', 'true')
  el.setAttribute('aria-hidden', 'true')
  el.style.cssText =
    'position:fixed;width:1px;height:1px;opacity:0.01;pointer-events:none;left:0;bottom:0;z-index:-1'
  if (typeof document !== 'undefined') {
    const mount = () => {
      if (!el.isConnected) document.body.appendChild(el)
    }
    if (document.body) mount()
    else document.addEventListener('DOMContentLoaded', mount, { once: true })
  }
  return el
})()

function audio(): HTMLAudioElement {
  return libraryAudio
}

let loadEpoch = 0
/** iOS: setPositionState frecuente hace que vuelvan ±10s en bloqueo. */
let lastPositionPushAt = 0
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

function setPlaybackStateFromElement(playing: boolean) {
  if (!useLibraryPlayerStore.getState().currentTrackId) return
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.playbackState = playing ? 'playing' : 'paused'
    } catch {
      /* ignore */
    }
  }
  void nativeSetPlaybackState(playing)
}

function pushPositionState(force = false) {
  if (!useLibraryPlayerStore.getState().currentTrackId) return
  const now = Date.now()
  // ~1s: el contador de bloqueo baja; más a menudo no hace falta
  if (!force && now - lastPositionPushAt < 1000) return
  lastPositionPushAt = now
  const el = audio()
  const duration = el.duration
  const position = el.currentTime
  const rate = el.playbackRate
  if (!Number.isFinite(duration) || duration <= 0) return
  if (!Number.isFinite(position) || position < 0) return
  if (!Number.isFinite(rate) || rate <= 0) return
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.setPositionState({
        duration,
        playbackRate: rate,
        position: Math.min(position, duration),
      })
    } catch {
      /* ignore */
    }
  }
  void nativeSetPositionState(Math.min(position, duration), duration, rate)
  // Tras position state, WebKit a veces reactiva seek± — reafirmar next/prev
  reinforceLibraryMediaHandlers()
}

function prefetchId(trackId: string | null) {
  if (!trackId) return
  if (peekAudioObjectUrl(trackId)) return
  void getAudioObjectUrl(trackId)
}

function neighborIds(): { current: string | null; next: string | null; prev: string | null } {
  const { queue, index, repeat, currentTrackId } = useLibraryPlayerStore.getState()
  if (!queue.length || !currentTrackId) {
    return { current: null, next: null, prev: null }
  }
  const nextIndex =
    index + 1 < queue.length ? index + 1 : repeat === 'all' || repeat === 'one' ? 0 : -1
  const prevIndex =
    index - 1 >= 0 ? index - 1 : repeat === 'all' || repeat === 'one' ? queue.length - 1 : -1
  return {
    current: currentTrackId,
    next: nextIndex >= 0 ? queue[nextIndex] ?? null : null,
    prev: prevIndex >= 0 ? queue[prevIndex] ?? null : null,
  }
}

/**
 * Precarga en primer plano: IndexedDB → Cache Storage / blob URL.
 * Deja current/next/prev listos en el store para saltos en bloqueo.
 */
async function warmReadyAudioUrls() {
  const neighbors = neighborIds()
  protectAudioUrls([neighbors.current, neighbors.next, neighbors.prev])

  const ensure = async (id: string | null): Promise<string | null> => {
    if (!id) return null
    return peekAudioObjectUrl(id) ?? (await getAudioObjectUrl(id))
  }

  const [currentAudioUrl, nextAudioUrl, prevAudioUrl] = await Promise.all([
    ensure(neighbors.current),
    ensure(neighbors.next),
    ensure(neighbors.prev),
  ])

  // Solo actualizar si seguimos en la misma pista
  if (useLibraryPlayerStore.getState().currentTrackId !== neighbors.current) return

  useLibraryPlayerStore.setState({
    currentAudioUrl,
    nextAudioUrl,
    prevAudioUrl,
  })
  protectAudioUrls([neighbors.current, neighbors.next, neighbors.prev])
}

function prefetchNeighbors() {
  void warmReadyAudioUrls()
}

/** URL síncrona desde Blob en RAM (reasigna blob: tras suspensión). */
function readyUrlForTrack(trackId: string): string | null {
  const fresh = reassignAudioObjectUrl(trackId)
  if (fresh) return fresh
  const { currentTrackId, currentAudioUrl, nextAudioUrl, prevAudioUrl } =
    useLibraryPlayerStore.getState()
  if (trackId === currentTrackId && currentAudioUrl) return currentAudioUrl
  const neighbors = neighborIds()
  if (trackId === neighbors.next && nextAudioUrl) return nextAudioUrl
  if (trackId === neighbors.prev && prevAudioUrl) return prevAudioUrl
  return peekAudioObjectUrl(trackId)
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

/** Reasigna src desde Blob/fichero + play() (mismo motor que la PWA). */
function applySrcAndPlay(trackId: string, urlHint?: string | null): void {
  const url = reassignAudioObjectUrl(trackId) ?? urlHint ?? peekAudioObjectUrl(trackId)
  if (!url) return
  const el = audio()
  el.muted = false
  el.volume = 1
  el.src = url
  useLibraryPlayerStore.setState({ currentAudioUrl: url })
  el.play().catch(() => {
    /* NotAllowedError / AbortError */
  })
}

function commitTrackChange(trackId: string, index: number, url: string) {
  loadEpoch += 1
  const prevId = useLibraryPlayerStore.getState().currentTrackId
  useLibraryPlayerStore.setState({
    currentTrackId: trackId,
    index,
    position: 0,
    isPlaying: true,
    currentAudioUrl: url,
  })
  persistSoon({ currentTrackId: trackId, index, position: 0 })
  setLibraryOwnsMediaSession(true)
  applySrcAndPlay(trackId, url)
  if (prevId && prevId !== trackId) {
    scheduleRevokeAudioUrl(prevId)
  }
  void db.tracks.get(trackId).then((track) => {
    if (track && useLibraryPlayerStore.getState().currentTrackId === trackId) {
      void publishMetadata(track)
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
 * Media Session: next/prev de pista + metadatos en bloqueo.
 * Nunca seek± (iOS los pinta como +10/−10).
 * En Capacitor nativo, UIBackgroundModes=audio + estos handlers = control en bloqueo.
 */
function reinforceLibraryMediaHandlers() {
  if (!useLibraryPlayerStore.getState().currentTrackId) return

  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.setActionHandler('seekforward', null)
      navigator.mediaSession.setActionHandler('seekbackward', null)
      navigator.mediaSession.setActionHandler('seekto', null)
    } catch {
      /* ignore */
    }

    navigator.mediaSession.setActionHandler('play', () => {
      const { currentTrackId } = useLibraryPlayerStore.getState()
      if (!currentTrackId) return
      const url = reassignAudioObjectUrl(currentTrackId)
      const el = audio()
      if (url && el.src !== url && el.currentSrc !== url) {
        const pos = el.currentTime
        el.src = url
        try {
          if (pos > 0.25) el.currentTime = pos
        } catch {
          /* ignore */
        }
      }
      el.play().catch(() => {})
    })

    navigator.mediaSession.setActionHandler('pause', () => {
      if (!useLibraryPlayerStore.getState().currentTrackId) return
      audio().pause()
    })

    navigator.mediaSession.setActionHandler('previoustrack', () => {
      if (!useLibraryPlayerStore.getState().currentTrackId) return
      const target = resolveSkipTarget(-1)
      if (!target) return
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
        useLibraryPlayerStore.setState({ position: 0 })
        el.play().catch(() => {})
        return
      }
      const url = readyUrlForTrack(target.trackId)
      if (!url) return
      commitTrackChange(target.trackId, target.index, url)
    })

    navigator.mediaSession.setActionHandler('nexttrack', () => {
      if (!useLibraryPlayerStore.getState().currentTrackId) return
      const target = resolveSkipTarget(1)
      if (!target) return
      const url = readyUrlForTrack(target.trackId)
      if (!url) return
      commitTrackChange(target.trackId, target.index, url)
    })
  }

  void bindNativeRemoteControls({
    play: () => {
      const { currentTrackId } = useLibraryPlayerStore.getState()
      if (!currentTrackId) return
      const url = reassignAudioObjectUrl(currentTrackId)
      const el = audio()
      if (url && el.src !== url && el.currentSrc !== url) {
        const pos = el.currentTime
        el.src = url
        try {
          if (pos > 0.25) el.currentTime = pos
        } catch {
          /* ignore */
        }
      }
      el.play().catch(() => {})
    },
    pause: () => {
      if (!useLibraryPlayerStore.getState().currentTrackId) return
      audio().pause()
    },
    previoustrack: () => {
      if (!useLibraryPlayerStore.getState().currentTrackId) return
      const target = resolveSkipTarget(-1)
      if (!target) return
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
        useLibraryPlayerStore.setState({ position: 0 })
        el.play().catch(() => {})
        return
      }
      const url = readyUrlForTrack(target.trackId)
      if (!url) return
      commitTrackChange(target.trackId, target.index, url)
    },
    nexttrack: () => {
      if (!useLibraryPlayerStore.getState().currentTrackId) return
      const target = resolveSkipTarget(1)
      if (!target) return
      const url = readyUrlForTrack(target.trackId)
      if (!url) return
      commitTrackChange(target.trackId, target.index, url)
    },
    seekto: (time) => {
      if (!useLibraryPlayerStore.getState().currentTrackId) return
      const el = audio()
      try {
        el.currentTime = time
      } catch {
        /* ignore */
      }
      useLibraryPlayerStore.setState({ position: time })
      pushPositionState(true)
    },
  })
}

function bindMediaSessionOnUserPlay() {
  setLibraryOwnsMediaSession(true)
  reinforceLibraryMediaHandlers()
}

async function publishMetadata(track: Track) {
  setLibraryOwnsMediaSession(true)

  // JPEG data-URL para Dynamic Island nativa (blob: no sirve fuera del WebView)
  let artwork: MediaImage[] = []
  try {
    artwork = await buildLockScreenArtwork(track.id)
  } catch {
    /* ignore */
  }

  if (useLibraryPlayerStore.getState().currentTrackId !== track.id) return

  if ('mediaSession' in navigator) {
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
  }

  void nativeSetMetadata({
    title: track.title,
    artist: track.artist || 'MyVibe',
    album: track.album || 'MyVibe',
    artwork,
  }).then(() => {
    const playing = !audio().paused || useLibraryPlayerStore.getState().isPlaying
    void nativeSetPlaybackState(playing)
    if (playing) pushPositionState(true)
  })
  reinforceLibraryMediaHandlers()
}

async function stopRivalPlayers() {
  try {
    const { usePlayerStore } = await import('./playerStore')
    const ps = usePlayerStore.getState()
    const rivalActive = Boolean(ps.currentRadioId || ps.currentPodcastEpisodeId)
    ps.yieldToLibraryPlayer()
    if (rivalActive) {
      audioEngine.markIntentionalPause(1500)
      audioEngine.pause()
    }
  } catch {
    /* ignore */
  }
}

async function loadTrack(trackId: string, autoplay: boolean): Promise<boolean> {
  setLibraryOwnsMediaSession(true)
  const epoch = ++loadEpoch
  const url = await getAudioObjectUrl(trackId)
  if (!url || epoch !== loadEpoch) return false

  const el = audio()
  const track = await db.tracks.get(trackId)
  if (!track || epoch !== loadEpoch) return false

  useLibraryPlayerStore.setState({ currentAudioUrl: url })

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
    await publishMetadata(track)
    await warmReadyAudioUrls()
    return true
  }

  applySrcAndPlay(trackId, url)

  if (epoch !== loadEpoch) return false

  useLibraryPlayerStore.setState({
    position: Math.max(0, el.currentTime || 0),
    duration:
      Number.isFinite(el.duration) && el.duration > 0 ? el.duration : track.duration || 0,
  })
  await publishMetadata(track)
  void recordPlay(trackId)
  void persistRecent(trackId)
  await warmReadyAudioUrls()
  return !el.paused
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
  pushPositionState(true)
}

function onLibraryPlaying() {
  if (!useLibraryPlayerStore.getState().currentTrackId) return
  useLibraryPlayerStore.setState({ isPlaying: true })
  setPlaybackStateFromElement(true)
  reinforceLibraryMediaHandlers()
}

function onLibraryPause() {
  if (!useLibraryPlayerStore.getState().currentTrackId) return
  if (audio().ended) return
  useLibraryPlayerStore.setState({ isPlaying: false })
  setPlaybackStateFromElement(false)
  persistSoon({ position: Math.max(0, audio().currentTime || 0) })
  reinforceLibraryMediaHandlers()
}

function onLibraryEnded() {
  if (!useLibraryPlayerStore.getState().currentTrackId) return
  void useLibraryPlayerStore.getState().onEnded()
}

libraryAudio.addEventListener('timeupdate', onLibraryTimeUpdate)
libraryAudio.addEventListener('loadedmetadata', onLibraryLoadedMetadata)
libraryAudio.addEventListener('playing', onLibraryPlaying)
libraryAudio.addEventListener('pause', onLibraryPause)
libraryAudio.addEventListener('ended', onLibraryEnded)
// Media Session next/prev: NO en cold start — solo en el primer play() del usuario

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    if (!useLibraryPlayerStore.getState().currentTrackId) return
    reinforceLibraryMediaHandlers()
    void warmReadyAudioUrls()
  })
}

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
  currentAudioUrl: null,
  nextAudioUrl: null,
  prevAudioUrl: null,
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
      await loadTrack(currentTrackId, false)
      if (snap.position > 0.5) {
        try {
          audio().currentTime = snap.position
        } catch {
          /* ignore */
        }
        set({ position: snap.position })
      }
      await warmReadyAudioUrls()
    }
  },

  playTracks: async (trackIds, startId, options) => {
    if (!trackIds.length) return
    await stopRivalPlayers()
    // Primer play del usuario: registrar Media Session aquí (no en cold start)
    bindMediaSessionOnUserPlay()

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
      currentAudioUrl: null,
      nextAudioUrl: null,
      prevAudioUrl: null,
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

    // Precarga current + vecinos EN PRIMER PLANO antes de play
    for (const id of queue.slice(index, index + 3)) {
      prefetchId(id)
    }
    await warmReadyAudioUrls()

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
    bindMediaSessionOnUserPlay()

    const el = audio()
    const url = reassignAudioObjectUrl(currentTrackId) ?? (await getAudioObjectUrl(currentTrackId))
    if (!url && !el.src && !el.currentSrc) {
      await loadTrack(currentTrackId, true)
      return
    }
    if (url) {
      const pos = Math.max(0, el.currentTime || get().position || 0)
      if (el.src !== url && el.currentSrc !== url) {
        el.src = url
        try {
          if (pos > 0.25) el.currentTime = pos
        } catch {
          /* ignore */
        }
      }
      set({ currentAudioUrl: url })
    }

    el.muted = false
    el.volume = 1
    try {
      await el.play()
      set({ isPlaying: !el.paused })
      const track = await db.tracks.get(currentTrackId)
      if (track) await publishMetadata(track)
    } catch {
      await loadTrack(currentTrackId, true)
    }
  },

  pause: () => {
    audio().pause()
    const pos = Math.max(0, audio().currentTime || 0)
    set({ isPlaying: false, position: pos })
    persistSoon({ position: pos })
    prefetchNeighbors()
  },

  onEnded: async () => {
    const { repeat, currentTrackId, queue } = get()
    if (!currentTrackId || !queue.length) return

    const { useSleepTimerStore } = await import('./sleepTimerStore')
    if (useSleepTimerStore.getState().onMediaEnded()) {
      set({ isPlaying: false })
      return
    }

    if (repeat === 'one') {
      const el = audio()
      try {
        el.currentTime = 0
      } catch {
        /* ignore */
      }
      set({ position: 0 })
      el.play().catch(() => {})
      return
    }

    const target = resolveSkipTarget(1)
    if (!target) {
      set({ isPlaying: false, position: 0 })
      return
    }
    const url = readyUrlForTrack(target.trackId)
    if (url) {
      commitTrackChange(target.trackId, target.index, url)
      return
    }
    set({ index: target.index, currentTrackId: target.trackId, position: 0 })
    await loadTrack(target.trackId, true)
  },

  next: async () => {
    const target = resolveSkipTarget(1)
    if (!target) return
    let url = readyUrlForTrack(target.trackId)
    if (!url) {
      // Solo en primer plano (gesto in-app): permitir generar URL
      url = await getAudioObjectUrl(target.trackId)
    }
    if (!url) return
    commitTrackChange(target.trackId, target.index, url)
  },

  previous: async () => {
    const { position } = get()
    if (position > 3) {
      get().seek(0)
      return
    }
    const target = resolveSkipTarget(-1)
    if (!target) return
    let url = readyUrlForTrack(target.trackId)
    if (!url) {
      url = await getAudioObjectUrl(target.trackId)
    }
    if (!url) return
    commitTrackChange(target.trackId, target.index, url)
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
    const prevId = get().currentTrackId
    audio().pause()
    setLibraryOwnsMediaSession(false)
    protectAudioUrls([])
    if (prevId) scheduleRevokeAudioUrl(prevId)
    set({
      currentTrackId: null,
      currentAudioUrl: null,
      nextAudioUrl: null,
      prevAudioUrl: null,
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
    void nativeClearNowPlaying()
  },

  setNowPlayingOpen: (open) => set({ nowPlayingOpen: open }),
  setQueueOpen: (open) => set({ queueOpen: open }),
}))
