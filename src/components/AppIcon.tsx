import './AppIcon.css'

type Props = {
  size?: number
  className?: string
  /** Squircle frame (default) or circular badge */
  variant?: 'app' | 'badge'
}

/** Imagotipo MyVibe (PNG transparente). */
export function AppIcon({ size = 64, className = '', variant = 'app' }: Props) {
  return (
    <img
      src="/icons/icon-512-v4.png"
      alt=""
      width={size}
      height={size}
      draggable={false}
      className={`app-icon app-icon--${variant} ${className}`}
      style={{ width: size, height: size }}
      aria-hidden
    />
  )
}
