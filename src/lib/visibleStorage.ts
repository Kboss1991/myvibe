import { isAppleMobile, supportsDirectoryPicker } from './folderImport'

const FS_DB = 'myvibe-visible-fs'
const FS_STORE = 'handles'
const FS_KEY = 'downloads-myvibe'

export type VisibleFile = {
  fileName: string
  blob: Blob
}

function sanitizeFileName(name: string): string {
  const base = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || 'track.mp3'
  return base.toLowerCase().endsWith('.mp3') ? base : `${base}.mp3`
}

export function myVibeDownloadName(artist: string, title: string, fileName?: string): string {
  if (fileName && /\.(mp3|m4a|aac|wav|flac|ogg)$/i.test(fileName)) {
    return sanitizeFileName(`MyVibe - ${fileName}`)
  }
  const a = (artist || 'Artista').slice(0, 40)
  const t = (title || 'Cancion').slice(0, 60)
  return sanitizeFileName(`MyVibe - ${a} - ${t}.mp3`)
}

function openFsDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(FS_DB, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(FS_STORE)) db.createObjectStore(FS_STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IDB'))
  })
}

async function saveDirHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openFsDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(FS_STORE, 'readwrite')
    tx.objectStore(FS_STORE).put(handle, FS_KEY)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IDB put'))
  })
  db.close()
}

async function loadDirHandle(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openFsDb()
    const handle = await new Promise<FileSystemDirectoryHandle | null>((resolve, reject) => {
      const tx = db.transaction(FS_STORE, 'readonly')
      const req = tx.objectStore(FS_STORE).get(FS_KEY)
      req.onsuccess = () => resolve((req.result as FileSystemDirectoryHandle) ?? null)
      req.onerror = () => reject(req.error ?? new Error('IDB get'))
    })
    db.close()
    return handle
  } catch {
    return null
  }
}

async function ensurePermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const opts = { mode: 'readwrite' as const }
  const h = handle as FileSystemDirectoryHandle & {
    queryPermission?: (o: { mode: 'readwrite' }) => Promise<PermissionState>
    requestPermission?: (o: { mode: 'readwrite' }) => Promise<PermissionState>
  }
  if (h.queryPermission) {
    const q = await h.queryPermission(opts)
    if (q === 'granted') return true
  }
  if (h.requestPermission) {
    const r = await h.requestPermission(opts)
    return r === 'granted'
  }
  return true
}

/** Chrome/Edge: elige (o reutiliza) carpeta Descargas/MyVibe visible en el sistema. */
export async function pickVisibleMusicFolder(): Promise<FileSystemDirectoryHandle> {
  if (!supportsDirectoryPicker()) {
    throw new Error('Este navegador no permite elegir carpeta. En iPhone usa “Guardar en Archivos”.')
  }
  const picker = (
    window as Window & {
      showDirectoryPicker?: (opts?: {
        mode?: 'read' | 'readwrite'
        startIn?: string
      }) => Promise<FileSystemDirectoryHandle>
    }
  ).showDirectoryPicker
  if (!picker) throw new Error('No hay selector de carpetas')

  const root = await picker({ mode: 'readwrite', startIn: 'downloads' })
  const music = await root.getDirectoryHandle('MyVibe', { create: true })
  await saveDirHandle(music)
  return music
}

async function getWritableFolder(interactive: boolean): Promise<FileSystemDirectoryHandle | null> {
  if (!supportsDirectoryPicker() || isAppleMobile()) return null
  const existing = await loadDirHandle()
  if (existing && (await ensurePermission(existing))) return existing
  if (!interactive) return null
  return pickVisibleMusicFolder()
}

async function writeToFolder(
  folder: FileSystemDirectoryHandle,
  files: VisibleFile[],
  onProgress?: (done: number, total: number, name: string) => void,
): Promise<number> {
  let done = 0
  for (const f of files) {
    const name = sanitizeFileName(f.fileName)
    const handle = await folder.getFileHandle(name, { create: true })
    const writable = await handle.createWritable()
    await writable.write(f.blob)
    await writable.close()
    done += 1
    onProgress?.(done, files.length, name)
  }
  return done
}

function triggerDownload(file: VisibleFile) {
  const name = sanitizeFileName(file.fileName)
  const url = URL.createObjectURL(file.blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 2_000)
}

async function shareFiles(files: VisibleFile[]): Promise<boolean> {
  const payload = files.map(
    (f) =>
      new File([f.blob], sanitizeFileName(f.fileName), {
        type: f.blob.type || 'audio/mpeg',
      }),
  )
  if (!navigator.share || !navigator.canShare?.({ files: payload })) return false
  await navigator.share({
    files: payload,
    title: 'MyVibe',
    text: 'Guardar en Archivos → En mi iPhone → Descargas → MyVibe',
  })
  return true
}

