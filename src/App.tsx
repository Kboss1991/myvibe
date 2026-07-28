import { useEffect } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { AppIcon } from './components/AppIcon'
import { BottomNav } from './components/BottomNav'
import { CarMode } from './components/CarMode'
import { NowPlaying, PlayerBar, QueueSheet } from './components/Player'
import { Sidebar } from './components/Sidebar'
import { AuthPage } from './pages/AuthPage'
import { HomePage } from './pages/HomePage'
import { LibraryPage } from './pages/LibraryPage'
import { LikedPage } from './pages/LikedPage'
import { PlaylistDetailPage } from './pages/PlaylistDetailPage'
import { ProfilePage } from './pages/ProfilePage'
import { ReceivePage } from './pages/ReceivePage'
import { SearchPage } from './pages/SearchPage'
import { UploadPage } from './pages/UploadPage'
import { useAuthStore } from './store/authStore'
import { useLibraryStore } from './store/libraryStore'
import { usePlayerStore } from './store/playerStore'
import './App.css'

export default function App() {
  const hydrateAuth = useAuthStore((s) => s.hydrate)
  const authReady = useAuthStore((s) => s.ready)
  const user = useAuthStore((s) => s.user)
  const initLibrary = useLibraryStore((s) => s.init)
  const hydratePlayer = usePlayerStore((s) => s.hydrate)
  const currentTrackId = usePlayerStore((s) => s.currentTrackId)
  const location = useLocation()
  const isReceive = location.pathname.startsWith('/receive')

  useEffect(() => {
    void hydrateAuth()
  }, [hydrateAuth])

  useEffect(() => {
    if (!user) return
    const unsub = initLibrary()
    void hydratePlayer()
    return unsub
  }, [user, initLibrary, hydratePlayer])

  if (!authReady) {
    return (
      <div className="boot-screen">
        <AppIcon size={72} className="boot-logo" />
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
    <div className={`app-shell ${currentTrackId ? 'has-player' : ''}`}>
      <Sidebar />
      <div className="app-column">
        <main className="app-main">
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/library" element={<LibraryPage />} />
            <Route path="/liked" element={<LikedPage />} />
            <Route path="/playlist/:id" element={<PlaylistDetailPage />} />
            <Route path="/upload" element={<UploadPage />} />
            <Route path="/profile" element={<ProfilePage />} />
            <Route path="/receive" element={<ReceivePage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>

        <div className="app-dock">
          <PlayerBar />
          <BottomNav />
        </div>
      </div>

      <NowPlaying />
      <QueueSheet />
      <CarMode />
    </div>
  )
}
