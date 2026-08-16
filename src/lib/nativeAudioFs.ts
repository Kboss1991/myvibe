import { Capacitor } from '@capacitor/core'
import { Directory, Filesystem } from '@capacitor/filesystem'

const AUDIO_DIR = 'myvibe/audio'
const COVER_DIR = 'myvibe/covers'
const WRITE_CHUNK = 258 * 1024 // múltiplo de 3 (base64-safe)

export function isNativeApp(): boolean {
  try {
    return Capacitor.isNativePlatform()
  } catch {
    return false
  }
}

/** Extensión .mp3: WKWebView / AVFoundation decodifican mal los .bin. */
function audioPathMp3(id: string): string {
  return `${AUDIO_DIR}/${id}.mp3`
}

/** Legacy: builds anteriores guardaban como .bin */
function audioPathBin(id: string): string {
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

async function pathExists(path: string): Promise<boolean> {
  try {
    const st = await Filesystem.stat({ path, directory: Directory.Documents })
    return typeof st.size === 'number' ? st.size > 0 : true
  } catch {
    return false
  }
}

/**
 * Ruta real en disco. Migra .bin → .mp3 la primera vez (calidad de decode).
 */
async function resolveAudioPath(id: string): Promise<string | null> {
  const mp3 = audioPathMp3(id)
  const bin = audioPathBin(id)
  if (await pathExists(mp3)) return mp3
  if (!(await pathExists(bin))) return null
  try {
    await Filesystem.rename({
      from: bin,
      to: mp3,
      directory: Directory.Documents,
    })
    return mp3
  } catch {
    return bin
  }
}

/** Escribe audio en Documents privados de la app (nativo). */
export async function writeNativeAudio(id: string, blob: Blob): Promise<void> {
  const path = audioPathMp3(id)
  await ensureParentDirs(path)
  for (const p of [path, audioPathBin(id)]) {
    try {
      await Filesystem.deleteFile({ path: p, directory: Directory.Documents })
    } catch {
      /* ignore */
    }
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
  const path = await resolveAudioPath(id)
  if (!path) return null

  // fetch(capacitor://) → Blob: mismos bytes en disco, sin base64 del bridge.
  // El <audio> con blob: audio/mpeg suena como la PWA; capacitor:// directo distorsiona.
  try {
    const { uri } = await Filesystem.getUri({
      path,
      directory: Directory.Documents,
    })
    if (uri) {
      const src = Capacitor.convertFileSrc(uri)
      const res = await fetch(src)
      if (res.ok) {
        const buf = await res.arrayBuffer()
        if (buf.byteLength > 0) {
          return new Blob([buf], { type: 'audio/mpeg' })
        }
      }
    }
  } catch {
    /* fall through a readFile */
  }

  try {
    const file = await Filesystem.readFile({
      path,
      directory: Directory.Documents,
    })
    const data = file.data
    if (typeof data === 'string') {
      const binary = atob(data)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      return new Blob([bytes], { type: 'audio/mpeg' })
    }
    if (data instanceof Blob) {
      return data.type ? data : new Blob([data], { type: 'audio/mpeg' })
    }
    return null
  } catch {
    return null
  }
}

/** URI nativa → URL usable en <audio src>. Nunca sirve .bin. */
export async function getNativeAudioSrc(id: string): Promise<string | null> {
  return getNativePlayableFileSrc(id)
}

/**
 * URL de reproducción con extensión .mp3 (WKWebView decodifica mal los .bin).
 */
export async function getNativePlayableFileSrc(id: string): Promise<string | null> {
  const path = await resolveAudioPath(id)
  if (!path) return null

  // Ya es .mp3 en Documents → URL directa
  if (path.endsWith('.mp3')) {
    try {
      const { uri } = await Filesystem.getUri({
        path,
        directory: Directory.Documents,
      })
      if (!uri) return null
      return Capacitor.convertFileSrc(uri)
    } catch {
      return null
    }
  }

  // Legacy .bin que no se pudo renombrar: copia a Cache como .mp3
  try {
    const playPath = `myvibe/play/${id}.mp3`
    try {
      await Filesystem.mkdir({
        path: 'myvibe/play',
        directory: Directory.Cache,
        recursive: true,
      })
    } catch {
      /* exists */
    }
    try {
      await Filesystem.deleteFile({ path: playPath, directory: Directory.Cache })
    } catch {
      /* ignore */
    }
    await Filesystem.copy({
      from: path,
      to: playPath,
      directory: Directory.Documents,
      toDirectory: Directory.Cache,
    })
    const { uri } = await Filesystem.getUri({
      path: playPath,
      directory: Directory.Cache,
    })
    if (!uri) return null
    return Capacitor.convertFileSrc(uri)
  } catch {
    // Nunca devolver .bin (suena fatal). El caller usará blob: audio/mpeg.
    return null
  }
}

export async function deleteNativeAudio(id: string): Promise<void> {
  for (const path of [audioPathMp3(id), audioPathBin(id)]) {
    try {
      await Filesystem.deleteFile({
        path,
        directory: Directory.Documents,
      })
    } catch {
      /* ignore */
    }
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

/** Streaming PC→móvil en nativo: escribe directo a Documents como .mp3. */
export async function beginNativeAudioWrite(id: string): Promise<NativeAppendWriter> {
  const path = audioPathMp3(id)
  await ensureParentDirs(path)
  for (const p of [path, audioPathBin(id)]) {
    try {
      await Filesystem.deleteFile({ path: p, directory: Directory.Documents })
    } catch {
      /* ignore */
    }
  }
  let written = 0
  let closed = false
  let started = false
  /** Acumula ~256 KiB antes de base64+bridge (menos picos de RAM/CPU). */
  let pending: Uint8Array[] = []
  let pendingBytes = 0
  const FLUSH_AT = 258 * 1024 // múltiplo de 3 (base64-safe)

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
  return (await resolveAudioPath(id)) != null
}

/** Tamaño en disco sin leer el MP3 a RAM (crítico en transferencias largas). */
export async function nativeAudioByteSize(id: string): Promise<number> {
  const path = await resolveAudioPath(id)
  if (!path) return 0
  try {
    const st = await Filesystem.stat({
      path,
      directory: Directory.Documents,
    })
    return typeof st.size === 'number' ? st.size : 0
  } catch {
    return 0
  }
}
