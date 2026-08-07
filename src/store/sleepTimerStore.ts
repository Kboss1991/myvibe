import { create } from 'zustand'

export type SleepTimerMode = 'off' | 'timed' | 'end_of_track'

type SleepTimerState = {
  mode: SleepTimerMode
  /** Timestamp ms cuando debe apagarse (timed / end_of_track). */
  endsAt: number | null
  /** Minutos elegidos si mode === 'timed'. */
  presetMinutes: number | null
  setMinutes: (minutes: number) => void
  /** Pausa al acabar la canción/episodio actual. */
  setEndOfTrack: (remainingSeconds: number) => void
  clear: () => void
  /** Dispara la pausa (timeout). */
  fire: () => void
  /**
   * Llamar cuando termina la pista/episodio actual.
   * true = el temporizador ha pausado; no avanzar a la siguiente.
   */
  onMediaEnded: () => boolean
}

let timeoutId: ReturnType<typeof setTimeout> | null = null

function clearNativeTimeout() {
  if (timeoutId != null) {
    clearTimeout(timeoutId)
    timeoutId = null
  }
}

function schedule(endsAt: number) {
  clearNativeTimeout()
  const ms = Math.max(0, endsAt - Date.now())
  timeoutId = setTimeout(() => {
    timeoutId = null
    useSleepTimerStore.getState().fire()
  }, ms)
}

async function pauseActivePlayback() {
  const { useLibraryPlayerStore } = await import('./libraryPlayerStore')
  const { usePlayerStore } = await import('./playerStore')
  const lib = useLibraryPlayerStore.getState()
  if (lib.currentTrackId) lib.pause()
  const rp = usePlayerStore.getState()
  if (rp.currentRadioId || rp.currentPodcastEpisodeId) rp.pause()
}

export const useSleepTimerStore = create<SleepTimerState>((set, get) => ({
  mode: 'off',
  endsAt: null,
  presetMinutes: null,

  setMinutes: (minutes) => {
    if (!Number.isFinite(minutes) || minutes <= 0) {
      get().clear()
      return
    }
    const endsAt = Date.now() + minutes * 60_000
    set({ mode: 'timed', endsAt, presetMinutes: minutes })
    schedule(endsAt)
  },

  setEndOfTrack: (remainingSeconds) => {
    const rem = Math.max(0.5, Number.isFinite(remainingSeconds) ? remainingSeconds : 0.5)
    const endsAt = Date.now() + rem * 1000
    set({ mode: 'end_of_track', endsAt, presetMinutes: null })
    schedule(endsAt)
  },

  clear: () => {
    clearNativeTimeout()
    set({ mode: 'off', endsAt: null, presetMinutes: null })
  },

  fire: () => {
    clearNativeTimeout()
    set({ mode: 'off', endsAt: null, presetMinutes: null })
    void pauseActivePlayback()
  },

  onMediaEnded: () => {
    if (get().mode !== 'end_of_track') return false
    clearNativeTimeout()
    set({ mode: 'off', endsAt: null, presetMinutes: null })
    void pauseActivePlayback()
    return true
  },
}))

export function formatSleepRemaining(endsAt: number | null, now = Date.now()): string {
  if (!endsAt) return ''
  const left = Math.max(0, Math.ceil((endsAt - now) / 1000))
  const m = Math.floor(left / 60)
  const s = left % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

export const SLEEP_TIMER_PRESETS_MIN = [15, 30, 45, 60] as const
