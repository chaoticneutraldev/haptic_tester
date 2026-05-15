import { NavLink, Outlet } from 'react-router-dom'

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `nav-link${isActive ? ' nav-link--active' : ''}`

export function Layout() {
  return (
    <div className="app-shell">
      <header className="app-header">
        <NavLink to="/" className="app-title" end>
          Haptic tester
        </NavLink>
        <nav className="app-nav" aria-label="Main">
          <NavLink to="/" className={linkClass} end>
            Home
          </NavLink>
          <NavLink to="/device" className={linkClass}>
            Device check
          </NavLink>
          <NavLink to="/tester" className={linkClass}>
            Haptics tester
          </NavLink>
          <NavLink to="/pairing" className={linkClass}>
            Pairing
          </NavLink>
        </nav>
      </header>
      <main className="app-main">
        <Outlet />
      </main>
      <footer className="app-footer">
        <p>
          Static lab tool. Web haptics use the Vibration API where available. Pairing uses WebRTC with shortcode and
          manual copy/paste signaling.
        </p>
        <p className="app-footer__version" aria-label={`App version ${__APP_VERSION__}`}>
          {__APP_VERSION__}
        </p>
      </footer>
    </div>
  )
}
