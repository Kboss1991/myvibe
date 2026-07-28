/** Cabecera de columnas sticky (Título / Tiempo). */
export function TrackColumnsHead({ selecting = false }: { selecting?: boolean }) {
  return (
    <div
      className={`track-list-head ${selecting ? 'is-selecting' : ''}`}
      aria-hidden
    >
      {selecting && <span className="track-list-head__check" />}
      <span className="track-list-head__title">Título</span>
      <span className="track-list-head__album">Álbum</span>
      <span className="track-list-head__date">Fecha</span>
      <span className="track-list-head__time">Tiempo</span>
      {!selecting && <span className="track-list-head__actions" />}
    </div>
  )
}
