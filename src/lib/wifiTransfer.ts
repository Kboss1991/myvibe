import Peer, { type DataConnection } from 'peerjs'
import { db } from '../db'
import { createId } from './fileImport'
import { getAudioBlob, saveAudioBlob } from './library'
import { tracksLookSame } from './trackDedupe'
import type { Track } from '../types'

const PROTOCOL = 1
const CHUNK = 256 * 1024 // 256 KB — fiable en móvil
const PEER_PREFIX = 'mv'

export function makeTransferCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000))
}

export function peerIdFromCode(code: string): string {
  const clean = code.replace(/\D/g, '').slice(0, 6)
  return `${PEER_PREFIX}${clean}`
}

type JsonMsg =
  | { t: 'hello'; v: number; trackCount: number; from?: string }
  | {
      t: 'track-start'
      i: number
      title: string
      artist: string
      album: string
      genre: string
      year: string
      mimeType: string
      fileName: string
      size: number
      duration: number
    }
  | { t: 'chunk-info'; i: number; offset: number; total: number }
  | { t: 'track-end'; i: number }
  | { t: 'done' }
  | { t: 'error'; message: string }
  | { t: 'ready' }

function isJsonMsg(data: unknown): data is JsonMsg {
  return !!data && typeof data === 'object' && 't' in (data as object)
}

export type HostHandlers = {
  onCode: (code: string) => void
  onStatus: (msg: string) => void
  onProgress: (done: number, total: number, name: string) => void
  onError: (msg: string) => void
  onFinished: () => void
}

export type HostSession = {
  code: string
  stop: () => void
}

/** PC: espera al móvil y envía la biblioteca. */
export async function startWifiHost(
  handlers: HostHandlers,
): Promise<HostSession> {
  const code = makeTransferCode()
  const peer = new Peer(peerIdFromCode(code), {
    debug: 0,
  })

  let stopped = false
  let conn: DataConnection | null = null

  const stop = () => {
    stopped = true
    try {
      conn?.close()
    } catch {
      // ignore
    }
    try {
      peer.destroy()
    } catch {
      // ignore
    }
  }

  peer.on('error', (err) => {
    handlers.onError(err.message || 'Error de conexión Wi‑Fi')
  })

  peer.on('open', () => {
    handlers.onCode(code)
    handlers.onStatus('Esperando al móvil… Abre MyVibe ahí y pulsa Recibir por Wi‑Fi.')
  })

  peer.on('connection', (c) => {
    if (conn) {
      c.close()
      return
    }
    conn = c
    // Escuchar ready desde ya (puede llegar antes que 'open' en el host)
    const readyPromise = waitForMsg(c, 'ready', 45000)
    c.on('open', () => {
      void (async () => {
        try {
          handlers.onStatus('Móvil conectado. Preparando envío…')
          await readyPromise
          await sendLibrary(c, handlers, () => stopped)
        } catch (e) {
          handlers.onError(e instanceof Error ? e.message : 'Error de transferencia')
        }
      })()
    })
    c.on('error', (err) => {
      handlers.onError(err.message || 'Se cortó la conexión')
    })
    c.on('close', () => {
      if (!stopped) handlers.onStatus('El móvil se desconectó')
    })
  })

  return { code, stop }
}

