import Hls from 'hls.js'
import { isHlsUrl } from './radios'

type Listener = () => void

const MAX_RADIO_DELAY = 30

class AudioEngine {
  private audio = new Audio()
  private listeners = new Set<Listener>()
  private objectUrl: string | null = null
  private hls: Hls | null = null
  private mounted = false
  private live = false

  private ctx: AudioContext | null = null
  private sourceNode: MediaElementAudioSourceNode | null = null
  private delayNode: DelayNode | null = null
  private gainNode: GainNode | null = null
  private radioDelaySec = 0
  private volumeValue = 1

  constructor() {
    this.audio.preload = 'auto'
    const media = this.audio as HTMLAudioElement & { playsInline?: boolean }
    media.playsInline = true
    this.audio.setAttribute('playsinline', 'true')
    this.audio.setAttribute('webkit-playsinline', 'true')
    this.audio.setAttribute('x-webkit-airplay', 'allow')
    this.audio.setAttribute('aria-hidden', 'true')
    this.audio.crossOrigin = 'anonymous'
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

  get isLive() {
    return this.live
  }

  get radioDelay() {
    return this.radioDelaySec
  }

  get maxRadioDelay() {
    return MAX_RADIO_DELAY
  }

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
    if (this.live) return 0
    return Number.isFinite(this.audio.duration) ? this.audio.duration : 0
  }

  get paused() {
    return this.audio.paused
  }

  get volume() {
    return this.volumeValue
  }

  get muted() {
    return this.audio.muted
  }

  /** Enruta el <audio> por Web Audio para poder aplicar delay (sync TV). */
  private ensureAudioGraph() {
    if (this.sourceNode) return
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    this.ctx = new Ctx()
    this.sourceNode = this.ctx.createMediaElementSource(this.audio)
    this.delayNode = this.ctx.createDelay(MAX_RADIO_DELAY)
    this.gainNode = this.ctx.createGain()
    this.delayNode.delayTime.value = this.live ? this.radioDelaySec : 0
    this.gainNode.gain.value = this.audio.muted ? 0 : this.volumeValue
    this.sourceNode.connect(this.delayNode)
    this.delayNode.connect(this.gainNode)
    this.gainNode.connect(this.ctx.destination)
    // El volumen lo controla el GainNode
    this.audio.volume = 1
  }

  private async resumeContext() {
    if (this.ctx?.state === 'suspended') {
      await this.ctx.resume()
    }
  }

  private applyDelayToGraph() {
    if (!this.delayNode) return
    const value = this.live ? this.radioDelaySec : 0
    this.delayNode.delayTime.setTargetAtTime(value, this.ctx?.currentTime ?? 0, 0.05)
  }

  /**
   * Retraso de la radio (0–30 s) para sincronizar con la tele.
   * Solo afecta a streams en directo.
   */
  setRadioDelay(seconds: number) {
    this.radioDelaySec = Math.max(0, Math.min(MAX_RADIO_DELAY, seconds))
    try {
      localStorage.setItem('myvibe_radio_delay', String(this.radioDelaySec))
    } catch {
      // ignore
    }
    if (this.live) {
      this.ensureAudioGraph()
      this.applyDelayToGraph()
      void this.resumeContext()
    }
    this.emit()
  }

  loadSavedRadioDelay() {
    try {
      const raw = localStorage.getItem('myvibe_radio_delay')
      if (raw == null) return
      const n = Number(raw)
      if (Number.isFinite(n)) this.radioDelaySec = Math.max(0, Math.min(MAX_RADIO_DELAY, n))
    } catch {
      // ignore
    }
  }

  private destroyHls() {
    if (this.hls) {
      this.hls.destroy()
      this.hls = null
    }
  }

