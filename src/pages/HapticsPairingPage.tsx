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
import { stopVibrate, vibratePattern, vibrateSupported } from '../lib/vibrate'

type Role = 'pick' | 'host' | 'guest'

type HostStep = 'idle' | 'offer-ready' | 'connected'

/** Live WebRTC transport state (SDP is already exchanged; this is the network path + data channel). */
type PeerNetSnapshot = {
  ice: RTCIceConnectionState
  connection: RTCPeerConnectionState
  dataChannel?: RTCDataChannelState
}

type HostAckKind = 'instant' | 'patternState' | 'play' | 'pause' | 'sustain' | 'stopAll'
type DeliveryDot = {
  seq: number
  presetId: string
  status: 'sent' | 'ack' | 'timeout'
}

type HostPatternConfig = {
  id: string
  name: string
  durationMs: number
  events: TimelineEvent[]
}

type GuestHeartbeat = {
  sentAt: number
  sessionStartedAt: number
  sustainedLevel: number
  recentTriggers30s: number
  lockedMode: boolean
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
          WebRTC data channel with <strong>shortcode signaling</strong>: HOST generates an 5-character pair code and
          GUEST joins with that code. Manual offer/answer blob copy (compact format <code>{SIGNALING_COMPACT_PREFIX}</code>
          ) is available as fallback.
        </p>
        <p className="callout">
          Pairing is not private—anyone with the pair code or fallback blobs could connect. Use the same Wi‑Fi when
          possible; without a reachable relay path some networks can still fail.
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
        'Share the pair code with the guest. Manual blob/QR is only needed if shortcode sync fails.',
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
        'Enter the host pair code and tap “Create answer”. Manual offer paste is fallback only.',
    }
  }, [connected, busy, hasAnswer])

  return (
    <div className="signaling-progress" role="status" aria-live="polite">
      <p className="signaling-progress__title">{line.title}</p>
      <p className="signaling-progress__detail">{line.detail}</p>
    </div>
  )
}

const HOST_PATTERN_PRESETS: HostPatternConfig[] = [
  { id: 'pattern-a', name: 'Pattern A', durationMs: 2000, events: [] },
  { id: 'pattern-b', name: 'Pattern B', durationMs: 3000, events: [] },
  { id: 'pattern-c', name: 'Pattern C', durationMs: 4000, events: [] },
]

function PairingHeartbeatFooter({
  role,
  heartbeat,
  sessionStartedAt,
  onStopAll,
}: {
  role: 'host' | 'guest'
  heartbeat: GuestHeartbeat | null
  sessionStartedAt: number | null
  onStopAll?: () => void
}) {
  const [now, setNow] = useState(0)
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])

  const fmt = (ms: number) => `${Math.max(0, Math.floor(ms / 1000))}s`
  const started = heartbeat?.sessionStartedAt ?? sessionStartedAt
  const sinceStart = started ? fmt(now - started) : 'n/a'
  const sinceBeat = heartbeat ? fmt(now - heartbeat.sentAt) : 'n/a'

  return (
    <div className="pairing-footer">
      <span>
        <strong>Heartbeat ({role})</strong>
      </span>
      <span>Sustain: {heartbeat?.sustainedLevel ?? 0}</span>
      <span>30s triggers: {heartbeat?.recentTriggers30s ?? 0}</span>
      <span>Session age: {sinceStart}</span>
      <span>Since last heartbeat: {sinceBeat}</span>
      <span>Locked: {heartbeat?.lockedMode ? 'ON' : 'OFF'}</span>
      {role === 'host' && onStopAll && (
        <button type="button" className="btn btn-danger" onClick={onStopAll}>
          Stop all
        </button>
      )}
    </div>
  )
}

