import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'
import { useLibraryStore } from '../store/libraryStore'
import { hasRealEmail, isCloudAuthEnabled } from '../lib/auth'
import { CoverArt } from '../components/CoverArt'
import {
  IconEdit,
  IconFlame,
  IconHeadphones,
  IconMusicNote,
  IconPerson,
  IconPlay,
  IconShare,
} from '../components/Icons'
import { UserAvatar } from '../components/UserAvatar'
import { formatLastSeen, isLibraryHostDevice } from '../lib/devices'
import { isLibraryHostCapable } from '../lib/folderImport'
import { startWifiHost, type WifiTransferProgress } from '../lib/wifiTransfer'
import {
  computeListenStats,
  formatListenMinutes,
  formatPlayCountLabel,
  formatStatsMonthLabel,
} from '../lib/listenStats'
import {
  clearPlaybackDebugLog,
  formatPlaybackDebugLine,
  getPlaybackDebugLog,
} from '../lib/playbackDebug'
import './pages.css'
import '../components/TrackList.css'


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
  const [debugLog, setDebugLog] = useState(() => getPlaybackDebugLog())
  const [debugOpen, setDebugOpen] = useState(false)

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
  const [syncing, setSyncing] = useState(false)
  const [wifiSyncing, setWifiSyncing] = useState(false)
  const [wifiCode, setWifiCode] = useState<string | null>(null)
  const [wifiHostStatus, setWifiHostStatus] = useState<string | null>(null)
  const [wifiProgress, setWifiProgress] = useState<WifiTransferProgress | null>(null)
  const [manualCode, setManualCode] = useState('')
  const wifiStopRef = useRef<(() => void) | null>(null)

  const stats = useMemo(() => computeListenStats(tracks), [tracks])
  const canHost = isLibraryHostCapable()
  const onPc = isLibraryHostDevice()
  const cloud = isCloudAuthEnabled()

  useEffect(() => {
    return () => {
      wifiStopRef.current?.()
    }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (window.location.hash !== '#wifi-transfer') return
    const el = document.getElementById('wifi-transfer')
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  useEffect(() => {
    void useLibraryStore
      .getState()
      .countOrphanStorage()
      .then(setOrphanCount)
      .catch(() => setOrphanCount({ audio: 0, covers: 0 }))
  }, [tracks.length])

  if (!user) return null

  const liked = getLiked().length
  const needsEmail = !hasRealEmail(user)
  const error = localError || authError
  const orphanTotal = orphanCount ? orphanCount.audio + orphanCount.covers : 0

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

      <section className="profile-debug" aria-label="Diagnóstico de audio">
        <button
          type="button"
          className="btn-outline"
          onClick={() => {
            setDebugLog(getPlaybackDebugLog())
            setDebugOpen((v) => !v)
          }}
        >
          {debugOpen ? 'Ocultar' : 'Ver'} diagnóstico pause/play
        </button>
        {debugOpen && (
          <div className="profile-debug__box">
            <p className="profile-debug__hint">
              Tras fallar en bloqueo, abre esto y copia las líneas (o haz captura). Así veo si el
              gesto llega a la app.
            </p>
            <pre className="profile-debug__log">
              {debugLog.length
                ? debugLog.map(formatPlaybackDebugLine).join('\n')
                : 'Sin eventos aún. Reproduce un podcast, pause/play en bloqueo y vuelve aquí.'}
            </pre>
            <div className="profile-actions">
              <button
                type="button"
                className="btn-outline"
                onClick={() => {
                  setDebugLog(getPlaybackDebugLog())
                }}
              >
                Actualizar
              </button>
              <button
                type="button"
                className="btn-outline"
                onClick={async () => {
                  const text = getPlaybackDebugLog().map(formatPlaybackDebugLine).join('\n')
                  try {
                    if (navigator.share) {
                      await navigator.share({ title: 'MyVibe audio debug', text })
                    } else if (navigator.clipboard?.writeText) {
                      await navigator.clipboard.writeText(text)
                      setOkMsg('Diagnóstico copiado')
                    }
                  } catch {
                    /* ignore */
                  }
                }}
              >
                Compartir / copiar
              </button>
              <button
                type="button"
                className="btn-outline"
                onClick={() => {
                  clearPlaybackDebugLog()
                  setDebugLog([])
                }}
              >
                Borrar log
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Estadísticas */}
      <section className="stats-panel" aria-labelledby="stats-heading">
        <header className="stats-panel__header">
          <h2 id="stats-heading" className="stats-panel__title">
            Estadísticas
          </h2>
          <p className="stats-panel__eyebrow">Resumen</p>
          <p className="stats-panel__period">{formatStatsMonthLabel()}</p>
        </header>

        <div className="stats-section">
          <h3 className="stats-section__label">Tus números</h3>
          <div className="stats-numbers" role="list">
            <article className="stats-number-card" role="listitem">
              <span className="stats-number-card__icon">
                <IconHeadphones size={20} />
              </span>
              <span className="stats-number-card__label">Tiempo de música</span>
              <strong
                className={`stats-number-card__value ${
                  stats.estimatedMinutes >= 60 ? 'is-duration' : ''
                }`}
              >
                {formatListenMinutes(stats.estimatedMinutes)}
              </strong>
            </article>
            <article className="stats-number-card" role="listitem">
              <span className="stats-number-card__icon">
                <IconPerson size={20} />
              </span>
              <span className="stats-number-card__label">Artistas escuchados</span>
              <strong className="stats-number-card__value">{stats.uniqueArtists}</strong>
            </article>
            <article className="stats-number-card" role="listitem">
              <span className="stats-number-card__icon">
                <IconMusicNote size={20} />
              </span>
              <span className="stats-number-card__label">Canciones escuchadas</span>
              <strong className="stats-number-card__value">{stats.uniqueTracksPlayed}</strong>
            </article>
            <article className="stats-number-card" role="listitem">
              <span className="stats-number-card__icon">
                <IconFlame size={20} />
              </span>
              <span className="stats-number-card__label">Días de racha</span>
              <strong className="stats-number-card__value">{stats.streakDays}</strong>
            </article>
            <article className="stats-number-card" role="listitem">
              <span className="stats-number-card__icon">
                <IconPlay size={20} />
              </span>
              <span className="stats-number-card__label">Reproducciones</span>
              <strong className="stats-number-card__value">{stats.totalPlays}</strong>
            </article>
          </div>
        </div>

        {(stats.topArtists.length > 0 || stats.topTracks.length > 0) && (
          <div className="stats-section">
            <h3 className="stats-section__label">Lo más escuchado</h3>
            <div className="stats-tops" role="list">
              {stats.topArtists.length > 0 && (
                <article className="stats-top-card" role="listitem">
                  <div className="stats-top-card__head">
                    <h4>Artistas</h4>
                    <button
                      type="button"
                      className="stats-top-card__share"
                      aria-label="Compartir top artistas"
                      onClick={() => {
                        const text = [
                          'Mis artistas más escuchados en MyVibe',
                          ...stats.topArtists.map(
                            (a, i) =>
                              `${i + 1}. ${a.name} · ${formatListenMinutes(a.minutes)}`,
                          ),
                        ].join('\n')
                        if (navigator.share) {
                          void navigator.share({ title: 'Top artistas · MyVibe', text }).catch(() => {})
                        } else if (navigator.clipboard?.writeText) {
                          void navigator.clipboard.writeText(text)
                          setOkMsg('Top artistas copiado')
                        }
                      }}
                    >
                      <IconShare size={18} />
                    </button>
                  </div>
                  <ol className="stats-rank-list">
                    {stats.topArtists.map((a, i) => (
                      <li
                        key={a.name}
                        className={
                          i === 0 ? 'stats-rank-list__item is-featured' : 'stats-rank-list__item'
                        }
                      >
                        <div className="stats-rank-list__art stats-rank-list__art--round">
                          <CoverArt
                            trackId={a.coverTrackId}
                            hasCover={a.hasCover}
                            refreshKey={a.coverUpdatedAt}
                            size={i === 0 ? 72 : 44}
                            rounded="full"
                          />
                          <span className="stats-rank-badge">{i + 1}</span>
                        </div>
                        <div className="stats-rank-list__meta">
                          <span className="stats-rank-list__title">{a.name}</span>
                          <span className="stats-rank-list__sub">
                            {formatListenMinutes(a.minutes)}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ol>
                </article>
              )}

              {stats.topTracks.length > 0 && (
                <article className="stats-top-card" role="listitem">
                  <div className="stats-top-card__head">
                    <h4>Canciones</h4>
                    <button
                      type="button"
                      className="stats-top-card__share"
                      aria-label="Compartir top canciones"
                      onClick={() => {
                        const text = [
                          'Mis canciones más escuchadas en MyVibe',
                          ...stats.topTracks.map(
                            (t, i) => `${i + 1}. ${t.title} — ${t.artist} · ${formatPlayCountLabel(t.plays)}`,
                          ),
                        ].join('\n')
                        if (navigator.share) {
                          void navigator.share({ title: 'Top canciones · MyVibe', text }).catch(() => {})
                        } else if (navigator.clipboard?.writeText) {
                          void navigator.clipboard.writeText(text)
                          setOkMsg('Top canciones copiado')
                        }
                      }}
                    >
                      <IconShare size={18} />
                    </button>
                  </div>
                  <ol className="stats-rank-list">
                    {stats.topTracks.map((t, i) => (
                      <li
                        key={t.id}
                        className={
                          i === 0 ? 'stats-rank-list__item is-featured' : 'stats-rank-list__item'
                        }
                      >
                        <div className="stats-rank-list__art">
                          <CoverArt
                            trackId={t.id}
                            hasCover={t.hasCover}
                            refreshKey={t.coverUpdatedAt}
                            size={i === 0 ? 72 : 44}
                            rounded="md"
                          />
                          <span className="stats-rank-badge">{i + 1}</span>
                        </div>
                        <div className="stats-rank-list__meta">
                          <span className="stats-rank-list__title">{t.title}</span>
                          <span className="stats-rank-list__sub">{t.artist}</span>
                          <span className="stats-rank-list__sub">
                            {formatPlayCountLabel(t.plays)}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ol>
                </article>
              )}
            </div>
          </div>
        )}
      </section>

      {/* Pasar música PC ↔ móvil (local Wi‑Fi; no depende de la nube) */}
      <section className="profile-card" id="wifi-transfer">
        <h2 className="profile-card__title">Pasar música al móvil</h2>
        <p className="profile-card__hint">
          Misma Wi‑Fi. Primero todas las canciones normales (con portada). Las que pesan mucho
          (más de 12 MB) van después, <strong>una a una</strong>.
        </p>
        {onPc || canHost ? (
          <div style={{ marginTop: 14 }}>
            {!wifiCode ? (
              <button
                type="button"
                className="chip chip-play"
                style={{ width: '100%', justifyContent: 'center', padding: '14px 18px', fontSize: '1.05rem' }}
                disabled={busy}
                onClick={() => {
                  setLocalError(null)
                  setOkMsg(null)
                  setWifiProgress(null)
                  setWifiHostStatus('Preparando…')
                  wifiStopRef.current?.()
                  void startWifiHost({
                    onCode: (c) => setWifiCode(c),
                    onStatus: setWifiHostStatus,
                    onProgress: setWifiProgress,
                    onError: (msg) => {
                      setLocalError(msg)
                      setWifiHostStatus(null)
                      setWifiProgress(null)
                    },
                    onFinished: () => {
                      setOkMsg('Biblioteca enviada al móvil')
                      setWifiHostStatus('Listo. Puedes generar otro código si hace falta.')
                      setWifiProgress((p) =>
                        p
                          ? { ...p, overallPercent: 100, trackPercent: 100, name: '' }
                          : {
                              done: 0,
                              total: 0,
                              name: '',
                              trackPercent: 100,
                              overallPercent: 100,
                            },
                      )
                    },
                  })
                    .then((session) => {
                      wifiStopRef.current = session.stop
                    })
                    .catch((e) => {
                      setLocalError(e instanceof Error ? e.message : 'No se pudo iniciar Wi‑Fi')
                      setWifiHostStatus(null)
                      setWifiProgress(null)
                    })
                }}
              >
                Generar código de 6 dígitos
              </button>
            ) : (
              <div>
                <p className="profile-card__hint">Escribe este código en el iPhone → Perfil:</p>
                <p
                  style={{
                    fontSize: '2.4rem',
                    fontWeight: 800,
                    letterSpacing: '0.28em',
                    margin: '12px 0',
                    fontVariantNumeric: 'tabular-nums',
                    textAlign: 'center',
                  }}
                >
                  {wifiCode}
                </p>
                {wifiProgress && wifiProgress.total > 0 ? (
                  <div className="wifi-progress" aria-live="polite">
                    <div className="wifi-progress__row">
                      <span className="wifi-progress__label">Total</span>
                      <span className="wifi-progress__pct">{wifiProgress.overallPercent}%</span>
                    </div>
                    <div className="wifi-progress__bar">
                      <div style={{ width: `${wifiProgress.overallPercent}%` }} />
                    </div>
                    <div className="wifi-progress__track">
                      <p className="wifi-progress__track-name">
                        {wifiProgress.name || 'Preparando…'}
                      </p>
                      <div className="wifi-progress__row">
                        <span className="wifi-progress__label">Esta canción</span>
                        <span className="wifi-progress__pct">{wifiProgress.trackPercent}%</span>
                      </div>
                      <div className="wifi-progress__bar wifi-progress__bar--track">
                        <div style={{ width: `${wifiProgress.trackPercent}%` }} />
                      </div>
                    </div>
                    <p className="wifi-progress__meta">
                      {wifiProgress.done}/{wifiProgress.total} confirmadas
                      {wifiHostStatus ? ` · ${wifiHostStatus}` : ''}
                    </p>
                  </div>
                ) : (
                  <p className="profile-card__hint">
                    {wifiHostStatus || 'Deja esta pestaña abierta hasta que termine el envío.'}
                  </p>
                )}
                <button
                  type="button"
                  className="chip"
                  style={{ marginTop: 8 }}
                  onClick={() => {
                    wifiStopRef.current?.()
                    wifiStopRef.current = null
                    setWifiCode(null)
                    setWifiHostStatus(null)
                    setWifiProgress(null)
                  }}
                >
                  Detener
                </button>
              </div>
            )}
          </div>
        ) : (
          <div style={{ marginTop: 14 }}>
            <label className="profile-card__hint" style={{ display: 'block' }}>
              Código del PC (6 dígitos)
              <input
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                placeholder="123456"
                value={manualCode}
                disabled={wifiSyncing}
                onChange={(e) =>
                  setManualCode(e.target.value.replace(/\D/g, '').slice(0, 6))
                }
                style={{
                  display: 'block',
                  width: '100%',
                  marginTop: 8,
                  padding: '14px 16px',
                  fontSize: '1.35rem',
                  letterSpacing: '0.28em',
                  borderRadius: 10,
                  border: '1px solid #3e3e3e',
                  background: '#121212',
                  color: '#fff',
                  textAlign: 'center',
                }}
              />
            </label>
            <button
              type="button"
              className="chip chip-play"
              style={{
                marginTop: 12,
                width: '100%',
                justifyContent: 'center',
                padding: '14px 18px',
                fontSize: '1.05rem',
              }}
              disabled={wifiSyncing || manualCode.length !== 6}
              onClick={() => {
                setWifiSyncing(true)
                setLocalError(null)
                setOkMsg(null)
                setWifiProgress(null)
                void import('../lib/wifiTransfer')
                  .then(({ startWifiClient }) =>
                    startWifiClient(manualCode, {
                      onStatus: (msg) => {
                        setWifiHostStatus(msg)
                        useLibraryStore.setState({ lastSyncMessage: msg })
                      },
                      onProgress: setWifiProgress,
                      onError: (msg) => {
                        setLocalError(msg)
                        setWifiSyncing(false)
                        setWifiProgress(null)
                        useLibraryStore.setState({ downloadProgress: null })
                      },
                      onFinished: (imported, _files, playlists) => {
                        setOkMsg(
                          `Recibidas ${imported} canciones` +
                            (playlists ? ` · ${playlists} playlists` : ''),
                        )
                        setWifiSyncing(false)
                        setWifiProgress((p) =>
                          p
                            ? { ...p, overallPercent: 100, trackPercent: 100 }
                            : null,
                        )
                        useLibraryStore.setState({
                          downloadProgress: null,
                          lastSyncAt: Date.now(),
                          lastSyncMessage: `Wi‑Fi código: ${imported} canciones`,
                        })
                      },
                    }),
                  )
                  .catch((e) => {
                    setLocalError(e instanceof Error ? e.message : 'Error Wi‑Fi')
                    setWifiSyncing(false)
                    setWifiProgress(null)
                  })
              }}
            >
              {wifiSyncing ? 'Recibiendo…' : 'Conectar con el PC'}
            </button>
            {wifiSyncing || (wifiProgress && wifiProgress.total > 0) ? (
              <div className="wifi-progress" aria-live="polite">
                <div className="wifi-progress__row">
                  <span className="wifi-progress__label">Total</span>
                  <span className="wifi-progress__pct">
                    {wifiProgress?.overallPercent ?? 0}%
                  </span>
                </div>
                <div className="wifi-progress__bar">
                  <div style={{ width: `${wifiProgress?.overallPercent ?? 0}%` }} />
                </div>
                <div className="wifi-progress__track">
                  <p className="wifi-progress__track-name">
                    {wifiProgress?.name || wifiHostStatus || 'Conectando…'}
                  </p>
                  <div className="wifi-progress__row">
                    <span className="wifi-progress__label">Esta canción</span>
                    <span className="wifi-progress__pct">
                      {wifiProgress?.trackPercent ?? 0}%
                    </span>
                  </div>
                  <div className="wifi-progress__bar wifi-progress__bar--track">
                    <div style={{ width: `${wifiProgress?.trackPercent ?? 0}%` }} />
                  </div>
                </div>
                {wifiProgress && wifiProgress.total > 0 ? (
                  <p className="wifi-progress__meta">
                    {wifiProgress.done}/{wifiProgress.total} recibidas
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="profile-card__hint" style={{ marginTop: 10 }}>
                En el PC (Chrome): Perfil → <strong>Generar código de 6 dígitos</strong>. Misma
                Wi‑Fi.
              </p>
            )}
          </div>
        )}
      </section>

      {/* Sincronización nube (podcasts / presencia) */}
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
                  setOkMsg(
                    onPc
                      ? 'Podcasts y presencia del PC actualizados'
                      : 'Estado del PC y podcasts actualizados',
                  )
                  void useLibraryStore
                    .getState()
                    .countOrphanStorage()
                    .then(setOrphanCount)
                    .catch(() => {})
                })
                .catch((e) => {
                  const msg = e instanceof Error ? e.message : 'Error al sincronizar'
                  setLocalError(msg)
                })
                .finally(() => setSyncing(false))
            }}
          >
            {syncing ? 'Actualizando…' : 'Actualizar ahora'}
          </button>
        </div>
        {!cloud ? (
          <p className="profile-card__hint">
            Supabase no configurado — podcasts/cuenta en la nube no disponibles. La música se pasa
            igual con el código de arriba.
          </p>
        ) : (
          <>
            <p className="profile-card__hint">
              Aquí solo se sincronizan podcasts y el estado del PC. La música va por Wi‑Fi (sección
              de arriba).
            </p>
            <p className="profile-card__meta" style={{ marginTop: 12 }}>
              Última sync:{' '}
              {lastSyncAt ? formatLastSeen(lastSyncAt) : 'aún no'}
              {pcOnline != null ? ` · PC host ${pcOnline ? 'en línea' : 'offline'}` : ''}
            </p>
            {lastSyncMessage ? <p className="profile-card__hint">{lastSyncMessage}</p> : null}
          </>
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
