import { useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { TrackList } from '../components/TrackList'
import { TrackColumnsHead } from '../components/TrackColumnsHead'
import { CoverArt } from '../components/CoverArt'
import { PlaylistBuilderSheet } from '../components/PlaylistBuilderSheet'
import {
  IconPlus,
  IconPlay,
  IconTrash,
  IconSearch,
  IconSparkles,
  IconUpload,
  IconSelect,
  IconClose,
} from '../components/Icons'
import { playlistCoverArtProps } from '../lib/library'
import { isDoubtfulMetadata } from '../lib/enrich'
import { useMainScrollCollapse } from '../hooks/useMainScrollCollapse'
import { useLibraryStore } from '../store/libraryStore'
import { usePlayerStore } from '../store/playerStore'
import './pages.css'

type Tab = 'songs' | 'playlists' | 'artists' | 'albums' | 'genres'

export function LibraryPage() {
  const [tab, setTab] = useState<Tab>('songs')
  const [creating, setCreating] = useState(false)
  const [genreFilter, setGenreFilter] = useState<string | null>(null)
  const [selectMode, setSelectMode] = useState(false)
  const tracks = useLibraryStore((s) => s.tracks)
  const playlists = useLibraryStore((s) => s.playlists)
  const deletePlaylist = useLibraryStore((s) => s.deletePlaylist)
  const enrichMissingCovers = useLibraryStore((s) => s.enrichMissingCovers)
  const enrichProgress = useLibraryStore((s) => s.enrichProgress)
  const replaceMissingAudio = useLibraryStore((s) => s.replaceMissingAudio)
  const artists = useLibraryStore((s) => s.artists)
  const albums = useLibraryStore((s) => s.albums)
  const genres = useLibraryStore((s) => s.genres)
  const playTracks = usePlayerStore((s) => s.playTracks)
  const missingCover = tracks.filter((t) => isDoubtfulMetadata(t))
  const missingAudio = tracks.filter((t) => t.hasLocalAudio === false)
  const [enrichBusy, setEnrichBusy] = useState(false)
  const [restoreBusy, setRestoreBusy] = useState(false)
  const restoreInputRef = useRef<HTMLInputElement>(null)

  const artistList = useMemo(() => artists(), [artists, tracks])
  const albumList = useMemo(() => albums(), [albums, tracks])
  const genreGroups = genres()
  const genreTracks = genreFilter
    ? genreGroups.find((g) => g.name === genreFilter)?.tracks ?? []
    : []

  const { progress, collapsed } = useMainScrollCollapse(64)

  const metaLabel =
    tab === 'songs'
      ? `${tracks.length} canciones`
      : tab === 'playlists'
        ? `${playlists.length} playlist${playlists.length === 1 ? '' : 's'}`
        : tab === 'artists'
          ? `${artistList.length} artista${artistList.length === 1 ? '' : 's'}`
          : tab === 'albums'
            ? `${albumList.length} álbum${albumList.length === 1 ? '' : 'es'}`
            : genreFilter
              ? genreFilter
              : `${genreGroups.length} género${genreGroups.length === 1 ? '' : 's'}`

  const playQueueIds = useMemo(() => {
    if (tab === 'genres' && genreFilter) return genreTracks.map((t) => t.id)
    return tracks.map((t) => t.id)
  }, [tab, genreFilter, genreTracks, tracks])

  const showSelect =
    (tab === 'songs' && tracks.length > 0) ||
    (tab === 'genres' && Boolean(genreFilter) && genreTracks.length > 0)

  return (
    <div
      className={`page library-page ${collapsed ? 'is-scrolled' : ''}`}
      style={{ ['--sticky-p' as string]: String(progress) }}
    >
      <div className="sticky-chrome">
        <div className="sticky-chrome__title">
          <h1>Tu biblioteca</h1>
          <button
            type="button"
            className="icon-btn"
            aria-label="Nueva playlist"
            onClick={() => setCreating(true)}
          >
            <IconPlus size={24} />
          </button>
        </div>

        <div className="tabs library-tabs sticky-chrome__tabs">
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
                setSelectMode(false)
                if (id !== 'genres') setGenreFilter(null)
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="sticky-chrome__meta">
          <div className="library-songs-head__count">
            {tab === 'genres' && genreFilter ? (
              <button
                type="button"
                className="chip-play"
                onClick={() => {
                  setGenreFilter(null)
                  setSelectMode(false)
                }}
              >
                ← Géneros
              </button>
            ) : null}
            <h2>{metaLabel}</h2>
            <Link
              to="/search"
              className="library-meta-icon"
              aria-label="Buscar en la biblioteca"
              title="Buscar"
            >
              <IconSearch size={16} />
            </Link>
            {tab === 'songs' && missingCover.length > 0 ? (
              <button
                type="button"
                className="library-meta-icon"
                disabled={enrichBusy}
                aria-label={
                  enrichBusy
                    ? 'Mejorando datos…'
                    : `Completar datos de ${missingCover.length} canciones`
                }
                title="Mejorar portada, artista y álbum"
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
                <IconSparkles size={16} />
                {enrichBusy || enrichProgress ? (
                  <span className="library-meta-icon__hint">
                    {enrichProgress
                      ? `${enrichProgress.done}/${enrichProgress.total}`
                      : '…'}
                  </span>
                ) : null}
              </button>
            ) : null}
            {showSelect ? (
              <button
                type="button"
                className={`library-select-btn ${selectMode ? 'is-on' : ''}`}
                aria-label={selectMode ? 'Cancelar selección' : 'Selección múltiple'}
                aria-pressed={selectMode}
                onClick={() => setSelectMode((v) => !v)}
              >
                {selectMode ? <IconClose size={16} /> : <IconSelect size={16} />}
                <span>{selectMode ? 'Cancelar' : 'Seleccionar'}</span>
              </button>
            ) : null}
          </div>
          <div className="sticky-chrome__meta-actions">
            {tab === 'songs' && missingAudio.length > 0 && (
              <button
                type="button"
                className="library-meta-icon"
                disabled={restoreBusy}
                aria-label={`Restaurar ${missingAudio.length} sin audio`}
                title="Elegir MP3 para canciones sin audio"
                onClick={() => restoreInputRef.current?.click()}
              >
                <IconUpload size={16} />
              </button>
            )}
            <button
              type="button"
              className="library-meta-play"
              disabled={!playQueueIds.length}
              aria-label="Reproducir"
              title="Reproducir"
              onClick={() => void playTracks(playQueueIds)}
            >
              <IconPlay size={22} />
            </button>
          </div>
        </div>

        {(tab === 'songs' || (tab === 'genres' && genreFilter)) && (
          <TrackColumnsHead selecting={selectMode} />
        )}
      </div>

      <input
        ref={restoreInputRef}
        type="file"
        accept="audio/mpeg,audio/mp3,.mp3,audio/*"
        multiple
        hidden
        onChange={(e) => {
          const files = e.target.files ? [...e.target.files] : []
          e.target.value = ''
          if (!files.length || !missingAudio.length) return
          setRestoreBusy(true)
          void replaceMissingAudio(
            files,
            missingAudio.map((t) => t.id),
          )
            .then((r) => {
              const extra = r.unmatched.length
                ? `\nSin emparejar: ${r.unmatched.slice(0, 3).join(', ')}${r.unmatched.length > 3 ? '…' : ''}`
                : ''
              alert(
                r.replaced > 0
                  ? `Restauradas ${r.replaced} canción${r.replaced === 1 ? '' : 'es'}.${extra}`
                  : `No se emparejó ningún MP3.${extra}`,
              )
            })
            .catch((err) => {
              alert(err instanceof Error ? err.message : 'No se pudieron subir los MP3')
            })
            .finally(() => setRestoreBusy(false))
        }}
      />

      {tab === 'songs' && (
        <TrackList
          tracks={tracks}
          showColumns
          hideColumnHead
          selectMode={selectMode}
          onSelectModeChange={setSelectMode}
          showSelectToggle={false}
          emptyTitle="Sin canciones"
          emptyHint="Sube música para empezar"
        />
      )}

      {tab === 'playlists' && (
        <ul className="playlist-list">
          {playlists.map((p) => {
            const cover = playlistCoverArtProps(p)
            return (
            <li key={p.id}>
              <Link to={`/playlist/${p.id}`} className="playlist-list__link">
                <CoverArt
                  trackId={cover.trackId}
                  hasCover={cover.hasCover}
                  refreshKey={cover.refreshKey}
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
            )
          })}
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
          {artistList.map((a) => (
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
          {artistList.length === 0 && (
            <div className="empty-state">
              <p className="empty-state__title">Sin artistas</p>
            </div>
          )}
        </ul>
      )}

      {tab === 'albums' && (
        <ul className="simple-list">
          {albumList.map((a) => (
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
          {albumList.length === 0 && (
            <div className="empty-state">
              <p className="empty-state__title">Sin álbumes</p>
            </div>
          )}
        </ul>
      )}

      {tab === 'genres' && (
        <>
          {genreFilter ? (
            <TrackList
              tracks={genreTracks}
              showColumns
              hideColumnHead
              selectMode={selectMode}
              onSelectModeChange={setSelectMode}
              showSelectToggle={false}
              emptyTitle="Sin canciones"
            />
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
        <PlaylistBuilderSheet playlistId={null} onClose={() => setCreating(false)} />
      )}
    </div>
  )
}
