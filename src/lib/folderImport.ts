/** Pick a folder (Chrome/Edge desktop) and collect audio files recursively. */

export function supportsDirectoryPicker(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window
}

/** iPhone/iPad: Safari no permite elegir carpetas enteras. */
export function isAppleMobile(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  if (/iPhone|iPad|iPod/i.test(ua)) return true
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
}

/** Solo el PC/escritorio debe publicar el host Wi‑Fi (no móviles Android). */
export function isLibraryHostDevice(): boolean {
  if (typeof navigator === 'undefined') return false
  if (isAppleMobile()) return false
  const ua = navigator.userAgent || ''
  if (/Android|webOS|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(ua)) return false
  return true
}

export function isImportableAudio(file: File): boolean {
  const name = (file.name || '').toLowerCase()
  const type = (file.type || '').toLowerCase()
  if (type.startsWith('audio/')) return true
  if (type === 'video/mp4' && /\.(m4a|mp4|aac)$/i.test(name)) return true
  return /\.(mp3|m4a|aac|wav|ogg|flac|mpeg|mp4)$/i.test(name)
}

export function isImportableMp3(file: File): boolean {
  const name = (file.name || '').toLowerCase()
  const type = (file.type || '').toLowerCase()
  return type === 'audio/mpeg' || type === 'audio/mp3' || name.endsWith('.mp3')
}

async function walkDirectory(
  dir: FileSystemDirectoryHandle,
  out: File[],
): Promise<void> {
  const handle = dir as FileSystemDirectoryHandle & {
    values: () => AsyncIterable<FileSystemHandle>
  }

  for await (const entry of handle.values()) {
    if (entry.kind === 'file') {
      const fileHandle = entry as FileSystemFileHandle
      const file = await fileHandle.getFile()
      if (isImportableMp3(file)) {
        out.push(file)
      }
    } else if (entry.kind === 'directory') {
      await walkDirectory(entry as FileSystemDirectoryHandle, out)
    }
  }
}

export async function pickMp3Folder(): Promise<File[]> {
  if (!supportsDirectoryPicker()) {
    throw new Error('Tu navegador no permite elegir carpetas. Usa Chrome o Edge en el PC.')
  }

  const picker = (
    window as unknown as {
      showDirectoryPicker: () => Promise<FileSystemDirectoryHandle>
    }
  ).showDirectoryPicker
  const dir = await picker()
  const files: File[] = []
  await walkDirectory(dir, files)
  return files
}

export function filterMp3Only(files: File[]): File[] {
  return files.filter(isImportableMp3)
}

export function filterAudioFiles(files: File[]): File[] {
  return files.filter(isImportableAudio)
}
