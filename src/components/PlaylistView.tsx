import { useMemo, useRef, useState } from 'react'
import type { Track } from '../types'
import { formatTime } from '../lib/mediaSession'
import { useAuthStore } from '../store/authStore'
import { usePlayerStore } from '../store/playerStore'
import { useMainScrollCollapse } from '../hooks/useMainScrollCollapse'
import { CoverArt } from './CoverArt'
import { CoverCropSheet } from './CoverCropSheet'
import { PlaylistBuilderSheet } from './PlaylistBuilderSheet'
import { UserAvatar } from './UserAvatar'
import {
  IconPlay,
  IconShuffle,
  IconQueue,
  IconDownload,
  IconShare,
  IconMore,
  IconSearch,
  IconPlus,
  IconEdit,
  IconTrash,
  IconClock,
  IconHeart,
  IconClose,
  IconGrip,
} from './Icons'
import './PlaylistView.css'
import './TrackList.css'

export type PlaylistSort =
  | 'custom'
  | 'title'
  | 'artist'
  | 'album'
  | 'duration'
  | 'newest'

type Props = {
  title: string
  subtitle?: string
  description?: string
  tracks: Track[]
  /** Orden original (p. ej. trackIds de la playlist) */
  orderedIds?: string[]
  coverTrackId?: string | null
  hasCover?: boolean
  /** id de cover custom: playlist:xxx */
  coverId?: string | null
  playlistId?: string
  likedStyle?: boolean
  onEditInfo?: (name: string, description: string) => Promise<void>
  onPickCover?: (file: File) => Promise<void>
  onDelete?: () => void
  onAddTracks?: (trackIds: string[]) => Promise<void>
  onRemoveTrack?: (trackId: string) => Promise<void>
  onReorderTracks?: (trackIds: string[]) => Promise<void>
  onShare?: () => Promise<void> | void
}

