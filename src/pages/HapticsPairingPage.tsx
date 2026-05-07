import { QRCodeSVG } from 'qrcode.react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { HAPTIC_PRESETS, getPresetById } from '../lib/hapticPresets'
import { QR_SAFE_MAX_LEN } from '../lib/signaling'
import { SIGNALING_COMPACT_PREFIX } from '../lib/signalingCodec'
import { generateSessionId } from '../lib/sessionId'
import { createSignalSession, getSignalState, postSignalAnswer, postSignalOffer } from '../lib/signalApi'
import {
  hostApplyAnswer,
  hostCreateOffer,
  guestHandleOffer,
  parseDcMessage,
  stringifyDcMessage,
  type DcMessage,
  type TimelineEvent,
} from '../lib/webrtc'
import { vibratePattern, vibrateSupported } from '../lib/vibrate'

type Role = 'pick' | 'host' | 'guest'

type HostStep = 'idle' | 'offer-ready' | 'connected'

/** Live WebRTC transport state (SDP is already exchanged; this is the network path + data channel). */
type PeerNetSnapshot = {
  ice: RTCIceConnectionState
  connection: RTCPeerConnectionState
  dataChannel?: RTCDataChannelState
}

function IcePathPanel({ snap, context }: { snap: PeerNetSnapshot | null; context: 'host' | 'guest' }) {
  if (!snap) return null
  const iceFailed = snap.ice === 'failed'
  const connFailed = snap.connection === 'failed'

  return (
    <div className="ice-path-panel">
      <p className="muted ice-path-panel__line">
        <strong>Network path:</strong> ICE <code>{snap.ice}</code>, peers <code>{snap.connection}</code>
        {snap.dataChannel !== undefined && (
          <>
            , data channel <code>{snap.dataChannel}</code>
          </>
        )}
      </p>
      {!iceFailed && !connFailed && (snap.ice === 'checking' || snap.connection === 'connecting') && (
        <p className="muted">
          {context === 'host'
            ? 'Still trying to reach the guest over the network (not a copy/paste step). Can take 15–30s.'
            : 'Still trying to reach the host over the network. Ensure they already tapped “Apply answer” with your latest answer.'}
        </p>
      )}
      {(iceFailed || connFailed) && (
        <p className="warn">
          The browsers could not establish a link. This can happen with restrictive NAT/firewalls, network filtering, or
          invalid/expired TURN credentials. Try <strong>both devices on the same Wi‑Fi</strong>, turn off VPNs, or use
          one phone’s hotspot for the other—then run <strong>Generate offer</strong> again on the host and redo the
          blobs.
        </p>
      )}
    </div>
  )
}

function newEvent(offsetMs: number, presetId: string): TimelineEvent {
  return { id: crypto.randomUUID(), offsetMs, presetId }
}

function quantize(ms: number, grid = 50): number {
  return Math.round(ms / grid) * grid
}

export function HapticsPairingPage() {
  const supported = vibrateSupported()
  const [role, setRole] = useState<Role>('pick')

  if (role === 'pick') {
    return (
      <div className="page stack">
        <h1>Haptics pairing</h1>
        <p className="lede">
          WebRTC data channel with <strong>manual signaling</strong>: copy or scan offer/answer blobs between devices.
          Blobs are usually <strong>gzip-compressed and base64url-encoded</strong> (prefix <code>{SIGNALING_COMPACT_PREFIX}</code>
          ) for a shorter paste; plain JSON still works. The session code is only a human label.
        </p>
        <p className="callout">
          Pairing is not private—anyone with the blobs could connect. Use the same Wi‑Fi when possible; without TURN,
          some networks will fail.
        </p>
        <div className="row">
          <button type="button" className="btn btn-primary" onClick={() => setRole('host')}>
            I am HOST
          </button>
          <button type="button" className="btn" onClick={() => setRole('guest')}>
            I am GUEST
          </button>
        </div>
      </div>
    )
  }

  if (role === 'host') {
    return <HostFlow onBack={() => setRole('pick')} supported={supported} />
  }

  return <GuestFlow onBack={() => setRole('pick')} supported={supported} />
}

