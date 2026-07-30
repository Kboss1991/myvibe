import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { CoverArt } from '../components/CoverArt'
import { UserAvatar } from '../components/UserAvatar'
import { IconHeart } from '../components/Icons'
import { useAuthStore } from '../store/authStore'
import { useLibraryStore } from '../store/libraryStore'
import { usePlayerStore } from '../store/playerStore'
import './pages.css'

function greetingForHour(hour: number): string {
  // Noche: 20:00–05:59 · Mañana: 06:00–11:59 · Tarde: 12:00–19:59
  if (hour >= 6 && hour < 12) return 'Buenos días'
  if (hour >= 12 && hour < 20) return 'Buenas tardes'
  return 'Buenas noches'
}

export function HomePage() {
  const user = useAuthStore((s) => s.user)
  const tracks = useLibraryStore((s) => s.tracks)
  const playlists = useLibraryStore((s) => s.playlists)
  const getRecent = useLibraryStore((s) => s.getRecent)
  const getLiked = useLibraryStore((s) => s.getLiked)
  const playTracks = usePlayerStore((s) => s.playTracks)
  const recent = getRecent()
  const liked = getLiked()
  const latest = tracks.slice(0, 12)
  const [greet, setGreet] = useState(() => greetingForHour(new Date().getHours()))

  useEffect(() => {
    const tick = () => setGreet(greetingForHour(new Date().getHours()))
    tick()
    const id = window.setInterval(tick, 60_000)
    return () => window.clearInterval(id)
  }, [])

  return (
    <div className="page home-page">
      <header className="spotify-hero">
        <div className="spotify-hero__sticky">
          <div className="spotify-hero__top">
            <h1>
              {greet}
              {user ? `, ${user.displayName.split(' ')[0]}` : ''}
            </h1>
            <div className="spotify-hero__actions">
              <Link to="/profile" className="home-avatar-link" aria-label="Perfil">
                <UserAvatar user={user} size={44} className="home-avatar" />
              </Link>
            </div>
          </div>

          {liked.length > 0 && (
            <button
              type="button"
              className="home-quick home-quick--liked"
              onClick={() => void playTracks(liked.map((t) => t.id))}
              aria-label="Reproducir canciones que te gustan"
            >
              <span className="home-quick__liked">
                <IconHeart size={22} filled />
              </span>
              <span>Canciones que te gustan</span>
            </button>
          )}
        </div>

        {(playlists.length > 0 || !tracks.length) && (
          <div className="home-quick-grid">
            {playlists.slice(0, 5).map((p) => (
              <Link key={p.id} to={`/playlist/${p.id}`} className="home-quick">
                <CoverArt trackId={p.trackIds[0]} hasCover={!!p.trackIds[0]} size={56} />
                <span>{p.name}</span>
              </Link>
            ))}
            {!tracks.length && (
              <Link to="/upload" className="home-quick">
                <span className="home-quick__liked" style={{ background: 'var(--accent)' }}>
                  +
                </span>
                <span>Subir tu primera carpeta MP3</span>
              </Link>
            )}
          </div>
        )}
      </header>

      {recent.length > 0 && (
        <section className="section">
          <div className="section__head">
            <h2>Escuchado recientemente</h2>
          </div>
          <div className="h-scroll home-cover-row">
            {recent.slice(0, 12).map((t) => (
              <button
                key={t.id}
                type="button"
                className="home-cover-card"
                onClick={() =>
                  void playTracks(
                    tracks.filter((x) => x.hasLocalAudio !== false).map((x) => x.id),
                    t.id,
                  )
                }
              >
                <span className="home-cover-card__art">
                  <CoverArt
                    trackId={t.id}
                    hasCover={t.hasCover}
                    refreshKey={`${t.artist}|${t.album}|${t.externalUrl ?? ''}|${t.coverUpdatedAt ?? 0}`}
                    size={200}
                    rounded="md"
                  />
                </span>
                <strong>{t.title}</strong>
                <span>{t.artist}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {playlists.length > 0 && (
        <section className="section">
          <div className="section__head">
            <h2>Tus playlists</h2>
            <Link to="/library">Mostrar todos</Link>
          </div>
          <div className="h-scroll home-cover-row">
            {playlists.slice(0, 10).map((p) => (
              <Link key={p.id} to={`/playlist/${p.id}`} className="home-cover-card">
                <span className="home-cover-card__art">
                  <CoverArt
                    trackId={p.trackIds[0]}
                    hasCover={!!p.trackIds[0]}
                    size={200}
                    rounded="md"
                  />
                </span>
                <strong>{p.name}</strong>
                <span>{p.trackIds.length} canciones</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {latest.length > 0 && (
        <section className="section">
          <div className="section__head">
            <h2>Tus canciones</h2>
          </div>
          <div className="h-scroll home-cover-row">
            {latest.map((t) => (
              <button
                key={t.id}
                type="button"
                className="home-cover-card"
                onClick={() =>
                  void playTracks(
                    tracks.filter((x) => x.hasLocalAudio !== false).map((x) => x.id),
                    t.id,
                  )
                }
              >
                <span className="home-cover-card__art">
                  <CoverArt
                    trackId={t.id}
                    hasCover={t.hasCover}
                    refreshKey={`${t.artist}|${t.album}|${t.externalUrl ?? ''}|${t.coverUpdatedAt ?? 0}`}
                    size={200}
                    rounded="md"
                  />
                </span>
                <strong>{t.title}</strong>
                <span>{t.artist}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {!tracks.length && (
        <section className="section">
          <div className="empty-state fade-up">
            <p className="empty-state__title">Tu biblioteca está vacía</p>
            <p className="empty-state__hint">
              Sube una carpeta de MP3 y completamos el perfil de cada canción online
            </p>
            <Link to="/upload" className="btn-primary" style={{ marginTop: 16, display: 'inline-flex' }}>
              Ir a Subir
            </Link>
          </div>
        </section>
      )}
    </div>
  )
}
