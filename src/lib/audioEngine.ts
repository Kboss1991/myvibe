type Listener = () => void

class AudioEngine {
  private audio = new Audio()
  private listeners = new Set<Listener>()
  private objectUrl: string | null = null

  constructor() {
    this.audio.preload = 'auto'
    this.audio.addEventListener('timeupdate', () => this.emit())
    this.audio.addEventListener('durationchange', () => this.emit())
    this.audio.addEventListener('ended', () => this.emit())
    this.audio.addEventListener('play', () => this.emit())
    this.audio.addEventListener('pause', () => this.emit())
    this.audio.addEventListener('volumechange', () => this.emit())
    this.audio.addEventListener('error', () => this.emit())
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit() {
    for (const l of this.listeners) l()
  }

  get element() {
    return this.audio
  }

  get currentTime() {
    return this.audio.currentTime
  }

  get duration() {
    return Number.isFinite(this.audio.duration) ? this.audio.duration : 0
  }

  get paused() {
    return this.audio.paused
  }

  get volume() {
    return this.audio.volume
  }

  get muted() {
    return this.audio.muted
  }

  async load(url: string, resumeAt = 0): Promise<void> {
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl)
      this.objectUrl = null
    }
    // Only revoke if it was created by us — callers manage library cache URLs.
    this.audio.src = url
    this.audio.load()
    if (resumeAt > 0) {
      await new Promise<void>((resolve) => {
        const onMeta = () => {
          this.audio.currentTime = resumeAt
          this.audio.removeEventListener('loadedmetadata', onMeta)
          resolve()
        }
        this.audio.addEventListener('loadedmetadata', onMeta)
      })
    }
    this.emit()
  }

  async play(): Promise<void> {
    try {
      await this.audio.play()
    } catch {
      // autoplay restrictions — UI stays paused
    }
    this.emit()
  }

  pause() {
    this.audio.pause()
    this.emit()
  }

  seek(time: number) {
    if (!Number.isFinite(time)) return
    this.audio.currentTime = Math.max(0, Math.min(time, this.duration || time))
    this.emit()
  }

  setVolume(v: number) {
    this.audio.volume = Math.max(0, Math.min(1, v))
    this.emit()
  }

  setMuted(m: boolean) {
    this.audio.muted = m
    this.emit()
  }

  async setSinkId(deviceId: string): Promise<void> {
    const el = this.audio as HTMLAudioElement & {
      setSinkId?: (id: string) => Promise<void>
    }
    if (typeof el.setSinkId !== 'function') {
      throw new Error('Tu navegador no permite elegir la salida de audio')
    }
    await el.setSinkId(deviceId)
    try {
      localStorage.setItem('myvibe_audio_sink', deviceId)
    } catch {
      // ignore
    }
    this.emit()
  }

  /** Restaura la salida guardada (Chrome/Edge). */
  async restoreSinkId(): Promise<void> {
    try {
      const saved = localStorage.getItem('myvibe_audio_sink')
      if (!saved) return
      const el = this.audio as HTMLAudioElement & {
        setSinkId?: (id: string) => Promise<void>
      }
      if (typeof el.setSinkId === 'function') {
        await el.setSinkId(saved)
        this.emit()
      }
    } catch {
      // dispositivo ya no disponible
    }
  }

  get sinkId(): string {
    const el = this.audio as HTMLAudioElement & { sinkId?: string }
    return el.sinkId || ''
  }

  onEnded(handler: () => void) {
    const fn = () => handler()
    this.audio.addEventListener('ended', fn)
    return () => this.audio.removeEventListener('ended', fn)
  }
}

export const audioEngine = new AudioEngine()
