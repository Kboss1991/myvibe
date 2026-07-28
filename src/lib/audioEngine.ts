type Listener = () => void

class AudioEngine {
  private audio = new Audio()
  private listeners = new Set<Listener>()
  private objectUrl: string | null = null
  private mounted = false

  constructor() {
    this.audio.preload = 'auto'
    const media = this.audio as HTMLAudioElement & { playsInline?: boolean }
    media.playsInline = true
    this.audio.setAttribute('playsinline', 'true')
    this.audio.setAttribute('webkit-playsinline', 'true')
    this.audio.setAttribute('x-webkit-airplay', 'allow')
    // Oculto pero en el DOM: iOS mantiene mejor el audio en segundo plano
    this.audio.setAttribute('aria-hidden', 'true')
    this.audio.style.cssText =
      'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-9999px;bottom:0'

    this.audio.addEventListener('timeupdate', () => this.emit())
    this.audio.addEventListener('durationchange', () => this.emit())
    this.audio.addEventListener('ended', () => this.emit())
    this.audio.addEventListener('play', () => this.emit())
    this.audio.addEventListener('pause', () => this.emit())
    this.audio.addEventListener('volumechange', () => this.emit())
    this.audio.addEventListener('error', () => this.emit())

    this.mountIntoDom()
    this.applyPlaybackSession()
  }

  /** Indica a iOS/Safari que es música (sigue con pantalla bloqueada). */
  applyPlaybackSession() {
    try {
      const nav = navigator as Navigator & {
        audioSession?: { type: string }
      }
      if (nav.audioSession) {
        nav.audioSession.type = 'playback'
      }
    } catch {
      // API no disponible
    }
  }

  private mountIntoDom() {
    if (this.mounted || typeof document === 'undefined') return
    const attach = () => {
      if (this.mounted) return
      if (!document.body) return
      if (!this.audio.isConnected) {
        document.body.appendChild(this.audio)
      }
      this.mounted = true
    }
    if (document.body) attach()
    else document.addEventListener('DOMContentLoaded', attach, { once: true })
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
    this.mountIntoDom()
    this.applyPlaybackSession()
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl)
      this.objectUrl = null
    }
    this.audio.src = url
    this.audio.load()

    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.audio.removeEventListener('loadeddata', onReady)
        this.audio.removeEventListener('canplay', onReady)
        this.audio.removeEventListener('error', onError)
        window.clearTimeout(timer)
      }
      const onReady = () => {
        cleanup()
        resolve()
      }
      const onError = () => {
        cleanup()
        reject(new Error(this.audio.error?.message || 'No se pudo cargar el audio'))
      }
      const timer = window.setTimeout(() => {
        cleanup()
        // Algunos móviles no disparan canplay; seguimos si hay metadata
        if (this.audio.readyState >= 1) resolve()
        else reject(new Error('Tiempo de carga de audio agotado'))
      }, 12000)
      this.audio.addEventListener('loadeddata', onReady)
      this.audio.addEventListener('canplay', onReady)
      this.audio.addEventListener('error', onError)
      if (this.audio.readyState >= 2) {
        cleanup()
        resolve()
      }
    })

    if (resumeAt > 0) {
      this.audio.currentTime = resumeAt
    }
    this.emit()
  }

  async play(): Promise<boolean> {
    this.mountIntoDom()
    this.applyPlaybackSession()
    try {
      await this.audio.play()
      this.emit()
      return true
    } catch (err) {
      const name = err instanceof DOMException ? err.name : ''
      // Solo autoplay: no hay audio real / gesto de usuario
      if (name === 'NotAllowedError' || name === 'AbortError') {
        this.emit()
        return false
      }
      // Decode / src no soportado → propagar señal vía element.error
      this.emit()
      return false
    }
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
