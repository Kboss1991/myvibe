import { useEffect, useState } from 'react'
import { avatarCoverId } from '../lib/auth'
import { getCoverObjectUrl } from '../lib/library'
import type { User } from '../types'
import './UserAvatar.css'

interface Props {
  user: User | null | undefined
  size?: number | string
  className?: string
}

export function UserAvatar({ user, size = 40, className = '' }: Props) {
  const [url, setUrl] = useState<string | null>(null)
  const initials = (user?.displayName || user?.username || 'U').slice(0, 1).toUpperCase()
  const hue = user?.avatarHue ?? 200

  useEffect(() => {
    let cancelled = false
    if (!user?.id || !user.hasAvatar) {
      setUrl(null)
      return
    }
    void getCoverObjectUrl(avatarCoverId(user.id)).then((u) => {
      if (!cancelled) setUrl(u)
    })
    return () => {
      cancelled = true
    }
  }, [user?.id, user?.hasAvatar, user?.avatarUpdatedAt])

  const style = {
    width: typeof size === 'number' ? `${size}px` : size,
    height: typeof size === 'number' ? `${size}px` : size,
    background: url
      ? undefined
      : `linear-gradient(135deg, hsl(${hue} 70% 45%), hsl(${(hue + 40) % 360} 60% 30%))`,
  }

  return (
    <span className={`user-avatar ${className}`} style={style} aria-hidden>
      {url ? <img src={url} alt="" draggable={false} /> : initials}
    </span>
  )
}
