import { useCallback, useState } from 'react'
import {
  canDragTracksToPlaylists,
  dataTransferHasTracks,
  getTrackDragIds,
} from '../lib/trackDrag'
import { useLibraryStore } from '../store/libraryStore'

type DropTarget = 'liked' | string

/**
 * Destinos de drop para canciones → Me gusta / playlists (PC).
 * Usar en sidebar, inicio, biblioteca, buscar, etc.
 */
export function usePlaylistDropTargets() {
  const addToPlaylist = useLibraryStore((s) => s.addToPlaylist)
  const setLiked = useLibraryStore((s) => s.setLiked)
  const playlists = useLibraryStore((s) => s.playlists)
  const [dropOver, setDropOver] = useState<DropTarget | null>(null)
  const [dropHint, setDropHint] = useState<string | null>(null)
  const allowDrop = canDragTracksToPlaylists()

  const clearDrop = useCallback(() => setDropOver(null), [])

  const showHint = useCallback((msg: string) => {
    setDropHint(msg)
    window.setTimeout(() => setDropHint(null), 2500)
  }, [])

  const onDragOverTarget = useCallback(
    (e: React.DragEvent, target: DropTarget) => {
      if (!allowDrop || !dataTransferHasTracks(e.dataTransfer)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      setDropOver(target)
    },
    [allowDrop],
  )

  const onDropLiked = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      clearDrop()
      if (!allowDrop) return
      const ids = getTrackDragIds(e.dataTransfer)
      if (!ids.length) return
      await setLiked(ids, true)
      showHint(
        ids.length === 1
          ? 'Añadida a Me gusta'
          : `${ids.length} añadidas a Me gusta`,
      )
    },
    [allowDrop, clearDrop, setLiked, showHint],
  )

  const onDropPlaylist = useCallback(
    async (e: React.DragEvent, playlistId: string, name?: string) => {
      e.preventDefault()
      e.stopPropagation()
      clearDrop()
      if (!allowDrop) return
      const ids = getTrackDragIds(e.dataTransfer)
      if (!ids.length) return
      const label =
        name || playlists.find((p) => p.id === playlistId)?.name || 'playlist'
      await addToPlaylist(playlistId, ids)
      showHint(
        ids.length === 1
          ? `Añadida a “${label}”`
          : `${ids.length} añadidas a “${label}”`,
      )
    },
    [allowDrop, clearDrop, addToPlaylist, playlists, showHint],
  )

  const likedDropProps = {
    onDragOver: (e: React.DragEvent) => onDragOverTarget(e, 'liked'),
    onDragLeave: clearDrop,
    onDrop: (e: React.DragEvent) => void onDropLiked(e),
  }

  function playlistDropProps(playlistId: string, name?: string) {
    return {
      onDragOver: (e: React.DragEvent) => onDragOverTarget(e, playlistId),
      onDragLeave: clearDrop,
      onDrop: (e: React.DragEvent) => void onDropPlaylist(e, playlistId, name),
    }
  }

  return {
    allowDrop,
    dropOver,
    dropHint,
    clearDrop,
    likedDropProps,
    playlistDropProps,
  }
}
