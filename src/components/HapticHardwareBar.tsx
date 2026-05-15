import { useMemo } from 'react'
import { useHapticOutput, type HapticOutputPreference } from '../lib/hapticOutputContext'

function prefLabel(p: HapticOutputPreference): string {
  switch (p) {
    case 'auto':
      return 'Auto (Bluetooth only when connected)'
    case 'mobile':
      return 'This device only'
    case 'intiface':
      return 'Bluetooth / Intiface only'
    case 'both':
      return 'Both this device and Bluetooth'
    default:
      return p
  }
}

export function HapticHardwareBar() {
  const {
    wsUrl,
    setWsUrl,
    outputPreference,
    setOutputPreference,
    connectionStatus,
    connectionError,
    scanning,
    intifaceDevices,
    intifaceReady,
    phoneHapticsCapable,
    connectIntiface,
    disconnectIntiface,
    startIntifaceScan,
    stopIntifaceScan,
  } = useHapticOutput()

  const statusLine = useMemo(() => {
    if (connectionStatus === 'connecting') return 'Connecting…'
    if (connectionStatus === 'error') return 'Error'
    if (connectionStatus !== 'connected') return 'Disconnected'
    if (scanning) return 'Scanning for Bluetooth devices…'
    if (intifaceReady) return `Connected — ${intifaceDevices.length} vibrating device(s)`
    return 'Connected — pair a device in Intiface Central, then scan'
  }, [connectionStatus, intifaceDevices.length, intifaceReady, scanning])

  return (
    <section className="haptic-bar panel stack" aria-label="External haptics and Intiface">
      <details>
        <summary className="haptic-bar__summary">
          <span className="haptic-bar__title">Haptics output</span>
          <span className="muted haptic-bar__status">{statusLine}</span>
        </summary>
        <div className="haptic-bar__body stack">
          <p className="muted small">
            Optional <strong>Intiface Central</strong> + Buttplug drives Bluetooth hardware. Install Intiface, start the
            server (default WebSocket <code>ws://127.0.0.1:12345</code>), pair your device there, then connect here.
          </p>
          <label className="field">
            <span>Intiface WebSocket URL</span>
            <input
              className="input mono"
              value={wsUrl}
              onChange={(e) => setWsUrl(e.target.value)}
              spellCheck={false}
              disabled={connectionStatus === 'connected' || connectionStatus === 'connecting'}
            />
          </label>
          <div className="row wrap">
            {connectionStatus !== 'connected' ? (
              <button type="button" className="btn btn-primary" onClick={() => void connectIntiface()}>
                Connect to Intiface
              </button>
            ) : (
              <>
                <button type="button" className="btn btn-danger" onClick={() => void disconnectIntiface()}>
                  Disconnect
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={scanning}
                  onClick={() => void startIntifaceScan()}
                >
                  {scanning ? 'Scanning…' : 'Bluetooth scan'}
                </button>
                {scanning && (
                  <button type="button" className="btn btn-ghost" onClick={() => void stopIntifaceScan()}>
                    Stop scan
                  </button>
                )}
              </>
            )}
          </div>
          {connectionError && <p className="warn">{connectionError}</p>}
          <label className="field">
            <span>Where to play haptics</span>
            <select
              value={outputPreference}
              onChange={(e) => setOutputPreference(e.target.value as HapticOutputPreference)}
              aria-label="Haptics output target"
            >
              <option value="auto">{prefLabel('auto')}</option>
              <option value="mobile">{prefLabel('mobile')}</option>
              <option value="intiface">{prefLabel('intiface')}</option>
              <option value="both">{prefLabel('both')}</option>
            </select>
          </label>
          <p className="muted small">
            Phone path: {phoneHapticsCapable ? 'available' : 'unavailable in this browser'}. Intiface path:{' '}
            {intifaceReady ? 'ready' : 'not ready'}.
          </p>
          {intifaceDevices.length > 0 && (
            <ul className="haptic-bar__devices">
              {intifaceDevices.map((d) => (
                <li key={d.index}>
                  <code>{d.index}</code> — {d.name}
                </li>
              ))}
            </ul>
          )}
        </div>
      </details>
    </section>
  )
}
