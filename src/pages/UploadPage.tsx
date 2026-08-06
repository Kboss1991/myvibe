import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { IconUpload } from '../components/Icons'
import {
  filterAudioFiles,
  isAppleMobile,
  pickMp3Folder,
  supportsDirectoryPicker,
} from '../lib/folderImport'
import { isMyVibeShareFile } from '../lib/share'
import {
  audioFilesFromZipEntries,
  extractZipEntries,
  isZipFile,
} from '../lib/zip'
import { useLibraryStore } from '../store/libraryStore'
import './pages.css'

export function UploadPage() {
  const inputRef = useRef<HTMLInputElement>(null)
  const importFiles = useLibraryStore((s) => s.importFiles)
  const importShare = useLibraryStore((s) => s.importShare)
  const importProgress = useLibraryStore((s) => s.importProgress)
  const enrichProgress = useLibraryStore((s) => s.enrichProgress)
  const navigate = useNavigate()
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const canPickFolder = supportsDirectoryPicker()
  const onIphone = isAppleMobile()

  async function handleShareFile(file: File) {
    setError(null)
    setStatus('Importando paquete MyVibe…')
    try {
      const result = await importShare(file)
      setStatus(
        result.playlistCount > 1
          ? `Biblioteca importada · ${result.trackIds.length} canciones · ${result.playlistCount} playlists`
          : result.playlistId
            ? `Playlist importada · ${result.trackIds.length} canciones`
            : result.trackIds.length > 1
              ? `Importadas ${result.trackIds.length} canciones`
              : `Canción importada`,
      )
      navigate(
        result.playlistCount > 1
          ? '/library'
          : result.playlistId
            ? `/playlist/${result.playlistId}`
            : '/library',
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo importar el .myvibe')
      setStatus(null)
    }
  }

  async function handleZipFile(file: File) {
    setError(null)
    setStatus(`Leyendo ZIP (${Math.round(file.size / (1024 * 1024))} MB)…`)
    try {
      const entries = await extractZipEntries(file)

      const { importAccountFromZipEntries } = await import('../lib/accountTransfer')
      const { useAuthStore } = await import('../store/authStore')
      let accountImported = false
      try {
        const user = await importAccountFromZipEntries(entries)
        if (user) {
          useAuthStore.setState({
            user,
            rememberedEmail: user.email,
            ready: true,
          })
          accountImported = true
          setStatus('Cuenta encontrada. Extrayendo canciones…')
        }
      } catch (e) {
        console.warn('Cuenta ZIP:', e)
      }

      const audioFiles = audioFilesFromZipEntries(entries)
      if (!audioFiles.length) {
        if (accountImported) {
          setStatus('Cuenta importada. Este ZIP no traía canciones.')
          navigate('/')
          return
        }
        setError('El ZIP no contiene canciones (MP3).')
        setStatus(null)
        return
      }

      setStatus(`Guardando ${audioFiles.length} canciones; luego carátulas y datos…`)
      const imported = await importFiles(audioFiles, { mp3Only: false, enrich: true })
      if (!imported.length) {
        setError(
          accountImported
            ? 'Cuenta importada, pero no se pudieron guardar las canciones.'
            : 'No se pudieron importar las canciones del ZIP.',
        )
        setStatus(null)
        return
      }

      setStatus(`Listo: ${imported.length} canciones${accountImported ? ' · cuenta OK' : ''}`)
      navigate('/library')
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'No se pudo importar el ZIP'
      setError(
        /memory|quota|allocation/i.test(msg)
          ? 'El ZIP es demasiado grande para este iPhone. Usa MP3 sueltos desde Archivos.'
          : msg,
      )
      setStatus(null)
    }
  }

  async function handleIncomingFiles(list: FileList | File[] | null) {
    if (!list || !list.length) return
    const files = [...list]

    const zips = files.filter((f) => isZipFile(f))
    const rest = files.filter((f) => !isZipFile(f))

    if (zips.length && rest.length === 0) {
      await handleZipFile(zips[0]!)
      return
    }

    const share = rest.find((f) => isMyVibeShareFile(f) && f.name.toLowerCase().endsWith('.myvibe'))
    if (share && rest.length === 1) {
      await handleShareFile(share)
      return
    }
    await handleAudioFiles(rest.length ? rest : files)
  }

  async function handleAudioFiles(list: FileList | File[] | null) {
    if (!list || !list.length) return
    setError(null)
    setStatus(null)
    const audio = filterAudioFiles([...list])
    if (!audio.length) {
      const sample = [...list]
        .slice(0, 3)
        .map((f) => f.name || f.type || 'sin nombre')
        .join(', ')
      setError(
        onIphone
          ? `No se detectaron canciones en la selección${sample ? ` (${sample})` : ''}. Elige archivos .mp3 / .m4a.`
          : 'No se encontraron archivos de audio en la selección.',
      )
      return
    }
    setStatus(`Guardando ${audio.length} canciones; luego carátulas y datos…`)
    try {
      const imported = await importFiles(audio, { mp3Only: false, enrich: true })
      if (!imported.length) {
        setError('No se pudieron importar las canciones.')
        return
      }
      const skipped = audio.length - imported.length
      setStatus(
        skipped > 0
          ? `Listo: ${imported.length} canciones (${skipped} fallaron; prueba de nuevo esas)`
          : `Listo: ${imported.length} canciones`,
      )
      navigate('/library')
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Error desconocido'
      setError(
        /quota|memory|allocation/i.test(msg)
          ? 'Poca memoria o espacio. Importa menos canciones cada vez (10–20).'
          : /NotReadable|NotFound|network/i.test(msg)
            ? 'No se pudo leer el archivo (¿aún en iCloud?). Ábrelo en Archivos para descargarlo y vuelve a subirlo.'
            : msg,
      )
      setStatus(null)
    }
  }

  async function importFolder() {
    setError(null)
    setStatus(null)
    try {
      if (canPickFolder && !onIphone) {
        const files = await pickMp3Folder()
        if (!files.length) {
          setError('La carpeta no contiene archivos .mp3.')
          return
        }
        await handleAudioFiles(files)
      } else {
        inputRef.current?.click()
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return
      setError(e instanceof Error ? e.message : 'No se pudo abrir la selección')
    }
  }

  function openFilePicker() {
    inputRef.current?.click()
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>Subir música</h1>
        <p className="page-header__sub">Solo carpeta o archivos. Sin QR ni otras opciones.</p>
      </header>

      <button type="button" className="folder-cta folder-cta--primary" onClick={() => void importFolder()}>
        <div className="folder-cta__icon">
          <IconUpload size={32} />
        </div>
        <div className="folder-cta__text">
          <strong>{onIphone ? 'Elegir archivos' : 'Elegir carpeta'}</strong>
          <span>
            {onIphone
              ? 'Desde Archivos · MP3 / M4A'
              : canPickFolder
                ? 'Recorre subcarpetas y carga los MP3'
                : 'Selecciona archivos de audio'}
          </span>
        </div>
      </button>

      <div
        className={`dropzone ${dragOver ? 'is-over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          void handleIncomingFiles(e.dataTransfer.files)
        }}
        onClick={openFilePicker}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') openFilePicker()
        }}
      >
        <strong>Archivos: clic o arrastrar</strong>
        <span>MP3, M4A…</span>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={onIphone ? '*/*' : 'audio/*,.mp3,.m4a,.zip,.myvibe,application/zip'}
        multiple
        hidden
        onChange={(e) => {
          void handleIncomingFiles(e.target.files)
          e.target.value = ''
        }}
      />

      {(importProgress || enrichProgress) && (
        <div className="import-progress">
          <div className="import-progress__bar">
            <div
              style={{
                width: `${
                  (enrichProgress ?? importProgress)!.total
                    ? ((enrichProgress ?? importProgress)!.done /
                        (enrichProgress ?? importProgress)!.total) *
                      100
                    : 0
                }%`,
              }}
            />
          </div>
          <p>
            {enrichProgress
              ? `${enrichProgress.done}/${enrichProgress.total}`
              : `${importProgress!.done}/${importProgress!.total}`}
            {(enrichProgress ?? importProgress)!.name
              ? ` · ${(enrichProgress ?? importProgress)!.name}`
              : ''}
          </p>
        </div>
      )}

      {status && <p className="form-status">{status}</p>}
      {error && <p className="form-error">{error}</p>}
    </div>
  )
}
