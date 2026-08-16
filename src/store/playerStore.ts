import { create } from 'zustand'
import { db, ensurePlaybackSnapshot, PLAYBACK_KEY } from '../db'
import { audioEngine } from '../lib/audioEngine'
import { setMediaPlaybackState, setMediaPositionState, updateMediaSession, updateRadioMediaSession, refreshMediaPlaybackState, isLibraryOwnsMediaSession } from '../lib/mediaSession'
import type { PlaybackSource, RepeatMode, Track } from '../types'
import { getRadioStation, listMyRadios, type RadioStation } from '../lib/myRadios'
import { roundRadioDelayMs } from '../lib/radios'
import {
  getPodcastEpisode,
  getPodcastResumeAt,
  getPodcastShow,
  markPodcastCompleted,
  rememberPodcastEpisode,
  rememberPodcastShow,
  savePodcastProgress,
  type PodcastEpisode,
  type PodcastShow,
} from '../lib/podcasts'

interface PlayerState {
  queue: string[]
  originalQueue: string[]
  index: number
  currentTrackId: string | null
  /** Emisora de radio en directo (null = biblioteca) */
  currentRadioId: string | null
  /** Episodio de podcast en reproducción */
  currentPodcastEpisodeId: string | null
  isPlaying: boolean
  shuffle: boolean
  repeat: RepeatMode
  position: number
  duration: number
  volume: number
  muted: boolean
  nowPlayingOpen: boolean
  queueOpen: boolean
  coverUrl: string | null
  hydrated: boolean
  /** Lista/origen desde el que se lanzó la cola (Now Playing expandido). */
  playbackSource: PlaybackSource | null
  /** Se incrementa al guardar progreso de podcast (para refrescar la UI). */
  podcastProgressTick: number
  /** Timestamp performance.now() al pausar radio para sumar al delay; null si no está midiendo */
  radioPauseStartedAt: number | null

  hydrate: () => Promise<void>
  /** Cede audio/UI a libraryPlayerStore (motor de biblioteca nuevo). */
  yieldToLibraryPlayer: () => void
  playRadio: (stationId: string) => Promise<void>
  playPodcastEpisode: (
    episode: PodcastEpisode,
    show: PodcastShow,
    siblings?: PodcastEpisode[],
  ) => Promise<void>
  setRadioDelay: (seconds: number) => void
  radioDelay: number
  toggle: () => Promise<void>
  pause: () => void
  play: () => Promise<void>
  next: (opts?: { fromEnded?: boolean }) => Promise<void>
  previous: () => Promise<void>
  seek: (time: number) => void
  skipForward: (seconds?: number) => void
  skipBack: (seconds?: number) => void
  setVolume: (v: number) => void
  toggleMute: () => void
  setNowPlayingOpen: (open: boolean) => void
  setQueueOpen: (open: boolean) => void
  syncFromEngine: () => void
  getCurrentRadio: () => RadioStation | null
  getCurrentPodcastEpisode: () => PodcastEpisode | null
  getCurrentPodcastShow: () => PodcastShow | null
}

let persistTimer: number | null = null
let endedUnsub: (() => void) | null = null
let engineUnsub: (() => void) | null = null
let interruptionUnsub: (() => void) | null = null
let interruptionEndUnsub: (() => void) | null = null
let interruptionBurstToken = 0
let trackAdvanceLockUntil = 0
/** Si el avance automático no pudo hacer play (bloqueo), reintentar al volver. */
let pendingBackgroundPlay = false
/**
 * Tras saltar de pista, forzar playbackState=playing un rato:
 * iOS/CarPlay pisa el botón a Play al cambiar metadata/posición.
 */
let mediaPlayingHoldUntil = 0
/** No llamar setPositionState justo tras el salto: en CarPlay resetea a Play. */
let suppressPositionUntil = 0
/** Throttle de setPositionState (cada tick lo pisa a Play en iOS). */
let lastPositionPushAt = 0
let lastPositionPushKey: string | null = null
/** Tras llamada / interrupción del sistema: reintentar play y reclamar Now Playing. */
let interruptionResumeTimer: number | null = null
let interruptionResumeUntil = 0

/** Player.tsx: no pisar metadata mientras publicamos tras skip/CarPlay. */
export function shouldDeferAuxiliaryMediaSessionBind(): boolean {
  const now = Date.now()
  return now < trackAdvanceLockUntil || now < mediaPlayingHoldUntil
}

function clearMediaPlayingHold() {
  mediaPlayingHoldUntil = 0
}

/** Cola de episodios del show abierto (ids). */
let podcastEpisodeQueue: string[] = []
let podcastPlayEpoch = 0
let lastPodcastProgressSave = 0
let radioDelayTimer: number | null = null
let nearEndPollTimer: number | null = null

