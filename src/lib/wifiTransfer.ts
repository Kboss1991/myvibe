import Peer, { type DataConnection, type PeerJSOption } from 'peerjs'
import { db } from '../db'
import { createId } from './fileImport'
import {
  beginHugeAudioWrite,
  finishHugeAudioWriteSize,
  getAudioBlob,
  getCoverBlob,
  markLocalAudioFresh,
  saveCoverBlob,
} from './library'
import { nativeAudioExists } from './nativeAudioFs'
import { isNativeApp } from './nativeShell'
import type { OpfsAppendWriter } from './opfs'
import type { Playlist, Track } from '../types'

/**
 * v6: primero todas las canciones “normales” de golpe (con portada);
 * las pesadas (> HEAVY_BYTES) van después, de una en una con reconexión.
 */
const PROTOCOL = 6
const CHUNK = 64 * 1024
const PEER_PREFIX = 'mv'
const BUFFER_HIGH = 192 * 1024
const ACK_TIMEOUT_MS = 180_000
/** Por encima de esto = pesada → solo de 1 en 1. */
const HEAVY_BYTES = 12 * 1024 * 1024
const RECONNECT_PAUSE_MS = 2000
const TRACK_PAUSE_NATIVE_MS = 200
const TRACK_PAUSE_WEB_MS = 30

export function makeTransferCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000))
}

export function peerIdFromCode(code: string): string {
  const clean = code.replace(/\D/g, '').slice(0, 6)
  return `${PEER_PREFIX}${clean}`
}

export function peerOptions(): PeerJSOption {
  return {
    debug: 0,
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
      ],
    },
  }
}

type PlaylistWire = {
  id: string
  name: string
  description: string
  trackIds: string[]
  themeColor?: string
  createdAt: number
  updatedAt: number
}

type JsonMsg =
  | { t: 'hello'; v: number; trackCount: number; from?: string }
  | { t: 'plan'; trackCount: number; skipped?: number; batch?: number; phase?: 'normal' | 'heavy' }
  | { t: 'playlists'; items: PlaylistWire[] }
  | { t: 'have'; ids: string[] }
  | { t: 'caps'; covers: boolean }
  | {
      t: 'track-start'
      i: number
      id: string
      title: string
      artist: string
      album: string
      genre: string
      year: string
      mimeType: string
      fileName: string
      size: number
      duration: number
      liked?: boolean
      hasCover?: boolean
      enriched?: boolean
    }
  | { t: 'chunk-info'; i: number; offset: number; total: number }
  | { t: 'track-end'; i: number }
  | { t: 'cover-start'; id: string; size: number; mimeType: string }
  | { t: 'cover-end'; id: string }
  | { t: 'ack'; id: string; i: number }
  | { t: 'session-end'; remaining: number; done: number; total: number }
  | { t: 'session-ack' }
  | { t: 'ping' }
  | { t: 'pong' }
  | { t: 'done' }
  | { t: 'error'; message: string }
  | { t: 'ready' }

function isJsonMsg(data: unknown): data is JsonMsg {
  return !!data && typeof data === 'object' && 't' in (data as object)
}

function getDataChannel(conn: DataConnection): RTCDataChannel | null {
  const raw = conn as DataConnection & { dataChannel?: RTCDataChannel }
  return raw.dataChannel ?? null
}

async function waitConnDrain(conn: DataConnection, isStopped: () => boolean) {
  const dc = getDataChannel(conn)
  if (!dc) {
    await new Promise((r) => setTimeout(r, 8))
    return
  }
  while (!isStopped() && dc.bufferedAmount > BUFFER_HIGH) {
    await new Promise<void>((resolve) => {
      const finish = () => {
        dc.removeEventListener('bufferedamountlow', finish)
        window.clearTimeout(timer)
        resolve()
      }
      dc.bufferedAmountLowThreshold = Math.floor(BUFFER_HIGH / 2)
      dc.addEventListener('bufferedamountlow', finish)
      const timer = window.setTimeout(finish, 300)
    })
  }
}

async function sendPayload(
  conn: DataConnection,
  payload: ArrayBuffer | JsonMsg,
  isStopped: () => boolean,
) {
  await waitConnDrain(conn, isStopped)
  if (isStopped()) return
  try {
    conn.send(payload)
  } catch (e) {
    throw e instanceof Error ? e : new Error('Conexión perdida al enviar')
  }
}

type Inbox = {
  next: (timeoutMs?: number) => Promise<unknown>
  waitJson: (type: JsonMsg['t'], timeoutMs: number) => Promise<JsonMsg>
  dispose: () => void
}

