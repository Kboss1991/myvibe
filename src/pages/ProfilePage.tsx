import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import { useLibraryStore } from '../store/libraryStore'
import { hasRealEmail, isCloudAuthEnabled } from '../lib/auth'
import { IconEdit } from '../components/Icons'
import { UserAvatar } from '../components/UserAvatar'
import {
  claimLibraryHost,
  clearLibraryHostClaim,
  formatLastSeen,
  isLibraryHostDevice,
  listDevices,
  revokeDevice,
  type UserDevice,
} from '../lib/devices'
import { isLibraryHostCapable } from '../lib/folderImport'
import {
  addFriendByCode,
  addFriendByEmail,
  ensureInviteCode,
  listCircle,
  listSharedPlaylists,
  removeFriend,
  sharePlaylistWithFriend,
  type CircleFriend,
  type SharedPlaylistCard,
} from '../lib/friends'
import { computeListenStats, formatListenMinutes } from '../lib/listenStats'
import { checkTasteTablesReady, TASTE_SQL_HINT } from '../lib/cloudLibrary'
import { TASTE_SYNC_SQL } from '../lib/tasteSyncSql'
import './pages.css'
import '../components/TrackList.css'

function supabaseSqlEditorUrl(): string | null {
  const raw = import.meta.env.VITE_SUPABASE_URL as string | undefined
  if (!raw) return null
  try {
    const host = new URL(raw).hostname // xxx.supabase.co
    const ref = host.split('.')[0]
    if (!ref) return null
    return `https://supabase.com/dashboard/project/${ref}/sql/new`
  } catch {
    return null
  }
}

