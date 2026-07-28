import { Link, NavLink } from 'react-router-dom'
import {
  IconHeart,
  IconHome,
  IconLibrary,
  IconPlus,
  IconSearch,
  IconUpload,
} from './Icons'
import { AppIcon } from './AppIcon'
import { CoverArt } from './CoverArt'
import { UserAvatar } from './UserAvatar'
import { useAuthStore } from '../store/authStore'
import { useLibraryStore } from '../store/libraryStore'
import './Sidebar.css'

const links = [
  { to: '/', label: 'Inicio', icon: IconHome, end: true },
  { to: '/search', label: 'Buscar', icon: IconSearch },
  { to: '/library', label: 'Tu biblioteca', icon: IconLibrary },
  { to: '/upload', label: 'Subir', icon: IconUpload },
]

export function Sidebar() {
  const user = useAuthStore((s) => s.user)
  const playlists = useLibraryStore((s) => s.playlists)
  const getLiked = useLibraryStore((s) => s.getLiked)
  const createPlaylist = useLibraryStore((s) => s.createPlaylist)
  const liked = getLiked()

  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <AppIcon size={32} />
        <span>MyVibe</span>
      </div>

      <nav className="sidebar__nav">
        {links.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) => `sidebar__link ${isActive ? 'is-active' : ''}`}
          >
            <Icon size={24} />
            {label}
          </NavLink>
        ))}
      </nav>

      <div className="sidebar__library">
        <div className="sidebar__library-head">
          <span>Biblioteca</span>
          <button
            type="button"
            className="sidebar__add"
            aria-label="Nueva playlist"
            title="Crear playlist"
            onClick={() => {
              const name = prompt('Nombre de la playlist')
              if (name?.trim()) void createPlaylist(name.trim())
            }}
          >
            <IconPlus size={18} />
          </button>
        </div>

        <div className="sidebar__library-list">
          <NavLink
            to="/liked"
            className={({ isActive }) =>
              `sidebar__item ${isActive ? 'is-active' : ''}`
            }
          >
            <span className="sidebar__liked-thumb">
              <IconHeart size={16} filled />
            </span>
            <span className="sidebar__item-text">
              <strong>Canciones que te gustan</strong>
              <small>
                Playlist · {liked.length} {liked.length === 1 ? 'canción' : 'canciones'}
              </small>
            </span>
          </NavLink>

          {playlists.map((p) => (
            <NavLink
              key={p.id}
              to={`/playlist/${p.id}`}
              className={({ isActive }) =>
                `sidebar__item ${isActive ? 'is-active' : ''}`
              }
            >
              <CoverArt
                trackId={p.trackIds[0]}
                hasCover={!!p.trackIds[0]}
                size={40}
                rounded="sm"
              />
              <span className="sidebar__item-text">
                <strong>{p.name}</strong>
                <small>
                  Playlist · {p.trackIds.length}{' '}
                  {p.trackIds.length === 1 ? 'canción' : 'canciones'}
                </small>
              </span>
            </NavLink>
          ))}

          {playlists.length === 0 && liked.length === 0 && (
            <p className="sidebar__empty">
              Dale like a canciones o{' '}
              <Link to="/library">crea una playlist</Link>
            </p>
          )}
        </div>
      </div>

      <NavLink to="/profile" className="sidebar__profile">
        <UserAvatar user={user} size={36} className="sidebar__avatar" />
        <span className="sidebar__profile-text">
          <strong>{user?.displayName}</strong>
          <small>Perfil</small>
        </span>
      </NavLink>
    </aside>
  )
}
