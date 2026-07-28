import { useEffect, useState } from 'react'
import { getCoverObjectUrl } from '../lib/library'
import './CoverArt.css'

interface Props {
  trackId?: string | null
  hasCover?: boolean
  /** Cambia tras enriquecer para forzar recarga de la imagen */
  refreshKey?: string | number | null
  size?: number | string
  className?: string
  rounded?: 'sm' | 'md' | 'lg' | 'full'
}

export function CoverArt({
  trackId,
  hasCover,
  refreshKey = '',
  size = 48,
  className = '',
  rounded = 'sm',
}: Props) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    if (!trackId || hasCover === false) {
      setUrl(null)
      return
    }
    void getCoverObjectUrl(trackId).then((u) => {
      if (!cancelled) setUrl(u)
    })
    return () => {
      cancelled = true
    }
  }, [trackId, hasCover, refreshKey])

  const style = {
    width: typeof size === 'number' ? `${size}px` : size,
    height: typeof size === 'number' ? `${size}px` : size,
  }

  return (
    <div
      className={`cover-art cover-art--${rounded} ${className}`}
      style={style}
      aria-hidden
    >
      {url ? (
        <img src={url} alt="" draggable={false} />
      ) : (
        <div className="cover-art__placeholder">
          <svg viewBox="0 0 24 24" width="40%" height="40%">
            <path
              fill="currentColor"
              d="M9 4v11.3A3.5 3.5 0 1 0 11 18V9l8-1.5V13a3.5 3.5 0 1 0 2 3V4.8L9 4z"
            />
          </svg>
        </div>
      )}
    </div>
  )
}
