import { useEffect, useMemo, useState } from 'react'
import { fetchPodcastEpisodes } from '../lib/podcastRss'
import { searchPodcasts } from '../lib/podcastSearch'
import {
  addMyPodcast,
  formatEpisodeDate,
  formatEpisodeDuration,
  formatPodcastProgressHint,
  getMyPodcasts,
  getPodcastListenState,
  getPodcastProgressRatio,
  isMyPodcast,
  removeMyPodcast,
  type PodcastEpisode,
  type PodcastShow,
} from '../lib/podcasts'
import { usePlayerStore } from '../store/playerStore'
import {
  IconChevronDown,
  IconClose,
  IconPlus,
  IconPodcast,
  IconSearch,
  IconTrash,
} from '../components/Icons'
import './pages.css'

export function PodcastsPage() {
  const playPodcastEpisode = usePlayerStore((s) => s.playPodcastEpisode)
  const currentPodcastEpisodeId = usePlayerStore((s) => s.currentPodcastEpisodeId)
  const podcastProgressTick = usePlayerStore((s) => s.podcastProgressTick)

  const [myShows, setMyShows] = useState<PodcastShow[]>(() => getMyPodcasts())
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<PodcastShow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searched, setSearched] = useState(false)
  const [findOpen, setFindOpen] = useState(false)

  const [openShow, setOpenShow] = useState<PodcastShow | null>(null)
  const [episodes, setEpisodes] = useState<PodcastEpisode[]>([])
  const [episodesLoading, setEpisodesLoading] = useState(false)
  const [episodesError, setEpisodesError] = useState<string | null>(null)

  useEffect(() => {
    if (myShows.length === 0) setFindOpen(true)
  }, [myShows.length])

  useEffect(() => {
    if (!openShow) {
      setEpisodes([])
      setEpisodesError(null)
      return
    }
    let cancelled = false
    setEpisodesLoading(true)
    setEpisodesError(null)
    void (async () => {
      try {
        const list = await fetchPodcastEpisodes(openShow)
        if (cancelled) return
        setEpisodes(list)
      } catch {
        if (cancelled) return
        setEpisodes([])
        setEpisodesError('No se pudieron cargar los episodios. Revisa la conexión.')
      } finally {
        if (!cancelled) setEpisodesLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [openShow])

  const canSearch = Boolean(query.trim())
  const mineIds = useMemo(() => new Set(myShows.map((s) => s.id)), [myShows])
  const hasMine = myShows.length > 0

  const runSearch = async () => {
    if (!canSearch) return
    setLoading(true)
    setError(null)
    setSearched(true)
    try {
      setResults(await searchPodcasts(query, 24))
    } catch {
      setResults([])
      setError('No se pudo buscar. Revisa la conexión e inténtalo de nuevo.')
    } finally {
      setLoading(false)
    }
  }

  const onAdd = (show: PodcastShow) => {
    setMyShows(addMyPodcast(show))
  }

  const onRemove = (id: string, name?: string) => {
    const label = name || 'este podcast'
    if (!window.confirm(`¿Quitar ${label} de tus podcasts?`)) return
    setMyShows(removeMyPodcast(id))
    if (openShow?.id === id) setOpenShow(null)
  }

  const onOpenShow = (show: PodcastShow) => {
    setOpenShow(show)
  }

  const onPlayEpisode = (ep: PodcastEpisode) => {
    if (!openShow) return
    void playPodcastEpisode(ep, openShow, episodes)
  }

  const searchPanel = (
    <section className="radio-find" aria-label="Buscar podcasts">
      <label className="search-box library-search radio-find__name">
        <IconSearch size={20} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void runSearch()
          }}
          placeholder="Ej. tu diràs, el tercer temps…"
          autoCapitalize="off"
          autoCorrect="off"
          enterKeyHint="search"
          aria-label="Nombre del podcast"
        />
        {query ? (
          <button
            type="button"
            className="library-search__clear"
            aria-label="Borrar búsqueda"
            onClick={() => setQuery('')}
          >
            ×
          </button>
        ) : null}
      </label>

      <div className="radio-find__filters">
        <button
          type="button"
          className="chip chip-play radio-find__go"
          disabled={!canSearch || loading}
          onClick={() => void runSearch()}
        >
          {loading ? 'Buscando…' : 'Buscar'}
        </button>
      </div>

      {error ? <p className="radio-find__error">{error}</p> : null}

      {searched && !loading ? (
        <div className="radio-find__results">
          {results.length === 0 ? (
            <p className="empty-state__hint">Sin resultados. Prueba otro nombre.</p>
          ) : (
            <ul className="radio-result-list">
              {results.map((s) => {
                const added = mineIds.has(s.id) || isMyPodcast(s.id)
                return (
                  <li key={s.id} className="radio-result">
                    <button
                      type="button"
                      className="radio-result__main"
                      onClick={() => {
                        if (!added) onAdd(s)
                        onOpenShow(s)
                      }}
                    >
                      <span className="radio-result__logo">
                        {s.artworkUrl ? (
                          <img src={s.artworkUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
                        ) : (
                          <IconPodcast size={22} />
                        )}
                      </span>
                      <span className="radio-result__meta">
                        <strong>{s.name}</strong>
                        <span>{s.artist || s.genre || 'Podcast'}</span>
                      </span>
                    </button>
                    {added ? (
                      <button
                        type="button"
                        className="icon-btn radio-result__added"
                        aria-label="Quitar de mis podcasts"
                        onClick={() => onRemove(s.id, s.name)}
                      >
                        <IconClose size={18} />
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="icon-btn radio-result__add"
                        aria-label="Añadir a mis podcasts"
                        onClick={() => onAdd(s)}
                      >
                        <IconPlus size={20} />
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  )

  if (openShow) {
    return (
      <div className="page podcasts-page">
        <header className="page-header podcasts-page__show-head">
          <button
            type="button"
            className="chip podcasts-page__back"
            onClick={() => setOpenShow(null)}
          >
            <IconChevronDown size={18} className="podcasts-page__back-icon" /> Volver
          </button>
          <div className="podcasts-page__show-hero">
            <span className="podcasts-page__show-art">
              {openShow.artworkUrl ? (
                <img src={openShow.artworkUrl} alt="" referrerPolicy="no-referrer" />
              ) : (
                <IconPodcast size={48} />
              )}
            </span>
            <div>
              <h1>{openShow.name}</h1>
              <p className="page-header__sub">{openShow.artist || 'Podcast'}</p>
            </div>
          </div>
        </header>

        <section className="section">
          <div className="section__head">
            <h2>Episodios</h2>
            {!episodesLoading ? (
              <span className="section__count">{episodes.length}</span>
            ) : null}
          </div>

          {episodesLoading ? (
            <p className="empty-state__hint">Cargando episodios…</p>
          ) : episodesError ? (
            <p className="radio-find__error">{episodesError}</p>
          ) : episodes.length === 0 ? (
            <p className="empty-state__hint">Este podcast no tiene episodios reproducibles.</p>
          ) : (
            <ul className="podcast-episode-list">
              {episodes.map((ep) => {
                const active = currentPodcastEpisodeId === ep.id
                void podcastProgressTick
                const listenState = getPodcastListenState(ep.id)
                const completed = listenState === 'completed'
                const ratio = completed
                  ? 1
                  : getPodcastProgressRatio(ep.id, ep.durationSec)
                const inProgress = listenState === 'in_progress' && ratio > 0
                const progressHint = formatPodcastProgressHint(ep.id)
                const meta = [
                  formatEpisodeDate(ep.pubDate),
                  formatEpisodeDuration(ep.durationSec),
                  inProgress && progressHint ? progressHint : null,
                ]
                  .filter(Boolean)
                  .join(' · ')
                return (
                  <li
                    key={ep.id}
                    className={`podcast-episode ${active ? 'is-active' : ''} ${completed ? 'is-listened' : ''} ${inProgress ? 'is-partial' : ''}`}
                  >
                    <button
                      type="button"
                      className="podcast-episode__main"
                      onClick={() => onPlayEpisode(ep)}
                      aria-label={`Reproducir ${ep.title}`}
                    >
                      <span className="podcast-episode__art">
                        {(ep.artworkUrl || openShow.artworkUrl) ? (
                          <img
                            src={ep.artworkUrl || openShow.artworkUrl}
                            alt=""
                            loading="lazy"
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          <IconPodcast size={20} />
                        )}
                      </span>
                      <span className="podcast-episode__meta">
                        <strong>{ep.title}</strong>
                        {meta ? <span>{meta}</span> : null}
                        <span
                          className={`podcast-episode__timeline ${completed ? 'is-done' : ''} ${ratio <= 0 ? 'is-empty' : ''}`}
                          role="progressbar"
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={Math.round(ratio * 100)}
                          aria-label="Progreso de escucha"
                        >
                          <span
                            className="podcast-episode__timeline-fill"
                            style={{ width: `${Math.round(ratio * 100)}%` }}
                          />
                        </span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </div>
    )
  }

  return (
    <div className="page podcasts-page">
      <header className="page-header">
        <h1>
          <IconPodcast size={28} /> Podcasts
        </h1>
        <p className="page-header__sub">
          {hasMine
            ? 'Toca un podcast para ver episodios. Usa la papelera para quitarlo.'
            : 'Busca por nombre (Tu diràs, El tercer temps…) y añade a tu lista.'}
        </p>
      </header>

      {hasMine ? (
        <details
          className="radio-find-fold"
          open={findOpen}
          onToggle={(e) => setFindOpen((e.target as HTMLDetailsElement).open)}
        >
          <summary>
            <IconSearch size={18} /> Buscar podcasts
          </summary>
          {searchPanel}
        </details>
      ) : (
        searchPanel
      )}

      <section className="section radio-mine-section">
        {hasMine ? (
          <>
            <div className="section__head">
              <h2>Mis podcasts</h2>
              <span className="section__count">{myShows.length}</span>
            </div>
            <div className="radio-big-grid">
              {myShows.map((s) => (
                <div key={s.id} className="radio-big">
                  <button
                    type="button"
                    className="radio-big__play"
                    onClick={() => onOpenShow(s)}
                    aria-label={`Abrir ${s.name}`}
                  >
                    <span className="radio-big__art">
                      {s.artworkUrl ? (
                        <img src={s.artworkUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
                      ) : (
                        <span className="radio-big__fallback">
                          <IconPodcast size={36} />
                        </span>
                      )}
                    </span>
                  </button>
                  <div className="radio-big__title-row">
                    <button
                      type="button"
                      className="radio-big__label"
                      onClick={() => onOpenShow(s)}
                    >
                      <strong className="radio-big__name">{s.name}</strong>
                      <span className="radio-big__sub">{s.artist || 'Podcast'}</span>
                    </button>
                    <button
                      type="button"
                      className="radio-big__delete"
                      aria-label={`Quitar ${s.name}`}
                      title="Quitar de mis podcasts"
                      onClick={() => onRemove(s.id, s.name)}
                    >
                      <IconTrash size={16} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="empty-state">
            <p className="empty-state__hint">
              Todavía no tienes podcasts. Busca arriba y pulsa + para añadirlos.
            </p>
          </div>
        )}
      </section>
    </div>
  )
}