function HostSignalingProgress({
  step,
  busy,
  hostHandoff,
}: {
  step: HostStep
  busy: boolean
  hostHandoff: boolean
}) {
  const line = useMemo(() => {
    if (step === 'connected') {
      return {
        title: 'Connected',
        detail: 'Data channel is open. You can send haptics to the guest.',
      }
    }
    if (step === 'idle' && busy) {
      return {
        title: 'Step 1 of 4 — Working…',
        detail: 'Creating the WebRTC offer and gathering ICE candidates (network discovery). This can take a few seconds.',
      }
    }
    if (step === 'idle') {
      return {
        title: 'Step 1 of 4 — Start',
        detail:
          'Tap “Generate offer” once and wait for the blob to appear. Tapping again while it’s working can invalidate pairing.',
      }
    }
    if (step === 'offer-ready' && busy) {
      return {
        title: 'Step 3 of 4 — Working…',
        detail: 'Applying the guest’s answer and finishing ICE on this device.',
      }
    }
    if (step === 'offer-ready' && hostHandoff) {
      return {
        title: 'Step 4 of 4 — Network in progress',
        detail:
          'Signaling is done. The data channel opens only after ICE/DTLS succeeds between devices. Check “Network path” below—if ICE fails, use the same Wi‑Fi or a hotspot and generate a new offer.',
      }
    }
    return {
      title: 'Step 2 of 4 — Share the offer',
      detail:
        'Send the offer blob to the guest (copy, QR, or AirDrop). When they send back an answer, paste it below and tap “Apply answer”.',
    }
  }, [step, busy, hostHandoff])

  return (
    <div className="signaling-progress" role="status" aria-live="polite">
      <p className="signaling-progress__title">{line.title}</p>
      <p className="signaling-progress__detail">{line.detail}</p>
    </div>
  )
}

function GuestSignalingProgress({
  connected,
  busy,
  hasAnswer,
}: {
  connected: boolean
  busy: boolean
  hasAnswer: boolean
}) {
  const line = useMemo(() => {
    if (connected) {
      return {
        title: 'Connected',
        detail: 'Listening for haptics from the host. This screen stays read-only.',
      }
    }
    if (busy && !hasAnswer) {
      return {
        title: 'Step 2 of 4 — Working…',
        detail:
          'Parsing the offer, creating an answer, and gathering ICE candidates. On some phones this can take 10–20 seconds.',
      }
    }
    if (busy && hasAnswer) {
      return {
        title: 'Step 3 of 4 — Waiting for network',
        detail:
          'Answer is ready—send it to the host if you have not. Waiting for ICE/DTLS: the devices must find a direct network path (see “Network path” below).',
      }
    }
    if (hasAnswer) {
      return {
        title: 'Step 3 of 4 — Send the answer',
        detail:
          'Copy or QR the answer to the host. After they tap “Apply answer”, the data channel opens only if ICE connects (same Wi‑Fi often required).',
      }
    }
    return {
      title: 'Step 1 of 4 — Prepare',
      detail:
        'Optionally type the host’s session code for your notes, paste the offer they gave you, then tap “Create answer”.',
    }
  }, [connected, busy, hasAnswer])

  return (
    <div className="signaling-progress" role="status" aria-live="polite">
      <p className="signaling-progress__title">{line.title}</p>
      <p className="signaling-progress__detail">{line.detail}</p>
    </div>
  )
}

