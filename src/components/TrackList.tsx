import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Track } from '../types'
import { isAppleMobile } from '../lib/folderImport'
import { formatTime } from '../lib/mediaSession'
import { formatAddedAt } from './TrackColumnsHead'
import { saveFilesVisibly, myVibeDownloadName, deleteVisibleCopies } from '../lib/visibleStorage'
import { useLibraryStore } from '../store/libraryStore'
import { useLibraryPlayerStore } from '../store/libraryPlayerStore'
import { CoverArt } from './CoverArt'
import { CoverCropSheet } from './CoverCropSheet'
import {
  IconHeart,
  IconMore,
  IconPlay,
  IconPlus,
  IconQueue,
  IconTrash,
  IconEdit,
  IconSearch,
  IconSelect,
  IconCheck,
  IconClose,
  IconShare,
  IconDownload,
  IconUpload,
} from './Icons'
import { getCoverBlob } from '../lib/library'
import { canDragTracksToPlaylists, resolveDragTrackIds, setTrackDragData } from '../lib/trackDrag'
import './TrackList.css'

/** Evita que el dock (reproductor) tape el menú en móvil. */
function SheetPortal({ children }: { children: ReactNode }) {
  if (typeof document === 'undefined') return null
  return createPortal(children, document.body)
}

interface Props {
  tracks: Track[]
  contextPlaylistId?: string
  emptyTitle?: string
  emptyHint?: string
  /** Mostrar botón de selección múltiple (default true) */
  selectable?: boolean
  /** Columnas: título, álbum, fecha, duración */
  showColumns?: boolean
  /** Si el encabezado Título/Tiempo va fuera (sticky) */
  hideColumnHead?: boolean
  /** Modo selección controlado por el padre */
  selectMode?: boolean
  onSelectModeChange?: (mode: boolean) => void
  /** Si false, el padre muestra el toggle (p. ej. junto al conteo) */
  showSelectToggle?: boolean
}