function createInbox(conn: DataConnection): Inbox {
  const queue: unknown[] = []
  let wake: (() => void) | null = null
  const onData = (data: unknown) => {
    if (isJsonMsg(data) && data.t === 'ping') {
      try {
        conn.send({ t: 'pong' } satisfies JsonMsg)
      } catch {
        /* ignore */
      }
      return
    }
    queue.push(data)
    wake?.()
    wake = null
  }
  conn.on('data', onData)

  const next = (timeoutMs = 120_000) =>
    new Promise<unknown>((resolve, reject) => {
      if (queue.length) {
        resolve(queue.shift())
        return
      }
      const timer = window.setTimeout(() => {
        wake = null
        reject(new Error('Tiempo de espera agotado'))
      }, timeoutMs)
      wake = () => {
        window.clearTimeout(timer)
        resolve(queue.shift())
      }
    })

  return {
    next,
    waitJson: async (type, timeoutMs) => {
      const start = Date.now()
      while (Date.now() - start < timeoutMs) {
        const left = timeoutMs - (Date.now() - start)
        const data = await next(Math.max(left, 1))
        if (isJsonMsg(data) && data.t === type) return data
        // otros JSON (pong, etc.) se ignoran; binarios no deberían llegar al host
      }
      throw new Error('Tiempo de espera agotado')
    },
    dispose: () => {
      conn.off('data', onData)
    },
  }
}

export type WifiTransferProgress = {
  done: number
  total: number
  name: string
  trackPercent: number
  overallPercent: number
}

function emitProgress(
  onProgress: (p: WifiTransferProgress) => void,
  done: number,
  total: number,
  name: string,
  trackPercent: number,
) {
  const safeTotal = Math.max(total, 1)
  const tp = Math.min(100, Math.max(0, Math.round(trackPercent)))
  const overall = Math.min(100, Math.round(((done + tp / 100) / safeTotal) * 100))
  onProgress({
    done,
    total,
    name,
    trackPercent: tp,
    overallPercent: overall,
  })
}

export type HostHandlers = {
  onCode: (code: string) => void
  onStatus: (msg: string) => void
  onProgress: (p: WifiTransferProgress) => void
  onError: (msg: string) => void
  onFinished: () => void
}

export type HostSession = {
  code: string
  stop: () => void
}