function mediaIsEffectivelyPlaying() {
  // Audio real manda.
  if (!audioEngine.paused) return true
  const { isPlaying } = usePlayerStore.getState()
  // Pause explícito: no fingir playing
  if (!isPlaying && !pendingBackgroundPlay) return false
  // Ventana tras salto de pista: metadata/posición resetean CarPlay a Play
  if (Date.now() < mediaPlayingHoldUntil && pendingBackgroundPlay) return true
  // Play remoto / avance: el <audio> puede ir un instante en pause al cambiar src
  if (pendingBackgroundPlay) return true
  if (audioEngine.isSystemInterrupted && isPlaying) return true
  return false
}


/** Play remoto mínimo: mismo gesto → audioEngine.play / store.play. Sin laberinto. */
function handleRemotePlay() {
  stopInterruptionResumeWatcher()
  const state = usePlayerStore.getState()
  if (!state.currentTrackId && !state.currentRadioId && !state.currentPodcastEpisodeId) {
    return
  }

  if (!audioEngine.paused) {
    pendingBackgroundPlay = false
    usePlayerStore.setState({ isPlaying: true })
    setMediaPlaybackState(true)
    refreshMediaPlaybackState(true, { strong: true })
    return
  }

  pendingBackgroundPlay = true
  usePlayerStore.setState({ isPlaying: true })
  const resumeAt =
    state.position > 0.25
      ? state.position
      : Number.isFinite(audioEngine.currentTime)
        ? audioEngine.currentTime
        : 0

  // Crítico en iOS: play() en el mismo turno del gesto de Media Session
  void audioEngine.playFromUserGesture(resumeAt).then((ok) => {
    const playing = Boolean(ok) && !audioEngine.paused
    if (playing) {
      pendingBackgroundPlay = false
      usePlayerStore.setState({ isPlaying: true })
      setMediaPlaybackState(true)
      refreshMediaPlaybackState(true, { strong: true })
      return
    }
    void usePlayerStore
      .getState()
      .play()
      .then(() => {
        const nowPlaying = !audioEngine.paused
        pendingBackgroundPlay = nowPlaying
        usePlayerStore.setState({ isPlaying: nowPlaying })
        refreshMediaPlaybackState(nowPlaying, { strong: nowPlaying })
      })
      .catch(() => {
        pendingBackgroundPlay = false
        clearMediaPlayingHold()
        usePlayerStore.setState({ isPlaying: false })
        refreshMediaPlaybackState(false)
      })
  })
}

function handleRemotePause() {
  audioEngine.markIntentionalPause(2000)
  interruptionBurstToken += 1
  stopInterruptionResumeWatcher()
  pendingBackgroundPlay = false
  clearMediaPlayingHold()
  usePlayerStore.getState().pause()
  if (!audioEngine.paused) audioEngine.pause()
  usePlayerStore.setState({ isPlaying: false })
  setMediaPlaybackState(false)
  refreshMediaPlaybackState(false)
}

/**
 * Avanza de pista. `early` = aún suena la actual (pantalla apagada).
 * Devuelve true si reclamó el avance (éxito o fallback async).
 */
function stopNearEndPoller() {
  if (nearEndPollTimer == null) return
  window.clearInterval(nearEndPollTimer)
  nearEndPollTimer = null
}

function stopInterruptionResumeWatcher() {
  if (interruptionResumeTimer != null) {
    window.clearInterval(interruptionResumeTimer)
    interruptionResumeTimer = null
  }
  interruptionResumeUntil = 0
}

function startInterruptionResumeWatcher() {
  interruptionResumeUntil = Date.now() + 180_000
  if (interruptionResumeTimer != null) return
  interruptionResumeTimer = window.setInterval(() => {
    if (Date.now() > interruptionResumeUntil) {
      stopInterruptionResumeWatcher()
      return
    }
    const state = usePlayerStore.getState()
    if (!pendingBackgroundPlay && !state.isPlaying) {
      stopInterruptionResumeWatcher()
      return
    }
    audioEngine.applyPlaybackSession()
    if (!audioEngine.paused) {
      pendingBackgroundPlay = false
      stopInterruptionResumeWatcher()
      refreshMediaPlaybackState(true)
      return
    }
    if (audioEngine.isSystemInterrupted) return
    void state.play().then(() => {
      if (!audioEngine.paused) refreshMediaPlaybackState(true)
    })
  }, 1200)
}

/**
 * Tras colgar, iOS a veces tarda un poco en soltar el hardware.
 * Varios intentos cortos sin esperar a que el usuario abra el móvil.
 */
