import Hls from 'hls.js'
import { isHlsUrl } from './radios'

type Listener = () => void

const MAX_RADIO_DELAY = 30

class AudioEngine {
  private audio = new Audio()
  private listeners = new Set<Listener>()
  private endedHandlers = new Set<() => void>()
  /** Pausa no pedida por nosotros (llamada, Siri, otra app) */
  private interruptionHandlers = new Set<() => void>()
  /** Fin de interrupción del sistema (colgar, volver audio a la app) */
  private interruptionEndHandlers = new Set<() => void>()
  /** true justo al llamar pause() programático — evita falsas interrupciones */
  private intentionalPause = false
  private intentionalPauseToken = 0
  /** true mientras iOS tiene el audio (llamada, Siri, etc.) */
  private systemInterrupted = false
  private audioSessionWired = false
  private ctxStateWired = false
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
  /** Última URL de media (podcast/pista) para reanudar tras pause en iOS. */
  private lastMediaUrl: string | null = null
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
    // Por si quedó un <audio> keep-alive de builds anteriores robando la sesión
    this.scrubOrphanKeepAlives()
  }

  private scrubOrphanKeepAlives() {
    try {
      for (const el of Array.from(document.querySelectorAll('audio'))) {
        if (el === this.audio || el === this.standby) continue
        const style = (el as HTMLElement).style
        if (style?.left === '-9999px' || el.getAttribute('data-myvibe-keepalive') === '1') {
          try {
            el.pause()
            el.removeAttribute('src')
            el.load()
            el.remove()
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* ignore */
    }
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
    el.addEventListener('pause', () => {
      // Pause de AirPods / bloqueo / CarPlay: NO es una llamada.
      // Si tratamos ese pause como interrupción, pendingBackgroundPlay + watcher
      // pelean el play, se pierde Now Playing y ya no se puede reanudar.
      // Las llamadas reales llegan por audioSession/AudioContext "interrupted".
      if (!this.intentionalPause && !this.audioSessionWired && !this.ctxStateWired) {
        for (const h of this.interruptionHandlers) h()
      }
      this.emit()
    })
    el.addEventListener('volumechange', () => this.emit())
    el.addEventListener('error', () => this.emit())
  }

  /**
   * Marca pause() / cambio de src como intencional (no interrupción).
   * Ventana larga: con AirPods el evento `pause` a veces llega mucho después.
   */
  markIntentionalPause(ms = 1500) {
    this.intentionalPause = true
    const token = ++this.intentionalPauseToken
    window.setTimeout(() => {
      if (token === this.intentionalPauseToken) {
        this.intentionalPause = false
      }
    }, Math.max(0, ms))
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

  get isSystemInterrupted() {
    return this.systemInterrupted
  }

  /** true si conviene no recargar la PWA (audio activo o llamada en curso). */
  get shouldKeepAlive() {
    return !this.audio.paused || this.systemInterrupted
  }

  applyPlaybackSession() {
    try {
      const nav = navigator as Navigator & {
        audioSession?: {
          type: string
          state?: string
          onstatechange: ((this: unknown, ev: Event) => void) | null
        }
      }
      if (nav.audioSession) {
        nav.audioSession.type = 'playback'
        if (!this.audioSessionWired) {
          this.audioSessionWired = true
          const session = nav.audioSession
          session.onstatechange = () => {
            const state = String(session.state ?? '')
            if (state === 'interrupted') {
              this.enterSystemInterruption()
              return
            }
            // active / inactive: la llamada (u otra app) ya soltó el audio
            if (this.systemInterrupted) {
              this.leaveSystemInterruption()
            }
          }
        }
      }
    } catch {
      // API no disponible
    }
  }

  private enterSystemInterruption() {
    if (this.intentionalPause) return
    const was = this.systemInterrupted
    this.systemInterrupted = true
    if (!was) {
      for (const h of this.interruptionHandlers) {
        try {
          h()
        } catch {
          /* ignore */
        }
      }
    }
  }

  private leaveSystemInterruption() {
    if (!this.systemInterrupted) return
    // Pause intencional (AirPods / UI): no auto-reanudar al volver "active"
    if (this.intentionalPause) {
      this.systemInterrupted = false
      return
    }
    this.systemInterrupted = false
    for (const h of this.interruptionEndHandlers) {
      try {
        h()
      } catch {
        /* ignore */
      }
    }
  }

  private wireContextState(ctx: AudioContext) {
    if (this.ctxStateWired) return
    this.ctxStateWired = true
    ctx.addEventListener('statechange', () => {
      const state = String(ctx.state)
      if (state === 'interrupted') {
        this.enterSystemInterruption()
        return
      }
      if (state === 'running' && this.systemInterrupted) {
        this.leaveSystemInterruption()
      }
    })
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
   * Arranca el standby MIENTRAS el actual sigue sonando y lo promueve.
   * Clave con pantalla apagada: no hay que hacer play() tras un silencio/`ended`.
   */
  overlapPromoteStandby(expectedTrackId?: string): boolean {
    if (!this.standby || !this.standbyUrl) return false
    if (
      expectedTrackId &&
      this.standbyTrackId &&
      this.standbyTrackId !== expectedTrackId
    ) {
      return false
    }
    // Solo tiene sentido si el actual aún reproduce (privilegio activo)
    if (this.audio.paused && !this.audio.ended) return false

    const next = this.standby
    const url = this.standbyUrl
    this.standby = null
    this.standbyUrl = null
    this.standbyTrackId = null

    next.muted = false
    next.volume = this.volumeValue
    try {
      if (next.currentTime > 0.05) next.currentTime = 0
    } catch {
      /* ignore */
    }

    this.applyPlaybackSession()
    try {
      void next.play()
    } catch {
      // Restaurar standby para reintento
      this.standby = next
      this.standbyUrl = url
      this.standbyTrackId = expectedTrackId ?? null
      return false
    }

    const old = this.audio
    try {
      this.markIntentionalPause()
      old.pause()
    } catch {
      /* ignore */
    }
    this.destroyHls()
    if (this.sourceNode || this.ctx) {
      this.disconnectGraphNodes()
    }
    this.live = false
    this.liveStreamUrl = null
    this.delayGraphActive = false

    this.configureElement(next)
    this.wireElement(next)
    this.audio = next
    this.objectUrl = url
    this.mountIntoDom()

    try {
      old.removeAttribute('src')
      old.remove()
    } catch {
      /* ignore */
    }

    if (next.paused) {
      try {
        void next.play()
      } catch {
        this.emit()
        return false
      }
    }
    this.emit()
    return true
  }

  /**
   * Continuar reproducción tras `ended` / early-advance en el MISMO <audio>.
   * Cambiar de elemento rompe Now Playing en iOS (desaparece de la pantalla de bloqueo).
   * Debe llamarse de forma síncrona, sin awaits previos.
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
    // Cambiar src dispara 'pause' → marcar intencional para no tratarlo como llamada
    this.markIntentionalPause(1200)
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

  /** Precarga la siguiente pista en un segundo elemento (solo buffer; no promover en iOS). */
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
      this.markIntentionalPause()
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
    this.wireContextState(this.ctx)
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
      this.ctxStateWired = false
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
      this.markIntentionalPause()
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
    if (!this.ctx) return
    this.wireContextState(this.ctx)
    const state = String(this.ctx.state)
    if (state === 'suspended' || state === 'interrupted') {
      try {
        await this.ctx.resume()
      } catch {
        /* iOS puede rechazar resume mientras dura la llamada */
      }
    }
  }

  private applyDelayToGraph() {
    if (!this.delayNode) return
    const value = this.live ? this.radioDelaySec : 0
    // Valor instantáneo: setTargetAtTime “come” sílabas / hace micro-saltos
    // al cambiar el delay mientras suena.
    const t = this.ctx?.currentTime ?? 0
    try {
      this.delayNode.delayTime.cancelScheduledValues(t)
      this.delayNode.delayTime.setValueAtTime(value, t)
    } catch {
      this.delayNode.delayTime.value = value
    }
  }

  get hasDelayGraph() {
    return this.delayGraphActive && Boolean(this.delayNode)
  }

  /**
   * Retraso de la radio (0–30 s) para sincronizar con la tele.
   *
   * El sync real suele venir de pausar el directo (el buffer se queda atrás).
   * Recargar el stream al “editar” vuelve al vivo y pierde ese sync — por eso
   * solo recargamos al poner 0 (Sin retraso) o si el DelayNode ya está activo.
   */
  setRadioDelay(seconds: number, opts?: { reload?: boolean }) {
    const next = Math.max(0, Math.min(MAX_RADIO_DELAY, seconds))
    const prev = this.radioDelaySec
    const allowReload = opts?.reload === true
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

    // Grafo Web Audio: solo recargar al quitar retraso. Nunca modular delayTime
    // en caliente (setTarget/setValue mientras suena = come sílabas / micro-saltos).
    // El sync real con la tele es el buffer del <audio> tras pausa/play.
    if (this.delayGraphActive && this.delayNode) {
      if (next <= 0 && allowReload) {
        void this.applyDelayMode(false)
      } else {
        void this.resumeContext()
      }
      if (prev !== next) this.emit()
      return
    }

    // Sync por pausa (sin DelayNode): nunca recargar si next > 0
    if (next > 0) {
      if (prev !== next) this.emit()
      return
    }

    // Sin retraso: volver al directo
    if (allowReload) {
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
      // Otra emisora / otro reset ganó la carrera
      if (token !== this.delayApplyToken) return
      if (this.liveStreamUrl !== url) return
      if (wasPlaying) {
        const ok = await this.play()
        if (token !== this.delayApplyToken || this.liveStreamUrl !== url) return
        if (!ok || this.audio.paused) throw new Error('play failed')
      }
      this.delayGraphActive = enable && Boolean(this.sourceNode)
      // Si pedimos delay pero no hay grafo (CORS), volver a directo
      if (enable && !this.delayGraphActive) throw new Error('no delay graph')
    } catch {
      if (token !== this.delayApplyToken) return
      if (this.liveStreamUrl !== url) return
      // Restaurar audio directo (sin delay). Solo se usa al resetear o al fallar
      // un intento explícito de grafo — no desde el ajuste por pausa.
      this.radioDelaySec = 0
      this.delayGraphActive = false
      try {
        localStorage.setItem('myvibe_radio_delay', '0')
      } catch {
        /* ignore */
      }
      try {
        await this.load(url, 0, { live: true })
        if (token !== this.delayApplyToken || this.liveStreamUrl !== url) return
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
    this.lastMediaUrl = url

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
        // Buffer amplio: el sync TV es por pausa y puede acumular hasta MAX_RADIO_DELAY.
        // Si el buffer es corto, al reanudar HLS “adelanta” al vivo → come palabras / saltos.
        const bufferPad = Math.max(60, MAX_RADIO_DELAY + 30)
        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          maxBufferLength: bufferPad,
          maxMaxBufferLength: bufferPad + 30,
          // Nunca acelerar para alcanzar el borde en vivo (rompe el retraso TV)
          maxLiveSyncPlaybackRate: 1,
          liveDurationInfinity: true,
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
    // Cancela “Sin retraso” / recargas async de la emisora anterior (si no,
    // pueden pisar el stream nuevo y dejar el delay/HLS a medias).
    this.delayApplyToken += 1
    this.radioDelaySec = 0
    this.delayGraphActive = false
    this.live = false
    this.liveStreamUrl = null
    try {
      localStorage.setItem('myvibe_radio_delay', '0')
    } catch {
      /* ignore */
    }
    // Siempre elemento limpio al sintonizar: si la radio anterior iba con
    // retraso (buffer/HLS/Web Audio), reutilizar el <audio> provoca saltos
    // y “come” palabras al volver a pausar/play en la siguiente.
    this.replaceAudioElement()
    this.liveStreamUrl = url
    await this.load(url, 0, { live: true })
    this.emit()
  }

  /** Reanuda contexto Web Audio + sesión de reproducción (al desbloquear). */
  async ensureAudible(): Promise<void> {
    this.mountIntoDom()
    this.applyPlaybackSession()
    await this.resumeContext()
    if (this.sourceNode && !this.live) {
      // Sustituir el <audio> (MediaElementSource solo una vez) pero conservar src/posición
      // para no dejar podcasts/canciones mudos tras radio con delay.
      const src = this.audio.getAttribute('src') || this.audio.currentSrc || this.objectUrl
      const t = this.audio.currentTime
      const wasPaused = this.audio.paused
      this.ensureElementAudioRoute()
      if (src && !src.startsWith('data:')) {
        this.markIntentionalPause(1200)
        this.audio.src = src
        if (Number.isFinite(t) && t > 0.25) {
          const seek = () => {
            try {
              this.audio.currentTime = t
            } catch {
              /* ignore */
            }
          }
          if (this.audio.readyState >= 1) seek()
          else this.audio.addEventListener('loadedmetadata', seek, { once: true })
        }
        if (!wasPaused) {
          try {
            await this.audio.play()
          } catch {
            /* caller reintenta */
          }
        }
      }
    }
    this.audio.muted = false
    if (!this.gainNode) this.audio.volume = this.volumeValue
  }

  /**
   * Tras pause en pantalla de bloqueo / BT, play() a veces “arranca” sin sonido.
   * Recarga el mismo src y reanuda en la posición.
   * Nunca llamar si ya suena: resetear src dispara pause→interrupción falsa y rompe CarPlay.
   */
  async hardResume(resumeAt?: number): Promise<boolean> {
    this.mountIntoDom()
    this.applyPlaybackSession()
    await this.resumeContext()
    if (!this.audio.paused && !this.audio.ended) {
      this.audio.muted = false
      if (!this.gainNode) this.audio.volume = this.volumeValue
      this.emit()
      return true
    }
    if (this.sourceNode && !this.live) {
      this.ensureElementAudioRoute()
    }
    const src =
      this.lastMediaUrl ||
      this.audio.getAttribute('src') ||
      this.audio.currentSrc ||
      this.objectUrl
    if (!src || src.startsWith('data:')) return false

    const t =
      typeof resumeAt === 'number' && Number.isFinite(resumeAt) && resumeAt > 0
        ? resumeAt
        : this.audio.currentTime || 0

    this.audio.muted = false
    if (!this.gainNode) this.audio.volume = this.volumeValue
    // Evita que el pause del reload dispare onInterruption / watcher CarPlay
    this.markIntentionalPause(1200)
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
    if (this.gainNode) {
      this.gainNode.gain.value = this.volumeValue
      this.audio.volume = 1
    } else {
      this.audio.volume = this.volumeValue
    }
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

  /**
   * Play en el mismo turno del gesto (Media Session / tap).
   * En iOS, cualquier await antes de audio.play() pierde el permiso.
   */
  playFromUserGesture(): Promise<boolean> {
    this.scrubOrphanKeepAlives()
    this.mountIntoDom()
    this.applyPlaybackSession()
    this.audio.muted = false
    if (this.gainNode) {
      this.gainNode.gain.value = this.volumeValue
      this.audio.volume = 1
    } else {
      this.audio.volume = this.volumeValue
    }
    void this.resumeContext()
    try {
      const p = this.audio.play()
      return Promise.resolve(p)
        .then(() => {
          this.emit()
          return !this.audio.paused
        })
        .catch(() => {
          this.emit()
          return false
        })
    } catch {
      this.emit()
      return Promise.resolve(false)
    }
  }

  pause() {
    this.scrubOrphanKeepAlives()
    this.markIntentionalPause()
    try {
      this.audio.pause()
    } catch {
      /* ignore */
    }
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

  /** Pausa externa (llamada, otra app, cambio de ruta BT). */
  onInterruption(handler: () => void) {
    this.interruptionHandlers.add(handler)
    return () => this.interruptionHandlers.delete(handler)
  }

  /** Fin de interrupción (colgar, iOS devuelve el audio). Clave en CarPlay. */
  onInterruptionEnd(handler: () => void) {
    this.interruptionEndHandlers.add(handler)
    return () => this.interruptionEndHandlers.delete(handler)
  }
}

export const audioEngine = new AudioEngine()
audioEngine.loadSavedRadioDelay()
