import { create } from 'zustand'
import { db, ensurePlaybackSnapshot, PLAYBACK_KEY } from '../db'
import { audioEngine } from '../lib/audioEngine'
import { getAudioObjectUrl, getCoverObjectUrl, recordPlay, getAudioBlobSources, getAudioBlob, revokeCachedUrls, ensureAudioMime, peekAudioObjectUrl } from '../lib/library'
import { deleteBinary } from '../lib/opfs'
import { setMediaPlaybackState, setMediaPositionState, shuffleArray, updateMediaSession, updateRadioMediaSession, refreshMediaPlaybackState, clearMediaPlaybackRefresh, claimNowPlaying, setPlaybackStateResolver, keepMediaSessionAlivePaused, reaffirmMediaSession, startSoftPauseSessionGuard, stopSoftPauseSessionGuard, setGhostPlayHandler } from '../lib/mediaSession'
import type { PlaybackSource, RepeatMode, Track } from '../types'
import { persistRecent } from './libraryStore'
import { getRadioStation, listMyRadios, type RadioStation } from '../lib/myRadios'
import { roundRadioDelayMs } from '../lib/radios'
import { isAppleMobile } from '../lib/folderImport'
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
import { logPlayback, PLAYBACK_DEBUG_BUILD } from '../lib/playbackDebug'

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
  playTrack: (trackId: string, queue?: string[]) => Promise<void>
  playTracks: (
    trackIds: string[],
    startId?: string,
    options?: { shuffle?: boolean; source?: PlaybackSource | null },
  ) => Promise<void>
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
  toggleShuffle: () => void
  cycleRepeat: () => void
  addToQueue: (trackId: string) => void
  playNext: (trackId: string) => void
  removeFromQueue: (queueIndex: number) => void
  clearQueue: () => void
  setNowPlayingOpen: (open: boolean) => void
  setQueueOpen: (open: boolean) => void
  syncFromEngine: () => void
  getCurrentTrack: (tracks: Track[]) => Track | null
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
let prefetchedNextId: string | null = null
/** Si el avance automático no pudo hacer play (bloqueo), reintentar al volver. */
let pendingBackgroundPlay = false
/**
 * Tras saltar de pista, forzar playbackState=playing un rato:
 * iOS/CarPlay pisa el botón a Play al cambiar metadata/posición.
 */
let mediaPlayingHoldUntil = 0
/** No llamar setPositionState justo tras el salto: en CarPlay resetea a Play. */
let suppressPositionUntil = 0
/** En iPhone biblioteca: limitar positionState para no resetear el botón en CarPlay. */
let lastLibraryPositionStateAt = 0
let lastLibraryPositionTrackId: string | null = null
let sessionPublishToken = 0
/** Tras llamada / interrupción del sistema: reintentar play y reclamar Now Playing. */
let interruptionResumeTimer: number | null = null
let interruptionResumeUntil = 0

function holdMediaPlaying(ms = 4500) {
  mediaPlayingHoldUntil = Math.max(mediaPlayingHoldUntil, Date.now() + ms)
}

/** Player.tsx: no pisar metadata mientras publicamos tras skip/CarPlay. */
export function shouldDeferAuxiliaryMediaSessionBind(): boolean {
  const now = Date.now()
  return now < trackAdvanceLockUntil || now < mediaPlayingHoldUntil
}

function clearMediaPlayingHold() {
  mediaPlayingHoldUntil = 0
}

function beginTrackChangeMediaGuard(ms = 6000) {
  holdMediaPlaying(ms)
  suppressPositionUntil = Math.max(suppressPositionUntil, Date.now() + Math.min(ms, 3000))
}

/**
 * Publica Now Playing SOLO cuando el <audio> ya no está en pause.
 * Si se publica antes, iOS/CarPlay deja el botón en Play aunque luego suene.
 */
async function publishPlayingMediaSession(trackId: string) {
  const token = ++sessionPublishToken
  beginTrackChangeMediaGuard(8000)
  setMediaPlaybackState(true)
  for (let i = 0; i < 40; i++) {
    if (token !== sessionPublishToken) return
    if (usePlayerStore.getState().currentTrackId !== trackId) return
    if (!audioEngine.paused) break
    await new Promise<void>((r) => window.setTimeout(r, 50))
  }
  if (token !== sessionPublishToken) return
  if (usePlayerStore.getState().currentTrackId !== trackId) return
  if (audioEngine.paused) {
    try {
      await audioEngine.play()
    } catch {
      /* ignore */
    }
  }

  // Portada lista ANTES del único write de metadata (si no, CarPlay muestra el logo)
  try {
    const coverUrl = await getCoverObjectUrl(trackId)
    if (token !== sessionPublishToken) return
    if (coverUrl && usePlayerStore.getState().currentTrackId === trackId) {
      usePlayerStore.setState({ coverUrl })
    }
  } catch {
    /* ignore */
  }

  if (token !== sessionPublishToken) return
  if (usePlayerStore.getState().currentTrackId !== trackId) return
  beginTrackChangeMediaGuard(8000)
  setMediaPlaybackState(true)
  await refreshMediaSessionForTrackId(trackId, true)
  // Reafirmar sin volver a escribir metadata
  for (const delay of [120, 400, 900, 1800, 3500]) {
    window.setTimeout(() => {
      if (token !== sessionPublishToken) return
      if (usePlayerStore.getState().currentTrackId !== trackId) return
      if (mediaIsEffectivelyPlaying()) setMediaPlaybackState(true)
    }, delay)
  }
}
/** Cola de episodios del show abierto (ids). */
let podcastEpisodeQueue: string[] = []
let podcastPlayEpoch = 0
let lastPodcastProgressSave = 0
let radioDelayTimer: number | null = null
let nearEndPollTimer: number | null = null
let lastNearEndTickAt = 0