export async function startWifiHost(handlers: HostHandlers): Promise<HostSession> {
  const code = makeTransferCode()
  const peer = new Peer(peerIdFromCode(code), peerOptions())

  let stopped = false
  let activeConn: DataConnection | null = null
  let sessionBusy = false
  let resolveNextConn: ((c: DataConnection) => void) | null = null

  const stop = () => {
    stopped = true
    try {
      activeConn?.close()
    } catch {
      /* ignore */
    }
    try {
      peer.destroy()
    } catch {
      /* ignore */
    }
    resolveNextConn = null
  }

  const waitConnection = () =>
    new Promise<DataConnection>((resolve, reject) => {
      if (stopped) {
        reject(new Error('Detenido'))
        return
      }
      resolveNextConn = resolve
      window.setTimeout(() => {
        if (resolveNextConn === resolve) {
          resolveNextConn = null
          reject(new Error('El móvil no reconectó a tiempo'))
        }
      }, 120_000)
    })

  peer.on('error', (err) => {
    handlers.onError(err.message || 'Error de conexión Wi‑Fi')
  })

  peer.on('open', () => {
    handlers.onCode(code)
    handlers.onStatus(
      'Esperando al móvil… En el iPhone: Perfil → introducir este código (misma Wi‑Fi).',
    )
  })

  peer.on('connection', (c) => {
    if (sessionBusy) {
      // Durante un lote no aceptamos otra conexión
      try {
        c.close()
      } catch {
        /* ignore */
      }
      return
    }
    if (resolveNextConn) {
      const r = resolveNextConn
      resolveNextConn = null
      r(c)
      return
    }
    // Primera conexión
    void runHost(c)
  })

  async function runHost(firstConn: DataConnection) {
    sessionBusy = true
    activeConn = firstConn
    try {
      await firstConnOpen(firstConn)
      const allWithAudio = await listTracksWithAudio()
      if (!allWithAudio.length) {
        const inbox = createInbox(firstConn)
        try {
          await inbox.waitJson('ready', 60000).catch(() => null)
          await sendPayload(
            firstConn,
            { t: 'error', message: 'No hay canciones con audio en el PC' },
            () => stopped,
          )
        } finally {
          inbox.dispose()
        }
        handlers.onError('No hay canciones para enviar')
        return
      }

      const playlistsWire = await buildPlaylistWire(allWithAudio)
      let conn = firstConn
      let inbox = createInbox(conn)
      let sentPlaylists = false
      let globalDone = 0

      try {
        await inbox.waitJson('ready', 60000)

        while (!stopped) {
          handlers.onStatus('Móvil conectado. Comprobando pendientes…')
          await sendPayload(
            conn,
            { t: 'hello', v: PROTOCOL, trackCount: allWithAudio.length },
            () => stopped,
          )

          let have = new Set<string>()
          try {
            const haveMsg = await inbox.waitJson('have', 45000)
            if (haveMsg.t === 'have') have = new Set(haveMsg.ids)
          } catch {
            /* enviar todo lo que quede */
          }
          // caps opcional (clientes antiguos); siempre preferimos portadas
          try {
            await inbox.waitJson('caps', 3000)
          } catch {
            /* ignore */
          }

          const pending = allWithAudio.filter((t) => !have.has(t.id))
          const already = allWithAudio.length - pending.length
          globalDone = already

          if (!pending.length) {
            await sendPayload(conn, { t: 'done' }, () => stopped)
            handlers.onStatus(`Nada pendiente: ${allWithAudio.length} canciones ya en el móvil.`)
            emitProgress(handlers.onProgress, allWithAudio.length, allWithAudio.length, '', 100)
            handlers.onFinished()
            return
          }

          const { light, heavy } = await splitByWeight(pending)
          const phase: 'normal' | 'heavy' = light.length ? 'normal' : 'heavy'
          const batch = light.length ? light : heavy.slice(0, 1)

          await sendPayload(
            conn,
            {
              t: 'plan',
              trackCount: pending.length,
              skipped: already,
              batch: batch.length,
              phase,
            },
            () => stopped,
          )

          if (!sentPlaylists) {
            await sendPayload(conn, { t: 'playlists', items: playlistsWire }, () => stopped)
            sentPlaylists = true
          }

          if (phase === 'normal') {
            handlers.onStatus(
              `Enviando ${batch.length} canciones normales` +
                (heavy.length ? ` · luego ${heavy.length} pesadas 1 a 1` : '') +
                (already ? ` · ${already} ya OK` : ''),
            )
          } else {
            const leftHeavy = heavy.length
            handlers.onStatus(
              `Canción pesada (${Math.round(((await getAudioBlob(batch[0]!.id))?.size ?? 0) / 1e6)} MB) · quedan ${leftHeavy}`,
            )
          }

          await sendTrackBatch({
            conn,
            inbox,
            batch,
            pendingTotal: pending.length,
            alreadyDone: already,
            sendCovers: true,
            handlers,
            isStopped: () => stopped,
          })

          globalDone = already + batch.length
          const remaining = pending.length - batch.length

          if (remaining <= 0) {
            await sendPayload(conn, { t: 'done' }, () => stopped)
            emitProgress(
              handlers.onProgress,
              allWithAudio.length,
              allWithAudio.length,
              '',
              100,
            )
            handlers.onStatus(`Envío terminado · ${allWithAudio.length} canciones`)
            handlers.onFinished()
            return
          }

          await sendPayload(
            conn,
            {
              t: 'session-end',
              remaining,
              done: globalDone,
              total: allWithAudio.length,
            },
            () => stopped,
          )
          try {
            await inbox.waitJson('session-ack', 30000)
          } catch {
            /* el móvil puede reconectar igual */
          }

          handlers.onStatus(
            phase === 'normal'
              ? `Normales listas (${globalDone}/${allWithAudio.length}). Siguen las pesadas, una a una…`
              : `Pesada OK (${globalDone}/${allWithAudio.length}). Siguiente…`,
          )
          inbox.dispose()
          try {
            conn.close()
          } catch {
            /* ignore */
          }
          activeConn = null
          sessionBusy = false

          conn = await waitConnection()
          sessionBusy = true
          activeConn = conn
          await firstConnOpen(conn)
          inbox = createInbox(conn)
          await inbox.waitJson('ready', 60000)
        }
      } finally {
        inbox.dispose()
      }
    } catch (e) {
      if (!stopped) {
        handlers.onError(e instanceof Error ? e.message : 'Error de transferencia')
      }
    } finally {
      sessionBusy = false
      activeConn = null
    }
  }

  return { code, stop }
}