export function TrackList({
  tracks,
  contextPlaylistId,
  emptyTitle = 'No hay canciones',
  emptyHint = 'Sube tu música para empezar',
  selectable = true,
  showColumns = false,
  hideColumnHead = false,
  selectMode: selectModeProp,
  onSelectModeChange,
  showSelectToggle = true,
}: Props) {
  const currentTrackId = useLibraryPlayerStore((s) => s.currentTrackId)
  const isPlaying = useLibraryPlayerStore((s) => s.isPlaying)
  const playTracks = useLibraryPlayerStore((s) => s.playTracks)
  const playNext = useLibraryPlayerStore((s) => s.playNext)
  const addToQueue = useLibraryPlayerStore((s) => s.addToQueue)
  const toggleLike = useLibraryStore((s) => s.toggleLike)
  const deleteTrack = useLibraryStore((s) => s.deleteTrack)
  const deleteTracks = useLibraryStore((s) => s.deleteTracks)
  const removeFromPlaylist = useLibraryStore((s) => s.removeFromPlaylist)
  const playlists = useLibraryStore((s) => s.playlists)
  const addToPlaylist = useLibraryStore((s) => s.addToPlaylist)
  const updateTrack = useLibraryStore((s) => s.updateTrack)
  const setCover = useLibraryStore((s) => s.setCover)
  const enrichTrack = useLibraryStore((s) => s.enrichTrack)
  const enrichSelected = useLibraryStore((s) => s.enrichSelected)
  const setLiked = useLibraryStore((s) => s.setLiked)
  const enrichProgress = useLibraryStore((s) => s.enrichProgress)
  const shareTrack = useLibraryStore((s) => s.shareTrack)
  const downloadFromPc = useLibraryStore((s) => s.downloadFromPc)
  const downloadProgress = useLibraryStore((s) => s.downloadProgress)
  const pcOnline = useLibraryStore((s) => s.pcOnline)
  const replaceTrackAudio = useLibraryStore((s) => s.replaceTrackAudio)
  const replaceMissingAudio = useLibraryStore((s) => s.replaceMissingAudio)

  const [menuTrack, setMenuTrack] = useState<Track | null>(null)
  const [enrichingId, setEnrichingId] = useState<string | null>(null)
  const [deleteNotice, setDeleteNotice] = useState<{
    count: number
    fileNames: string[]
  } | null>(null)
  const [deletingVisible, setDeletingVisible] = useState(false)
  const [editTrack, setEditTrack] = useState<Track | null>(null)
  const [playlistPickIds, setPlaylistPickIds] = useState<string[] | null>(null)
  const [selectModeInternal, setSelectModeInternal] = useState(false)
  const selectMode = selectModeProp ?? selectModeInternal
  const setSelectMode = (mode: boolean) => {
    onSelectModeChange?.(mode)
    if (selectModeProp === undefined) setSelectModeInternal(mode)
  }
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const [replacingId, setReplacingId] = useState<string | null>(null)
  const replaceOneInputRef = useRef<HTMLInputElement>(null)
  const replaceBulkInputRef = useRef<HTMLInputElement>(null)
  const replaceTargetIdRef = useRef<string | null>(null)

  const selectedTracks = useMemo(
    () => tracks.filter((t) => selected.has(t.id)),
    [tracks, selected],
  )
  const selectedRemote = useMemo(
    () => selectedTracks.filter((t) => t.hasLocalAudio === false),
    [selectedTracks],
  )
  const selectedNeedsUpdate = useMemo(
    () =>
      selectedTracks.filter(
        (t) => t.needsAudioUpdate && t.hasLocalAudio !== false,
      ),
    [selectedTracks],
  )
  const allSelected = tracks.length > 0 && selected.size === tracks.length
  const desktopDrag = canDragTracksToPlaylists()

  useEffect(() => {
    if (!selectMode) setSelected(new Set())
  }, [selectMode])

  useEffect(() => {
    const open = Boolean(menuTrack || playlistPickIds || deleteNotice || editTrack)
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    document.body.classList.add('sheet-open')
    return () => {
      document.body.style.overflow = prev
      document.body.classList.remove('sheet-open')
    }
  }, [menuTrack, playlistPickIds, deleteNotice, editTrack])

  async function downloadIds(ids: string[], opts?: { quiet?: boolean }) {
    if (!ids.length) return
    setBulkBusy(true)
    try {
      const result = await downloadFromPc(ids)
      const n = result.imported
      if (n <= 0) {
        alert('No se descargó ninguna. ¿PC abierto con la misma cuenta?')
        return
      }

      if (opts?.quiet) {
        alert(
          n === 1
            ? 'Audio actualizado: se sustituyó la copia antigua.'
            : `${n} audios actualizados: se sustituyeron las copias antiguas.`,
        )
        return
      }

      // Copia visible obligatoria: PC → Descargas/MyVibe; iPhone → Archivos
      if (result.visibleFiles.length) {
        try {
          const out = await saveFilesVisibly(result.visibleFiles, { interactive: true })
          alert(`Descargadas ${n} en MyVibe.\n${out.message}`)
        } catch (e) {
          if (e instanceof DOMException && e.name === 'AbortError') {
            alert(
              `Descargadas ${n} en MyVibe (reproductor).\n` +
                (isAppleMobile()
                  ? 'No se guardó en Archivos (cancelado). Puedes exportar desde Perfil si lo necesitas.'
                  : 'No se eligió carpeta. Puedes exportar desde Perfil si lo necesitas.'),
            )
          } else {
            alert(`Descargadas ${n} en MyVibe.`)
          }
        }
      } else {
        alert(`Descargadas ${n} en MyVibe.`)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'No se pudo descargar'
      const isModule =
        /import|módulo|modulo|module script|MIME type/i.test(msg)
      alert(
        isModule
          ? 'Hay una versión nueva de la app. Cierra MyVibe del todo, vuelve a abrir y prueba otra vez.'
          : msg,
      )
      if (isModule) {
        const key = 'mv-chunk-reload'
        if (!sessionStorage.getItem(key)) {
          sessionStorage.setItem(key, '1')
          window.location.reload()
        }
      }
    } finally {
      setBulkBusy(false)
    }
  }

  function openReplaceOne(trackId: string) {
    replaceTargetIdRef.current = trackId
    replaceOneInputRef.current?.click()
  }

  async function onReplaceOneFile(fileList: FileList | null) {
    const trackId = replaceTargetIdRef.current
    const file = fileList?.[0]
    replaceTargetIdRef.current = null
    if (replaceOneInputRef.current) replaceOneInputRef.current.value = ''
    if (!trackId || !file) return
    setReplacingId(trackId)
    setBulkBusy(true)
    try {
      await replaceTrackAudio(trackId, file)
      alert(`Audio restaurado: ${file.name}`)
    } catch (e) {
      alert(e instanceof Error ? e.message : 'No se pudo subir el MP3')
    } finally {
      setReplacingId(null)
      setBulkBusy(false)
    }
  }

  async function onReplaceBulkFiles(fileList: FileList | null) {
    const files = fileList ? [...fileList] : []
    if (replaceBulkInputRef.current) replaceBulkInputRef.current.value = ''
    if (!files.length) return
    const ids =
      selectedRemote.length > 0
        ? selectedRemote.map((t) => t.id)
        : tracks.filter((t) => t.hasLocalAudio === false).map((t) => t.id)
    if (!ids.length) {
      alert('No hay canciones sin audio para restaurar.')
      return
    }
    setBulkBusy(true)
    try {
      const result = await replaceMissingAudio(files, ids)
      const extra = result.unmatched.length
        ? `\nSin emparejar: ${result.unmatched.slice(0, 3).join(', ')}${result.unmatched.length > 3 ? '…' : ''}`
        : ''
      alert(
        result.replaced > 0
          ? `Restauradas ${result.replaced} canción${result.replaced === 1 ? '' : 'es'}.${extra}`
          : `No se emparejó ningún MP3 con las canciones sin audio.${extra}`,
      )
    } catch (e) {
      alert(e instanceof Error ? e.message : 'No se pudieron subir los MP3')
    } finally {
      setBulkBusy(false)
    }
  }

  function exitSelectMode() {
    setSelectMode(false)
    setSelected(new Set())
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSelectAll() {
    if (allSelected) setSelected(new Set())
    else setSelected(new Set(tracks.map((t) => t.id)))
  }

  async function runBulk(
    action: () => Promise<void>,
    clearAfter = true,
  ) {
    setBulkBusy(true)
    try {
      await action()
      if (clearAfter) exitSelectMode()
    } finally {
      setBulkBusy(false)
    }
  }

  if (!tracks.length) {
    return (
      <div className="empty-state fade-up">
        <p className="empty-state__title">{emptyTitle}</p>
        <p className="empty-state__hint">{emptyHint}</p>
      </div>
    )
  }

  return (
    <>
      <input
        ref={replaceOneInputRef}
        type="file"
        accept="audio/mpeg,audio/mp3,.mp3,audio/*"
        hidden
        onChange={(e) => void onReplaceOneFile(e.target.files)}
      />
      <input
        ref={replaceBulkInputRef}
        type="file"
        accept="audio/mpeg,audio/mp3,.mp3,audio/*"
        multiple
        hidden
        onChange={(e) => void onReplaceBulkFiles(e.target.files)}
      />
      {selectable && selectMode && (
        <div className="select-toolbar">
          <button type="button" className="select-toolbar__toggle is-on" onClick={toggleSelectAll}>
            <span className={`check-box ${allSelected ? 'is-checked' : ''}`}>
              {allSelected ? <IconCheck size={14} /> : null}
            </span>
            {allSelected ? 'Quitar todo' : 'Seleccionar todo'}
          </button>
          <span className="select-toolbar__count">
            {selected.size} seleccionada{selected.size === 1 ? '' : 's'}
          </span>
          <button type="button" className="select-toolbar__cancel" onClick={exitSelectMode}>
            <IconClose size={18} /> Cancelar
          </button>
        </div>
      )}
      {selectable && !selectMode && showSelectToggle && (
        <div className="select-toolbar">
          <button
            type="button"
            className="select-toolbar__toggle"
            onClick={() => setSelectMode(true)}
          >
            <IconSelect size={18} /> Selección múltiple
          </button>
        </div>
      )}

      <ul className={`track-list ${selectMode ? 'is-selecting' : ''} ${showColumns ? 'track-list--cols' : ''}`}>
        {showColumns && !hideColumnHead && (
          <li className="track-row track-row--head" aria-hidden>
            {selectMode && <span className="track-col track-col--check" />}
            <span className="track-col track-col--title">Título</span>
            <span className="track-col track-col--album">Álbum</span>
            <span className="track-col track-col--date">Añadida</span>
            <span className="track-col track-col--time">Tiempo</span>
            {!selectMode && <span className="track-col track-col--actions" />}
          </li>
        )}
        {tracks.map((track, i) => {
          const active = track.id === currentTrackId
          const isSelected = selected.has(track.id)
          const remote = track.hasLocalAudio === false
          const needsUpdate =
            Boolean(track.needsAudioUpdate) && track.hasLocalAudio !== false
          const downloading =
            Boolean(downloadProgress?.ids.includes(track.id)) &&
            (remote || needsUpdate || downloadProgress?.trackId === track.id)
          const dlPercent =
            downloadProgress?.trackId === track.id
              ? downloadProgress.percent
              : downloading
                ? 0
                : null
          return (
            <li
              key={track.id}
              className={`track-row fade-up ${active ? 'is-active' : ''} ${isSelected ? 'is-selected' : ''} ${showColumns ? 'track-row--cols' : ''} ${remote ? 'is-remote' : ''} ${needsUpdate ? 'is-update' : ''} ${downloading ? 'is-downloading' : ''} ${desktopDrag ? 'is-draggable' : ''}`}
              style={{ animationDelay: `${Math.min(i, 12) * 0.03}s` }}
              draggable={desktopDrag}
              title={
                desktopDrag
                  ? selectMode && isSelected && selected.size > 1
                    ? `Arrastra ${selected.size} canciones a Me gusta o una playlist`
                    : 'Arrastra a Me gusta o una playlist (barra lateral o listas)'
                  : undefined
              }
              onDragStart={(e) => {
                if (!desktopDrag) {
                  e.preventDefault()
                  return
                }
                const ids = resolveDragTrackIds(track.id, selected)
                setTrackDragData(e.dataTransfer, ids)
              }}
            >
              {selectMode && (
                <button
                  type="button"
                  className="track-row__check"
                  aria-label={isSelected ? 'Quitar selección' : 'Seleccionar'}
                  onClick={() => toggleSelect(track.id)}
                >
                  <span className={`check-box ${isSelected ? 'is-checked' : ''}`}>
                    {isSelected ? <IconCheck size={14} /> : null}
                  </span>
                </button>
              )}
              {selectMode ? (
                <div
                  className="track-row__main track-col--title"
                  role="button"
                  tabIndex={0}
                  onClick={() => toggleSelect(track.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      toggleSelect(track.id)
                    }
                  }}
                >
                  <CoverArt
                    trackId={track.id}
                    hasCover={track.hasCover}
                    refreshKey={`${track.artist}|${track.album}|${track.externalUrl ?? ''}|${track.coverUpdatedAt ?? 0}`}
                    size={48}
                  />
                  <div className="track-row__meta">
                    <span className="track-row__title">
                      {active && isPlaying ? <IconPlay size={12} /> : null}
                      {track.title}
                      {remote && !downloading ? (
                        <em className="track-remote-tag"> · sin audio</em>
                      ) : null}
                      {needsUpdate && !downloading ? (
                        <em className="track-update-tag"> · actualizar</em>
                      ) : null}
                      {downloading && downloadProgress?.trackId === track.id ? (
                        <em className="track-dl-tag"> · {dlPercent}%</em>
                      ) : null}
                    </span>
                    <span className="track-row__sub">{track.artist}</span>
                  </div>
                </div>
              ) : (
              <button
                type="button"
                className="track-row__main track-col--title"
                onClick={() => {
                  if (remote) {
                    void downloadIds([track.id])
                    return
                  }
                  void playTracks(
                    tracks.filter((t) => t.hasLocalAudio !== false).map((t) => t.id),
                    track.id,
                  )
                }}
              >
                <CoverArt
                  trackId={track.id}
                  hasCover={track.hasCover}
                  refreshKey={`${track.artist}|${track.album}|${track.externalUrl ?? ''}|${track.coverUpdatedAt ?? 0}`}
                  size={48}
                />
                <div className="track-row__meta">
                  <span className="track-row__title">
                    {active && isPlaying ? <IconPlay size={12} /> : null}
                    {track.title}
                    {remote && !downloading ? (
                      <em className="track-remote-tag"> · sin audio</em>
                    ) : null}
                    {needsUpdate && !downloading ? (
                      <em className="track-update-tag"> · actualizar</em>
                    ) : null}
                    {downloading && downloadProgress?.trackId === track.id ? (
                      <em className="track-dl-tag"> · {dlPercent}%</em>
                    ) : null}
                  </span>
                  <span className="track-row__sub">{track.artist}</span>
                </div>
              </button>
              )}
              {showColumns && (
                <>
                  <span className="track-col track-col--album">{track.album || '—'}</span>
                  <span className="track-col track-col--date">
                    {formatAddedAt(track.createdAt)}
                  </span>
                  <span className="track-col track-col--time">
                    {formatTime(track.duration)}
                  </span>
                </>
              )}
              {!selectMode && (
                <div className="track-row__actions track-col--actions">
                  {needsUpdate && (
                    <button
                      type="button"
                      className="icon-btn track-row__update"
                      aria-label="Actualizar audio desde el PC"
                      title={
                        pcOnline === false
                          ? 'PC no detectado'
                          : 'Descargar: borra la antigua y pone la nueva'
                      }
                      disabled={bulkBusy || Boolean(downloadProgress)}
                      onClick={(e) => {
                        e.stopPropagation()
                        void downloadIds([track.id], { quiet: true })
                      }}
                    >
                      <IconDownload size={20} />
                    </button>
                  )}
                  {remote && (
                    <>
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label="Subir MP3 de nuevo"
                        title="Subir MP3 de nuevo"
                        disabled={bulkBusy || replacingId === track.id}
                        onClick={(e) => {
                          e.stopPropagation()
                          openReplaceOne(track.id)
                        }}
                      >
                        <IconUpload size={20} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label="Descargar desde el PC"
                        title={pcOnline === false ? 'PC no detectado' : 'Descargar'}
                        disabled={bulkBusy || Boolean(downloadProgress)}
                        onClick={(e) => {
                          e.stopPropagation()
                          void downloadIds([track.id])
                        }}
                      >
                        <IconDownload size={20} />
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className={`icon-btn like-btn track-row__like ${track.liked ? 'is-liked' : ''}`}
                    aria-label={track.liked ? 'Quitar de Me gusta' : 'Me gusta'}
                    title={track.liked ? 'Quitar de Me gusta' : 'Me gusta'}
                    onClick={(e) => {
                      e.stopPropagation()
                      void toggleLike(track.id)
                    }}
                  >
                    <IconHeart size={18} filled={track.liked} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn track-row__more"
                    aria-label="Más opciones"
                    onClick={(e) => {
                      e.stopPropagation()
                      setMenuTrack(track)
                    }}
                  >
                    <IconMore size={20} />
                  </button>
                </div>
              )}
              {downloading && dlPercent != null && (
                <div className="track-dl" aria-label={`Descarga ${dlPercent}%`}>
                  <div className="track-dl__bar">
                    <div
                      className="track-dl__fill"
                      style={{
                        width: `${
                          downloadProgress?.trackId === track.id
                            ? Math.max(dlPercent, 2)
                            : 0
                        }%`,
                      }}
                    />
                  </div>
                  <span className="track-dl__pct">
                    {downloadProgress?.trackId === track.id ? `${dlPercent}%` : 'En cola'}
                  </span>
                </div>
              )}
            </li>
          )
        })}
      </ul>

      {downloadProgress && (
        <div className="download-banner" role="status">
          <div className="download-banner__top">
            <strong>
              Descargando {downloadProgress.done}/{downloadProgress.total}
            </strong>
            <span>
              {downloadProgress.trackId
                ? `${downloadProgress.percent}%`
                : '…'}
            </span>
          </div>
          <div className="download-banner__bar">
            <div
              style={{
                width: `${
                  downloadProgress.total
                    ? Math.min(
                        100,
                        Math.round(
                          ((downloadProgress.done + downloadProgress.percent / 100) /
                            downloadProgress.total) *
                            100,
                        ),
                      )
                    : 0
                }%`,
              }}
            />
          </div>
          {downloadProgress.name ? (
            <p className="download-banner__name">{downloadProgress.name}</p>
          ) : null}
        </div>
      )}

      {selectMode && selected.size > 0 && (
        <div className="bulk-bar">
          <div className="bulk-bar__inner">
            {desktopDrag ? (
              <span className="bulk-bar__hint">
                Arrastra la selección a una playlist (barra lateral)
              </span>
            ) : null}
            {selectedRemote.length > 0 && (
              <>
                <button
                  type="button"
                  disabled={bulkBusy || Boolean(downloadProgress)}
                  onClick={() => replaceBulkInputRef.current?.click()}
                >
                  <IconUpload size={18} /> Subir MP3 ({selectedRemote.length})
                </button>
                <button
                  type="button"
                  disabled={bulkBusy || Boolean(downloadProgress)}
                  onClick={() =>
                    void runBulk(async () => {
                      await downloadIds(selectedRemote.map((t) => t.id))
                    })
                  }
                >
                  <IconDownload size={18} /> Descargar ({selectedRemote.length})
                </button>
              </>
            )}
            {selectedNeedsUpdate.length > 0 && (
              <button
                type="button"
                disabled={bulkBusy || Boolean(downloadProgress)}
                onClick={() =>
                  void runBulk(async () => {
                    await downloadIds(
                      selectedNeedsUpdate.map((t) => t.id),
                      { quiet: true },
                    )
                  })
                }
              >
                <IconDownload size={18} /> Actualizar ({selectedNeedsUpdate.length})
              </button>
            )}
            <button
              type="button"
              disabled={bulkBusy}
              onClick={() =>
                void runBulk(async () => {
                  const playable = selectedTracks.filter((t) => t.hasLocalAudio !== false)
                  if (!playable.length) {
                    alert('Esas canciones aún no están en el móvil. Descárgalas antes.')
                    return
                  }
                  void playTracks(playable.map((t) => t.id))
                })
              }
            >
              <IconPlay size={18} /> Reproducir
            </button>
            <button
              type="button"
              disabled={bulkBusy}
              onClick={() =>
                void runBulk(async () => {
                  await setLiked([...selected], true)
                })
              }
            >
              <IconHeart size={18} filled /> Me gusta
            </button>
            <button
              type="button"
              disabled={bulkBusy}
              onClick={() =>
                void runBulk(async () => {
                  const ids = [...selected]
                  ids.forEach((id) => addToQueue(id))
                })
              }
            >
              <IconQueue size={18} /> A la cola
            </button>
            <button
              type="button"
              disabled={bulkBusy}
              onClick={() => setPlaylistPickIds([...selected])}
            >
              <IconPlus size={18} /> Añadir a lista
            </button>
            <button
              type="button"
              disabled={bulkBusy}
              onClick={() =>
                void runBulk(async () => {
                  const r = await enrichSelected([...selected])
                  alert(
                    `Online: ${r.ok} actualizadas` +
                      (r.fail ? `, ${r.fail} sin resultado` : ''),
                  )
                }, false)
              }
            >
              <IconSearch size={18} />{' '}
              {enrichProgress ? `${enrichProgress.done}/${enrichProgress.total}` : 'Buscar info'}
            </button>
            {contextPlaylistId && (
              <button
                type="button"
                disabled={bulkBusy}
                onClick={() =>
                  void runBulk(async () => {
                    for (const id of selected) {
                      await removeFromPlaylist(contextPlaylistId, id)
                    }
                  })
                }
              >
                <IconTrash size={18} /> Quitar
              </button>
            )}
            <button
              type="button"
              className="danger"
              disabled={bulkBusy}
              onClick={() => {
                if (!confirm(`¿Eliminar ${selected.size} canciones?`)) return
                const toDelete = selectedTracks
                const fileNames = toDelete.map((t) =>
                  myVibeDownloadName(t.artist, t.title, t.fileName),
                )
                void runBulk(async () => {
                  await deleteTracks(toDelete.map((t) => t.id))
                  setDeleteNotice({ count: toDelete.length, fileNames })
                  setSelectMode(false)
                  setSelected(new Set())
                })
              }}
            >
              <IconTrash size={18} /> Eliminar
            </button>
          </div>
        </div>
      )}

      {menuTrack && (
        <SheetPortal>
        <div className="sheet track-actions-sheet">
          <button
            type="button"
            className="sheet-backdrop"
            aria-label="Cerrar"
            onClick={() => setMenuTrack(null)}
          />
          <div className="sheet__panel track-actions-panel" role="menu">
            <div className="track-actions-scroll">
            <div className="track-actions-head">
              <CoverArt
                trackId={menuTrack.id}
                hasCover={menuTrack.hasCover}
                refreshKey={`${menuTrack.artist}|${menuTrack.album}|${menuTrack.externalUrl ?? ''}|${menuTrack.coverUpdatedAt ?? 0}`}
                size={48}
              />
              <div>
                <strong>{menuTrack.title}</strong>
                <span>{menuTrack.artist}</span>
              </div>
            </div>

            {menuTrack.hasLocalAudio === false && (
              <>
                <button
                  type="button"
                  className="sheet__item"
                  disabled={bulkBusy || replacingId === menuTrack.id}
                  onClick={() => {
                    const id = menuTrack.id
                    setMenuTrack(null)
                    openReplaceOne(id)
                  }}
                >
                  <IconUpload size={18} /> Subir MP3 de nuevo
                </button>
                <button
                  type="button"
                  className="sheet__item"
                  disabled={bulkBusy || Boolean(downloadProgress)}
                  onClick={() => {
                    const id = menuTrack.id
                    setMenuTrack(null)
                    void downloadIds([id])
                  }}
                >
                  <IconDownload size={18} /> Descargar desde el PC
                </button>
              </>
            )}

            {menuTrack.needsAudioUpdate && menuTrack.hasLocalAudio !== false && (
              <button
                type="button"
                className="sheet__item sheet__item--update"
                disabled={bulkBusy || Boolean(downloadProgress)}
                onClick={() => {
                  const id = menuTrack.id
                  setMenuTrack(null)
                  void downloadIds([id], { quiet: true })
                }}
              >
                <IconDownload size={18} /> Actualizar audio (borrar antigua)
              </button>
            )}

            <button
              type="button"
              className="sheet__item"
              onClick={() => {
                void toggleLike(menuTrack.id)
                setMenuTrack(null)
              }}
            >
              <IconHeart size={18} filled={menuTrack.liked} />{' '}
              {menuTrack.liked ? 'Quitar de Me gusta' : 'Me gusta'}
            </button>
            <button
              type="button"
              className="sheet__item"
              onClick={() => {
                const track = menuTrack
                setMenuTrack(null)
                void shareTrack(track.id)
                  .then((mode) => {
                    if (mode === 'downloaded') {
                      alert(
                        'Archivo .myvibe descargado. Envíaselo a quien tenga MyVibe; podrá importarlo en Subir.',
                      )
                    }
                  })
                  .catch((e) => {
                    if (e instanceof DOMException && e.name === 'AbortError') return
                    alert(e instanceof Error ? e.message : 'No se pudo compartir')
                  })
              }}
            >
              <IconShare size={18} /> Compartir con MyVibe
            </button>
            <button
              type="button"
              className="sheet__item"
              onClick={() => {
                playNext(menuTrack.id)
                setMenuTrack(null)
              }}
            >
              <IconQueue size={18} /> Reproducir a continuación
            </button>
            <button
              type="button"
              className="sheet__item"
              onClick={() => {
                addToQueue(menuTrack.id)
                setMenuTrack(null)
              }}
            >
              <IconPlus size={18} /> Añadir a la cola
            </button>
            <button
              type="button"
              className="sheet__item"
              onClick={() => {
                setPlaylistPickIds([menuTrack.id])
                setMenuTrack(null)
              }}
            >
              <IconPlus size={18} /> Añadir a playlist
            </button>
            <button
              type="button"
              className="sheet__item"
              onClick={() => {
                setEditTrack(menuTrack)
                setMenuTrack(null)
              }}
            >
              <IconEdit size={18} /> Editar información
            </button>
            <button
              type="button"
              className="sheet__item"
              disabled={enrichingId === menuTrack.id}
              onClick={() => {
                const id = menuTrack.id
                setEnrichingId(id)
                void enrichTrack(id).then((result) => {
                  setEnrichingId(null)
                  setMenuTrack(null)
                  if (!result.found) {
                    alert(
                      'No se encontró información online. Edita el título o artista y vuelve a intentarlo.',
                    )
                  }
                })
              }}
            >
              <IconSearch size={18} />{' '}
              {enrichingId === menuTrack.id
                ? 'Buscando en internet…'
                : 'Buscar portada e info online'}
            </button>
            <button
              type="button"
              className="sheet__item"
              disabled={enrichingId === menuTrack.id}
              onClick={() => {
                const id = menuTrack.id
                setEnrichingId(id)
                void enrichTrack(id, { force: true }).then((result) => {
                  setEnrichingId(null)
                  setMenuTrack(null)
                  if (!result.found) {
                    alert(
                      'No se pudo forzar un emparejamiento mejor. Prueba a editar el título (p. ej. añade el nombre de la película) y repite.',
                    )
                  } else {
                    alert(
                      result.coverUpdated
                        ? 'Emparejamiento forzado: artista, álbum y portada actualizados.'
                        : 'Emparejamiento forzado: artista y álbum actualizados.',
                    )
                  }
                })
              }}
            >
              <IconSearch size={18} />{' '}
              {enrichingId === menuTrack.id
                ? 'Forzando…'
                : 'Forzar emparejamiento'}
            </button>
            {contextPlaylistId && (
              <button
                type="button"
                className="sheet__item"
                onClick={() => {
                  void removeFromPlaylist(contextPlaylistId, menuTrack.id)
                  setMenuTrack(null)
                }}
              >
                <IconTrash size={18} /> Quitar de playlist
              </button>
            )}
            </div>
            <div className="track-actions-footer">
              <button
                type="button"
                className="sheet__item danger"
                onClick={() => {
                  const track = menuTrack
                  const isRemote = track.hasLocalAudio === false
                  if (
                    !confirm(
                      isRemote
                        ? `¿Quitar “${track.title}” de este móvil?`
                        : `¿Borrar “${track.title}” de este dispositivo?`,
                    )
                  ) {
                    setMenuTrack(null)
                    return
                  }
                  const fileName = myVibeDownloadName(track.artist, track.title, track.fileName)
                  setMenuTrack(null)
                  void deleteTrack(track.id).then(() => {
                    setDeleteNotice({ count: 1, fileNames: [fileName] })
                  })
                }}
              >
                <IconTrash size={18} />{' '}
                {menuTrack.hasLocalAudio === false ? 'Quitar de este móvil' : 'Borrar'}
              </button>
            </div>
          </div>
        </div>
        </SheetPortal>
      )}

      {playlistPickIds && (
        <SheetPortal>
        <div className="sheet">
          <button
            type="button"
            className="sheet-backdrop"
            onClick={() => setPlaylistPickIds(null)}
          />
          <div className="sheet__panel">
            <h3>
              Añadir {playlistPickIds.length} canción
              {playlistPickIds.length === 1 ? '' : 'es'} a una lista
            </h3>
            {playlists.length === 0 ? (
              <p className="empty-state__hint">
                Aún no tienes listas. Crea una con el + en Tu biblioteca.
              </p>
            ) : (
              playlists.map((p) => (
                <button
                  type="button"
                  key={p.id}
                  className="sheet__item"
                  onClick={() => {
                    void addToPlaylist(p.id, playlistPickIds).then(() => {
                      setPlaylistPickIds(null)
                      if (selectMode) exitSelectMode()
                    })
                  }}
                >
                  <span>{p.name}</span>
                  <span style={{ color: '#b3b3b3', marginLeft: 'auto', fontSize: '0.8rem' }}>
                    {p.trackIds.length}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
        </SheetPortal>
      )}

      {deleteNotice && (
        <SheetPortal>
        <div className="sheet track-actions-sheet">
          <button
            type="button"
            className="sheet-backdrop"
            aria-label="Cerrar"
            onClick={() => setDeleteNotice(null)}
          />
          <div className="sheet__panel" role="dialog" aria-label="Después de eliminar">
            <div className="track-actions-head">
              <div>
                <strong>
                  Eliminada{deleteNotice.count === 1 ? '' : 's'} de MyVibe
                </strong>
                <span>
                  {deleteNotice.count} canción{deleteNotice.count === 1 ? '' : 'es'} borrada
                  {deleteNotice.count === 1 ? '' : 's'} del reproductor.
                  {isAppleMobile()
                    ? ' Si también las guardaste en Archivos, aún ocupan espacio.'
                    : ' Si también están en Descargas → MyVibe, aún ocupan espacio.'}
                </span>
              </div>
            </div>
            <button
              type="button"
              className="sheet__item danger"
              disabled={deletingVisible}
              onClick={() => {
                setDeletingVisible(true)
                void deleteVisibleCopies(deleteNotice.fileNames, { interactive: true })
                  .then((r) => {
                    alert(r.message)
                    if (r.mode === 'folder' && r.removed > 0) setDeleteNotice(null)
                  })
                  .catch((e) => {
                    if (e instanceof DOMException && e.name === 'AbortError') return
                    alert(e instanceof Error ? e.message : 'No se pudieron borrar las copias')
                  })
                  .finally(() => setDeletingVisible(false))
              }}
            >
              <IconTrash size={18} />{' '}
              {deletingVisible
                ? 'Borrando…'
                : isAppleMobile()
                  ? 'Cómo borrar copias en Archivos'
                  : 'Borrar también en Descargas/MyVibe'}
            </button>
            <button type="button" className="sheet__item" onClick={() => setDeleteNotice(null)}>
              Listo, solo MyVibe
            </button>
          </div>
        </div>
        </SheetPortal>
      )}

      {editTrack && (
        <SheetPortal>
          <EditTrackModal
            track={editTrack}
            onClose={() => setEditTrack(null)}
            onSave={async (patch) => {
              await updateTrack(editTrack.id, patch)
              setEditTrack(null)
            }}
            onSetCover={async (file) => {
              await setCover(editTrack.id, file)
            }}
          />
        </SheetPortal>
      )}
    </>
  )
}

function EditTrackModal({
  track,
  onClose,
  onSave,
  onSetCover,
}: {
  track: Track
  onClose: () => void
  onSave: (patch: Partial<Pick<Track, 'title' | 'artist' | 'album' | 'genre'>>) => Promise<void>
  onSetCover: (file: File) => Promise<void>
}) {
  const [title, setTitle] = useState(track.title)
  const [artist, setArtist] = useState(track.artist)
  const [album, setAlbum] = useState(track.album)
  const [genre, setGenre] = useState(track.genre)
  const [hasCover, setHasCover] = useState(track.hasCover)
  const [coverRev, setCoverRev] = useState(track.coverUpdatedAt ?? 0)
  const [coverBusy, setCoverBusy] = useState(false)
  const [cropSource, setCropSource] = useState<{ blob: Blob; name: string } | null>(null)
  const coverInputRef = useRef<HTMLInputElement>(null)

  const openCrop = (file: File | Blob | undefined, name?: string) => {
    if (!file) return
    if (file instanceof File) {
      const okType = !file.type || file.type.startsWith('image/')
      if (!okType) return
      setCropSource({ blob: file, name: file.name })
    } else {
      setCropSource({ blob: file, name: name || 'cover.jpg' })
    }
    if (coverInputRef.current) coverInputRef.current.value = ''
  }

  const applyCrop = async (file: File) => {
    setCoverBusy(true)
    try {
      await onSetCover(file)
      setHasCover(true)
      setCoverRev(Date.now())
      setCropSource(null)
    } finally {
      setCoverBusy(false)
    }
  }

  const adjustExisting = async () => {
    setCoverBusy(true)
    try {
      const blob = await getCoverBlob(track.id)
      if (!blob) {
        coverInputRef.current?.click()
        return
      }
      openCrop(blob, `${track.title}-cover.jpg`)
    } finally {
      setCoverBusy(false)
    }
  }

  return (
    <>
      <div className="sheet">
        <button type="button" className="sheet-backdrop" onClick={onClose} />
        <div className="sheet__panel">
          <h3>Editar canción</h3>

          <div className="edit-cover">
            <button
              type="button"
              className="edit-cover__art"
              onClick={() => (hasCover ? void adjustExisting() : coverInputRef.current?.click())}
              disabled={coverBusy}
              aria-label="Cambiar portada"
            >
              <CoverArt
                trackId={track.id}
                hasCover={hasCover}
                refreshKey={coverRev}
                size={120}
                rounded="md"
              />
              <span className="edit-cover__hint">
                <IconUpload size={18} />
                {coverBusy ? 'Cargando…' : hasCover ? 'Ajustar / cambiar' : 'Añadir imagen'}
              </span>
            </button>
            <input
              ref={coverInputRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => openCrop(e.target.files?.[0])}
            />
            <div className="edit-cover__actions">
              <button
                type="button"
                className="edit-cover__link"
                onClick={() => coverInputRef.current?.click()}
                disabled={coverBusy}
              >
                Subir imagen
              </button>
              {hasCover && (
                <button
                  type="button"
                  className="edit-cover__link"
                  onClick={() => void adjustExisting()}
                  disabled={coverBusy}
                >
                  Reposicionar
                </button>
              )}
            </div>
            <p className="edit-cover__help">
              Puedes subir una foto y moverla o hacer zoom antes de guardarla
            </p>
          </div>

          <label className="field">
            Título
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="field">
            Artista
            <input value={artist} onChange={(e) => setArtist(e.target.value)} />
          </label>
          <label className="field">
            Álbum
            <input value={album} onChange={(e) => setAlbum(e.target.value)} />
          </label>
          <label className="field">
            Género
            <input value={genre} onChange={(e) => setGenre(e.target.value)} />
          </label>
          <button
            type="button"
            className="btn-primary"
            onClick={() => void onSave({ title, artist, album, genre })}
          >
            Guardar
          </button>
        </div>
      </div>

      {cropSource && (
        <CoverCropSheet
          file={cropSource.blob}
          fileName={cropSource.name}
          onCancel={() => setCropSource(null)}
          onConfirm={applyCrop}
        />
      )}
    </>
  )
}