function resolveNextLibraryTrack(state: {
  queue: string[]
  index: number
  currentTrackId: string | null
  repeat: RepeatMode
}): { trackId: string; nextIndex: number } | null {
  const { queue, repeat, currentTrackId } = state
  if (!queue.length) return null
  let index = state.index
  if (currentTrackId && queue[index] !== currentTrackId) {
    const found = queue.indexOf(currentTrackId)
    if (found >= 0) index = found
  }
  let nextIndex = index + 1
  if (nextIndex >= queue.length) {
    if (repeat === 'all') nextIndex = 0
    else return null
  }
  const trackId = queue[nextIndex]
  if (!trackId) return null
  return { trackId, nextIndex }
}

function prefetchNextForCurrent(
  get: () => PlayerState,
) {
  const { queue, index, currentTrackId, currentRadioId, currentPodcastEpisodeId, repeat } =
    get()
  if (currentRadioId || currentPodcastEpisodeId || !currentTrackId) return
  const nextId = queue[index + 1] ?? (repeat === 'all' ? queue[0] : null)
  if (!nextId || nextId === currentTrackId) return
  if (nextId === prefetchedNextId && peekAudioObjectUrl(nextId)) {
    audioEngine.prepareStandby(peekAudioObjectUrl(nextId)!, nextId)
    return
  }
  prefetchedNextId = nextId
  void getAudioObjectUrl(nextId).then((url) => {
    if (!url) return
    if (usePlayerStore.getState().currentTrackId !== currentTrackId) return
    audioEngine.prepareStandby(url, nextId)
  })
}

function   commitChainedTrack(
  set: (partial: Partial<PlayerState>) => void,
  get: () => PlayerState,
  trackId: string,
  nextIndex: number,
) {
  set({
    index: nextIndex,
    currentTrackId: trackId,
    currentRadioId: null,
    currentPodcastEpisodeId: null,
    isPlaying: true,
    position: 0,
  })
  persistSoon({ index: nextIndex, currentTrackId: trackId, position: 0 })
  pendingBackgroundPlay = true
  beginTrackChangeMediaGuard(8000)
  setMediaPlaybackState(true)
  refreshMediaPlaybackState(true, { strong: true })
  // NO publicar MediaSession aquí: el <audio> aún está en pause tras el cambio de src.
  // Esperar a que suene → una sola escritura de metadata.
  void publishPlayingMediaSession(trackId)
  void getCoverObjectUrl(trackId).then((coverUrl) => {
    if (usePlayerStore.getState().currentTrackId === trackId) {
      set({ coverUrl })
    }
  })
  void recordPlay(trackId)
  void persistRecent(trackId)
  prefetchNextForCurrent(get)
}

async function refreshMediaSessionForTrackId(trackId: string, forcePlaying = false) {
  const track = await db.tracks.get(trackId)
  if (!track || usePlayerStore.getState().currentTrackId !== trackId) return
  const cover = usePlayerStore.getState().coverUrl
  const wantPlaying = forcePlaying || mediaIsEffectivelyPlaying()
  await updateMediaSession(
    track,
    cover,
    {
      play: () => handleRemotePlay(),
      pause: () => handleRemotePause(),
      previoustrack: () => void usePlayerStore.getState().previous(),
      nexttrack: () => void usePlayerStore.getState().next(),
      seekto: (time) => usePlayerStore.getState().seek(time),
      getPosition: () => usePlayerStore.getState().position,
      seekSkip: false,
    },
    { playing: wantPlaying },
  )
  if (wantPlaying) refreshMediaPlaybackState(true, { strong: true })
  else refreshMediaPlaybackState(wantPlaying)
}

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

/**
 * Play remoto (CarPlay / bloqueo / AirPods).
 *
 * Importante: en iOS NO lanzar dos audio.play() a la vez (current + fresh).
 * El log del usuario: 1º ok-fresh, 2º FAIL cur=false fresh=false → AbortError mutuo.
 * Una sola estrategia por gesto.
 */
/** Evita dos handleRemotePlay en el mismo gesto (ghost + ms-play). */
let remotePlayCoalesceUntil = 0

function settlePlayPromise(p: Promise<boolean>, ms = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    const finish = (v: boolean) => {
      if (done) return
      done = true
      resolve(v)
    }
    void p.then((v) => finish(Boolean(v))).catch(() => finish(false))
    window.setTimeout(() => {
      finish(!audioEngine.paused)
    }, ms)
  })
}

/** Solo en primer plano: tras fallo, permitir reload src en el siguiente play. */
let preferReloadRemotePlayUntil = 0

