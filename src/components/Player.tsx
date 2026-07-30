import { useEffect, useRef } from 'react'
import { audioEngine } from '../lib/audioEngine'
import { formatTime } from '../lib/mediaSession'
import { useLibraryStore } from '../store/libraryStore'
import { bindMediaSession, usePlayerStore } from '../store/playerStore'
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
  IconVolume,
  IconClose,
} from './Icons'
import './Player.css'

export function PlayerBar() {
  const tracks = useLibraryStore((s) => s.tracks)
  const currentTrackId = usePlayerStore((s) => s.currentTrackId)
  const currentRadioId = usePlayerStore((s) => s.currentRadioId)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const position = usePlayerStore((s) => s.position)
  const duration = usePlayerStore((s) => s.duration)
  const toggle = usePlayerStore((s) => s.toggle)
  const seek = usePlayerStore((s) => s.seek)
  const next = usePlayerStore((s) => s.next)
  const previous = usePlayerStore((s) => s.previous)
  const setNowPlayingOpen = usePlayerStore((s) => s.setNowPlayingOpen)
  const setQueueOpen = usePlayerStore((s) => s.setQueueOpen)
  const track = tracks.find((t) => t.id === currentTrackId)
  const radio = usePlayerStore((s) => s.getCurrentRadio())
  const coverUrl = usePlayerStore((s) => s.coverUrl)
  const radioDelay = usePlayerStore((s) => s.radioDelay)
  const setRadioDelay = usePlayerStore((s) => s.setRadioDelay)

  useEffect(() => {
    void bindMediaSession(tracks)
  }, [tracks, currentTrackId, currentRadioId, coverUrl])

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        void audioEngine.ensureAudible()
        void bindMediaSession(tracks)
        const st = usePlayerStore.getState()
        if (st.isPlaying && audioEngine.paused) {
          void st.play()
        }
      } else {
        void bindMediaSession(tracks)
      }
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [tracks, currentTrackId, currentRadioId, coverUrl])

  if (!track && !radio) return null

  const isLive = Boolean(radio)

  return (
    <div className="player-bar" role="region" aria-label="Reproductor">
      <div className="player-bar__row">
        <button
          type="button"
          className="player-bar__main"
          onClick={() => (isLive ? undefined : setNowPlayingOpen(true))}
          aria-label={isLive ? radio!.name : 'Abrir ahora suena'}
        >
          {radio ? (
            <img className="player-bar__radio-logo" src={radio.logoUrl} alt="" referrerPolicy="no-referrer" />
          ) : (
            <CoverArt
              trackId={track!.id}
              hasCover={track!.hasCover}
              refreshKey={`${track!.artist}|${track!.album}|${track!.externalUrl ?? ''}|${track!.coverUpdatedAt ?? 0}`}
              size={48}
              rounded="sm"
            />
          )}
          <div className="player-bar__meta">
            <span className="player-bar__title">{radio ? radio.name : track!.title}</span>
            <span className="player-bar__artist">
              {radio ? radio.tagline : track!.artist}
            </span>
          </div>
        </button>
        <div className="player-bar__actions">
          {!isLive && (
            <button
              type="button"
              className="icon-btn player-bar__queue"
              aria-label="Cola"
              onClick={() => setQueueOpen(true)}
            >
              <IconQueue size={22} />
            </button>
          )}
          <button
            type="button"
            className="icon-btn player-bar__skip"
            aria-label="Anterior"
            onClick={() => void previous()}
          >
            <IconSkipBack size={26} />
          </button>
          <button
            type="button"
            className="player-bar__play"
            aria-label={isPlaying ? 'Pausar' : 'Reproducir'}
            onClick={() => void toggle()}
          >
            {isPlaying ? <IconPause size={22} /> : <IconPlay size={22} />}
          </button>
          <button
            type="button"
            className="icon-btn player-bar__skip"
            aria-label="Siguiente"
            onClick={() => void next()}
          >
            <IconSkipForward size={26} />
          </button>
        </div>
      </div>
      {isLive ? (
        <div className="player-bar__seek player-bar__seek--live">
          <span className="player-bar__live">EN DIRECTO</span>
          <div className="player-bar__delay" title="Retraso para sincronizar con la tele">
            <button
              type="button"
              className="player-bar__delay-btn"
              aria-label="Menos retraso"
              disabled={radioDelay <= 0}
              onClick={() => setRadioDelay(Math.round((radioDelay - 0.5) * 2) / 2)}
            >
              −
            </button>
            <span className="player-bar__delay-val">
              {radioDelay <= 0
                ? 'Sync TV'
                : `${radioDelay.toLocaleString('es-ES', { maximumFractionDigits: 1 })} s`}
            </span>
            <button
              type="button"
              className="player-bar__delay-btn"
              aria-label="Más retraso"
              disabled={radioDelay >= audioEngine.maxRadioDelay}
              onClick={() => setRadioDelay(Math.round((radioDelay + 0.5) * 2) / 2)}
            >
              +
            </button>
          </div>
        </div>
      ) : (
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
          />
          <span className="player-bar__time">{formatTime(duration)}</span>
        </div>
      )}
    </div>
  )
}

