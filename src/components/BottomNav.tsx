import { NavLink } from 'react-router-dom'
import { IconHome, IconLibrary, IconSearch, IconUpload } from './Icons'
import { UserAvatar } from './UserAvatar'
import { useAuthStore } from '../store/authStore'
import './BottomNav.css'

const links = [
  { to: '/', label: 'Inicio', icon: IconHome, end: true },
  { to: '/search', label: 'Buscar', icon: IconSearch },
  { to: '/library', label: 'Biblioteca', icon: IconLibrary },
  { to: '/upload', label: 'Subir', icon: IconUpload },
]

export function BottomNav() {
  const user = useAuthStore((s) => s.user)

  return (
    <nav className="bottom-nav" aria-label="Principal">
      {links.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }) => `bottom-nav__link ${isActive ? 'is-active' : ''}`}
        >
          <Icon size={22} />
          <span>{label}</span>
        </NavLink>
      ))}
      <NavLink
        to="/profile"
        className={({ isActive }) => `bottom-nav__link ${isActive ? 'is-active' : ''}`}
      >
        <UserAvatar user={user} size={22} className="bottom-nav__avatar" />
        <span>Perfil</span>
      </NavLink>
    </nav>
  )
}