function handleRemotePlay() {
  const now = Date.now()
  if (now < remotePlayCoalesceUntil) {
    logPlayback('remote-play-skipped', { detail: 'coalesce' })
    return
  }
  remotePlayCoalesceUntil = now + 500

  const state = usePlayerStore.getState()
  if (!state.currentTrackId && !state.currentRadioId && !state.currentPodcastEpisodeId) {
    logPlayback('remote-play-empty')
    return
  }

  stopInterruptionResumeWatcher()
  clearMediaPlaybackRefresh()
  stopSoftPauseSessionGuard()

  if (!audioEngine.paused && !audioEngine.isSuspendedForUi) {
    let msState = 'unknown'
    try {
      msState = navigator.mediaSession.playbackState
    } catch {
      /* ignore */
    }
    logPlayback('remote-play-sync', {
      isPlaying: state.isPlaying,
      detail: `ms=${msState} elPaused=false`,
    })
    pendingBackgroundPlay = false
    holdMediaPlaying(8000)
    usePlayerStore.setState({ isPlaying: true })
    void bindMediaSession([])
      .then(() => {
        claimNowPlaying(true, { reclaim: true })
      })
      .catch(() => {
        claimNowPlaying(true, { reclaim: true })
      })
    setMediaPlaybackState(true)
    reaffirmMediaSession({ playing: true })
    return
  }

  const snap0 = audioEngine.debugSnapshot()
  const isPodcast = Boolean(state.currentPodcastEpisodeId)
  const ep = isPodcast ? getPodcastEpisode(state.currentPodcastEpisodeId!) : null
  const elementPaused = audioEngine.element.paused

  const resumeAt =
    state.position > 0.25
      ? state.position
      : Number.isFinite(audioEngine.currentTime)
        ? audioEngine.currentTime
        : 0

  const mediaUrl =
    (isPodcast && ep?.audioUrl) ||
    (!isPodcast && !state.currentRadioId
      ? peekAudioObjectUrl(state.currentTrackId || '') || audioEngine.mediaUrl
      : null) ||
    null

  const visible =
    typeof document === 'undefined' || document.visibilityState === 'visible'

  // CarPlay / bloqueo: reload src destruye el buffer (ready 4→1) y play() falla.
  // Solo reload con la PWA visible; si no, play() sobre el mismo src en el gesto.
  const useReload =
    visible &&
    Boolean(mediaUrl) &&
    !state.currentRadioId &&
    elementPaused &&
    (audioEngine.element.readyState < 3 || Date.now() < preferReloadRemotePlayUntil)

  const strategy: 'inplace' | 'reload' = useReload && mediaUrl ? 'reload' : 'inplace'

  logPlayback('remote-play', {
    paused: snap0.paused,
    muted: snap0.muted,
    rate: snap0.rate,
    suspended: snap0.suspended,
    isPlaying: state.isPlaying,
    podcast: isPodcast,
    detail: `build=${PLAYBACK_DEBUG_BUILD} visible=${visible} strategy=${strategy} elPaused=${snap0.elementPaused} ready=${snap0.readyState} graph=${snap0.hasGraph} vol=${snap0.volume}`,
  })

  audioEngine.forceAudibleOutput()

  let kicked: Promise<boolean>
  if (strategy === 'reload' && mediaUrl) {
    kicked = audioEngine.reloadInPlaceFromGesture(mediaUrl, resumeAt)
  } else if (audioEngine.isSuspendedForUi) {
    kicked = audioEngine.resumeFromUiGesture()
  } else {
    kicked = audioEngine.playFromUserGesture(resumeAt)
  }

  try {
    requestAnimationFrame(() => {
      audioEngine.forceAudibleOutput()
      const s = audioEngine.debugSnapshot()
      logPlayback('remote-play-raf', {
        paused: s.paused,
        muted: s.muted,
        rate: s.rate,
        suspended: s.suspended,
        podcast: isPodcast,
        detail: `strategy=${strategy} elPaused=${s.elementPaused} vol=${s.volume} err=${s.playErr ?? '-'}`,
      })
    })
  } catch {
    /* ignore */
  }

  void (async () => {
    const ok = await settlePlayPromise(kicked, 2000)
    audioEngine.forceAudibleOutput()
    audioEngine.applyPlaybackSession()
    let playing = ok && !audioEngine.paused
    const snap1 = audioEngine.debugSnapshot()
    if (playing && (snap1.muted || snap1.volume === 0)) {
      audioEngine.forceAudibleOutput()
    }

    if (!playing) {
      if (visible) preferReloadRemotePlayUntil = Date.now() + 30000
      pendingBackgroundPlay = true
      logPlayback('remote-play-fail', {
        paused: snap1.paused,
        isPlaying: false,
        detail: `build=${PLAYBACK_DEBUG_BUILD} visible=${visible} strategy=${strategy} ready=${snap1.readyState} err=${snap1.playErr ?? '-'}`,
      })
    } else {
      preferReloadRemotePlayUntil = 0
    }

    logPlayback('remote-play-result', {
      paused: snap1.paused,
      muted: snap1.muted,
      rate: snap1.rate,
      suspended: snap1.suspended,
      isPlaying: playing,
      podcast: isPodcast,
      detail: playing
        ? `ok-${strategy}`
        : `FAIL strategy=${strategy} elPaused=${snap1.elementPaused} err=${snap1.playErr ?? '-'} ready=${snap1.readyState}`,
    })

    // Medir avance + nivel de audio DESPUÉS del promote (fresh)
    const t0 = audioEngine.currentTime

    if (playing) {
      void (async () => {
        const probe = await audioEngine.probeOutput(t0, 700)
        const s = audioEngine.debugSnapshot()
        logPlayback('remote-play-clock', {
          paused: s.paused,
          muted: probe.muted,
          isPlaying: !s.paused,
          podcast: isPodcast,
          audible: probe.sounds,
          detail: `advancing=${probe.advancing} dt=${probe.dt.toFixed(2)} peak=${probe.peak.toFixed(3)} rms=${probe.rms.toFixed(3)} sounds=${probe.sounds} why=${probe.reason} meter=${probe.meter} vol=${probe.volume.toFixed(2)}`,
        })

        const dead =
          !probe.advancing ||
          probe.sounds === 'no' ||
          probe.reason === 'stalled'

        if (dead) {
          preferReloadRemotePlayUntil = Date.now() + 60000
          logPlayback('remote-play-stalled', {
            paused: s.paused,
            podcast: isPodcast,
            audible: probe.sounds,
            detail: `strategy=${strategy} why=${probe.reason} dt=${probe.dt.toFixed(2)} peak=${probe.peak.toFixed(3)}`,
          })
          pendingBackgroundPlay = false
          usePlayerStore.setState({ isPlaying: false })
          keepMediaSessionAlivePaused()
          startSoftPauseSessionGuard()
          refreshMediaPlaybackState(false)
          return
        }
        if (!audioEngine.paused) {
          audioEngine.applyPlaybackSession()
          audioEngine.forceAudibleOutput()
        }
      })()
    }

    pendingBackgroundPlay = playing
    usePlayerStore.setState({ isPlaying: playing })
    if (!playing) {
      clearMediaPlayingHold()
      keepMediaSessionAlivePaused()
      startSoftPauseSessionGuard()
      refreshMediaPlaybackState(false)
      return
    }
    stopSoftPauseSessionGuard()
    reaffirmMediaSession({ playing: true })
    refreshMediaPlaybackState(true, { strong: true })
  })()
}

