import { useEffect, useRef, useState } from 'react'
import { audioEngine } from '../lib/audioEngine'
import { formatTime } from '../lib/mediaSession'
import { useLibraryStore } from '../store/libraryStore'
import { bindMediaSession, usePlayerStore } from '../store/playerStore'
import { BluetoothSheet } from './BluetoothSheet'
import { CoverArt } from './CoverArt'
import {
  IconBluetooth,
  IconCar,
  IconHeart,
  IconPause,
  IconPlay,
  IconQueue,
  IconRepeat,
  IconRepeatOne,
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
  const coverUrl = usePlayerStore((s) => s.coverUrl)
  const [btOpen, setBtOpen] = useState(false)

  // Metadatos + carátula grande en pantalla de bloqueo (no en cada play/pause)
  useEffect(() => {
    void bindMediaSession(tracks)
  }, [tracks, currentTrackId, coverUrl])

  // Mantener sesión de audio al bloquear / cambiar de app
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        audioEngine.applyPlaybackSession()
        void bindMediaSession(tracks)
      } else {
        // Al bloquear, reafirma artwork por si iOS lo había sustituido por el icono
        void bindMediaSession(tracks)
      }
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [tracks, currentTrackId, coverUrl])

  if (!track) return null

  return (
    <div className="player-bar" role="region" aria-label="Reproductor">
      <div className="player-bar__row">
        <button
          type="button"
          className="player-bar__main"
          onClick={() => setNowPlayingOpen(true)}
          aria-label="Abrir ahora suena"
        >
          <CoverArt
            trackId={track.id}
            hasCover={track.hasCover}
            refreshKey={`${track.artist}|${track.album}|${track.externalUrl ?? ''}`}
            size={48}
            rounded="sm"
          />
          <div className="player-bar__meta">
            <span className="player-bar__title">{track.title}</span>
            <span className="player-bar__artist">{track.artist}</span>
          </div>
        </button>
        <div className="player-bar__actions">
          <button
            type="button"
            className="icon-btn"
            aria-label="Altavoz Bluetooth"
            title="Conectar altavoz"
            onClick={() => setBtOpen(true)}
          >
            <IconBluetooth size={20} />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Cola"
            onClick={() => setQueueOpen(true)}
          >
            <IconQueue size={20} />
          </button>
          <button
            type="button"
            className="icon-btn player-bar__skip"
            aria-label="Anterior"
            onClick={() => void previous()}
          >
            <IconSkipBack size={22} />
          </button>
          <button
            type="button"
            className="player-bar__play"
            aria-label={isPlaying ? 'Pausar' : 'Reproducir'}
            onClick={() => void toggle()}
          >
            {isPlaying ? <IconPause size={20} /> : <IconPlay size={20} />}
          </button>
          <button
            type="button"
            className="icon-btn player-bar__skip"
            aria-label="Siguiente"
            onClick={() => void next()}
          >
            <IconSkipForward size={22} />
          </button>
        </div>
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
        />
        <span className="player-bar__time">{formatTime(duration)}</span>
      </div>
      <BluetoothSheet open={btOpen} onClose={() => setBtOpen(false)} />
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
  const setCarMode = usePlayerStore((s) => s.setCarMode)
  const track = tracks.find((t) => t.id === currentTrackId)
  const seekRef = useRef<HTMLInputElement>(null)
  const [btOpen, setBtOpen] = useState(false)

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
        <div className="now-playing__header-actions">
          <button
            className="icon-btn"
            aria-label="Altavoz Bluetooth"
            title="Conectar altavoz"
            onClick={() => setBtOpen(true)}
          >
            <IconBluetooth size={24} />
          </button>
          <button className="icon-btn" aria-label="Modo coche" onClick={() => setCarMode(true)}>
            <IconCar size={24} />
          </button>
        </div>
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
          {repeat === 'one' ? <IconRepeatOne size={22} /> : <IconRepeat size={22} />}
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
      <BluetoothSheet open={btOpen} onClose={() => setBtOpen(false)} />
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
