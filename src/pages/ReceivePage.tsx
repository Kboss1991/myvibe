import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { AppIcon } from '../components/AppIcon'
import { startWifiClient } from '../lib/wifiTransfer'
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
  const [progress, setProgress] = useState<{
    done: number
    total: number
    name: string
  } | null>(null)
  const [doneCount, setDoneCount] = useState<number | null>(null)
  const stopRef = useRef<(() => void) | null>(null)
  const autoStarted = useRef(false)

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
    setProgress(null)
    setBusy(true)
    setStatus('Iniciando…')
    stopRef.current?.()
    try {
      const session = await startWifiClient(useCode, {
        onStatus: setStatus,
        onProgress: (done, total, name) => setProgress({ done, total, name }),
        onError: (msg) => {
          setError(msg)
          setBusy(false)
          setStatus(null)
        },
        onFinished: (imported) => {
          setDoneCount(imported)
          setBusy(false)
          setProgress(null)
          setStatus(`Listo: ${imported} canciones en tu biblioteca`)
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
    // Solo al montar / cambiar query
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

  function cancel() {
    stopRef.current?.()
    stopRef.current = null
    setBusy(false)
    setStatus(null)
    setProgress(null)
  }

  return (
    <div className="receive-page">
      <div className="receive-card">
        <AppIcon size={64} className="receive-logo" />
        <h1>Recibir por Wi‑Fi</h1>
        <p className="receive-sub">
          Escanea el QR del PC o escribe el código. Las canciones se guardan en la biblioteca de
          MyVibe en este móvil.
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
            <div className="import-progress">
              <div className="import-progress__bar">
                <div
                  style={{
                    width: `${
                      progress?.total ? (progress.done / progress.total) * 100 : 8
                    }%`,
                  }}
                />
              </div>
              <p>
                {status}
                {progress?.name ? ` · ${progress.name}` : ''}
                {progress ? ` (${progress.done}/${progress.total})` : ''}
              </p>
            </div>
            <button type="button" className="btn-outline" style={{ width: '100%' }} onClick={cancel}>
              Cancelar
            </button>
          </>
        )}

        {doneCount != null && (
          <>
            <p className="form-status">
              {doneCount} canciones guardadas en MyVibe. Ya las puedes reproducir.
            </p>
            <button
              type="button"
              className="btn-primary"
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
