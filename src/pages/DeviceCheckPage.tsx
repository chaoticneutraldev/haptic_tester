import { useCallback, useEffect, useState } from 'react'
import { collectDeviceInfo, type DeviceInfo } from '../lib/deviceDetect'
import { vibratePattern, vibrateSupported, stopVibrate } from '../lib/vibrate'
import { DeviceSilhouette } from '../components/DeviceSilhouette'

export function DeviceCheckPage() {
  const [info, setInfo] = useState<DeviceInfo | null>(null)
  const [lastTest, setLastTest] = useState<string | null>(null)
  const supported = vibrateSupported()

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
    if (!supported) {
      setLastTest('Vibration API not available in this browser.')
      return
    }
    const ok = vibratePattern([25, 50, 25])
    setLastTest(ok ? 'Short pattern fired.' : 'vibrate() returned false.')
  }, [supported])

  const startHoldTest = useCallback(() => {
    if (!supported) {
      setLastTest('Vibration API not available in this browser.')
      return
    }
    const ok = vibratePattern([800])
    setLastTest(ok ? 'Long pulse while held…' : 'vibrate() returned false.')
  }, [supported])

  const isIosSafari =
    typeof navigator !== 'undefined' &&
    /iPhone|iPad|iPod/i.test(navigator.userAgent) &&
    /Safari/i.test(navigator.userAgent) &&
    !/CriOS|FxiOS/i.test(navigator.userAgent)

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
            <span className="warn">Not available (common on iOS Safari)</span>
          )}
        </p>
        {isIosSafari && (
          <p className="callout">
            iOS Safari does not implement the standard Vibration API. Patterns here will not drive the Taptic Engine
            like native <code>UIImpactFeedbackGenerator</code>.
          </p>
        )}
      </section>

      {info && (
        <section className="panel stack">
          <h2>Heuristic profile</h2>
          <dl className="kv">
            <dt>Platform hint</dt>
            <dd>{info.platformHint}</dd>
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
          <button type="button" className="btn btn-primary" onClick={() => runTest()} disabled={!supported}>
            Tap test
          </button>
          <button
            type="button"
            className="btn"
            onPointerDown={() => startHoldTest()}
            onPointerUp={() => stopVibrate()}
            onPointerLeave={() => stopVibrate()}
            disabled={!supported}
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
