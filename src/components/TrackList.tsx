import { useMemo, useState } from 'react'
import type { Track } from '../types'
import { formatTime } from '../lib/mediaSession'
import { useLibraryStore } from '../store/libraryStore'
import { usePlayerStore } from '../store/playerStore'
import { CoverArt } from './CoverArt'
import {
  IconHeart,
  IconMore,
  IconPlay,
  IconPlus,
  IconQueue,
  IconTrash,
  IconEdit,
  IconSearch,
  IconSelect,
  IconCheck,
  IconClose,
  IconShare,
} from './Icons'
import './TrackList.css'

interface Props {
  tracks: Track[]
  contextPlaylistId?: string
  emptyTitle?: string
  emptyHint?: string
  /** Mostrar botón de selección múltiple (default true) */
  selectable?: boolean
  /** Columnas: título, álbum, fecha, duración */
  showColumns?: boolean
}

export function TrackList({
  tracks,
  contextPlaylistId,
  emptyTitle = 'No hay canciones',
  emptyHint = 'Sube tu música para empezar',
  selectable = true,
  showColumns = false,
}: Props) {
  const currentTrackId = usePlayerStore((s) => s.currentTrackId)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const playTracks = usePlayerStore((s) => s.playTracks)
  const playNext = usePlayerStore((s) => s.playNext)
  const addToQueue = usePlayerStore((s) => s.addToQueue)
  const toggleLike = useLibraryStore((s) => s.toggleLike)
  const deleteTrack = useLibraryStore((s) => s.deleteTrack)
  const deleteTracks = useLibraryStore((s) => s.deleteTracks)
  const removeFromPlaylist = useLibraryStore((s) => s.removeFromPlaylist)
  const playlists = useLibraryStore((s) => s.playlists)
  const addToPlaylist = useLibraryStore((s) => s.addToPlaylist)
  const updateTrack = useLibraryStore((s) => s.updateTrack)
  const enrichTrack = useLibraryStore((s) => s.enrichTrack)
  const enrichSelected = useLibraryStore((s) => s.enrichSelected)
  const setLiked = useLibraryStore((s) => s.setLiked)
  const enrichProgress = useLibraryStore((s) => s.enrichProgress)
  const shareTrack = useLibraryStore((s) => s.shareTrack)

  const [menuTrack, setMenuTrack] = useState<Track | null>(null)
  const [enrichingId, setEnrichingId] = useState<string | null>(null)
  const [editTrack, setEditTrack] = useState<Track | null>(null)
  const [playlistPickIds, setPlaylistPickIds] = useState<string[] | null>(null)
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)

  const selectedTracks = useMemo(
    () => tracks.filter((t) => selected.has(t.id)),
    [tracks, selected],
  )
  const allSelected = tracks.length > 0 && selected.size === tracks.length

  function exitSelectMode() {
    setSelectMode(false)
    setSelected(new Set())
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSelectAll() {
    if (allSelected) setSelected(new Set())
    else setSelected(new Set(tracks.map((t) => t.id)))
  }

  async function runBulk(
    action: () => Promise<void>,
    clearAfter = true,
  ) {
    setBulkBusy(true)
    try {
      await action()
      if (clearAfter) exitSelectMode()
    } finally {
      setBulkBusy(false)
    }
  }

  if (!tracks.length) {
    return (
      <div className="empty-state fade-up">
        <p className="empty-state__title">{emptyTitle}</p>
        <p className="empty-state__hint">{emptyHint}</p>
      </div>
    )
  }

  return (
    <>
      {selectable && (
        <div className="select-toolbar">
          {!selectMode ? (
            <button
              type="button"
              className="select-toolbar__toggle"
              onClick={() => setSelectMode(true)}
            >
              <IconSelect size={18} /> Selección múltiple
            </button>
          ) : (
            <>
              <button type="button" className="select-toolbar__toggle is-on" onClick={toggleSelectAll}>
                <span className={`check-box ${allSelected ? 'is-checked' : ''}`}>
                  {allSelected ? <IconCheck size={14} /> : null}
                </span>
                {allSelected ? 'Quitar todo' : 'Seleccionar todo'}
              </button>
              <span className="select-toolbar__count">
                {selected.size} seleccionada{selected.size === 1 ? '' : 's'}
              </span>
              <button
                type="button"
                className="select-toolbar__cancel"
                onClick={exitSelectMode}
              >
                <IconClose size={18} /> Cancelar
              </button>
            </>
          )}
        </div>
      )}

      <ul className={`track-list ${selectMode ? 'is-selecting' : ''} ${showColumns ? 'track-list--cols' : ''}`}>
        {showColumns && (
          <li className="track-row track-row--head" aria-hidden>
            {selectMode && <span className="track-col track-col--check" />}
            <span className="track-col track-col--title">Título</span>
            <span className="track-col track-col--album">Álbum</span>
            <span className="track-col track-col--date">Fecha</span>
            <span className="track-col track-col--time">Tiempo</span>
            {!selectMode && <span className="track-col track-col--actions" />}
          </li>
        )}
        {tracks.map((track, i) => {
          const active = track.id === currentTrackId
          const isSelected = selected.has(track.id)
          return (
            <li
              key={track.id}
              className={`track-row fade-up ${active ? 'is-active' : ''} ${isSelected ? 'is-selected' : ''} ${showColumns ? 'track-row--cols' : ''}`}
              style={{ animationDelay: `${Math.min(i, 12) * 0.03}s` }}
            >
              {selectMode && (
                <button
                  type="button"
                  className="track-row__check"
                  aria-label={isSelected ? 'Quitar selección' : 'Seleccionar'}
                  onClick={() => toggleSelect(track.id)}
                >
                  <span className={`check-box ${isSelected ? 'is-checked' : ''}`}>
                    {isSelected ? <IconCheck size={14} /> : null}
                  </span>
                </button>
              )}
              <button
                type="button"
                className="track-row__main track-col--title"
                onClick={() => {
                  if (selectMode) toggleSelect(track.id)
                  else void playTracks(tracks.map((t) => t.id), track.id)
                }}
              >
                <CoverArt
                  trackId={track.id}
                  hasCover={track.hasCover}
                  refreshKey={`${track.artist}|${track.album}|${track.externalUrl ?? ''}`}
                  size={48}
                />
                <div className="track-row__meta">
                  <span className="track-row__title">
                    {active && isPlaying ? <IconPlay size={12} /> : null}
                    {track.title}
                  </span>
                  <span className="track-row__sub">{track.artist}</span>
                </div>
              </button>
              {showColumns && (
                <>
                  <span className="track-col track-col--album">{track.album || '—'}</span>
                  <span className="track-col track-col--date">
                    {track.year || '—'}
                  </span>
                  <span className="track-col track-col--time">
                    {formatTime(track.duration)}
                  </span>
                </>
              )}
              {!selectMode && (
                <div className="track-row__actions track-col--actions">
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label="Más opciones"
                    onClick={(e) => {
                      e.stopPropagation()
                      setMenuTrack(track)
                    }}
                  >
                    <IconMore size={20} />
                  </button>
                </div>
              )}
            </li>
          )
        })}
      </ul>

      {selectMode && selected.size > 0 && (
        <div className="bulk-bar">
          <div className="bulk-bar__inner">
            <button
              type="button"
              disabled={bulkBusy}
              onClick={() =>
                void runBulk(async () => {
                  void playTracks(selectedTracks.map((t) => t.id))
                })
              }
            >
              <IconPlay size={18} /> Reproducir
            </button>
            <button
              type="button"
              disabled={bulkBusy}
              onClick={() =>
                void runBulk(async () => {
                  await setLiked([...selected], true)
                })
              }
            >
              <IconHeart size={18} filled /> Me gusta
            </button>
            <button
              type="button"
              disabled={bulkBusy}
              onClick={() =>
                void runBulk(async () => {
                  const ids = [...selected]
                  ids.forEach((id) => addToQueue(id))
                })
              }
            >
              <IconQueue size={18} /> A la cola
            </button>
            <button
              type="button"
              disabled={bulkBusy}
              onClick={() => setPlaylistPickIds([...selected])}
            >
              <IconPlus size={18} /> Playlist
            </button>
            <button
              type="button"
              disabled={bulkBusy}
              onClick={() =>
                void runBulk(async () => {
                  const r = await enrichSelected([...selected])
                  alert(
                    `Online: ${r.ok} actualizadas` +
                      (r.fail ? `, ${r.fail} sin resultado` : ''),
                  )
                }, false)
              }
            >
              <IconSearch size={18} />{' '}
              {enrichProgress ? `${enrichProgress.done}/${enrichProgress.total}` : 'Buscar info'}
            </button>
            {contextPlaylistId && (
              <button
                type="button"
                disabled={bulkBusy}
                onClick={() =>
                  void runBulk(async () => {
                    for (const id of selected) {
                      await removeFromPlaylist(contextPlaylistId, id)
                    }
                  })
                }
              >
                <IconTrash size={18} /> Quitar
              </button>
            )}
            <button
              type="button"
              className="danger"
              disabled={bulkBusy}
              onClick={() => {
                if (!confirm(`¿Eliminar ${selected.size} canciones?`)) return
                void runBulk(async () => {
                  await deleteTracks([...selected])
                })
              }}
            >
              <IconTrash size={18} /> Eliminar
            </button>
          </div>
        </div>
      )}

      {menuTrack && (
        <div className="sheet track-actions-sheet">
          <button
            type="button"
            className="sheet-backdrop"
            aria-label="Cerrar"
            onClick={() => setMenuTrack(null)}
          />
          <div className="sheet__panel" role="menu">
            <div className="track-actions-head">
              <CoverArt
                trackId={menuTrack.id}
                hasCover={menuTrack.hasCover}
                refreshKey={`${menuTrack.artist}|${menuTrack.album}|${menuTrack.externalUrl ?? ''}`}
                size={48}
              />
              <div>
                <strong>{menuTrack.title}</strong>
                <span>{menuTrack.artist}</span>
              </div>
            </div>

            <button
              type="button"
              className="sheet__item"
              onClick={() => {
                void toggleLike(menuTrack.id)
                setMenuTrack(null)
              }}
            >
              <IconHeart size={18} filled={menuTrack.liked} />{' '}
              {menuTrack.liked ? 'Quitar de Me gusta' : 'Me gusta'}
            </button>
            <button
              type="button"
              className="sheet__item"
              onClick={() => {
                const track = menuTrack
                setMenuTrack(null)
                void shareTrack(track.id)
                  .then((mode) => {
                    if (mode === 'downloaded') {
                      alert(
                        'Archivo .myvibe descargado. Envíaselo a quien tenga MyVibe; podrá importarlo en Subir.',
                      )
                    }
                  })
                  .catch((e) => {
                    if (e instanceof DOMException && e.name === 'AbortError') return
                    alert(e instanceof Error ? e.message : 'No se pudo compartir')
                  })
              }}
            >
              <IconShare size={18} /> Compartir con MyVibe
            </button>
            <button
              type="button"
              className="sheet__item"
              onClick={() => {
                playNext(menuTrack.id)
                setMenuTrack(null)
              }}
            >
              <IconQueue size={18} /> Reproducir a continuación
            </button>
            <button
              type="button"
              className="sheet__item"
              onClick={() => {
                addToQueue(menuTrack.id)
                setMenuTrack(null)
              }}
            >
              <IconPlus size={18} /> Añadir a la cola
            </button>
            <button
              type="button"
              className="sheet__item"
              onClick={() => {
                setPlaylistPickIds([menuTrack.id])
                setMenuTrack(null)
              }}
            >
              <IconPlus size={18} /> Añadir a playlist
            </button>
            <button
              type="button"
              className="sheet__item"
              onClick={() => {
                setEditTrack(menuTrack)
                setMenuTrack(null)
              }}
            >
              <IconEdit size={18} /> Editar información
            </button>
            <button
              type="button"
              className="sheet__item"
              disabled={enrichingId === menuTrack.id}
              onClick={() => {
                const id = menuTrack.id
                setEnrichingId(id)
                void enrichTrack(id).then((result) => {
                  setEnrichingId(null)
                  setMenuTrack(null)
                  if (!result.found) {
                    alert(
                      'No se encontró información online. Edita el título o artista y vuelve a intentarlo.',
                    )
                  }
                })
              }}
            >
              <IconSearch size={18} />{' '}
              {enrichingId === menuTrack.id
                ? 'Buscando en internet…'
                : 'Buscar portada e info online'}
            </button>
            <button
              type="button"
              className="sheet__item"
              disabled={enrichingId === menuTrack.id}
              onClick={() => {
                const id = menuTrack.id
                setEnrichingId(id)
                void enrichTrack(id, { force: true }).then((result) => {
                  setEnrichingId(null)
                  setMenuTrack(null)
                  if (!result.found) {
                    alert(
                      'No se pudo forzar un emparejamiento mejor. Prueba a editar el título (p. ej. añade el nombre de la película) y repite.',
                    )
                  } else {
                    alert(
                      result.coverUpdated
                        ? 'Emparejamiento forzado: artista, álbum y portada actualizados.'
                        : 'Emparejamiento forzado: artista y álbum actualizados.',
                    )
                  }
                })
              }}
            >
              <IconSearch size={18} />{' '}
              {enrichingId === menuTrack.id
                ? 'Forzando…'
                : 'Forzar emparejamiento'}
            </button>
            {contextPlaylistId && (
              <button
                type="button"
                className="sheet__item"
                onClick={() => {
                  void removeFromPlaylist(contextPlaylistId, menuTrack.id)
                  setMenuTrack(null)
                }}
              >
                <IconTrash size={18} /> Quitar de playlist
              </button>
            )}
            <button
              type="button"
              className="sheet__item danger"
              onClick={() => {
                if (confirm(`¿Eliminar “${menuTrack.title}”?`)) {
                  void deleteTrack(menuTrack.id)
                }
                setMenuTrack(null)
              }}
            >
              <IconTrash size={18} /> Eliminar
            </button>
          </div>
        </div>
      )}

      {playlistPickIds && (
        <div className="sheet">
          <button
            type="button"
            className="sheet-backdrop"
            onClick={() => setPlaylistPickIds(null)}
          />
          <div className="sheet__panel">
            <h3>
              Añadir {playlistPickIds.length} canción
              {playlistPickIds.length === 1 ? '' : 'es'} a playlist
            </h3>
            {playlists.length === 0 ? (
              <p className="empty-state__hint">Crea una playlist en Tu biblioteca</p>
            ) : (
              playlists.map((p) => (
                <button
                  type="button"
                  key={p.id}
                  className="sheet__item"
                  onClick={() => {
                    void addToPlaylist(p.id, playlistPickIds).then(() => {
                      setPlaylistPickIds(null)
                      if (selectMode) exitSelectMode()
                    })
                  }}
                >
                  {p.name}
                </button>
              ))
            )}
          </div>
        </div>
      )}

      {editTrack && (
        <EditTrackModal
          track={editTrack}
          onClose={() => setEditTrack(null)}
          onSave={async (patch) => {
            await updateTrack(editTrack.id, patch)
            setEditTrack(null)
          }}
        />
      )}
    </>
  )
}

function EditTrackModal({
  track,
  onClose,
  onSave,
}: {
  track: Track
  onClose: () => void
  onSave: (patch: Partial<Pick<Track, 'title' | 'artist' | 'album' | 'genre'>>) => Promise<void>
}) {
  const [title, setTitle] = useState(track.title)
  const [artist, setArtist] = useState(track.artist)
  const [album, setAlbum] = useState(track.album)
  const [genre, setGenre] = useState(track.genre)

  return (
    <div className="sheet">
      <button type="button" className="sheet-backdrop" onClick={onClose} />
      <div className="sheet__panel">
        <h3>Editar canción</h3>
        <label className="field">
          Título
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="field">
          Artista
          <input value={artist} onChange={(e) => setArtist(e.target.value)} />
        </label>
        <label className="field">
          Álbum
          <input value={album} onChange={(e) => setAlbum(e.target.value)} />
        </label>
        <label className="field">
          Género
          <input value={genre} onChange={(e) => setGenre(e.target.value)} />
        </label>
        <button
          type="button"
          className="btn-primary"
          onClick={() => void onSave({ title, artist, album, genre })}
        >
          Guardar
        </button>
      </div>
    </div>
  )
}
