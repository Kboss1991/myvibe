import { useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { TrackList } from '../components/TrackList'
import {
  TrackColumnsHead,
  sortTracks,
  type TrackSort,
} from '../components/TrackColumnsHead'
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
  IconHeart,
  IconDownload,
  IconShare,
} from '../components/Icons'
import { playlistCoverArtProps } from '../lib/library'
import { isDoubtfulMetadata } from '../lib/enrich'
import { isLibraryHostCapable } from '../lib/folderImport'
import { saveWifiSharePrefill } from '../lib/wifiTransfer'
import { useMainScrollCollapse } from '../hooks/useMainScrollCollapse'
import { usePlaylistDropTargets } from '../hooks/usePlaylistDropTargets'
import { useLibraryStore } from '../store/libraryStore'
import { useLibraryPlayerStore } from '../store/libraryPlayerStore'
import './pages.css'

type Tab = 'songs' | 'playlists' | 'artists' | 'albums' | 'genres'

export function LibraryPage() {
  const navigate = useNavigate()
  const [tab, setTab] = useState<Tab>('songs')
  const [creating, setCreating] = useState(false)
  const [genreFilter, setGenreFilter] = useState<string | null>(null)
  const [selectMode, setSelectMode] = useState(false)
  const [trackSort, setTrackSort] = useState<TrackSort>({
    key: 'date',
    dir: 'desc',
  })
  const tracks = useLibraryStore((s) => s.tracks)
  const playlists = useLibraryStore((s) => s.playlists)
  const getLiked = useLibraryStore((s) => s.getLiked)
  const liked = getLiked()
  const deletePlaylist = useLibraryStore((s) => s.deletePlaylist)
  const enrichMissingCovers = useLibraryStore((s) => s.enrichMissingCovers)
  const enrichProgress = useLibraryStore((s) => s.enrichProgress)
  const replaceMissingAudio = useLibraryStore((s) => s.replaceMissingAudio)
  const downloadFromPc = useLibraryStore((s) => s.downloadFromPc)
  const downloadProgress = useLibraryStore((s) => s.downloadProgress)
  const artists = useLibraryStore((s) => s.artists)
  const albums = useLibraryStore((s) => s.albums)
  const genres = useLibraryStore((s) => s.genres)
  const playTracks = useLibraryPlayerStore((s) => s.playTracks)
  const {
    allowDrop,
    dropOver,
    dropHint,
    likedDropProps,
    playlistDropProps,
  } = usePlaylistDropTargets()
  const missingCover = tracks.filter((t) => isDoubtfulMetadata(t))
  const missingAudio = tracks.filter((t) => t.hasLocalAudio === false)
  const needsAudioUpdate = tracks.filter(
    (t) => t.needsAudioUpdate && t.hasLocalAudio !== false,
  )
  const [enrichBusy, setEnrichBusy] = useState(false)
  const [restoreBusy, setRestoreBusy] = useState(false)
  const [updateBusy, setUpdateBusy] = useState(false)
  const restoreInputRef = useRef<HTMLInputElement>(null)
  const canHost = isLibraryHostCapable()

  const artistList = useMemo(() => artists(), [artists, tracks])
  const albumList = useMemo(() => albums(), [albums, tracks])
  const genreGroups = genres()
  const genreTracks = genreFilter
    ? genreGroups.find((g) => g.name === genreFilter)?.tracks ?? []
    : []

  const sortedSongs = useMemo(
    () => sortTracks(tracks, trackSort),
    [tracks, trackSort],
  )
  const sortedGenreTracks = useMemo(
    () => sortTracks(genreTracks, trackSort),
    [genreTracks, trackSort],
  )

  const { progress, collapsed } = useMainScrollCollapse(64)

  const metaLabel =
    tab === 'songs'
      ? `${tracks.length} canciones`
      : tab === 'playlists'
        ? `${playlists.length + (liked.length > 0 ? 1 : 0)} playlist${playlists.length + (liked.length > 0 ? 1 : 0) === 1 ? '' : 's'}`
        : tab === 'artists'
          ? `${artistList.length} artista${artistList.length === 1 ? '' : 's'}`
          : tab === 'albums'
            ? `${albumList.length} álbum${albumList.length === 1 ? '' : 'es'}`
            : genreFilter
              ? genreFilter
              : `${genreGroups.length} género${genreGroups.length === 1 ? '' : 's'}`

  const playQueueIds = useMemo(() => {
    if (tab === 'genres' && genreFilter) {
      return sortedGenreTracks.map((t) => t.id)
    }
    return sortedSongs.map((t) => t.id)
  }, [tab, genreFilter, sortedGenreTracks, sortedSongs])

  const showSelect =
    (tab === 'songs' && tracks.length > 0) ||
    (tab === 'genres' && Boolean(genreFilter) && genreTracks.length > 0)

  const canWifiShare = isLibraryHostCapable() && playQueueIds.length > 0
  const goWifiShareCurrentView = () => {
    const ids = playQueueIds.filter((id) => {
      const t = tracks.find((x) => x.id === id)
      return t && t.hasLocalAudio !== false
    })
    if (!ids.length) return
    const label =
      tab === 'genres' && genreFilter
        ? genreFilter
        : tab === 'songs'
          ? 'Canciones'
          : metaLabel
    saveWifiSharePrefill({
      mode: 'filter',
      trackIds: ids,
      label: String(label),
    })
    navigate('/profile#wifi-transfer')
  }

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
            {canWifiShare && (tab === 'songs' || (tab === 'genres' && genreFilter)) ? (
              <button
                type="button"
                className="library-meta-icon"
                aria-label="Enviar por Wi‑Fi"
                title="Enviar esta vista por Wi‑Fi"
                onClick={goWifiShareCurrentView}
              >
                <IconShare size={16} />
              </button>
            ) : null}
          </div>
        </div>

        {(tab === 'songs' || (tab === 'genres' && genreFilter)) && (
          <TrackColumnsHead
            selecting={selectMode}
            sort={trackSort}
            onSortChange={setTrackSort}
          />
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

      {tab === 'songs' && canHost && (
        <div className="enrich-banner" role="status">
          <div>
            <strong>Pasar música al móvil</strong>
            <span>
              Perfil → <em>Generar código de 6 dígitos</em>. En el iPhone: Perfil → escribe el
              código (misma Wi‑Fi).
            </span>
          </div>
          <Link to="/profile#wifi-transfer" className="enrich-banner__btn">
            <IconUpload size={16} /> Generar código
          </Link>
        </div>
      )}

      {tab === 'songs' && !canHost && (
        <div className="enrich-banner" role="status">
          <div>
            <strong>Biblioteca desde el PC (código Wi‑Fi)</strong>
            <span>
              En el PC (Chrome): Perfil → Generar código. Si se corta, vuelve a conectar: solo
              envía las que falten.
            </span>
          </div>
          <Link to="/profile#wifi-transfer" className="enrich-banner__btn">
            <IconDownload size={16} /> Escribir código
          </Link>
        </div>
      )}

      {tab === 'songs' && needsAudioUpdate.length > 0 && (
        <div className="enrich-banner audio-update-banner" role="status">
          <div>
            <strong>
              {needsAudioUpdate.length} canción
              {needsAudioUpdate.length === 1 ? '' : 'es'} con audio nuevo en el PC
            </strong>
            <span>Sustituye la copia antigua de este móvil</span>
          </div>
          <button
            type="button"
            className="enrich-banner__btn"
            disabled={updateBusy || Boolean(downloadProgress)}
            onClick={() => {
              setUpdateBusy(true)
              void downloadFromPc(needsAudioUpdate.map((t) => t.id))
                .then((r) => {
                  alert(
                    r.imported > 0
                      ? `Actualizadas ${r.imported}: se borró la antigua y se puso la nueva.`
                      : 'No se actualizó ninguna. ¿PC abierto con la misma cuenta?',
                  )
                })
                .catch((err) => {
                  alert(err instanceof Error ? err.message : 'No se pudo actualizar')
                })
                .finally(() => setUpdateBusy(false))
            }}
          >
            <IconDownload size={16} />{' '}
            {updateBusy || downloadProgress ? 'Actualizando…' : 'Actualizar todas'}
          </button>
        </div>
      )}

      {tab === 'songs' && (
        <TrackList
          tracks={sortedSongs}
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
        <>
          {dropHint ? (
            <p className="drop-toast" role="status">
              {dropHint}
            </p>
          ) : null}
          <ul className="playlist-list">
            {(liked.length > 0 || allowDrop) && (
              <li>
                <Link
                  to="/liked"
                  className={`playlist-list__link ${dropOver === 'liked' ? 'is-drop-over' : ''}`}
                  {...(allowDrop ? likedDropProps : {})}
                >
                  <span className="playlist-list__liked-thumb" aria-hidden>
                    <IconHeart size={22} filled />
                  </span>
                  <div>
                    <strong>Canciones que te gustan</strong>
                    <span>
                      {liked.length} canción{liked.length === 1 ? '' : 'es'}
                    </span>
                  </div>
                </Link>
              </li>
            )}
            {playlists.map((p) => {
              const cover = playlistCoverArtProps(p)
              const drop = allowDrop ? playlistDropProps(p.id, p.name) : null
              return (
                <li key={p.id}>
                  <Link
                    to={`/playlist/${p.id}`}
                    className={`playlist-list__link ${dropOver === p.id ? 'is-drop-over' : ''}`}
                    {...(drop ?? {})}
                  >
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
            {playlists.length === 0 && liked.length === 0 && !allowDrop && (
              <div className="empty-state">
                <p className="empty-state__title">Sin playlists</p>
                <p className="empty-state__hint">Pulsa + para crear una</p>
              </div>
            )}
          </ul>
        </>
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
              {isLibraryHostCapable() ? (
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Enviar ${a.name} por Wi‑Fi`}
                  title="Enviar por Wi‑Fi"
                  onClick={() => {
                    const ids = a.tracks
                      .filter((t) => t.hasLocalAudio !== false)
                      .map((t) => t.id)
                    if (!ids.length) return
                    saveWifiSharePrefill({
                      mode: 'filter',
                      trackIds: ids,
                      label: a.name,
                    })
                    navigate('/profile#wifi-transfer')
                  }}
                >
                  <IconShare size={18} />
                </button>
              ) : null}
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
              {isLibraryHostCapable() ? (
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Enviar álbum ${a.name} por Wi‑Fi`}
                  title="Enviar por Wi‑Fi"
                  onClick={() => {
                    const ids = a.tracks
                      .filter((t) => t.hasLocalAudio !== false)
                      .map((t) => t.id)
                    if (!ids.length) return
                    saveWifiSharePrefill({
                      mode: 'filter',
                      trackIds: ids,
                      label: a.name,
                    })
                    navigate('/profile#wifi-transfer')
                  }}
                >
                  <IconShare size={18} />
                </button>
              ) : null}
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
              tracks={sortedGenreTracks}
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