export function ProfilePage() {
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)
  const updateProfile = useAuthStore((s) => s.updateProfile)
  const setEmail = useAuthStore((s) => s.setEmail)
  const setAvatar = useAuthStore((s) => s.setAvatar)
  const clearAvatar = useAuthStore((s) => s.clearAvatar)
  const changePassword = useAuthStore((s) => s.changePassword)
  const authError = useAuthStore((s) => s.error)
  const clearError = useAuthStore((s) => s.clearError)
  const tracks = useLibraryStore((s) => s.tracks)
  const playlists = useLibraryStore((s) => s.playlists)
  const getLiked = useLibraryStore((s) => s.getLiked)
  const lastSyncMessage = useLibraryStore((s) => s.lastSyncMessage)
  const lastSyncAt = useLibraryStore((s) => s.lastSyncAt)
  const pcOnline = useLibraryStore((s) => s.pcOnline)
  const syncCloudCatalog = useLibraryStore((s) => s.syncCloudCatalog)
  const navigate = useNavigate()
  const avatarInputRef = useRef<HTMLInputElement>(null)

  const [editing, setEditing] = useState(false)
  const [displayName, setDisplayName] = useState(user?.displayName ?? '')
  const [bio, setBio] = useState(user?.bio ?? '')
  const [email, setEmailField] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [okMsg, setOkMsg] = useState<string | null>(null)
  const [orphanCount, setOrphanCount] = useState<{ audio: number; covers: number } | null>(null)

  const [devices, setDevices] = useState<UserDevice[]>([])
  const [inviteCode, setInviteCode] = useState('')
  const [friends, setFriends] = useState<CircleFriend[]>([])
  const [shared, setShared] = useState<SharedPlaylistCard[]>([])
  const [friendInput, setFriendInput] = useState('')
  const [shareFriendId, setShareFriendId] = useState('')
  const [sharePlaylistId, setSharePlaylistId] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [tasteReady, setTasteReady] = useState<boolean | null>(null)

  const stats = useMemo(() => computeListenStats(tracks), [tracks])
  const isHost = isLibraryHostDevice()
  const canHost = isLibraryHostCapable()
  const cloud = isCloudAuthEnabled()
  const sqlEditorUrl = supabaseSqlEditorUrl()

  async function refreshProfileExtras() {
    if (!user) return
    try {
      const [devs, code, circle, shares, taste] = await Promise.all([
        listDevices(user.id),
        ensureInviteCode(user.id).catch(() => ''),
        listCircle(user.id).catch(() => [] as CircleFriend[]),
        listSharedPlaylists(user.id).catch(() => [] as SharedPlaylistCard[]),
        checkTasteTablesReady().catch(() => ({
          ok: false,
          likes: false,
          playlists: false,
          message: TASTE_SQL_HINT,
        })),
      ])
      setDevices(devs)
      setInviteCode(code)
      setFriends(circle)
      setShared(shares)
      setTasteReady(taste.ok)
      if (!taste.ok && taste.message) {
        setLocalError(taste.message)
      }
    } catch (e) {
      console.warn('Perfil extras', e)
    }
  }

  useEffect(() => {
    void useLibraryStore
      .getState()
      .countOrphanStorage()
      .then(setOrphanCount)
      .catch(() => setOrphanCount({ audio: 0, covers: 0 }))
  }, [tracks.length])

  useEffect(() => {
    void refreshProfileExtras()
  }, [user?.id])

  if (!user) return null

  const liked = getLiked().length
  const needsEmail = !hasRealEmail(user)
  const error = localError || authError
  const orphanTotal = orphanCount ? orphanCount.audio + orphanCount.covers : 0
  const hostDevice = devices.find((d) => d.isLibraryHost)

  function openEdit() {
    clearError()
    setLocalError(null)
    setOkMsg(null)
    setDisplayName(user!.displayName)
    setBio(user!.bio)
    setEmailField(needsEmail ? '' : user!.email)
    setNewPassword('')
    setConfirmPassword('')
    setEditing(true)
  }

  function closeEdit() {
    setEditing(false)
    setLocalError(null)
    clearError()
    setNewPassword('')
    setConfirmPassword('')
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
      // store
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
        <button type="button" className="btn-outline" onClick={openEdit}>
          <IconEdit size={18} /> Editar perfil
        </button>
      </div>

      {/* Estadísticas */}
      <section className="profile-card">
        <h2 className="profile-card__title">Tu escucha</h2>
        <div className="profile-stats-grid">
          <div>
            <strong>{formatListenMinutes(stats.estimatedMinutes)}</strong>
            <span>tiempo estimado</span>
          </div>
          <div>
            <strong>{stats.totalPlays}</strong>
            <span>reproducciones</span>
          </div>
          <div>
            <strong>{stats.streakDays}</strong>
            <span>días de racha</span>
          </div>
          <div>
            <strong>{stats.uniqueTracksPlayed}</strong>
            <span>canciones tocadas</span>
          </div>
        </div>
        {stats.topArtists.length > 0 && (
          <div className="profile-tops">
            <h3>Top artistas</h3>
            <ol>
              {stats.topArtists.map((a) => (
                <li key={a.name}>
                  <span>{a.name}</span>
                  <em>{a.plays}</em>
                </li>
              ))}
            </ol>
          </div>
        )}
        {stats.topTracks.length > 0 && (
          <div className="profile-tops">
            <h3>Top canciones</h3>
            <ol>
              {stats.topTracks.map((t) => (
                <li key={t.id}>
                  <span>
                    {t.title}
                    <small>{t.artist}</small>
                  </span>
                  <em>{t.plays}</em>
                </li>
              ))}
            </ol>
          </div>
        )}
      </section>

      {/* Sincronización */}
      <section className="profile-card">
        <div className="profile-card__head">
          <h2 className="profile-card__title">Sincronización</h2>
          <button
            type="button"
            className="chip chip-play"
            disabled={syncing || !cloud}
            onClick={() => {
              setSyncing(true)
              setLocalError(null)
              setOkMsg(null)
              void syncCloudCatalog()
                .then(() => {
                  setOkMsg('Me gusta, playlists y catálogo sincronizados')
                  setTasteReady(true)
                  void refreshProfileExtras()
                })
                .catch((e) => {
                  const msg = e instanceof Error ? e.message : 'Error al sincronizar'
                  setLocalError(msg)
                  if (/library_likes|library_playlists|taste-sync|Faltan las tablas/i.test(msg)) {
                    setTasteReady(false)
                  }
                })
                .finally(() => setSyncing(false))
            }}
          >
            {syncing ? 'Actualizando…' : 'Actualizar ahora'}
          </button>
        </div>
        {!cloud ? (
          <p className="profile-card__hint">Supabase no configurado — todo es local en este dispositivo.</p>
        ) : (
          <>
            {tasteReady === false ? (
              <div className="profile-card__alert" role="alert">
                <p>
                  <strong>Me gusta y playlists no pueden sincronizarse:</strong> faltan tablas en
                  Supabase.
                </p>
                <ol>
                  <li>
                    Abre el{' '}
                    {sqlEditorUrl ? (
                      <a href={sqlEditorUrl} target="_blank" rel="noreferrer">
                        SQL Editor de Supabase
                      </a>
                    ) : (
                      'SQL Editor de Supabase'
                    )}
                  </li>
                  <li>
                    Pega el SQL de me gusta/playlists y pulsa <strong>Run</strong>
                  </li>
                  <li>Vuelve aquí y pulsa «Actualizar ahora»</li>
                </ol>
                <button
                  type="button"
                  className="chip"
                  style={{ marginTop: 10 }}
                  onClick={() => {
                    void navigator.clipboard
                      ?.writeText(TASTE_SYNC_SQL)
                      .then(() => setOkMsg('SQL copiado. Pégalo en Supabase → Run'))
                      .catch(() => setLocalError('No se pudo copiar; abre supabase/taste-sync.sql'))
                  }}
                >
                  Copiar SQL
                </button>
              </div>
            ) : (
              <p className="profile-card__hint">
                Me gusta y playlists se guardan solos en tu cuenta al tocarlos (PC y móvil).
              </p>
            )}
            <p className="profile-card__meta">
              Última sync:{' '}
              {lastSyncAt ? formatLastSeen(lastSyncAt) : 'aún no'}
              {pcOnline != null ? ` · PC host ${pcOnline ? 'en línea' : 'offline'}` : ''}
              {tasteReady === true ? ' · Perfil OK' : tasteReady === false ? ' · Perfil incompleto' : ''}
            </p>
            {lastSyncMessage ? <p className="profile-card__hint">{lastSyncMessage}</p> : null}
          </>
        )}
      </section>

      {/* Biblioteca principal */}
      <section className="profile-card">
        <h2 className="profile-card__title">Biblioteca principal</h2>
        <p className="profile-card__hint">
          El PC host publica el catálogo y puede borrar en la nube. El móvil descarga; no debería
          ser host.
        </p>
        <p className="profile-card__meta">
          Ahora:{' '}
          {hostDevice
            ? `${hostDevice.label}${hostDevice.isThisDevice ? ' (este)' : ''}`
            : isHost
              ? 'Este dispositivo (PC)'
              : 'Ninguno marcado · el móvil solo descarga'}
        </p>
        {canHost ? (
          <div className="profile-card__row">
            {isHost ? (
              <button
                type="button"
                className="btn-outline"
                disabled={busy}
                onClick={() => {
                  setBusy(true)
                  void clearLibraryHostClaim()
                    .then(() => {
                      setOkMsg('Ya no eres la biblioteca principal')
                      return refreshProfileExtras()
                    })
                    .catch((e) => setLocalError(e instanceof Error ? e.message : 'Error'))
                    .finally(() => setBusy(false))
                }}
              >
                Dejar de ser host
              </button>
            ) : (
              <button
                type="button"
                className="btn-outline"
                disabled={busy}
                onClick={() => {
                  setBusy(true)
                  void claimLibraryHost(user.id)
                    .then(() => {
                      setOkMsg('Este PC es la biblioteca principal')
                      return refreshProfileExtras()
                    })
                    .catch((e) => setLocalError(e instanceof Error ? e.message : 'Error'))
                    .finally(() => setBusy(false))
                }}
              >
                Marcar este PC como host
              </button>
            )}
          </div>
        ) : (
          <p className="profile-card__meta">Este dispositivo es móvil/tablet: solo descarga.</p>
        )}
      </section>

      {/* Dispositivos */}
      <section className="profile-card">
        <h2 className="profile-card__title">Dispositivos conectados</h2>
        <ul className="profile-device-list">
          {devices.map((d) => (
            <li key={d.id} className={d.isThisDevice ? 'is-this' : ''}>
              <div>
                <strong>
                  {d.label}
                  {d.isThisDevice ? ' · Este' : ''}
                  {d.isLibraryHost ? ' · Host' : ''}
                </strong>
                <span>
                  {d.kind === 'pc' ? 'PC' : d.kind === 'tablet' ? 'Tablet' : 'Móvil'} ·{' '}
                  {formatLastSeen(d.lastSeen)}
                </span>
              </div>
              {!d.isThisDevice && cloud ? (
                <button
                  type="button"
                  className="profile-danger-zone__link"
                  disabled={busy}
                  onClick={() => {
                    if (!window.confirm(`¿Cerrar sesión en «${d.label}»?`)) return
                    setBusy(true)
                    void revokeDevice(user.id, d.id)
                      .then(() => {
                        setOkMsg('Sesión remota cerrada')
                        return refreshProfileExtras()
                      })
                      .catch((e) => setLocalError(e instanceof Error ? e.message : 'Error'))
                      .finally(() => setBusy(false))
                  }}
                >
                  Cerrar sesión
                </button>
              ) : null}
            </li>
          ))}
        </ul>
        {!cloud && (
          <p className="profile-card__hint">Con la nube verás todos los dispositivos de la cuenta.</p>
        )}
      </section>

      {/* Círculo */}
      <section className="profile-card">
        <h2 className="profile-card__title">Círculo cercano</h2>
        <p className="profile-card__hint">
          No es una red abierta: solo gente que invites por código o correo. Ven “escuchando ahora”
          y puedes compartir playlists (lista de temas, sin audio).
        </p>
        {cloud ? (
          <>
            <div className="profile-invite">
              <span>Tu código</span>
              <strong>{inviteCode || '…'}</strong>
              <button
                type="button"
                className="btn-outline"
                disabled={!inviteCode}
                onClick={() => {
                  void navigator.clipboard?.writeText(inviteCode).then(() => setOkMsg('Código copiado'))
                }}
              >
                Copiar
              </button>
            </div>
            <div className="profile-friend-add">
              <input
                value={friendInput}
                onChange={(e) => setFriendInput(e.target.value)}
                placeholder="Código o correo del amigo"
                aria-label="Código o correo"
              />
              <button
                type="button"
                className="chip chip-play"
                disabled={busy || !friendInput.trim()}
                onClick={() => {
                  const raw = friendInput.trim()
                  setBusy(true)
                  setLocalError(null)
                  const run = raw.includes('@') ? addFriendByEmail(raw) : addFriendByCode(raw)
                  void run
                    .then((r) => {
                      setOkMsg(`${r.displayName} está en tu círculo`)
                      setFriendInput('')
                      return refreshProfileExtras()
                    })
                    .catch((e) => setLocalError(e instanceof Error ? e.message : 'No se pudo añadir'))
                    .finally(() => setBusy(false))
                }}
              >
                Añadir
              </button>
            </div>
            {friends.length === 0 ? (
              <p className="profile-card__meta">Todavía no hay nadie en tu círculo.</p>
            ) : (
              <ul className="profile-friend-list">
                {friends.map((f) => (
                  <li key={f.id}>
                    <div>
                      <strong>{f.displayName}</strong>
                      <span>
                        {f.listening && Date.now() - f.listening.updatedAt < 30 * 60_000
                          ? `Escuchando: ${f.listening.title} · ${f.listening.artist}`
                          : 'Sin actividad reciente'}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="profile-danger-zone__link"
                      onClick={() => {
                        void removeFriend(user.id, f.id).then(() => refreshProfileExtras())
                      }}
                    >
                      Quitar
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {friends.length > 0 && playlists.length > 0 && (
              <div className="profile-share-playlist">
                <h3>Compartir playlist</h3>
                <select
                  value={shareFriendId}
                  onChange={(e) => setShareFriendId(e.target.value)}
                  aria-label="Amigo"
                >
                  <option value="">Elige amigo</option>
                  {friends.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.displayName}
                    </option>
                  ))}
                </select>
                <select
                  value={sharePlaylistId}
                  onChange={(e) => setSharePlaylistId(e.target.value)}
                  aria-label="Playlist"
                >
                  <option value="">Elige playlist</option>
                  {playlists.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn-outline"
                  disabled={busy || !shareFriendId || !sharePlaylistId}
                  onClick={() => {
                    const pl = playlists.find((p) => p.id === sharePlaylistId)
                    if (!pl) return
                    const titles = pl.trackIds
                      .map((id) => tracks.find((t) => t.id === id)?.title)
                      .filter((x): x is string => Boolean(x))
                    setBusy(true)
                    void sharePlaylistWithFriend({
                      friendId: shareFriendId,
                      playlistLocalId: pl.id,
                      playlistName: pl.name,
                      trackTitles: titles,
                    })
                      .then(() => {
                        setOkMsg(`«${pl.name}» compartida`)
                        setShareFriendId('')
                        setSharePlaylistId('')
                        return refreshProfileExtras()
                      })
                      .catch((e) => setLocalError(e instanceof Error ? e.message : 'Error al compartir'))
                      .finally(() => setBusy(false))
                  }}
                >
                  Enviar
                </button>
              </div>
            )}

            {shared.length > 0 && (
              <div className="profile-shared">
                <h3>Compartidas</h3>
                <ul>
                  {shared.map((s) => (
                    <li key={s.id}>
                      <strong>{s.playlistName}</strong>
                      <span>
                        {s.fromMe ? 'Enviada' : 'Recibida'} · {s.trackTitles.length} temas
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        ) : (
          <p className="profile-card__meta">Activa Supabase para el círculo entre dispositivos.</p>
        )}
      </section>

      <details className="profile-danger-zone">
        <summary>Espacio en este dispositivo</summary>
        <p className="profile-danger-zone__hint">
          Libera datos de MyVibe en este {canHost ? 'PC' : 'dispositivo'}.
          {orphanTotal > 0 ? ` Hay ${orphanTotal} restos sin usar.` : ''}
        </p>
        <div className="profile-danger-zone__actions">
          <button
            type="button"
            className="profile-danger-zone__link"
            disabled={busy}
            onClick={() => {
              const onPc = isLibraryHostDevice()
              setBusy(true)
              setLocalError(null)
              void useLibraryStore
                .getState()
                .previewClearLocalMusic()
                .then((preview) => {
                  const extra = onPc
                    ? '\n\nSi este PC es la biblioteca principal, no pulses Actualizar después o puedes vaciar también la nube.'
                    : ''
                  const ok = window.confirm(preview.summary + extra)
                  if (!ok) return
                  return useLibraryStore
                    .getState()
                    .clearLocalMusic()
                    .then((r) => {
                      setOkMsg(`Borradas ${r.tracks} canciones de este dispositivo.`)
                      void useLibraryStore
                        .getState()
                        .countOrphanStorage()
                        .then(setOrphanCount)
                        .catch(() => setOrphanCount({ audio: 0, covers: 0 }))
                    })
                })
                .catch((e) => {
                  setLocalError(e instanceof Error ? e.message : 'No se pudo borrar')
                })
                .finally(() => setBusy(false))
            }}
          >
            Borrar música local
          </button>
          <button
            type="button"
            className="profile-danger-zone__link"
            disabled={busy}
            onClick={() => {
              setBusy(true)
              setLocalError(null)
              void useLibraryStore
                .getState()
                .previewOrphanPurge()
                .then((preview) => {
                  const ok = window.confirm(preview.summary)
                  if (!ok) return
                  if (preview.audio + preview.covers === 0) {
                    setOkMsg('No había datos huérfanos que limpiar.')
                    return
                  }
                  return useLibraryStore
                    .getState()
                    .purgeOrphanStorage()
                    .then((r) => {
                      const mb =
                        r.bytesApprox > 0
                          ? ` (~${Math.max(1, Math.round(r.bytesApprox / 1024 / 1024))} MB)`
                          : ''
                      setOkMsg(
                        r.audio + r.covers === 0
                          ? 'No había datos huérfanos que limpiar.'
                          : `Limpiados ${r.audio} audio y ${r.covers} carátulas sin usar${mb}.`,
                      )
                      setOrphanCount({ audio: 0, covers: 0 })
                    })
                })
                .catch((e) => {
                  setLocalError(e instanceof Error ? e.message : 'No se pudo limpiar')
                })
                .finally(() => setBusy(false))
            }}
          >
            {orphanTotal > 0 ? `Limpiar restos (${orphanTotal})` : 'Limpiar restos'}
          </button>
        </div>
      </details>

      <div className="profile-actions">
        <button
          type="button"
          className="btn-outline danger-outline"
          onClick={() => {
            logout()
            navigate('/')
          }}
        >
          Cerrar sesión
        </button>
      </div>

      {okMsg && !editing && <p className="form-status">{okMsg}</p>}
      {localError && !editing && <p className="form-error">{localError}</p>}
      {authError && !editing && <p className="form-error">{authError}</p>}

      {editing && (
        <div className="sheet">
          <button type="button" className="sheet-backdrop" onClick={closeEdit} />
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
            {needsEmail && (
              <label className="field">
                Correo electrónico
                <input
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmailField(e.target.value)}
                  placeholder="tu@email.com"
                />
              </label>
            )}
            <div className="profile-edit-security">
              <p className="profile-edit-security__title">Contraseña</p>
              <label className="field">
                Nueva contraseña
                <input
                  type="password"
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Déjalo vacío para no cambiarla"
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
            </div>
            {error && <p className="form-error">{error}</p>}
            <button
              type="button"
              className="btn-primary"
              disabled={busy}
              onClick={async () => {
                setLocalError(null)
                clearError()
                if (newPassword || confirmPassword) {
                  if (newPassword !== confirmPassword) {
                    setLocalError('Las contraseñas nuevas no coinciden')
                    return
                  }
                }
                setBusy(true)
                try {
                  if (needsEmail && email.trim()) {
                    await setEmail(email)
                  }
                  await updateProfile({
                    displayName: displayName.trim() || user.username,
                    bio: bio.trim(),
                    avatarHue: Math.floor(Math.random() * 360),
                  })
                  if (newPassword) {
                    await changePassword(newPassword)
                  }
                  setOkMsg('Perfil actualizado')
                  closeEdit()
                } catch {
                  // store
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
    </div>
  )
}
