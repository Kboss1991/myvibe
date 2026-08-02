import './PortraitGate.css'

/** Bloquea el uso en horizontal en móvil (la UI no se adapta a landscape). */
export function PortraitGate() {
  return (
    <div className="portrait-gate" role="dialog" aria-modal="true" aria-label="Gira el teléfono">
      <div className="portrait-gate__inner">
        <span className="portrait-gate__phone" aria-hidden />
        <strong>Gira el teléfono</strong>
        <p>MyVibe en el móvil solo funciona en vertical.</p>
      </div>
    </div>
  )
}
