import { create } from 'zustand'
import { db, ensurePlaybackSnapshot, PLAYBACK_KEY } from '../db'
import { audioEngine } from '../lib/audioEngine'
import { getAudioObjectUrl, getCoverObjectUrl, recordPlay, getAudioBlobSources, getAudioBlob, revokeCachedUrls, ensureAudioMime } from '../lib/library'
import { deleteBinary } from '../lib/opfs'
import { setMediaPlaybackState, setMediaPositionState, shuffleArray, updateMediaSession, updateRadioMediaSession } from '../lib/mediaSession'
import type { RepeatMode, Track } from '../types'
import { persistRecent } from './libraryStore'
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
  /** Se incrementa al guardar progreso de podcast (para refrescar la UI). */
  podcastProgressTick: number
  /** Timestamp performance.now() al pausar radio para sumar al delay; null si no está midiendo */
  radioPauseStartedAt: number | null

  hydrate: () => Promise<void>
  playTrack: (trackId: string, queue?: string[]) => Promise<void>
  playTracks: (
    trackIds: string[],
    startId?: string,
    options?: { shuffle?: boolean },
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
  next: () => Promise<void>
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

let persistTimer: ReturnType<typeof setTimeout> | null = null
let endedUnsub: (() => void) | null = null
let engineUnsub: (() => void) | null = null
let trackAdvanceLockUntil = 0
let prefetchedNextId: string | null = null
/** Si el avance automático no pudo hacer play (bloqueo), reintentar al volver. */
let pendingBackgroundPlay = false
/** Cola de episodios del show abierto (ids). */
let podcastEpisodeQueue: string[] = []
let podcastPlayEpoch = 0
let lastPodcastProgressSave = 0

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
        set({ isPlaying: true })
        setMediaPlaybackState(true)
        return true
      }
    }
    pendingBackgroundPlay = false
    set({ isPlaying: !audioEngine.paused })
    setMediaPlaybackState(!audioEngine.paused)
    if (!audioEngine.paused) {
      await recordPlay(trackId)
      await persistRecent(trackId)
    }
  } else {
    pendingBackgroundPlay = false
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
  shuffle: false,
  repeat: 'off',
  position: 0,
  duration: 0,
  volume: 1,
  muted: false,
  nowPlayingOpen: false,
  queueOpen: false,
  coverUrl: null,
  hydrated: false,
  podcastProgressTick: 0,

  hydrate: async () => {
    const snap = await ensurePlaybackSnapshot()
    audioEngine.setVolume(snap.volume)
    set({
      queue: snap.queue,
      originalQueue: snap.queue,
      index: snap.index,
      currentTrackId: snap.currentTrackId,
      shuffle: snap.shuffle,
      // Migrar estado antiguo 'one' → 'all'
      repeat: snap.repeat === 'all' || (snap.repeat as string) === 'one' ? 'all' : 'off',
      position: snap.position,
      volume: snap.volume,
      hydrated: true,
    })

    if (!engineUnsub) {
      engineUnsub = audioEngine.subscribe(() => get().syncFromEngine())
    }
    if (!endedUnsub) {
      endedUnsub = audioEngine.onEnded(() => {
        const now = Date.now()
        if (now < trackAdvanceLockUntil) return
        if (get().currentRadioId || audioEngine.isLive) return
        if (get().currentPodcastEpisodeId) {
          persistPodcastProgressNow(set, get, true)
        }
        trackAdvanceLockUntil = now + 500
        void get().next()
      })
    }

    if (snap.currentTrackId && snap.queue.length) {
      await loadAndMaybePlay(snap.currentTrackId, snap.position, false, set)
    }
  },

  syncFromEngine: () => {
    const playing = !audioEngine.paused
    const live = Boolean(get().currentRadioId) || audioEngine.isLive
    if (live) {
      set({
        isPlaying: pendingBackgroundPlay ? true : playing,
        position: 0,
        duration: 0,
      })
      setMediaPlaybackState(pendingBackgroundPlay ? true : playing)
      return
    }
    const position = audioEngine.currentTime
    const duration = audioEngine.duration
    set({
      position,
      duration: Number.isFinite(duration) ? duration : 0,
      isPlaying: pendingBackgroundPlay ? true : playing,
      volume: audioEngine.volume,
      muted: audioEngine.muted,
    })
    setMediaPositionState(position, duration, pendingBackgroundPlay ? true : playing)
    persistSoon({ position })

    if (get().currentPodcastEpisodeId && playing) {
      const now = performance.now()
      if (now - lastPodcastProgressSave > 3000) {
        persistPodcastProgressNow(set, get)
      }
    }

    // Prefetch del siguiente blob para que el cambio de pista en bloqueo sea inmediato
    const { queue, index, currentTrackId, currentRadioId, currentPodcastEpisodeId } = get()
    if (
      !currentRadioId &&
      !currentPodcastEpisodeId &&
      currentTrackId &&
      duration > 20 &&
      position > 0 &&
      duration - position < 18
    ) {
      const nextId = queue[index + 1] ?? (get().repeat === 'all' ? queue[0] : null)
      if (nextId && nextId !== prefetchedNextId) {
        prefetchedNextId = nextId
        void getAudioObjectUrl(nextId)
      }
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
      isPlaying: true,
    })
    setMediaPlaybackState(true)
    try {
      const { reportStationClick } = await import('../lib/radioBrowser')
      reportStationClick(station.id)
      await audioEngine.loadLive(station.streamUrl)
      if (get().currentRadioId !== station.id) return
      audioEngine.applyPlaybackSession()
      let ok = await audioEngine.play()
      if ((!ok || audioEngine.paused) && get().currentRadioId === station.id) {
        await new Promise((r) => window.setTimeout(r, 120))
        ok = await audioEngine.play()
      }
      if (get().currentRadioId !== station.id) return
      const playing = !audioEngine.paused
      set({ isPlaying: playing, radioPauseStartedAt: null })
      setMediaPlaybackState(playing)
      void updateRadioMediaSession(station, {
        play: () => void usePlayerStore.getState().play(),
        pause: () => usePlayerStore.getState().pause(),
        previoustrack: () => void usePlayerStore.getState().previous(),
        nexttrack: () => void usePlayerStore.getState().next(),
      })
      // Si el stream se cae al segundo (CORS/stall), un reintento corto
      window.setTimeout(() => {
        if (get().currentRadioId !== station.id) return
        if (get().isPlaying && audioEngine.paused) {
          void audioEngine.play().then((again) => {
            if (get().currentRadioId !== station.id) return
            set({ isPlaying: again && !audioEngine.paused })
            setMediaPlaybackState(again && !audioEngine.paused)
          })
        }
      }, 600)
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
    })

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
        episode.artworkUrl || show.artworkUrl,
        {
          play: () => void usePlayerStore.getState().play(),
          pause: () => usePlayerStore.getState().pause(),
          previoustrack: () => void usePlayerStore.getState().previous(),
          nexttrack: () => void usePlayerStore.getState().next(),
          seekto: (time) => usePlayerStore.getState().seek(time),
          getPosition: () => usePlayerStore.getState().position,
          seekSkip: true,
        },
      )
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
    const { currentRadioId, radioPauseStartedAt, currentPodcastEpisodeId } = get()
    if (currentPodcastEpisodeId) {
      persistPodcastProgressNow(set, get)
    }
    pendingBackgroundPlay = false
    audioEngine.pause()
    set({
      isPlaying: false,
      ...(currentRadioId && radioPauseStartedAt == null
        ? { radioPauseStartedAt: performance.now() }
        : {}),
    })
    setMediaPlaybackState(false)
  },

  play: async () => {
    const {
      currentTrackId,
      currentRadioId,
      currentPodcastEpisodeId,
      queue,
      index,
      radioPauseStartedAt,
      radioDelay,
    } = get()
    if (currentRadioId) {
      const station = getRadioStation(currentRadioId)
      if (!station) return

      if (radioPauseStartedAt != null) {
        const added = (performance.now() - radioPauseStartedAt) / 1000
        const next = roundRadioDelayMs(
          Math.min(audioEngine.maxRadioDelay, radioDelay + added),
        )
        audioEngine.setRadioDelay(next)
        set({ radioDelay: audioEngine.radioDelay, radioPauseStartedAt: null })
      }

      // Si el stream se cortó, volver a cargar
      if (!audioEngine.element.src && !audioEngine.isLive) {
        await get().playRadio(currentRadioId)
        return
      }
      audioEngine.applyPlaybackSession()
      await audioEngine.ensureAudible()
      const locked =
        typeof document !== 'undefined' && document.visibilityState === 'hidden'
      let ok = locked ? await audioEngine.hardResume() : await audioEngine.play()
      if (!ok || audioEngine.paused) {
        await get().playRadio(currentRadioId)
        return
      }
      set({ isPlaying: !audioEngine.paused, radioPauseStartedAt: null })
      setMediaPlaybackState(!audioEngine.paused)
      return
    }
    if (currentPodcastEpisodeId) {
      if (radioPauseStartedAt != null) set({ radioPauseStartedAt: null })
      audioEngine.applyPlaybackSession()
      await audioEngine.ensureAudible()
      const resumeAt =
        Number.isFinite(audioEngine.currentTime) && audioEngine.currentTime > 0
          ? audioEngine.currentTime
          : get().position
      const locked =
        typeof document !== 'undefined' && document.visibilityState === 'hidden'
      let ok = locked ? await audioEngine.hardResume(resumeAt) : await audioEngine.play()
      if (!ok || audioEngine.paused) {
        ok = await audioEngine.hardResume(resumeAt)
      }
      if (!ok || audioEngine.paused) {
        const ep = getPodcastEpisode(currentPodcastEpisodeId)
        const show = ep ? getPodcastShow(ep.showId) : null
        if (ep && show) {
          const siblings = podcastEpisodeQueue
            .map((id) => getPodcastEpisode(id))
            .filter((e): e is PodcastEpisode => Boolean(e))
          await get().playPodcastEpisode(ep, show, siblings)
        }
        return
      }
      set({ isPlaying: !audioEngine.paused })
      setMediaPlaybackState(!audioEngine.paused)
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
    const locked =
      typeof document !== 'undefined' && document.visibilityState === 'hidden'

    // En bloqueo, tras pause el elemento suele quedar mudo: reenganchar fuente
    let ok = locked ? await audioEngine.hardResume(resumeAt) : await audioEngine.play()
    if (!ok || audioEngine.paused) {
      ok = await audioEngine.hardResume(resumeAt)
    }
    if (!ok || audioEngine.paused) {
      await loadAndMaybePlay(currentTrackId, resumeAt, true, set)
      return
    }
    set({ isPlaying: true })
    setMediaPlaybackState(true)
  },

  next: async () => {
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
    const { queue, index, repeat } = get()
    if (!queue.length) return

    let nextIndex = index + 1
    if (nextIndex >= queue.length) {
      if (repeat === 'all') nextIndex = 0
      else {
        pendingBackgroundPlay = false
        get().pause()
        audioEngine.seek(0)
        return
      }
    }
    trackAdvanceLockUntil = Date.now() + 500
    const trackId = queue[nextIndex]
    if (!trackId) return
    prefetchedNextId = null
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
    const next: RepeatMode = get().repeat === 'off' ? 'all' : 'off'
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
    persistSoon({ queue: [], index: 0, currentTrackId: null, position: 0 })
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
    audioEngine.setRadioDelay(roundRadioDelayMs(seconds))
    set({ radioDelay: audioEngine.radioDelay, radioPauseStartedAt: null })
  },
}))

