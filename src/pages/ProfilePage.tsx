import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import { useLibraryStore } from '../store/libraryStore'
import { hasRealEmail } from '../lib/auth'
import { startWifiHost } from '../lib/wifiTransfer'
import { buildReceiveUrl, isLocalhostHost, receiveQrDataUrl } from '../lib/receiveQr'
import { IconDownload, IconEdit } from '../components/Icons'
import { UserAvatar } from '../components/UserAvatar'
import './pages.css'
import '../components/TrackList.css'

type Sheet = 'profile' | 'email' | 'password' | 'transfer' | null

export function ProfilePage() {
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)
  const updateProfile = useAuthStore((s) => s.updateProfile)
  const setEmail = useAuthStore((s) => s.setEmail)
  const setAvatar = useAuthStore((s) => s.setAvatar)
  const clearAvatar = useAuthStore((s) => s.clearAvatar)
  const exportAccount = useAuthStore((s) => s.exportAccount)
  const changePassword = useAuthStore((s) => s.changePassword)
  const authError = useAuthStore((s) => s.error)
  const clearError = useAuthStore((s) => s.clearError)
  const tracks = useLibraryStore((s) => s.tracks)
  const playlists = useLibraryStore((s) => s.playlists)
  const getLiked = useLibraryStore((s) => s.getLiked)
  const exportLibraryFolder = useLibraryStore((s) => s.exportLibraryFolder)
  const exportLibraryPacks = useLibraryStore((s) => s.exportLibraryPacks)
  const importProgress = useLibraryStore((s) => s.importProgress)
  const navigate = useNavigate()
  const avatarInputRef = useRef<HTMLInputElement>(null)

  const [sheet, setSheet] = useState<Sheet>(null)
  const [displayName, setDisplayName] = useState(user?.displayName ?? '')
  const [bio, setBio] = useState(user?.bio ?? '')
  const [email, setEmailField] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [okMsg, setOkMsg] = useState<string | null>(null)
  const [wifiCode, setWifiCode] = useState<string | null>(null)
  const [wifiQr, setWifiQr] = useState<string | null>(null)
  const [wifiReceiveUrl, setWifiReceiveUrl] = useState<string | null>(null)
  const [wifiStatus, setWifiStatus] = useState<string | null>(null)
  const [wifiProgress, setWifiProgress] = useState<{
    done: number
    total: number
    name: string
  } | null>(null)
  const wifiStopRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    return () => {
      wifiStopRef.current?.()
    }
  }, [])

  if (!user) return null

  const liked = getLiked().length
  const needsEmail = !hasRealEmail(user)
  const error = localError || authError
  const exporting = Boolean(importProgress)

  function openSheet(next: Sheet) {
    if (!user) return
    clearError()
    setLocalError(null)
    setOkMsg(null)
    setEmailField(needsEmail ? '' : user.email)
    setNewPassword('')
    setConfirmPassword('')
    if (next === 'profile') {
      setDisplayName(user.displayName)
      setBio(user.bio)
    }
    setSheet(next)
  }

  function closeSheet() {
    if (sheet === 'transfer') {
      wifiStopRef.current?.()
      wifiStopRef.current = null
      setWifiCode(null)
      setWifiQr(null)
      setWifiReceiveUrl(null)
      setWifiStatus(null)
      setWifiProgress(null)
    }
    setSheet(null)
    setLocalError(null)
    clearError()
  }

  async function handleWifiSend() {
    setLocalError(null)
    setOkMsg(null)
    if (!tracks.length) {
      setLocalError('No hay canciones para enviar')
      return
    }
    wifiStopRef.current?.()
    setWifiQr(null)
    setWifiReceiveUrl(null)
    setBusy(true)
    setWifiStatus('Preparando…')
    try {
      const session = await startWifiHost({
        onCode: (code) => {
          setWifiCode(code)
          setBusy(false)
          const url = buildReceiveUrl(code)
          setWifiReceiveUrl(url)
          void receiveQrDataUrl(code)
            .then(setWifiQr)
            .catch(() => setWifiQr(null))
        },
        onStatus: setWifiStatus,
        onProgress: (done, total, name) => setWifiProgress({ done, total, name }),
        onError: (msg) => {
          setLocalError(msg)
          setBusy(false)
        },
        onFinished: () => {
          setOkMsg('Música enviada al móvil · ya está en su biblioteca MyVibe')
          setWifiProgress(null)
          setBusy(false)
        },
      })
      wifiStopRef.current = session.stop
    } catch (e) {
      setBusy(false)
      setLocalError(e instanceof Error ? e.message : 'No se pudo iniciar el envío Wi‑Fi')
    }
  }

  async function handleAvatarFile(file: File | undefined) {
    if (!file) return
    setLocalError(null)
    clearError()
    setBusy(true)
    try {
      await setAvatar(file)
      setOkMsg('Avatar actualizado')
    } catch {
      // error en store
    } finally {
      setBusy(false)
    }
  }

  async function handleExportFolder() {
    setLocalError(null)
    setOkMsg(null)
    if (!tracks.length) {
      setLocalError('No hay canciones para transferir')
      return
    }
    setBusy(true)
    try {
      const result = await exportLibraryFolder()
      setOkMsg(
        `Listo: ${result.count} MP3 en la carpeta “${result.folderHint}”. Cópiala al móvil (USB/Drive) y en Subir elige esa carpeta.`,
      )
      setSheet(null)
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return
      setLocalError(e instanceof Error ? e.message : 'No se pudo exportar a carpeta')
    } finally {
      setBusy(false)
    }
  }

  async function handleExportPacks() {
    setLocalError(null)
    setOkMsg(null)
    if (!tracks.length) {
      setLocalError('No hay canciones para transferir')
      return
    }
    setBusy(true)
    try {
      const result = await exportLibraryPacks()
      setOkMsg(
        `Descargados ${result.packs} ZIP pequeños (${result.tracks} canciones). En el móvil importa cada parte en Subir.`,
      )
      setSheet(null)
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return
      setLocalError(e instanceof Error ? e.message : 'No se pudieron crear los paquetes')
    } finally {
      setBusy(false)
    }
  }

  async function handleExportAccount() {
    setLocalError(null)
    setOkMsg(null)
    setBusy(true)
    try {
      await exportAccount()
      setOkMsg(
        'Cuenta descargada. En el móvil: login → Importar cuenta (mismo correo y contraseña).',
      )
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : 'No se pudo exportar la cuenta')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page profile-page">
      <div
        className="profile-hero"
        style={{
          background: `linear-gradient(180deg, hsl(${user.avatarHue} 40% 28%) 0%, #121212 100%)`,
        }}
      >
        <button
          type="button"
          className="profile-avatar-btn"
          disabled={busy}
          onClick={() => avatarInputRef.current?.click()}
          aria-label="Cambiar foto de perfil"
        >
          <UserAvatar user={user} size={140} className="profile-avatar" />
          <span className="profile-avatar-overlay">Cambiar</span>
        </button>
        <input
          ref={avatarInputRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            void handleAvatarFile(e.target.files?.[0])
            e.target.value = ''
          }}
        />
        <div className="profile-meta">
          <p className="profile-label">Perfil</p>
          <h1>{user.displayName}</h1>
          <p className="profile-stats">
            <span>{needsEmail ? `@${user.username}` : user.email}</span>
            <span>·</span>
            <span>{tracks.length} canciones</span>
            <span>·</span>
            <span>{playlists.length} playlists</span>
            <span>·</span>
            <span>{liked} me gusta</span>
          </p>
          {user.bio && <p className="profile-bio">{user.bio}</p>}
        </div>
      </div>

      <div className="profile-actions">
        <button className="btn-outline" onClick={() => openSheet('profile')}>
          <IconEdit size={18} /> Editar perfil
        </button>
        <button
          className="btn-outline"
          disabled={busy || exporting || !tracks.length}
          onClick={() => openSheet('transfer')}
        >
          <IconDownload size={18} /> Pasar al móvil
        </button>
        <button
          className="btn-outline"
          disabled={busy}
          onClick={() => void handleExportAccount()}
        >
          <IconDownload size={18} /> Exportar cuenta
        </button>
        {needsEmail ? (
          <button className="btn-outline" onClick={() => openSheet('email')}>
            Añadir correo
          </button>
        ) : (
          <button className="btn-outline" onClick={() => openSheet('email')}>
            Cambiar correo
          </button>
        )}
        <button className="btn-outline" onClick={() => openSheet('password')}>
          Cambiar contraseña
        </button>
        <button
          className="btn-outline danger-outline"
          onClick={() => {
            logout()
            navigate('/')
          }}
        >
          Cerrar sesión
        </button>
      </div>

      {exporting && (
        <div className="import-progress">
          <div className="import-progress__bar">
            <div
              style={{
                width: `${
                  importProgress!.total
                    ? (importProgress!.done / importProgress!.total) * 100
                    : 0
                }%`,
              }}
            />
          </div>
          <p>
            Preparando transferencia {importProgress!.done}/{importProgress!.total}
            {importProgress!.name ? ` · ${importProgress!.name}` : ''}
          </p>
        </div>
      )}

      {okMsg && !sheet && <p className="form-status">{okMsg}</p>}
      {localError && !sheet && <p className="form-error">{localError}</p>}
      {authError && !sheet && <p className="form-error">{authError}</p>}

      <p className="profile-transfer-hint">
        En el móvil: escanea el <strong>QR</strong> (cámara) y la música se guarda sola en la
        biblioteca de MyVibe.
      </p>

      {sheet === 'transfer' && (
        <div className="sheet">
          <button type="button" className="sheet-backdrop" onClick={closeSheet} />
          <div className="sheet__panel">
            <h3>Pasar música al móvil</h3>

            <button
              type="button"
              className="btn-primary"
              disabled={busy || Boolean(wifiCode)}
              style={{ width: '100%', marginBottom: 10 }}
              onClick={() => void handleWifiSend()}
            >
              1. Enviar por QR / Wi‑Fi (recomendado)
            </button>
            <p className="profile-sheet-hint">
              Genera un QR. En el móvil abre la cámara, escanea y MyVibe recibe y guarda las
              canciones en su biblioteca.
            </p>

            {wifiCode && (
              <div className="wifi-code-box">
                <p>Escanea con la cámara del móvil</p>
                {wifiQr ? (
                  <img className="wifi-qr" src={wifiQr} alt={`QR código ${wifiCode}`} />
                ) : (
                  <p className="form-status">Generando QR…</p>
                )}
                <strong>{wifiCode}</strong>
                <span className="wifi-code-alt">o escribe el código en /receive</span>
                {isLocalhostHost() && (
                  <p className="form-error" style={{ marginTop: 8 }}>
                    Estás en localhost: el QR no servirá en el móvil. Abre MyVibe en el PC con tu IP
                    de red (ej. http://192.168.x.x:5174) y vuelve a generar el envío.
                  </p>
                )}
                {wifiReceiveUrl && !isLocalhostHost() && (
                  <span className="wifi-url-hint">{wifiReceiveUrl}</span>
                )}
                {wifiStatus && <span>{wifiStatus}</span>}
                {wifiProgress && (
                  <span>
                    {wifiProgress.done}/{wifiProgress.total}
                    {wifiProgress.name ? ` · ${wifiProgress.name}` : ''}
                  </span>
                )}
                <button
                  type="button"
                  className="btn-outline"
                  style={{ width: '100%', marginTop: 10 }}
                  onClick={() => {
                    wifiStopRef.current?.()
                    wifiStopRef.current = null
                    setWifiCode(null)
                    setWifiQr(null)
                    setWifiReceiveUrl(null)
                    setWifiStatus(null)
                    setWifiProgress(null)
                  }}
                >
                  Cancelar envío
                </button>
              </div>
            )}

            <button
              type="button"
              className="btn-outline"
              disabled={busy || exporting || Boolean(wifiCode)}
              style={{ width: '100%', marginBottom: 10, marginTop: 8 }}
              onClick={() => void handleExportFolder()}
            >
              2. Exportar a carpeta (PC)
            </button>
            <p className="profile-sheet-hint">Chrome/Edge · carpeta MyVibe-export · USB/Drive.</p>

            <button
              type="button"
              className="btn-outline"
              disabled={busy || exporting || Boolean(wifiCode)}
              style={{ width: '100%', marginBottom: 10 }}
              onClick={() => void handleExportPacks()}
            >
              3. ZIP pequeños
            </button>

            {(busy || exporting) && !wifiCode && (
              <p className="form-status">
                {importProgress
                  ? `${importProgress.done}/${importProgress.total}${
                      importProgress.name ? ` · ${importProgress.name}` : ''
                    }`
                  : 'Trabajando…'}
              </p>
            )}
            {localError && <p className="form-error">{localError}</p>}
          </div>
        </div>
      )}

      {sheet === 'profile' && (
        <div className="sheet">
          <button type="button" className="sheet-backdrop" onClick={closeSheet} />
          <div className="sheet__panel">
            <h3>Editar perfil</h3>
            <div className="profile-edit-avatar">
              <UserAvatar user={user} size={72} />
              <div className="profile-edit-avatar-actions">
                <button
                  type="button"
                  className="btn-outline"
                  disabled={busy}
                  onClick={() => avatarInputRef.current?.click()}
                >
                  Subir foto
                </button>
                {user.hasAvatar && (
                  <button
                    type="button"
                    className="btn-outline danger-outline"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true)
                      try {
                        await clearAvatar()
                        setOkMsg('Avatar eliminado')
                      } finally {
                        setBusy(false)
                      }
                    }}
                  >
                    Quitar foto
                  </button>
                )}
              </div>
            </div>
            <label className="field">
              Nombre
              <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </label>
            <label className="field">
              Bio
              <input
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                placeholder="Cuéntanos algo"
              />
            </label>
            <button
              type="button"
              className="btn-primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  await updateProfile({
                    displayName: displayName.trim() || user.username,
                    bio: bio.trim(),
                    avatarHue: Math.floor(Math.random() * 360),
                  })
                  setOkMsg('Perfil actualizado')
                  closeSheet()
                } finally {
                  setBusy(false)
                }
              }}
            >
              Guardar
            </button>
          </div>
        </div>
      )}

      {sheet === 'email' && (
        <div className="sheet">
          <button type="button" className="sheet-backdrop" onClick={closeSheet} />
          <div className="sheet__panel">
            <h3>{needsEmail ? 'Añadir correo' : 'Cambiar correo'}</h3>
            <p className="profile-sheet-hint">
              Lo usarás para iniciar sesión en este dispositivo.
            </p>
            <label className="field">
              Correo electrónico
              <input
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmailField(e.target.value)}
                placeholder="tu@email.com"
                autoFocus
              />
            </label>
            {error && <p className="form-error">{error}</p>}
            <button
              type="button"
              className="btn-primary"
              disabled={busy}
              onClick={async () => {
                setLocalError(null)
                clearError()
                setBusy(true)
                try {
                  await setEmail(email)
                  setOkMsg('Correo guardado')
                  closeSheet()
                } catch {
                  // error en store
                } finally {
                  setBusy(false)
                }
              }}
            >
              Guardar correo
            </button>
          </div>
        </div>
      )}

      {sheet === 'password' && (
        <div className="sheet">
          <button type="button" className="sheet-backdrop" onClick={closeSheet} />
          <div className="sheet__panel">
            <h3>Cambiar contraseña</h3>
            <label className="field">
              Nueva contraseña
              <input
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoFocus
              />
            </label>
            <label className="field">
              Repetir nueva contraseña
              <input
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </label>
            {error && <p className="form-error">{error}</p>}
            <button
              type="button"
              className="btn-primary"
              disabled={busy}
              onClick={async () => {
                setLocalError(null)
                clearError()
                if (newPassword !== confirmPassword) {
                  setLocalError('Las contraseñas nuevas no coinciden')
                  return
                }
                setBusy(true)
                try {
                  await changePassword(newPassword)
                  setOkMsg('Contraseña actualizada')
                  closeSheet()
                } catch {
                  // error en store
                } finally {
                  setBusy(false)
                }
              }}
            >
              Guardar contraseña
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
