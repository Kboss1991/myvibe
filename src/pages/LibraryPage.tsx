import { useMemo, useState } from 'react'
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

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
}

export function LibraryPage() {
  const [tab, setTab] = useState<Tab>('songs')
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [query, setQuery] = useState('')
  const [genreFilter, setGenreFilter] = useState<string | null>(null)
  const tracks = useLibraryStore((s) => s.tracks)
  const playlists = useLibraryStore((s) => s.playlists)
  const search = useLibraryStore((s) => s.search)
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
  const q = query.trim()
  const qn = norm(q)

  const filteredTracks = useMemo(() => (q ? search(q) : tracks), [q, search, tracks])
  const filteredPlaylists = useMemo(() => {
    if (!qn) return playlists
    return playlists.filter((p) => norm(p.name).includes(qn))
  }, [playlists, qn])
  const filteredArtists = useMemo(() => {
    const list = artists()
    if (!qn) return list
    return list.filter((a) => norm(a.name).includes(qn))
  }, [artists, tracks, qn])
  const filteredAlbums = useMemo(() => {
    const list = albums()
    if (!qn) return list
    return list.filter(
      (a) => norm(a.name).includes(qn) || norm(a.artist).includes(qn),
    )
  }, [albums, tracks, qn])
  const genreGroups = genres()
  const filteredGenres = useMemo(() => {
    if (!qn) return genreGroups
    return genreGroups.filter((g) => norm(g.name).includes(qn))
  }, [genreGroups, qn])
  const genreTracks = genreFilter
    ? genreGroups.find((g) => g.name === genreFilter)?.tracks ?? []
    : []
  const filteredGenreTracks = useMemo(() => {
    if (!genreFilter) return []
    if (!q) return genreTracks
    const allowed = new Set(search(q).map((t) => t.id))
    return genreTracks.filter((t) => allowed.has(t.id))
  }, [genreFilter, genreTracks, q, search])

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

      <label className="search-box library-search">
        <IconSearch size={18} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar en tu biblioteca"
          autoCapitalize="off"
          autoCorrect="off"
          enterKeyHint="search"
        />
        {query ? (
          <button
            type="button"
            className="library-search__clear"
            aria-label="Limpiar búsqueda"
            onClick={() => setQuery('')}
          >
            ×
          </button>
        ) : null}
      </label>

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
          {!q && liked.length > 0 && (
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
            <h2>
              {q
                ? `${filteredTracks.length} resultado${filteredTracks.length === 1 ? '' : 's'}`
                : `${tracks.length} canciones`}
            </h2>
            <div className="section__head-actions">
              {!q && missingCover.length > 0 && (
                <button
                  type="button"
                  className="library-quiet-action"
                  disabled={enrichBusy}
                  title="Buscar portada, artista y álbum en internet"
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
                  <IconSearch size={14} />
                  {enrichBusy
                    ? 'Buscando…'
                    : enrichProgress
                      ? `${enrichProgress.done}/${enrichProgress.total}`
                      : `${missingCover.length} sin datos`}
                </button>
              )}
              {filteredTracks.length > 0 && (
                <button
                  type="button"
                  className="chip-play"
                  onClick={() => void playTracks(filteredTracks.map((t) => t.id))}
                >
                  <IconPlay size={16} /> Reproducir
                </button>
              )}
            </div>
          </div>
          <TrackList
            tracks={filteredTracks}
            showColumns
            emptyTitle={q ? 'Sin resultados' : 'Sin canciones'}
            emptyHint={q ? 'Prueba con otro título o artista' : 'Sube música para empezar'}
          />
        </>
      )}

      {tab === 'playlists' && (
        <ul className="playlist-list">
          {filteredPlaylists.map((p) => (
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
          {filteredPlaylists.length === 0 && (
            <div className="empty-state">
              <p className="empty-state__title">{q ? 'Sin resultados' : 'Sin playlists'}</p>
              <p className="empty-state__hint">
                {q ? 'Prueba con otro nombre' : 'Pulsa + para crear una'}
              </p>
            </div>
          )}
        </ul>
      )}

      {tab === 'artists' && (
        <ul className="simple-list">
          {filteredArtists.map((a) => (
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
          {filteredArtists.length === 0 && (
            <div className="empty-state">
              <p className="empty-state__title">{q ? 'Sin resultados' : 'Sin artistas'}</p>
            </div>
          )}
        </ul>
      )}

      {tab === 'albums' && (
        <ul className="simple-list">
          {filteredAlbums.map((a) => (
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
          {filteredAlbums.length === 0 && (
            <div className="empty-state">
              <p className="empty-state__title">{q ? 'Sin resultados' : 'Sin álbumes'}</p>
            </div>
          )}
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
                {filteredGenreTracks.length > 0 && (
                  <button
                    type="button"
                    className="chip-play"
                    onClick={() => void playTracks(filteredGenreTracks.map((t) => t.id))}
                  >
                    <IconPlay size={16} /> Reproducir
                  </button>
                )}
              </div>
              <TrackList
                tracks={filteredGenreTracks}
                showColumns
                emptyTitle={q ? 'Sin resultados' : 'Sin canciones'}
                emptyHint={q ? 'Prueba con otro título' : undefined}
              />
            </>
          ) : (
            <ul className="playlist-list">
              {filteredGenres.map((g) => (
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
              {filteredGenres.length === 0 && (
                <div className="empty-state">
                  <p className="empty-state__title">{q ? 'Sin resultados' : 'Sin géneros'}</p>
                  <p className="empty-state__hint">
                    {q
                      ? 'Prueba con otro nombre'
                      : 'Sube canciones o busca info online para etiquetarlas'}
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
