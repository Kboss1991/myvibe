import { useEffect, useRef, type CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { audioEngine } from '../lib/audioEngine'
import { formatTime } from '../lib/mediaSession'
import { formatRadioDelay, getRadioStation } from '../lib/radios'
import { getPodcastEpisode, getPodcastShow } from '../lib/podcasts'
import { useDisplayedRadioDelay } from '../hooks/useDisplayedRadioDelay'
import { useLibraryStore } from '../store/libraryStore'
import { bindMediaSession, resumeAfterInterruption, usePlayerStore } from '../store/playerStore'
import { CoverArt } from './CoverArt'
import {
  IconHeart,
  IconPause,
  IconPlay,
  IconQueue,
  IconRepeat,
  IconShuffle,
  IconSkipBack,
  IconSkipForward,
  IconChevronDown,
  IconClose,
  IconRadio,
  IconPodcast,
  IconSkipBack15,
  IconSkipForward15,
} from './Icons'
import './Player.css'
import './TrackList.css'

function seekProgressStyle(position: number, duration: number): CSSProperties {
  const p = duration > 0 ? Math.min(100, Math.max(0, (position / duration) * 100)) : 0
  return { ['--seek-p' as string]: `${p}%` }
}

export function PlayerBar() {
  const tracks = useLibraryStore((s) => s.tracks)
  const toggleLike = useLibraryStore((s) => s.toggleLike)
  const currentTrackId = usePlayerStore((s) => s.currentTrackId)
  const currentRadioId = usePlayerStore((s) => s.currentRadioId)
  const currentPodcastEpisodeId = usePlayerStore((s) => s.currentPodcastEpisodeId)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const position = usePlayerStore((s) => s.position)
  const duration = usePlayerStore((s) => s.duration)
  const shuffle = usePlayerStore((s) => s.shuffle)
  const repeat = usePlayerStore((s) => s.repeat)
  const toggle = usePlayerStore((s) => s.toggle)
  const seek = usePlayerStore((s) => s.seek)
  const skipForward = usePlayerStore((s) => s.skipForward)
  const skipBack = usePlayerStore((s) => s.skipBack)
  const next = usePlayerStore((s) => s.next)
  const previous = usePlayerStore((s) => s.previous)
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle)
  const cycleRepeat = usePlayerStore((s) => s.cycleRepeat)
  const setNowPlayingOpen = usePlayerStore((s) => s.setNowPlayingOpen)
  const setQueueOpen = usePlayerStore((s) => s.setQueueOpen)
  const track = tracks.find((t) => t.id === currentTrackId)
  // Resolver por id (estable); no usar getCurrentRadio() en el selector (objeto nuevo cada tick)
  const radio = currentRadioId ? getRadioStation(currentRadioId) : null
  const podcastEp = currentPodcastEpisodeId ? getPodcastEpisode(currentPodcastEpisodeId) : null
  const podcastShow = podcastEp ? getPodcastShow(podcastEp.showId) : null
  const coverUrl = usePlayerStore((s) => s.coverUrl)
  const radioDelay = usePlayerStore((s) => s.radioDelay)
  const radioPauseStartedAt = usePlayerStore((s) => s.radioPauseStartedAt)
  const maxDelay = audioEngine.maxRadioDelay
  const displayDelay = useDisplayedRadioDelay(radioDelay, radioPauseStartedAt, maxDelay)

  useEffect(() => {
    // Solo ficha Now Playing; play/pause remoto están stripped (no-op).
    void bindMediaSession(tracks)
  }, [currentTrackId, currentRadioId, currentPodcastEpisodeId])

  useEffect(() => {
    const onResume = () => {
      resumeAfterInterruption()
    }
    const onVis = () => {
      if (document.visibilityState === 'visible') onResume()
    }
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('pageshow', onResume)
    window.addEventListener('focus', onResume)
    document.addEventListener('resume', onResume as EventListener)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('pageshow', onResume)
      window.removeEventListener('focus', onResume)
      document.removeEventListener('resume', onResume as EventListener)
    }
  }, [currentTrackId, currentRadioId, currentPodcastEpisodeId, isPlaying])

  // Si queda un sheet/overlay colgado, quitarlo al sintonizar radio
  useEffect(() => {
    if (!currentRadioId) return
    document.body.classList.remove('sheet-open')
  }, [currentRadioId])

  if (!track && !radio && !podcastEp) return null

  const isLive = Boolean(radio)

  /* Radio: barra compacta — tocar info abre vista grande */
  if (isLive && radio) {
    return (
      <div className="player-bar player-bar--radio" role="region" aria-label="Radio en directo">
        <div className="player-bar__radio-row">
          <button
            type="button"
            className="player-bar__radio-info player-bar__radio-info--btn"
            onClick={() => setNowPlayingOpen(true)}
            aria-label="Abrir radio a pantalla completa"
          >
            {radio.logoUrl ? (
              <img
                className="player-bar__radio-logo"
                src={radio.logoUrl}
                alt=""
                referrerPolicy="no-referrer"
              />
            ) : (
              <span className="player-bar__radio-logo player-bar__radio-logo--empty" />
            )}
            <div className="player-bar__meta">
              <span className="player-bar__title">{radio.name}</span>
              <span className="player-bar__artist">
                {radioPauseStartedAt != null
                  ? 'Sincronizando con la tele…'
                  : displayDelay > 0
                    ? `Retraso ${formatRadioDelay(displayDelay)}`
                    : radio.tagline || 'En directo'}
              </span>
            </div>
          </button>
          <button
            type="button"
            className="player-bar__play"
            aria-label={isPlaying ? 'Pausar' : 'Reproducir'}
            onClick={() => void toggle()}
          >
            {isPlaying ? <IconPause size={18} /> : <IconPlay size={18} />}
          </button>
        </div>
        <button
          type="button"
          className="player-bar__seek player-bar__seek--radio-open"
          title="Abrir controles de radio"
          onClick={() => setNowPlayingOpen(true)}
        >
          <span className="player-bar__time" aria-live="polite">
            {formatRadioDelay(displayDelay)}
          </span>
          <span className="player-bar__seek-hint">Toca para ampliar · sync tele</span>
          <span className="player-bar__time">{formatRadioDelay(maxDelay)}</span>
        </button>
      </div>
    )
  }

  return (
    <div
      className={`player-bar ${podcastEp ? 'player-bar--podcast' : ''}`}
      role="region"
      aria-label="Reproductor"
    >
      {/* Izquierda: ahora suena */}
      <div className="player-bar__left">
        <button
          type="button"
          className="player-bar__main"
          onClick={() => setNowPlayingOpen(true)}
          aria-label="Abrir ahora suena"
        >
          {podcastEp ? (
            podcastEp.artworkUrl || podcastShow?.artworkUrl || coverUrl ? (
              <img
                className="player-bar__cover-img"
                src={podcastEp.artworkUrl || podcastShow?.artworkUrl || coverUrl || ''}
                alt=""
                referrerPolicy="no-referrer"
                width={56}
                height={56}
              />
            ) : (
              <span className="player-bar__cover-fallback" aria-hidden>
                <IconPodcast size={24} />
              </span>
            )
          ) : (
            <CoverArt
              trackId={track!.id}
              hasCover={track!.hasCover}
              refreshKey={`${track!.artist}|${track!.album}|${track!.externalUrl ?? ''}`}
              size={56}
              rounded="sm"
            />
          )}
          <div className="player-bar__meta">
            <span className="player-bar__title">
              {podcastEp ? podcastEp.title : track!.title}
            </span>
            <span className="player-bar__artist">
              {podcastEp
                ? podcastShow?.name || podcastShow?.artist || 'Podcast'
                : track!.artist}
            </span>
          </div>
        </button>
        {track ? (
          <button
            type="button"
            className={`icon-btn player-bar__like ${track.liked ? 'is-liked' : ''}`}
            aria-label="Me gusta"
            onClick={() => void toggleLike(track.id)}
          >
            <IconHeart size={18} filled={track.liked} />
          </button>
        ) : null}
      </div>

      {/* Centro: controles + progreso */}
      <div className="player-bar__center">
        <div className="player-bar__controls">
          {podcastEp ? (
            <button
              type="button"
              className="icon-btn player-bar__ctrl"
              aria-label="Retroceder 15 segundos"
              onClick={() => skipBack(15)}
            >
              <IconSkipBack15 size={18} />
            </button>
          ) : (
            <button
              type="button"
              className={`icon-btn player-bar__ctrl ${shuffle ? 'is-on' : ''}`}
              aria-label={shuffle ? 'Desactivar orden aleatorio' : 'Activar orden aleatorio'}
              aria-pressed={shuffle}
              title={shuffle ? 'Aleatorio: sí' : 'Aleatorio: no'}
              onClick={() => toggleShuffle()}
            >
              <IconShuffle size={16} />
            </button>
          )}
          <button
            type="button"
            className="icon-btn player-bar__skip"
            aria-label="Anterior"
            onClick={() => void previous()}
          >
            <IconSkipBack size={20} />
          </button>
          <button
            type="button"
            className="player-bar__play"
            aria-label={isPlaying ? 'Pausar' : 'Reproducir'}
            onClick={() => void toggle()}
          >
            {isPlaying ? <IconPause size={18} /> : <IconPlay size={18} />}
          </button>
          <button
            type="button"
            className="icon-btn player-bar__skip"
            aria-label="Siguiente"
            onClick={() => void next()}
          >
            <IconSkipForward size={20} />
          </button>
          {podcastEp ? (
            <button
              type="button"
              className="icon-btn player-bar__ctrl"
              aria-label="Avanzar 15 segundos"
              onClick={() => skipForward(15)}
            >
              <IconSkipForward15 size={18} />
            </button>
          ) : (
            <button
              type="button"
              className={`icon-btn player-bar__ctrl ${repeat !== 'off' ? 'is-on' : ''}`}
              aria-label="Repetir"
              onClick={() => cycleRepeat()}
            >
              <IconRepeat size={16} />
            </button>
          )}
        </div>

        <div className="player-bar__seek">
          <span className="player-bar__time">{formatTime(position)}</span>
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.1}
            value={Math.min(position, duration || 0)}
            onChange={(e) => seek(Number(e.target.value))}
            aria-label="Progreso"
            style={seekProgressStyle(position, duration || 0)}
          />
          <span className="player-bar__time">{formatTime(duration)}</span>
        </div>
      </div>

      {/* Derecha: cola */}
      <div className="player-bar__right">
        {!podcastEp ? (
          <button
            type="button"
            className="icon-btn player-bar__queue"
            aria-label="Cola"
            onClick={() => setQueueOpen(true)}
          >
            <IconQueue size={18} />
          </button>
        ) : null}
      </div>
    </div>
  )
}

