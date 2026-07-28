import { useState } from 'react'
import { formatTime } from '../lib/mediaSession'
import { useLibraryStore } from '../store/libraryStore'
import { usePlayerStore } from '../store/playerStore'
import { AppIcon } from './AppIcon'
import { BluetoothSheet } from './BluetoothSheet'
import { CoverArt } from './CoverArt'
import {
  IconBluetooth,
  IconClose,
  IconPause,
  IconPlay,
  IconSkipBack,
  IconSkipForward,
} from './Icons'
import './CarMode.css'

export function CarMode() {
  const open = usePlayerStore((s) => s.carMode)
  const setCarMode = usePlayerStore((s) => s.setCarMode)
  const tracks = useLibraryStore((s) => s.tracks)
  const currentTrackId = usePlayerStore((s) => s.currentTrackId)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const position = usePlayerStore((s) => s.position)
  const duration = usePlayerStore((s) => s.duration)
  const toggle = usePlayerStore((s) => s.toggle)
  const next = usePlayerStore((s) => s.next)
  const previous = usePlayerStore((s) => s.previous)
  const track = tracks.find((t) => t.id === currentTrackId)
  const [btOpen, setBtOpen] = useState(false)

  if (!open) return null

  return (
    <div className="car-mode">
      <button className="car-mode__close" onClick={() => setCarMode(false)} aria-label="Salir">
        <IconClose size={28} />
      </button>

      <div className="car-mode__brand">
        <AppIcon size={48} />
        MyVibe
      </div>
      <p className="car-mode__hint">Modo conducción · conecta un altavoz Bluetooth</p>

      <button type="button" className="car-mode__bt" onClick={() => setBtOpen(true)}>
        <IconBluetooth size={20} /> Buscar dispositivos / altavoz
      </button>

      <CoverArt
        trackId={track?.id}
        hasCover={track?.hasCover}
        size="min(55vw, 260px)"
        rounded="lg"
        className="car-mode__art"
      />

      <h1 className="car-mode__title">{track?.title ?? 'Sin reproducción'}</h1>
      <p className="car-mode__artist">{track?.artist ?? 'Elige una canción'}</p>

      <div className="car-mode__progress">
        <div
          className="car-mode__progress-fill"
          style={{ width: `${duration ? (position / duration) * 100 : 0}%` }}
        />
      </div>
      <div className="car-mode__times">
        <span>{formatTime(position)}</span>
        <span>{formatTime(duration)}</span>
      </div>

      <div className="car-mode__controls">
        <button aria-label="Anterior" onClick={() => void previous()}>
          <IconSkipBack size={40} />
        </button>
        <button
          className="car-mode__play"
          aria-label={isPlaying ? 'Pausar' : 'Reproducir'}
          onClick={() => void toggle()}
        >
          {isPlaying ? <IconPause size={44} /> : <IconPlay size={44} />}
        </button>
        <button aria-label="Siguiente" onClick={() => void next()}>
          <IconSkipForward size={40} />
        </button>
      </div>

      <BluetoothSheet open={btOpen} onClose={() => setBtOpen(false)} />
    </div>
  )
}