function handleRemotePause() {
  // Pause real: el soft-pause en biblioteca empeora el icono y puede abrir Podcasts.
  audioEngine.markIntentionalPause(4000)
  interruptionBurstToken += 1
  stopInterruptionResumeWatcher()
  pendingBackgroundPlay = false
  clearMediaPlayingHold()
  clearMediaPlaybackRefresh()
  stopSoftPauseSessionGuard()

  const state = usePlayerStore.getState()
  const snap = audioEngine.debugSnapshot()
  logPlayback('remote-pause', {
    paused: snap.paused,
    muted: snap.muted,
    rate: snap.rate,
    suspended: snap.suspended,
    isPlaying: state.isPlaying,
    podcast: Boolean(state.currentPodcastEpisodeId),
    detail: `elPaused=${snap.elementPaused}`,
  })

  if (state.currentPodcastEpisodeId) {
    persistPodcastProgressNow(usePlayerStore.setState, usePlayerStore.getState)
  }

  audioEngine.pause()

  usePlayerStore.setState({
    isPlaying: false,
    ...(state.currentRadioId && state.radioPauseStartedAt == null
      ? { radioPauseStartedAt: performance.now() }
      : {}),
  })
  // Mantener ficha Now Playing (sin soft-audio)
  claimNowPlaying(false, { reclaim: true })
  keepMediaSessionAlivePaused()
  startSoftPauseSessionGuard()

  const snap2 = audioEngine.debugSnapshot()
  logPlayback('remote-pause-done', {
    paused: snap2.paused,
    muted: snap2.muted,
    rate: snap2.rate,
    suspended: snap2.suspended,
    isPlaying: false,
    podcast: Boolean(state.currentPodcastEpisodeId),
    detail: `soft=false elPaused=${snap2.elementPaused}`,
  })
}

/**
 * Avanza de pista. `early` = aún suena la actual (pantalla apagada).
 * Devuelve true si reclamó el avance (éxito o fallback async).
 */
function tryAdvanceLibraryTrack(
  set: (partial: Partial<PlayerState>) => void,
  get: () => PlayerState,
  mode: 'early' | 'ended' | 'watchdog',
): boolean {
  if (Date.now() < trackAdvanceLockUntil) return false
  if (get().currentRadioId || audioEngine.isLive) return false
  if (get().currentPodcastEpisodeId) return false

  const resolved = resolveNextLibraryTrack(get())
  if (!resolved) {
    if (mode === 'ended') {
      pendingBackgroundPlay = false
      trackAdvanceLockUntil = Date.now() + 800
      get().pause()
      audioEngine.seek(0)
      return true
    }
    return false
  }

  const { trackId, nextIndex } = resolved
  const url = peekAudioObjectUrl(trackId)
  if (!url) {
    void getAudioObjectUrl(trackId).then((u) => {
      if (u) audioEngine.prepareStandby(u, trackId)
    })
    if (mode === 'ended' || mode === 'watchdog') {
      trackAdvanceLockUntil = Date.now() + 1200
      void get().next({ fromEnded: true })
      return true
    }
    return false
  }

  audioEngine.prepareStandby(url, trackId)
  trackAdvanceLockUntil = Date.now() + 2000
  prefetchedNextId = null

  // SIEMPRE mismo <audio>: overlapPromote cambia de elemento y iOS quita Now Playing
  const ok = audioEngine.chainPlay(url)
  if (!ok) {
    trackAdvanceLockUntil = Date.now() + 400
    if (mode !== 'early') {
      void get().next({ fromEnded: true })
      return true
    }
    return false
  }

  commitChainedTrack(set, get, trackId, nextIndex)

  window.setTimeout(() => {
    if (usePlayerStore.getState().currentTrackId !== trackId) return
    if (!audioEngine.paused) {
      beginTrackChangeMediaGuard(4000)
      prefetchNextForCurrent(get)
      setMediaPlaybackState(true)
      return
    }
    pendingBackgroundPlay = true
    beginTrackChangeMediaGuard(5000)
    set({ isPlaying: true })
    void loadAndMaybePlay(trackId, 0, true, set)
  }, 90)

  return true
}

function tickNearEndAdvance(
  set: (partial: Partial<PlayerState>) => void,
  get: () => PlayerState,
) {
  if (get().currentRadioId || get().currentPodcastEpisodeId || audioEngine.isLive) return
  if (!get().currentTrackId) return

  const duration = audioEngine.duration
  const position = audioEngine.currentTime
  if (!(duration > 8) || !(position > 0)) return

  const remaining = duration - position
  if (remaining > 20) return

  prefetchNextForCurrent(get)

  // Pantalla apagada: el proceso congela el JS al llegar al ended.
  // Avanzar MIENTRAS aún suena. Si los ticks van lentos (= pantalla off),
  // usar ventana más amplia; si van fluidos, cortar solo ~0.4 s del final.
  if (audioEngine.paused) return
  const now = Date.now()
  const gap = lastNearEndTickAt ? now - lastNearEndTickAt : 0
  lastNearEndTickAt = now
  const threshold = gap > 700 ? 1.55 : 0.45
  if (remaining <= threshold && remaining >= 0) {
    tryAdvanceLibraryTrack(set, get, 'early')
  }
}

