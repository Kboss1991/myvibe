import { useEffect, useState } from 'react'
import { roundRadioDelayMs } from '../lib/radios'

/** Retraso mostrado: base + tiempo de pausa en vivo (s,mmm). */
export function useDisplayedRadioDelay(
  baseDelay: number,
  pauseStartedAt: number | null,
  maxDelay: number,
) {
  const [now, setNow] = useState(() => performance.now())

  useEffect(() => {
    if (pauseStartedAt == null) return
    let raf = 0
    const tick = () => {
      setNow(performance.now())
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [pauseStartedAt])

  if (pauseStartedAt == null) return roundRadioDelayMs(baseDelay)
  const live = baseDelay + (now - pauseStartedAt) / 1000
  return roundRadioDelayMs(Math.min(maxDelay, Math.max(0, live)))
}
