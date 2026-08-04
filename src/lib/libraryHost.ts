import Peer, { type DataConnection } from 'peerjs'
import {
  clearDevicePeer,
  getDevicePeer,
  publishDevicePeer,
} from './cloudLibrary'
import { getAudioBlob, getCoverBlob, saveAudioBlob, saveCoverBlob, enrichTrackOnline } from './library'
import { db } from '../db'
import { myVibeDownloadName, type VisibleFile } from './visibleStorage'
import { isAppleMobile } from './folderImport'
import { findBestTrackMatch } from './trackDedupe'
import type { Track } from '../types'

const PROTOCOL = 3
const CHUNK = 256 * 1024
const PEER_PREFIX = 'mvh'

type TrackHint = {
  id: string
  title?: string
  artist?: string
  fileName?: string
  duration?: number
}

type JsonMsg =
  | { t: 'hello'; v: number }
  | { t: 'ready' }
  | { t: 'req-tracks'; ids: string[]; hints?: TrackHint[] }
  | {
      t: 'track-start'
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
      enriched?: boolean
      hasCover?: boolean
    }
  | { t: 'chunk-info'; id: string; offset: number; total: number }
  | { t: 'track-end'; id: string }
  | {
      t: 'cover-start'
      id: string
      size: number
      mimeType: string
    }
  | { t: 'cover-end'; id: string }
  | { t: 'done' }
  | { t: 'error'; message: string }

function isJsonMsg(data: unknown): data is JsonMsg {
  return !!data && typeof data === 'object' && 't' in (data as object)
}

function makePeerId(userId: string): string {
  const clean = userId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 28)
  const rnd = Math.random().toString(36).slice(2, 8)
  return `${PEER_PREFIX}${clean}${rnd}`.slice(0, 60)
}

function isBinaryChunk(data: unknown): data is ArrayBuffer | Uint8Array | Blob {
  return (
    data instanceof ArrayBuffer ||
    data instanceof Uint8Array ||
    (typeof Blob !== 'undefined' && data instanceof Blob)
  )
}

async function toUint8(data: ArrayBuffer | Uint8Array | Blob): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return new Uint8Array(await data.arrayBuffer())
}

export type LibraryHostSession = {
  peerId: string
  stop: () => void
}

/** PC: publica peer y sirve canciones bajo demanda al móvil. */
export async function startLibraryHost(userId: string): Promise<LibraryHostSession> {
  const peerId = makePeerId(userId)
  const peer = new Peer(peerId, { debug: 0 })
  let stopped = false

  const stop = () => {
    stopped = true
    try {
      peer.destroy()
    } catch {
      // ignore
    }
    void clearDevicePeer(userId)
  }

  await new Promise<void>((resolve, reject) => {
    peer.on('open', () => resolve())
    peer.on('error', (err) => reject(err))
    window.setTimeout(() => reject(new Error('No se pudo abrir el host Wi‑Fi')), 20000)
  })

  await publishDevicePeer(userId, peerId, isAppleMobile() ? 'Móvil' : 'PC')

  peer.on('connection', (conn) => {
    conn.on('open', () => {
      conn.send({ t: 'hello', v: PROTOCOL } satisfies JsonMsg)
    })
    conn.on('data', (data) => {
      if (!isJsonMsg(data)) return
      if (data.t === 'req-tracks') {
        void sendTracks(conn, data.ids, () => stopped, data.hints)
      }
    })
  })

  // Renueva presencia cada 40s
  const beat = window.setInterval(() => {
    if (stopped) return
    void publishDevicePeer(userId, peerId, isAppleMobile() ? 'Móvil' : 'PC')
  }, 40000)

  const origStop = stop
  return {
    peerId,
    stop: () => {
      window.clearInterval(beat)
      origStop()
    },
  }
}

async function resolveLocalTrack(
  id: string,
  hint?: TrackHint,
): Promise<Track | null> {
  const byId = await db.tracks.get(id)
  if (byId && byId.hasLocalAudio !== false) {
    const audio = await getAudioBlob(id)
    if (audio) return byId
  }

  const all = (await db.tracks.toArray()).filter((t) => t.hasLocalAudio !== false)
  const probe = {
    title: hint?.title || byId?.title || '',
    artist: hint?.artist || byId?.artist || '',
    duration: hint?.duration || byId?.duration || 0,
    fileName: hint?.fileName || byId?.fileName || '',
  }

  if (probe.title || probe.fileName) {
    const match = findBestTrackMatch(
      all.filter((t) => t.id !== id),
      probe,
    )
    if (match && (await getAudioBlob(match.id))) return match
  }

  return null
}