async function sendLibrary(
  conn: DataConnection,
  handlers: HostHandlers,
  isStopped: () => boolean,
) {
  try {
    const tracks = await db.tracks.toArray()
    if (!tracks.length) {
      conn.send({ t: 'error', message: 'No hay canciones en el PC' } satisfies JsonMsg)
      handlers.onError('No hay canciones para enviar')
      return
    }

    handlers.onStatus(`Conectado. Enviando ${tracks.length} canciones…`)
    conn.send({
      t: 'hello',
      v: PROTOCOL,
      trackCount: tracks.length,
    } satisfies JsonMsg)

    for (let i = 0; i < tracks.length; i++) {
      if (isStopped()) return
      const track = tracks[i]!
      handlers.onProgress(i, tracks.length, track.title)

      const audio = await getAudioBlob(track.id)
      if (!audio) continue
      const buf = new Uint8Array(await audio.arrayBuffer())

      conn.send({
        t: 'track-start',
        i,
        title: track.title,
        artist: track.artist,
        album: track.album,
        genre: track.genre,
        year: track.year,
        mimeType: track.mimeType || audio.type || 'audio/mpeg',
        fileName: track.fileName || `${track.title}.mp3`,
        size: buf.byteLength,
        duration: track.duration || 0,
      } satisfies JsonMsg)

      for (let offset = 0; offset < buf.byteLength; offset += CHUNK) {
        if (isStopped()) return
        const end = Math.min(offset + CHUNK, buf.byteLength)
        const slice = buf.subarray(offset, end)
        conn.send({
          t: 'chunk-info',
          i,
          offset,
          total: buf.byteLength,
        } satisfies JsonMsg)
        // Copia para ArrayBuffer “limpio”
        const copy = slice.slice().buffer
        conn.send(copy)
        await new Promise((r) => setTimeout(r, 0))
      }

      conn.send({ t: 'track-end', i } satisfies JsonMsg)
    }

    conn.send({ t: 'done' } satisfies JsonMsg)
    handlers.onProgress(tracks.length, tracks.length, '')
    handlers.onStatus('Envío terminado')
    handlers.onFinished()
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Error al enviar'
    try {
      conn.send({ t: 'error', message: msg } satisfies JsonMsg)
    } catch {
      // ignore
    }
    handlers.onError(msg)
  }
}

function waitForMsg(
  conn: DataConnection,
  type: JsonMsg['t'],
  timeoutMs: number,
): Promise<JsonMsg> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup()
      reject(new Error('Tiempo de espera agotado'))
    }, timeoutMs)

    const onData = (data: unknown) => {
      if (isJsonMsg(data) && data.t === type) {
        cleanup()
        resolve(data)
      }
    }

    const cleanup = () => {
      window.clearTimeout(timer)
      conn.off('data', onData)
    }

    conn.on('data', onData)
  })
}

export type ClientHandlers = {
  onStatus: (msg: string) => void
  onProgress: (done: number, total: number, name: string) => void
  onError: (msg: string) => void
  onFinished: (
    imported: number,
    visibleFiles: { fileName: string; blob: Blob }[],
  ) => void
}

export type ClientSession = {
  stop: () => void
}

/** Móvil: se conecta al PC con el código e importa. */
export async function startWifiClient(
  code: string,
  handlers: ClientHandlers,
): Promise<ClientSession> {
  const clean = code.replace(/\D/g, '')
  if (clean.length !== 6) {
    throw new Error('El código debe tener 6 dígitos')
  }

  const peer = new Peer({ debug: 0 })
  let stopped = false
  let conn: DataConnection | null = null

  const stop = () => {
    stopped = true
    try {
      conn?.close()
    } catch {
      // ignore
    }
    try {
      peer.destroy()
    } catch {
      // ignore
    }
  }

  await new Promise<void>((resolve, reject) => {
    peer.on('open', () => resolve())
    peer.on('error', (err) => reject(err))
    window.setTimeout(() => reject(new Error('No se pudo iniciar la conexión')), 15000)
  })

  handlers.onStatus('Conectando con el PC…')
  conn = peer.connect(peerIdFromCode(clean), { reliable: true })

  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('No hay respuesta del PC. ¿Código correcto y misma Wi‑Fi?')), 20000)
    conn!.on('open', () => {
      window.clearTimeout(timer)
      resolve()
    })
    conn!.on('error', (err) => {
      window.clearTimeout(timer)
      reject(err)
    })
  })

  if (stopped) {
    stop()
    return { stop }
  }

  handlers.onStatus('Conectado. Recibiendo…')
  // Reenviar ready hasta que el PC responda con hello (evita carrera de listeners)
  const readyPulse = window.setInterval(() => {
    try {
      conn?.send({ t: 'ready' } satisfies JsonMsg)
    } catch {
      // ignore
    }
  }, 400)

  void receiveLibrary(conn, handlers, () => stopped, () => {
    window.clearInterval(readyPulse)
  }).finally(() => {
    window.clearInterval(readyPulse)
    if (!stopped) stop()
  })

  return { stop }
}