export function NowPlaying() {
  const navigate = useNavigate()
  const tracks = useLibraryStore((s) => s.tracks)
  const playlists = useLibraryStore((s) => s.playlists)
  const toggleLike = useLibraryStore((s) => s.toggleLike)
  const open = usePlayerStore((s) => s.nowPlayingOpen)
  const setOpen = usePlayerStore((s) => s.setNowPlayingOpen)
  const currentTrackId = usePlayerStore((s) => s.currentTrackId)
  const currentRadioId = usePlayerStore((s) => s.currentRadioId)
  const currentPodcastEpisodeId = usePlayerStore((s) => s.currentPodcastEpisodeId)
  const playbackSource = usePlayerStore((s) => s.playbackSource)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const position = usePlayerStore((s) => s.position)
  const duration = usePlayerStore((s) => s.duration)
  const shuffle = usePlayerStore((s) => s.shuffle)
  const repeat = usePlayerStore((s) => s.repeat)
  const toggle = usePlayerStore((s) => s.toggle)
  const next = usePlayerStore((s) => s.next)
  const previous = usePlayerStore((s) => s.previous)
  const seek = usePlayerStore((s) => s.seek)
  const skipForward = usePlayerStore((s) => s.skipForward)
  const skipBack = usePlayerStore((s) => s.skipBack)
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle)
  const cycleRepeat = usePlayerStore((s) => s.cycleRepeat)
  const setQueueOpen = usePlayerStore((s) => s.setQueueOpen)
  const radioDelay = usePlayerStore((s) => s.radioDelay)
  const radioPauseStartedAt = usePlayerStore((s) => s.radioPauseStartedAt)
  const setRadioDelay = usePlayerStore((s) => s.setRadioDelay)
  const coverUrl = usePlayerStore((s) => s.coverUrl)
  const track = tracks.find((t) => t.id === currentTrackId)
  const radio = currentRadioId ? getRadioStation(currentRadioId) : null
  const podcastEp = currentPodcastEpisodeId ? getPodcastEpisode(currentPodcastEpisodeId) : null
  const podcastShow = podcastEp ? getPodcastShow(podcastEp.showId) : null
  const maxDelay = audioEngine.maxRadioDelay
  const displayDelay = useDisplayedRadioDelay(radioDelay, radioPauseStartedAt, maxDelay)
  const seekRef = useRef<HTMLInputElement>(null)

  const sourceTitle =
    playbackSource?.kind === 'playlist'
      ? playlists.find((p) => p.id === playbackSource.id)?.name || playbackSource.title
      : playbackSource?.kind === 'liked'
        ? playbackSource.title
        : null

  const goToSource = () => {
    if (!playbackSource) return
    setOpen(false)
    if (playbackSource.kind === 'liked') navigate('/liked')
    else navigate(`/playlist/${playbackSource.id}`)
  }

  if (!open) return null
  if (!track && !radio && !podcastEp) return null

  if (radio) {
    return (
      <div className="now-playing now-playing--radio">
        <header className="now-playing__header">
          <button className="icon-btn" aria-label="Cerrar" onClick={() => setOpen(false)}>
            <IconChevronDown size={28} />
          </button>
          <div>
            <p className="now-playing__eyebrow">En directo</p>
            <p className="now-playing__album">{radio.tagline || 'Radio'}</p>
          </div>
          <span aria-hidden className="now-playing__header-spacer" />
        </header>

        <div className="now-playing__art-wrap">
          {radio.logoUrl ? (
            <img
              className={`now-playing__art now-playing__radio-art ${isPlaying ? 'is-live' : ''}`}
              src={radio.logoUrl}
              alt=""
              referrerPolicy="no-referrer"
            />
          ) : (
            <div className={`now-playing__art now-playing__radio-art now-playing__radio-art--empty ${isPlaying ? 'is-live' : ''}`}>
              <IconRadio size={72} />
            </div>
          )}
        </div>

        <div className="now-playing__info">
          <div>
            <h1>{radio.name}</h1>
            <p>
              {radioPauseStartedAt != null
                ? 'Sincronizando con la tele…'
                : radio.tagline || 'Emisora en directo'}
            </p>
          </div>
        </div>

        <div className="seek-block seek-block--radio">
          <label className="now-playing__delay-label" htmlFor="np-radio-delay">
            Retraso para la tele
          </label>
          <input
            id="np-radio-delay"
            type="range"
            min={0}
            max={maxDelay}
            step={0.001}
            value={displayDelay}
            readOnly
            tabIndex={-1}
            aria-valuetext={formatRadioDelay(displayDelay)}
            aria-label="Retraso actual en segundos y milisegundos"
          />
          <div className="seek-times">
            <span>{formatRadioDelay(displayDelay)}</span>
            <span>{formatRadioDelay(maxDelay)}</span>
          </div>
          {displayDelay > 0 || radioPauseStartedAt != null ? (
            <button
              type="button"
              className="now-playing__radio-reset"
              onClick={() => setRadioDelay(0)}
            >
              Sin retraso
            </button>
          ) : null}
        </div>

        <div className="transport">
          <span className="transport__spacer" aria-hidden />
          <button type="button" className="icon-btn" aria-label="Anterior" onClick={() => void previous()}>
            <IconSkipBack size={28} />
          </button>
          <button
            type="button"
            className="transport__play"
            aria-label={isPlaying ? 'Pausar' : 'Reproducir'}
            onClick={() => void toggle()}
          >
            {isPlaying ? <IconPause size={32} /> : <IconPlay size={32} />}
          </button>
          <button type="button" className="icon-btn" aria-label="Siguiente" onClick={() => void next()}>
            <IconSkipForward size={28} />
          </button>
          <span className="transport__spacer" aria-hidden />
        </div>

        <p className="now-playing__radio-hint">
          {radioPauseStartedAt != null
            ? 'Cuando cuadre con la tele, pulsa play. Puedes repetir para afinar.'
            : 'Pulsa pausa, espera a la tele y play. Repite para sumar más retraso.'}
        </p>
      </div>
    )
  }

  if (podcastEp) {
    const art = podcastEp.artworkUrl || podcastShow?.artworkUrl || coverUrl || ''
    return (
      <div className="now-playing now-playing--podcast">
        <header className="now-playing__header">
          <button className="icon-btn" aria-label="Cerrar" onClick={() => setOpen(false)}>
            <IconChevronDown size={28} />
          </button>
          <div>
            <p className="now-playing__eyebrow">Podcast</p>
            <p className="now-playing__album">{podcastShow?.name || 'Episodio'}</p>
          </div>
          <span aria-hidden className="now-playing__header-spacer" />
        </header>

        <div className="now-playing__art-wrap">
          {art ? (
            <img
              className={`now-playing__art now-playing__podcast-art ${isPlaying ? 'is-live' : ''}`}
              src={art}
              alt=""
              referrerPolicy="no-referrer"
            />
          ) : (
            <span className="now-playing__art now-playing__podcast-art now-playing__podcast-art--empty">
              <IconPodcast size={72} />
            </span>
          )}
        </div>

        <div className="now-playing__info">
          <div>
            <h1>{podcastEp.title}</h1>
            <p>{podcastShow?.artist || podcastShow?.name || 'Podcast'}</p>
          </div>
        </div>

        <div className="seek-block">
          <input
            ref={seekRef}
            type="range"
            min={0}
            max={duration || 0}
            step={0.1}
            value={Math.min(position, duration || 0)}
            onChange={(e) => seek(Number(e.target.value))}
            aria-label="Progreso"
            style={seekProgressStyle(position, duration || 0)}
          />
          <div className="seek-times">
            <span>{formatTime(position)}</span>
            <span>{formatTime(duration)}</span>
          </div>
        </div>

        <div className="transport">
          <button
            type="button"
            className="icon-btn"
            aria-label="Retroceder 15 segundos"
            onClick={() => skipBack(15)}
          >
            <IconSkipBack15 size={24} />
          </button>
          <button type="button" className="icon-btn" aria-label="Anterior" onClick={() => void previous()}>
            <IconSkipBack size={28} />
          </button>
          <button
            type="button"
            className="transport__play"
            aria-label={isPlaying ? 'Pausar' : 'Reproducir'}
            onClick={() => void toggle()}
          >
            {isPlaying ? <IconPause size={32} /> : <IconPlay size={32} />}
          </button>
          <button type="button" className="icon-btn" aria-label="Siguiente" onClick={() => void next()}>
            <IconSkipForward size={28} />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Avanzar 15 segundos"
            onClick={() => skipForward(15)}
          >
            <IconSkipForward15 size={24} />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="now-playing">
      <header className="now-playing__header">
        <button className="icon-btn" aria-label="Cerrar" onClick={() => setOpen(false)}>
          <IconChevronDown size={28} />
        </button>
        {sourceTitle && playbackSource ? (
          <button
            type="button"
            className="now-playing__source"
            onClick={goToSource}
            aria-label={`Volver a ${sourceTitle}`}
          >
            <p className="now-playing__eyebrow">Escuchando de</p>
            <p className="now-playing__source-title">{sourceTitle}</p>
          </button>
        ) : (
          <div>
            <p className="now-playing__eyebrow">Reproduciendo</p>
            <p className="now-playing__album">{track!.album}</p>
          </div>
        )}
        <span aria-hidden className="now-playing__header-spacer" />
      </header>

      <div className="now-playing__art-wrap">
        <CoverArt
          trackId={track!.id}
          hasCover={track!.hasCover}
          size="min(72vw, 340px)"
          rounded="lg"
          className={`now-playing__art ${isPlaying ? 'is-spinning' : ''}`}
        />
      </div>

      <div className="now-playing__info">
        <div>
          <h1>{track!.title}</h1>
          <p>{track!.artist}</p>
        </div>
        <button
          className={`icon-btn like-btn ${track!.liked ? 'is-liked' : ''}`}
          onClick={() => void toggleLike(track!.id)}
          aria-label="Me gusta"
        >
          <IconHeart size={26} filled={track!.liked} />
        </button>
      </div>

      <div className="seek-block">
        <input
          ref={seekRef}
          type="range"
          min={0}
          max={duration || 0}
          step={0.1}
          value={Math.min(position, duration || 0)}
          onChange={(e) => seek(Number(e.target.value))}
          aria-label="Progreso"
          style={seekProgressStyle(position, duration || 0)}
        />
        <div className="seek-times">
          <span>{formatTime(position)}</span>
          <span>{formatTime(duration)}</span>
        </div>
      </div>

      <div className="transport">
        <button
          type="button"
          className={`icon-btn ${shuffle ? 'is-on' : ''}`}
          aria-label={shuffle ? 'Desactivar orden aleatorio' : 'Activar orden aleatorio'}
          aria-pressed={shuffle}
          title={shuffle ? 'Aleatorio: sí' : 'Aleatorio: no'}
          onClick={() => toggleShuffle()}
        >
          <IconShuffle size={22} />
        </button>
        <button type="button" className="icon-btn" aria-label="Anterior" onClick={() => void previous()}>
          <IconSkipBack size={28} />
        </button>
        <button
          type="button"
          className="transport__play"
          aria-label={isPlaying ? 'Pausar' : 'Reproducir'}
          onClick={() => void toggle()}
        >
          {isPlaying ? <IconPause size={32} /> : <IconPlay size={32} />}
        </button>
        <button type="button" className="icon-btn" aria-label="Siguiente" onClick={() => void next()}>
          <IconSkipForward size={28} />
        </button>
        <button
          type="button"
          className={`icon-btn ${repeat !== 'off' ? 'is-on' : ''}`}
          aria-label="Repetir"
          onClick={() => cycleRepeat()}
        >
          <IconRepeat size={22} />
        </button>
      </div>

      <div className="now-playing__footer">
        <button type="button" className="icon-btn" aria-label="Cola" onClick={() => setQueueOpen(true)}>
          <IconQueue size={22} />
        </button>
      </div>
    </div>
  )
}

