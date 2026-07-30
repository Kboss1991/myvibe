import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { registerSW } from 'virtual:pwa-register'
import App from './App'
import './styles/tokens.css'

function forceReloadOnce(reason: string) {
  const key = `mv-reload:v20260731-radios:${reason}`
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