async function burstResumeAfterCall() {
  const token = ++interruptionBurstToken
  const delays = [0, 200, 600, 1200, 2500, 5000, 9000]
  for (const wait of delays) {
    if (wait) await new Promise((r) => window.setTimeout(r, wait))
    if (token !== interruptionBurstToken) return
    if (!pendingBackgroundPlay) return
    if (audioEngine.isSystemInterrupted) continue

    const state = usePlayerStore.getState()
    if (!state.currentTrackId && !state.currentRadioId && !state.currentPodcastEpisodeId) {
      return
    }

    audioEngine.applyPlaybackSession()
    await state.play()

    if (!audioEngine.paused) {
      pendingBackgroundPlay = false
      stopInterruptionResumeWatcher()
      refreshMediaPlaybackState(true)
      return
    }
  }
}

/** Reanudar tras llamada / volver al coche / desbloquear. Solo radio/podcast. */
export function resumeAfterInterruption() {
  const state = usePlayerStore.getState()
  if (!state.currentRadioId && !state.currentPodcastEpisodeId) {
    return
  }
  audioEngine.applyPlaybackSession()
  const wantPlaying = pendingBackgroundPlay || state.isPlaying
  if (wantPlaying && audioEngine.paused) {
    pendingBackgroundPlay = true
    void burstResumeAfterCall()
    startInterruptionResumeWatcher()
    return
  }
  if (wantPlaying && !audioEngine.paused) {
    refreshMediaPlaybackState(true)
  }
}

function bumpPodcastProgressTick(
  set: (partial: Partial<PlayerState>) => void,
  get: () => PlayerState,
) {
  set({ podcastProgressTick: get().podcastProgressTick + 1 })
}

function persistPodcastProgressNow(
  set: (partial: Partial<PlayerState>) => void,
  get: () => PlayerState,
  forceComplete = false,
) {
  const id = get().currentPodcastEpisodeId
  if (!id) return
  const position = audioEngine.currentTime
  const duration = Number.isFinite(audioEngine.duration)
    ? audioEngine.duration
    : get().duration
  if (forceComplete) {
    markPodcastCompleted(id)
  } else {
    const showId = getPodcastEpisode(id)?.showId
    savePodcastProgress(id, position, duration, showId || undefined)
  }
  lastPodcastProgressSave = performance.now()
  bumpPodcastProgressTick(set, get)
}

function podcastSyntheticTrack(episode: PodcastEpisode, show: PodcastShow): Track {
  return {
    id: episode.id,
    title: episode.title,
    artist: show.name || show.artist || 'Podcast',
    album: show.artist || show.name || '',
    genre: '',
    year: '',
    duration: episode.durationSec || 0,
    mimeType: 'audio/mpeg',
    fileName: '',
    hasCover: Boolean(episode.artworkUrl || show.artworkUrl),
    liked: false,
    playCount: 0,
    lastPlayedAt: null,
    createdAt: 0,
    enriched: false,
    hasLocalAudio: false,
  }
}

type PlaybackPersistPartial = Partial<{
  currentTrackId: string | null
  queue: string[]
  originalQueue: string[]
  index: number
  shuffle: boolean
  repeat: RepeatMode
  position: number
  volume: number
  playbackSource: PlaybackSource | null
}>

let pendingPersist: PlaybackPersistPartial = {}

function persistSoon(partial: PlaybackPersistPartial) {
  Object.assign(pendingPersist, partial)
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = window.setTimeout(() => {
    void flushPlaybackPersist()
  }, 400)
}

async function flushPlaybackPersist() {
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  const partial = pendingPersist
  pendingPersist = {}
  if (!Object.keys(partial).length) return
  try {
    await db.playback.update(PLAYBACK_KEY, partial)
  } catch {
    // ignore
  }
}

/** Guarda al instante posición + cola (al cerrar / pasar a segundo plano). */
function persistPlaybackNow() {
  const state = usePlayerStore.getState()
  if (!state.hydrated) return
  const livePos =
    state.currentTrackId && !audioEngine.isLive && Number.isFinite(audioEngine.currentTime)
      ? audioEngine.currentTime
      : state.position
  pendingPersist = {
    ...pendingPersist,
    currentTrackId: state.currentTrackId,
    queue: state.queue,
    originalQueue: state.originalQueue.length ? state.originalQueue : state.queue,
    index: state.index,
    shuffle: state.shuffle,
    repeat: state.repeat,
    position: livePos,
    volume: state.volume,
    playbackSource: state.playbackSource,
  }
  void flushPlaybackPersist()
}

let persistLifecycleBound = false
function bindPersistLifecycle() {
  if (persistLifecycleBound || typeof window === 'undefined') return
  persistLifecycleBound = true
  const flush = () => persistPlaybackNow()
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush()
  })
  window.addEventListener('pagehide', flush)
  window.addEventListener('beforeunload', flush)
  document.addEventListener('freeze', flush as EventListener)
}