async function sendTracks(
  conn: DataConnection,
  ids: string[],
  isStopped: () => boolean,
  hints?: TrackHint[],
) {
  try {
    const localAudioCount = (await db.tracks.toArray()).filter(
      (t) => t.hasLocalAudio !== false,
    ).length
    if (localAudioCount === 0) {
      conn.send({
        t: 'error',
        message:
          'Este PC no tiene canciones con audio. Importa la música en el ordenador y pulsa Actualizar.',
      } satisfies JsonMsg)
      conn.send({ t: 'done' } satisfies JsonMsg)
      return
    }

    const hintMap = new Map((hints || []).map((h) => [h.id, h]))
    for (const requestedId of ids) {
      if (isStopped()) return
      const track = await resolveLocalTrack(requestedId, hintMap.get(requestedId))
      const audio = track ? await getAudioBlob(track.id) : null
      if (!track || !audio) {
        const hint = hintMap.get(requestedId)
        const label = hint?.title || requestedId.slice(0, 8)
        conn.send({
          t: 'error',
          message: `No está en este PC: ${label}. ¿Misma cuenta y biblioteca importada en el PC?`,
        } satisfies JsonMsg)
        continue
      }
      const buf = new Uint8Array(await audio.arrayBuffer())
      // El móvil guarda con el id que conoce (stub), aunque en PC sea otro
      const outId = requestedId
      const cover = track.hasCover ? await getCoverBlob(track.id) : null
      const coverBuf = cover ? new Uint8Array(await cover.arrayBuffer()) : null
      conn.send({
        t: 'track-start',
        id: outId,
        title: track.title,
        artist: track.artist,
        album: track.album,
        genre: track.genre,
        year: track.year,
        mimeType: track.mimeType || audio.type || 'audio/mpeg',
        fileName: track.fileName || `${track.title}.mp3`,
        size: buf.byteLength,
        duration: track.duration || 0,
        enriched: Boolean(track.enriched),
        hasCover: Boolean(coverBuf?.byteLength),
      } satisfies JsonMsg)

      for (let offset = 0; offset < buf.byteLength; offset += CHUNK) {
        if (isStopped()) return
        const end = Math.min(offset + CHUNK, buf.byteLength)
        const slice = buf.subarray(offset, end)
        conn.send({
          t: 'chunk-info',
          id: outId,
          offset,
          total: buf.byteLength,
        } satisfies JsonMsg)
        conn.send(slice.slice().buffer)
        await new Promise((r) => setTimeout(r, 8))
      }
      conn.send({ t: 'track-end', id: outId } satisfies JsonMsg)

      // Carátula justo después del audio (metadatos ya van en track-start)
      if (coverBuf && coverBuf.byteLength && cover) {
        conn.send({
          t: 'cover-start',
          id: outId,
          size: coverBuf.byteLength,
          mimeType: cover.type || 'image/jpeg',
        } satisfies JsonMsg)
        for (let offset = 0; offset < coverBuf.byteLength; offset += CHUNK) {
          if (isStopped()) return
          const end = Math.min(offset + CHUNK, coverBuf.byteLength)
          const slice = coverBuf.subarray(offset, end)
          conn.send({
            t: 'chunk-info',
            id: outId,
            offset,
            total: coverBuf.byteLength,
          } satisfies JsonMsg)
          conn.send(slice.slice().buffer)
          await new Promise((r) => setTimeout(r, 4))
        }
        conn.send({ t: 'cover-end', id: outId } satisfies JsonMsg)
      }
    }
    conn.send({ t: 'done' } satisfies JsonMsg)
  } catch (e) {
    conn.send({
      t: 'error',
      message: e instanceof Error ? e.message : 'Error al enviar',
    } satisfies JsonMsg)
    conn.send({ t: 'done' } satisfies JsonMsg)
  }
}

export type DownloadHandlers = {
  onStatus: (msg: string) => void
  onProgress: (
    done: number,
    total: number,
    name: string,
    detail?: { trackId: string; percent: number },
  ) => void
  onError: (msg: string) => void
}

/**
 * Móvil: pide canciones al PC de la misma cuenta (Wi‑Fi / PeerJS),
 * las guarda en la biblioteca y en la carpeta visible.
 */
