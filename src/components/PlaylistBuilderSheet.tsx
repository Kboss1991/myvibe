import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import type { Track } from '../types'
import { playlistCoverId } from '../lib/library'
import { useLibraryStore } from '../store/libraryStore'
import { CoverArt } from './CoverArt'
import { CoverCropSheet } from './CoverCropSheet'
import { IconClose, IconEdit, IconPlus, IconSearch } from './Icons'
import './PlaylistBuilderSheet.css'
import './TrackList.css'

function SheetPortal({ children }: { children: ReactNode }) {
  if (typeof document === 'undefined') return null
  return createPortal(children, document.body)
}

type Props = {
  /** null = modo crear; id = editar / añadir recomendaciones */
  playlistId: string | null
  onClose: () => void
}

export function PlaylistBuilderSheet({ playlistId: initialId, onClose }: Props) {
  const navigate = useNavigate()
  const tracks = useLibraryStore((s) => s.tracks)
  const playlists = useLibraryStore((s) => s.playlists)
  const createPlaylist = useLibraryStore((s) => s.createPlaylist)
  const updatePlaylistInfo = useLibraryStore((s) => s.updatePlaylistInfo)
  const setPlaylistCover = useLibraryStore((s) => s.setPlaylistCover)
  const addToPlaylist = useLibraryStore((s) => s.addToPlaylist)
  const removeFromPlaylist = useLibraryStore((s) => s.removeFromPlaylist)

  const [playlistId, setPlaylistId] = useState<string | null>(initialId)
  const [draftName, setDraftName] = useState('')
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [query, setQuery] = useState('')
  const [artists, setArtists] = useState<Set<string>>(() => new Set())
  const [years, setYears] = useState<Set<string>>(() => new Set())
  const [genres, setGenres] = useState<Set<string>>(() => new Set())
  const [filterTab, setFilterTab] = useState<'artists' | 'years' | 'genres' | null>(null)
  const [cropSource, setCropSource] = useState<{ blob: Blob; name: string } | null>(null)
  const coverInputRef = useRef<HTMLInputElement>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)

  const playlist = playlists.find((p) => p.id === playlistId) ?? null
  const inList = useMemo(
    () => new Set(playlist?.trackIds ?? []),
    [playlist?.trackIds],
  )

  useEffect(() => {
    document.body.classList.add('sheet-open')
    return () => document.body.classList.remove('sheet-open')
  }, [])

  useEffect(() => {
    if (!playlistId) {
      window.setTimeout(() => nameInputRef.current?.focus(), 50)
    }
  }, [playlistId])

  useEffect(() => {
    if (playlist && !renaming) setRenameValue(playlist.name)
  }, [playlist, renaming])

  const artistOptions = useMemo(() => {
    const map = new Map<string, number>()
    for (const t of tracks) {
      if (inList.has(t.id)) continue
      const a = t.artist?.trim() || 'Desconocido'
      map.set(a, (map.get(a) ?? 0) + 1)
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }, [tracks, inList])

  const yearOptions = useMemo(() => {
    const map = new Map<string, number>()
    for (const t of tracks) {
      if (inList.has(t.id)) continue
      const y = (t.year || '').trim()
      if (!y) continue
      map.set(y, (map.get(y) ?? 0) + 1)
    }
    return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]))
  }, [tracks, inList])

  const genreOptions = useMemo(() => {
    const map = new Map<string, number>()
    for (const t of tracks) {
      if (inList.has(t.id)) continue
      const g = (t.genre || '').trim()
      if (!g) continue
      map.set(g, (map.get(g) ?? 0) + 1)
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }, [tracks, inList])

  const recommendations = useMemo(() => {
    const q = query.trim().toLowerCase()
    return tracks
      .filter((t) => {
        if (inList.has(t.id)) return false
        if (artists.size && !artists.has(t.artist?.trim() || 'Desconocido')) return false
        if (years.size && !years.has((t.year || '').trim())) return false
        if (genres.size && !genres.has((t.genre || '').trim())) return false
        if (q) {
          const hay = `${t.title} ${t.artist} ${t.album}`.toLowerCase()
          if (!hay.includes(q)) return false
        }
        return true
      })
      .slice(0, 120)
  }, [tracks, inList, artists, years, genres, query])

  async function handleCreate() {
    const name = draftName.trim() || 'Mi lista'
    setCreating(true)
    try {
      const p = await createPlaylist(name)
      setPlaylistId(p.id)
      setRenameValue(p.name)
    } finally {
      setCreating(false)
    }
  }

  async function handleRename() {
    if (!playlistId) return
    const name = renameValue.trim() || 'Mi lista'
    await updatePlaylistInfo(playlistId, { name })
    setRenaming(false)
  }

  async function toggleTrack(track: Track) {
    if (!playlistId) return
    if (inList.has(track.id)) await removeFromPlaylist(playlistId, track.id)
    else await addToPlaylist(playlistId, [track.id])
  }

  function toggleFilter(set: Set<string>, value: string, setter: (s: Set<string>) => void) {
    const next = new Set(set)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    setter(next)
  }

  function finish() {
    const createdFresh = initialId === null && Boolean(playlistId)
    onClose()
    if (createdFresh && playlistId) navigate(`/playlist/${playlistId}`)
  }

  const step = playlistId ? 'edit' : 'create'

  return (
    <SheetPortal>
      <div className="sheet pl-builder">
        <button type="button" className="sheet-backdrop" aria-label="Cerrar" onClick={onClose} />
        <div className={`sheet__panel pl-builder__panel ${step === 'edit' ? 'pl-builder__panel--edit' : ''}`}>
          {step === 'create' ? (
            <div className="pl-builder__create">
              <button type="button" className="pl-builder__x" aria-label="Cerrar" onClick={onClose}>
                <IconClose size={22} />
              </button>
              <p className="pl-builder__lead">Ponle un título a la lista</p>
              <input
                ref={nameInputRef}
                className="pl-builder__title-input"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                placeholder="Mi lista nº 1"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleCreate()
                }}
              />
              <button
                type="button"
                className="btn-primary pl-builder__create-btn"
                disabled={creating}
                onClick={() => void handleCreate()}
              >
                {creating ? 'Creando…' : 'Crear'}
              </button>
            </div>
          ) : (
            <>
              <div className="pl-builder__top">
                <button type="button" className="pl-builder__x" aria-label="Cerrar" onClick={finish}>
                  <IconClose size={22} />
                </button>
                <button type="button" className="btn-primary pl-builder__done" onClick={finish}>
                  Listo
                </button>
              </div>

              <div className="pl-builder__hero">
                <button
                  type="button"
                  className="pl-builder__cover"
                  onClick={() => coverInputRef.current?.click()}
                  aria-label="Cambiar portada"
                >
                  {playlist?.hasCover ? (
                    <CoverArt
                      trackId={playlistCoverId(playlist.id)}
                      hasCover
                      refreshKey={playlist.updatedAt}
                      size={120}
                      rounded="md"
                    />
                  ) : playlist?.trackIds[0] ? (
                    <CoverArt
                      trackId={playlist.trackIds[0]}
                      hasCover={
                        tracks.find((t) => t.id === playlist.trackIds[0])?.hasCover ?? false
                      }
                      size={120}
                      rounded="md"
                    />
                  ) : (
                    <span className="pl-builder__cover-empty">Portada</span>
                  )}
                  <span className="pl-builder__cover-hint">Cambiar</span>
                </button>
                <input
                  ref={coverInputRef}
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    e.target.value = ''
                    if (f) setCropSource({ blob: f, name: f.name })
                  }}
                />

                <div className="pl-builder__name-row">
                  {renaming ? (
                    <div className="pl-builder__rename">
                      <input
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void handleRename()
                          if (e.key === 'Escape') setRenaming(false)
                        }}
                      />
                      <button type="button" className="btn-primary" onClick={() => void handleRename()}>
                        Guardar
                      </button>
                    </div>
                  ) : (
                    <>
                      <h3 className="pl-builder__name">{playlist?.name ?? 'Lista'}</h3>
                      <button
                        type="button"
                        className="pl-builder__rename-btn"
                        aria-label="Cambiar título"
                        onClick={() => {
                          setRenameValue(playlist?.name ?? '')
                          setRenaming(true)
                        }}
                      >
                        <IconEdit size={16} /> Cambiar título
                      </button>
                    </>
                  )}
                  <p className="pl-builder__count">
                    {playlist?.trackIds.length ?? 0}{' '}
                    {(playlist?.trackIds.length ?? 0) === 1 ? 'canción' : 'canciones'}
                  </p>
                </div>
              </div>

              <p className="pl-builder__section-title">Añadir canciones</p>

              <div className="pl-builder__filters">
                {(
                  [
                    ['artists', 'Artistas', artists.size],
                    ['years', 'Años', years.size],
                    ['genres', 'Estilos', genres.size],
                  ] as const
                ).map(([key, label, count]) => (
                  <button
                    key={key}
                    type="button"
                    className={`pl-builder__chip ${filterTab === key ? 'is-on' : ''} ${count ? 'has-sel' : ''}`}
                    onClick={() => setFilterTab((t) => (t === key ? null : key))}
                  >
                    {label}
                    {count ? ` · ${count}` : ''}
                  </button>
                ))}
                {(artists.size > 0 || years.size > 0 || genres.size > 0) && (
                  <button
                    type="button"
                    className="pl-builder__chip pl-builder__chip--clear"
                    onClick={() => {
                      setArtists(new Set())
                      setYears(new Set())
                      setGenres(new Set())
                    }}
                  >
                    Limpiar
                  </button>
                )}
              </div>

              {filterTab === 'artists' && (
                <div className="pl-builder__filter-list">
                  {artistOptions.slice(0, 40).map(([name, n]) => (
                    <button
                      key={name}
                      type="button"
                      className={`pl-builder__filter-item ${artists.has(name) ? 'is-on' : ''}`}
                      onClick={() => toggleFilter(artists, name, setArtists)}
                    >
                      <span>{name}</span>
                      <small>{n}</small>
                    </button>
                  ))}
                </div>
              )}
              {filterTab === 'years' && (
                <div className="pl-builder__filter-list">
                  {yearOptions.slice(0, 40).map(([name, n]) => (
                    <button
                      key={name}
                      type="button"
                      className={`pl-builder__filter-item ${years.has(name) ? 'is-on' : ''}`}
                      onClick={() => toggleFilter(years, name, setYears)}
                    >
                      <span>{name}</span>
                      <small>{n}</small>
                    </button>
                  ))}
                  {yearOptions.length === 0 && (
                    <p className="empty-state__hint">No hay años en tu biblioteca</p>
                  )}
                </div>
              )}
              {filterTab === 'genres' && (
                <div className="pl-builder__filter-list">
                  {genreOptions.slice(0, 40).map(([name, n]) => (
                    <button
                      key={name}
                      type="button"
                      className={`pl-builder__filter-item ${genres.has(name) ? 'is-on' : ''}`}
                      onClick={() => toggleFilter(genres, name, setGenres)}
                    >
                      <span>{name}</span>
                      <small>{n}</small>
                    </button>
                  ))}
                  {genreOptions.length === 0 && (
                    <p className="empty-state__hint">No hay estilos en tu biblioteca</p>
                  )}
                </div>
              )}

              <label className="pl-builder__search">
                <IconSearch size={16} />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Buscar canciones"
                />
              </label>

              <ul className="pl-builder__tracks">
                {recommendations.map((t) => {
                  const added = inList.has(t.id)
                  return (
                    <li key={t.id} className="pl-builder__track">
                      <CoverArt trackId={t.id} hasCover={t.hasCover} size={48} rounded="sm" />
                      <div className="pl-builder__track-meta">
                        <strong>{t.title}</strong>
                        <span>
                          {t.artist}
                          {t.year ? ` · ${t.year}` : ''}
                          {t.genre ? ` · ${t.genre}` : ''}
                        </span>
                      </div>
                      <button
                        type="button"
                        className={`pl-builder__add-circle ${added ? 'is-added' : ''}`}
                        aria-label={added ? 'Quitar de la lista' : 'Añadir a la lista'}
                        onClick={() => void toggleTrack(t)}
                      >
                        {added ? <IconClose size={16} /> : <IconPlus size={18} />}
                      </button>
                    </li>
                  )
                })}
                {recommendations.length === 0 && (
                  <p className="empty-state__hint">
                    No hay canciones con estos filtros. Prueba otros o limpia el filtro.
                  </p>
                )}
              </ul>
            </>
          )}
        </div>
      </div>

      {cropSource && playlistId && (
        <CoverCropSheet
          file={cropSource.blob}
          fileName={cropSource.name}
          onCancel={() => setCropSource(null)}
          onConfirm={async (file) => {
            await setPlaylistCover(playlistId, file)
            setCropSource(null)
          }}
        />
      )}
    </SheetPortal>
  )
}
