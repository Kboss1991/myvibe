import { Link } from 'react-router-dom'
import { TrackList } from '../components/TrackList'
import { CoverArt } from '../components/CoverArt'
import { UserAvatar } from '../components/UserAvatar'
import { IconCar, IconPlay, IconHeart } from '../components/Icons'
import { useAuthStore } from '../store/authStore'
import { useLibraryStore } from '../store/libraryStore'
import { usePlayerStore } from '../store/playerStore'
import './pages.css'

export function HomePage() {
  const user = useAuthStore((s) => s.user)
  const tracks = useLibraryStore((s) => s.tracks)
  const playlists = useLibraryStore((s) => s.playlists)
  const getRecent = useLibraryStore((s) => s.getRecent)
  const getLiked = useLibraryStore((s) => s.getLiked)
  const playTracks = usePlayerStore((s) => s.playTracks)
  const setCarMode = usePlayerStore((s) => s.setCarMode)
  const recent = getRecent()
  const liked = getLiked()
  const latest = tracks.slice(0, 8)
  const hour = new Date().getHours()
  const greet =
    hour < 12 ? 'Buenos días' : hour < 19 ? 'Buenas tardes' : 'Buenas noches'

  return (
    <div className="page home-page">
      <header className="spotify-hero">
        <div className="spotify-hero__top">
          <h1>
            {greet}
            {user ? `, ${user.displayName.split(' ')[0]}` : ''}
          </h1>
          <div className="spotify-hero__actions">
            <button className="btn-ghost" onClick={() => setCarMode(true)}>
              <IconCar size={18} /> Modo coche
            </button>
            <Link to="/profile" className="home-avatar-link" aria-label="Perfil">
              <UserAvatar user={user} size={32} className="home-avatar" />
            </Link>
          </div>
        </div>

        <div className="home-quick-grid">
          {liked.length > 0 && (
            <button
              className="home-quick"
              onClick={() => void playTracks(liked.map((t) => t.id))}
            >
              <span className="home-quick__liked">
                <IconHeart size={22} filled />
              </span>
              <span>Canciones que te gustan</span>
              <span className="home-quick__play">
                <IconPlay size={18} />
              </span>
            </button>
          )}
          {playlists.slice(0, 5).map((p) => (
            <Link key={p.id} to={`/playlist/${p.id}`} className="home-quick">
              <CoverArt trackId={p.trackIds[0]} hasCover={!!p.trackIds[0]} size={56} />
              <span>{p.name}</span>
            </Link>
          ))}
          {!tracks.length && (
            <Link to="/upload" className="home-quick">
              <span className="home-quick__liked" style={{ background: '#f5a623' }}>
                +
              </span>
              <span>Subir tu primera carpeta MP3</span>
            </Link>
          )}
        </div>
      </header>

      {recent.length > 0 && (
        <section className="section">
          <div className="section__head">
            <h2>Escuchado recientemente</h2>
          </div>
          <TrackList tracks={recent.slice(0, 6)} />
        </section>
      )}

      {playlists.length > 0 && (
        <section className="section">
          <div className="section__head">
            <h2>Hecho para ti</h2>
            <Link to="/library">Mostrar todos</Link>
          </div>
          <div className="h-scroll">
            {playlists.slice(0, 10).map((p) => (
              <Link key={p.id} to={`/playlist/${p.id}`} className="spotify-card">
                <CoverArt
                  trackId={p.trackIds[0]}
                  hasCover={!!p.trackIds[0]}
                  size={160}
                  rounded="md"
                />
                <strong>{p.name}</strong>
                <span>{p.trackIds.length} canciones</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="section">
        <div className="section__head">
          <h2>{tracks.length ? 'Tus canciones' : 'Empieza aquí'}</h2>
          {tracks.length > 0 && (
            <button
              className="chip-play"
              onClick={() => void playTracks(tracks.map((t) => t.id))}
            >
              <IconPlay size={16} /> Reproducir
            </button>
          )}
        </div>
        <TrackList
          tracks={latest}
          emptyTitle="Tu biblioteca está vacía"
          emptyHint="Sube una carpeta de MP3 y completamos el perfil de cada canción online"
        />
      </section>
    </div>
  )
}
