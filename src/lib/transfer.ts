import { db } from '../db'
import { getAudioBlob } from './library'
import { accountZipEntries, ACCOUNT_JSON } from './accountTransfer'
import { buildZipBlob } from './zip'

const PACK_MAX_TRACKS = 12

function safeFileName(name: string, ext: string): string {
  const base = (name.replace(/[<>:"/\\|?*\x00-\x1f]+/g, '').trim() || 'cancion').slice(0, 80)
  const cleanExt = ext.startsWith('.') ? ext : `.${ext}`
  return `${base}${cleanExt}`
}

function extFromTrack(mime: string, fileName: string): string {
  const fromName = fileName.match(/\.[a-z0-9]+$/i)?.[0]
  if (fromName) return fromName.toLowerCase()
  if (mime.includes('wav')) return '.wav'
  if (mime.includes('ogg')) return '.ogg'
  if (mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac')) return '.m4a'
  return '.mp3'
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export function supportsFolderExport(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window
}

/**
 * Forma más fiable: escribe MP3 sueltos en una carpeta del PC.
 * Luego USB / Drive / Nearby Share → en el móvil Subir → carpeta o MP3.
 */
export async function exportLibraryToFolder(
  userId: string | undefined,
  onProgress?: (done: number, total: number, name: string) => void,
): Promise<{ count: number; folderHint: string }> {
  if (!supportsFolderExport()) {
    throw new Error('Exportar a carpeta requiere Chrome o Edge en el PC')
  }

  const picker = (
    window as unknown as {
      showDirectoryPicker: (opts?: {
        mode?: 'read' | 'readwrite'
        startIn?: string
      }) => Promise<FileSystemDirectoryHandle>
    }
  ).showDirectoryPicker

  const root = await picker({ mode: 'readwrite', startIn: 'downloads' })
  const exportDir = await root.getDirectoryHandle('MyVibe-export', { create: true })
  const musicDir = await exportDir.getDirectoryHandle('canciones', { create: true })

  const tracks = await db.tracks.toArray()
  if (!tracks.length) throw new Error('No hay canciones para exportar')

  if (userId) {
    onProgress?.(0, tracks.length, 'Guardando cuenta…')
    const accountEntries = await accountZipEntries(userId)
    for (const entry of accountEntries) {
      const base = entry.name.split('/').pop() || entry.name
      const handle = await exportDir.getFileHandle(base, { create: true })
      const writable = await handle.createWritable()
      await writable.write(new Uint8Array(entry.data))
      await writable.close()
    }
  }

  const readme = await exportDir.getFileHandle('COMO-IMPORTAR.txt', { create: true })
  const readmeW = await readme.createWritable()
  await readmeW.write(
    [
      'MyVibe — exportación',
      '',
      '1. Copia esta carpeta al móvil (USB, Drive, Nearby Share…).',
      '2. Abre MyVibe en el móvil → Subir.',
      '3. Elige la carpeta "canciones" o los MP3.',
      '4. Si hay myvibe-account.json, en el login: Importar cuenta.',
      '',
    ].join('\n'),
  )
  await readmeW.close()

  const used = new Map<string, number>()
  let written = 0

  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i]!
    onProgress?.(i, tracks.length, track.title)
    const audio = await getAudioBlob(track.id)
    if (!audio) continue

    const ext = extFromTrack(track.mimeType || audio.type, track.fileName || '')
    const label = `${track.artist || 'Artista'} - ${track.title || 'Canción'}`
    let name = safeFileName(label, ext)
    const n = used.get(name) ?? 0
    used.set(name, n + 1)
    if (n > 0) name = safeFileName(`${label} (${n + 1})`, ext)

    const handle = await musicDir.getFileHandle(name, { create: true })
    const writable = await handle.createWritable()
    await writable.write(audio)
    await writable.close()
    written += 1

    // Yield para no congelar el UI
    if (i % 3 === 0) await new Promise((r) => setTimeout(r, 0))
  }

  onProgress?.(tracks.length, tracks.length, '')
  if (!written) throw new Error('No se pudo escribir ninguna canción')
  return { count: written, folderHint: 'MyVibe-export' }
}

/**
 * Plan B: varios ZIP pequeños (mejor para móvil que un ZIP enorme).
 * El primero incluye la cuenta.
 */
export async function downloadLibraryPacks(
  userId: string | undefined,
  onProgress?: (done: number, total: number, name: string) => void,
): Promise<{ packs: number; tracks: number }> {
  const tracks = await db.tracks.toArray()
  if (!tracks.length) throw new Error('No hay canciones para exportar')

  const packs: (typeof tracks)[] = []
  for (let i = 0; i < tracks.length; i += PACK_MAX_TRACKS) {
    packs.push(tracks.slice(i, i + PACK_MAX_TRACKS))
  }

  let exportedTracks = 0
  const totalSteps = tracks.length

  for (let p = 0; p < packs.length; p++) {
    const chunk = packs[p]!
    const entries: { name: string; data: Uint8Array }[] = []
    const used = new Map<string, number>()

    if (p === 0 && userId) {
      const accountEntries = await accountZipEntries(userId)
      entries.push(...accountEntries)
    }

    for (let i = 0; i < chunk.length; i++) {
      const track = chunk[i]!
      const globalDone = p * PACK_MAX_TRACKS + i
      onProgress?.(globalDone, totalSteps, `Parte ${p + 1}/${packs.length} · ${track.title}`)
      const audio = await getAudioBlob(track.id)
      if (!audio) continue
      const buf = new Uint8Array(await audio.arrayBuffer())
      const ext = extFromTrack(track.mimeType || audio.type, track.fileName || '')
      const label = `${track.artist || 'Artista'} - ${track.title || 'Canción'}`
      let name = safeFileName(label, ext)
      const n = used.get(name) ?? 0
      used.set(name, n + 1)
      if (n > 0) name = safeFileName(`${label} (${n + 1})`, ext)
      entries.push({ name: `canciones/${name}`, data: buf })
      exportedTracks += 1
    }

    if (!entries.length) continue
    const zip = buildZipBlob(entries)
    downloadBlob(zip, `myvibe-parte-${p + 1}-de-${packs.length}.zip`)
    // Pausa entre descargas para que el navegador no las cancele
    await new Promise((r) => setTimeout(r, 600))
  }

  onProgress?.(totalSteps, totalSteps, '')
  if (!exportedTracks) throw new Error('No hay canciones con audio')
  return { packs: packs.length, tracks: exportedTracks }
}

export { ACCOUNT_JSON, PACK_MAX_TRACKS }
