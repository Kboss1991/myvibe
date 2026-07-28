import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { registerSW } from 'virtual:pwa-register'
import App from './App'
import './styles/tokens.css'

// Fuerza coger la versión nueva tras cada deploy (evita UI vieja en caché)
registerSW({
  immediate: true,
  onNeedRefresh() {
    window.location.reload()
  },
  onRegisteredSW(_url, registration) {
    if (!registration) return
    void registration.update()
    window.setInterval(() => void registration.update(), 30 * 60 * 1000)
  },
})

// Tras un deploy, Safari/iOS a veces falla al cargar chunks viejos del SW.
// Recarga una vez para coger la versión nueva.
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault()
  const key = 'mv-chunk-reload'
  if (!sessionStorage.getItem(key)) {
    sessionStorage.setItem(key, '1')
    window.location.reload()
  }
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
