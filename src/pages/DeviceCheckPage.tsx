import { useCallback, useEffect, useState } from 'react'
import { collectDeviceInfo, type DeviceInfo } from '../lib/deviceDetect'
import { useHapticOutput } from '../lib/hapticOutputContext'
import { bestEffortHapticsMode, vibrateSupported } from '../lib/vibrate'
import { DeviceSilhouette } from '../components/DeviceSilhouette'

export function DeviceCheckPage() {
  const [info, setInfo] = useState<DeviceInfo | null>(null)
  const [lastTest, setLastTest] = useState<string | null>(null)
  const supported = vibrateSupported()
  const bestEffort = bestEffortHapticsMode()
  const canTrigger = supported || bestEffort
  const { playRoutingPattern, stopAllHardwareOutputs, intifaceReady } = useHapticOutput()
  const effectiveTrigger = canTrigger || intifaceReady

  useEffect(() => {
    let cancelled = false
    collectDeviceInfo().then((d) => {
      if (!cancelled) setInfo(d)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const runTest = useCallback(() => {
    if (!effectiveTrigger) {
      setLastTest('Neither phone vibration nor Intiface routing is available here.')
      return
    }
    playRoutingPattern([25, 50, 25])
    setLastTest(
      canTrigger ? (supported ? 'Short pattern fired.' : 'Best-effort haptic simulation fired.') : ' Routed to Bluetooth device.',
    )
  }, [canTrigger, effectiveTrigger, playRoutingPattern, supported])

  const startHoldTest = useCallback(() => {
    if (!effectiveTrigger) {
      setLastTest('Neither phone vibration nor Intiface routing is available here.')
      return
    }
    playRoutingPattern([800])
    setLastTest(
      canTrigger
        ? supported
          ? 'Long pulse while held…'
          : 'Best-effort hold simulation active…'
        : 'Long pulse routed to Bluetooth device.',
    )
  }, [canTrigger, effectiveTrigger, playRoutingPattern, supported])

  return (
    <div className="page stack">
      <h1>Device check</h1>
      <p className="lede">
        Best-effort detection only. Model names are not exposed reliably on the web; we show hints from the user agent
        and screen traits.
      </p>

      <section className="panel stack">
        <h2>Capabilities</h2>
        <p>
          <strong>Vibration API:</strong>{' '}
          {supported ? (
            <span className="ok">Available</span>
          ) : (
            <span className="warn">{bestEffort ? 'Not available (best-effort simulation mode)' : 'Not available'}</span>
          )}
        </p>
        {bestEffort && (
          <p className="callout">
            This iOS browser does not expose the standard web vibration API. Physical haptics are best effort only here:
            we simulate pattern timing visually, but it may not drive the Taptic Engine like native{' '}
            <code>UIImpactFeedbackGenerator</code>.
          </p>
        )}
      </section>

      {info && (
        <section className="panel stack">
          <h2>Heuristic profile</h2>
          <dl className="kv">
            <dt>Platform hint</dt>
            <dd>{info.platformHint}</dd>
            <dt>Browser hint</dt>
            <dd>{info.browserHint}</dd>
            <dt>Form factor</dt>
            <dd>{info.formFactor}</dd>
            <dt>Screen</dt>
            <dd>
              {info.screenCss} @ {info.dpr}x
            </dd>
            <dt>Pointer</dt>
            <dd>{info.isCoarsePointer ? 'Coarse (touch-first)' : 'Fine (mouse/trackpad likely)'}</dd>
            <dt>Touch points</dt>
            <dd>{info.maxTouchPoints}</dd>
          </dl>
          <details className="details-ua">
            <summary>User agent string</summary>
            <pre className="ua">{info.userAgent}</pre>
          </details>
        </section>
      )}

      <section className="panel stack">
        <h2>Live test</h2>
        <p>Buttons require a direct tap (browser security). Hold the second button for a longer pattern.</p>
        <div className="row">
          <button type="button" className="btn btn-primary" onClick={() => runTest()} disabled={!effectiveTrigger}>
            Tap test
          </button>
          <button
            type="button"
            className="btn"
            onPointerDown={() => startHoldTest()}
            onPointerUp={() => stopAllHardwareOutputs()}
            onPointerLeave={() => stopAllHardwareOutputs()}
            disabled={!effectiveTrigger}
          >
            Press &amp; hold
          </button>
        </div>
        {lastTest && <p className="muted">{lastTest}</p>}
      </section>

      <section className="panel stack">
        <h2>Device outline (illustrative)</h2>
        {info && <DeviceSilhouette formFactor={info.formFactor} />}
      </section>
    </div>
  )
}
