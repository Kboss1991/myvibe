/** Pick a folder (Chrome/Edge desktop) and collect only .mp3 files recursively. */

export function supportsDirectoryPicker(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window
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
      if (file.name.toLowerCase().endsWith('.mp3')) {
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
  return files.filter((f) => {
    const name = f.name.toLowerCase()
    return name.endsWith('.mp3') || f.type === 'audio/mpeg' || f.type === 'audio/mp3'
  })
}