export const usePlayerStore = create<PlayerState>((set, get) => ({
  queue: [],
  originalQueue: [],
  index: 0,
  currentTrackId: null,
  currentRadioId: null,
  currentPodcastEpisodeId: null,
  radioDelay: audioEngine.radioDelay,
  radioPauseStartedAt: null,
  isPlaying: false,
  shuffle: true,
  repeat: 'off',
  position: 0,
  duration: 0,
  volume: 1,
  muted: false,
  nowPlayingOpen: false,
  queueOpen: false,
  coverUrl: null,
  hydrated: false,
  playbackSource: null,
  podcastProgressTick: 0,

  hydrate: async () => {
    /* Media Session play/pause remoto stripped */
    const snap = await ensurePlaybackSnapshot()
    audioEngine.setVolume(snap.volume)

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

    // Biblioteca: motor nuevo en libraryPlayerStore — no restaurar aquí
    queue = []
    originalQueue = []
    index = 0
    currentTrackId = null

    set({
      queue,
      originalQueue,
      index,
      currentTrackId,
      shuffle: false,
      repeat: 'off',
      position: 0,
      volume: snap.volume,
      playbackSource: null,
      hydrated: true,
    })
    bindPersistLifecycle()

    if (!engineUnsub) {
      engineUnsub = audioEngine.subscribe(() => get().syncFromEngine())
    }
    if (!endedUnsub) {
      endedUnsub = audioEngine.onEnded(() => {
        if (get().currentRadioId || audioEngine.isLive) return

        if (get().currentPodcastEpisodeId) {
          if (Date.now() < trackAdvanceLockUntil) return
          void import('./sleepTimerStore').then(({ useSleepTimerStore }) => {
            if (useSleepTimerStore.getState().onMediaEnded()) {
              persistPodcastProgressNow(set, get, true)
              set({ isPlaying: false })
              return
            }
            persistPodcastProgressNow(set, get, true)
            trackAdvanceLockUntil = Date.now() + 800
            void get().next({ fromEnded: true })
          })
          return
        }

        // Biblioteca: libraryPlayerStore (audio propio)
      })
    }

    if (!interruptionUnsub) {
      interruptionUnsub = audioEngine.onInterruption(() => {
        // Durante auto-next el cambio de src dispara pause: no es una llamada
        if (Date.now() < trackAdvanceLockUntil) return
        // Llamada / Siri / otra app: no marcar pause de usuario
        if (!get().currentRadioId && !get().currentPodcastEpisodeId) {
          return
        }
        // Si ya estábamos en pause intencional, isPlaying es false y no hay pending
        if (!get().isPlaying && !pendingBackgroundPlay) return

        pendingBackgroundPlay = true
        set({ isPlaying: true })
        // Mantener metadatos en Now Playing (si se pierden, CarPlay salta a Spotify)
        audioEngine.applyPlaybackSession()
        startInterruptionResumeWatcher()
      })
    }

    if (!interruptionEndUnsub) {
      interruptionEndUnsub = audioEngine.onInterruptionEnd(() => {
        if (!get().currentRadioId && !get().currentPodcastEpisodeId) {
          return
        }
        // Colgar / iOS suelta el audio: reanudar sin abrir el móvil
        pendingBackgroundPlay = true
        set({ isPlaying: true })
        audioEngine.applyPlaybackSession()
        void burstResumeAfterCall()
        startInterruptionResumeWatcher()
      })
    }
  },

  yieldToLibraryPlayer: () => {
    podcastEpisodeQueue = []
    pendingBackgroundPlay = false
    clearMediaPlayingHold()
    interruptionBurstToken += 1
    stopInterruptionResumeWatcher()
    stopNearEndPoller()
    // No pausar aquí: libraryPlayerStore decide si hay rival activo.
    // Pausar siempre al reanudar biblioteca destruía la sesión iOS.
    set({
      currentTrackId: null,
      currentRadioId: null,
      currentPodcastEpisodeId: null,
      queue: [],
      originalQueue: [],
      index: 0,
      isPlaying: false,
      coverUrl: null,
      playbackSource: null,
      radioPauseStartedAt: null,
      position: 0,
      duration: 0,
    })
  },

  syncFromEngine: () => {
    // Biblioteca posee el <audio> compartido: no pisar Media Session
    if (isLibraryOwnsMediaSession()) return
    const playing = !audioEngine.paused
    // Solo soltar pending cuando ya suena y pasó la ventana anti-reset de CarPlay
    if (playing && pendingBackgroundPlay && Date.now() >= mediaPlayingHoldUntil) {
      pendingBackgroundPlay = false
      stopInterruptionResumeWatcher()
    }
    const effectivePlaying = mediaIsEffectivelyPlaying()
    const live = Boolean(get().currentRadioId) || audioEngine.isLive
    if (live) {
      stopNearEndPoller()
      set({
        isPlaying: effectivePlaying,
        position: 0,
        duration: 0,
      })
      setMediaPlaybackState(effectivePlaying)
      return
    }
    const position = audioEngine.currentTime
    const duration = audioEngine.duration
    set({
      position,
      duration: Number.isFinite(duration) ? duration : 0,
      isPlaying: effectivePlaying,
      volume: audioEngine.volume,
      muted: audioEngine.muted,
    })
    // setPositionState en iOS resetea a Play: no cada tick; solo ~2s o al cambiar pista/pausar
    if (Date.now() < suppressPositionUntil) {
      if (effectivePlaying) setMediaPlaybackState(true)
    } else {
      const posKey =
        get().currentTrackId ||
        get().currentPodcastEpisodeId ||
        get().currentRadioId ||
        null
      const now = Date.now()
      const trackChanged = posKey !== lastPositionPushKey
      const due =
        trackChanged ||
        !effectivePlaying ||
        now - lastPositionPushAt >= 2000
      if (due) {
        setMediaPositionState(position, duration, effectivePlaying)
        lastPositionPushAt = now
        lastPositionPushKey = posKey
      } else if (effectivePlaying) {
        setMediaPlaybackState(true)
      }
    }
    persistSoon({ position })

    if (get().currentPodcastEpisodeId && playing) {
      const now = performance.now()
      if (now - lastPodcastProgressSave > 3000) {
        persistPodcastProgressNow(set, get)
      }
      stopNearEndPoller()
      return
    }

    if (playing && get().currentPodcastEpisodeId) {
      // podcast near-end handled by ended event
    }

    // Biblioteca ya no usa audioEngine / tryAdvanceLibraryTrack
  },

  // Watchdog biblioteca eliminado — libraryPlayerStore

  playRadio: async (stationId) => {
    try {
      const { useLibraryPlayerStore } = await import('./libraryPlayerStore')
      useLibraryPlayerStore.getState().stop()
    } catch {
      /* ignore */
    }
    const station = getRadioStation(stationId)
    if (!station) return
    if (get().currentPodcastEpisodeId) {
      persistPodcastProgressNow(set, get)
    }
    podcastEpisodeQueue = []
    pendingBackgroundPlay = false
    if (radioDelayTimer) {
      clearTimeout(radioDelayTimer)
      radioDelayTimer = null
    }
    // Nueva emisora = retraso a cero (el sync TV es por buffer de esa sintonía)
    set({
      currentRadioId: station.id,
      currentTrackId: null,
      currentPodcastEpisodeId: null,
      coverUrl: station.logoUrl || null,
      queue: [],
      originalQueue: [],
      index: 0,
      position: 0,
      duration: 0,
      radioPauseStartedAt: null,
      radioDelay: 0,
      isPlaying: true,
      playbackSource: null,
    })
    persistSoon({ playbackSource: null })
    setMediaPlaybackState(true)
    try {
      const { reportStationClick } = await import('../lib/radioBrowser')
      reportStationClick(station.id)
      await audioEngine.loadLive(station.streamUrl)
      if (get().currentRadioId !== station.id) return
      audioEngine.applyPlaybackSession()
      const ok = await audioEngine.play()
      if (get().currentRadioId !== station.id) return
      const playing = ok && !audioEngine.paused
      // Forzar 0: loadLive ya resetea el motor; no heredar delay de la emisora anterior
      set({ isPlaying: playing, radioPauseStartedAt: null, radioDelay: 0 })
      setMediaPlaybackState(playing)
      void updateRadioMediaSession(station, {
        play: () => {
          pendingBackgroundPlay = true
          void usePlayerStore.getState().play()
        },
        pause: () => usePlayerStore.getState().pause(),
        previoustrack: () => void usePlayerStore.getState().previous(),
        nexttrack: () => void usePlayerStore.getState().next(),
      })
    } catch (e) {
      console.warn('Radio', e)
      if (get().currentRadioId === station.id) {
        set({ isPlaying: false, currentRadioId: null })
        setMediaPlaybackState(false)
      }
      alert(`No se pudo sintonizar ${station.name}. Prueba otra emisora.`)
    }
  },

  playPodcastEpisode: async (episode, show, siblings) => {
    try {
      const { useLibraryPlayerStore } = await import('./libraryPlayerStore')
      useLibraryPlayerStore.getState().stop()
    } catch {
      /* ignore */
    }
    if (!episode?.audioUrl) return
    if (get().currentPodcastEpisodeId && get().currentPodcastEpisodeId !== episode.id) {
      persistPodcastProgressNow(set, get)
    }
    rememberPodcastShow(show)
    rememberPodcastEpisode(episode)
    const list = (siblings?.length ? siblings : [episode]).filter((e) => e.audioUrl)
    for (const ep of list) rememberPodcastEpisode(ep)
    podcastEpisodeQueue = list.map((e) => e.id)
    const epoch = ++podcastPlayEpoch
    const index = Math.max(0, podcastEpisodeQueue.indexOf(episode.id))
    const resumeAt = getPodcastResumeAt(episode.id)

    set({
      currentPodcastEpisodeId: episode.id,
      currentRadioId: null,
      currentTrackId: null,
      coverUrl: episode.artworkUrl || show.artworkUrl || '',
      queue: [],
      originalQueue: [],
      index,
      position: resumeAt,
      duration: episode.durationSec || 0,
      radioPauseStartedAt: null,
      queueOpen: false,
      playbackSource: null,
    })
    persistSoon({ playbackSource: null })

    try {
      await audioEngine.load(episode.audioUrl, resumeAt, { live: false, skipCors: true })
      if (epoch !== podcastPlayEpoch || get().currentPodcastEpisodeId !== episode.id) return
      audioEngine.applyPlaybackSession()
      await audioEngine.ensureAudible()
      await audioEngine.play()
      if (epoch !== podcastPlayEpoch || get().currentPodcastEpisodeId !== episode.id) return
      set({ isPlaying: !audioEngine.paused, queueOpen: false })
      setMediaPlaybackState(!audioEngine.paused)
      await updateMediaSession(
        podcastSyntheticTrack(episode, show),
        episode.artworkUrl || show.artworkUrl || null,
        {
          play: () => handleRemotePlay(),
          pause: () => handleRemotePause(),
          previoustrack: () => void usePlayerStore.getState().previous(),
          nexttrack: () => void usePlayerStore.getState().next(),
          // Sin seekto: en iOS sustituye next/prev por ±10s
        },
        { playing: !audioEngine.paused },
      )
      refreshMediaPlaybackState(!audioEngine.paused)
    } catch (e) {
      if (epoch !== podcastPlayEpoch) return
      console.warn('Podcast', e)
      if (get().currentPodcastEpisodeId === episode.id) {
        set({ isPlaying: false, currentPodcastEpisodeId: null })
      }
      alert(`No se pudo reproducir «${episode.title}».`)
    }
  },

  // Biblioteca eliminada de este store → ver libraryPlayerStore.ts

  toggle: async () => {
    // Si suena O el UI cree que suena → pausar. Evita “play mudo” por desync.
    if (!audioEngine.paused || get().isPlaying) {
      get().pause()
      return
    }
    await get().play()
  },

  pause: () => {
    const { currentRadioId, radioPauseStartedAt, currentPodcastEpisodeId } = get()
    if (currentPodcastEpisodeId) {
      persistPodcastProgressNow(set, get)
    }
    pendingBackgroundPlay = false
    clearMediaPlayingHold()
    interruptionBurstToken += 1
    stopInterruptionResumeWatcher()
    audioEngine.markIntentionalPause(4000)
    audioEngine.pause()
    setMediaPlaybackState(false)
    refreshMediaPlaybackState(false)
    set({
      isPlaying: false,
      ...(currentRadioId && radioPauseStartedAt == null
        ? { radioPauseStartedAt: performance.now() }
        : {}),
    })
  },

  play: async () => {
    const {
      currentRadioId,
      currentPodcastEpisodeId,
      radioPauseStartedAt,
      radioDelay,
    } = get()
    audioEngine.applyPlaybackSession()

    // Ya suena: solo sincronizar UI / playbackState.
    if (!audioEngine.paused && (currentRadioId || currentPodcastEpisodeId)) {
      pendingBackgroundPlay = false
      stopInterruptionResumeWatcher()
      set({
        isPlaying: true,
        ...(currentRadioId ? { radioPauseStartedAt: null } : {}),
      })
      setMediaPlaybackState(true)
      refreshMediaPlaybackState(true)
      return
    }

    if (currentRadioId) {
      const station = getRadioStation(currentRadioId)
      if (!station) return

      // Tras pausa: sumar ese tiempo al retraso. No recargar (perdería el sync).
      if (radioPauseStartedAt != null) {
        const added = (performance.now() - radioPauseStartedAt) / 1000
        const next = roundRadioDelayMs(
          Math.min(audioEngine.maxRadioDelay, radioDelay + added),
        )
        audioEngine.setRadioDelay(next)
        set({ radioDelay: audioEngine.radioDelay, radioPauseStartedAt: null })
      }

      const src = audioEngine.element.getAttribute('src') || audioEngine.element.currentSrc
      if (!src || !audioEngine.isLive) {
        await get().playRadio(currentRadioId)
        return
      }

      audioEngine.applyPlaybackSession()
      // Radio en directo: play simple (hardResume/recargas provocan el bucle stop/play)
      let ok = await audioEngine.play()
      if (!ok || audioEngine.paused) {
        await new Promise((r) => window.setTimeout(r, 80))
        ok = await audioEngine.play()
      }
      // Si falla el play, NO resintonizar: playRadio vuelve al vivo y borra el retraso
      const playing = !audioEngine.paused
      set({ isPlaying: playing, radioPauseStartedAt: null })
      if (playing) setMediaPlaybackState(true)
      // Metadatos DESPUÉS del play: si van antes, CarPlay deja el botón en Play
      await bindMediaSession([])
      refreshMediaPlaybackState(playing)
      return
    }
    if (currentPodcastEpisodeId) {
      if (radioPauseStartedAt != null) set({ radioPauseStartedAt: null })
      audioEngine.applyPlaybackSession()
      const resumeAt =
        Number.isFinite(audioEngine.currentTime) && audioEngine.currentTime > 0
          ? audioEngine.currentTime
          : get().position

      // 1) Play inmediato sobre el mismo src (sin destruir el buffer)
      let ok = await audioEngine.playFromUserGesture()

      // 2) ensureAudible + play (primer plano)
      if (!ok || audioEngine.paused) {
        await audioEngine.ensureAudible()
        ok = await audioEngine.play()
      }
      if (!ok || audioEngine.paused) {
        await new Promise<void>((r) => window.setTimeout(r, 80))
        ok = await audioEngine.play()
      }
      // 3) hardResume solo en primer plano
      const visible =
        typeof document === 'undefined' || document.visibilityState === 'visible'
      if ((!ok || audioEngine.paused) && visible) {
        const src = audioEngine.element.getAttribute('src') || audioEngine.element.currentSrc
        if (src) ok = await audioEngine.hardResume(resumeAt)
      }
      // 4) Último recurso: recargar el episodio (solo visible)
      if ((!ok || audioEngine.paused) && visible) {
        const ep = getPodcastEpisode(currentPodcastEpisodeId)
        const show = ep ? getPodcastShow(ep.showId) : null
        if (ep && show) {
          const siblings = podcastEpisodeQueue
            .map((id) => getPodcastEpisode(id))
            .filter((e): e is PodcastEpisode => Boolean(e))
          await get().playPodcastEpisode(ep, show, siblings)
          return
        }
      }
      if (!ok || audioEngine.paused) {
        pendingBackgroundPlay = false
        clearMediaPlayingHold()
        set({ isPlaying: false })
        refreshMediaPlaybackState(false)
        return
      }
      pendingBackgroundPlay = false
      set({ isPlaying: true })
      setMediaPlaybackState(true)
      void bindMediaSession([])
      refreshMediaPlaybackState(true, { strong: true })
      return
    }
    if (radioPauseStartedAt != null) set({ radioPauseStartedAt: null })
    // Biblioteca: ver libraryPlayerStore (este store ya no reproduce pistas)
  },

  next: async (opts) => {
    const fromEnded = Boolean(opts?.fromEnded)
    void fromEnded
    if (get().currentRadioId) {
      const list = listMyRadios()
      if (!list.length) return
      const i = list.findIndex((s) => s.id === get().currentRadioId)
      const next = list[(i + 1) % list.length]
      if (next) await get().playRadio(next.id)
      return
    }
    if (get().currentPodcastEpisodeId && podcastEpisodeQueue.length) {
      const cur = get().currentPodcastEpisodeId!
      const i = podcastEpisodeQueue.indexOf(cur)
      const nextId = podcastEpisodeQueue[i + 1]
      if (!nextId) {
        pendingBackgroundPlay = false
        get().pause()
        return
      }
      const ep = getPodcastEpisode(nextId)
      const show = ep ? getPodcastShow(ep.showId) : null
      if (ep && show) {
        const siblings = podcastEpisodeQueue
          .map((id) => getPodcastEpisode(id))
          .filter((e): e is PodcastEpisode => Boolean(e))
        await get().playPodcastEpisode(ep, show, siblings)
      }
      return
    }
    // Biblioteca: libraryPlayerStore
  },

  previous: async () => {
    if (get().currentRadioId) {
      const list = listMyRadios()
      if (!list.length) return
      const i = list.findIndex((s) => s.id === get().currentRadioId)
      const prev = list[(i - 1 + list.length) % list.length]
      if (prev) await get().playRadio(prev.id)
      return
    }
    if (get().currentPodcastEpisodeId && podcastEpisodeQueue.length) {
      const { position } = get()
      if (position > 3) {
        audioEngine.seek(0)
        return
      }
      const cur = get().currentPodcastEpisodeId!
      const i = podcastEpisodeQueue.indexOf(cur)
      const prevId = podcastEpisodeQueue[i - 1]
      if (!prevId) {
        audioEngine.seek(0)
        return
      }
      const ep = getPodcastEpisode(prevId)
      const show = ep ? getPodcastShow(ep.showId) : null
      if (ep && show) {
        const siblings = podcastEpisodeQueue
          .map((id) => getPodcastEpisode(id))
          .filter((e): e is PodcastEpisode => Boolean(e))
        await get().playPodcastEpisode(ep, show, siblings)
      }
      return
    }
    // Biblioteca: libraryPlayerStore
  },

  seek: (time) => {
    if (get().currentRadioId || audioEngine.isLive) return
    audioEngine.seek(time)
    persistSoon({ position: time })
    if (get().currentPodcastEpisodeId) {
      persistPodcastProgressNow(set, get)
    }
  },

  skipForward: (seconds = 15) => {
    if (!get().currentPodcastEpisodeId) return
    if (get().currentRadioId || audioEngine.isLive) return
    const dur = Number.isFinite(audioEngine.duration)
      ? audioEngine.duration
      : get().duration
    const cur = audioEngine.currentTime
    const next = Math.min(
      Number.isFinite(dur) && dur > 0 ? dur : cur + seconds,
      cur + Math.max(1, seconds),
    )
    get().seek(next)
  },

  skipBack: (seconds = 15) => {
    if (!get().currentPodcastEpisodeId) return
    if (get().currentRadioId || audioEngine.isLive) return
    const cur = audioEngine.currentTime
    const next = Math.max(0, cur - Math.max(1, seconds))
    get().seek(next)
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

  setNowPlayingOpen: (open) => set({ nowPlayingOpen: open, ...(open ? {} : {}) }),
  setQueueOpen: (open) => set({ queueOpen: open }),

  getCurrentRadio: () => getRadioStation(get().currentRadioId),

  getCurrentPodcastEpisode: () => getPodcastEpisode(get().currentPodcastEpisodeId),

  getCurrentPodcastShow: () => {
    const ep = getPodcastEpisode(get().currentPodcastEpisodeId)
    return ep ? getPodcastShow(ep.showId) : null
  },

  setRadioDelay: (seconds) => {
    const rounded = roundRadioDelayMs(seconds)
    if (radioDelayTimer) {
      clearTimeout(radioDelayTimer)
      radioDelayTimer = null
    }
    // Solo “Sin retraso” (0) puede recargar el stream. Cualquier otro cambio
    // actualiza el valor / DelayNode sin volver al directo.
    const reset = rounded <= 0
    if (reset) {
      set({ radioDelay: 0, radioPauseStartedAt: null })
      audioEngine.setRadioDelay(0, { reload: true })
      set({ radioDelay: audioEngine.radioDelay, radioPauseStartedAt: null })
      return
    }
    // Si hay grafo Web Audio, afinar al instante. Si no, el audio real se
    // ajusta con pausa/play; aquí solo reflejamos el valor pedido.
    set({ radioDelay: rounded })
    audioEngine.setRadioDelay(rounded)
    set({ radioDelay: audioEngine.radioDelay })
  },
}))

export async function bindMediaSession(_tracks: Track[]) {
  if (isLibraryOwnsMediaSession()) return
  const state = usePlayerStore.getState()
  if (state.currentRadioId) {
    const station = getRadioStation(state.currentRadioId)
    if (station) {
      await updateRadioMediaSession(station, {
        play: () => handleRemotePlay(),
        pause: () => handleRemotePause(),
        previoustrack: () => void usePlayerStore.getState().previous(),
        nexttrack: () => void usePlayerStore.getState().next(),
      })
    }
    refreshMediaPlaybackState()
    return
  }
  if (state.currentPodcastEpisodeId) {
    const ep = getPodcastEpisode(state.currentPodcastEpisodeId)
    const show = ep ? getPodcastShow(ep.showId) : null
    if (ep && show) {
      await updateMediaSession(
        podcastSyntheticTrack(ep, show),
        ep.artworkUrl || show.artworkUrl || state.coverUrl || null,
        {
          play: () => handleRemotePlay(),
          pause: () => handleRemotePause(),
          previoustrack: () => void usePlayerStore.getState().previous(),
          nexttrack: () => void usePlayerStore.getState().next(),
          // Sin seekto: en iOS sustituye next/prev por ±10s
        },
        { playing: mediaIsEffectivelyPlaying() },
      )
    }
    refreshMediaPlaybackState()
    return
  }
  // Biblioteca: libraryPlayerStore publica su propia Media Session
}
