import Hls from 'hls.js'
import { isHlsUrl } from './radios'

type Listener = () => void

const MAX_RADIO_DELAY = 30

class AudioEngine {
  private audio = new Audio()
  private listeners = new Set<Listener>()
  private endedHandlers = new Set<() => void>()
  /** Referencia al blob URL actual; NO se revoca aquí (lo gestiona library cache). */
  private objectUrl: string | null = null
  private hls: Hls | null = null
  private live = false

  private ctx: AudioContext | null = null
  private sourceNode: MediaElementAudioSourceNode | null = null
  private delayNode: DelayNode | null = null
  private gainNode: GainNode | null = null
  private radioDelaySec = 0
  private volumeValue = 1

  constructor() {
    this.configureElement(this.audio)
    this.wireElement(this.audio)
    this.mountIntoDom()
    this.applyPlaybackSession()
  }

  private configureElement(el: HTMLAudioElement) {
    el.preload = 'auto'
    const media = el as HTMLAudioElement & { playsInline?: boolean }
    media.playsInline = true
    el.setAttribute('playsinline', 'true')
    el.setAttribute('webkit-playsinline', 'true')
    el.setAttribute('x-webkit-airplay', 'allow')
    el.setAttribute('aria-hidden', 'true')
    el.crossOrigin = 'anonymous'
    // Visible 1×1: algunos navegadores matan el audio si es 0×0 / visibility:hidden
    el.style.cssText =
      'position:fixed;width:1px;height:1px;opacity:0.01;pointer-events:none;left:0;bottom:0;z-index:-1'
  }