function firstConnOpen(conn: DataConnection): Promise<void> {
  if (conn.open) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('No se abrió la conexión')), 30000)
    conn.once('open', () => {
      window.clearTimeout(timer)
      resolve()
    })
    conn.once('error', (err) => {
      window.clearTimeout(timer)
      reject(err)
    })
  })
}

async function listTracksWithAudio(): Promise<Track[]> {
  const all = await db.tracks.toArray()
  const out: Track[] = []
  for (const t of all) {
    if (t.hasLocalAudio === false) continue
    if (await getAudioBlob(t.id)) out.push(t)
  }
  return out
}

/** Separa canciones ligeras (van juntas) y pesadas (van 1 a 1). */
async function splitByWeight(tracks: Track[]): Promise<{ light: Track[]; heavy: Track[] }> {
  const light: Track[] = []
  const heavy: Track[] = []
  for (const t of tracks) {
    const blob = await getAudioBlob(t.id)
    if (!blob) continue
    if (blob.size > HEAVY_BYTES) heavy.push(t)
    else light.push(t)
  }
  return { light, heavy }
}

async function buildPlaylistWire(tracks: Track[]): Promise<PlaylistWire[]> {
  const playlists = await db.playlists.toArray()
  return playlists.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description || '',
    trackIds: p.trackIds.filter((id) => tracks.some((t) => t.id === id)),
    themeColor: p.themeColor,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }))
}

async function sendTrackBatch(opts: {
  conn: DataConnection
  inbox: Inbox
  batch: Track[]
  pendingTotal: number
  alreadyDone: number
  sendCovers: boolean
  handlers: HostHandlers
  isStopped: () => boolean
}) {
  const { conn, inbox, batch, pendingTotal, alreadyDone, sendCovers, handlers, isStopped } =
    opts
  let lastReported = -1
  const ping = window.setInterval(() => {
    try {
      conn.send({ t: 'ping' } satisfies JsonMsg)
    } catch {
      /* ignore */
    }
  }, 8000)

  try {
    for (let i = 0; i < batch.length; i++) {
      if (isStopped()) return
      const track = batch[i]!
      const overallDone = alreadyDone + i
      lastReported = -1
      emitProgress(handlers.onProgress, overallDone, alreadyDone + pendingTotal, track.title, 0)

      const audio = await getAudioBlob(track.id)
      if (!audio) continue
      const totalSize = audio.size
      const cover =
        sendCovers && track.hasCover ? await getCoverBlob(track.id) : null
      const coverBuf = cover ? new Uint8Array(await cover.arrayBuffer()) : null
      const hasCover = Boolean(coverBuf?.byteLength)
      const payloadBytes = totalSize + (hasCover ? coverBuf!.byteLength : 0)

      await sendPayload(
        conn,
        {
          t: 'track-start',
          i,
          id: track.id,
          title: track.title,
          artist: track.artist,
          album: track.album,
          genre: track.genre,
          year: track.year,
          mimeType: track.mimeType || audio.type || 'audio/mpeg',
          fileName: track.fileName || `${track.title}.mp3`,
          size: totalSize,
          duration: track.duration || 0,
          liked: Boolean(track.liked),
          hasCover,
          enriched: Boolean(track.enriched),
        },
        isStopped,
      )

      let sentBytes = 0
      for (let offset = 0; offset < totalSize; offset += CHUNK) {
        if (isStopped()) return
        const end = Math.min(offset + CHUNK, totalSize)
        const ab = await audio.slice(offset, end).arrayBuffer()
        await sendPayload(
          conn,
          { t: 'chunk-info', i, offset, total: totalSize },
          isStopped,
        )
        await sendPayload(conn, ab, isStopped)
        sentBytes = end
        const trackPct = payloadBytes ? (sentBytes / payloadBytes) * 100 : 100
        if (trackPct - lastReported >= 3 || end >= totalSize) {
          lastReported = trackPct
          emitProgress(
            handlers.onProgress,
            overallDone,
            alreadyDone + pendingTotal,
            track.title,
            trackPct,
          )
        }
      }

      await sendPayload(conn, { t: 'track-end', i }, isStopped)

      if (coverBuf && cover && hasCover) {
        await sendPayload(
          conn,
          {
            t: 'cover-start',
            id: track.id,
            size: coverBuf.byteLength,
            mimeType: cover.type || 'image/jpeg',
          },
          isStopped,
        )
        for (let offset = 0; offset < coverBuf.byteLength; offset += CHUNK) {
          if (isStopped()) return
          const end = Math.min(offset + CHUNK, coverBuf.byteLength)
          const slice = coverBuf.subarray(offset, end)
          await sendPayload(
            conn,
            { t: 'chunk-info', i, offset, total: coverBuf.byteLength },
            isStopped,
          )
          await sendPayload(conn, slice.slice().buffer, isStopped)
          sentBytes = totalSize + end
          const trackPct = payloadBytes ? (sentBytes / payloadBytes) * 100 : 100
          if (trackPct - lastReported >= 3 || end >= coverBuf.byteLength) {
            lastReported = trackPct
            emitProgress(
              handlers.onProgress,
              overallDone,
              alreadyDone + pendingTotal,
              track.title,
              trackPct,
            )
          }
        }
        await sendPayload(conn, { t: 'cover-end', id: track.id }, isStopped)
      }

      const ack = await inbox.waitJson('ack', ACK_TIMEOUT_MS)
      if (ack.t === 'ack' && ack.id !== track.id) {
        const again = await inbox.waitJson('ack', 20_000)
        if (again.t !== 'ack' || again.id !== track.id) {
          throw new Error(`El móvil no confirmó “${track.title}”`)
        }
      }
      emitProgress(
        handlers.onProgress,
        overallDone + 1,
        alreadyDone + pendingTotal,
        track.title,
        100,
      )
      await new Promise((r) =>
        setTimeout(r, isNativeApp() ? TRACK_PAUSE_NATIVE_MS : TRACK_PAUSE_WEB_MS),
      )
    }
  } finally {
    window.clearInterval(ping)
  }
}

