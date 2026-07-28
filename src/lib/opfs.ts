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
    // iOS: escribir ArrayBuffer es más fiable que Blob directo
    const payload =
      data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : new Uint8Array(data)
    await writable.write(payload)
    await writable.close()
    return 'opfs'
  } catch {
    return 'fallback'
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
