import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { registerSW } from 'virtual:pwa-register'
import App from './App'
import { audioEngine } from './lib/audioEngine'
import './styles/tokens.css'

// iOS WebKit: anular ±10s desde el arranque. next/prev se registran en el primer play() del usuario.
if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
  try {
    navigator.mediaSession.setActionHandler('seekforward', null)
    navigator.mediaSession.setActionHandler('seekbackward', null)
  } catch {
    /* ignore */
  }
}

/** Intenta fijar portrait (PWA). Sin trucos CSS de rotar el html. */
function tryLockPortrait() {
  try {
    const orientation = screen.orientation as ScreenOrientation & {
      lock?: (orientation: string) => Promise<void>
    }
    if (typeof orientation?.lock === 'function') {
      void orientation.lock('portrait').catch(() => {
        void orientation.lock?.('portrait-primary').catch(() => undefined)
      })
    }
  } catch {
    // iOS a menudo ignora lock; el manifesto lleva orientation: portrait-primary
  }
}

tryLockPortrait()
window.addEventListener('orientationchange', tryLockPortrait)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') tryLockPortrait()
})
document.addEventListener(
  'pointerdown',
  () => {
    tryLockPortrait()
  },
  { once: true, passive: true },
)

function shouldDeferReload() {
  try {
    if (audioEngine.shouldKeepAlive) return true
    if ('mediaSession' in navigator && navigator.mediaSession.playbackState === 'playing') {
      return true
    }
  } catch {
    /* ignore */
  }
  return false
}

function forceReloadOnce(reason: string) {
  // No tumbar la PWA en mitad de una canción / llamada (CarPlay desaparece)
  if (shouldDeferReload()) return
  const key = `mv-reload:v20260802-carplay:${reason}`
  if (sessionStorage.getItem(key)) return
  sessionStorage.setItem(key, '1')
  window.location.reload()
}

// Fuerza coger la versión nueva tras cada deploy (evita UI vieja en caché iOS)
registerSW({
  immediate: true,
  onNeedRefresh() {
    forceReloadOnce('need-refresh')
  },
  onRegisteredSW(_url, registration) {
    if (!registration) return

    const poke = () => {
      void registration.update()
      if (registration.waiting) {
        registration.waiting.postMessage({ type: 'SKIP_WAITING' })
        forceReloadOnce('waiting-sw')
      }
    }

    poke()
    window.setInterval(poke, 60 * 1000)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') poke()
    })
    window.addEventListener('focus', poke)

    registration.addEventListener('updatefound', () => {
      const neu = registration.installing
      if (!neu) return
      neu.addEventListener('statechange', () => {
        if (neu.state === 'installed' && navigator.serviceWorker.controller) {
          forceReloadOnce('updatefound')
        }
      })
    })
  },
})

navigator.serviceWorker?.addEventListener('controllerchange', () => {
  forceReloadOnce('controllerchange')
})

// Tras un deploy, Safari/iOS a veces falla al cargar chunks viejos del SW.
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault()
  forceReloadOnce('chunk')
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