export function PlaylistView({
  title,
  description = '',
  tracks,
  orderedIds,
  coverTrackId,
  hasCover,
  coverId,
  playlistId,
  likedStyle,
  onEditInfo,
  onPickCover,
  onDelete,
  onAddTracks,
  onRemoveTrack,
  onReorderTracks,
  onShare,
}: Props) {
  const user = useAuthStore((s) => s.user)
  const playTracks = usePlayerStore((s) => s.playTracks)
  const addToQueue = usePlayerStore((s) => s.addToQueue)
  const shuffle = usePlayerStore((s) => s.shuffle)
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle)
  const currentTrackId = usePlayerStore((s) => s.currentTrackId)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const [sharing, setSharing] = useState(false)

  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [sort, setSort] = useState<PlaylistSort>('custom')
  const [moreOpen, setMoreOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [builderOpen, setBuilderOpen] = useState(false)
  const [editMode, setEditMode] = useState(false)
  const [dragId, setDragId] = useState<string | null>(null)
  const [editName, setEditName] = useState(title)
  const [editDesc, setEditDesc] = useState(description)
  const [cropSource, setCropSource] = useState<{ blob: Blob; name: string } | null>(null)
  const coverInputRef = useRef<HTMLInputElement>(null)

  const totalDuration = tracks.reduce((s, t) => s + (t.duration || 0), 0)
  const hours = Math.floor(totalDuration / 3600)
  const mins = Math.floor((totalDuration % 3600) / 60)
  const durationLabel =
    hours > 0 ? `${hours} h ${mins} min` : `${mins} min`

  const { progress, collapsed } = useMainScrollCollapse(100)

  const displayTracks = useMemo(() => {
    let list = [...tracks]
    const q = query.trim().toLowerCase()
    if (q) {
      list = list.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          t.artist.toLowerCase().includes(q) ||
          t.album.toLowerCase().includes(q),
      )
    }
    // En modo editar siempre el orden de la lista
    const effectiveSort = editMode ? 'custom' : sort
    switch (effectiveSort) {
      case 'title':
        list.sort((a, b) => a.title.localeCompare(b.title, 'es'))
        break
      case 'artist':
        list.sort((a, b) => a.artist.localeCompare(b.artist, 'es'))
        break
      case 'album':
        list.sort((a, b) => a.album.localeCompare(b.album, 'es'))
        break
      case 'duration':
        list.sort((a, b) => b.duration - a.duration)
        break
      case 'newest':
        list.sort((a, b) => b.createdAt - a.createdAt)
        break
      case 'custom':
      default:
        if (orderedIds?.length) {
          const order = new Map(orderedIds.map((id, i) => [id, i]))
          list.sort(
            (a, b) => (order.get(a.id) ?? 9999) - (order.get(b.id) ?? 9999),
          )
        }
        break
    }
    return list
  }, [tracks, query, sort, orderedIds, editMode])

  function moveTrack(fromId: string, toId: string) {
    if (!onReorderTracks || !orderedIds?.length || fromId === toId) return
    const next = [...orderedIds]
    const from = next.indexOf(fromId)
    const to = next.indexOf(toId)
    if (from < 0 || to < 0) return
    next.splice(from, 1)
    next.splice(to, 0, fromId)
    void onReorderTracks(next)
  }

  function moveBy(trackId: string, delta: number) {
    if (!onReorderTracks || !orderedIds?.length) return
    const from = orderedIds.indexOf(trackId)
    if (from < 0) return
    const to = Math.max(0, Math.min(orderedIds.length - 1, from + delta))
    if (to === from) return
    const next = [...orderedIds]
    next.splice(from, 1)
    next.splice(to, 0, trackId)
    void onReorderTracks(next)
  }

  const ids = displayTracks.map((t) => t.id)
  const heroCoverId = coverId || coverTrackId || tracks[0]?.id || null
  const heroHasCover = coverId
    ? !!hasCover
    : Boolean(tracks.find((t) => t.id === heroCoverId)?.hasCover)

  function exportM3u() {
    const lines = ['#EXTM3U', ...tracks.map((t) => `#EXTINF:${Math.round(t.duration)},${t.artist} - ${t.title}\n${t.fileName}`)]
    const blob = new Blob([lines.join('\n')], { type: 'audio/x-mpegurl' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${title.replace(/[^\w\- ]+/g, '') || 'playlist'}.m3u`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div
      className={`sp-playlist ${likedStyle ? 'sp-playlist--liked' : ''} ${collapsed ? 'is-scrolled' : ''} ${editMode ? 'is-editing' : ''}`}
      style={{ ['--sticky-p' as string]: String(progress) }}
    >
      <div className="sp-hero-fade">
        <header className="sp-hero">
          <button
            type="button"
            className="sp-hero__cover"
            onClick={() => onPickCover && coverInputRef.current?.click()}
            disabled={!onPickCover}
          >
            {likedStyle && !heroCoverId ? (
              <div className="sp-hero__liked-art">
                <IconHeart size={56} filled />
              </div>
            ) : (
              <CoverArt
                trackId={heroCoverId}
                hasCover={heroHasCover !== false}
                size="100%"
                rounded="md"
                className="sp-hero__cover-img"
              />
            )}
            {onPickCover && (
              <span className="sp-hero__cover-edit">
                <IconEdit size={18} />
                Foto
              </span>
            )}
          </button>
          {onPickCover && (
            <input
              ref={coverInputRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) setCropSource({ blob: file, name: file.name })
                e.target.value = ''
              }}
            />
          )}

          <div className="sp-hero__meta">
            <p className="sp-hero__type">Lista</p>
            <div className="sp-hero__title-row">
              <h1 className="sp-hero__title">{title}</h1>
              <button
                type="button"
                className="sp-play"
                disabled={!tracks.length}
                aria-label="Reproducir"
                onClick={() => void playTracks(ids)}
              >
                <IconPlay size={22} />
              </button>
            </div>
            <p className="sp-hero__stats">
              <span className="sp-hero__owner">
                <UserAvatar user={user} size={22} className="sp-hero__avatar" />
                {user?.displayName || 'Tú'}
              </span>
              <span className="dot">·</span>
              <span>
                {tracks.length} cancion{tracks.length === 1 ? '' : 'es'}
              </span>
              <span className="dot">·</span>
              <span>{durationLabel}</span>
            </p>
          </div>
        </header>
      </div>

      <div className="sp-actions">
        {playlistId && onAddTracks && (
          <button type="button" className="sp-pill" onClick={() => setBuilderOpen(true)}>
            <IconPlus size={16} /> Añadir
          </button>
        )}
        {playlistId && onReorderTracks && onRemoveTrack && (
          <button
            type="button"
            className={`sp-pill ${editMode ? 'is-on' : ''}`}
            onClick={() => {
              setEditMode((v) => !v)
              setSort('custom')
            }}
          >
            <IconEdit size={16} /> {editMode ? 'Listo' : 'Editar'}
          </button>
        )}
        <button
          type="button"
          className={`sp-pill sp-pill--icon ${shuffle ? 'is-on' : ''}`}
          aria-label={shuffle ? 'Desactivar orden aleatorio' : 'Activar orden aleatorio'}
          title={shuffle ? 'Aleatorio: sí' : 'Aleatorio: no'}
          aria-pressed={shuffle}
          onClick={() => toggleShuffle()}
        >
          <IconShuffle size={18} />
        </button>

        <div className="sp-actions__more">
          {searchOpen ? (
            <label className="sp-search">
              <IconSearch size={16} />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Buscar"
              />
              <button
                type="button"
                aria-label="Cerrar búsqueda"
                onClick={() => {
                  setQuery('')
                  setSearchOpen(false)
                }}
              >
                <IconClose size={16} />
              </button>
            </label>
          ) : (
            <button
              type="button"
              className="sp-icon"
              aria-label="Buscar"
              onClick={() => setSearchOpen(true)}
            >
              <IconSearch size={20} />
            </button>
          )}
          <div className="sp-more-wrap">
            <button
              type="button"
              className="sp-icon"
              aria-label="Más opciones"
              onClick={() => setMoreOpen((v) => !v)}
            >
              <IconMore size={20} />
            </button>
            {moreOpen && (
              <div className="sp-menu">
                {onEditInfo && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditName(title)
                      setEditDesc(description)
                      setEditOpen(true)
                      setMoreOpen(false)
                    }}
                  >
                    <IconEdit size={18} /> Nombre e información
                  </button>
                )}
                <button
                  type="button"
                  disabled={!tracks.length}
                  onClick={() => {
                    exportM3u()
                    setMoreOpen(false)
                  }}
                >
                  <IconDownload size={18} /> Exportar M3U
                </button>
                {onShare && (
                  <button
                    type="button"
                    disabled={!tracks.length || sharing}
                    onClick={() => {
                      setMoreOpen(false)
                      setSharing(true)
                      void Promise.resolve(onShare())
                        .catch((e) => {
                          if (e instanceof DOMException && e.name === 'AbortError') return
                          alert(e instanceof Error ? e.message : 'No se pudo compartir')
                        })
                        .finally(() => setSharing(false))
                    }}
                  >
                    <IconShare size={18} /> Compartir
                  </button>
                )}
                <button
                  type="button"
                  disabled={!tracks.length}
                  onClick={() => {
                    tracks.forEach((t) => addToQueue(t.id))
                    setMoreOpen(false)
                  }}
                >
                  <IconQueue size={18} /> Añadir a la cola
                </button>
                {onDelete && (
                  <button
                    type="button"
                    className="danger"
                    onClick={() => {
                      setMoreOpen(false)
                      onDelete()
                    }}
                  >
                    <IconTrash size={18} /> Eliminar lista
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {editMode && (
        <p className="sp-edit-hint">Arrastra para reordenar · toca la X para quitar</p>
      )}

      <div className="sp-table-wrap">
        <div className="sp-table-head">
          <span className="col-num">{editMode ? '' : '#'}</span>
          <span className="col-title">Título</span>
          <span className="col-album">Álbum</span>
          <span className="col-date">Fecha</span>
          <span className="col-time">
            <IconClock size={16} />
          </span>
        </div>
        {displayTracks.length === 0 ? (
          <div className="sp-empty">
            {query
              ? 'No hay coincidencias en esta lista'
              : playlistId && onAddTracks
                ? 'Esta lista está vacía. Pulsa Añadir para meter canciones.'
                : 'Esta lista está vacía.'}
          </div>
        ) : (
          <ul className="sp-table-body">
            {displayTracks.map((track, i) => {
              const active = track.id === currentTrackId
              return (
                <li
                  key={track.id}
                  className={`sp-row ${active ? 'is-active' : ''} ${dragId === track.id ? 'is-dragging' : ''}`}
                  draggable={editMode}
                  onDragStart={() => setDragId(track.id)}
                  onDragEnd={() => setDragId(null)}
                  onDragOver={(e) => {
                    if (!editMode) return
                    e.preventDefault()
                  }}
                  onDrop={(e) => {
                    if (!editMode || !dragId) return
                    e.preventDefault()
                    moveTrack(dragId, track.id)
                    setDragId(null)
                  }}
                >
                  {editMode ? (
                    <span className="sp-row__grip" aria-hidden>
                      <IconGrip size={16} />
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="sp-row__playnum"
                      onClick={() =>
                        void playTracks(
                          displayTracks.map((t) => t.id),
                          track.id,
                        )
                      }
                    >
                      <span className="num">{i + 1}</span>
                      <span className="play">
                        <IconPlay size={14} />
                      </span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="sp-row__title"
                    onClick={() => {
                      if (editMode) return
                      void playTracks(
                        displayTracks.map((t) => t.id),
                        track.id,
                      )
                    }}
                  >
                    <CoverArt
                      trackId={track.id}
                      hasCover={track.hasCover}
                      refreshKey={`${track.artist}|${track.album}|${track.externalUrl ?? ''}|${track.coverUpdatedAt ?? 0}`}
                      size={40}
                    />
                    <span>
                      <strong className={active && isPlaying ? 'playing' : ''}>
                        {track.title}
                      </strong>
                      <small>{track.artist}</small>
                    </span>
                  </button>
                  <span className="col-album">{track.album}</span>
                  <span className="col-date">{track.year || '—'}</span>
                  <span className="col-time">{formatTime(track.duration)}</span>
                  {editMode && onRemoveTrack ? (
                    <div className="sp-row__edit-actions">
                      <button
                        type="button"
                        className="sp-row__move"
                        aria-label="Subir"
                        disabled={i === 0}
                        onClick={() => moveBy(track.id, -1)}
                      >
                        ▲
                      </button>
                      <button
                        type="button"
                        className="sp-row__move"
                        aria-label="Bajar"
                        disabled={i === displayTracks.length - 1}
                        onClick={() => moveBy(track.id, 1)}
                      >
                        ▼
                      </button>
                      <button
                        type="button"
                        className="sp-row__remove"
                        aria-label="Quitar de la lista"
                        onClick={() => void onRemoveTrack(track.id)}
                      >
                        <IconClose size={16} />
                      </button>
                    </div>
                  ) : (
                    <span />
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {builderOpen && playlistId && onAddTracks && (
        <PlaylistBuilderSheet playlistId={playlistId} onClose={() => setBuilderOpen(false)} />
      )}

      {editOpen && onEditInfo && (
        <div className="sheet">
          <button type="button" className="sheet-backdrop" onClick={() => setEditOpen(false)} />
          <div className="sheet__panel">
            <h3>Nombre e información</h3>
            <label className="field">
              Nombre
              <input value={editName} onChange={(e) => setEditName(e.target.value)} />
            </label>
            <label className="field">
              Descripción
              <input
                value={editDesc}
                onChange={(e) => setEditDesc(e.target.value)}
                placeholder="Añade una descripción opcional"
              />
            </label>
            <button
              type="button"
              className="btn-primary"
              onClick={() => {
                void onEditInfo(editName.trim() || title, editDesc.trim()).then(
                  () => setEditOpen(false),
                )
              }}
            >
              Guardar
            </button>
          </div>
        </div>
      )}

      {moreOpen && (
        <button
          type="button"
          className="sp-dismiss"
          aria-label="Cerrar menú"
          onClick={() => setMoreOpen(false)}
        />
      )}

      {cropSource && onPickCover && (
        <CoverCropSheet
          file={cropSource.blob}
          fileName={cropSource.name}
          onCancel={() => setCropSource(null)}
          onConfirm={async (file) => {
            await onPickCover(file)
            setCropSource(null)
          }}
        />
      )}
    </div>
  )
}
