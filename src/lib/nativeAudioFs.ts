import { Capacitor } from '@capacitor/core'
import { Directory, Filesystem } from '@capacitor/filesystem'

const AUDIO_DIR = 'myvibe/audio'
const COVER_DIR = 'myvibe/covers'
const WRITE_CHUNK = 512 * 1024

export function isNativeApp(): boolean {
  try {
    return Capacitor.isNativePlatform()
  } catch {
    return false
  }
}

function audioPath(id: string): string {
  return `${AUDIO_DIR}/${id}.bin`
}

function coverPath(id: string): string {
  return `${COVER_DIR}/${id}.jpg`
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) {
    const slice = bytes.subarray(i, Math.min(i + step, bytes.length))
    binary += String.fromCharCode(...slice)
  }
  return btoa(binary)
}

async function blobChunkToBase64(blob: Blob): Promise<string> {
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()))
}

async function ensureParentDirs(path: string): Promise<void> {
  const parts = path.split('/')
  parts.pop()
  let cur = ''
  for (const part of parts) {
    cur = cur ? `${cur}/${part}` : part
    try {
      await Filesystem.mkdir({
        path: cur,
        directory: Directory.Documents,
        recursive: true,
      })
    } catch {
      // ya existe
    }
  }
}

/** Escribe audio en Documents privados de la app (nativo). */
export async function writeNativeAudio(id: string, blob: Blob): Promise<void> {
  const path = audioPath(id)
  await ensureParentDirs(path)
  // Borrar previo si existe (writeFile no siempre trunca bien en append scenarios)
  try {
    await Filesystem.deleteFile({ path, directory: Directory.Documents })
  } catch {
    /* ignore */
  }

  if (blob.size <= WRITE_CHUNK * 2) {
    await Filesystem.writeFile({
      path,
      data: await blobChunkToBase64(blob),
      directory: Directory.Documents,
      recursive: true,
    })
    return
  }

  // Archivos grandes: trozos en base64 para no OOM
  let offset = 0
  let first = true
  while (offset < blob.size) {
    const end = Math.min(offset + WRITE_CHUNK, blob.size)
    const part = blob.slice(offset, end)
    const data = await blobChunkToBase64(part)
    if (first) {
      await Filesystem.writeFile({
        path,
        data,
        directory: Directory.Documents,
        recursive: true,
      })
      first = false
    } else {
      await Filesystem.appendFile({
        path,
        data,
        directory: Directory.Documents,
      })
    }
    offset = end
  }
}

export async function readNativeAudioBlob(id: string): Promise<Blob | null> {
  try {
    const res = await Filesystem.stat({
      path: audioPath(id),
      directory: Directory.Documents,
    })
    if (!res || (typeof res.size === 'number' && res.size <= 0)) return null
  } catch {
    return null
  }

  try {
    const file = await Filesystem.readFile({
      path: audioPath(id),
      directory: Directory.Documents,
    })
    const data = file.data
    if (typeof data === 'string') {
      const binary = atob(data)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      return new Blob([bytes], { type: 'audio/mpeg' })
    }
    if (data instanceof Blob) return data
    return null
  } catch {
    return null
  }
}

/** URI nativa → URL usable en <audio src> (sin cargar el MP3 en RAM). */
export async function getNativeAudioSrc(id: string): Promise<string | null> {
  try {
    const { uri } = await Filesystem.getUri({
      path: audioPath(id),
      directory: Directory.Documents,
    })
    if (!uri) return null
    // Confirmar que existe
    await Filesystem.stat({ path: audioPath(id), directory: Directory.Documents })
    return Capacitor.convertFileSrc(uri)
  } catch {
    return null
  }
}

export async function deleteNativeAudio(id: string): Promise<void> {
  try {
    await Filesystem.deleteFile({
      path: audioPath(id),
      directory: Directory.Documents,
    })
  } catch {
    /* ignore */
  }
}

export async function writeNativeCover(id: string, blob: Blob): Promise<void> {
  const path = coverPath(id)
  await ensureParentDirs(path)
  try {
    await Filesystem.deleteFile({ path, directory: Directory.Documents })
  } catch {
    /* ignore */
  }
  await Filesystem.writeFile({
    path,
    data: await blobChunkToBase64(blob),
    directory: Directory.Documents,
    recursive: true,
  })
}

