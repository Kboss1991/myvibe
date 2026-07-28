import { useState } from 'react'
import { Link } from 'react-router-dom'
import { TrackList } from '../components/TrackList'
import { CoverArt } from '../components/CoverArt'
import { IconHeart, IconPlus, IconPlay, IconTrash, IconSearch } from '../components/Icons'
import { playlistCoverId } from '../lib/library'
import { isDoubtfulMetadata } from '../lib/enrich'
import { useLibraryStore } from '../store/libraryStore'
import { usePlayerStore } from '../store/playerStore'
import './pages.css'

type Tab = 'songs' | 'playlists' | 'artists' | 'albums' | 'genres'

export function LibraryPage() {
  const [tab, setTab] = useState<Tab>('songs')
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [genreFilter, setGenreFilter] = useState<string | null>(null)
  const tracks = useLibraryStore((s) => s.tracks)
  const playlists = useLibraryStore((s) => s.playlists)
  const getLiked = useLibraryStore((s) => s.getLiked)
  const createPlaylist = useLibraryStore((s) => s.createPlaylist)
  const deletePlaylist = useLibraryStore((s) => s.deletePlaylist)
  const enrichMissingCovers = useLibraryStore((s) => s.enrichMissingCovers)
  const enrichProgress = useLibraryStore((s) => s.enrichProgress)
  const artists = useLibraryStore((s) => s.artists)
  const albums = useLibraryStore((s) => s.albums)
  const genres = useLibraryStore((s) => s.genres)
  const playTracks = usePlayerStore((s) => s.playTracks)
  const liked = getLiked()
  const missingCover = tracks.filter((t) => isDoubtfulMetadata(t))
  const [enrichBusy, setEnrichBusy] = useState(false)
  const genreGroups = genres()
  const genreTracks = genreFilter
    ? genreGroups.find((g) => g.name === genreFilter)?.tracks ?? []
    : []

  return (
    <div className="page">
      <header className="page-header row-between">
        <h1>Tu biblioteca</h1>
        <button
          type="button"
          className="icon-btn"
          aria-label="Nueva playlist"
          onClick={() => setCreating(true)}
        >
          <IconPlus size={24} />
        </button>
      </header>

      <div className="tabs">
        {(
          [
            ['songs', 'Canciones'],
            ['playlists', 'Playlists'],
            ['artists', 'Artistas'],
            ['albums', 'Álbumes'],
            ['genres', 'Géneros'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`tab ${tab === id ? 'is-active' : ''}`}
            onClick={() => {
              setTab(id)
              if (id !== 'genres') setGenreFilter(null)
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'songs' && (
        <>
          {missingCover.length > 0 && (
            <div className="enrich-banner">
              <div>
                <strong>Sin portada o datos dudosos: {missingCover.length}</strong>
                <span>Busca en internet portada oficial, artista y álbum</span>
              </div>
              <button
                type="button"
                className="btn-primary enrich-banner__btn"
                disabled={enrichBusy}
                onClick={() => {
                  setEnrichBusy(true)
                  void enrichMissingCovers()
                    .then((r) => {
                      alert(
                        `Listo: ${r.ok} actualizadas` +
                          (r.fail ? `, ${r.fail} sin resultado` : ''),
                      )
                    })
                    .finally(() => setEnrichBusy(false))
                }}
              >
                <IconSearch size={16} />{' '}
                {enrichBusy ? 'Buscando…' : 'Buscar info online'}
              </button>
            </div>
          )}
          {enrichProgress && (
            <p className="enrich-progress-text">
              {enrichProgress.done}/{enrichProgress.total}
              {enrichProgress.name ? ` · ${enrichProgress.name}` : ''}
            </p>
          )}
          {liked.length > 0 && (
            <button
              type="button"
              className="liked-banner"
              onClick={() => void playTracks(liked.map((t) => t.id))}
            >
              <span className="liked-banner__icon">
                <IconHeart size={22} filled />
              </span>
              <div>
                <strong>Canciones que te gustan</strong>
                <span>{liked.length} temas</span>
              </div>
              <IconPlay size={20} />
            </button>
          )}
          <div className="section__head tight">
            <h2>{tracks.length} canciones</h2>
            {tracks.length > 0 && (
              <button
                type="button"
                className="chip-play"
                onClick={() => void playTracks(tracks.map((t) => t.id))}
              >
                <IconPlay size={16} /> Reproducir
              </button>
            )}
          </div>
          <TrackList tracks={tracks} showColumns />
        </>
      )}

      {tab === 'playlists' && (
        <ul className="playlist-list">
          {playlists.map((p) => (
            <li key={p.id}>
              <Link to={`/playlist/${p.id}`} className="playlist-list__link">
                <CoverArt
                  trackId={p.hasCover ? playlistCoverId(p.id) : p.trackIds[0]}
                  hasCover={p.hasCover || !!p.trackIds[0]}
                  size={56}
                />
                <div>
                  <strong>{p.name}</strong>
                  <span>{p.trackIds.length} canciones</span>
                </div>
              </Link>
              <button
                type="button"
                className="icon-btn"
                aria-label="Eliminar playlist"
                onClick={() => {
                  if (confirm(`¿Eliminar “${p.name}”?`)) void deletePlaylist(p.id)
                }}
              >
                <IconTrash size={18} />
              </button>
            </li>
          ))}
          {playlists.length === 0 && (
            <div className="empty-state">
              <p className="empty-state__title">Sin playlists</p>
              <p className="empty-state__hint">Pulsa + para crear una</p>
            </div>
          )}
        </ul>
      )}

      {tab === 'artists' && (
        <ul className="simple-list">
          {artists().map((a) => (
            <li key={a.name}>
              <button type="button" onClick={() => void playTracks(a.tracks.map((t) => t.id))}>
                <CoverArt
                  trackId={a.tracks[0]?.id}
                  hasCover={a.tracks[0]?.hasCover}
                  size={48}
                  rounded="full"
                />
                <div>
                  <strong>{a.name}</strong>
                  <span>{a.tracks.length} canciones</span>
                </div>
                <IconPlay size={18} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {tab === 'albums' && (
        <ul className="simple-list">
          {albums().map((a) => (
            <li key={`${a.name}-${a.artist}`}>
              <button type="button" onClick={() => void playTracks(a.tracks.map((t) => t.id))}>
                <CoverArt
                  trackId={a.tracks[0]?.id}
                  hasCover={a.tracks[0]?.hasCover}
                  size={48}
                />
                <div>
                  <strong>{a.name}</strong>
                  <span>{a.artist}</span>
                </div>
                <IconPlay size={18} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {tab === 'genres' && (
        <>
          {genreFilter ? (
            <>
              <div className="section__head tight">
                <button
                  type="button"
                  className="chip-play"
                  onClick={() => setGenreFilter(null)}
                >
                  ← Géneros
                </button>
                <h2>{genreFilter}</h2>
                {genreTracks.length > 0 && (
                  <button
                    type="button"
                    className="chip-play"
                    onClick={() => void playTracks(genreTracks.map((t) => t.id))}
                  >
                    <IconPlay size={16} /> Reproducir
                  </button>
                )}
              </div>
              <TrackList tracks={genreTracks} showColumns />
            </>
          ) : (
            <ul className="playlist-list">
              {genreGroups.map((g) => (
                <li key={g.name}>
                  <button
                    type="button"
                    className="playlist-list__link"
                    onClick={() => setGenreFilter(g.name)}
                  >
                    <CoverArt
                      trackId={g.tracks[0]?.id}
                      hasCover={g.tracks[0]?.hasCover}
                      size={48}
                    />
                    <div>
                      <strong>{g.name}</strong>
                      <span>
                        {g.tracks.length}{' '}
                        {g.tracks.length === 1 ? 'canción' : 'canciones'}
                      </span>
                    </div>
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Reproducir ${g.name}`}
                    onClick={() => void playTracks(g.tracks.map((t) => t.id))}
                  >
                    <IconPlay size={18} />
                  </button>
                </li>
              ))}
              {genreGroups.length === 0 && (
                <div className="empty-state">
                  <p className="empty-state__title">Sin géneros</p>
                  <p className="empty-state__hint">
                    Sube canciones o busca info online para etiquetarlas
                  </p>
                </div>
              )}
            </ul>
          )}
        </>
      )}

      {creating && (
        <div className="sheet">
          <button type="button" className="sheet-backdrop" onClick={() => setCreating(false)} />
          <div className="sheet__panel">
            <h3>Nueva playlist</h3>
            <label className="field">
              Nombre
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Mi playlist"
                autoFocus
              />
            </label>
            <button
              type="button"
              className="btn-primary"
              onClick={async () => {
                await createPlaylist(name || 'Nueva playlist')
                setName('')
                setCreating(false)
                setTab('playlists')
              }}
            >
              Crear
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
