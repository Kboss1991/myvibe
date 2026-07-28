import { useEffect, useState } from 'react'

/** Progreso 0–1 según scroll de `.app-main` (para headers sticky compactables). */
export function useMainScrollCollapse(rangePx = 72) {
  const [progress, setProgress] = useState(0)

  useEffect(() => {
    const main = document.querySelector('.app-main')
    if (!main) return

    const update = () => {
      const y = Math.max(0, (main as HTMLElement).scrollTop)
      setProgress(Math.min(1, y / Math.max(1, rangePx)))
    }

    update()
    main.addEventListener('scroll', update, { passive: true })
    return () => main.removeEventListener('scroll', update)
  }, [rangePx])

  return {
    progress,
    collapsed: progress > 0.55,
  }
}
