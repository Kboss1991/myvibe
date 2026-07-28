import { audioEngine } from '../lib/audioEngine'
import { RADIO_STATIONS } from '../lib/radios'
import { usePlayerStore } from '../store/playerStore'
import { IconPause, IconPlay, IconRadio } from '../components/Icons'
import './pages.css'

function formatRadioDelay(sec: number) {
  if (sec <= 0) return '0 s'
  return `${sec.toLocaleString('es-ES', { maximumFractionDigits: 1 })} s`
}

export function RadiosPage() {
  const playRadio = usePlayerStore((s) => s.playRadio)
  const toggle = usePlayerStore((s) => s.toggle)
  const setRadioDelay = usePlayerStore((s) => s.setRadioDelay)
  const currentRadioId = usePlayerStore((s) => s.currentRadioId)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const radioDelay = usePlayerStore((s) => s.radioDelay)
  const maxDelay = audioEngine.maxRadioDelay

  const catalunya = RADIO_STATIONS.filter((s) => s.group === 'catalunya')
  const espana = RADIO_STATIONS.filter((s) => s.group === 'espana')

  const onSelect = (id: string) => {
    if (currentRadioId === id) void toggle()
    else void playRadio(id)
  }

  const nudgeDelay = (delta: number) => {
    setRadioDelay(Math.round((radioDelay + delta) * 2) / 2)
  }

  return (
    <div className="page radios-page">
      <header className="page-header">
        <h1>
          <IconRadio size={28} /> Radios
        </h1>
        <p className="page-header__sub">
          Emisoras en directo. Toca una para sintonizarla en el reproductor.
        </p>
      </header>

      <section className="radio-sync" aria-label="Sincronizar con la tele">
        <div className="radio-sync__text">
          <h2>Sincronizar con la tele</h2>
          <p>
            Si el audio va por delante de la imagen, retrásalo hasta que cuadre.
            El valor se guarda en este dispositivo.
          </p>
        </div>
        <div className="radio-sync__controls">
          <button
            type="button"
            className="radio-sync__nudge"
            aria-label="Menos retraso"
            disabled={radioDelay <= 0}
            onClick={() => nudgeDelay(-0.5)}
          >
            −
          </button>
          <div className="radio-sync__value" aria-live="polite">
            <strong>{formatRadioDelay(radioDelay)}</strong>
            <span>retraso</span>
          </div>
          <button
            type="button"
            className="radio-sync__nudge"
            aria-label="Más retraso"
            disabled={radioDelay >= maxDelay}
            onClick={() => nudgeDelay(0.5)}
          >
            +
          </button>
        </div>
        <label className="radio-sync__slider">
          <span className="sr-only">Retraso en segundos</span>
          <input
            type="range"
            min={0}
            max={maxDelay}
            step={0.5}
            value={radioDelay}
            onChange={(e) => setRadioDelay(Number(e.target.value))}
          />
          <span className="radio-sync__ends">
            <span>0</span>
            <span>{maxDelay} s</span>
          </span>
        </label>
        {radioDelay > 0 ? (
          <button type="button" className="radio-sync__reset" onClick={() => setRadioDelay(0)}>
            Sin retraso
          </button>
        ) : null}
      </section>

      <section className="section">
        <h2 className="section__title">Catalunya</h2>
        <div className="radio-grid">
          {catalunya.map((s) => {
            const active = currentRadioId === s.id
            const playing = active && isPlaying
            return (
              <button
                key={s.id}
                type="button"
                className={`radio-card ${active ? 'is-active' : ''}`}
                onClick={() => onSelect(s.id)}
              >
                <span className="radio-card__logo">
                  <img src={s.logoUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
                  <span className="radio-card__play" aria-hidden>
                    {playing ? <IconPause size={22} /> : <IconPlay size={22} />}
                  </span>
                </span>
                <strong>{s.name}</strong>
                <span>{active ? (playing ? 'En antena' : 'Pausada') : s.tagline}</span>
                {active && playing ? <span className="radio-card__live">EN DIRECTO</span> : null}
              </button>
            )
          })}
        </div>
      </section>

      <section className="section">
        <h2 className="section__title">España</h2>
        <div className="radio-grid">
          {espana.map((s) => {
            const active = currentRadioId === s.id
            const playing = active && isPlaying
            return (
              <button
                key={s.id}
                type="button"
                className={`radio-card ${active ? 'is-active' : ''}`}
                onClick={() => onSelect(s.id)}
              >
                <span className="radio-card__logo">
                  <img src={s.logoUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
                  <span className="radio-card__play" aria-hidden>
                    {playing ? <IconPause size={22} /> : <IconPlay size={22} />}
                  </span>
                </span>
                <strong>{s.name}</strong>
                <span>{active ? (playing ? 'En antena' : 'Pausada') : s.tagline}</span>
                {active && playing ? <span className="radio-card__live">EN DIRECTO</span> : null}
              </button>
            )
          })}
        </div>
      </section>
    </div>
  )
}