export type ClientHandlers = {
  onStatus: (msg: string) => void
  onProgress: (p: WifiTransferProgress) => void
  onError: (msg: string) => void
  onFinished: (
    imported: number,
    visibleFiles: { fileName: string; blob: Blob }[],
    playlists?: number,
  ) => void
}

export type ClientSession = {
  stop: () => void
}

export async function startWifiClient(
  code: string,
  handlers: ClientHandlers,
): Promise<ClientSession> {
  const clean = code.replace(/\D/g, '')
  if (clean.length !== 6) {
    throw new Error('El código debe tener 6 dígitos')
  }

  let stopped = false
  let currentStop: (() => void) | null = null
  let importedTotal = 0
  let playlistsIn = 0

  const stop = () => {
    stopped = true
    currentStop?.()
  }

  void (async () => {
    try {
      let round = 0
      while (!stopped) {
        round += 1
        handlers.onStatus(
          round === 1
            ? 'Conectando con el PC…'
            : `Reconectando para la siguiente (pesada o resto)…`,
        )
        const result = await runClientRound(clean, handlers, () => stopped, (s) => {
          currentStop = s
        })
        importedTotal += result.imported
        playlistsIn += result.playlists
        if (result.kind === 'done') {
          handlers.onStatus(
            `Listo: ${importedTotal} canciones nuevas` +
              (playlistsIn ? ` · ${playlistsIn} playlists` : ''),
          )
          handlers.onFinished(importedTotal, [], playlistsIn)
          return
        }
        // session-end → pausa y reconectar
        handlers.onStatus(
          `Lote recibido. Reconectando… quedan ${result.remaining}`,
        )
        await new Promise((r) => setTimeout(r, RECONNECT_PAUSE_MS))
      }
    } catch (e) {
      if (!stopped) {
        handlers.onError(e instanceof Error ? e.message : 'Error Wi‑Fi')
      }
    }
  })()

  return { stop }
}

async function runClientRound(
  code: string,
  handlers: ClientHandlers,
  isStopped: () => boolean,
  setStop: (s: () => void) => void,
): Promise<
  | { kind: 'done'; imported: number; playlists: number }
  | { kind: 'session-end'; imported: number; playlists: number; remaining: number }
> {
  const peer = new Peer(peerOptions())
  let conn: DataConnection | null = null

  const stop = () => {
    try {
      conn?.close()
    } catch {
      /* ignore */
    }
    try {
      peer.destroy()
    } catch {
      /* ignore */
    }
  }
  setStop(stop)

  await new Promise<void>((resolve, reject) => {
    peer.on('open', () => resolve())
    peer.on('error', (err) => reject(err))
    window.setTimeout(
      () => reject(new Error('No se pudo iniciar PeerJS. Revisa la conexión a internet.')),
      20000,
    )
  })

  conn = peer.connect(peerIdFromCode(code), { reliable: true })
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(
      () =>
        reject(
          new Error(
            'No hay respuesta del PC. Código correcto, misma Wi‑Fi, y en el PC “Generar código” activo.',
          ),
        ),
      45000,
    )
    conn!.on('open', () => {
      window.clearTimeout(timer)
      resolve()
    })
    conn!.on('error', (err) => {
      window.clearTimeout(timer)
      reject(err)
    })
  })

  if (isStopped()) {
    stop()
    throw new Error('Detenido')
  }

  const outcome = await receiveLibraryRound(conn, handlers, isStopped)
  stop()
  return outcome
}

