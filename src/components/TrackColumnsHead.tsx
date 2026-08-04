import type { Track } from '../types'
import './TrackList.css'

export type TrackSortKey = 'title' | 'album' | 'date' | 'duration'
export type TrackSortDir = 'asc' | 'desc'

export type TrackSort = {
  key: TrackSortKey
  dir: TrackSortDir
}

const COLS: { key: TrackSortKey; label: string; className: string }[] = [
  { key: 'title', label: 'Título', className: 'track-list-head__title' },
  { key: 'album', label: 'Álbum', className: 'track-list-head__album' },
  { key: 'date', label: 'Fecha', className: 'track-list-head__date' },
  { key: 'duration', label: 'Tiempo', className: 'track-list-head__time' },
]

function norm(s: string) {
  return s.trim().toLocaleLowerCase('es')
}

function yearNum(year: string): number {
  const n = Number.parseInt(String(year).replace(/\D/g, '').slice(0, 4), 10)
  return Number.isFinite(n) ? n : 0
}

/** Ordena canciones por columna (título, álbum, fecha o duración). */
export function sortTracks(tracks: Track[], sort: TrackSort): Track[] {
  const mul = sort.dir === 'asc' ? 1 : -1
  const list = tracks.slice()
  list.sort((a, b) => {
    let cmp = 0
    switch (sort.key) {
      case 'title':
        cmp = norm(a.title).localeCompare(norm(b.title), 'es', {
          sensitivity: 'base',
          numeric: true,
        })
        if (!cmp) {
          cmp = norm(a.artist).localeCompare(norm(b.artist), 'es', {
            sensitivity: 'base',
          })
        }
        break
      case 'album':
        cmp = norm(a.album).localeCompare(norm(b.album), 'es', {
          sensitivity: 'base',
          numeric: true,
        })
        if (!cmp) {
          cmp = norm(a.title).localeCompare(norm(b.title), 'es', {
            sensitivity: 'base',
          })
        }
        break
      case 'date': {
        // Columna muestra año; prioriza año y luego fecha de alta
        const ya = yearNum(a.year)
        const yb = yearNum(b.year)
        if (ya && yb && ya !== yb) cmp = ya - yb
        else if (ya && !yb) cmp = 1
        else if (!ya && yb) cmp = -1
        else cmp = (a.createdAt || 0) - (b.createdAt || 0)
        break
      }
      case 'duration':
        cmp = (a.duration || 0) - (b.duration || 0)
        break
    }
    if (cmp) return cmp * mul
    return (b.createdAt || 0) - (a.createdAt || 0)
  })
  return list
}

interface Props {
  selecting?: boolean
  sort: TrackSort
  onSortChange: (next: TrackSort) => void
}

/** Cabecera de columnas sticky con ordenación al clic. */
export function TrackColumnsHead({
  selecting = false,
  sort,
  onSortChange,
}: Props) {
  function toggle(key: TrackSortKey) {
    if (sort.key === key) {
      onSortChange({ key, dir: sort.dir === 'asc' ? 'desc' : 'asc' })
      return
    }
    // Fecha y duración: primero de mayor a menor; nombres: A→Z
    const dir: TrackSortDir =
      key === 'date' || key === 'duration' ? 'desc' : 'asc'
    onSortChange({ key, dir })
  }

  return (
    <div
      className={`track-list-head ${selecting ? 'is-selecting' : ''}`}
      role="row"
    >
      {selecting && <span className="track-list-head__check" />}
      {COLS.map((col) => {
        const active = sort.key === col.key
        const arrow = active ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''
        return (
          <button
            key={col.key}
            type="button"
            className={`track-list-head__btn ${col.className} ${active ? 'is-active' : ''}`}
            aria-label={`Ordenar por ${col.label}`}
            title={`Ordenar por ${col.label}`}
            onClick={() => toggle(col.key)}
          >
            {col.label}
            {arrow}
          </button>
        )
      })}
      {!selecting && <span className="track-list-head__actions" />}
    </div>
  )
}
