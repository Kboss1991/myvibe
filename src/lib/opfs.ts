/** OPFS with IndexedDB blob fallback via Dexie audio/covers tables. */

let rootPromise: Promise<FileSystemDirectoryHandle> | null = null

async function getRoot(): Promise<FileSystemDirectoryHandle | null> {
  if (!('storage' in navigator) || !navigator.storage.getDirectory) {
    return null
  }
  if (!rootPromise) {
    rootPromise = navigator.storage.getDirectory()
  }
  try {
    return await rootPromise
  } catch {
    rootPromise = null
    return null
  }
}

async function ensureDir(
  root: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemDirectoryHandle> {
  return root.getDirectoryHandle(name, { create: true })
}

const STREAM_CHUNK = 512 * 1024

/**
 * Escribe sin cargar el archivo entero en RAM (crítico en iPhone con MP3 de cientos de MB).
 */
export async function writeBinary(
  folder: 'audio' | 'covers',
  id: string,
  data: Blob | ArrayBuffer,
): Promise<'opfs' | 'fallback'> {
  const root = await getRoot()
  if (!root) return 'fallback'

  try {
    const dir = await ensureDir(root, folder)
    const handle = await dir.getFileHandle(id, { create: true })
    const writable = await handle.createWritable()
    if (data instanceof Blob) {
      // Por trozos: arrayBuffer() de 500MB+ tumba Safari (pantalla blanca)
      for (let offset = 0; offset < data.size; offset += STREAM_CHUNK) {
        const end = Math.min(offset + STREAM_CHUNK, data.size)
        const part = data.slice(offset, end)
        await writable.write(new Uint8Array(await part.arrayBuffer()))
      }
    } else {
      await writable.write(new Uint8Array(data))
    }
    await writable.close()
    return 'opfs'
  } catch {
    return 'fallback'
  }
}

export type OpfsAppendWriter = {
  write: (chunk: Uint8Array | ArrayBuffer | Blob) => Promise<void>
  close: () => Promise<void>
  abort: () => Promise<void>
  /** Bytes escritos (aprox.) */
  bytesWritten: () => number
}

/** Abre un fichero OPFS para ir escribiendo chunks (descarga PC→móvil de pistas largas). */
export async function openBinaryWriter(
  folder: 'audio' | 'covers',
  id: string,
): Promise<OpfsAppendWriter | null> {
  const root = await getRoot()
  if (!root) return null
  try {
    const dir = await ensureDir(root, folder)
    const handle = await dir.getFileHandle(id, { create: true })
    const writable = await handle.createWritable()
    let written = 0
    let closed = false
    return {
      write: async (chunk) => {
        if (closed) return
        if (chunk instanceof Blob) {
          await writable.write(new Uint8Array(await chunk.arrayBuffer()))
          written += chunk.size
        } else if (chunk instanceof ArrayBuffer) {
          await writable.write(new Uint8Array(chunk))
          written += chunk.byteLength
        } else {
          await writable.write(chunk)
          written += chunk.byteLength
        }
      },
      close: async () => {
        if (closed) return
        closed = true
        await writable.close()
      },
      abort: async () => {
        if (closed) return
        closed = true
        try {
          await writable.abort()
        } catch {
          try {
            await writable.close()
          } catch {
            /* ignore */
          }
        }
        try {
          await dir.removeEntry(id)
        } catch {
          /* ignore */
        }
      },
      bytesWritten: () => written,
    }
  } catch {
    return null
  }
}

export async function readBinary(
  folder: 'audio' | 'covers',
  id: string,
): Promise<Blob | null> {
  const root = await getRoot()
  if (!root) return null

  try {
    const dir = await ensureDir(root, folder)
    const handle = await dir.getFileHandle(id)
    const file = await handle.getFile()
    return file
  } catch {
    return null
  }
}

export async function deleteBinary(
  folder: 'audio' | 'covers',
  id: string,
): Promise<void> {
  const root = await getRoot()
  if (!root) return

  try {
    const dir = await ensureDir(root, folder)
    await dir.removeEntry(id)
  } catch {
    // ignore missing
  }
}

/** Borra todo el contenido de audio/ o covers/ en OPFS. */
export async function clearOpfsFolder(folder: 'audio' | 'covers'): Promise<number> {
  const root = await getRoot()
  if (!root) return 0
  let removed = 0
  try {
    const dir = await root.getDirectoryHandle(folder)
    const dirAny = dir as FileSystemDirectoryHandle & {
      entries?: () => AsyncIterable<[string, FileSystemHandle]>
      values?: () => AsyncIterable<FileSystemHandle>
    }
    if (dirAny.entries) {
      for await (const [name] of dirAny.entries()) {
        try {
          await dir.removeEntry(name)
          removed += 1
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // carpeta inexistente
  }
  return removed
}

/** Lista ids (nombres de archivo) en OPFS audio/ o covers/. */
export async function listOpfsIds(folder: 'audio' | 'covers'): Promise<string[]> {
  const root = await getRoot()
  if (!root) return []
  const ids: string[] = []
  try {
    const dir = await root.getDirectoryHandle(folder)
    const dirAny = dir as FileSystemDirectoryHandle & {
      keys?: () => AsyncIterable<string>
      entries?: () => AsyncIterable<[string, FileSystemHandle]>
    }
    if (dirAny.keys) {
      for await (const name of dirAny.keys()) ids.push(name)
    } else if (dirAny.entries) {
      for await (const [name] of dirAny.entries()) ids.push(name)
    }
  } catch {
    // carpeta inexistente
  }
  return ids
}

export function supportsOpfs(): boolean {
  return typeof navigator !== 'undefined' && 'storage' in navigator && !!navigator.storage?.getDirectory
}