export async function bindMediaSession(tracks: Track[]) {
  const state = usePlayerStore.getState()
  if (state.currentRadioId) {
    const station = getRadioStation(state.currentRadioId)
    if (station) {
      await updateRadioMediaSession(station, {
        play: () => void usePlayerStore.getState().play(),
        pause: () => usePlayerStore.getState().pause(),
        previoustrack: () => void usePlayerStore.getState().previous(),
        nexttrack: () => void usePlayerStore.getState().next(),
      })
    }
    return
  }
  if (state.currentPodcastEpisodeId) {
    const ep = getPodcastEpisode(state.currentPodcastEpisodeId)
    const show = ep ? getPodcastShow(ep.showId) : null
    if (ep && show) {
      await updateMediaSession(
        podcastSyntheticTrack(ep, show),
        ep.artworkUrl || show.artworkUrl || state.coverUrl,
        {
          play: () => void usePlayerStore.getState().play(),
          pause: () => usePlayerStore.getState().pause(),
          previoustrack: () => void usePlayerStore.getState().previous(),
          nexttrack: () => void usePlayerStore.getState().next(),
          seekto: (time) => usePlayerStore.getState().seek(time),
          getPosition: () => usePlayerStore.getState().position,
          seekSkip: true,
        },
      )
    }
    return
  }
  const track = tracks.find((t) => t.id === state.currentTrackId) ?? null
  await updateMediaSession(track, state.coverUrl, {
    play: () => void usePlayerStore.getState().play(),
    pause: () => usePlayerStore.getState().pause(),
    previoustrack: () => void usePlayerStore.getState().previous(),
    nexttrack: () => void usePlayerStore.getState().next(),
    seekto: (time) => usePlayerStore.getState().seek(time),
    getPosition: () => usePlayerStore.getState().position,
    seekSkip: false,
  })
}
