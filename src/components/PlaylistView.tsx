import { useMemo, useRef, useState } from 'react'
import type { Track } from '../types'
import { formatTime } from '../lib/mediaSession'
import { useAuthStore } from '../store/authStore'
import { useLibraryStore } from '../store/libraryStore'
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
  IconSort,
  IconHeart,
  IconClose,
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
  onShare?: () => Promise<void> | void
}

const SORT_LABELS: Record<PlaylistSort, string> = {
  custom: 'Orden personalizado',
  title: 'Título',
  artist: 'Artista',
  album: 'Álbum',
  duration: 'Duración',
  newest: 'Recientes',
}

export function PlaylistView({
  title,
  subtitle,
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
  onShare,
}: Props) {
  const user = useAuthStore((s) => s.user)
  const allTracks = useLibraryStore((s) => s.tracks)
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
  const [sortOpen, setSortOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [builderOpen, setBuilderOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [editName, setEditName] = useState(title)
  const [editDesc, setEditDesc] = useState(description)
  const [addQuery, setAddQuery] = useState('')
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
    switch (sort) {
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
  }, [tracks, query, sort, orderedIds])

  const ids = displayTracks.map((t) => t.id)
  const heroCoverId = coverId || coverTrackId || tracks[0]?.id || null
  const heroHasCover = coverId
    ? !!hasCover
    : Boolean(tracks.find((t) => t.id === heroCoverId)?.hasCover)

  const addCandidates = useMemo(() => {
    const inList = new Set(tracks.map((t) => t.id))
    const q = addQuery.trim().toLowerCase()
    return allTracks
      .filter((t) => !inList.has(t.id))
      .filter(
        (t) =>
          !q ||
          t.title.toLowerCase().includes(q) ||
          t.artist.toLowerCase().includes(q),
      )
      .slice(0, 80)
  }, [allTracks, tracks, addQuery])

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
      className={`sp-playlist ${likedStyle ? 'sp-playlist--liked' : ''} ${collapsed ? 'is-scrolled' : ''}`}
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
              <IconHeart size={72} filled />
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
              <IconEdit size={22} />
              Elegir foto
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
          <h1 className="sp-hero__title">{title}</h1>
          {description && <p className="sp-hero__desc">{description}</p>}
          <p className="sp-hero__stats">
            <span className="sp-hero__owner">
              <UserAvatar user={user} size={24} className="sp-hero__avatar" />
              {user?.displayName || 'Tú'}
            </span>
            {subtitle && (
              <>
                <span className="dot">·</span>
                <span>{subtitle}</span>
              </>
            )}
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

      <div className="sp-sticky">
        <div className="sp-sticky__bar">
          <span className="sp-sticky__cover">
            {likedStyle && !heroCoverId ? (
              <span className="sp-sticky__liked">
                <IconHeart size={18} filled />
              </span>
            ) : (
              <CoverArt
                trackId={heroCoverId}
                hasCover={heroHasCover !== false}
                size={48}
                rounded="sm"
              />
            )}
          </span>
          <div className="sp-sticky__meta">
            <strong>{title}</strong>
            <span>
              {tracks.length} cancion{tracks.length === 1 ? '' : 'es'} · {durationLabel}
            </span>
          </div>
          <button
            type="button"
            className="sp-sticky__play"
            disabled={!tracks.length}
            aria-label="Reproducir"
            onClick={() => void playTracks(ids, undefined, { shuffle: false })}
          >
            <IconPlay size={22} />
          </button>
        </div>
        <div className="sp-table-head sp-table-head--sticky">
          <span className="col-num">#</span>
          <span className="col-title">Título</span>
          <span className="col-album">Álbum</span>
          <span className="col-date">Fecha</span>
          <span className="col-time">
            <IconClock size={16} />
          </span>
        </div>
      </div>

      <div className="sp-controls">
        <div className="sp-controls__left">
          <button
            type="button"
            className="sp-play"
            disabled={!tracks.length}
            aria-label="Reproducir"
            onClick={() => void playTracks(ids, undefined, { shuffle: false })}
          >
            <IconPlay size={28} />
          </button>
          <button
            type="button"
            className={`sp-icon ${shuffle ? 'is-on' : ''}`}
            aria-label="Aleatorio"
            title="Orden aleatorio"
            disabled={!tracks.length}
            onClick={() => {
              if (!shuffle) toggleShuffle()
              void playTracks(
                tracks.map((t) => t.id),
                undefined,
                { shuffle: true },
              )
            }}
          >
            <IconShuffle size={28} />
          </button>
          <button
            type="button"
            className="sp-icon"
            aria-label="Descargar lista"
            title="Exportar M3U"
            disabled={!tracks.length}
            onClick={exportM3u}
          >
            <IconDownload size={24} />
          </button>
          {onShare && (
            <button
              type="button"
              className="sp-icon"
              aria-label="Compartir con MyVibe"
              title="Compartir .myvibe (audio + datos)"
              disabled={!tracks.length || sharing}
              onClick={() => {
                setSharing(true)
                void Promise.resolve(onShare())
                  .catch((e) => {
                    if (e instanceof DOMException && e.name === 'AbortError') return
                    alert(e instanceof Error ? e.message : 'No se pudo compartir')
                  })
                  .finally(() => setSharing(false))
              }}
            >
              <IconShare size={24} />
            </button>
          )}
          <button
            type="button"
            className="sp-icon"
            aria-label="Añadir a la cola"
            disabled={!tracks.length}
            onClick={() => tracks.forEach((t) => addToQueue(t.id))}
          >
            <IconQueue size={24} />
          </button>
          <div className="sp-more-wrap">
            <button
              type="button"
              className="sp-icon"
              aria-label="Más opciones"
              onClick={() => setMoreOpen((v) => !v)}
            >
              <IconMore size={24} />
            </button>
            {moreOpen && (
              <div className="sp-menu">
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
                <button
                  type="button"
                  onClick={() => {
                    void playTracks(ids, undefined, { shuffle: true })
                    setMoreOpen(false)
                  }}
                >
                  <IconShuffle size={18} /> Reproducir aleatorio
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

        <div className="sp-controls__right">
          {searchOpen ? (
            <label className="sp-search">
              <IconSearch size={16} />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Buscar en la lista"
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
              <IconSearch size={22} />
            </button>
          )}

          <div className="sp-sort-wrap">
            <button
              type="button"
              className="sp-sort"
              onClick={() => setSortOpen((v) => !v)}
            >
              {SORT_LABELS[sort]}
              <IconSort size={16} />
            </button>
            {sortOpen && (
              <div className="sp-menu sp-menu--right">
                {(Object.keys(SORT_LABELS) as PlaylistSort[]).map((key) => (
                  <button
                    type="button"
                    key={key}
                    className={sort === key ? 'is-active' : ''}
                    onClick={() => {
                      setSort(key)
                      setSortOpen(false)
                    }}
                  >
                    {SORT_LABELS[key]}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="sp-secondary">
        {onAddTracks && playlistId && (
          <button type="button" className="sp-pill" onClick={() => setBuilderOpen(true)}>
            <IconEdit size={16} /> Editar lista
          </button>
        )}
        {onAddTracks && (
          <button type="button" className="sp-pill" onClick={() => setAddOpen(true)}>
            <IconPlus size={16} /> Añadir
          </button>
        )}
        {onEditInfo && (
          <button
            type="button"
            className="sp-pill"
            onClick={() => {
              setEditName(title)
              setEditDesc(description)
              setEditOpen(true)
            }}
          >
            <IconEdit size={16} /> Nombre e información
          </button>
        )}
      </div>

      <div className="sp-table-wrap">
        {displayTracks.length === 0 ? (
          <div className="sp-empty">
            {query
              ? 'No hay coincidencias en esta lista'
              : 'Esta lista está vacía. Pulsa Añadir para meter canciones.'}
          </div>
        ) : (
          <ul className="sp-table-body">
            {displayTracks.map((track, i) => {
              const active = track.id === currentTrackId
              return (
                <li
                  key={track.id}
                  className={`sp-row ${active ? 'is-active' : ''}`}
                >
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
                  <button
                    type="button"
                    className="sp-row__title"
                    onClick={() =>
                      void playTracks(
                        displayTracks.map((t) => t.id),
                        track.id,
                      )
                    }
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
                  <span className="col-date">
                    {track.year || '—'}
                  </span>
                  <span className="col-time">{formatTime(track.duration)}</span>
                  {onRemoveTrack && (
                    <button
                      type="button"
                      className="sp-row__remove"
                      aria-label="Quitar de la lista"
                      onClick={() => void onRemoveTrack(track.id)}
                    >
                      <IconClose size={16} />
                    </button>
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

      {addOpen && onAddTracks && (
        <div className="sheet">
          <button type="button" className="sheet-backdrop" onClick={() => setAddOpen(false)} />
          <div className="sheet__panel sp-add-panel">
            <h3>Añadir a esta lista</h3>
            <label className="sp-search sp-search--block">
              <IconSearch size={16} />
              <input
                value={addQuery}
                onChange={(e) => setAddQuery(e.target.value)}
                placeholder="Buscar en tu biblioteca"
                autoFocus
              />
            </label>
            <ul className="sp-add-list">
              {addCandidates.map((t) => (
                <li key={t.id}>
                  <CoverArt trackId={t.id} hasCover={t.hasCover} size={40} />
                  <div>
                    <strong>{t.title}</strong>
                    <span>{t.artist}</span>
                  </div>
                  <button
                    type="button"
                    className="sp-pill"
                    onClick={() => void onAddTracks([t.id])}
                  >
                    <IconPlus size={14} /> Añadir
                  </button>
                </li>
              ))}
              {addCandidates.length === 0 && (
                <p className="empty-state__hint">No hay más canciones para añadir</p>
              )}
            </ul>
            {playlistId && (
              <p className="sp-add-hint">Los cambios se guardan al instante</p>
            )}
          </div>
        </div>
      )}

      {(moreOpen || sortOpen) && (
        <button
          type="button"
          className="sp-dismiss"
          aria-label="Cerrar menú"
          onClick={() => {
            setMoreOpen(false)
            setSortOpen(false)
          }}
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
