import { createPortal } from 'react-dom'
import { getRadioStation } from '../lib/myRadios'
import { getPodcastEpisode, getPodcastShow } from '../lib/podcasts'
import { useLibraryStore } from '../store/libraryStore'
import { useLibraryPlayerStore } from '../store/libraryPlayerStore'
import { usePlayerStore } from '../store/playerStore'
import './PlayingIsland.css'

export function PlayingIsland() {
  const tracks = useLibraryStore((s) => s.tracks)

  const libTrackId = useLibraryPlayerStore((s) => s.currentTrackId)
  const libPlaying = useLibraryPlayerStore((s) => s.isPlaying)
  const libCoverUrl = useLibraryPlayerStore((s) => s.coverUrl)
  const libNowOpen = useLibraryPlayerStore((s) => s.nowPlayingOpen)
  const libOpen = useLibraryPlayerStore((s) => s.setNowPlayingOpen)

  const radioId = usePlayerStore((s) => s.currentRadioId)
  const podcastId = usePlayerStore((s) => s.currentPodcastEpisodeId)
  const rpPlaying = usePlayerStore((s) => s.isPlaying)
  const rpCoverUrl = usePlayerStore((s) => s.coverUrl)
  const rpNowOpen = usePlayerStore((s) => s.nowPlayingOpen)
  const rpOpen = usePlayerStore((s) => s.setNowPlayingOpen)

  const isLibrary = Boolean(libTrackId)
  const track = libTrackId ? tracks.find((t) => t.id === libTrackId) : null
  const radio = radioId ? getRadioStation(radioId) : null
  const podcastEp = podcastId ? getPodcastEpisode(podcastId) : null
  const podcastShow = podcastEp ? getPodcastShow(podcastEp.showId) : null

  const active = Boolean(libTrackId || radio || podcastEp)
  const isPlaying = isLibrary ? libPlaying : rpPlaying
  const coverUrl = isLibrary ? libCoverUrl : rpCoverUrl
  const nowOpen = isLibrary ? libNowOpen : rpNowOpen
  const openNowPlaying = isLibrary ? libOpen : rpOpen

  if (!active || nowOpen) return null

  const title =
    track?.title ||
    radio?.name ||
    podcastEp?.title ||
    podcastShow?.name ||
    'Reproduciendo'

  return createPortal(
    <button
      type="button"
      className={`playing-island ${isPlaying ? 'is-playing' : 'is-paused'}`}
      onClick={() => openNowPlaying(true)}
      aria-label={`Ahora suena: ${title}. Abrir reproductor`}
    >
      {coverUrl ? (
        <img className="playing-island__cover" src={coverUrl} alt="" draggable={false} />
      ) : (
        <span className="playing-island__cover playing-island__cover--empty" aria-hidden />
      )}
      <span className="playing-island__bars" aria-hidden>
        <i />
        <i />
        <i />
        <i />
        <i />
      </span>
    </button>,
    document.body,
  )
}
