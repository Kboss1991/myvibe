import { useEffect, useMemo, useState, useSyncExternalStore, type MouseEvent } from 'react'
import { audioEngine } from '../lib/audioEngine'
import { searchStations } from '../lib/radioBrowser'
import {
  addMyRadio,
  hasMyRadio,
  listMyRadios,
  removeMyRadio,
  subscribeMyRadios,
  type RadioStation,
} from '../lib/myRadios'
import { formatRadioDelay } from '../lib/radios'
import { usePlayerStore } from '../store/playerStore'
import { IconClose, IconPause, IconPlay, IconPlus, IconRadio, IconSearch, IconTrash } from '../components/Icons'
import './pages.css'

let lastRadioSelectAt = 0

function useMyRadios(): RadioStation[] {
  return useSyncExternalStore(subscribeMyRadios, listMyRadios, listMyRadios)
}

const GROUP_LABEL: Record<RadioStation['group'], string> = {
  catalunya: 'Catalunya',
  espana: 'España',
  world: 'Internacional',
}

export function RadiosPage() {
  const playRadio = usePlayerStore((s) => s.playRadio)
  const toggle = usePlayerStore((s) => s.toggle)
  const setRadioDelay = usePlayerStore((s) => s.setRadioDelay)
  const currentRadioId = usePlayerStore((s) => s.currentRadioId)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const radioDelay = usePlayerStore((s) => s.radioDelay)
  const maxDelay = audioEngine.maxRadioDelay

  const myRadios = useMyRadios()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<RadioStation[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)

  // Forzar lectura estable tras la primera siembra (sin mutar en getSnapshot)
  useEffect(() => {
    listMyRadios()
  }, [])

  const q = query.trim()
  const hasQuery = q.length >= 2

  useEffect(() => {
    if (!hasQuery) {
      setResults([])
      setSearching(false)
      setSearchError(null)
      return
    }
    let cancelled = false
    setSearching(true)
    setSearchError(null)
    const timer = window.setTimeout(() => {
      void searchStations(q)
        .then((stations) => {
          if (cancelled) return
          setResults(stations)
          setSearching(false)
        })
        .catch(() => {
          if (cancelled) return
          setResults([])
          setSearching(false)
          setSearchError('No se pudo buscar. Revisa la conexión e inténtalo de nuevo.')
        })
    }, 320)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [q, hasQuery])

  const groups = useMemo(() => {
    const order: RadioStation['group'][] = ['catalunya', 'espana', 'world']
    const present = order.filter((g) => myRadios.some((s) => s.group === g))
    if (present.length <= 1) {
      return [{ key: 'all' as const, title: 'Mis radios', stations: myRadios }]
    }
    return present.map((g) => ({
      key: g,
      title: GROUP_LABEL[g],
      stations: myRadios.filter((s) => s.group === g),
    }))
  }, [myRadios])

  const onSelect = (id: string) => {
    // Evitar doble toque (touch+click) que pausa justo al sintonizar
    const now = Date.now()
    if (now - lastRadioSelectAt < 450) return
    lastRadioSelectAt = now
    if (currentRadioId === id) void toggle()
    else void playRadio(id)
  }

  const onAdd = (station: RadioStation) => {
    addMyRadio(station)
  }

  const onRemove = (id: string, e: MouseEvent) => {
    e.stopPropagation()
    removeMyRadio(id)
    if (currentRadioId === id) {
      usePlayerStore.getState().pause()
    }
  }

  const playFromSearch = (station: RadioStation) => {
    if (!hasMyRadio(station.id)) addMyRadio(station)
    void playRadio(station.id)
  }

  return (
    <div className="page radios-page">
      <header className="page-header">
        <h1>
          <IconRadio size={28} /> Radios
        </h1>
        <p className="page-header__sub">
          Busca entre miles de emisoras y añade solo las tuyas.
        </p>
      </header>

      <label className="search-box radios-search">
        <IconSearch size={20} />
        <input
          type="search"
          placeholder="Buscar emisoras (RAC1, BBC, jazz…)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          enterKeyHint="search"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        {query ? (
          <button
            type="button"
            className="search-box__clear"
            aria-label="Limpiar búsqueda"
            onClick={() => setQuery('')}
          >
            <IconClose size={18} />
          </button>
        ) : null}
      </label>

      <section className="radio-sync" aria-label="Sincronizar con la tele">
        <div className="radio-sync__text">
          <h2>Sincronizar con la tele</h2>
          <p>
            Pausa la radio, espera a que cuadre la imagen y dale a play. Cada
            pausa suma ese tiempo al retraso. El valor se guarda en este dispositivo.
          </p>
        </div>
        <div className="radio-sync__controls">
          <div className="radio-sync__value radio-sync__value--solo" aria-live="polite">
            <strong>{formatRadioDelay(radioDelay)}</strong>
            <span>retraso</span>
          </div>
        </div>
        <div className="radio-sync__meter" aria-hidden>
          <div
            className="radio-sync__meter-fill"
            style={{ width: `${Math.min(100, (radioDelay / Math.max(maxDelay, 1)) * 100)}%` }}
          />
        </div>
        <p className="radio-sync__ends">
          <span>0</span>
          <span>{maxDelay} s</span>
        </p>
        {radioDelay > 0 ? (
          <button type="button" className="radio-sync__reset" onClick={() => setRadioDelay(0)}>
            Sin retraso
          </button>
        ) : null}
      </section>

      {hasQuery ? (
        <section className="section">
          <h2 className="section__title">Resultados</h2>
          {searching ? <p className="radios-hint">Buscando…</p> : null}
          {searchError ? <p className="radios-hint radios-hint--error">{searchError}</p> : null}
          {!searching && !searchError && results.length === 0 ? (
            <p className="radios-hint">No hay emisoras para “{q}”.</p>
          ) : null}
          <ul className="radio-results">
            {results.map((s) => {
              const saved = hasMyRadio(s.id)
              return (
                <li key={s.id} className="radio-result">
                  <button
                    type="button"
                    className="radio-result__main"
                    onClick={() => playFromSearch(s)}
                  >
                    <span className="radio-result__logo">
                      {s.logoUrl ? (
                        <img src={s.logoUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
                      ) : (
                        <IconRadio size={22} />
                      )}
                    </span>
                    <span className="radio-result__meta">
                      <strong>{s.name}</strong>
                      <span>{s.tagline}</span>
                    </span>
                  </button>
                  {saved ? (
                    <button
                      type="button"
                      className="radio-result__action is-saved"
                      aria-label={`Quitar ${s.name}`}
                      onClick={(e) => onRemove(s.id, e)}
                    >
                      <IconTrash size={18} />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="radio-result__action"
                      aria-label={`Añadir ${s.name}`}
                      onClick={() => onAdd(s)}
                    >
                      <IconPlus size={18} />
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      ) : (
        <>
          {myRadios.length === 0 ? (
            <section className="section radios-empty">
              <h2 className="section__title">Mis radios</h2>
              <p className="radios-hint">
                Aún no tienes emisoras. Usa el buscador para encontrarlas y pulsa + para añadirlas.
              </p>
            </section>
          ) : (
            groups.map((g) => (
              <section key={g.key} className="section">
                <h2 className="section__title">{g.title}</h2>
                <div className="radio-grid">
                  {g.stations.map((s) => {
                    const active = currentRadioId === s.id
                    const playing = active && isPlaying
                    return (
                      <div key={s.id} className={`radio-card ${active ? 'is-active' : ''}`}>
                        <button type="button" className="radio-card__hit" onClick={() => onSelect(s.id)}>
                          <span className="radio-card__logo">
                            {s.logoUrl ? (
                              <img
                                src={s.logoUrl}
                                alt=""
                                loading="lazy"
                                referrerPolicy="no-referrer"
                              />
                            ) : (
                              <span className="radio-card__logo-fallback">
                                <IconRadio size={36} />
                              </span>
                            )}
                            <span className="radio-card__play" aria-hidden>
                              {playing ? <IconPause size={22} /> : <IconPlay size={22} />}
                            </span>
                            {active && playing ? (
                              <span className="radio-card__live">EN DIRECTO</span>
                            ) : null}
                          </span>
                          <strong>{s.name}</strong>
                          <span>{active ? (playing ? 'En antena' : 'Pausada') : s.tagline}</span>
                        </button>
                        <button
                          type="button"
                          className="radio-card__remove"
                          aria-label={`Quitar ${s.name}`}
                          onClick={(e) => onRemove(s.id, e)}
                        >
                          <IconTrash size={16} />
                        </button>
                      </div>
                    )
                  })}
                </div>
              </section>
            ))
          )}
        </>
      )}
    </div>
  )
}
