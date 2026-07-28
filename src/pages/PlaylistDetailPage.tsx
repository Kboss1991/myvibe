import { useMemo } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { PlaylistView } from '../components/PlaylistView'
import { playlistCoverId } from '../lib/library'
import { useLibraryStore } from '../store/libraryStore'

export function PlaylistDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const playlists = useLibraryStore((s) => s.playlists)
  const tracks = useLibraryStore((s) => s.tracks)
  const updatePlaylistInfo = useLibraryStore((s) => s.updatePlaylistInfo)
  const setPlaylistCover = useLibraryStore((s) => s.setPlaylistCover)
  const deletePlaylist = useLibraryStore((s) => s.deletePlaylist)
  const addToPlaylist = useLibraryStore((s) => s.addToPlaylist)
  const removeFromPlaylist = useLibraryStore((s) => s.removeFromPlaylist)
  const sharePlaylist = useLibraryStore((s) => s.sharePlaylist)

  const playlist = playlists.find((p) => p.id === id)
  const playlistTracks = useMemo(() => {
    if (!playlist) return []
    const map = new Map(tracks.map((t) => [t.id, t]))
    return playlist.trackIds.map((tid) => map.get(tid)).filter(Boolean) as typeof tracks
  }, [playlist, tracks])

  if (!playlist) {
    return (
      <div className="page">
        <p className="empty-state__title">Playlist no encontrada</p>
        <Link to="/library">Volver</Link>
      </div>
    )
  }

  return (
    <div className="page playlist-page" style={{ paddingTop: 0, paddingLeft: 0, paddingRight: 0 }}>
      <PlaylistView
        title={playlist.name}
        description={playlist.description || ''}
        tracks={playlistTracks}
        orderedIds={playlist.trackIds}
        coverTrackId={playlist.trackIds[0]}
        hasCover={playlist.hasCover}
        coverId={playlist.hasCover ? playlistCoverId(playlist.id) : null}
        playlistId={playlist.id}
        onEditInfo={async (name, description) => {
          await updatePlaylistInfo(playlist.id, { name, description })
        }}
        onPickCover={async (file) => {
          await setPlaylistCover(playlist.id, file)
        }}
        onDelete={() => {
          if (confirm(`¿Eliminar “${playlist.name}”?`)) {
            void deletePlaylist(playlist.id)
            navigate('/library')
          }
        }}
        onAddTracks={async (trackIds) => {
          await addToPlaylist(playlist.id, trackIds)
        }}
        onRemoveTrack={async (trackId) => {
          await removeFromPlaylist(playlist.id, trackId)
        }}
        onShare={async () => {
          const mode = await sharePlaylist(playlist.id)
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