export async function downloadTracksFromPc(
  userId: string,
  trackIds: string[],
  handlers: DownloadHandlers,
): Promise<{ imported: number; visibleFiles: VisibleFile[] }> {
  if (!trackIds.length) return { imported: 0, visibleFiles: [] }

  handlers.onStatus('Buscando tu PC…')
  const peerInfo = await getDevicePeer(userId)
  if (!peerInfo) {
    throw new Error(
      'No hay un PC en línea. Abre MyVibe en el ordenador con la misma cuenta (misma Wi‑Fi).',
    )
  }
  if (/móvil|movil|android|iphone|ipad/i.test(peerInfo.label)) {
    throw new Error(
      'El dispositivo en línea no es un PC. Abre MyVibe en el ordenador, deja la pestaña abierta y pulsa Actualizar.',
    )
  }
  // Peer “caducado” si > 3 min sin heartbeat
  const age = Date.now() - Date.parse(peerInfo.updatedAt)
  if (Number.isFinite(age) && age > 3 * 60 * 1000) {
    throw new Error(
      'El PC parece desconectado. Abre MyVibe en el PC e inténtalo de nuevo.',
    )
  }

  const peer = new Peer({ debug: 0 })
  let conn: DataConnection | null = null

  const cleanup = () => {
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

  try {
    await new Promise<void>((resolve, reject) => {
      peer.on('open', () => resolve())
      peer.on('error', (err) => reject(err))
      window.setTimeout(() => reject(new Error('No se pudo iniciar la conexión')), 15000)
    })

    handlers.onStatus(`Conectando con ${peerInfo.label}…`)
    conn = peer.connect(peerInfo.peerId, { reliable: true })

    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(
        () => reject(new Error('Sin respuesta del PC. ¿Misma Wi‑Fi y MyVibe abierto?')),
        25000,
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

    handlers.onStatus('Pidiendo canciones…')
    const hints: TrackHint[] = []
    for (const id of trackIds) {
      const t = await db.tracks.get(id)
      hints.push({
        id,
        title: t?.title,
        artist: t?.artist,
        fileName: t?.fileName,
        duration: t?.duration,
      })
    }
    conn.send({ t: 'req-tracks', ids: trackIds, hints } satisfies JsonMsg)

    let current: {
      meta: Extract<JsonMsg, { t: 'track-start' }>
      parts: Uint8Array[]
    } | null = null
    let currentCover: {
      id: string
      size: number
      mimeType: string
      parts: Uint8Array[]
    } | null = null
    const savedVisible: VisibleFile[] = []
    let imported = 0
    const total = trackIds.length
    const pcErrors: string[] = []
    let gotDone = false
    // Por canción: 3 min de inactividad. Antes el timeout global de 2 min
    // cortaba lotes grandes y dejaba carátulas sin audio.
    let idleTimer: number | null = null
    const bumpIdle = () => {
      if (idleTimer != null) window.clearTimeout(idleTimer)
      idleTimer = window.setTimeout(() => {
        queue.push({ t: 'done' } satisfies JsonMsg)
        waiting?.()
        waiting = null
      }, 180_000)
    }
    bumpIdle()

    try {
      while (true) {
        const data = await nextData()
        bumpIdle()

        if (isBinaryChunk(data)) {
          const bytes = await toUint8(data)
          if (currentCover) {
            currentCover.parts.push(bytes)
          } else if (current) {
            current.parts.push(bytes)
            const received = current.parts.reduce((n, p) => n + p.byteLength, 0)
            const size = Math.max(1, current.meta.size)
            const percent = Math.min(99, Math.round((received / size) * 100))
            handlers.onProgress(imported, total, current.meta.title, {
              trackId: current.meta.id,
              percent,
            })
          }
          continue
        }
        if (!isJsonMsg(data)) continue

        if (data.t === 'error') {
          pcErrors.push(data.message)
          handlers.onStatus(data.message)
          handlers.onError(data.message)
          continue
        }
        if (data.t === 'hello') {
          if (data.v !== PROTOCOL) {
            throw new Error('Actualiza MyVibe en el PC y en el móvil')
          }
          continue
        }
        if (data.t === 'track-start') {
          current = { meta: data, parts: [] }
          currentCover = null
          handlers.onProgress(imported, total, data.title, {
            trackId: data.id,
            percent: 0,
          })
          continue
        }
        if (data.t === 'chunk-info') {
          if (
            current &&
            !currentCover &&
            data.id === current.meta.id &&
            data.total > 0
          ) {
            const percent = Math.min(
              99,
              Math.round(((data.offset + 1) / data.total) * 100),
            )
            handlers.onProgress(imported, total, current.meta.title, {
              trackId: data.id,
              percent,
            })
          }
          continue
        }
        if (data.t === 'track-end') {
          if (!current || current.meta.id !== data.id) continue
          const meta = current.meta
          handlers.onProgress(imported, total, meta.title, {
            trackId: meta.id,
            percent: 99,
          })
          const received = current.parts.reduce((n, p) => n + p.byteLength, 0)
          if (received < meta.size * 0.98 || received < 1024) {
            pcErrors.push(
              `Transferencia incompleta: ${meta.title} (${received}/${meta.size} bytes)`,
            )
            current = null
            continue
          }
          const merged = new Uint8Array(received)
          let offset = 0
          for (const part of current.parts) {
            merged.set(part, offset)
            offset += part.byteLength
          }
          current = null
          // Copiar bytes a un buffer propio (Safari a veces falla con vistas)
          const exact = merged.slice()
          const blob = new Blob([exact], {
            type: meta.mimeType || 'audio/mpeg',
          })
          // Copia para biblioteca + otra para Archivos (no compartir el mismo buffer)
          const libraryBlob = blob.slice(0, blob.size, blob.type || 'audio/mpeg')
          const visibleBlob = blob.slice(0, blob.size, blob.type || 'audio/mpeg')
          await saveAudioBlob(meta.id, libraryBlob)
          const verified = await getAudioBlob(meta.id)
          if (!verified || verified.size < libraryBlob.size * 0.98) {
            pcErrors.push(`No se pudo guardar el audio: ${meta.title}`)
            await db.tracks.update(meta.id, { hasLocalAudio: false })
            continue
          }
          const prev = await db.tracks.get(meta.id)
          const now = Date.now()
          await db.tracks.put({
            id: meta.id,
            title: meta.title || prev?.title || 'Sin título',
            artist: meta.artist || prev?.artist || 'Artista desconocido',
            album: meta.album || prev?.album || 'Sin álbum',
            genre: meta.genre || prev?.genre || '',
            year: meta.year || prev?.year || '',
            duration: meta.duration || prev?.duration || 0,
            mimeType: meta.mimeType || 'audio/mpeg',
            fileName: meta.fileName || prev?.fileName || `${meta.title}.mp3`,
            hasCover: prev?.hasCover ?? false,
            liked: prev?.liked ?? false,
            playCount: prev?.playCount ?? 0,
            lastPlayedAt: prev?.lastPlayedAt ?? null,
            createdAt: prev?.createdAt ?? now,
            enriched: Boolean(meta.enriched || prev?.enriched),
            externalUrl: prev?.externalUrl,
            hasLocalAudio: true,
            origin: 'cloud',
            audioUpdatedAt: now,
            needsAudioUpdate: false,
            cloudAudioSeenAt: now,
            audioBytes: libraryBlob.size,
          })
          savedVisible.push({
            fileName: myVibeDownloadName(meta.artist, meta.title, meta.fileName),
            blob: visibleBlob,
          })
          imported += 1
          handlers.onProgress(imported, total, meta.title, {
            trackId: meta.id,
            percent: 100,
          })
          // Si el PC no mandó carátula, buscar online en el móvil
          if (!meta.hasCover) {
            try {
              await enrichTrackOnline(meta.id)
            } catch {
              // best-effort
            }
          }
          continue
        }
        if (data.t === 'cover-start') {
          currentCover = {
            id: data.id,
            size: data.size,
            mimeType: data.mimeType || 'image/jpeg',
            parts: [],
          }
          continue
        }
        if (data.t === 'cover-end') {
          if (!currentCover || currentCover.id !== data.id) {
            currentCover = null
            continue
          }
          const coverMeta = currentCover
          const received = coverMeta.parts.reduce((n, p) => n + p.byteLength, 0)
          currentCover = null
          if (received < coverMeta.size * 0.9) continue
          const merged = new Uint8Array(received)
          let offset = 0
          for (const part of coverMeta.parts) {
            merged.set(part, offset)
            offset += part.byteLength
          }
          const coverBlob = new Blob(
            [merged.buffer.slice(merged.byteOffset, merged.byteOffset + merged.byteLength)],
            { type: coverMeta.mimeType },
          )
          try {
            await saveCoverBlob(coverMeta.id, coverBlob)
            await db.tracks.update(coverMeta.id, { hasCover: true, enriched: true })
          } catch {
            // carátula opcional
          }
          continue
        }
        if (data.t === 'done') {
          gotDone = true
          break
        }
      }
    } finally {
      if (idleTimer != null) window.clearTimeout(idleTimer)
    }

    if (imported === 0) {
      const detail = pcErrors[0] || (!gotDone ? 'La transferencia se cortó' : '')
      throw new Error(
        detail
          ? `No se pudo descargar. ${detail}`
          : 'No se descargó ninguna. En el PC: misma cuenta, pestaña abierta en myvibe-wheat.vercel.app y pulsa Actualizar.',
      )
    }

    handlers.onStatus(`Descargadas ${imported} canciones`)
    return { imported, visibleFiles: savedVisible }
  } finally {
    cleanup()
  }
}