  private wireElement(el: HTMLAudioElement) {
    el.addEventListener('timeupdate', () => this.emit())
    el.addEventListener('durationchange', () => this.emit())
    el.addEventListener('ended', () => {
      this.emit()
      for (const h of this.endedHandlers) h()
    })
    el.addEventListener('play', () => this.emit())
    el.addEventListener('pause', () => this.emit())
    el.addEventListener('volumechange', () => this.emit())
    el.addEventListener('error', () => this.emit())
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
    if (typeof document === 'undefined') return
    const attach = () => {
      if (!document.body) return
      if (!this.audio.isConnected) {
        document.body.appendChild(this.audio)
      }
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
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    this.ctx = new Ctx()
    this.sourceNode = this.ctx.createMediaElementSource(this.audio)
    this.delayNode = this.ctx.createDelay(MAX_RADIO_DELAY)
    this.gainNode = this.ctx.createGain()
    this.delayNode.delayTime.value = this.live ? this.radioDelaySec : 0
    this.gainNode.gain.value = this.audio.muted ? 0 : this.volumeValue
    this.sourceNode.connect(this.delayNode)
    this.delayNode.connect(this.gainNode)
    this.gainNode.connect(this.ctx.destination)
    this.audio.volume = 1
  }

  private disconnectGraphNodes() {
    try {
      this.sourceNode?.disconnect()
    } catch {
      /* ignore */
    }
    try {
      this.delayNode?.disconnect()
    } catch {
      /* ignore */
    }
    try {
      this.gainNode?.disconnect()
    } catch {
      /* ignore */
    }
    this.sourceNode = null
    this.delayNode = null
    this.gainNode = null
    if (this.ctx) {
      void this.ctx.close().catch(() => undefined)
      this.ctx = null
    }
  }

  /**
   * Tras usar radio (Web Audio), hay que sustituir el <audio>:
   * createMediaElementSource solo se puede llamar una vez por elemento,
   * y el grafo deja el audio mudo si el contexto se suspende (bloqueo).
   */
  private replaceAudioElement() {
    const old = this.audio
    const wasMuted = old.muted
    const vol = this.volumeValue
    try {
      old.pause()
    } catch {
      /* ignore */
    }
    this.destroyHls()
    this.disconnectGraphNodes()

    const next = new Audio()
    this.configureElement(next)
    this.wireElement(next)
    next.muted = wasMuted
    next.volume = vol
    this.audio = next
    this.objectUrl = null
    this.mountIntoDom()
    try {
      old.removeAttribute('src')
      old.remove()
    } catch {
      /* ignore */
    }
  }

  /** Sale del grafo Web Audio al volver a música/podcast. */
  private ensureElementAudioRoute() {
    if (!this.sourceNode && !this.ctx) return
    this.replaceAudioElement()
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

  private waitElementReady(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
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
      }, timeoutMs)
      this.audio.addEventListener('loadeddata', onReady)
      this.audio.addEventListener('canplay', onReady)
      this.audio.addEventListener('error', onError)
      if (this.audio.readyState >= 2) {
        cleanup()
        resolve()
      }
    })
  }

  async load(
    url: string,
    resumeAt = 0,
    options?: { live?: boolean; isObjectUrl?: boolean },
  ): Promise<void> {
    this.mountIntoDom()
    this.applyPlaybackSession()
    this.destroyHls()

    const nextLive = Boolean(options?.live)
    if (!nextLive) {
      // Música: ruta directa del <audio>, sin grafo (evita silencio en bloqueo)
      this.ensureElementAudioRoute()
    }

    this.live = nextLive
    // No revocar blob URLs: library.ts los cachea
    this.objectUrl = options?.isObjectUrl ? url : null

    if (options?.isObjectUrl) {
      this.audio.removeAttribute('crossorigin')
    } else {
      this.audio.crossOrigin = 'anonymous'
    }

    if (this.live) {
      this.ensureAudioGraph()
      this.applyDelayToGraph()
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
      // Soft-swap: cambiar src sin vaciar antes (mantiene mejor la sesión en bloqueo)
      this.audio.src = url
    }

    if (!useHls || this.audio.canPlayType('application/vnd.apple.mpegurl')) {
      await this.waitElementReady(this.live ? 20000 : 8000)
    }

    if (!this.live && resumeAt > 0) {
      try {
        this.audio.currentTime = resumeAt
      } catch {
        /* ignore */
      }
    }
    this.audio.muted = false
    if (!this.gainNode) this.audio.volume = this.volumeValue
    this.emit()
  }

  async loadObjectUrl(url: string, resumeAt = 0): Promise<void> {
    await this.load(url, resumeAt, { isObjectUrl: true, live: false })
  }

  async loadLive(url: string): Promise<void> {
    this.loadSavedRadioDelay()
    await this.load(url, 0, { live: true })
  }

  /** Reanuda contexto Web Audio + sesión de reproducción (al desbloquear). */
  async ensureAudible(): Promise<void> {
    this.mountIntoDom()
    this.applyPlaybackSession()
    await this.resumeContext()
    if (this.sourceNode && !this.live) {
      this.ensureElementAudioRoute()
    }
    this.audio.muted = false
    if (!this.gainNode) this.audio.volume = this.volumeValue
  }

  /**
   * Tras pause en pantalla de bloqueo / BT, play() a veces “arranca” sin sonido.
   * Recarga el mismo src y reanuda en la posición.
   */
  async hardResume(resumeAt?: number): Promise<boolean> {
    this.mountIntoDom()
    this.applyPlaybackSession()
    await this.resumeContext()
    if (this.sourceNode && !this.live) {
      this.ensureElementAudioRoute()
    }
    const src = this.audio.getAttribute('src') || this.audio.currentSrc || this.objectUrl
    if (!src || src.startsWith('data:')) return false

    const t =
      typeof resumeAt === 'number' && Number.isFinite(resumeAt) && resumeAt > 0
        ? resumeAt
        : this.audio.currentTime || 0

    this.audio.muted = false
    if (!this.gainNode) this.audio.volume = this.volumeValue
    this.audio.src = src

    try {
      await this.waitElementReady(5000)
    } catch {
      /* intentar play igual */
    }

    if (t > 0.25 && !this.live) {
      try {
        this.audio.currentTime = t
      } catch {
        /* ignore */
      }
    }

    return this.play()
  }

  async play(): Promise<boolean> {
    this.mountIntoDom()
    this.applyPlaybackSession()
    await this.resumeContext()
    this.audio.muted = false
    if (!this.gainNode) this.audio.volume = this.volumeValue
    try {
      await this.audio.play()
      this.emit()
      return !this.audio.paused
    } catch (err) {
      const name = err instanceof DOMException ? err.name : ''
      if (name === 'AbortError') {
        // Cambio de src concurrente: reintentar una vez
        try {
          await this.audio.play()
          this.emit()
          return !this.audio.paused
        } catch {
          this.emit()
          return false
        }
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
    this.endedHandlers.add(handler)
    return () => this.endedHandlers.delete(handler)
  }
}

export const audioEngine = new AudioEngine()
audioEngine.loadSavedRadioDelay()