function HostFlow({ onBack, supported }: { onBack: () => void; supported: boolean }) {
  const MATCH_TTL_MS = 15 * 60 * 1000
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
  const [offerExpiresAt, setOfferExpiresAt] = useState<number | null>(null)
  const [showManualHost, setShowManualHost] = useState(false)
  const [lastGuestAck, setLastGuestAck] = useState<{ kind: HostAckKind; at: number } | null>(null)

  const [mode, setMode] = useState<'instant' | 'pattern' | 'sustained'>('instant')
  const [patterns, setPatterns] = useState<HostPatternConfig[]>(HOST_PATTERN_PRESETS)
  const [activePatternId, setActivePatternId] = useState(HOST_PATTERN_PRESETS[0]?.id ?? 'pattern-a')
  const [playing, setPlaying] = useState(false)
  const [loopMode, setLoopMode] = useState(false)
  const [playheadMs, setPlayheadMs] = useState(0)
  const [sustainLevel, setSustainLevel] = useState(0)
  const [deliveryDots, setDeliveryDots] = useState<DeliveryDot[]>([])
  const seqRef = useRef(1)
  const [guestHeartbeat, setGuestHeartbeat] = useState<GuestHeartbeat | null>(null)
  const [hostSessionStartedAt, setHostSessionStartedAt] = useState<number | null>(null)
  const activePattern = useMemo(
    () => patterns.find((p) => p.id === activePatternId) ?? patterns[0] ?? HOST_PATTERN_PRESETS[0],
    [patterns, activePatternId],
  )
  const durationMs = activePattern.durationMs
  const events = activePattern.events
  const playheadRaf = useRef<number | null>(null)
  const playAnchor = useRef<{ startAt: number; startPlayhead: number } | null>(null)
  const localTimeouts = useRef<number[]>([])
  const applyAnswerButtonRef = useRef<HTMLButtonElement | null>(null)
  const prevAnswerTrimmedRef = useRef('')
  const [countdownNow, setCountdownNow] = useState(() => Date.now())
  const answerReady = Boolean(answerInput.trim()) && !hostHandoff
  const answerTimeoutRemainingS =
    offerExpiresAt && step !== 'connected' ? Math.max(0, Math.ceil((offerExpiresAt - countdownNow) / 1000)) : null
  const answerTimeoutExpired = typeof answerTimeoutRemainingS === 'number' && answerTimeoutRemainingS <= 0

  const send = useCallback((msg: DcMessage) => {
    const ch = channelRef.current
    if (ch && ch.readyState === 'open') ch.send(stringifyDcMessage(msg))
  }, [])

  const clearLocalSched = useCallback(() => {
    localTimeouts.current.forEach((id) => window.clearTimeout(id))
    localTimeouts.current = []
  }, [])

  const endConnection = useCallback(
    (notifyGuest: boolean) => {
      if (notifyGuest) send({ v: 1, t: 'disconnect' })
      clearLocalSched()
      pcRef.current?.close()
      channelRef.current?.close()
      pcRef.current = null
      channelRef.current = null
      setStep('idle')
      setHostHandoff(false)
      setHostNetSnap(null)
      setPairCode('')
      setOfferExpiresAt(null)
      setOfferText('')
      setAnswerInput('')
      setLastGuestAck(null)
      setDeliveryDots([])
      setSustainLevel(0)
      setGuestHeartbeat(null)
      setHostSessionStartedAt(null)
      setError(null)
    },
    [send, clearLocalSched],
  )

  const updateActivePattern = useCallback(
    (updater: (p: HostPatternConfig) => HostPatternConfig) => {
      setPatterns((prev) => prev.map((p) => (p.id === activePatternId ? updater(p) : p)))
    },
    [activePatternId],
  )

  const schedulePatternCycle = useCallback(
    (initial: number) => {
      clearLocalSched()
      const startAt = Date.now() + 180
      playAnchor.current = { startAt, startPlayhead: initial }
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
    },
    [clearLocalSched, send, durationMs, events],
  )

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
    if (step !== 'connected') return
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
        if (loopMode) {
          setPlayheadMs(0)
          schedulePatternCycle(0)
          playheadRaf.current = requestAnimationFrame(loop)
          return
        }
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
  }, [playing, step, durationMs, send, broadcastPatternState, loopMode, schedulePatternCycle])

  useEffect(() => {
    if (step !== 'connected') return
    if (playing) return
    broadcastPatternState()
  }, [events, durationMs, step, playing, broadcastPatternState, playheadMs])

  const generateOffer = async () => {
    setError(null)
    setHostHandoff(false)
    setAnswerInput('')
    setOfferExpiresAt(null)
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
        const msg = parseDcMessage(typeof ev.data === 'string' ? ev.data : '')
        if (msg?.t === 'disconnect') {
          endConnection(false)
          setError('Guest ended the connection.')
          return
        }
        if (msg?.t === 'heartbeat') {
          setGuestHeartbeat({
            sentAt: msg.sentAt,
            sessionStartedAt: msg.sessionStartedAt,
            sustainedLevel: msg.sustainedLevel,
            recentTriggers30s: msg.recentTriggers30s,
            lockedMode: msg.lockedMode,
          })
          return
        }
        if (msg?.t === 'ack') {
          setLastGuestAck({ kind: msg.kind, at: msg.at })
          if (msg.kind === 'instant' && typeof msg.seq === 'number') {
            setDeliveryDots((prev) => prev.map((d) => (d.seq === msg.seq ? { ...d, status: 'ack' } : d)))
          }
        }
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
      setOfferExpiresAt(Date.now() + MATCH_TTL_MS)
      setStep('offer-ready')
      channel.onopen = () => {
        pushHostNet()
        setHostSessionStartedAt(Date.now())
        setHostHandoff(false)
        setStep('connected')
      }
      if (channel.readyState === 'open') {
        setHostSessionStartedAt(Date.now())
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

  useEffect(() => {
    if (!offerExpiresAt || step === 'connected') return
    const t = window.setInterval(() => setCountdownNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [offerExpiresAt, step])

  useEffect(() => {
    const trimmed = answerInput.trim()
    if (trimmed && !prevAnswerTrimmedRef.current && !hostHandoff) {
      window.setTimeout(() => {
        applyAnswerButtonRef.current?.focus()
        applyAnswerButtonRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }, 50)
    }
    prevAnswerTrimmedRef.current = trimmed
  }, [answerInput, hostHandoff])

  useEffect(() => {
    if (step !== 'connected') return
    const timer = window.setInterval(() => {
      send({ v: 1, t: 'hostHeartbeat', sentAt: Date.now() })
    }, 5000)
    return () => window.clearInterval(timer)
  }, [step, send])

  const playInstant = (presetId: string) => {
    const p = getPresetById(presetId)
    if (p) vibratePattern(p.pattern)
    const seq = seqRef.current++
    setDeliveryDots((prev) => [...prev, { seq, presetId, status: 'sent' as const }].slice(-20))
    window.setTimeout(() => {
      setDeliveryDots((prev) => prev.map((d) => (d.seq === seq && d.status === 'sent' ? { ...d, status: 'timeout' } : d)))
    }, 4000)
    send({ v: 1, t: 'instant', presetId, seq })
  }

  const sendSustainLevel = (nextLevel: number) => {
    const clamped = Math.max(0, Math.min(100, Math.round(nextLevel)))
    setSustainLevel(clamped)
    send({ v: 1, t: 'sustain', level: clamped })
  }

  const sendStopAll = () => {
    clearLocalSched()
    playAnchor.current = null
    setPlaying(false)
    setPlayheadMs(0)
    setSustainLevel(0)
    send({ v: 1, t: 'stopAll' })
  }

  const startPatternPlayback = () => {
    setPlaying(true)
    schedulePatternCycle(playheadMs)
  }

  const pausePatternPlayback = () => {
    clearLocalSched()
    playAnchor.current = null
    setPlaying(false)
    send({ v: 1, t: 'pause', playheadMs })
    broadcastPatternState({ playing: false, playheadMs })
  }

  const adjustDuration = (delta: number) => {
    updateActivePattern((p) => ({
      ...p,
      durationMs: Math.min(16000, Math.max(1000, p.durationMs + delta)),
    }))
    setPlayheadMs((p) => Math.min(Math.max(0, p), Math.min(16000, Math.max(1000, durationMs + delta))))
  }

  const addEventAtPlayhead = (presetId: string) => {
    updateActivePattern((p) => ({
      ...p,
      events: [...p.events, newEvent(quantize(playheadMs), presetId)],
    }))
  }

  const removeEvent = (id: string) => {
    updateActivePattern((p) => ({
      ...p,
      events: p.events.filter((e) => e.id !== id),
    }))
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
          Pair code: <strong>{pairCode}</strong> (share this 5-character code; match TTL 15m, active TTL 12h)
        </p>
      )}

      <HostSignalingProgress step={step} busy={busy} hostHandoff={hostHandoff} />

      {step !== 'connected' && hostNetSnap && <IcePathPanel snap={hostNetSnap} context="host" />}

      {step !== 'connected' && (
        <section className="panel stack">
          <h2>Pairing</h2>
          <ol className="steps">
            <li>
              <p>Generate an offer and share the pair code with the guest (shortcode mode).</p>
              {step === 'idle' && (
                <button type="button" className="btn btn-primary" disabled={busy} onClick={generateOffer}>
                  Generate offer
                </button>
              )}
            </li>
            <li>
              <p>Wait for guest answer via shortcode (auto-fill), then connect.</p>
              <button type="button" className="btn" onClick={() => setShowManualHost((v) => !v)}>
                {showManualHost ? 'Hide manual blob/QR fallback' : 'Show manual blob/QR fallback'}
              </button>
              {showManualHost && offerText && (
                <>
                  <p>
                    Offer ({offerText.startsWith(SIGNALING_COMPACT_PREFIX) ? 'compact' : 'JSON'}) — {offerText.length}{' '}
                    chars
                  </p>
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
                </>
              )}
              {showManualHost && (
                <p className="muted">Manual mode: paste guest answer blob below if shortcode sync is unavailable.</p>
              )}
              {showManualHost ? (
                <textarea
                  className="input mono"
                  rows={6}
                  value={answerInput}
                  onChange={(e) => setAnswerInput(e.target.value)}
                  spellCheck={false}
                  placeholder={`${SIGNALING_COMPACT_PREFIX}... or paste JSON`}
                />
              ) : (
                <p className="muted">
                  {answerInput
                    ? 'Answer received from shortcode service and ready to apply.'
                    : 'Waiting for guest answer via shortcode...'}
                </p>
              )}
              {answerReady && (
                <p className="apply-answer-ready" role="status" aria-live="polite">
                  Answer ready. Tap <strong>Apply answer</strong> now.
                  {typeof answerTimeoutRemainingS === 'number' && (
                    <>
                      {' '}
                      Expires in <strong>{answerTimeoutRemainingS}s</strong>.
                    </>
                  )}
                </p>
              )}
              {answerTimeoutExpired && (
                <p className="warn">
                  Pair-code match window expired. Generate a new offer to continue pairing.
                </p>
              )}
              <button
                ref={applyAnswerButtonRef}
                type="button"
                className={`btn btn-primary ${answerReady ? 'btn-ready-apply' : ''}`}
                disabled={busy || !answerInput.trim() || hostHandoff || answerTimeoutExpired}
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
          <div className="row wrap">
            <button type="button" className="btn btn-danger" onClick={() => endConnection(true)}>
              End connection
            </button>
          </div>
          <p className="muted">
            Guest delivery ack:{' '}
            {lastGuestAck
              ? `${lastGuestAck.kind} @ ${new Date(lastGuestAck.at).toLocaleTimeString()}`
              : 'none yet (send a test action)'}
          </p>
          <div className="delivery-dots" aria-label="Last 20 host haptic sends">
            {Array.from({ length: 20 }).map((_, idx) => {
              const dot = deliveryDots[idx]
              const cls = dot ? `delivery-dot delivery-dot--${dot.status}` : 'delivery-dot delivery-dot--idle'
              return <span key={idx} className={cls} title={dot ? `${dot.presetId} #${dot.seq} ${dot.status}` : 'idle'} />
            })}
          </div>

          <div className="panel row wrap">
            <label className="toggle">
              <span>Mode</span>
              <select value={mode} onChange={(e) => setMode(e.target.value as 'instant' | 'pattern' | 'sustained')}>
                <option value="instant">Instant</option>
                <option value="pattern">Pattern</option>
                <option value="sustained">Sustained</option>
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
                Switch between saved pattern slots below. Each pattern keeps its own timeline and duration. Loop mode is
                global and applies to whichever pattern is active.
              </p>
              <div className="row wrap">
                {patterns.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={`btn ${p.id === activePatternId ? 'btn-primary' : ''}`}
                    disabled={playing}
                    onClick={() => {
                      setActivePatternId(p.id)
                      setPlayheadMs(0)
                    }}
                  >
                    {p.name}
                  </button>
                ))}
                {playing && <span className="muted">Pause to switch patterns.</span>}
              </div>
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
                <label className="field inline">
                  <span>Loop mode</span>
                  <input type="checkbox" checked={loopMode} onChange={(e) => setLoopMode(e.target.checked)} />
                </label>
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
          {mode === 'sustained' && (
            <section className="panel stack">
              <h2>Sustained buzz</h2>
              <p className="muted">Set a continuous buzz level on GUEST (0 = off, 100 = strongest emulation).</p>
              <div className="row wrap">
                <button type="button" className="btn" onClick={() => sendSustainLevel(sustainLevel - 10)}>
                  -10
                </button>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={sustainLevel}
                  onChange={(e) => sendSustainLevel(Number(e.target.value))}
                />
                <button type="button" className="btn" onClick={() => sendSustainLevel(sustainLevel + 10)}>
                  +10
                </button>
                <span className="pill">Level {sustainLevel}</span>
              </div>
              <div className="row wrap">
                <button type="button" className="btn" onClick={() => sendSustainLevel(0)}>
                  Stop
                </button>
                <button type="button" className="btn btn-primary" onClick={() => sendSustainLevel(60)}>
                  Medium
                </button>
                <button type="button" className="btn" onClick={() => sendSustainLevel(90)}>
                  Strong
                </button>
              </div>
            </section>
          )}
          <PairingHeartbeatFooter
            role="host"
            heartbeat={guestHeartbeat}
            sessionStartedAt={hostSessionStartedAt}
            onStopAll={sendStopAll}
          />
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
  const [showManualGuest, setShowManualGuest] = useState(false)
  const [lastHostMessage, setLastHostMessage] = useState<{ kind: HostAckKind; at: number } | null>(null)
  const [guestSustainLevel, setGuestSustainLevel] = useState(0)
  const sustainTimerRef = useRef<number | null>(null)
  const guestTriggerTimesRef = useRef<number[]>([])
  const guestSessionStartedAtRef = useRef<number | null>(null)
  const guestSustainLevelRef = useRef(0)
  const guestLockedRef = useRef(false)
  const commandSinceHeartbeatRef = useRef(false)
  const lastHeartbeatSentAtRef = useRef<number | null>(null)
  const [guestSessionStartedAt, setGuestSessionStartedAt] = useState<number | null>(null)
  const [guestLastHeartbeatAt, setGuestLastHeartbeatAt] = useState<number | null>(null)
  const [guestRecentTriggers30s, setGuestRecentTriggers30s] = useState(0)
  const lastHostActivityAtRef = useRef<number | null>(null)
  const [guestSafetyStopped, setGuestSafetyStopped] = useState(false)
  const [lastHapticExecution, setLastHapticExecution] = useState<{
    at: number
    success: boolean
    reason: 'remote' | 'prime'
  } | null>(null)
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
  const hasPairCode = sessionInput.trim().length >= 5
  const [guestLocked, setGuestLocked] = useState(false)

  const clearGuestSched = () => {
    guestTimeouts.current.forEach((id) => window.clearTimeout(id))
    guestTimeouts.current = []
  }

  const stopAllGuestActions = useCallback(() => {
    clearGuestSched()
    if (sustainTimerRef.current) window.clearInterval(sustainTimerRef.current)
    sustainTimerRef.current = null
    playAnchor.current = null
    setPlaying(false)
    setPlayheadMs(0)
    setGuestSustainLevel(0)
    guestSustainLevelRef.current = 0
    stopVibrate()
  }, [])

  const endGuestConnection = useCallback((notifyHost: boolean) => {
    if (notifyHost) {
      const ch = channelRef.current
      if (ch && ch.readyState === 'open') {
        ch.send(stringifyDcMessage({ v: 1, t: 'disconnect' }))
      }
    }
    clearGuestSched()
    if (sustainTimerRef.current) window.clearInterval(sustainTimerRef.current)
    sustainTimerRef.current = null
    pcRef.current?.close()
    channelRef.current?.close()
    pcRef.current = null
    channelRef.current = null
    setConnected(false)
    setGuestNetSnap(null)
    setAnswerText('')
    setOfferIn('')
    setLastHostMessage(null)
    setGuestSustainLevel(0)
    setGuestLocked(false)
    setGuestLastHeartbeatAt(null)
    setGuestRecentTriggers30s(0)
    setGuestSessionStartedAt(null)
    commandSinceHeartbeatRef.current = false
    lastHeartbeatSentAtRef.current = null
    guestSustainLevelRef.current = 0
    guestLockedRef.current = false
    lastHostActivityAtRef.current = null
    setGuestSafetyStopped(false)
    guestSessionStartedAtRef.current = null
    guestTriggerTimesRef.current = []
  }, [])

  useEffect(() => {
    return () => {
      clearGuestSched()
      if (sustainTimerRef.current) window.clearInterval(sustainTimerRef.current)
      sustainTimerRef.current = null
      pcRef.current?.close()
    }
  }, [])

  const handleDcMessage = useCallback(
    (raw: string) => {
      const msg = parseDcMessage(raw)
      if (!msg) return
      const sendAck = (kind: HostAckKind, seq?: number) => {
        const ch = channelRef.current
        if (ch && ch.readyState === 'open') {
          ch.send(stringifyDcMessage({ v: 1, t: 'ack', kind, at: Date.now(), ...(typeof seq === 'number' ? { seq } : {}) }))
        }
      }
      if (msg.t === 'instant') {
        lastHostActivityAtRef.current = Date.now()
        setGuestSafetyStopped(false)
        commandSinceHeartbeatRef.current = true
        setLastHostMessage({ kind: 'instant', at: Date.now() })
        sendAck('instant', msg.seq)
        guestTriggerTimesRef.current.push(Date.now())
        setGuestRecentTriggers30s((n) => n + 1)
        const p = getPresetById(msg.presetId)
        if (p && supported) {
          const ok = vibratePattern(p.pattern)
          setLastHapticExecution({ at: Date.now(), success: ok, reason: 'remote' })
        }
        return
      }
      if (msg.t === 'patternState') {
        lastHostActivityAtRef.current = Date.now()
        setGuestSafetyStopped(false)
        commandSinceHeartbeatRef.current = true
        setLastHostMessage({ kind: 'patternState', at: Date.now() })
        sendAck('patternState')
        setModeView('pattern')
        setDurationMs(msg.durationMs)
        setEvents(msg.events)
        setPlaying(msg.playing)
        setPlayheadMs(msg.playheadMs)
        return
      }
      if (msg.t === 'play') {
        lastHostActivityAtRef.current = Date.now()
        setGuestSafetyStopped(false)
        commandSinceHeartbeatRef.current = true
        setLastHostMessage({ kind: 'play', at: Date.now() })
        sendAck('play')
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
            guestTriggerTimesRef.current.push(Date.now())
            setGuestRecentTriggers30s((n) => n + 1)
            const p = getPresetById(ev.presetId)
            if (p && supported) vibratePattern(p.pattern)
          }, delay0 + (ev.offsetMs - initial))
          guestTimeouts.current.push(t)
        }
        return
      }
      if (msg.t === 'pause') {
        lastHostActivityAtRef.current = Date.now()
        setGuestSafetyStopped(false)
        commandSinceHeartbeatRef.current = true
        setLastHostMessage({ kind: 'pause', at: Date.now() })
        sendAck('pause')
        clearGuestSched()
        playAnchor.current = null
        setPlaying(false)
        setPlayheadMs(msg.playheadMs)
      }
      if (msg.t === 'sustain') {
        lastHostActivityAtRef.current = Date.now()
        setGuestSafetyStopped(false)
        commandSinceHeartbeatRef.current = true
        setLastHostMessage({ kind: 'sustain', at: Date.now() })
        setGuestSustainLevel(msg.level)
        guestSustainLevelRef.current = msg.level
        sendAck('sustain')
        if (sustainTimerRef.current) {
          window.clearInterval(sustainTimerRef.current)
          sustainTimerRef.current = null
        }
        if (msg.level > 0 && supported) {
          const onMs = Math.max(20, Math.round((msg.level / 100) * 240))
          const offMs = Math.max(35, 180 - Math.round((msg.level / 100) * 120))
          const run = () => {
            const ok = vibratePattern([onMs, offMs])
            setLastHapticExecution({ at: Date.now(), success: ok, reason: 'remote' })
          }
          run()
          sustainTimerRef.current = window.setInterval(run, onMs + offMs)
        }
      }
      if (msg.t === 'stopAll') {
        lastHostActivityAtRef.current = Date.now()
        stopAllGuestActions()
        setLastHostMessage({ kind: 'stopAll', at: Date.now() })
        sendAck('stopAll')
      }
      if (msg.t === 'hostHeartbeat') {
        lastHostActivityAtRef.current = Date.now()
        setGuestSafetyStopped(false)
      }
      if (msg.t === 'disconnect') {
        lastHostActivityAtRef.current = Date.now()
        endGuestConnection(false)
        setError('Host ended the connection.')
      }
    },
    [supported, endGuestConnection, stopAllGuestActions],
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

  useEffect(() => {
    if (!connected) return
    if (!guestSessionStartedAtRef.current) {
      guestSessionStartedAtRef.current = Date.now()
      setGuestSessionStartedAt(guestSessionStartedAtRef.current)
    }
    if (!lastHostActivityAtRef.current) lastHostActivityAtRef.current = Date.now()
    const sendHeartbeat = () => {
      const ch = channelRef.current
      if (!ch || ch.readyState !== 'open') return
      const now = Date.now()
      guestTriggerTimesRef.current = guestTriggerTimesRef.current.filter((t) => now - t <= 30_000)
      setGuestRecentTriggers30s(guestTriggerTimesRef.current.length)
      ch.send(
        stringifyDcMessage({
          v: 1,
          t: 'heartbeat',
          status: 'alive',
          sentAt: now,
          sessionStartedAt: guestSessionStartedAtRef.current ?? now,
          sustainedLevel: guestSustainLevelRef.current,
          recentTriggers30s: guestTriggerTimesRef.current.length,
          lockedMode: guestLockedRef.current,
        }),
      )
      commandSinceHeartbeatRef.current = false
      lastHeartbeatSentAtRef.current = now
      setGuestLastHeartbeatAt(now)
    }
    sendHeartbeat()
    const timer = window.setInterval(() => {
      const now = Date.now()
      const last = lastHeartbeatSentAtRef.current ?? 0
      const cadence = commandSinceHeartbeatRef.current ? 5_000 : 30_000
      if (now - last >= cadence) sendHeartbeat()
    }, 1_000)
    return () => window.clearInterval(timer)
  }, [connected])

  useEffect(() => {
    if (!connected) return
    const WATCHDOG_MS = 12_000
    const timer = window.setInterval(() => {
      const last = lastHostActivityAtRef.current
      if (!last) return
      if (Date.now() - last > WATCHDOG_MS && !guestSafetyStopped) {
        stopAllGuestActions()
        setGuestSafetyStopped(true)
        setError('Safety stop: host connection lost; haptics halted.')
      }
    }, 1000)
    return () => window.clearInterval(timer)
  }, [connected, guestSafetyStopped, stopAllGuestActions])

  useEffect(() => {
    guestSustainLevelRef.current = guestSustainLevel
  }, [guestSustainLevel])

  useEffect(() => {
    guestLockedRef.current = guestLocked
  }, [guestLocked])

  const createAnswer = async () => {
    setError(null)
    setGuestNetSnap(null)
    setBusy(true)
    try {
      let resolvedOffer = offerIn.trim()
      const enteredCode = sessionInput.trim().toUpperCase()
      if (!resolvedOffer && enteredCode.length >= 5) {
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
      if (enteredCode.length >= 5) {
        await postSignalAnswer(enteredCode, ans)
      }

      const pushGuestNet = () => {
        const snap = {
          ice: pc.iceConnectionState,
          connection: pc.connectionState,
          dataChannel: channelRef.current?.readyState,
        } as const
        setGuestNetSnap(snap)
        if (snap.connection === 'failed' || snap.connection === 'disconnected' || snap.connection === 'closed') {
          stopAllGuestActions()
        }
      }
      pc.addEventListener('iceconnectionstatechange', pushGuestNet)
      pc.addEventListener('connectionstatechange', pushGuestNet)
      pushGuestNet()

      const ch = await waitForChannel()
      channelRef.current = ch
      ch.addEventListener('open', () => {
        pushGuestNet()
        lastHostActivityAtRef.current = Date.now()
        setGuestSafetyStopped(false)
        setConnected(true)
      })
      ch.addEventListener('closing', () => {
        stopAllGuestActions()
      })
      ch.addEventListener('close', () => {
        stopAllGuestActions()
      })
      ch.addEventListener('closing', pushGuestNet)
      pushGuestNet()
      ch.onmessage = (ev) => handleDcMessage(typeof ev.data === 'string' ? ev.data : '')
      if (ch.readyState === 'open') {
        pushGuestNet()
        lastHostActivityAtRef.current = Date.now()
        setGuestSafetyStopped(false)
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
            <input className="input" value={sessionInput} onChange={(e) => setSessionInput(e.target.value.toUpperCase())} maxLength={8} />
          </label>
          <button type="button" className="btn" onClick={() => setShowManualGuest((v) => !v)}>
            {showManualGuest ? 'Hide manual blob/QR fallback' : 'Show manual blob/QR fallback'}
          </button>
          {showManualGuest && (
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
          )}
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || (!offerIn.trim() && !hasPairCode)}
            onClick={createAnswer}
          >
            Create answer
          </button>
          {answerText && (
            <>
              {!showManualGuest ? (
                <p className="muted">Answer posted via shortcode. Wait for host to apply and connect.</p>
              ) : (
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
            </>
          )}
          {error && <p className="warn">{error}</p>}
        </section>
      )}

      {connected && (
        <section className={`panel stack ${guestLocked ? 'guest-locked-mode' : ''}`}>
          <h2>Receiving haptics</h2>
          <p className="ok">Connected. This UI is read-only.</p>
          <div className="row wrap">
            <button type="button" className="btn btn-danger" onClick={() => endGuestConnection(true)}>
              End connection
            </button>
            <button type="button" className="btn" onClick={() => setGuestLocked((v) => !v)}>
              {guestLocked ? 'Unlock mode' : 'Locked mode'}
            </button>
          </div>
          <div className="panel stack">
            <p className="muted">
              Signal received: <strong>{lastHostMessage ? 'Yes' : 'No'}</strong> | Haptics supported:{' '}
              <strong>{supported ? 'Yes' : 'No'}</strong>
            </p>
            {lastHapticExecution && (
              <p className={lastHapticExecution.success ? 'ok' : 'warn'}>
                Last haptic execution ({lastHapticExecution.reason}) at{' '}
                {new Date(lastHapticExecution.at).toLocaleTimeString()}:{' '}
                {lastHapticExecution.success ? 'vibrate() accepted' : 'vibrate() returned false'}
              </p>
            )}
            <div className="row wrap">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  const ok = supported ? vibratePattern([25, 40, 25]) : false
                  setLastHapticExecution({ at: Date.now(), success: ok, reason: 'prime' })
                }}
                disabled={!supported}
              >
                Prime haptics (tap once)
              </button>
              <p className="muted">
                Some browsers require a direct user gesture before background/remote-triggered vibrations reliably fire.
              </p>
            </div>
          </div>
          <p className="muted">
            Last host command:{' '}
            {lastHostMessage
              ? `${lastHostMessage.kind} @ ${new Date(lastHostMessage.at).toLocaleTimeString()}`
              : 'none yet'}
          </p>
          {lastHostMessage?.kind === 'sustain' && <p className="muted">Current sustained level: {guestSustainLevel}</p>}
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
          {guestLocked && (
            <div className="guest-lock-overlay">
              <p>Locked mode enabled. Screen dimmed and touch input is blocked.</p>
              <button type="button" className="btn btn-primary" onClick={() => setGuestLocked(false)}>
                Unlock
              </button>
            </div>
          )}
        </section>
      )}
      {connected && (
        <PairingHeartbeatFooter
          role="guest"
          heartbeat={
            guestLastHeartbeatAt
              ? {
                  sentAt: guestLastHeartbeatAt,
                  sessionStartedAt: guestSessionStartedAt ?? guestLastHeartbeatAt,
                  sustainedLevel: guestSustainLevel,
                  recentTriggers30s: guestRecentTriggers30s,
                  lockedMode: guestLocked,
                }
              : null
          }
          sessionStartedAt={guestSessionStartedAt}
        />
      )}
    </div>
  )
}