export function NowPlaying() {
  const tracks = useLibraryStore((s) => s.tracks)
  const toggleLike = useLibraryStore((s) => s.toggleLike)
  const open = usePlayerStore((s) => s.nowPlayingOpen)
  const setOpen = usePlayerStore((s) => s.setNowPlayingOpen)
  const currentTrackId = usePlayerStore((s) => s.currentTrackId)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const position = usePlayerStore((s) => s.position)
  const duration = usePlayerStore((s) => s.duration)
  const shuffle = usePlayerStore((s) => s.shuffle)
  const repeat = usePlayerStore((s) => s.repeat)
  const volume = usePlayerStore((s) => s.volume)
  const muted = usePlayerStore((s) => s.muted)
  const toggle = usePlayerStore((s) => s.toggle)
  const next = usePlayerStore((s) => s.next)
  const previous = usePlayerStore((s) => s.previous)
  const seek = usePlayerStore((s) => s.seek)
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle)
  const cycleRepeat = usePlayerStore((s) => s.cycleRepeat)
  const setVolume = usePlayerStore((s) => s.setVolume)
  const setQueueOpen = usePlayerStore((s) => s.setQueueOpen)
  const track = tracks.find((t) => t.id === currentTrackId)
  const seekRef = useRef<HTMLInputElement>(null)

  if (!open || !track) return null

  return (
    <div className="now-playing">
      <header className="now-playing__header">
        <button className="icon-btn" aria-label="Cerrar" onClick={() => setOpen(false)}>
          <IconChevronDown size={28} />
        </button>
        <div>
          <p className="now-playing__eyebrow">Reproduciendo</p>
          <p className="now-playing__album">{track.album}</p>
        </div>
        <span aria-hidden className="now-playing__header-spacer" />
      </header>

      <div className="now-playing__art-wrap">
        <CoverArt
          trackId={track.id}
          hasCover={track.hasCover}
          size="min(72vw, 340px)"
          rounded="lg"
          className={`now-playing__art ${isPlaying ? 'is-spinning' : ''}`}
        />
      </div>

      <div className="now-playing__info">
        <div>
          <h1>{track.title}</h1>
          <p>{track.artist}</p>
        </div>
        <button
          className={`icon-btn like-btn ${track.liked ? 'is-liked' : ''}`}
          onClick={() => void toggleLike(track.id)}
          aria-label="Me gusta"
        >
          <IconHeart size={26} filled={track.liked} />
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
        />
        <div className="seek-times">
          <span>{formatTime(position)}</span>
          <span>{formatTime(duration)}</span>
        </div>
      </div>

      <div className="transport">
        <button
          className={`icon-btn ${shuffle ? 'is-on' : ''}`}
          aria-label="Aleatorio"
          onClick={toggleShuffle}
        >
          <IconShuffle size={22} />
        </button>
        <button className="icon-btn" aria-label="Anterior" onClick={() => void previous()}>
          <IconSkipBack size={28} />
        </button>
        <button
          className="transport__play"
          aria-label={isPlaying ? 'Pausar' : 'Reproducir'}
          onClick={() => void toggle()}
        >
          {isPlaying ? <IconPause size={32} /> : <IconPlay size={32} />}
        </button>
        <button className="icon-btn" aria-label="Siguiente" onClick={() => void next()}>
          <IconSkipForward size={28} />
        </button>
        <button
          className={`icon-btn ${repeat !== 'off' ? 'is-on' : ''}`}
          aria-label="Repetir"
          onClick={cycleRepeat}
        >
          <IconRepeat size={22} />
        </button>
      </div>

      <div className="volume-row">
        <IconVolume size={18} />
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={muted ? 0 : volume}
          onChange={(e) => setVolume(Number(e.target.value))}
          aria-label="Volumen"
        />
        <button className="icon-btn" aria-label="Cola" onClick={() => setQueueOpen(true)}>
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
  const index = usePlayerStore((s) => s.index)
  const removeFromQueue = usePlayerStore((s) => s.removeFromQueue)
  const clearQueue = usePlayerStore((s) => s.clearQueue)
  const playTracks = usePlayerStore((s) => s.playTracks)
  const tracks = useLibraryStore((s) => s.tracks)
  const map = new Map(tracks.map((t) => [t.id, t]))

  if (!open) return null

  return (
    <div className="sheet">
      <button className="sheet-backdrop" onClick={() => setOpen(false)} />
      <div className="sheet__panel queue-sheet">
        <div className="queue-sheet__head">
          <h3>Cola de reproducción</h3>
          <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Cerrar">
            <IconClose size={22} />
          </button>
        </div>
        {queue.length === 0 ? (
          <p className="empty-state__hint">La cola está vacía</p>
        ) : (
          <>
            <button className="text-btn" onClick={clearQueue}>
              Vaciar cola
            </button>
            <ul className="queue-list">
              {queue.map((id, i) => {
                const t = map.get(id)
                if (!t) return null
                return (
                  <li key={`${id}-${i}`} className={i === index ? 'is-current' : ''}>
                    <button
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
                      className="icon-btn"
                      aria-label="Quitar"
                      onClick={() => removeFromQueue(i)}
                    >
                      <IconClose size={18} />
                    </button>
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}