export async function readNativeCoverBlob(id: string): Promise<Blob | null> {
  try {
    const file = await Filesystem.readFile({
      path: coverPath(id),
      directory: Directory.Documents,
    })
    const data = file.data
    if (typeof data === 'string') {
      const binary = atob(data)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      return new Blob([bytes], { type: 'image/jpeg' })
    }
    if (data instanceof Blob) return data
    return null
  } catch {
    return null
  }
}

export async function getNativeCoverSrc(id: string): Promise<string | null> {
  try {
    const { uri } = await Filesystem.getUri({
      path: coverPath(id),
      directory: Directory.Documents,
    })
    if (!uri) return null
    await Filesystem.stat({ path: coverPath(id), directory: Directory.Documents })
    return Capacitor.convertFileSrc(uri)
  } catch {
    return null
  }
}

export async function deleteNativeCover(id: string): Promise<void> {
  try {
    await Filesystem.deleteFile({
      path: coverPath(id),
      directory: Directory.Documents,
    })
  } catch {
    /* ignore */
  }
}

export type NativeAppendWriter = {
  write: (chunk: Uint8Array | ArrayBuffer | Blob) => Promise<void>
  close: () => Promise<void>
  abort: () => Promise<void>
  bytesWritten: () => number
}

/** Streaming PC→móvil en nativo: escribe directo a Documents. */
export async function beginNativeAudioWrite(id: string): Promise<NativeAppendWriter> {
  const path = audioPath(id)
  await ensureParentDirs(path)
  try {
    await Filesystem.deleteFile({ path, directory: Directory.Documents })
  } catch {
    /* ignore */
  }
  let written = 0
  let closed = false
  let started = false
  /** Acumula ~256 KiB antes de base64+bridge (menos picos de RAM/CPU). */
  let pending: Uint8Array[] = []
  let pendingBytes = 0
  const FLUSH_AT = 256 * 1024

  const flush = async () => {
    if (!pendingBytes) return
    let merged: Uint8Array
    if (pending.length === 1) {
      merged = pending[0]!
    } else {
      merged = new Uint8Array(pendingBytes)
      let o = 0
      for (const p of pending) {
        merged.set(p, o)
        o += p.byteLength
      }
    }
    pending = []
    pendingBytes = 0
    const data = bytesToBase64(merged)
    if (!started) {
      await Filesystem.writeFile({
        path,
        data,
        directory: Directory.Documents,
        recursive: true,
      })
      started = true
    } else {
      await Filesystem.appendFile({
        path,
        data,
        directory: Directory.Documents,
      })
    }
  }

  return {
    write: async (chunk) => {
      if (closed) return
      let bytes: Uint8Array
      if (chunk instanceof Blob) {
        bytes = new Uint8Array(await chunk.arrayBuffer())
      } else if (chunk instanceof ArrayBuffer) {
        bytes = new Uint8Array(chunk)
      } else {
        // Copia propia: el buffer de PeerJS puede reutilizarse
        bytes = new Uint8Array(chunk.byteLength)
        bytes.set(chunk)
      }
      pending.push(bytes)
      pendingBytes += bytes.byteLength
      written += bytes.byteLength
      if (pendingBytes >= FLUSH_AT) await flush()
    },
    close: async () => {
      if (closed) return
      await flush()
      closed = true
    },
    abort: async () => {
      closed = true
      pending = []
      pendingBytes = 0
      try {
        await Filesystem.deleteFile({ path, directory: Directory.Documents })
      } catch {
        /* ignore */
      }
    },
    bytesWritten: () => written,
  }
}

export async function nativeAudioExists(id: string): Promise<boolean> {
  try {
    const st = await Filesystem.stat({
      path: audioPath(id),
      directory: Directory.Documents,
    })
    return typeof st.size === 'number' ? st.size > 0 : true
  } catch {
    return false
  }
}

/** Tamaño en disco sin leer el MP3 a RAM (crítico en transferencias largas). */
export async function nativeAudioByteSize(id: string): Promise<number> {
  try {
    const st = await Filesystem.stat({
      path: audioPath(id),
      directory: Directory.Documents,
    })
    return typeof st.size === 'number' ? st.size : 0
  } catch {
    return 0
  }
}
