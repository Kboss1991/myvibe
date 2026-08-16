import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { AppIcon } from '../components/AppIcon'
import { BrandWordmark } from '../components/BrandWordmark'
import { isAppleMobile } from '../lib/folderImport'
import { saveFilesVisibly, type VisibleFile } from '../lib/visibleStorage'
import { startWifiClient, type WifiTransferProgress } from '../lib/wifiTransfer'
import { useAuthStore } from '../store/authStore'
import './pages.css'

export function ReceivePage() {
  const user = useAuthStore((s) => s.user)
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<WifiTransferProgress | null>(null)
  const [doneCount, setDoneCount] = useState<number | null>(null)
  const [visibleFiles, setVisibleFiles] = useState<VisibleFile[]>([])
  const [exportBusy, setExportBusy] = useState(false)
  const [exportMsg, setExportMsg] = useState<string | null>(null)
  const stopRef = useRef<(() => void) | null>(null)
  const autoStarted = useRef(false)
  const onIphone = isAppleMobile()

  useEffect(() => {
    return () => {
      stopRef.current?.()
    }
  }, [])

  async function startReceive(overrideCode?: string) {
    const useCode = (overrideCode ?? code).replace(/\D/g, '').slice(0, 6)
    if (useCode.length !== 6) {
      setError('El código debe tener 6 dígitos')
      return
    }
    setCode(useCode)
    setError(null)
    setDoneCount(null)
    setVisibleFiles([])
    setExportMsg(null)
    setProgress(null)
    setBusy(true)
    setStatus('Iniciando…')
    stopRef.current?.()
    try {
      const session = await startWifiClient(useCode, {
        onStatus: setStatus,
        onProgress: setProgress,
        onError: (msg) => {
          setError(msg)
          setBusy(false)
          setStatus(null)
        },
        onFinished: (imported, files) => {
          setDoneCount(imported)
          setVisibleFiles(files)
          setBusy(false)
          setProgress(null)
          setStatus(`Listo: ${imported} canciones en MyVibe`)
        },
      })
      stopRef.current = session.stop
    } catch (e) {
      setBusy(false)
      setStatus(null)
      setError(e instanceof Error ? e.message : 'No se pudo conectar')
    }
  }

  useEffect(() => {
    const fromQr = searchParams.get('code')?.replace(/\D/g, '').slice(0, 6) ?? ''
    if (fromQr.length === 6) {
      setCode(fromQr)
      if (!autoStarted.current) {
        autoStarted.current = true
        void startReceive(fromQr)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

  function cancel() {
    stopRef.current?.()
    stopRef.current = null
    setBusy(false)
    setStatus(null)
    setProgress(null)
  }

  async function saveToDownloads() {
    if (!visibleFiles.length) return
    setExportBusy(true)
    setExportMsg(null)
    setError(null)
    try {
      const result = await saveFilesVisibly(visibleFiles, {
        interactive: true,
        onProgress: (done, total, name) =>
          setExportMsg(`Guardando ${done}/${total}${name ? ` · ${name}` : ''}`),
      })
      setExportMsg(result.message)
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        setExportMsg('Cancelado')
      } else {
        setError(e instanceof Error ? e.message : 'No se pudo guardar en Descargas')
      }
    } finally {
      setExportBusy(false)
    }
  }

  return (
    <div className="receive-page">
      <div className="receive-card">
        <AppIcon size={64} className="receive-logo" />
        <BrandWordmark className="receive-brand" />
        <h1>Recibir por Wi‑Fi</h1>
        <p className="receive-sub">
          Escanea el QR del PC. Luego puedes guardar copias visibles en{' '}
          <strong>Descargas → MyVibe</strong> (Archivos del iPhone).
        </p>

        <label className="receive-label">
          Código
          <input
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={6}
            autoComplete="one-time-code"
            placeholder="123456"
            value={code}
            disabled={busy}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          />
        </label>

        {!busy && doneCount == null && (
          <button
            type="button"
            className="btn-primary"
            style={{ width: '100%' }}
            disabled={code.length !== 6}
            onClick={() => void startReceive()}
          >
            Conectar y recibir
          </button>
        )}

        {busy && (
          <>
            <div className="wifi-progress" aria-live="polite">
              <div className="wifi-progress__row">
                <span className="wifi-progress__label">Total</span>
                <span className="wifi-progress__pct">{progress?.overallPercent ?? 0}%</span>
              </div>
              <div className="wifi-progress__bar">
                <div style={{ width: `${progress?.overallPercent ?? 0}%` }} />
              </div>
              <div className="wifi-progress__track">
                <p className="wifi-progress__track-name">
                  {progress?.name || status || 'Conectando…'}
                </p>
                <div className="wifi-progress__row">
                  <span className="wifi-progress__label">Esta canción</span>
                  <span className="wifi-progress__pct">{progress?.trackPercent ?? 0}%</span>
                </div>
                <div className="wifi-progress__bar wifi-progress__bar--track">
                  <div style={{ width: `${progress?.trackPercent ?? 0}%` }} />
                </div>
              </div>
              {progress && progress.total > 0 ? (
                <p className="wifi-progress__meta">
                  {progress.done}/{progress.total}
                  {status ? ` · ${status}` : ''}
                </p>
              ) : status ? (
                <p className="wifi-progress__meta">{status}</p>
              ) : null}
            </div>
            <button type="button" className="btn-outline" style={{ width: '100%' }} onClick={cancel}>
              Cancelar
            </button>
          </>
        )}

        {doneCount != null && (
          <>
            <p className="form-status">
              {doneCount} canciones en MyVibe (reproductor).
            </p>
            {visibleFiles.length > 0 && (
              <>
                <button
                  type="button"
                  className="btn-primary"
                  style={{ width: '100%' }}
                  disabled={exportBusy}
                  onClick={() => void saveToDownloads()}
                >
                  {exportBusy
                    ? 'Guardando…'
                    : onIphone
                      ? 'Guardar en Archivos / Descargas'
                      : 'Guardar en carpeta Descargas/MyVibe'}
                </button>
                {onIphone && (
                  <p className="receive-sub" style={{ marginTop: 0 }}>
                    En el menú: <em>Guardar en Archivos</em> → Descargas → crea/elige la carpeta{' '}
                    <strong>MyVibe</strong>.
                  </p>
                )}
              </>
            )}
            {exportMsg && <p className="form-status">{exportMsg}</p>}
            <button
              type="button"
              className="btn-outline"
              style={{ width: '100%' }}
              onClick={() => navigate(user ? '/library' : '/')}
            >
              {user ? 'Abrir biblioteca' : 'Iniciar sesión / crear cuenta'}
            </button>
          </>
        )}

        {error && <p className="form-error">{error}</p>}

        <p className="receive-footer">
          {user ? (
            <Link to="/upload">Volver a Subir</Link>
          ) : (
            <Link to="/">Volver al login</Link>
          )}
        </p>
      </div>
    </div>
  )
}
