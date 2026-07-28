import { useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
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
import { usePlayerStore } from '../store/playerStore'
import './pages.css'

export function UploadPage() {
  const inputRef = useRef<HTMLInputElement>(null)
  const iosFilesRef = useRef<HTMLInputElement>(null)
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

      setStatus(`Importando ${audioFiles.length} canciones…`)
      const imported = await importFiles(audioFiles, { mp3Only: false, enrich: false })
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
      void playTracks(imported.map((t) => t.id))
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

    // Separar ZIP claros del resto (no escanear magic en todos: en iPhone falla con iCloud)
    const zips = files.filter((f) => isZipFile(f))
    const rest = files.filter((f) => !isZipFile(f))

    if (zips.length === 1 && rest.length === 0) {
      await handleZipFile(zips[0]!)
      return
    }
    if (zips.length && rest.length === 0) {
      // Varios ZIP: importa el primero con mensaje
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
          ? `No se detectaron canciones en la selección${sample ? ` (${sample})` : ''}. Elige archivos .mp3 / .m4a dentro de la carpeta.`
          : 'No se encontraron archivos de audio en la selección.',
      )
      return
    }
    setStatus(`Importando ${audio.length} canciones…`)
    try {
      const imported = await importFiles(audio, { mp3Only: false, enrich: false })
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
      void playTracks(imported.map((t) => t.id))
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
          setError('La carpeta no contiene archivos de audio.')
          return
        }
        await handleAudioFiles(files)
      } else {
        // iPhone / Safari: no hay carpetas → multi-archivo desde Archivos
        iosFilesRef.current?.click()
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return
      setError(e instanceof Error ? e.message : 'No se pudo abrir la selección')
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>Subir música</h1>
        <p className="page-header__sub">
          {onIphone
            ? 'Lo más fácil: recibir por Wi‑Fi desde el PC (sin ZIP ni Archivos).'
            : 'Importa carpeta de MP3, ZIP pequeños o un archivo .myvibe.'}
        </p>
      </header>

      <Link to="/receive" className="folder-cta folder-cta--primary">
        <div className="folder-cta__icon">
          <IconUpload size={32} />
        </div>
        <div className="folder-cta__text">
          <strong>Recibir por Wi‑Fi / QR</strong>
          <span>
            Escanea el QR del PC (cámara) o introduce el código. Se guarda en tu biblioteca.
          </span>
        </div>
      </Link>

      {onIphone && (
        <div className="ios-upload-hint">
          <strong>Si Wi‑Fi no funciona: MP3 desde Archivos</strong>
          <ol>
            <li>Pulsa <em>Examinar Archivos</em> (abajo).</li>
            <li>En el selector, elige la pestaña <em>Explorar</em> (no Recientes).</li>
            <li>
              Menú superior/lateral: <em>En mi iPhone</em> o <em>iCloud Drive</em> →{' '}
              <em>Descargas</em> → entra en tu carpeta.
            </li>
            <li>
              Arriba a la derecha: <em>Seleccionar</em> → marca los MP3 → <em>Abrir</em>.
            </li>
          </ol>
          <p className="ios-upload-hint__note">
            Safari no puede abrir una carpeta entera; hay que marcar los archivos.
          </p>
        </div>
      )}

      <button
        type="button"
        className="folder-cta"
        onClick={() => (onIphone ? iosFilesRef.current?.click() : void importFolder())}
      >
        <div className="folder-cta__icon">
          <IconUpload size={32} />
        </div>
        <div className="folder-cta__text">
          <strong>{onIphone ? 'Examinar Archivos' : 'Elegir carpeta (MP3)'}</strong>
          <span>
            {onIphone
              ? 'Explorar → En mi iPhone / iCloud → Descargas → tu carpeta'
              : canPickFolder
                ? 'Chrome / Edge en PC · recorre subcarpetas'
                : 'Selecciona archivos de audio'}
          </span>
        </div>
      </button>

      {!onIphone && (
        <button type="button" className="folder-cta" onClick={() => void importFolder()}>
          <div className="folder-cta__icon">
            <IconUpload size={32} />
          </div>
          <div className="folder-cta__text">
            <strong>Elegir carpeta (solo audio)</strong>
            <span>
              {canPickFolder
                ? 'Ideal tras “Pasar al móvil → Exportar a carpeta”'
                : 'Si no hay carpetas, elige varios archivos'}
            </span>
          </div>
        </button>
      )}

      <button type="button" className="folder-cta" onClick={() => zipRef.current?.click()}>
        <div className="folder-cta__icon">
          <IconUpload size={32} />
        </div>
        <div className="folder-cta__text">
          <strong>Importar ZIP</strong>
          <span>Solo si son ZIP pequeños. En iPhone suele ir mejor con MP3 sueltos.</span>
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
          <span>Canción o playlist enviada con MyVibe</span>
        </div>
      </button>

      {!onIphone && (
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
      )}

      {/* iPhone: accept all files so Files browser shows folders (audio-only hides them) */}
      <input
        ref={iosFilesRef}
        type="file"
        accept="*/*"
        multiple
        hidden
        onChange={(e) => {
          void handleIncomingFiles(e.target.files)
          e.target.value = ''
        }}
      />
      <input
        ref={inputRef}
        type="file"
        accept="audio/*,.mp3,.m4a,.zip,.myvibe,application/zip"
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
        accept=".zip,application/zip,application/x-zip-compressed,*/*"
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
        accept=".myvibe,application/json,*/*"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) void handleShareFile(file)
          e.target.value = ''
        }}
      />
      {!onIphone && (
        <input
          ref={folderRef}
          type="file"
          multiple
          hidden
          {...{ webkitdirectory: '', directory: '' }}
          onChange={(e) => void handleAudioFiles(e.target.files)}
        />
      )}

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
        <h2>{onIphone ? 'En iPhone' : 'Pasar música del PC al móvil'}</h2>
        {onIphone ? (
          <ol>
            <li>Pulsa Examinar Archivos.</li>
            <li>Pestaña Explorar (no Recientes).</li>
            <li>En mi iPhone o iCloud Drive → Descargas → entra en la carpeta.</li>
            <li>Seleccionar → marca los MP3 → Abrir.</li>
          </ol>
        ) : (
          <ol>
            <li>En el PC: Perfil → Pasar al móvil → Exportar a carpeta.</li>
            <li>Copia la carpeta al móvil (USB o Drive).</li>
            <li>En iPhone: Subir → Elegir canciones desde Archivos.</li>
          </ol>
        )}
      </section>
    </div>
  )
}