function startNearEndPoller(
  set: (partial: Partial<PlayerState>) => void,
  get: () => PlayerState,
) {
  if (nearEndPollTimer != null) return
  nearEndPollTimer = window.setInterval(() => tickNearEndAdvance(set, get), 300)
}

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
    // Reclamar Now Playing para que CarPlay no se vaya a Spotify/Podcasts
    audioEngine.applyPlaybackSession()
    if (!audioEngine.paused) {
      pendingBackgroundPlay = false
      stopInterruptionResumeWatcher()
      refreshMediaPlaybackState(true)
      return
    }
    // Durante la llamada play() falla siempre: solo pelear el Now Playing
    if (audioEngine.isSystemInterrupted) {
      claimNowPlaying(true, { reclaim: true })
      return
    }
    void state.play().then(() => {
      if (!audioEngine.paused) refreshMediaPlaybackState(true)
      else claimNowPlaying(true, { reclaim: true })
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
    await bindMediaSession([])
    claimNowPlaying(true, { reclaim: true })
    await state.play()

    if (!audioEngine.paused) {
      pendingBackgroundPlay = false
      stopInterruptionResumeWatcher()
      refreshMediaPlaybackState(true)
      return
    }
    // Aunque aún no suene, seguir ocupando el slot de CarPlay frente a Spotify
    claimNowPlaying(true, { reclaim: true })
  }
}

/** Reanudar tras llamada / volver al coche / desbloquear. */
export function resumeAfterInterruption() {
  const state = usePlayerStore.getState()
  if (!state.currentTrackId && !state.currentRadioId && !state.currentPodcastEpisodeId) {
    return
  }
  audioEngine.applyPlaybackSession()
  const wantPlaying = pendingBackgroundPlay || state.isPlaying
  void bindMediaSession([]).then(() =>
    claimNowPlaying(wantPlaying, { reclaim: Boolean(pendingBackgroundPlay) }),
  )

  // Si venimos de una llamada, forzar ola de reintentos (CarPlay no abre la PWA)
  if (pendingBackgroundPlay || (state.isPlaying && audioEngine.paused)) {
    pendingBackgroundPlay = true
    claimNowPlaying(true, { reclaim: true })
    void burstResumeAfterCall()
    startInterruptionResumeWatcher()
    return
  }
  if (state.isPlaying) {
    if (audioEngine.paused) {
      void audioEngine.ensureAudible()
      void audioEngine.play()
    } else {
      refreshMediaPlaybackState(true)
    }
    return
  }
  // Seguir apareciendo en Now Playing aunque estemos en pause (evita que gane Podcasts)
  void bindMediaSession([])
  setMediaPlaybackState(false)
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
    savePodcastProgress(id, position, duration)
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

function normalizePlaybackSource(raw: unknown): PlaybackSource | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Record<string, unknown>
  if (s.kind === 'liked' && typeof s.title === 'string' && s.title.trim()) {
    return { kind: 'liked', title: s.title.trim() }
  }
  if (
    s.kind === 'playlist' &&
    typeof s.id === 'string' &&
    s.id &&
    typeof s.title === 'string' &&
    s.title.trim()
  ) {
    return { kind: 'playlist', id: s.id, title: s.title.trim() }
  }
  return null
}

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

