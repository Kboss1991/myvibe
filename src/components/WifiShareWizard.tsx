import { useMemo, useState } from 'react'
import type { Playlist, Track } from '../types'
import type { WifiHostOptions, WifiSharePrefill } from '../lib/wifiTransfer'

export type WifiShareMode = 'playlists' | 'liked' | 'filter' | 'all'

type Props = {
  tracks: Track[]
  playlists: Playlist[]
  liked: Track[]
  artists: { name: string; tracks: Track[] }[]
  albums: { name: string; artist: string; tracks: Track[] }[]
  genres: { name: string; tracks: Track[] }[]
  busy?: boolean
  initialPrefill?: WifiSharePrefill | null
  onStart: (options: WifiHostOptions, summary: string) => void
}

function withAudio(tracks: Track[]): Track[] {
  return tracks.filter((t) => t.hasLocalAudio !== false)
}

export function WifiShareWizard({
  tracks,
  playlists,
  liked,
  artists,
  albums,
  genres,
  busy,
  initialPrefill,
  onStart,
}: Props) {
  const [mode, setMode] = useState<WifiShareMode>(initialPrefill?.mode ?? 'playlists')
  const [selectedPlaylists, setSelectedPlaylists] = useState<Set<string>>(
    () => new Set(initialPrefill?.playlistIds ?? []),
  )
  const [prefillTrackIds] = useState<string[] | null>(
    () =>
      initialPrefill?.mode === 'filter' && initialPrefill.trackIds?.length
        ? initialPrefill.trackIds
        : null,
  )
  const [filterKind, setFilterKind] = useState<'artist' | 'album' | 'genre'>('genre')
  const [filterValue, setFilterValue] = useState('')
  const [query, setQuery] = useState('')

  const filterOptions = useMemo(() => {
    if (filterKind === 'artist') return artists.map((a) => a.name)
    if (filterKind === 'album') return albums.map((a) => `${a.artist} — ${a.name}`)
    return genres.map((g) => g.name)
  }, [filterKind, artists, albums, genres])

  const filteredTracks = useMemo(() => {
    let list = withAudio(tracks)
    if (filterKind === 'artist' && filterValue) {
      const g = artists.find((a) => a.name === filterValue)
      list = g ? withAudio(g.tracks) : []
    } else if (filterKind === 'album' && filterValue) {
      const g = albums.find((a) => `${a.artist} — ${a.name}` === filterValue)
      list = g ? withAudio(g.tracks) : []
    } else if (filterKind === 'genre' && filterValue) {
      const g = genres.find((x) => x.name === filterValue)
      list = g ? withAudio(g.tracks) : []
    }
    const q = query.trim().toLowerCase()
    if (q) {
      list = list.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          t.artist.toLowerCase().includes(q) ||
          t.album.toLowerCase().includes(q),
      )
    }
    return list
  }, [tracks, filterKind, filterValue, query, artists, albums, genres])

  const selection = useMemo(() => {
    if (mode === 'all') {
      const list = withAudio(tracks)
      return {
        trackIds: list.map((t) => t.id),
        playlistIds: undefined as string[] | undefined,
        count: list.length,
        playlistCount: playlists.length,
        label: 'Toda la biblioteca',
      }
    }
    if (mode === 'liked') {
      const list = withAudio(liked)
      return {
        trackIds: list.map((t) => t.id),
        playlistIds: undefined,
        count: list.length,
        playlistCount: 0,
        label: 'Me gusta',
      }
    }
    if (mode === 'playlists') {
      const ids = [...selectedPlaylists]
      const idSet = new Set<string>()
      for (const pid of ids) {
        const p = playlists.find((x) => x.id === pid)
        if (!p) continue
        for (const tid of p.trackIds) idSet.add(tid)
      }
      const audioIds = [...idSet].filter((id) => {
        const t = tracks.find((x) => x.id === id)
        return t && t.hasLocalAudio !== false
      })
      return {
        trackIds: audioIds,
        playlistIds: ids,
        count: audioIds.length,
        playlistCount: ids.length,
        label: ids.length === 1
          ? playlists.find((p) => p.id === ids[0])?.name || 'Playlist'
          : `${ids.length} playlists`,
      }
    }
    // filter
    if (prefillTrackIds?.length && !filterValue && !query.trim()) {
      const idSet = new Set(prefillTrackIds)
      const list = withAudio(tracks).filter((t) => idSet.has(t.id))
      return {
        trackIds: list.map((t) => t.id),
        playlistIds: undefined,
        count: list.length,
        playlistCount: 0,
        label: initialPrefill?.label || 'Selección de biblioteca',
      }
    }
    return {
      trackIds: filteredTracks.map((t) => t.id),
      playlistIds: undefined,
      count: filteredTracks.length,
      playlistCount: 0,
      label:
        initialPrefill?.label && !filterValue && !query.trim()
          ? initialPrefill.label
          : filterValue
            ? filterValue
            : query.trim()
              ? `Búsqueda “${query.trim()}”`
              : 'Filtro de biblioteca',
    }
  }, [
    mode,
    tracks,
    liked,
    playlists,
    selectedPlaylists,
    filteredTracks,
    filterValue,
    query,
    initialPrefill?.label,
    prefillTrackIds,
  ])

  const togglePlaylist = (id: string) => {
    setSelectedPlaylists((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const canStart =
    selection.count > 0 &&
    (mode !== 'playlists' || selectedPlaylists.size > 0) &&
    (mode !== 'filter' ||
      Boolean(filterValue) ||
      Boolean(query.trim()) ||
      Boolean(prefillTrackIds?.length))

  return (
    <div className="wifi-wizard">
      <ol className="wifi-wizard__steps">
        <li>
          <strong>1.</strong> Elige qué enviar
        </li>
        <li>
          <strong>2.</strong> Genera el código
        </li>
        <li>
          <strong>3.</strong> En el iPhone: Perfil → mismo código
        </li>
      </ol>

      <div className="wifi-wizard__modes" role="tablist" aria-label="Qué enviar">
        {(
          [
            ['playlists', 'Playlists'],
            ['liked', 'Me gusta'],
            ['filter', 'Filtro'],
            ['all', 'Toda'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={mode === id}
            className={`wifi-wizard__mode ${mode === id ? 'is-on' : ''}`}
            onClick={() => setMode(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === 'playlists' && (
        <div className="wifi-wizard__panel">
          {playlists.length === 0 ? (
            <p className="profile-card__hint">No hay playlists todavía.</p>
          ) : (
            <ul className="wifi-wizard__check-list">
              {playlists.map((p) => {
                const n = p.trackIds.filter((id) => {
                  const t = tracks.find((x) => x.id === id)
                  return t && t.hasLocalAudio !== false
                }).length
                return (
                  <li key={p.id}>
                    <label className="wifi-wizard__check">
                      <input
                        type="checkbox"
                        checked={selectedPlaylists.has(p.id)}
                        onChange={() => togglePlaylist(p.id)}
                      />
                      <span>
                        {p.name}
                        <em>
                          {n} canción{n === 1 ? '' : 'es'}
                        </em>
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}

      {mode === 'liked' && (
        <div className="wifi-wizard__panel">
          <p className="profile-card__hint">
            {withAudio(liked).length} canciones en Me gusta con audio.
          </p>
        </div>
      )}

      {mode === 'filter' && (
        <div className="wifi-wizard__panel">
          {prefillTrackIds?.length && !filterValue && !query.trim() ? (
            <p className="profile-card__hint">
              Lote desde la biblioteca: {initialPrefill?.label || 'selección'} (
              {selection.count} canciones). Puedes afinar con el filtro de abajo.
            </p>
          ) : null}
          <div className="wifi-wizard__filter-row">
            <select
              value={filterKind}
              onChange={(e) => {
                setFilterKind(e.target.value as 'artist' | 'album' | 'genre')
                setFilterValue('')
              }}
              aria-label="Tipo de filtro"
            >
              <option value="genre">Género</option>
              <option value="artist">Artista</option>
              <option value="album">Álbum</option>
            </select>
            <select
              value={filterValue}
              onChange={(e) => setFilterValue(e.target.value)}
              aria-label="Valor del filtro"
            >
              <option value="">— Elegir —</option>
              {filterOptions.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <input
            type="search"
            className="wifi-wizard__search"
            placeholder="Buscar título / artista (opcional)"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <p className="profile-card__hint" style={{ marginTop: 8 }}>
            {filteredTracks.length} canción{filteredTracks.length === 1 ? '' : 'es'} coinciden
          </p>
        </div>
      )}

      {mode === 'all' && (
        <div className="wifi-wizard__panel">
          <p className="profile-card__hint">
            Enviará las {withAudio(tracks).length} canciones con audio del PC. Usa esto solo si
            quieres sincronizar casi todo de una vez.
          </p>
        </div>
      )}

      <p className="wifi-wizard__summary">
        Se enviarán <strong>{selection.count}</strong> canción
        {selection.count === 1 ? '' : 'es'}
        {selection.playlistCount
          ? ` · ${selection.playlistCount} playlist${selection.playlistCount === 1 ? '' : 's'}`
          : ''}
        {selection.label ? ` · ${selection.label}` : ''}
      </p>

      <button
        type="button"
        className="chip chip-play"
        style={{ width: '100%', justifyContent: 'center', padding: '14px 18px', fontSize: '1.05rem' }}
        disabled={busy || !canStart}
        onClick={() => {
          const options: WifiHostOptions =
            mode === 'all'
              ? {}
              : {
                  trackIds: selection.trackIds,
                  ...(selection.playlistIds?.length
                    ? { playlistIds: selection.playlistIds }
                    : {}),
                }
          onStart(options, selection.label)
        }}
      >
        Generar código de 6 dígitos
      </button>
    </div>
  )
}
