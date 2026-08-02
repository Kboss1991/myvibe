import { PlaylistView } from '../components/PlaylistView'
import { useLibraryStore } from '../store/libraryStore'

export function LikedPage() {
  const getLiked = useLibraryStore((s) => s.getLiked)
  const shareLiked = useLibraryStore((s) => s.shareLiked)
  const toggleLike = useLibraryStore((s) => s.toggleLike)
  const liked = getLiked()

  return (
    <div className="page playlist-page" style={{ paddingTop: 0, paddingLeft: 0, paddingRight: 0 }}>
      <PlaylistView
        title="Canciones que te gustan"
        tracks={liked}
        likedStyle
        coverTrackId={liked[0]?.id}
        hasCover={liked[0]?.hasCover}
        onRemoveTrack={async (trackId) => {
          const track = liked.find((t) => t.id === trackId)
          if (track?.liked) await toggleLike(trackId)
        }}
        onShare={async () => {
          const mode = await shareLiked()
          if (mode === 'downloaded') {
            alert(
              'Archivo .myvibe descargado. Envíaselo a quien tenga MyVibe; podrá importarlo en Subir.',
            )
          }
        }}
      />
    </div>
  )
}