async function loadAndMaybePlay(
  trackId: string,
  resumeAt: number,
  shouldPlay: boolean,
  set: (partial: Partial<PlayerState>) => void,
) {
  let url = await getAudioObjectUrl(trackId)
  if (!url) {
    try {
      await db.tracks.update(trackId, { hasLocalAudio: false })
    } catch {
      // ignore
    }
    return false
  }

  // Portada en paralelo: no retrasar el audio (crítico al pasar de pista en bloqueo)
  set({ currentTrackId: trackId, currentRadioId: null, currentPodcastEpisodeId: null })
  void getCoverObjectUrl(trackId).then((coverUrl) => {
    if (usePlayerStore.getState().currentTrackId === trackId) {
      set({ coverUrl })
    }
  })

  try {
    await audioEngine.loadObjectUrl(url, resumeAt)
  } catch {
    const retried = await retryAlternateAudioSource(trackId, resumeAt)
    if (!retried) return false
  }

  if (shouldPlay) {
    audioEngine.applyPlaybackSession()
    let ok = await audioEngine.play()
    if ((!ok || audioEngine.paused) && !audioEngine.element.error) {
      // Reintento corto (AbortError / carrera al cambiar src)
      await new Promise((r) => window.setTimeout(r, 40))
      ok = await audioEngine.play()
    }
    // En primer plano: más reintentos (el auto-next no tiene gesto)
    if ((!ok || audioEngine.paused) && !audioEngine.element.error) {
      const visible =
        typeof document === 'undefined' || document.visibilityState === 'visible'
      if (visible) {
        for (let i = 0; i < 4 && (audioEngine.paused || !ok); i++) {
          await new Promise((r) => window.setTimeout(r, 80 + i * 60))
          ok = await audioEngine.play()
        }
      }
    }
    if (audioEngine.element.error || audioEngine.paused) {
      if (audioEngine.element.error) {
        const alt = await retryAlternateAudioSource(trackId, resumeAt)
        if (alt) ok = await audioEngine.play()
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
        pendingBackgroundPlay = false
        return false
      }

      if (audioEngine.paused) {
        // En bloqueo el play del siguiente track a veces falla: marcar reintento
        pendingBackgroundPlay = true
        beginTrackChangeMediaGuard(8000)
        set({ isPlaying: true })
        void publishPlayingMediaSession(trackId)
        return true
      }
    }
    pendingBackgroundPlay = false
    const playing = !audioEngine.paused
    set({ isPlaying: playing })
    if (playing) {
      await recordPlay(trackId)
      await persistRecent(trackId)
      prefetchNextForCurrent(usePlayerStore.getState)
      void publishPlayingMediaSession(trackId)
    } else {
      refreshMediaPlaybackState(false)
    }
  } else {
    pendingBackgroundPlay = false
    set({ isPlaying: false })
    refreshMediaPlaybackState(false)
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
    await audioEngine.loadObjectUrl(stable, resumeAt)
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
    setPlaybackStateResolver(() => mediaIsEffectivelyPlaying())
    setGhostPlayHandler(() => handleRemotePlay())
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

    set({
      queue,
      originalQueue,
      index,
      currentTrackId,
      // Restaurar aleatorio; si no había valor guardado, ON
      shuffle: snap.shuffle !== false,
      // Migrar estado antiguo 'one' → 'all'
      repeat: snap.repeat === 'all' || (snap.repeat as string) === 'one' ? 'all' : 'off',
      position: snap.position,
      volume: snap.volume,
      playbackSource: currentTrackId
        ? normalizePlaybackSource(snap.playbackSource)
        : null,
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
          persistPodcastProgressNow(set, get, true)
          trackAdvanceLockUntil = Date.now() + 800
          void get().next({ fromEnded: true })
          return
        }

        // Si el poller early ya avanzó, ignorar
        if (Date.now() < trackAdvanceLockUntil) return
        tryAdvanceLibraryTrack(set, get, 'ended')
      })
    }

    if (!interruptionUnsub) {
      interruptionUnsub = audioEngine.onInterruption(() => {
        // Durante auto-next el cambio de src dispara pause: no es una llamada
        if (Date.now() < trackAdvanceLockUntil) return
        // Llamada / Siri / otra app: no marcar pause de usuario
        if (!get().currentTrackId && !get().currentRadioId && !get().currentPodcastEpisodeId) {
          return
        }
        // Si ya estábamos en pause intencional, isPlaying es false y no hay pending
        if (!get().isPlaying && !pendingBackgroundPlay) return

        pendingBackgroundPlay = true
        set({ isPlaying: true })
        // Mantener metadatos en Now Playing (si se pierden, CarPlay salta a Spotify)
        audioEngine.applyPlaybackSession()
        void bindMediaSession([]).then(() => {
          // Durante la llamada el audio está pausado, pero hay que seguir
          // reclamando el slot "playing" para no ceder CarPlay a Spotify.
          claimNowPlaying(true, { reclaim: true })
        })
        startInterruptionResumeWatcher()
      })
    }

    if (!interruptionEndUnsub) {
      interruptionEndUnsub = audioEngine.onInterruptionEnd(() => {
        if (!get().currentTrackId && !get().currentRadioId && !get().currentPodcastEpisodeId) {
          return
        }
        // Colgar / iOS suelta el audio: reanudar sin abrir el móvil
        pendingBackgroundPlay = true
        set({ isPlaying: true })
        audioEngine.applyPlaybackSession()
        void bindMediaSession([]).then(() => claimNowPlaying(true, { reclaim: true }))
        void burstResumeAfterCall()
        startInterruptionResumeWatcher()
      })
    }

    if (currentTrackId && queue.length) {
      // Restaura la pista y la posición; no autoplay (política del navegador)
      await loadAndMaybePlay(currentTrackId, snap.position || 0, false, set)
    }
  },

  syncFromEngine: () => {
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
    const currentTrackId = get().currentTrackId
    const libraryTrackOnApple =
      Boolean(currentTrackId) &&
      !get().currentRadioId &&
      !get().currentPodcastEpisodeId &&
      isAppleMobile()
    set({
      position,
      duration: Number.isFinite(duration) ? duration : 0,
      isPlaying: effectivePlaying,
      volume: audioEngine.volume,
      muted: audioEngine.muted,
    })
    // Tras salto de pista, setPositionState en CarPlay vuelve a poner Play
    if (libraryTrackOnApple) {
      const now = Date.now()
      const trackChanged = currentTrackId !== lastLibraryPositionTrackId
      const shouldPushPosition =
        trackChanged ||
        !effectivePlaying ||
        now - lastLibraryPositionStateAt >= 12000 ||
        position < 1
      if (shouldPushPosition) {
        setMediaPositionState(position, duration, effectivePlaying)
        lastLibraryPositionStateAt = now
        lastLibraryPositionTrackId = currentTrackId
      }
      if (effectivePlaying) setMediaPlaybackState(true)
    } else if (Date.now() < suppressPositionUntil) {
      if (effectivePlaying) setMediaPlaybackState(true)
    } else {
      setMediaPositionState(position, duration, effectivePlaying)
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

    if (playing && get().currentTrackId && !get().currentRadioId) {
      startNearEndPoller(set, get)
      tickNearEndAdvance(set, get)
    } else {
      stopNearEndPoller()
    }

    // Watchdog: elemento en `ended` sin haber avanzado
    if (
      audioEngine.element.ended &&
      !get().currentRadioId &&
      !audioEngine.isLive &&
      !get().currentPodcastEpisodeId &&
      get().currentTrackId
    ) {
      tryAdvanceLibraryTrack(set, get, 'watchdog')
    }
  },

  getCurrentTrack: (tracks) => {
    const id = get().currentTrackId
    if (!id) return null
    return tracks.find((t) => t.id === id) ?? null
  },

  playRadio: async (stationId) => {
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
          seekto: (time) => usePlayerStore.getState().seek(time),
          getPosition: () => usePlayerStore.getState().position,
          seekSkip: true,
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

  playTrack: async (trackId, queue) => {
    audioEngine.clearStandby()
    prefetchedNextId = null
    const q = queue ?? get().queue
    let nextQueue = q.includes(trackId) ? [...q] : [...q, trackId]
    let index = Math.max(0, nextQueue.indexOf(trackId))
    const originalQueue = [...nextQueue]
    const shuffleOn = get().shuffle !== false
    if (shuffleOn) {
      // Mantener la canción elegida la primera; el resto aleatorio
      nextQueue = shuffleArray(nextQueue, index >= 0 ? index : undefined)
      index = 0
    }
    set({
      queue: nextQueue,
      originalQueue,
      index,
      shuffle: shuffleOn,
      playbackSource: null,
    })
    persistSoon({
      queue: nextQueue,
      originalQueue,
      index,
      currentTrackId: nextQueue[index] ?? trackId,
      shuffle: shuffleOn,
      position: 0,
      playbackSource: null,
    })
    const playId = nextQueue[index] ?? trackId
    const ok = await loadAndMaybePlay(playId, 0, true, set)
    if (!ok) {
      for (let i = index + 1; i < nextQueue.length; i++) {
        const nextId = nextQueue[i]!
        set({ index: i, currentTrackId: nextId })
        if (await loadAndMaybePlay(nextId, 0, true, set)) return
      }
    }
  },

  playTracks: async (trackIds, startId, options) => {
    if (!trackIds.length) return
    audioEngine.clearStandby()
    prefetchedNextId = null
    const forceShuffle = options?.shuffle
    const source =
      options && 'source' in options ? (options.source ?? null) : null
    const shuffleOn =
      forceShuffle === true
        ? true
        : forceShuffle === false
          ? false
          : get().shuffle !== false
    let queue = [...trackIds]
    let index = startId ? Math.max(0, queue.indexOf(startId)) : 0
    if (index < 0) index = 0
    const originalQueue = [...queue]
    if (shuffleOn) {
      // Play general (sin canción concreta): mezcla TODO, incluida la primera.
      // Si el usuario eligió una pista, esa queda la primera.
      const stay = startId ? index : undefined
      queue = shuffleArray(queue, stay)
      index = 0
    }
    set({
      queue,
      originalQueue,
      index,
      currentTrackId: queue[index] ?? null,
      shuffle: shuffleOn,
      playbackSource: source,
    })
    persistSoon({
      queue,
      originalQueue,
      index,
      currentTrackId: queue[index] ?? null,
      shuffle: shuffleOn,
      position: 0,
      playbackSource: source,
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
    clearMediaPlaybackRefresh()
    audioEngine.markIntentionalPause(4000)
    // Pause real siempre: soft-pause en iOS evita que Media Session dispare play
    stopSoftPauseSessionGuard()
    audioEngine.pause()
    setMediaPlaybackState(false)
    refreshMediaPlaybackState(false)
    keepMediaSessionAlivePaused()
    startSoftPauseSessionGuard()
    set({
      isPlaying: false,
      ...(currentRadioId && radioPauseStartedAt == null
        ? { radioPauseStartedAt: performance.now() }
        : {}),
    })
  },

  play: async () => {
    clearMediaPlaybackRefresh()
    stopSoftPauseSessionGuard()
    const {
      currentTrackId,
      currentRadioId,
      currentPodcastEpisodeId,
      queue,
      index,
      radioPauseStartedAt,
      radioDelay,
    } = get()
    audioEngine.applyPlaybackSession()

    // Ya suena: solo sincronizar CarPlay. hardResume aquí cortocircuita el audio.
    if (!audioEngine.paused && (currentTrackId || currentRadioId || currentPodcastEpisodeId)) {
      pendingBackgroundPlay = false
      stopInterruptionResumeWatcher()
      set({
        isPlaying: true,
        ...(currentRadioId ? { radioPauseStartedAt: null } : {}),
      })
      refreshMediaPlaybackState(true, { strong: true })
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
      clearMediaPlaybackRefresh()
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
    if (!currentTrackId && queue.length) {
      await loadAndMaybePlay(queue[index] ?? queue[0], 0, true, set)
      return
    }
    if (!currentTrackId) return
    audioEngine.applyPlaybackSession()
    await audioEngine.ensureAudible()
    const resumeAt =
      Number.isFinite(audioEngine.currentTime) && audioEngine.currentTime > 0
        ? audioEngine.currentTime
        : get().position

    // Solo play suave. hardResume/recarga de src desde CarPlay deja el motor roto.
    let ok = await audioEngine.play()
    if (!ok || audioEngine.paused) {
      await new Promise<void>((r) => window.setTimeout(r, 100))
      ok = await audioEngine.play()
    }
    // hardResume solo en primer plano (gesto en la app), nunca con pantalla bloqueada
    const visible =
      typeof document === 'undefined' || document.visibilityState === 'visible'
    if ((!ok || audioEngine.paused) && visible) {
      ok = await audioEngine.hardResume(resumeAt)
    }
    if (!ok || audioEngine.paused) {
      if (visible) {
        await loadAndMaybePlay(currentTrackId, resumeAt, true, set)
      } else {
        pendingBackgroundPlay = true
        beginTrackChangeMediaGuard(5000)
        set({ isPlaying: true })
        setMediaPlaybackState(true)
        refreshMediaPlaybackState(true, { strong: true })
      }
      return
    }
    set({ isPlaying: true })
    setMediaPlaybackState(true)
    await bindMediaSession([])
    refreshMediaPlaybackState(true, { strong: true })
  },

  next: async (opts) => {
    const fromEnded = Boolean(opts?.fromEnded)
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
    const { queue, index, repeat, currentTrackId } = get()
    if (!queue.length) return

    const resolved = resolveNextLibraryTrack({ queue, index, currentTrackId, repeat })
    if (!resolved) {
      pendingBackgroundPlay = false
      get().pause()
      audioEngine.seek(0)
      return
    }
    const { trackId, nextIndex } = resolved
    trackAdvanceLockUntil = Date.now() + 1200
    prefetchedNextId = null
    if (!fromEnded) audioEngine.clearStandby()

    // Tras ended: mismo <audio>, src + play síncrono
    if (fromEnded) {
      let url = peekAudioObjectUrl(trackId)
      if (!url) {
        url = await Promise.race([
          getAudioObjectUrl(trackId),
          new Promise<null>((r) => window.setTimeout(() => r(null), 80)),
        ])
      }
      if (url && audioEngine.chainPlay(url)) {
        commitChainedTrack(set, get, trackId, nextIndex)
        window.setTimeout(() => {
          if (usePlayerStore.getState().currentTrackId !== trackId) return
          if (!audioEngine.paused) {
            beginTrackChangeMediaGuard(4000)
            setMediaPlaybackState(true)
            return
          }
          pendingBackgroundPlay = true
          beginTrackChangeMediaGuard(5000)
          void loadAndMaybePlay(trackId, 0, true, set)
        }, 80)
        return
      }
    }

    set({
      index: nextIndex,
      currentTrackId: trackId,
      currentRadioId: null,
      currentPodcastEpisodeId: null,
    })
    persistSoon({ index: nextIndex, currentTrackId: trackId, position: 0 })
    void getCoverObjectUrl(trackId).then((coverUrl) => {
      if (usePlayerStore.getState().currentTrackId === trackId) {
        set({ coverUrl })
      }
    })

    pendingBackgroundPlay = true
    beginTrackChangeMediaGuard(8000)
    setMediaPlaybackState(true)
    refreshMediaPlaybackState(true, { strong: true })
    const ok = await loadAndMaybePlay(trackId, 0, true, set)
    if (ok) {
      prefetchNextForCurrent(get)
      return
    }
    // Evitar quedarse en silencio en una pista rota
    for (let i = nextIndex + 1; i < queue.length; i++) {
      const id = queue[i]!
      set({ index: i, currentTrackId: id })
      if (await loadAndMaybePlay(id, 0, true, set)) {
        prefetchNextForCurrent(get)
        return
      }
    }
    if (repeat === 'all') {
      for (let i = 0; i < nextIndex; i++) {
        const id = queue[i]!
        set({ index: i, currentTrackId: id })
        if (await loadAndMaybePlay(id, 0, true, set)) {
          prefetchNextForCurrent(get)
          return
        }
      }
    }
  },

  previous: async () => {
    audioEngine.clearStandby()
    prefetchedNextId = null
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
    pendingBackgroundPlay = true
    beginTrackChangeMediaGuard(8000)
    await loadAndMaybePlay(trackId, 0, true, set)
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

  toggleShuffle: () => {
    const { shuffle, queue, originalQueue, currentTrackId } = get()
    if (!shuffle) {
      const base = originalQueue.length ? originalQueue : queue
      const currentIndex = currentTrackId ? base.indexOf(currentTrackId) : -1
      const shuffled = shuffleArray(
        base,
        currentIndex >= 0 ? currentIndex : undefined,
      )
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
      set({
        shuffle: false,
        queue: base,
        index: idx,
      })
      persistSoon({
        shuffle: false,
        queue: base,
        originalQueue: base,
        index: idx,
      })
    }
  },

  cycleRepeat: () => {
    const next: RepeatMode = get().repeat === 'off' ? 'all' : 'off'
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
    const { queue, index, currentTrackId, shuffle, originalQueue } = get()
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
      if (newId) void loadAndMaybePlay(newId, 0, get().isPlaying, set)
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
    get().pause()
    podcastEpisodeQueue = []
    set({
      queue: [],
      originalQueue: [],
      index: 0,
      currentTrackId: null,
      currentRadioId: null,
      currentPodcastEpisodeId: null,
      coverUrl: null,
    })
    persistSoon({
      queue: [],
      originalQueue: [],
      index: 0,
      currentTrackId: null,
      position: 0,
    })
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

export async function bindMediaSession(tracks: Track[]) {
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
          seekto: (time) => usePlayerStore.getState().seek(time),
          getPosition: () => usePlayerStore.getState().position,
          seekSkip: true,
        },
        { playing: mediaIsEffectivelyPlaying() },
      )
    }
    refreshMediaPlaybackState()
    return
  }
  let track = tracks.find((t) => t.id === state.currentTrackId) ?? null
  // Reclamar Now Playing tras llamada sin depender del array en memoria
  if (!track && state.currentTrackId) {
    track = (await db.tracks.get(state.currentTrackId)) ?? null
  }
  await updateMediaSession(
    track,
    state.coverUrl,
    {
      play: () => handleRemotePlay(),
      pause: () => handleRemotePause(),
      previoustrack: () => void usePlayerStore.getState().previous(),
      nexttrack: () => void usePlayerStore.getState().next(),
      seekto: (time) => usePlayerStore.getState().seek(time),
      getPosition: () => usePlayerStore.getState().position,
      seekSkip: false,
    },
    { playing: mediaIsEffectivelyPlaying() },
  )
  // Tras MediaMetadata, iOS resetea el botón — reafirmar play/pause real
  refreshMediaPlaybackState(mediaIsEffectivelyPlaying())
}