async function receiveLibrary(
  conn: DataConnection,
  handlers: ClientHandlers,
  isStopped: () => boolean,
  onHello?: () => void,
) {
  let expected = 0
  let imported = 0
  const visibleFiles: { fileName: string; blob: Blob }[] = []
  let current: {
    meta: Extract<JsonMsg, { t: 'track-start' }>
    parts: Uint8Array[]
    received: number
  } | null = null

  const queue: unknown[] = []
  let waiting: (() => void) | null = null

  conn.on('data', (data) => {
    queue.push(data)
    waiting?.()
    waiting = null
  })

  const nextData = () =>
    new Promise<unknown>((resolve) => {
      if (queue.length) {
        resolve(queue.shift())
        return
      }
      waiting = () => resolve(queue.shift())
    })

  conn.send({ t: 'ready' } satisfies JsonMsg)

  try {
    while (!isStopped()) {
      const data = await nextData()

      if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
        if (!current) continue
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
        current.parts.push(bytes)
        current.received += bytes.byteLength
        continue
      }

      if (!isJsonMsg(data)) continue

      if (data.t === 'error') {
        handlers.onError(data.message)
        return
      }

      if (data.t === 'hello') {
        onHello?.()
        if (data.v !== PROTOCOL) {
          handlers.onError('Versión de transferencia incompatible. Actualiza MyVibe en ambos.')
          return
        }
        expected = data.trackCount
        handlers.onStatus(`Recibiendo ${expected} canciones…`)
        continue
      }

      if (data.t === 'track-start') {
        current = { meta: data, parts: [], received: 0 }
        handlers.onProgress(data.i, expected || data.i + 1, data.title)
        continue
      }

      if (data.t === 'chunk-info') {
        // informativo; el binario llega justo después
        continue
      }

      if (data.t === 'track-end') {
        if (!current || current.meta.i !== data.i) continue
        const meta = current.meta
        const total = meta.size
        const merged = new Uint8Array(total)
        let offset = 0
        for (const part of current.parts) {
          merged.set(part, offset)
          offset += part.byteLength
        }
        current = null

        try {
          const blob = new Blob(
            [merged.buffer.slice(merged.byteOffset, merged.byteOffset + merged.byteLength)],
            {
              type: meta.mimeType || 'audio/mpeg',
            },
          )
          const existing = (await db.tracks.toArray()).find((t) =>
            tracksLookSame(t, {
              title: meta.title,
              artist: meta.artist || '',
              duration: meta.duration || 0,
              fileName: meta.fileName || '',
            }),
          )
          const id = existing?.id ?? createId()
          await saveAudioBlob(id, blob)
          const track: Track = {
            id,
            title: meta.title,
            artist: meta.artist || 'Artista desconocido',
            album: meta.album || 'Sin álbum',
            genre: meta.genre || '',
            year: meta.year || '',
            duration: meta.duration || 0,
            mimeType: meta.mimeType || 'audio/mpeg',
            fileName: meta.fileName || `${meta.title}.mp3`,
            hasCover: existing?.hasCover ?? false,
            liked: existing?.liked ?? false,
            playCount: existing?.playCount ?? 0,
            lastPlayedAt: existing?.lastPlayedAt ?? null,
            createdAt: existing?.createdAt ?? Date.now(),
            enriched: existing?.enriched ?? false,
            hasLocalAudio: true,
          }
          await db.tracks.put(track)
          visibleFiles.push({
            fileName:
              meta.fileName && /\.mp3$/i.test(meta.fileName)
                ? `MyVibe - ${meta.fileName}`
                : `MyVibe - ${meta.artist || 'Artista'} - ${meta.title}.mp3`,
            blob,
          })
          imported += 1
        } catch (e) {
          console.warn('Fallo al guardar pista', e)
        }
        continue
      }

      if (data.t === 'done') {
        handlers.onStatus(`Listo: ${imported} canciones importadas`)
        handlers.onFinished(imported, visibleFiles)
        return
      }
    }
  } catch (e) {
    handlers.onError(e instanceof Error ? e.message : 'Error al recibir')
  }
}
