import { useState } from 'react'
import { Link, NavLink } from 'react-router-dom'
import {
  IconHeart,
  IconHome,
  IconLibrary,
  IconPlus,
  IconPodcast,
  IconRadio,
  IconSearch,
  IconUpload,
} from './Icons'
import { AppIcon } from './AppIcon'
import { BrandWordmark } from './BrandWordmark'
import { playlistCoverArtProps } from '../lib/library'
import { usePlaylistDropTargets } from '../hooks/usePlaylistDropTargets'
import { CoverArt } from './CoverArt'
import { PlaylistBuilderSheet } from './PlaylistBuilderSheet'
import { UserAvatar } from './UserAvatar'
import { useAuthStore } from '../store/authStore'
import { useLibraryStore } from '../store/libraryStore'
import './Sidebar.css'

const links = [
  { to: '/', label: 'Inicio', icon: IconHome, end: true },
  { to: '/search', label: 'Buscar', icon: IconSearch },
  { to: '/library', label: 'Tu biblioteca', icon: IconLibrary },
  { to: '/radios', label: 'Radios', icon: IconRadio },
  { to: '/podcasts', label: 'Podcasts', icon: IconPodcast },
  { to: '/upload', label: 'Subir', icon: IconUpload },
]

export function Sidebar() {
  const user = useAuthStore((s) => s.user)
  const playlists = useLibraryStore((s) => s.playlists)
  const getLiked = useLibraryStore((s) => s.getLiked)
  const liked = getLiked()
  const [creating, setCreating] = useState(false)
  const {
    allowDrop,
    dropOver,
    dropHint,
    clearDrop,
    likedDropProps,
    playlistDropProps,
  } = usePlaylistDropTargets()

  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <AppIcon size={32} />
        <BrandWordmark className="sidebar__brand-text" />
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
            onClick={() => setCreating(true)}
          >
            <IconPlus size={18} />
          </button>
        </div>

        {dropHint ? (
          <p className="sidebar__drop-toast" role="status">
            {dropHint}
          </p>
        ) : null}

        <div className="sidebar__library-list">
          <NavLink
            to="/liked"
            className={({ isActive }) =>
              `sidebar__item ${isActive ? 'is-active' : ''} ${dropOver === 'liked' ? 'is-drop-over' : ''}`
            }
            {...(allowDrop
              ? {
                  ...likedDropProps,
                  onDragLeave: clearDrop,
                }
              : {})}
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

          {playlists.map((p) => {
            const cover = playlistCoverArtProps(p)
            const drop = allowDrop ? playlistDropProps(p.id, p.name) : null
            return (
              <NavLink
                key={p.id}
                to={`/playlist/${p.id}`}
                className={({ isActive }) =>
                  `sidebar__item ${isActive ? 'is-active' : ''} ${dropOver === p.id ? 'is-drop-over' : ''}`
                }
                {...(drop
                  ? {
                      ...drop,
                      onDragLeave: clearDrop,
                    }
                  : {})}
              >
                <CoverArt
                  trackId={cover.trackId}
                  hasCover={cover.hasCover}
                  refreshKey={cover.refreshKey}
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
            )
          })}

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

      {creating && (
        <PlaylistBuilderSheet playlistId={null} onClose={() => setCreating(false)} />
      )}
    </aside>
  )
}
