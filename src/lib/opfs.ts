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
    await writable.write(data)
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

export function supportsOpfs(): boolean {
  return typeof navigator !== 'undefined' && 'storage' in navigator && !!navigator.storage?.getDirectory
}