export function QueueSheet() {
  const open = usePlayerStore((s) => s.queueOpen)
  const setOpen = usePlayerStore((s) => s.setQueueOpen)
  const queue = usePlayerStore((s) => s.queue)
  const removeFromQueue = usePlayerStore((s) => s.removeFromQueue)
  const playTracks = usePlayerStore((s) => s.playTracks)
  const tracks = useLibraryStore((s) => s.tracks)
  const currentTrackId = usePlayerStore((s) => s.currentTrackId)

  if (!open) return null

  return (
    <div className="sheet">
      <button type="button" className="sheet-backdrop" onClick={() => setOpen(false)} />
      <div className="sheet__panel queue-sheet">
        <div className="queue-sheet__head">
          <h3>Cola</h3>
          <button type="button" className="icon-btn" aria-label="Cerrar" onClick={() => setOpen(false)}>
            <IconClose size={22} />
          </button>
        </div>
        {queue.length === 0 ? (
          <p className="empty-state__hint">La cola está vacía</p>
        ) : (
          <ul className="queue-list">
            {queue.map((id, i) => {
              const t = tracks.find((x) => x.id === id)
              if (!t) return null
              return (
                <li key={`${id}-${i}`} className={id === currentTrackId ? 'is-active' : ''}>
                  <button
                    type="button"
                    className="queue-list__main"
                    onClick={() => void playTracks(queue, id)}
                  >
                    <CoverArt trackId={t.id} hasCover={t.hasCover} size={40} />
                    <div>
                      <strong>{t.title}</strong>
                      <span>{t.artist}</span>
                    </div>
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label="Quitar de la cola"
                    onClick={() => removeFromQueue(i)}
                  >
                    <IconClose size={18} />
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
