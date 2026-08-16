import { Capacitor } from '@capacitor/core'
import { Directory, Filesystem } from '@capacitor/filesystem'
import write_blob from 'capacitor-blob-writer'

const AUDIO_DIR = 'myvibe/audio'
const COVER_DIR = 'myvibe/covers'

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

/**
 * Escritura binaria bit-a-bit (HTTP local). Evita base64+appendFile que
 * corrompe MP3 y suena a distorsión.
 */
async function writeBinaryBlob(path: string, blob: Blob): Promise<void> {
  await ensureParentDirs(path)
  try {
    await Filesystem.deleteFile({ path, directory: Directory.Documents })
  } catch {
    /* ignore */
  }
  await write_blob({
    path,
    directory: Directory.Documents,
    blob,
    recursive: true,
    on_fallback(error) {
      console.warn('[nativeAudioFs] blob-writer fallback', error)
    },
  })
}

/** Escribe audio en Documents privados de la app (nativo). */
export async function writeNativeAudio(id: string, blob: Blob): Promise<void> {
  const path = audioPathMp3(id)
  for (const p of [path, audioPathBin(id)]) {
    try {
      await Filesystem.deleteFile({ path: p, directory: Directory.Documents })
    } catch {
      /* ignore */
    }
  }
  const typed = blob.type ? blob : new Blob([blob], { type: 'audio/mpeg' })
  await writeBinaryBlob(path, typed)
}

export async function readNativeAudioBlob(id: string): Promise<Blob | null> {
  const path = await resolveAudioPath(id)
  if (!path) return null

  // fetch → blob (sin base64 ni bucles atob que congelan el WebView)
  try {
    const { uri } = await Filesystem.getUri({
      path,
      directory: Directory.Documents,
    })
    if (uri) {
      const src = Capacitor.convertFileSrc(uri)
      const res = await fetch(src)
      if (res.ok) {
        const blob = await res.blob()
        if (blob.size > 0) {
          return blob.type === 'audio/mpeg' ? blob : blob.slice(0, blob.size, 'audio/mpeg')
        }
      }
    }
  } catch {
    /* fall through */
  }

  // Fallback solo para ficheros pequeños (atob de MP3 grandes congela la UI)
  try {
    const st = await Filesystem.stat({ path, directory: Directory.Documents })
    const size = typeof st.size === 'number' ? st.size : 0
    if (size <= 0 || size > 8 * 1024 * 1024) return null

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
  const typed = blob.type ? blob : new Blob([blob], { type: 'image/jpeg' })
  await writeBinaryBlob(path, typed)
}

export async function readNativeCoverBlob(id: string): Promise<Blob | null> {
  try {
    const { uri } = await Filesystem.getUri({
      path: coverPath(id),
      directory: Directory.Documents,
    })
    if (uri) {
      const src = Capacitor.convertFileSrc(uri)
      const res = await fetch(src)
      if (res.ok) {
        const blob = await res.blob()
        if (blob.size > 0) return blob
      }
    }
  } catch {
    /* fall through */
  }
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

/**
 * Streaming PC→móvil: acumula bytes y al cerrar escribe binario limpio
 * (sin base64/appendFile). Una pista a la vez en fase heavy.
 */
export async function beginNativeAudioWrite(id: string): Promise<NativeAppendWriter> {
  const path = audioPathMp3(id)
  for (const p of [path, audioPathBin(id)]) {
    try {
      await Filesystem.deleteFile({ path: p, directory: Directory.Documents })
    } catch {
      /* ignore */
    }
  }
  let written = 0
  let closed = false
  const parts: Uint8Array[] = []

  return {
    write: async (chunk) => {
      if (closed) return
      let bytes: Uint8Array
      if (chunk instanceof Blob) {
        bytes = new Uint8Array(await chunk.arrayBuffer())
      } else if (chunk instanceof ArrayBuffer) {
        bytes = new Uint8Array(chunk)
      } else {
        bytes = new Uint8Array(chunk.byteLength)
        bytes.set(chunk)
      }
      parts.push(bytes)
      written += bytes.byteLength
    },
    close: async () => {
      if (closed) return
      closed = true
      const blob = new Blob(parts as BlobPart[], { type: 'audio/mpeg' })
      parts.length = 0
      await writeBinaryBlob(path, blob)
    },
    abort: async () => {
      closed = true
      parts.length = 0
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

/**
 * Una sola vez: borra audio guardado con el writer base64 corrupto
 * para forzar re-transferencia Wi‑Fi bit-perfect.
 */
export async function invalidateCorruptNativeAudioOnce(): Promise<number> {
  if (!isNativeApp()) return 0
  const KEY = 'myvibe.bitPerfectAudio.v2'
  try {
    if (localStorage.getItem(KEY) === '1') return 0
  } catch {
    return 0
  }

  const { db } = await import('../db')
  const tracks = await db.tracks.toArray()
  let cleared = 0
  for (const t of tracks) {
    const had =
      t.hasLocalAudio === true || (typeof t.audioBytes === 'number' && t.audioBytes > 1024)
    if (!had) continue
    await deleteNativeAudio(t.id).catch(() => undefined)
    await db.tracks.update(t.id, {
      hasLocalAudio: false,
      audioBytes: 0,
      needsAudioUpdate: true,
    })
    cleared += 1
  }
  try {
    localStorage.setItem(KEY, '1')
  } catch {
    /* ignore */
  }
  return cleared
}
