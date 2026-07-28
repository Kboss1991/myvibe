import { useMemo, useState } from 'react'
import { TrackList } from '../components/TrackList'
import { useLibraryStore } from '../store/libraryStore'
import { IconSearch } from '../components/Icons'
import './pages.css'

export function SearchPage() {
  const [q, setQ] = useState('')
  const search = useLibraryStore((s) => s.search)
  const artists = useLibraryStore((s) => s.artists)
  const albums = useLibraryStore((s) => s.albums)
  const tracks = useLibraryStore((s) => s.tracks)

  const results = useMemo(() => search(q), [q, search, tracks])
  const showBrowse = !q.trim()

  return (
    <div className="page">
      <header className="page-header">
        <h1>Buscar</h1>
      </header>

      <label className="search-box">
        <IconSearch size={20} />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Canciones, artistas o álbumes"
          autoCapitalize="off"
          autoCorrect="off"
        />
      </label>

      {showBrowse ? (
        <>
          <section className="section">
            <h2 className="section__title">Artistas</h2>
            <div className="chip-cloud">
              {artists().slice(0, 20).map((a) => (
                <button key={a.name} className="chip" onClick={() => setQ(a.name)}>
                  {a.name}
                </button>
              ))}
              {artists().length === 0 && (
                <p className="empty-state__hint">Aún no hay artistas en tu biblioteca</p>
              )}
            </div>
          </section>
          <section className="section">
            <h2 className="section__title">Álbumes</h2>
            <div className="chip-cloud">
              {albums().slice(0, 20).map((a) => (
                <button
                  key={`${a.name}-${a.artist}`}
                  className="chip"
                  onClick={() => setQ(a.name)}
                >
                  {a.name}
                </button>
              ))}
            </div>
          </section>
        </>
      ) : (
        <section className="section">
          <h2 className="section__title">
            {results.length} resultado{results.length === 1 ? '' : 's'}
          </h2>
          <TrackList
            tracks={results}
            emptyTitle="Sin resultados"
            emptyHint="Prueba con otro título o artista"
          />
        </section>
      )}
    </div>
  )
}
