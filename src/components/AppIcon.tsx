import './AppIcon.css'

type Props = {
  size?: number
  className?: string
  /** Squircle app-icon frame (default) or just the badge circle */
  variant?: 'app' | 'badge'
}

/** Icono MyVibe: círculo ámbar + forma de onda (réplica CSS). */
export function AppIcon({ size = 64, className = '', variant = 'app' }: Props) {
  return (
    <div
      className={`app-icon app-icon--${variant} ${className}`}
      style={{ width: size, height: size }}
      aria-hidden
    >
      <div className="app-icon__circle">
        <div className="app-icon__wave">
          <span style={{ height: '18%' }} />
          <span style={{ height: '34%' }} />
          <span style={{ height: '58%' }} />
          <span style={{ height: '82%' }} />
          <span className="app-icon__wave-split">
            <i style={{ height: '42%' }} />
            <i style={{ height: '28%' }} />
          </span>
          <span style={{ height: '82%' }} />
          <span style={{ height: '58%' }} />
          <span style={{ height: '34%' }} />
          <span style={{ height: '18%' }} />
        </div>
      </div>
    </div>
  )
}
