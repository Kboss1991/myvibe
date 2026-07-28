import { useEffect, useRef, useState, type FormEvent } from 'react'
import { AppIcon } from '../components/AppIcon'
import { BrandWordmark } from '../components/BrandWordmark'
import { isCloudAuthEnabled, isInsecureLanContext } from '../lib/auth'
import { useAuthStore } from '../store/authStore'
import './Auth.css'

export function AuthPage() {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const rememberedEmail = useAuthStore((s) => s.rememberedEmail)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [remember, setRemember] = useState(true)
  const [busy, setBusy] = useState(false)
  const [importMsg, setImportMsg] = useState<string | null>(null)
  const login = useAuthStore((s) => s.login)
  const register = useAuthStore((s) => s.register)
  const requestPasswordReset = useAuthStore((s) => s.requestPasswordReset)
  const importAccount = useAuthStore((s) => s.importAccount)
  const error = useAuthStore((s) => s.error)
  const clearError = useAuthStore((s) => s.clearError)
  const lanHttp = isInsecureLanContext()
  const cloud = isCloudAuthEnabled()
  const accountInputRef = useRef<HTMLInputElement>(null)
  const [resetMsg, setResetMsg] = useState<string | null>(null)

  useEffect(() => {
    if (rememberedEmail) setEmail(rememberedEmail)
  }, [rememberedEmail])

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    clearError()
    setImportMsg(null)
    try {
      if (mode === 'login') await login(email, password, remember)
      else await register(email, password, displayName, remember)
    } catch {
      // error in store
    } finally {
      setBusy(false)
    }
  }

  async function handleImportAccount(file: File | undefined) {
    if (!file) return
    setBusy(true)
    clearError()
    setImportMsg(null)
    try {
      await importAccount(file)
      const name = file.name.toLowerCase()
      const zipMod = await import('../lib/zip')
      if (name.endsWith('.zip') || (await zipMod.looksLikeZip(file))) {
        try {
          const { extractZipEntries, audioFilesFromZipEntries } = zipMod
          const { useLibraryStore } = await import('../store/libraryStore')
          const entries = await extractZipEntries(file)
          const audioFiles = audioFilesFromZipEntries(entries)
          if (audioFiles.length) {
            setImportMsg(`Cuenta lista. Importando ${audioFiles.length} canciones…`)
            await useLibraryStore.getState().importFiles(audioFiles, {
              mp3Only: false,
              enrich: false,
            })
          }
        } catch {
          // Solo cuenta; la música se puede subir después
        }
      }
      setImportMsg('Cuenta importada. Ya estás dentro.')
    } catch {
      // error en store
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-logo" aria-hidden>
          <AppIcon size={96} />
        </div>
        <BrandWordmark as="h1" className="auth-brand" />
        <p className="auth-sub">
          {mode === 'login' ? 'Inicia sesión con tu correo' : 'Crea tu cuenta con correo'}
        </p>

        {!cloud && (
          <>
            <button
              type="button"
              className="auth-import"
              disabled={busy}
              onClick={() => accountInputRef.current?.click()}
            >
              Importar cuenta desde PC / otro dispositivo
            </button>
            <input
              ref={accountInputRef}
              type="file"
              accept=".zip,.myvibe-account,application/zip,application/json"
              hidden
              onChange={(e) => {
                void handleImportAccount(e.target.files?.[0])
                e.target.value = ''
              }}
            />
            {importMsg && <p className="auth-import-ok">{importMsg}</p>}
          </>
        )}

        <form onSubmit={(e) => void submit(e)} className="auth-form">
          {mode === 'register' && (
            <label>
              Nombre para mostrar
              <input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Tu nombre"
                autoComplete="nickname"
                enterKeyHint="next"
              />
            </label>
          )}
          <label>
            Correo electrónico
            <input
              type="email"
              inputMode="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="tu@email.com"
              autoComplete="email"
              required
              enterKeyHint="next"
            />
          </label>
          <label>
            Contraseña
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={cloud ? 'Mínimo 6 caracteres' : '••••••••'}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              required
              minLength={cloud ? 6 : 4}
              enterKeyHint="done"
            />
          </label>

          <label className="auth-remember">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            Mantener sesión iniciada en este dispositivo
          </label>

          {error && <p className="auth-error">{error}</p>}
          {resetMsg && <p className="auth-import-ok">{resetMsg}</p>}

          <button type="submit" className="auth-submit" disabled={busy}>
            {busy
              ? lanHttp
                ? 'Preparando… (puede tardar unos segundos)'
                : 'Espera…'
              : mode === 'login'
                ? 'Iniciar sesión'
                : 'Registrarse'}
          </button>
        </form>

        {cloud && mode === 'login' && (
          <button
            type="button"
            className="auth-switch"
            disabled={busy || !email.trim()}
            onClick={() => {
              setBusy(true)
              clearError()
              setResetMsg(null)
              void requestPasswordReset(email)
                .then(() =>
                  setResetMsg('Te hemos enviado un correo para restablecer la contraseña.'),
                )
                .catch(() => {})
                .finally(() => setBusy(false))
            }}
          >
            ¿Olvidaste la contraseña?
          </button>
        )}

        <button
          type="button"
          className="auth-switch"
          onClick={() => {
            clearError()
            setResetMsg(null)
            setMode(mode === 'login' ? 'register' : 'login')
          }}
        >
          {mode === 'login'
            ? '¿No tienes cuenta? Regístrate'
            : '¿Ya tienes cuenta? Inicia sesión'}
        </button>
      </div>
    </div>
  )
}
