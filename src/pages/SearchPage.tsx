import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { CoverArt } from '../components/CoverArt'
import { TrackList } from '../components/TrackList'
import { IconSearch } from '../components/Icons'
import { playlistCoverArtProps } from '../lib/library'
import { useLibraryStore } from '../store/libraryStore'
import { useLibraryPlayerStore } from '../store/libraryPlayerStore'
import './pages.css'

export function SearchPage() {
  const [q, setQ] = useState('')
  const search = useLibraryStore((s) => s.search)
  const artists = useLibraryStore((s) => s.artists)
  const albums = useLibraryStore((s) => s.albums)
  const tracks = useLibraryStore((s) => s.tracks)
  const playlists = useLibraryStore((s) => s.playlists)
  const playTracks = useLibraryPlayerStore((s) => s.playTracks)

  const query = q.trim().toLowerCase()
  const hasQuery = query.length > 0

  const trackResults = useMemo(() => (hasQuery ? search(q) : []), [q, search, tracks, hasQuery])

  const artistResults = useMemo(() => {
    if (!hasQuery) return []
    return artists().filter((a) => a.name.toLowerCase().includes(query)).slice(0, 24)
  }, [artists, query, hasQuery, tracks])

  const albumResults = useMemo(() => {
    if (!hasQuery) return []
    return albums()
      .filter(
        (a) =>
          a.name.toLowerCase().includes(query) || a.artist.toLowerCase().includes(query),
      )
      .slice(0, 24)
  }, [albums, query, hasQuery, tracks])

  const playlistResults = useMemo(() => {
    if (!hasQuery) return []
    return playlists
      .filter((p) => p.name.toLowerCase().includes(query))
      .slice(0, 24)
  }, [playlists, query, hasQuery])

  const total =
    trackResults.length +
    artistResults.length +
    albumResults.length +
    playlistResults.length

  return (
    <div className="page search-page">
      <div className={`search-hero ${hasQuery ? 'has-query' : ''}`}>
        <label className="search-box search-box--hero">
          <IconSearch size={24} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="¿Qué quieres escuchar?"
            autoCapitalize="off"
            autoCorrect="off"
            autoFocus
            aria-label="Buscar canciones, álbumes, artistas o playlists"
          />
          {q ? (
            <button
              type="button"
              className="search-box__clear"
              aria-label="Borrar búsqueda"
              onClick={() => setQ('')}
            >
              ×
            </button>
          ) : null}
        </label>
        {!hasQuery && (
          <p className="search-hero__hint">
            Busca canciones, álbumes, artistas o playlists de tu biblioteca
          </p>
        )}
      </div>

      {hasQuery && (
        <div className="search-results">
          {total === 0 ? (
            <div className="empty-state fade-up">
              <p className="empty-state__title">Sin resultados</p>
              <p className="empty-state__hint">Prueba con otro título, artista o playlist</p>
            </div>
          ) : (
            <>
              {artistResults.length > 0 && (
                <section className="section">
                  <h2 className="section__title">Artistas</h2>
                  <div className="h-scroll home-cover-row">
                    {artistResults.map((a) => {
                      const cover = a.tracks.find((t) => t.hasCover) ?? a.tracks[0]
                      return (
                        <button
                          key={a.name}
                          type="button"
                          className="home-cover-card home-cover-card--artist"
                          onClick={() =>
                            void playTracks(
                              a.tracks
                                .filter((t) => t.hasLocalAudio !== false)
                                .map((t) => t.id),
                            )
                          }
                        >
                          <span className="home-cover-card__art">
                            <CoverArt
                              trackId={cover?.id}
                              hasCover={cover?.hasCover}
                              size={160}
                              rounded="full"
                            />
                          </span>
                          <strong>{a.name}</strong>
                          <span>Artista · {a.tracks.length}</span>
                        </button>
                      )
                    })}
                  </div>
                </section>
              )}

              {albumResults.length > 0 && (
                <section className="section">
                  <h2 className="section__title">Álbumes</h2>
                  <div className="h-scroll home-cover-row">
                    {albumResults.map((a) => {
                      const cover = a.tracks.find((t) => t.hasCover) ?? a.tracks[0]
                      return (
                        <button
                          key={`${a.name}-${a.artist}`}
                          type="button"
                          className="home-cover-card"
                          onClick={() =>
                            void playTracks(
                              a.tracks
                                .filter((t) => t.hasLocalAudio !== false)
                                .map((t) => t.id),
                            )
                          }
                        >
                          <span className="home-cover-card__art">
                            <CoverArt
                              trackId={cover?.id}
                              hasCover={cover?.hasCover}
                              size={160}
                              rounded="md"
                            />
                          </span>
                          <strong>{a.name}</strong>
                          <span>{a.artist}</span>
                        </button>
                      )
                    })}
                  </div>
                </section>
              )}

              {playlistResults.length > 0 && (
                <section className="section">
                  <h2 className="section__title">Playlists</h2>
                  <div className="h-scroll home-cover-row">
                    {playlistResults.map((p) => {
                      const cover = playlistCoverArtProps(p)
                      return (
                      <Link key={p.id} to={`/playlist/${p.id}`} className="home-cover-card">
                        <span className="home-cover-card__art">
                          <CoverArt
                            trackId={cover.trackId}
                            hasCover={cover.hasCover}
                            refreshKey={cover.refreshKey}
                            size={160}
                            rounded="md"
                          />
                        </span>
                        <strong>{p.name}</strong>
                        <span>Playlist · {p.trackIds.length}</span>
                      </Link>
                      )
                    })}
                  </div>
                </section>
              )}

              {trackResults.length > 0 && (
                <section className="section">
                  <h2 className="section__title">
                    Canciones
                    <span className="section__count">{trackResults.length}</span>
                  </h2>
                  <TrackList
                    tracks={trackResults}
                    emptyTitle="Sin canciones"
                    emptyHint=""
                    selectable={false}
                  />
                </section>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
