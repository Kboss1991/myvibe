import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { IconUpload } from '../components/Icons'
import { filterMp3Only, pickMp3Folder, supportsDirectoryPicker } from '../lib/folderImport'
import { isMyVibeShareFile } from '../lib/share'
import { extractAudioFilesFromZip, isZipFile } from '../lib/zip'
import { useLibraryStore } from '../store/libraryStore'
import { usePlayerStore } from '../store/playerStore'
import './pages.css'

export function UploadPage() {
  const inputRef = useRef<HTMLInputElement>(null)
  const shareRef = useRef<HTMLInputElement>(null)
  const zipRef = useRef<HTMLInputElement>(null)
  const folderRef = useRef<HTMLInputElement>(null)
  const importFiles = useLibraryStore((s) => s.importFiles)
  const importShare = useLibraryStore((s) => s.importShare)
  const importProgress = useLibraryStore((s) => s.importProgress)
  const playTracks = usePlayerStore((s) => s.playTracks)
  const navigate = useNavigate()
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const canPickFolder = supportsDirectoryPicker()

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
      if (result.trackIds.length) void playTracks(result.trackIds)
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
    setStatus('Leyendo ZIP…')
    try {
      const { importAccountFromZip } = await import('../lib/accountTransfer')
      const { useAuthStore } = await import('../store/authStore')
      let accountImported = false
      try {
        const user = await importAccountFromZip(file)
        if (user) {
          useAuthStore.setState({
            user,
            rememberedEmail: user.email,
            ready: true,
          })
          accountImported = true
        }
      } catch {
        // ZIP sin cuenta o cuenta inválida: seguimos con la música
      }

      let audioFiles: File[] = []
      try {
        audioFiles = await extractAudioFilesFromZip(file)
      } catch (e) {
        if (accountImported) {
          setStatus('Cuenta importada. Este ZIP no traía canciones (o ya estaban).')
          navigate('/')
          return
        }
        throw e
      }

      setStatus(
        `Importando ${audioFiles.length} canciones${accountImported ? ' (cuenta incluida)' : ''}…`,
      )
      const imported = await importFiles(audioFiles, { mp3Only: false })
      if (!imported.length) {
        if (accountImported) {
          setStatus('Cuenta importada. No se pudieron importar canciones del ZIP.')
          navigate('/')
          return
        }
        setError('No se pudieron importar las canciones del ZIP.')
        setStatus(null)
        return
      }
      const enriched = imported.filter((t) => t.enriched).length
      setStatus(
        `Listo: ${imported.length} canciones · ${enriched} enriquecidas${
          accountImported ? ' · cuenta sincronizada' : ''
        }`,
      )
      void playTracks(imported.map((t) => t.id))
      navigate('/library')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo importar el ZIP')
      setStatus(null)
    }
  }

  async function handleIncomingFiles(list: FileList | File[] | null) {
    if (!list || !list.length) return
    const files = [...list]
    const zip = files.find((f) => isZipFile(f))
    if (zip) {
      await handleZipFile(zip)
      return
    }
    const share = files.find((f) => isMyVibeShareFile(f) && f.name.toLowerCase().endsWith('.myvibe'))
    if (share) {
      await handleShareFile(share)
      return
    }
    await handleMp3Files(files)
  }

  async function handleMp3Files(list: FileList | File[] | null) {
    if (!list || !list.length) return
    setError(null)
    setStatus(null)
    const mp3s = filterMp3Only([...list])
    if (!mp3s.length) {
      setError('No se encontraron archivos MP3, ZIP o .myvibe en la selección.')
      return
    }
    setStatus(`Importando ${mp3s.length} MP3 y buscando portadas/datos en internet…`)
    try {
      const imported = await importFiles(mp3s, { mp3Only: true })
      if (!imported.length) {
        setError('No se pudieron importar los MP3.')
        return
      }
      const enriched = imported.filter((t) => t.enriched).length
      setStatus(`Listo: ${imported.length} canciones · ${enriched} enriquecidas online`)
      void playTracks(imported.map((t) => t.id))
      navigate('/library')
    } catch {
      setError('No se pudieron importar los archivos. Prueba de nuevo.')
    }
  }

  async function importFolder() {
    setError(null)
    setStatus(null)
    try {
      if (canPickFolder) {
        const files = await pickMp3Folder()
        if (!files.length) {
          setError('La carpeta no contiene archivos MP3.')
          return
        }
        await handleMp3Files(files)
      } else {
        folderRef.current?.click()
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return
      setError(e instanceof Error ? e.message : 'No se pudo abrir la carpeta')
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>Subir música</h1>
        <p className="page-header__sub">
          Importa MP3, un <strong>ZIP</strong> de biblioteca o un archivo <strong>.myvibe</strong>.
        </p>
      </header>

      <button type="button" className="folder-cta" onClick={() => zipRef.current?.click()}>
        <div className="folder-cta__icon">
          <IconUpload size={32} />
        </div>
        <div className="folder-cta__text">
          <strong>Importar ZIP de biblioteca</strong>
          <span>Incluye canciones y, si viene del PC, también tu cuenta</span>
        </div>
      </button>

      <button type="button" className="folder-cta" onClick={() => void importFolder()}>
        <div className="folder-cta__icon">
          <IconUpload size={32} />
        </div>
        <div className="folder-cta__text">
          <strong>Elegir carpeta (solo MP3)</strong>
          <span>
            {canPickFolder
              ? 'Chrome / Edge en PC · recorre subcarpetas e ignora lo que no sea MP3'
              : 'Selecciona una carpeta; se filtrarán solo los MP3'}
          </span>
        </div>
      </button>

      <button
        type="button"
        className="folder-cta"
        style={{ marginTop: 12 }}
        onClick={() => shareRef.current?.click()}
      >
        <div className="folder-cta__icon">
          <IconUpload size={32} />
        </div>
        <div className="folder-cta__text">
          <strong>Importar .myvibe compartido</strong>
          <span>Canción o playlist enviada por otra persona con MyVibe</span>
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
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click()
        }}
      >
        <strong>O elige archivos MP3 / ZIP / .myvibe</strong>
        <span>arrástralos aquí</span>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept=".mp3,.zip,.myvibe,audio/mpeg,application/zip,application/json"
        multiple
        hidden
        onChange={(e) => {
          void handleIncomingFiles(e.target.files)
          e.target.value = ''
        }}
      />
      <input
        ref={zipRef}
        type="file"
        accept=".zip,application/zip,application/x-zip-compressed"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) void handleZipFile(file)
          e.target.value = ''
        }}
      />
      <input
        ref={shareRef}
        type="file"
        accept=".myvibe,application/json,application/x-myvibe+json"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) void handleShareFile(file)
          e.target.value = ''
        }}
      />
      <input
        ref={folderRef}
        type="file"
        multiple
        hidden
        {...{ webkitdirectory: '', directory: '' }}
        onChange={(e) => void handleMp3Files(e.target.files)}
      />

      {importProgress && (
        <div className="import-progress">
          <div className="import-progress__bar">
            <div
              style={{
                width: `${
                  importProgress.total
                    ? (importProgress.done / importProgress.total) * 100
                    : 0
                }%`,
              }}
            />
          </div>
          <p>
            {importProgress.done}/{importProgress.total}
            {importProgress.name ? ` · ${importProgress.name}` : ''}
          </p>
        </div>
      )}

      {status && <p className="form-status">{status}</p>}
      {error && <p className="form-error">{error}</p>}

      <section className="tips">
        <h2>Pasar música del PC al móvil</h2>
        <ol>
          <li>En el PC: Perfil → Descargar biblioteca (cuenta + MP3).</li>
          <li>Pasa el ZIP al móvil.</li>
          <li>
            En el móvil: login → Importar cuenta, o Subir → Importar ZIP (sin descomprimir).
          </li>
        </ol>
      </section>
    </div>
  )
}