function HostFlow({ onBack, supported }: { onBack: () => void; supported: boolean }) {
  const sessionId = useMemo(() => generateSessionId(), [])
  const [step, setStep] = useState<HostStep>('idle')
  const [busy, setBusy] = useState(false)
  const [hostHandoff, setHostHandoff] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const channelRef = useRef<RTCDataChannel | null>(null)
  /** Ignores stale async completions if “Generate offer” is clicked again while ICE is still running */
  const hostOfferGenerationRef = useRef(0)
  const [hostNetSnap, setHostNetSnap] = useState<PeerNetSnapshot | null>(null)
  const [offerText, setOfferText] = useState('')
  const [answerInput, setAnswerInput] = useState('')
  const [pairCode, setPairCode] = useState('')

  const [mode, setMode] = useState<'instant' | 'pattern'>('instant')
  const [durationMs, setDurationMs] = useState(2000)
  const [events, setEvents] = useState<TimelineEvent[]>([])
  const [playing, setPlaying] = useState(false)
  const [playheadMs, setPlayheadMs] = useState(0)
  const playheadRaf = useRef<number | null>(null)
  const playAnchor = useRef<{ startAt: number; startPlayhead: number } | null>(null)
  const localTimeouts = useRef<number[]>([])

  const send = useCallback((msg: DcMessage) => {
    const ch = channelRef.current
    if (ch && ch.readyState === 'open') ch.send(stringifyDcMessage(msg))
  }, [])

  const clearLocalSched = useCallback(() => {
    localTimeouts.current.forEach((id) => window.clearTimeout(id))
    localTimeouts.current = []
  }, [])

  const broadcastPatternState = useCallback(
    (overrides?: Partial<{ playing: boolean; playheadMs: number }>) => {
      send({
        v: 1,
        t: 'patternState',
        durationMs,
        events,
        playheadMs: overrides?.playheadMs ?? playheadMs,
        playing: overrides?.playing ?? playing,
      })
    },
    [durationMs, events, playheadMs, playing, send],
  )

  useEffect(() => {
    if (step !== 'connected' || mode !== 'pattern') return
    if (!playing) {
      if (playheadRaf.current) cancelAnimationFrame(playheadRaf.current)
      playheadRaf.current = null
      return
    }
    const loop = () => {
      const anchor = playAnchor.current
      if (!anchor) return
      const elapsed = Date.now() - anchor.startAt
      const next = Math.min(durationMs, anchor.startPlayhead + elapsed)
      setPlayheadMs(next)
      if (next >= durationMs) {
        setPlaying(false)
        playAnchor.current = null
        send({ v: 1, t: 'pause', playheadMs: durationMs })
        broadcastPatternState({ playing: false, playheadMs: durationMs })
        return
      }
      playheadRaf.current = requestAnimationFrame(loop)
    }
    playheadRaf.current = requestAnimationFrame(loop)
    return () => {
      if (playheadRaf.current) cancelAnimationFrame(playheadRaf.current)
    }
  }, [playing, step, mode, durationMs, send, broadcastPatternState])

  useEffect(() => {
    if (step !== 'connected' || mode !== 'pattern') return
    if (playing) return
    broadcastPatternState()
  }, [events, durationMs, step, mode, playing, broadcastPatternState, playheadMs])

  const generateOffer = async () => {
    setError(null)
    setHostHandoff(false)
    setAnswerInput('')
    setHostNetSnap(null)
    const gen = ++hostOfferGenerationRef.current
    setBusy(true)
    try {
      pcRef.current?.close()
      const { pc, channel, offerText: text } = await hostCreateOffer()
      if (gen !== hostOfferGenerationRef.current) {
        pc.close()
        return
      }
      pcRef.current = pc
      channelRef.current = channel
      channel.onmessage = (ev) => {
        /* host typically does not need guest messages */
        void ev
      }
      const pushHostNet = () => {
        setHostNetSnap({
          ice: pc.iceConnectionState,
          connection: pc.connectionState,
          dataChannel: channel.readyState,
        })
      }
      pc.addEventListener('iceconnectionstatechange', pushHostNet)
      pc.addEventListener('connectionstatechange', pushHostNet)
      channel.addEventListener('open', pushHostNet)
      pushHostNet()
      setOfferText(text)
      const signal = await createSignalSession()
      setPairCode(signal.code)
      await postSignalOffer(signal.code, text)
      setStep('offer-ready')
      channel.onopen = () => {
        pushHostNet()
        setHostHandoff(false)
        setStep('connected')
      }
      if (channel.readyState === 'open') {
        setHostHandoff(false)
        setStep('connected')
      }
    } catch (e) {
      if (gen === hostOfferGenerationRef.current) {
        setError(e instanceof Error ? e.message : 'Failed to create offer')
      }
    } finally {
      if (gen === hostOfferGenerationRef.current) {
        setBusy(false)
      }
    }
  }

  const applyAnswer = async () => {
    const pc = pcRef.current
    if (!pc) return
    setError(null)
    setBusy(true)
    try {
      await hostApplyAnswer(pc, answerInput.trim())
      setHostHandoff(true)
    } catch (e) {
      setHostHandoff(false)
      setError(e instanceof Error ? e.message : 'Invalid answer')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!pairCode || step === 'connected') return
    const timer = window.setInterval(async () => {
      try {
        const s = await getSignalState(pairCode)
        if (s.answer && !answerInput) {
          setAnswerInput(s.answer)
        }
      } catch {
        /* best-effort polling */
      }
    }, 2000)
    return () => window.clearInterval(timer)
  }, [pairCode, step, answerInput])

  const playInstant = (presetId: string) => {
    const p = getPresetById(presetId)
    if (p) vibratePattern(p.pattern)
    send({ v: 1, t: 'instant', presetId })
  }

  const startPatternPlayback = () => {
    clearLocalSched()
    const startAt = Date.now() + 180
    const initial = playheadMs
    playAnchor.current = { startAt, startPlayhead: initial }
    setPlaying(true)
    send({ v: 1, t: 'play', startAt, durationMs, events, initialPlayheadMs: initial })

    const now = Date.now()
    const delay0 = Math.max(0, startAt - now)
    for (const ev of events) {
      if (ev.offsetMs < initial) continue
      const t = window.setTimeout(() => {
        const p = getPresetById(ev.presetId)
        if (p) vibratePattern(p.pattern)
      }, delay0 + (ev.offsetMs - initial))
      localTimeouts.current.push(t)
    }
  }

  const pausePatternPlayback = () => {
    clearLocalSched()
    playAnchor.current = null
    setPlaying(false)
    send({ v: 1, t: 'pause', playheadMs })
    broadcastPatternState({ playing: false, playheadMs })
  }

  const adjustDuration = (delta: number) => {
    setDurationMs((d) => Math.min(16000, Math.max(1000, d + delta)))
  }

  const addEventAtPlayhead = (presetId: string) => {
    setEvents((ev) => [...ev, newEvent(quantize(playheadMs), presetId)])
  }

  const removeEvent = (id: string) => {
    setEvents((ev) => ev.filter((e) => e.id !== id))
  }

  const onTimelineClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (playing) return
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect()
    const x = e.clientX - rect.left
    const ratio = Math.min(1, Math.max(0, x / rect.width))
    const ms = quantize(ratio * durationMs)
    setPlayheadMs(ms)
  }

  return (
    <div className="page stack">
      <div className="row spread">
        <h1>HOST</h1>
        <button type="button" className="btn btn-ghost" onClick={onBack}>
          Change role
        </button>
      </div>
      <p className="session-code">
        Session code: <strong>{sessionId}</strong> (read this aloud to the guest for verification)
      </p>
      {pairCode && (
        <p className="session-code">
          Pair code: <strong>{pairCode}</strong> (share this 8-character code; match TTL 15m, active TTL 12h)
        </p>
      )}

      <HostSignalingProgress step={step} busy={busy} hostHandoff={hostHandoff} />

      {step !== 'connected' && hostNetSnap && <IcePathPanel snap={hostNetSnap} context="host" />}

      {step !== 'connected' && (
        <section className="panel stack">
          <h2>Manual signaling</h2>
          <ol className="steps">
            <li>
              <p>Generate an offer. Share the pair code with the guest. Blob copy/QR remains available as fallback.</p>
              {step === 'idle' && (
                <button type="button" className="btn btn-primary" disabled={busy} onClick={generateOffer}>
                  Generate offer
                </button>
              )}
            </li>
            {offerText && (
              <li>
                <p>Offer ({offerText.startsWith(SIGNALING_COMPACT_PREFIX) ? 'compact' : 'JSON'}) — {offerText.length} chars</p>
                <div className="row wrap">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => navigator.clipboard.writeText(offerText).catch(() => {})}
                  >
                    Copy offer
                  </button>
                  {offerText.length <= QR_SAFE_MAX_LEN ? (
                    <div className="qr-box">
                      <QRCodeSVG value={offerText} size={160} level="L" />
                    </div>
                  ) : (
                    <p className="muted">Offer too large for QR ({offerText.length} chars). Use copy instead.</p>
                  )}
                </div>
                <textarea className="input mono" readOnly rows={4} value={offerText} spellCheck={false} />
              </li>
            )}
            <li>
              <p>Paste the answer from the GUEST (or wait for auto-fill from pair code), then connect.</p>
              <textarea
                className="input mono"
                rows={6}
                value={answerInput}
                onChange={(e) => setAnswerInput(e.target.value)}
                spellCheck={false}
                placeholder={`${SIGNALING_COMPACT_PREFIX}... or paste JSON`}
              />
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || !answerInput.trim() || hostHandoff}
                onClick={applyAnswer}
              >
                Apply answer
              </button>
              {hostHandoff && (
                <p className="muted">Answer applied—waiting for the data channel. If it fails, use “Generate offer” to start over.</p>
              )}
            </li>
          </ol>
          {error && <p className="warn">{error}</p>}
        </section>
      )}

      {step === 'connected' && (
        <>
          <p className="ok">Data channel open. Use the panel below; the guest device will mirror pattern view.</p>

          <div className="panel row wrap">
            <label className="toggle">
              <span>Mode</span>
              <select value={mode} onChange={(e) => setMode(e.target.value as 'instant' | 'pattern')}>
                <option value="instant">Instant</option>
                <option value="pattern">Pattern</option>
              </select>
            </label>
          </div>

          {mode === 'instant' && (
            <section className="panel stack">
              <h2>Haptic actions</h2>
              {!supported && <p className="muted">This device cannot vibrate, but commands still send to the guest.</p>}
              <div className="preset-grid">
                {HAPTIC_PRESETS.map((p) => (
                  <button key={p.id} type="button" className="preset-cell" onClick={() => playInstant(p.id)}>
                    <span className="preset-name">{p.name}</span>
                  </button>
                ))}
              </div>
            </section>
          )}

          {mode === 'pattern' && (
            <section className="panel stack">
              <h2>Pattern timeline</h2>
              <p className="muted">
                Sheet-style timeline: add haptic “notes”, extend length, play/pause. Guests see updates but cannot edit.
              </p>
              <div className="row wrap">
                <button type="button" className="btn" onClick={() => adjustDuration(-1000)} disabled={durationMs <= 1000}>
                  −1s
                </button>
                <button type="button" className="btn" onClick={() => adjustDuration(1000)} disabled={durationMs >= 16000}>
                  +1s
                </button>
                <span className="pill">
                  Length {(durationMs / 1000).toFixed(0)}s (1–16s)
                </span>
                {!playing ? (
                  <button type="button" className="btn btn-primary" onClick={startPatternPlayback}>
                    Play
                  </button>
                ) : (
                  <button type="button" className="btn" onClick={pausePatternPlayback}>
                    Pause
                  </button>
                )}
              </div>

              <div
                className="timeline"
                onClick={onTimelineClick}
                role="slider"
                aria-valuemin={0}
                aria-valuemax={durationMs}
                aria-valuenow={playheadMs}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (playing) return
                  if (e.key === 'ArrowRight') setPlayheadMs((p) => quantize(Math.min(durationMs, p + 100)))
                  if (e.key === 'ArrowLeft') setPlayheadMs((p) => quantize(Math.max(0, p - 100)))
                }}
              >
                <div className="timeline-inner">
                  {events.map((ev) => (
                    <button
                      key={ev.id}
                      type="button"
                      className="timeline-note"
                      style={{ left: `${(ev.offsetMs / durationMs) * 100}%` }}
                      title={`${ev.presetId} @ ${ev.offsetMs}ms`}
                      onClick={(e) => {
                        e.stopPropagation()
                        if (!playing) setPlayheadMs(ev.offsetMs)
                      }}
                    />
                  ))}
                  <div className="timeline-playhead" style={{ left: `${(playheadMs / durationMs) * 100}%` }} />
                </div>
              </div>

              <div className="row wrap">
                <label className="field inline">
                  <span>Add at playhead</span>
                  <select
                    key={events.length}
                    defaultValue=""
                    onChange={(e) => {
                      const v = e.target.value
                      if (v) addEventAtPlayhead(v)
                    }}
                    disabled={playing}
                  >
                    <option value="">Select preset…</option>
                    {HAPTIC_PRESETS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <ul className="event-list">
                {events.map((ev) => {
                  const p = getPresetById(ev.presetId)
                  return (
                    <li key={ev.id} className="event-row">
                      <span>
                        {p?.name ?? ev.presetId} @ {ev.offsetMs}ms
                      </span>
                      <button type="button" className="btn btn-ghost" disabled={playing} onClick={() => removeEvent(ev.id)}>
                        Remove
                      </button>
                    </li>
                  )
                })}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  )
}

function GuestFlow({ onBack, supported }: { onBack: () => void; supported: boolean }) {
  const [sessionInput, setSessionInput] = useState('')
  const [offerIn, setOfferIn] = useState('')
  const [answerText, setAnswerText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const [guestNetSnap, setGuestNetSnap] = useState<PeerNetSnapshot | null>(null)
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const channelRef = useRef<RTCDataChannel | null>(null)
  const guestTimeouts = useRef<number[]>([])

  const [modeView, setModeView] = useState<'instant' | 'pattern'>('instant')
  const [durationMs, setDurationMs] = useState(2000)
  const [events, setEvents] = useState<TimelineEvent[]>([])
  const [playing, setPlaying] = useState(false)
  const [playheadMs, setPlayheadMs] = useState(0)
  const playheadRaf = useRef<number | null>(null)
  const playAnchor = useRef<{ startAt: number; startPlayhead: number } | null>(null)

  const clearGuestSched = () => {
    guestTimeouts.current.forEach((id) => window.clearTimeout(id))
    guestTimeouts.current = []
  }

  useEffect(() => {
    return () => {
      clearGuestSched()
      pcRef.current?.close()
    }
  }, [])

  const handleDcMessage = useCallback(
    (raw: string) => {
      const msg = parseDcMessage(raw)
      if (!msg) return
      if (msg.t === 'instant') {
        const p = getPresetById(msg.presetId)
        if (p && supported) vibratePattern(p.pattern)
        return
      }
      if (msg.t === 'patternState') {
        setModeView('pattern')
        setDurationMs(msg.durationMs)
        setEvents(msg.events)
        setPlaying(msg.playing)
        setPlayheadMs(msg.playheadMs)
        return
      }
      if (msg.t === 'play') {
        setModeView('pattern')
        clearGuestSched()
        setDurationMs(msg.durationMs)
        setEvents(msg.events)
        setPlaying(true)
        const startAt = msg.startAt
        const initial = msg.initialPlayheadMs
        setPlayheadMs(initial)
        const now = Date.now()
        const delay0 = Math.max(0, startAt - now)
        playAnchor.current = { startAt, startPlayhead: initial }
        for (const ev of msg.events) {
          if (ev.offsetMs < initial) continue
          const t = window.setTimeout(() => {
            const p = getPresetById(ev.presetId)
            if (p && supported) vibratePattern(p.pattern)
          }, delay0 + (ev.offsetMs - initial))
          guestTimeouts.current.push(t)
        }
        return
      }
      if (msg.t === 'pause') {
        clearGuestSched()
        playAnchor.current = null
        setPlaying(false)
        setPlayheadMs(msg.playheadMs)
      }
    },
    [supported],
  )

  useEffect(() => {
    if (!connected || modeView !== 'pattern' || !playing) {
      if (playheadRaf.current) cancelAnimationFrame(playheadRaf.current)
      playheadRaf.current = null
      return
    }
    const loop = () => {
      const anchor = playAnchor.current
      if (!anchor) return
      const elapsed = Date.now() - anchor.startAt
      const next = Math.min(durationMs, anchor.startPlayhead + elapsed)
      setPlayheadMs(next)
      if (next >= durationMs) {
        setPlaying(false)
        playAnchor.current = null
        return
      }
      playheadRaf.current = requestAnimationFrame(loop)
    }
    playheadRaf.current = requestAnimationFrame(loop)
    return () => {
      if (playheadRaf.current) cancelAnimationFrame(playheadRaf.current)
    }
  }, [connected, modeView, playing, durationMs])

  const createAnswer = async () => {
    setError(null)
    setGuestNetSnap(null)
    setBusy(true)
    try {
      let resolvedOffer = offerIn.trim()
      const enteredCode = sessionInput.trim().toUpperCase()
      if (!resolvedOffer && enteredCode.length >= 6) {
        const s = await getSignalState(enteredCode)
        if (!s.offer) throw new Error('Host offer is not ready for this code yet')
        resolvedOffer = s.offer
        setOfferIn(resolvedOffer)
      }
      if (!resolvedOffer) throw new Error('Paste an offer or enter a valid pair code')
      pcRef.current?.close()
      const { pc, answerText: ans, waitForChannel } = await guestHandleOffer(resolvedOffer)
      pcRef.current = pc
      setAnswerText(ans)
      if (enteredCode.length >= 6) {
        await postSignalAnswer(enteredCode, ans)
      }

      const pushGuestNet = () => {
        setGuestNetSnap({
          ice: pc.iceConnectionState,
          connection: pc.connectionState,
          dataChannel: channelRef.current?.readyState,
        })
      }
      pc.addEventListener('iceconnectionstatechange', pushGuestNet)
      pc.addEventListener('connectionstatechange', pushGuestNet)
      pushGuestNet()

      const ch = await waitForChannel()
      channelRef.current = ch
      ch.addEventListener('open', () => {
        pushGuestNet()
        setConnected(true)
      })
      ch.addEventListener('closing', pushGuestNet)
      pushGuestNet()
      ch.onmessage = (ev) => handleDcMessage(typeof ev.data === 'string' ? ev.data : '')
      if (ch.readyState === 'open') {
        pushGuestNet()
        setConnected(true)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to handle offer')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page stack guest">
      <div className="row spread">
        <h1>GUEST</h1>
        <button type="button" className="btn btn-ghost" onClick={onBack}>
          Change role
        </button>
      </div>
      <p className="lede">
        Enter the HOST pair code to fetch/post signaling automatically, or use manual blob paste as fallback.
      </p>

      <GuestSignalingProgress connected={connected} busy={busy} hasAnswer={Boolean(answerText)} />

      {!connected && guestNetSnap && <IcePathPanel snap={guestNetSnap} context="guest" />}

      {!connected && (
        <section className="panel stack">
          <label className="field">
            <span>HOST pair code (shortcode mode)</span>
            <input className="input" value={sessionInput} onChange={(e) => setSessionInput(e.target.value.toUpperCase())} maxLength={12} />
          </label>
          <label className="field">
            <span>Paste offer from HOST</span>
            <textarea
              className="input mono"
              rows={6}
              value={offerIn}
              onChange={(e) => setOfferIn(e.target.value)}
              spellCheck={false}
              placeholder={`${SIGNALING_COMPACT_PREFIX}… or JSON`}
            />
          </label>
          <button type="button" className="btn btn-primary" disabled={busy || !offerIn.trim()} onClick={createAnswer}>
            Create answer
          </button>
          {answerText && (
            <>
              <p>
                Send this answer to the HOST ({answerText.startsWith(SIGNALING_COMPACT_PREFIX) ? 'compact' : 'JSON'}) —{' '}
                {answerText.length} chars (copy or QR).
              </p>
              <div className="row wrap">
                <button type="button" className="btn" onClick={() => navigator.clipboard.writeText(answerText).catch(() => {})}>
                  Copy answer
                </button>
                {answerText.length <= QR_SAFE_MAX_LEN ? (
                  <div className="qr-box">
                    <QRCodeSVG value={answerText} size={160} level="L" />
                  </div>
                ) : (
                  <p className="muted">Answer too large for QR. Use copy.</p>
                )}
              </div>
              <textarea className="input mono" readOnly rows={4} value={answerText} spellCheck={false} />
            </>
          )}
          {error && <p className="warn">{error}</p>}
        </section>
      )}

      {connected && (
        <section className="panel stack">
          <h2>Receiving haptics</h2>
          <p className="ok">Connected. This UI is read-only.</p>
          {!supported && <p className="warn">Vibration API not available—patterns will not be felt here.</p>}
          {modeView === 'instant' && <p className="muted">Waiting for instant taps from the host…</p>}
          {modeView === 'pattern' && (
            <>
              <h3>Timeline (mirror)</h3>
              <div className="timeline timeline--readonly">
                <div className="timeline-inner">
                  {events.map((ev) => (
                    <div
                      key={ev.id}
                      className="timeline-note timeline-note--readonly"
                      style={{ left: `${(ev.offsetMs / durationMs) * 100}%` }}
                    />
                  ))}
                  <div className="timeline-playhead" style={{ left: `${(playheadMs / durationMs) * 100}%` }} />
                </div>
              </div>
              <p className="muted">
                {playing ? 'Playing…' : 'Paused'} — {(durationMs / 1000).toFixed(1)}s
              </p>
            </>
          )}
        </section>
      )}
    </div>
  )
}