export type SaveVisibleResult = {
  mode: 'folder' | 'share' | 'download'
  saved: number
  message: string
}

/**
 * Guarda copias visibles (carpeta Descargas/MyVibe, compartir a Archivos, o descarga).
 * La biblioteca interna de MyVibe se mantiene para reproducir.
 */
export async function saveFilesVisibly(
  files: VisibleFile[],
  options?: {
    interactive?: boolean
    onProgress?: (done: number, total: number, name: string) => void
  },
): Promise<SaveVisibleResult> {
  if (!files.length) {
    return { mode: 'download', saved: 0, message: 'No hay archivos' }
  }

  const interactive = options?.interactive !== false

  // 1) Carpeta real (Chrome/Edge PC o Android)
  try {
    const folder = await getWritableFolder(interactive)
    if (folder) {
      const saved = await writeToFolder(folder, files, options?.onProgress)
      return {
        mode: 'folder',
        saved,
        message: `Guardadas ${saved} en la carpeta MyVibe (Descargas).`,
      }
    }
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw e
    }
    // sigue con share/download
  }

  // 2) iPhone: compartir a Archivos (hay que elegir carpeta cada vez)
  if (isAppleMobile() && interactive) {
    let saved = 0
    // De una en una: más fiable en Safari y permite la misma carpeta MyVibe
    for (let i = 0; i < files.length; i++) {
      const f = files[i]!
      options?.onProgress?.(i, files.length, f.fileName)
      try {
        const ok = await shareFiles([f])
        if (ok) {
          saved += 1
          continue
        }
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') {
          break
        }
      }
    }
    return {
      mode: saved ? 'share' : 'download',
      saved,
      message:
        saved > 0
          ? `Guardadas ${saved} vía Archivos. Carpeta: En mi iPhone → Descargas → MyVibe.`
          : 'No se guardó en Archivos (cancelado). Siguen en MyVibe para escuchar.',
    }
  }

  // 3) Descargas del navegador (aparecen en Descargas)
  let saved = 0
  for (const f of files) {
    triggerDownload(f)
    saved += 1
    options?.onProgress?.(saved, files.length, f.fileName)
    await new Promise((r) => setTimeout(r, 400))
  }
  return {
    mode: 'download',
    saved,
    message: `Descargadas ${saved} a la carpeta Descargas (busca “MyVibe - …”).`,
  }
}

export async function hasVisibleFolderConfigured(): Promise<boolean> {
  const h = await loadDirHandle()
  return Boolean(h)
}

export type DeleteVisibleResult = {
  mode: 'folder' | 'manual'
  removed: number
  message: string
  fileNames: string[]
}

/**
 * Intenta borrar copias visibles en Descargas/MyVibe.
 * PC (Chrome): borra de la carpeta recordada.
 * iPhone: no puede borrar solo; devuelve instrucciones.
 */
export async function deleteVisibleCopies(
  fileNames: string[],
  options?: { interactive?: boolean },
): Promise<DeleteVisibleResult> {
  const names = [...new Set(fileNames.map(sanitizeFileName).filter(Boolean))]
  if (!names.length) {
    return {
      mode: 'manual',
      removed: 0,
      message: 'No hay nombres de archivo para borrar.',
      fileNames: [],
    }
  }

  if (isAppleMobile()) {
    const preview = names.slice(0, 8).join('\n· ')
    const more = names.length > 8 ? `\n· … y ${names.length - 8} más` : ''
    return {
      mode: 'manual',
      removed: 0,
      fileNames: names,
      message:
        `En el iPhone hay que borrarlas a mano:\n\n` +
        `App Archivos → En mi iPhone → Descargas → MyVibe\n\n` +
        `Busca y elimina:\n· ${preview}${more}`,
    }
  }

  try {
    const interactive = options?.interactive !== false
    let folder = await getWritableFolder(false)
    if (!folder && interactive) {
      folder = await getWritableFolder(true)
    }
    if (!folder) {
      return {
        mode: 'manual',
        removed: 0,
        fileNames: names,
        message:
          `No hay carpeta MyVibe vinculada.\n` +
          `Bórralas en el Explorador → Descargas → MyVibe:\n· ${names.slice(0, 8).join('\n· ')}`,
      }
    }

    let removed = 0
    for (const name of names) {
      try {
        await folder.removeEntry(name)
        removed += 1
      } catch {
        // no existía
      }
    }
    return {
      mode: 'folder',
      removed,
      fileNames: names,
      message:
        removed > 0
          ? `Borradas ${removed} copias de Descargas → MyVibe.`
          : 'No se encontraron esas copias en la carpeta MyVibe (quizá ya no estaban).',
    }
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      return {
        mode: 'manual',
        removed: 0,
        fileNames: names,
        message: 'Cancelado.',
      }
    }
    throw e
  }
}