async function listLocalAudioIds(): Promise<string[]> {
  const ids: string[] = []
  for (const t of await db.tracks.toArray()) {
    if (t.hasLocalAudio === false) continue
    // NUNCA getAudioBlob aquí: releer todos los MP3 a RAM mata el iPhone
    if ((t.audioBytes ?? 0) > 1024 || t.hasLocalAudio === true) {
      if (isNativeApp()) {
        if (await nativeAudioExists(t.id)) ids.push(t.id)
        else if ((t.audioBytes ?? 0) > 1024) ids.push(t.id)
      } else {
        ids.push(t.id)
      }
      continue
    }
    if (isNativeApp() && (await nativeAudioExists(t.id))) ids.push(t.id)
  }
  return ids
}

async function receiveLibraryRound(
  conn: DataConnection,
  handlers: ClientHandlers,
  isStopped: () => boolean,
): Promise<
  | { kind: 'done'; imported: number; playlists: number }
  | { kind: 'session-end'; imported: number; playlists: number; remaining: number }
> {
  let expected = 0
  let skippedBase = 0
  let imported = 0
  let playlistsIn = 0
  let lastReported = -1
  let lastTitle = ''
  let current: {
    meta: Extract<JsonMsg, { t: 'track-start' }>
    stream: OpfsAppendWriter | null
    received: number
    parts: Uint8Array[]
    discard: boolean
  } | null = null
  let currentCover: {
    id: string
    size: number
    mimeType: string
    parts: Uint8Array[]
    received: number
  } | null = null
  let pendingAck: { id: string; i: number } | null = null
  const skipCovers = false

  const queue: unknown[] = []
  let wake: (() => void) | null = null
  conn.on('data', (data) => {
    queue.push(data)
    wake?.()
    wake = null
  })

  const nextData = () =>
    new Promise<unknown>((resolve) => {
      if (queue.length) {
        resolve(queue.shift())
        return
      }
      wake = () => resolve(queue.shift())
    })

  const sendAck = (id: string, i: number) => {
    try {
      conn.send({ t: 'ack', id, i } satisfies JsonMsg)
    } catch {
      /* ignore */
    }
  }

  const report = (name: string, trackPct: number, force = false) => {
    if (!force && trackPct - lastReported < 2 && trackPct < 100) return
    lastReported = trackPct
    const totalAll = Math.max(skippedBase + expected, 1)
    emitProgress(
      handlers.onProgress,
      skippedBase + imported,
      totalAll,
      name,
      trackPct,
    )
  }

  const abortStream = async () => {
    if (current?.stream) {
      try {
        await current.stream.abort()
      } catch {
        /* ignore */
      }
    }
    current = null
  }

  const readyPulse = window.setInterval(() => {
    try {
      conn.send({ t: 'ready' } satisfies JsonMsg)
    } catch {
      /* ignore */
    }
  }, 500)
  conn.send({ t: 'ready' } satisfies JsonMsg)

  try {
    while (!isStopped()) {
      const data = await nextData()

      if (
        data instanceof ArrayBuffer ||
        data instanceof Uint8Array ||
        (typeof Blob !== 'undefined' && data instanceof Blob)
      ) {
        const bytes =
          data instanceof Uint8Array
            ? data
            : data instanceof Blob
              ? new Uint8Array(await data.arrayBuffer())
              : new Uint8Array(data)

        if (currentCover) {
          if (!skipCovers) currentCover.parts.push(bytes)
          currentCover.received += bytes.byteLength
          const coverPct = currentCover.size
            ? (currentCover.received / currentCover.size) * 100
            : 100
          report(lastTitle || 'Portada', 85 + coverPct * 0.15)
          continue
        }
        if (!current) continue
        if (current.discard) {
          current.received += bytes.byteLength
          continue
        }
        if (current.stream) {
          await current.stream.write(bytes)
        } else {
          current.parts.push(bytes)
        }
        current.received += bytes.byteLength
        const trackPct = current.meta.size
          ? Math.min(95, (current.received / current.meta.size) * 95)
          : 0
        report(current.meta.title, trackPct)
        continue
      }

      if (!isJsonMsg(data)) continue

      if (data.t === 'ping') {
        try {
          conn.send({ t: 'pong' } satisfies JsonMsg)
        } catch {
          /* ignore */
        }
        continue
      }

      if (data.t === 'error') {
        handlers.onError(data.message)
        throw new Error(data.message)
      }

      if (data.t === 'hello') {
        window.clearInterval(readyPulse)
        if (data.v < 1 || data.v > PROTOCOL) {
          throw new Error(
            'Versión incompatible. En el PC: Ctrl+Shift+R y vuelve a generar el código.',
          )
        }
        expected = data.trackCount
        handlers.onStatus(`Biblioteca PC: ${expected}. Comprobando qué falta…`)
        const haveIds = await listLocalAudioIds()
        conn.send({ t: 'have', ids: haveIds } satisfies JsonMsg)
        conn.send({ t: 'caps', covers: true } satisfies JsonMsg)
        continue
      }

      if (data.t === 'plan') {
        expected = data.trackCount
        skippedBase = data.skipped ?? 0
        if (data.phase === 'heavy') {
          handlers.onStatus(
            `Canción pesada (1 a 1)` +
              (data.batch ? ` · este envío: ${data.batch}` : '') +
              ` · pendientes ${expected}`,
          )
        } else if (data.phase === 'normal') {
          handlers.onStatus(
            `Canciones normales de golpe` +
              (data.batch ? `: ${data.batch}` : '') +
              ` · pendientes totales ${expected}` +
              (data.skipped ? ` · ya OK ${data.skipped}` : ''),
          )
        } else {
          handlers.onStatus(
            data.batch
              ? `Este lote: ${data.batch} · pendientes ${expected}` +
                  (data.skipped ? ` · ya OK ${data.skipped}` : '')
              : `Pendientes: ${expected}`,
          )
        }
        emitProgress(
          handlers.onProgress,
          skippedBase,
          Math.max(skippedBase + expected, 1),
          '',
          0,
        )
        continue
      }

      if (data.t === 'playlists') {
        const now = Date.now()
        for (const item of data.items) {
          await db.playlists.put({
            id: item.id,
            name: item.name || 'Playlist',
            description: item.description || '',
            trackIds: item.trackIds || [],
            hasCover: false,
            themeColor: item.themeColor,
            createdAt: item.createdAt || now,
            updatedAt: item.updatedAt || now,
          } satisfies Playlist)
          playlistsIn += 1
        }
        continue
      }

      if (data.t === 'track-start') {
        await abortStream()
        currentCover = null
        lastReported = -1
        lastTitle = data.title
        const id = data.id || createId()
        const meta = { ...data, id }
        let stream: OpfsAppendWriter | null = null
        try {
          stream = await beginHugeAudioWrite(id)
        } catch {
          stream = null
        }
        const discard = !stream && isNativeApp()
        current = { meta, stream, received: 0, parts: [], discard }
        report(data.title, 0, true)
        continue
      }

      if (data.t === 'chunk-info') continue

      if (data.t === 'track-end') {
        if (!current || current.meta.i !== data.i) continue
        const meta = current.meta
        const stream = current.stream
        const parts = current.parts
        const received = current.received
        const discard = current.discard
        current = null

        if (discard) {
          console.warn('Descartada (sin escritura a disco)', meta.title)
          sendAck(meta.id, meta.i)
          continue
        }

        if (received < meta.size * 0.98) {
          if (stream) {
            try {
              await stream.abort()
            } catch {
              /* ignore */
            }
          }
          console.warn('Pista incompleta', meta.title, received, meta.size)
          sendAck(meta.id, meta.i)
          continue
        }

        try {
          report(meta.title, 96, true)
          let audioBytes = received
          if (stream) {
            // Solo tamaño en disco — no releer el MP3 a RAM
            audioBytes = await finishHugeAudioWriteSize(meta.id, stream, meta.size)
          } else {
            const merged = new Uint8Array(meta.size)
            let off = 0
            for (const p of parts) {
              merged.set(p, off)
              off += p.byteLength
            }
            const libraryBlob = new Blob(
              [merged.buffer.slice(merged.byteOffset, merged.byteOffset + merged.byteLength)],
              { type: meta.mimeType || 'audio/mpeg' },
            )
            const { saveAudioBlob } = await import('./library')
            await saveAudioBlob(meta.id, libraryBlob)
            audioBytes = libraryBlob.size
          }

          const existing = await db.tracks.get(meta.id)
          const now = Date.now()
          await db.tracks.put({
            id: meta.id,
            title: meta.title,
            artist: meta.artist || 'Artista desconocido',
            album: meta.album || 'Sin álbum',
            genre: meta.genre || '',
            year: meta.year || '',
            duration: meta.duration || 0,
            mimeType: meta.mimeType || 'audio/mpeg',
            fileName: meta.fileName || `${meta.title}.mp3`,
            hasCover: existing?.hasCover ?? false,
            liked: meta.liked ?? existing?.liked ?? false,
            playCount: existing?.playCount ?? 0,
            lastPlayedAt: existing?.lastPlayedAt ?? null,
            createdAt: existing?.createdAt ?? now,
            enriched: meta.enriched ?? existing?.enriched ?? false,
            hasLocalAudio: true,
            origin: 'local',
            audioBytes,
            audioUpdatedAt: now,
            needsAudioUpdate: false,
          } satisfies Track)
          await markLocalAudioFresh(meta.id, now, audioBytes)

          if (meta.hasCover) {
            // Host envía portada después; hay que consumirla aunque en nativo no la guardemos
            pendingAck = { id: meta.id, i: meta.i }
            report(meta.title, 90, true)
          } else {
            imported += 1
            emitProgress(
              handlers.onProgress,
              skippedBase + imported,
              Math.max(skippedBase + expected, 1),
              meta.title,
              100,
            )
            sendAck(meta.id, meta.i)
            if (isNativeApp()) await new Promise((r) => setTimeout(r, 80))
          }
        } catch (e) {
          console.warn('Fallo al guardar pista', e)
          sendAck(meta.id, meta.i)
        }
        continue
      }

      if (data.t === 'cover-start') {
        currentCover = {
          id: data.id,
          size: data.size,
          mimeType: data.mimeType || 'image/jpeg',
          parts: [],
          received: 0,
        }
        continue
      }

      if (data.t === 'cover-end') {
        if (!currentCover || currentCover.id !== data.id) {
          currentCover = null
          if (pendingAck && pendingAck.id === data.id) {
            imported += 1
            emitProgress(
              handlers.onProgress,
              skippedBase + imported,
              Math.max(skippedBase + expected, 1),
              lastTitle,
              100,
            )
            sendAck(pendingAck.id, pendingAck.i)
            pendingAck = null
          }
          continue
        }
        const coverMeta = currentCover
        const got = coverMeta.received || coverMeta.parts.reduce((n, p) => n + p.byteLength, 0)
        currentCover = null
        if (!skipCovers && got >= coverMeta.size * 0.9 && coverMeta.parts.length) {
          try {
            await saveCoverBlob(
              coverMeta.id,
              new Blob(coverMeta.parts as BlobPart[], { type: coverMeta.mimeType }),
            )
            await db.tracks.update(coverMeta.id, {
              hasCover: true,
              enriched: true,
              coverUpdatedAt: Date.now(),
            })
          } catch (e) {
            console.warn('Fallo portada', e)
          }
        }
        coverMeta.parts = []
        if (pendingAck && pendingAck.id === coverMeta.id) {
          imported += 1
          emitProgress(
            handlers.onProgress,
            skippedBase + imported,
            Math.max(skippedBase + expected, 1),
            lastTitle,
            100,
          )
          sendAck(pendingAck.id, pendingAck.i)
          pendingAck = null
        }
        continue
      }

      if (data.t === 'session-end') {
        if (pendingAck) {
          sendAck(pendingAck.id, pendingAck.i)
          pendingAck = null
        }
        try {
          conn.send({ t: 'session-ack' } satisfies JsonMsg)
        } catch {
          /* ignore */
        }
        return {
          kind: 'session-end',
          imported,
          playlists: playlistsIn,
          remaining: data.remaining,
        }
      }

      if (data.t === 'done') {
        if (pendingAck) {
          sendAck(pendingAck.id, pendingAck.i)
          pendingAck = null
        }
        emitProgress(
          handlers.onProgress,
          skippedBase + imported,
          Math.max(skippedBase + expected, skippedBase + imported, 1),
          '',
          100,
        )
        return { kind: 'done', imported, playlists: playlistsIn }
      }
    }
    throw new Error('Transferencia interrumpida')
  } finally {
    window.clearInterval(readyPulse)
    await abortStream()
  }
}
