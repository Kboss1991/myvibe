import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { CoverArt } from '../components/CoverArt'
import { UserAvatar } from '../components/UserAvatar'
import { IconHeart, IconPodcast } from '../components/Icons'
import {
  fetchLatestFromMyPodcasts,
  type LatestPodcastItem,
} from '../lib/podcastRss'
import { formatEpisodeDate, getMyPodcasts } from '../lib/podcasts'
import { playlistCoverArtProps } from '../lib/library'
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
  const playPodcastEpisode = usePlayerStore((s) => s.playPodcastEpisode)
  const recent = getRecent()
  const liked = getLiked()
  const latest = tracks.slice(0, 12)
  const [greet, setGreet] = useState(() => greetingForHour(new Date().getHours()))
  const myPodcasts = getMyPodcasts()
  const [podcastNews, setPodcastNews] = useState<LatestPodcastItem[]>([])
  const [podcastNewsLoading, setPodcastNewsLoading] = useState(false)

  useEffect(() => {
    const tick = () => setGreet(greetingForHour(new Date().getHours()))
    tick()
    const id = window.setInterval(tick, 60_000)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    if (!myPodcasts.length) {
      setPodcastNews([])
      return
    }
    let cancelled = false
    setPodcastNewsLoading(true)
    void fetchLatestFromMyPodcasts(myPodcasts, 12)
      .then((items) => {
        if (!cancelled) setPodcastNews(items)
      })
      .catch(() => {
        if (!cancelled) setPodcastNews([])
      })
      .finally(() => {
        if (!cancelled) setPodcastNewsLoading(false)
      })
    return () => {
      cancelled = true
    }
    // Recargar cuando cambia cuántos podcasts tienes guardados
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myPodcasts.length])

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
            <Link
              to="/liked"
              className="home-quick home-quick--liked"
              aria-label="Canciones que te gustan"
            >
              <span className="home-quick__liked">
                <IconHeart size={22} filled />
              </span>
              <span>Canciones que te gustan</span>
            </Link>
          )}
        </div>

        {!tracks.length && (
          <div className="home-quick-grid">
            <Link to="/upload" className="home-quick">
              <span className="home-quick__liked" style={{ background: 'var(--accent)' }}>
                +
              </span>
              <span>Subir tu primera carpeta MP3</span>
            </Link>
          </div>
        )}
      </header>

      {myPodcasts.length > 0 && (
        <section className="section">
          <div className="section__head">
            <h2>Lo nuevo en tus podcasts</h2>
            <Link to="/podcasts">Mostrar todos</Link>
          </div>
          {podcastNewsLoading && podcastNews.length === 0 ? (
            <p className="empty-state__hint home-podcast-hint">Buscando episodios nuevos…</p>
          ) : podcastNews.length === 0 ? (
            <p className="empty-state__hint home-podcast-hint">
              No se pudieron cargar episodios ahora. Ábrelos en Podcasts.
            </p>
          ) : (
            <div className="h-scroll home-cover-row">
              {podcastNews.map(({ episode, show }) => {
                const art = episode.artworkUrl || show.artworkUrl
                const date = formatEpisodeDate(episode.pubDate)
                return (
                  <button
                    key={episode.id}
                    type="button"
                    className="home-cover-card"
                    onClick={() =>
                      void playPodcastEpisode(
                        episode,
                        show,
                        podcastNews
                          .filter((x) => x.show.id === show.id)
                          .map((x) => x.episode),
                      )
                    }
                    aria-label={`Reproducir ${episode.title}`}
                  >
                    <span className="home-cover-card__art home-cover-card__art--podcast">
                      {art ? (
                        <img src={art} alt="" loading="lazy" referrerPolicy="no-referrer" />
                      ) : (
                        <span className="home-cover-card__podcast-fallback">
                          <IconPodcast size={40} />
                        </span>
                      )}
                    </span>
                    <strong>{episode.title}</strong>
                    <span>
                      {show.name}
                      {date ? ` · ${date}` : ''}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </section>
      )}

      {recent.length > 0 && (
        <section className="section">
          <div className="section__head">
            <h2>Escuchado recientemente</h2>
          </div>
          <div className="h-scroll home-cover-row">
            {recent.slice(0, 12).map((t) => (
              <div key={t.id} className="home-cover-card home-cover-card--static">
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
              </div>
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
            {playlists.slice(0, 10).map((p) => {
              const cover = playlistCoverArtProps(p)
              return (
              <Link key={p.id} to={`/playlist/${p.id}`} className="home-cover-card">
                <span className="home-cover-card__art">
                  <CoverArt
                    trackId={cover.trackId}
                    hasCover={cover.hasCover}
                    refreshKey={cover.refreshKey}
                    size={200}
                    rounded="md"
                  />
                </span>
                <strong>{p.name}</strong>
                <span>{p.trackIds.length} canciones</span>
              </Link>
              )
            })}
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
              <div key={t.id} className="home-cover-card home-cover-card--static">
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
              </div>
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