  private clearSource() {
    this.destroyHls()
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl)
      this.objectUrl = null
    }
    this.audio.removeAttribute('src')
    this.audio.load()
  }

  async load(
    url: string,
    resumeAt = 0,
    options?: { live?: boolean; isObjectUrl?: boolean },
  ): Promise<void> {
    this.mountIntoDom()
    this.applyPlaybackSession()
    this.clearSource()
    this.live = Boolean(options?.live)

    if (options?.isObjectUrl) {
      this.objectUrl = url
      // blob: no usa CORS; quitar crossOrigin evita fallos en canciones locales
      this.audio.removeAttribute('crossorigin')
    } else {
      this.audio.crossOrigin = 'anonymous'
    }

    // Delay solo en directo; canciones sin retardo
    if (this.live) {
      this.ensureAudioGraph()
      this.applyDelayToGraph()
    } else if (this.delayNode) {
      this.delayNode.delayTime.value = 0
    }

    const useHls = isHlsUrl(url) && !this.audio.canPlayType('application/vnd.apple.mpegurl')

    if (isHlsUrl(url) && this.audio.canPlayType('application/vnd.apple.mpegurl')) {
      this.audio.src = url
      this.audio.load()
    } else if (useHls && Hls.isSupported()) {
      await new Promise<void>((resolve, reject) => {
        const bufferPad = Math.max(30, this.radioDelaySec + 15)
        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: this.radioDelaySec < 1,
          maxBufferLength: bufferPad,
          maxMaxBufferLength: bufferPad + 30,
        })
        this.hls = hls
        hls.loadSource(url)
        hls.attachMedia(this.audio)
        const onError = (_: unknown, data: { fatal?: boolean }) => {
          if (!data.fatal) return
          hls.destroy()
          this.hls = null
          reject(new Error('No se pudo cargar el directo (HLS)'))
        }
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          hls.off(Hls.Events.ERROR, onError)
          resolve()
        })
        hls.on(Hls.Events.ERROR, onError)
        window.setTimeout(() => {
          if (this.audio.readyState >= 1) {
            hls.off(Hls.Events.ERROR, onError)
            resolve()
          }
        }, 10000)
      })
    } else {
      this.audio.src = url
      this.audio.load()
    }

    if (!useHls || this.audio.canPlayType('application/vnd.apple.mpegurl')) {
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
          if (this.audio.readyState >= 1 || this.live) resolve()
          else reject(new Error('Tiempo de carga de audio agotado'))
        }, this.live ? 20000 : 12000)
        this.audio.addEventListener('loadeddata', onReady)
        this.audio.addEventListener('canplay', onReady)
        this.audio.addEventListener('error', onError)
        if (this.audio.readyState >= 2) {
          cleanup()
          resolve()
        }
      })
    }

    if (!this.live && resumeAt > 0) {
      this.audio.currentTime = resumeAt
    }
    this.emit()
  }

  async loadObjectUrl(url: string, resumeAt = 0): Promise<void> {
    await this.load(url, resumeAt, { isObjectUrl: true, live: false })
  }

  async loadLive(url: string): Promise<void> {
    this.loadSavedRadioDelay()
    await this.load(url, 0, { live: true })
  }

  async play(): Promise<boolean> {
    this.mountIntoDom()
    this.applyPlaybackSession()
    await this.resumeContext()
    try {
      await this.audio.play()
      this.emit()
      return true
    } catch (err) {
      const name = err instanceof DOMException ? err.name : ''
      if (name === 'NotAllowedError' || name === 'AbortError') {
        this.emit()
        return false
      }
      this.emit()
      return false
    }
  }

  pause() {
    this.audio.pause()
    this.emit()
  }

  seek(time: number) {
    if (this.live) return
    if (!Number.isFinite(time)) return
    this.audio.currentTime = Math.max(0, Math.min(time, this.duration || time))
    this.emit()
  }

  setVolume(v: number) {
    this.volumeValue = Math.max(0, Math.min(1, v))
    if (this.gainNode) {
      this.gainNode.gain.value = this.audio.muted ? 0 : this.volumeValue
      this.audio.volume = 1
    } else {
      this.audio.volume = this.volumeValue
    }
    this.emit()
  }

  setMuted(m: boolean) {
    this.audio.muted = m
    if (this.gainNode) {
      this.gainNode.gain.value = m ? 0 : this.volumeValue
    }
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
audioEngine.loadSavedRadioDelay()
