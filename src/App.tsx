import { Component, useEffect, type ReactNode } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { AppIcon } from './components/AppIcon'
import { BrandWordmark } from './components/BrandWordmark'
import { BottomNav } from './components/BottomNav'
import { NowPlaying, PlayerBar, QueueSheet } from './components/Player'
import { Sidebar } from './components/Sidebar'
import { heartbeatDevice, isLibraryHostDevice } from './lib/devices'
import { isCloudAuthEnabled } from './lib/auth'
import { startLibraryHost } from './lib/libraryHost'
import { publishListeningNow } from './lib/friends'
import { AuthPage } from './pages/AuthPage'
import { HomePage } from './pages/HomePage'
import { LibraryPage } from './pages/LibraryPage'
import { LikedPage } from './pages/LikedPage'
import { PlaylistDetailPage } from './pages/PlaylistDetailPage'
import { ProfilePage } from './pages/ProfilePage'
import { RadiosPage } from './pages/RadiosPage'
import { PodcastsPage } from './pages/PodcastsPage'
import { ReceivePage } from './pages/ReceivePage'
import { SearchPage } from './pages/SearchPage'
import { UploadPage } from './pages/UploadPage'
import { useAuthStore } from './store/authStore'
import { useLibraryStore } from './store/libraryStore'
import { usePlayerStore } from './store/playerStore'
import './App.css'

class RouteErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="page" style={{ padding: 24 }}>
          <h1>Algo ha fallado</h1>
          <p className="page-header__sub" style={{ marginTop: 8 }}>
            {this.state.error.message}
          </p>
          <button
            type="button"
            className="btn-primary"
            style={{ marginTop: 16 }}
            onClick={() => this.setState({ error: null })}
          >
            Reintentar
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

export default function App() {
  const hydrateAuth = useAuthStore((s) => s.hydrate)
  const authReady = useAuthStore((s) => s.ready)
  const user = useAuthStore((s) => s.user)
  const initLibrary = useLibraryStore((s) => s.init)
  const syncCloudCatalog = useLibraryStore((s) => s.syncCloudCatalog)
  const hydratePlayer = usePlayerStore((s) => s.hydrate)
  const currentTrackId = usePlayerStore((s) => s.currentTrackId)
  const currentRadioId = usePlayerStore((s) => s.currentRadioId)
  const currentPodcastEpisodeId = usePlayerStore((s) => s.currentPodcastEpisodeId)
  const location = useLocation()
  const isReceive = location.pathname.startsWith('/receive')
  const hasPlayer = Boolean(currentTrackId || currentRadioId || currentPodcastEpisodeId)
  const setNowPlayingOpen = usePlayerStore((s) => s.setNowPlayingOpen)
  const setQueueOpen = usePlayerStore((s) => s.setQueueOpen)

  // Al cambiar de pestaña, cerrar hojas a pantalla completa (si no, tapan Radios/etc.)
  useEffect(() => {
    setNowPlayingOpen(false)
    setQueueOpen(false)
    document.body.classList.remove('sheet-open')
  }, [location.pathname, setNowPlayingOpen, setQueueOpen])

  useEffect(() => {
    void hydrateAuth()
  }, [hydrateAuth])

  useEffect(() => {
    if (!user) return
    const unsub = initLibrary()
    void hydratePlayer()
    return unsub
  }, [user, initLibrary, hydratePlayer])

  // Catálogo en la nube + host Wi‑Fi en el PC + dispositivos
  useEffect(() => {
    if (!user || !isCloudAuthEnabled()) return
    let stopped = false
    let hostStop: (() => void) | null = null
    let syncTimer: number | undefined
    let deviceTimer: number | undefined

    const runSync = () => {
      void syncCloudCatalog().catch((e) => console.warn('Sync catálogo', e))
    }

    const runDevice = async () => {
      try {
        const { revoked } = await heartbeatDevice(user.id)
        if (revoked) {
          await useAuthStore.getState().logout()
        }
      } catch (e) {
        console.warn('Dispositivo', e)
      }
    }

    const run = async () => {
      await new Promise((r) => setTimeout(r, 800))
      if (stopped) return
      await runDevice()
      if (stopped) return
      runSync()
      if (stopped) return

      if (isLibraryHostDevice()) {
        try {
          const session = await startLibraryHost(user.id)
          if (stopped) {
            session.stop()
            return
          }
          hostStop = session.stop
        } catch (e) {
          console.warn('Host biblioteca', e)
        }
      }

      syncTimer = window.setInterval(runSync, 30_000)
      deviceTimer = window.setInterval(() => void runDevice(), 40_000)
    }

    void run()
    return () => {
      stopped = true
      if (syncTimer) window.clearInterval(syncTimer)
      if (deviceTimer) window.clearInterval(deviceTimer)
      hostStop?.()
    }
  }, [user, syncCloudCatalog])

  // Cuando aparecen canciones locales (p. ej. tras cargar IDB), vuelve a publicar
  const tracksLen = useLibraryStore((s) => s.tracks.length)
  useEffect(() => {
    if (!user || !isCloudAuthEnabled()) return
    if (tracksLen <= 0) return
    const t = window.setTimeout(() => {
      void syncCloudCatalog().catch(() => {})
    }, 500)
    return () => window.clearTimeout(t)
  }, [user, tracksLen, syncCloudCatalog])

  // Presencia “escuchando ahora” para el círculo
  useEffect(() => {
    if (!user || !isCloudAuthEnabled() || !currentTrackId) return
    const track = useLibraryStore.getState().tracks.find((t) => t.id === currentTrackId)
    if (!track) return
    const t = window.setTimeout(() => {
      void publishListeningNow({
        title: track.title,
        artist: track.artist,
      }).catch(() => {})
    }, 1200)
    return () => window.clearTimeout(t)
  }, [user, currentTrackId])

  if (!authReady) {
    return (
      <div className="boot-screen">
        <AppIcon size={72} className="boot-logo" />
        <BrandWordmark className="boot-brand" />
      </div>
    )
  }

  // Recibir por Wi‑Fi funciona sin iniciar sesión
  if (isReceive) {
    return <ReceivePage />
  }

  if (!user) {
    return <AuthPage />
  }

  return (
    <div className={`app-shell ${hasPlayer ? 'has-player' : ''}`}>
      <Sidebar />
      <div className="app-column">
        <main className="app-main">
          <RouteErrorBoundary>
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/search" element={<SearchPage />} />
              <Route path="/library" element={<LibraryPage />} />
              <Route path="/radios" element={<RadiosPage />} />
              <Route path="/podcasts" element={<PodcastsPage />} />
              <Route path="/liked" element={<LikedPage />} />
              <Route path="/playlist/:id" element={<PlaylistDetailPage />} />
              <Route path="/upload" element={<UploadPage />} />
              <Route path="/profile" element={<ProfilePage />} />
              <Route path="/receive" element={<ReceivePage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </RouteErrorBoundary>
        </main>

        <div className="app-dock">
          <PlayerBar />
          <BottomNav />
        </div>
      </div>

      <NowPlaying />
      <QueueSheet />
    </div>
  )
}
