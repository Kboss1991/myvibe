import Peer, { type DataConnection, type PeerJSOption } from 'peerjs'
import { db } from '../db'
import { createId } from './fileImport'
import { getAudioBlob, saveAudioBlob } from './library'
import { tracksLookSame } from './trackDedupe'
import type { Playlist, Track } from '../types'

/** v2: playlists + ids estables del PC */
const PROTOCOL = 2
const CHUNK = 256 * 1024
const PEER_PREFIX = 'mv'

export function makeTransferCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000))
}

export function peerIdFromCode(code: string): string {
  const clean = code.replace(/\D/g, '').slice(0, 6)
  return `${PEER_PREFIX}${clean}`
}

/** Opciones PeerJS más tolerantes (Chrome Windows ↔ iPhone). */
export function peerOptions(): PeerJSOption {
  return {
    debug: 0,
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
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
  | { t: 'playlists'; items: PlaylistWire[] }
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

/** PC: espera al móvil y envía la biblioteca + playlists. */
export async function startWifiHost(
  handlers: HostHandlers,
): Promise<HostSession> {
  const code = makeTransferCode()
  const peer = new Peer(peerIdFromCode(code), peerOptions())

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
    handlers.onStatus(
      'Esperando al móvil… En el iPhone: Perfil → introducir este código (misma Wi‑Fi).',
    )
  })

  peer.on('connection', (c) => {
    if (conn) {
      c.close()
      return
    }
    conn = c
    const readyPromise = waitForMsg(c, 'ready', 60000)
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
    const all = await db.tracks.toArray()
    const tracks: Track[] = []
    for (const t of all) {
      if (t.hasLocalAudio === false) continue
      if (await getAudioBlob(t.id)) tracks.push(t)
    }
    if (!tracks.length) {
      conn.send({ t: 'error', message: 'No hay canciones con audio en el PC' } satisfies JsonMsg)
      handlers.onError('No hay canciones para enviar')
      return
    }

    const playlists = await db.playlists.toArray()
    const wire: PlaylistWire[] = playlists.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description || '',
      trackIds: p.trackIds.filter((id) => tracks.some((t) => t.id === id)),
      themeColor: p.themeColor,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    }))

    handlers.onStatus(`Conectado. Enviando ${tracks.length} canciones…`)
    conn.send({
      t: 'hello',
      v: PROTOCOL,
      trackCount: tracks.length,
    } satisfies JsonMsg)
    conn.send({ t: 'playlists', items: wire } satisfies JsonMsg)

    for (let i = 0; i < tracks.length; i++) {
      if (isStopped()) return
      const track = tracks[i]!
      handlers.onProgress(i, tracks.length, track.title)

      const audio = await getAudioBlob(track.id)
      if (!audio) continue
      const totalSize = audio.size

      conn.send({
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
      } satisfies JsonMsg)

      for (let offset = 0; offset < totalSize; offset += CHUNK) {
        if (isStopped()) return
        const end = Math.min(offset + CHUNK, totalSize)
        const part = audio.slice(offset, end)
        const ab = await part.arrayBuffer()
        conn.send({
          t: 'chunk-info',
          i,
          offset,
          total: totalSize,
        } satisfies JsonMsg)
        conn.send(ab)
        await new Promise((r) => setTimeout(r, totalSize > 80_000_000 ? 2 : 0))
      }

      conn.send({ t: 'track-end', i } satisfies JsonMsg)
    }

    conn.send({ t: 'done' } satisfies JsonMsg)
    handlers.onProgress(tracks.length, tracks.length, '')
    handlers.onStatus(
      `Envío terminado · ${tracks.length} canciones` +
        (wire.length ? ` · ${wire.length} playlists` : ''),
    )
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
    playlists?: number,
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

  const peer = new Peer(peerOptions())
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
    window.setTimeout(
      () => reject(new Error('No se pudo iniciar PeerJS. Revisa la conexión a internet.')),
      20000,
    )
  })

  handlers.onStatus('Conectando con el PC…')
  conn = peer.connect(peerIdFromCode(clean), { reliable: true })

  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(
      () =>
        reject(
          new Error(
            'No hay respuesta del PC. Comprueba: código correcto, misma Wi‑Fi, y en el PC el modo “Compartir por código” activo.',
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

  if (stopped) {
    stop()
    return { stop }
  }

  handlers.onStatus('Conectado. Recibiendo…')
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
  let playlistsIn = 0
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

      if (data instanceof ArrayBuffer || data instanceof Uint8Array || (typeof Blob !== 'undefined' && data instanceof Blob)) {
        if (!current) continue
        const bytes =
          data instanceof Uint8Array
            ? data
            : data instanceof Blob
              ? new Uint8Array(await data.arrayBuffer())
              : new Uint8Array(data)
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
        if (data.v < 1 || data.v > PROTOCOL) {
          handlers.onError(
            'Versión incompatible. En el PC abre MyVibe con el código nuevo (no la web antigua de Vercel).',
          )
          return
        }
        expected = data.trackCount
        handlers.onStatus(`Recibiendo ${expected} canciones…`)
        continue
      }

      if (data.t === 'playlists') {
        const now = Date.now()
        for (const item of data.items) {
          const row: Playlist = {
            id: item.id,
            name: item.name || 'Playlist',
            description: item.description || '',
            trackIds: item.trackIds || [],
            hasCover: false,
            themeColor: item.themeColor,
            createdAt: item.createdAt || now,
            updatedAt: item.updatedAt || now,
          }
          await db.playlists.put(row)
          playlistsIn += 1
        }
        if (playlistsIn) {
          handlers.onStatus(`Playlists: ${playlistsIn}. Descargando audio…`)
        }
        continue
      }

      if (data.t === 'track-start') {
        current = { meta: data, parts: [], received: 0 }
        handlers.onProgress(data.i, expected || data.i + 1, data.title)
        continue
      }

      if (data.t === 'chunk-info') {
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

        if (offset < total * 0.98) {
          console.warn('Pista incompleta', meta.title, offset, total)
          continue
        }

        try {
          const blob = new Blob(
            [merged.buffer.slice(merged.byteOffset, merged.byteOffset + merged.byteLength)],
            {
              type: meta.mimeType || 'audio/mpeg',
            },
          )
          const preferredId = meta.id || ''
          const existingById = preferredId ? await db.tracks.get(preferredId) : undefined
          const existing =
            existingById ??
            (await db.tracks.toArray()).find((t) =>
              tracksLookSame(t, {
                title: meta.title,
                artist: meta.artist || '',
                duration: meta.duration || 0,
                fileName: meta.fileName || '',
              }),
            )
          const id = preferredId || existing?.id || createId()
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
            liked: meta.liked ?? existing?.liked ?? false,
            playCount: existing?.playCount ?? 0,
            lastPlayedAt: existing?.lastPlayedAt ?? null,
            createdAt: existing?.createdAt ?? Date.now(),
            enriched: existing?.enriched ?? false,
            hasLocalAudio: true,
            origin: 'local',
            audioBytes: blob.size,
            audioUpdatedAt: Date.now(),
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
        handlers.onStatus(
          `Listo: ${imported} canciones` +
            (playlistsIn ? ` · ${playlistsIn} playlists` : ''),
        )
        handlers.onFinished(imported, visibleFiles, playlistsIn)
        return
      }
    }
  } catch (e) {
    handlers.onError(e instanceof Error ? e.message : 'Error al recibir')
  }
}
