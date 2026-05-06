import { Link } from 'react-router-dom'

export function HomePage() {
  return (
    <div className="page stack">
      <h1>Haptic tester</h1>
      <p className="lede">
        Test vibration patterns in the browser, inspect capability on this device, or pair two devices over WebRTC
        (manual offer/answer exchange) and drive haptics from a host phone or laptop.
      </p>
      <ul className="card-list">
        <li>
          <Link to="/device" className="card">
            <h2>Device check</h2>
            <p>Heuristic device info, Vibration API detection, and a quick gated test.</p>
          </Link>
        </li>
        <li>
          <Link to="/tester" className="card">
            <h2>Haptics tester</h2>
            <p>Grid of presets plus a simple pattern editor with named curve shortcuts.</p>
          </Link>
        </li>
        <li>
          <Link to="/pairing" className="card">
            <h2>Haptics pairing</h2>
            <p>HOST / GUEST roles, WebRTC data channel, instant or timeline pattern mode.</p>
          </Link>
        </li>
      </ul>
    </div>
  )
}
