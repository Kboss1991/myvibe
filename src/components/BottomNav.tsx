import { NavLink } from 'react-router-dom'
import { IconHome, IconLibrary, IconPodcast, IconRadio, IconSearch } from './Icons'
import './BottomNav.css'

const links = [
  { to: '/', label: 'Inicio', icon: IconHome, end: true },
  { to: '/search', label: 'Buscar', icon: IconSearch },
  { to: '/library', label: 'Biblioteca', icon: IconLibrary },
  { to: '/radios', label: 'Radios', icon: IconRadio },
  { to: '/podcasts', label: 'Podcasts', icon: IconPodcast },
]

export function BottomNav() {
  return (
    <nav className="bottom-nav" aria-label="Principal">
      {links.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          className={({ isActive }) => `bottom-nav__link ${isActive ? 'is-active' : ''}`}
        >
          <Icon size={26} />
          <span>{label}</span>
        </NavLink>
      ))}
    </nav>
  )
}
