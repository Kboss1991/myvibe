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
  /** URL original del directo (para recargar al activar/desactivar delay). */
  private liveStreamUrl: string | null = null
  private delayApplyToken = 0
  /** true si el grafo de delay está activo de verdad */
  private delayGraphActive = false
  /** Siguiente pista precargada (gapless / auto-next sin gesto) */
  private standby: HTMLAudioElement | null = null
  private standbyUrl: string | null = null
  private standbyTrackId: string | null = null

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
      // Primero avanzar de pista (play en el mismo elemento), luego emitir estado.
      // Si emit va antes, la UI marca pause y se pierde la continuidad de reproducción.
      for (const h of this.endedHandlers) h()
      this.emit()
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
      if (this.standby && !this.standby.isConnected) {
        document.body.appendChild(this.standby)
      }
    }
    if (document.body) attach()
    else document.addEventListener('DOMContentLoaded', attach, { once: true })
  }

  /**
   * Continuar reproducción tras `ended` en el MISMO <audio>.
   * Cambiar de elemento (standby) rompe el gesto/privilegio en iOS y Android.
   * Debe llamarse de forma síncrona desde el handler de ended, sin awaits previos.
   */
  chainPlay(url: string): boolean {
    if (!url) return false
    this.mountIntoDom()
    this.applyPlaybackSession()
    this.destroyHls()
    this.live = false
    this.liveStreamUrl = null
    this.delayGraphActive = false
    // Si el elemento estuvo en Web Audio, ya no suena por speakers tras disconnect:
    // hay que sustituirlo (pierde continuidad, pero evita silencio total).
    if (this.sourceNode || this.ctx) {
      this.replaceAudioElement()
    }
    this.objectUrl = url
    this.audio.removeAttribute('crossorigin')
    this.audio.muted = false
    if (!this.gainNode) this.audio.volume = this.volumeValue
    // NO pause(), NO load() — solo src + play en el mismo turno que `ended`
    try {
      this.audio.src = url
    } catch {
      return false
    }
    try {
      const p = this.audio.play()
      void p.catch(() => {
        this.emit()
      })
      return true
    } catch {
      return false
    }
  }

  /** Precarga la siguiente pista en un segundo elemento (listo para play al `ended`). */
  prepareStandby(url: string, trackId?: string) {
    if (!url) return
    if (
      this.standbyUrl === url &&
      this.standby &&
      this.standby.readyState >= 2 &&
      (!trackId || this.standbyTrackId === trackId)
    ) {
      return
    }
    if (!this.standby) {
      this.standby = new Audio()
      this.configureElement(this.standby)
      this.standby.removeAttribute('crossorigin')
    }
    this.standbyUrl = url
    this.standbyTrackId = trackId ?? null
    this.standby.muted = false
    this.standby.volume = this.volumeValue
    if (this.standby.src !== url) {
      this.standby.src = url
      this.standby.load()
    }
    this.mountIntoDom()
  }

  clearStandby() {
    if (this.standby) {
      try {
        this.standby.pause()
        this.standby.removeAttribute('src')
        this.standby.load()
        this.standby.remove()
      } catch {
        /* ignore */
      }
    }
    this.standby = null
    this.standbyUrl = null
    this.standbyTrackId = null
  }

  /**
   * Promueve el standby a elemento activo y hace play() síncrono.
   * Debe llamarse desde el handler de `ended` (continuidad de reproducción).
   */
  promoteStandbyAndPlay(expectedTrackId?: string): boolean {
    if (!this.standby || !this.standbyUrl) return false
    if (
      expectedTrackId &&
      this.standbyTrackId &&
      this.standbyTrackId !== expectedTrackId
    ) {
      this.clearStandby()
      return false
    }
    const next = this.standby
    const url = this.standbyUrl
    this.standby = null
    this.standbyUrl = null
    this.standbyTrackId = null

    const old = this.audio
    try {
      old.pause()
    } catch {
      /* ignore */
    }
    this.destroyHls()
    this.disconnectGraphNodes()
    this.live = false
    this.liveStreamUrl = null
    this.delayGraphActive = false

    this.configureElement(next)
    this.wireElement(next)
    next.muted = false
    next.volume = this.volumeValue
    this.audio = next
    this.objectUrl = url
    this.mountIntoDom()
    this.applyPlaybackSession()

    try {
      old.removeAttribute('src')
      old.remove()
    } catch {
      /* ignore */
    }

    // play() en el mismo turno que ended — sin await
    void this.resumeContext()
    const p = this.audio.play()
    void p.then(() => this.emit()).catch(() => this.emit())
    this.emit()
    return true
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
   * @param opts.reload Si false, nunca recarga el stream (solo DelayNode / valor).
   */
  setRadioDelay(seconds: number, opts?: { reload?: boolean }) {
    const next = Math.max(0, Math.min(MAX_RADIO_DELAY, seconds))
    const prev = this.radioDelaySec
    const allowReload = opts?.reload !== false
    this.radioDelaySec = next
    try {
      localStorage.setItem('myvibe_radio_delay', String(this.radioDelaySec))
    } catch {
      // ignore
    }

    if (!this.live) {
      if (prev !== next) this.emit()
      return
    }

    // Grafo ya activo: solo cambiar el DelayNode
    if (this.delayGraphActive && this.delayNode && next > 0) {
      this.applyDelayToGraph()
      void this.resumeContext()
      if (prev !== next) this.emit()
      return
    }

    // Sin recarga (p. ej. al pulsar play tras pausa): no tocar el stream
    if (!allowReload) {
      if (prev !== next) this.emit()
      return
    }

    // Solo el slider/usuario puede intentar activar el grafo (una vez)
    if (next > 0 && !this.delayGraphActive) {
      void this.applyDelayMode(true)
    } else if (next <= 0 && this.delayGraphActive) {
      void this.applyDelayMode(false)
    }

    if (prev !== next) this.emit()
  }

  /** Activa o desactiva el grafo de delay sin dejar el audio muerto. */
  private async applyDelayMode(enable: boolean) {
    const url = this.liveStreamUrl
    if (!url || !this.live) return
    const token = ++this.delayApplyToken
    const wasPlaying = !this.audio.paused

    if (enable) {
      this.radioDelaySec = Math.max(this.radioDelaySec, 0.5)
    } else {
      this.radioDelaySec = 0
    }

    try {
      await this.load(url, 0, { live: true })
      if (token !== this.delayApplyToken) return
      if (wasPlaying) {
        const ok = await this.play()
        if (token !== this.delayApplyToken) return
        if (!ok || this.audio.paused) throw new Error('play failed')
      }
      this.delayGraphActive = enable && Boolean(this.sourceNode)
      // Si pedimos delay pero no hay grafo (CORS), volver a directo
      if (enable && !this.delayGraphActive) throw new Error('no delay graph')
    } catch {
      if (token !== this.delayApplyToken) return
      // Restaurar audio directo para no quedarse pillado/mudo
      this.radioDelaySec = 0
      this.delayGraphActive = false
      try {
        localStorage.setItem('myvibe_radio_delay', '0')
      } catch {
        /* ignore */
      }
      try {
        await this.load(url, 0, { live: true })
        if (token !== this.delayApplyToken) return
        if (wasPlaying) await this.play()
      } catch {
        /* ignore */
      }
      this.emit()
    }
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
    options?: { live?: boolean; isObjectUrl?: boolean; skipCors?: boolean },
  ): Promise<void> {
    this.mountIntoDom()
    this.applyPlaybackSession()
    this.destroyHls()

    const nextLive = Boolean(options?.live)
    // Retraso TV necesita Web Audio (+ CORS). Muchas emisoras (RAC1/StreamTheWorld)
    // fallan con crossOrigin y se paran al instante: sin retraso → <audio> directo.
    const needsDelayGraph = nextLive && this.radioDelaySec > 0

    if (!nextLive || !needsDelayGraph) {
      if (this.sourceNode || this.ctx) {
        this.replaceAudioElement()
      }
    }

    this.live = nextLive
    // No revocar blob URLs: library.ts los cachea
    this.objectUrl = options?.isObjectUrl ? url : null

    if (options?.isObjectUrl || options?.skipCors || (nextLive && !needsDelayGraph)) {
      this.audio.removeAttribute('crossorigin')
    } else {
      this.audio.crossOrigin = 'anonymous'
    }

    if (needsDelayGraph) {
      this.ensureAudioGraph()
      this.applyDelayToGraph()
      this.delayGraphActive = Boolean(this.sourceNode)
    } else {
      this.delayGraphActive = false
    }

    if (nextLive) {
      this.liveStreamUrl = url
    } else {
      this.liveStreamUrl = null
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
        }, 8000)
      })
    } else {
      this.audio.src = url
      this.audio.load()
    }

    if (!useHls || this.audio.canPlayType('application/vnd.apple.mpegurl')) {
      // Timeout corto con delay/CORS: si no, se queda pillado 20s
      const readyMs = this.live && needsDelayGraph ? 6000 : this.live ? 12000 : 8000
      await this.waitElementReady(readyMs)
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

  /**
   * Cambio de pista encadenado al evento `ended`.
   * No espera canplay: hay que llamar play() en el mismo turno (o casi)
   * para que el navegador permita continuar sin gesto del usuario.
   */
  async swapAndPlay(url: string, resumeAt = 0): Promise<boolean> {
    this.mountIntoDom()
    this.applyPlaybackSession()
    this.destroyHls()
    this.live = false
    this.liveStreamUrl = null
    this.delayGraphActive = false
    if (this.sourceNode || this.ctx) {
      this.replaceAudioElement()
    }
    this.objectUrl = url
    this.audio.removeAttribute('crossorigin')
    this.audio.muted = false
    if (!this.gainNode) this.audio.volume = this.volumeValue
    this.audio.src = url

    // play() sin await de canplay — continuidad tras ended
    try {
      void this.resumeContext()
      const playPromise = this.audio.play()
      if (resumeAt > 0.25) {
        const seek = () => {
          try {
            this.audio.currentTime = resumeAt
          } catch {
            /* ignore */
          }
        }
        if (this.audio.readyState >= 1) seek()
        else this.audio.addEventListener('loadedmetadata', seek, { once: true })
      }
      await playPromise
      this.emit()
      if (!this.audio.paused) return true
    } catch {
      /* fallback abajo */
    }

    try {
      await this.waitElementReady(4000)
      if (resumeAt > 0.25) {
        try {
          this.audio.currentTime = resumeAt
        } catch {
          /* ignore */
        }
      }
      await this.audio.play()
      this.emit()
      return !this.audio.paused
    } catch {
      this.emit()
      return false
    }
  }

  async loadLive(url: string): Promise<void> {
    this.liveStreamUrl = url
    // Nunca aplicar delay al sintonizar: provoca recargas/CORS y un bucle play/stop.
    this.radioDelaySec = 0
    this.delayGraphActive = false
    try {
      localStorage.setItem('myvibe_radio_delay', '0')
    } catch {
      /* ignore */
    }
    await this.load(url, 0, { live: true })
    this.emit()
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
