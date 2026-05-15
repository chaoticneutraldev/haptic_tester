import { QRCodeSVG } from 'qrcode.react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { HAPTIC_PRESETS, getPresetById } from '../lib/hapticPresets'
import { RECOMMENDED_PATTERN_DURATION_MS, RECOMMENDED_PATTERN_EVENTS } from '../lib/recommendedPattern'
import { QR_SAFE_MAX_LEN } from '../lib/signaling'
import { SIGNALING_COMPACT_PREFIX } from '../lib/signalingCodec'
import { generateSessionId } from '../lib/sessionId'
import {
  createSignalSession,
  getSignalState,
  postLinkNextShortcode,
  postSignalAnswer,
  postSignalOffer,
} from '../lib/signalApi'
import {
  hostApplyAnswer,
  hostCreateOffer,
  guestHandleOffer,
  parseDcMessage,
  stringifyDcMessage,
  type DcMessage,
  type TimelineEvent,
} from '../lib/webrtc'
import { useHapticOutput } from '../lib/hapticOutputContext'
import { bestEffortHapticsMode, vibrateSupported } from '../lib/vibrate'

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

const GUEST_INTENSITY_CHECK_STORAGE_KEY = 'haptic-pairing-guest-intensity-check'

const HOST_PAIRING_PREVIEW_STORAGE_KEY = 'haptic-host-pairing-preview-scale'

function loadHostPairingPreviewScale(): number {
  try {
    const raw = localStorage.getItem(HOST_PAIRING_PREVIEW_STORAGE_KEY)
    const n = Number(raw)
    if (n === 0 || n === 0.25 || n === 0.5 || n === 0.75 || n === 1) return n
  } catch {
    /* ignore */
  }
  return 1
}

function loadGuestIntensityCheck(): 'unknown' | 'felt' | 'weak' {
  try {
    const raw = localStorage.getItem(GUEST_INTENSITY_CHECK_STORAGE_KEY)
    return raw === 'felt' || raw === 'weak' ? raw : 'unknown'
  } catch {
    return 'unknown'
  }
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

type HostGuest = {
  id: string
  label: string
  step: HostStep
  busy: boolean
  hostHandoff: boolean
  error: string | null
  netSnap: PeerNetSnapshot | null
  offerText: string
  answerInput: string
  pairCode: string
  offerExpiresAt: number | null
  lastGuestAck: { kind: HostAckKind; at: number } | null
  deliveryDots: DeliveryDot[]
  heartbeat: GuestHeartbeat | null
  sessionStartedAt: number | null
  /** Data channel dropped unexpectedly while paired (not user-ended). */
  linkLost: boolean
  /** Host published a replacement offer and linked it from the guest’s old code. */
  hostReconnectWaiting: boolean
}

function HostFlow({ onBack, supported }: { onBack: () => void; supported: boolean }) {
  /** Only used if the server omits `matchExpiresAt` (e.g. older signaling rows). */
  const MATCH_TTL_MS_FALLBACK = 2 * 60 * 60 * 1000
  const sessionId = useMemo(() => generateSessionId(), [])
  const { playRoutingPattern, stopAllHardwareOutputs } = useHapticOutput()
  const [hostPreviewScale, setHostPreviewScale] = useState(loadHostPairingPreviewScale)
  useEffect(() => {
    try {
      localStorage.setItem(HOST_PAIRING_PREVIEW_STORAGE_KEY, String(hostPreviewScale))
    } catch {
      /* ignore */
    }
  }, [hostPreviewScale])
  const [mode, setMode] = useState<'instant' | 'pattern' | 'sustained'>('instant')
  const [patterns, setPatterns] = useState<HostPatternConfig[]>(HOST_PATTERN_PRESETS)
  const [activePatternId, setActivePatternId] = useState(HOST_PATTERN_PRESETS[0]?.id ?? 'pattern-a')
  const [playing, setPlaying] = useState(false)
  const [loopMode, setLoopMode] = useState(false)
  const [playheadMs, setPlayheadMs] = useState(0)
  const [sustainLevel, setSustainLevel] = useState(0)
  const [guests, setGuests] = useState<HostGuest[]>([])
  const [countdownNow, setCountdownNow] = useState(() => Date.now())
  const [forceCompactFooter, setForceCompactFooter] = useState(false)
  const seqRef = useRef(1)
  const playheadRaf = useRef<number | null>(null)
  const playAnchor = useRef<{ startAt: number; startPlayhead: number } | null>(null)
  const localTimeouts = useRef<number[]>([])
  const pcsRef = useRef<Record<string, RTCPeerConnection>>({})
  const channelsRef = useRef<Record<string, RTCDataChannel>>({})
  const offerGenerationRef = useRef<Record<string, number>>({})
  const guestCounterRef = useRef(1)
  /** Ignore data-channel close while intentionally rotating or removing a guest PC. */
  const hostSuppressDisconnectRef = useRef<Record<string, boolean>>({})

  const connectedGuests = useMemo(() => guests.filter((g) => g.step === 'connected'), [guests])
  const compactFooter = forceCompactFooter || connectedGuests.length >= 6
  const activePattern = useMemo(
    () => patterns.find((p) => p.id === activePatternId) ?? patterns[0] ?? HOST_PATTERN_PRESETS[0],
    [patterns, activePatternId],
  )
  const durationMs = activePattern.durationMs
  const events = activePattern.events

  const updateGuest = useCallback((id: string, updater: (guest: HostGuest) => HostGuest) => {
    setGuests((prev) => prev.map((guest) => (guest.id === id ? updater(guest) : guest)))
  }, [])

  const broadcast = useCallback((msg: DcMessage) => {
    const raw = stringifyDcMessage(msg)
    Object.values(channelsRef.current).forEach((ch) => {
      if (ch.readyState === 'open') ch.send(raw)
    })
  }, [])

  const clearLocalSched = useCallback(() => {
    localTimeouts.current.forEach((id) => window.clearTimeout(id))
    localTimeouts.current = []
  }, [])

  const removeGuest = useCallback(
    (guestId: string, notifyGuest: boolean) => {
      hostSuppressDisconnectRef.current[guestId] = true
      const ch = channelsRef.current[guestId]
      if (notifyGuest && ch && ch.readyState === 'open') {
        ch.send(stringifyDcMessage({ v: 1, t: 'disconnect' }))
      }
      channelsRef.current[guestId]?.close()
      pcsRef.current[guestId]?.close()
      delete channelsRef.current[guestId]
      delete pcsRef.current[guestId]
      delete offerGenerationRef.current[guestId]
      delete hostSuppressDisconnectRef.current[guestId]
      setGuests((prev) => prev.filter((g) => g.id !== guestId))
    },
    [setGuests],
  )

  const addGuest = useCallback(() => {
    const id = crypto.randomUUID()
    const label = `Guest ${guestCounterRef.current++}`
    const guest: HostGuest = {
      id,
      label,
      step: 'idle',
      busy: false,
      hostHandoff: false,
      error: null,
      netSnap: null,
      offerText: '',
      answerInput: '',
      pairCode: '',
      offerExpiresAt: null,
      lastGuestAck: null,
      deliveryDots: [],
      heartbeat: null,
      sessionStartedAt: null,
      linkLost: false,
      hostReconnectWaiting: false,
    }
    setGuests((prev) => [...prev, guest])
    return id
  }, [])

  const wireHostChannel = useCallback(
    (guestId: string, pc: RTCPeerConnection, channel: RTCDataChannel, onGuestDisconnectMessage: () => void) => {
      const pushNet = () => {
        updateGuest(guestId, (g) => ({
          ...g,
          netSnap: {
            ice: pc.iceConnectionState,
            connection: pc.connectionState,
            dataChannel: channel.readyState,
          },
        }))
      }
      const markLinkLost = () => {
        if (hostSuppressDisconnectRef.current[guestId]) return
        updateGuest(guestId, (g) =>
          g.step === 'connected' ? { ...g, linkLost: true, hostReconnectWaiting: false } : g,
        )
      }
      channel.onmessage = (ev) => {
        const msg = parseDcMessage(typeof ev.data === 'string' ? ev.data : '')
        if (!msg) return
        if (msg.t === 'disconnect') {
          onGuestDisconnectMessage()
          return
        }
        if (msg.t === 'heartbeat') {
          updateGuest(guestId, (g) => ({
            ...g,
            heartbeat: {
              sentAt: msg.sentAt,
              sessionStartedAt: msg.sessionStartedAt,
              sustainedLevel: msg.sustainedLevel,
              recentTriggers30s: msg.recentTriggers30s,
              lockedMode: msg.lockedMode,
            },
          }))
          return
        }
        if (msg.t === 'ack') {
          updateGuest(guestId, (g) => ({
            ...g,
            lastGuestAck: { kind: msg.kind, at: msg.at },
            deliveryDots:
              msg.kind === 'instant' && typeof msg.seq === 'number'
                ? g.deliveryDots.map((d) => (d.seq === msg.seq ? { ...d, status: 'ack' } : d))
                : g.deliveryDots,
          }))
        }
      }
      pc.addEventListener('iceconnectionstatechange', () => {
        pushNet()
        if (pc.iceConnectionState === 'failed') markLinkLost()
      })
      pc.addEventListener('connectionstatechange', () => {
        pushNet()
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') markLinkLost()
      })
      channel.addEventListener('open', pushNet)
      channel.addEventListener('close', markLinkLost)
      pushNet()
    },
    [updateGuest],
  )

  const finalizeHostChannelOpen = useCallback(
    (guestId: string) => {
      updateGuest(guestId, (g) => ({
        ...g,
        step: 'connected',
        hostHandoff: false,
        linkLost: false,
        hostReconnectWaiting: false,
        sessionStartedAt: Date.now(),
      }))
    },
    [updateGuest],
  )

  const generateOfferForGuest = useCallback(
    async (guestId: string) => {
      hostSuppressDisconnectRef.current[guestId] = true
      updateGuest(guestId, (g) => ({
        ...g,
        busy: true,
        error: null,
        hostHandoff: false,
        answerInput: '',
        offerExpiresAt: null,
        netSnap: null,
        linkLost: false,
        hostReconnectWaiting: false,
      }))
      const gen = (offerGenerationRef.current[guestId] ?? 0) + 1
      offerGenerationRef.current[guestId] = gen
      try {
        pcsRef.current[guestId]?.close()
        const { pc, channel, offerText } = await hostCreateOffer()
        if (offerGenerationRef.current[guestId] !== gen) {
          pc.close()
          return
        }
        pcsRef.current[guestId] = pc
        channelsRef.current[guestId] = channel
        wireHostChannel(guestId, pc, channel, () => {
          removeGuest(guestId, false)
        })
        const signal = await createSignalSession()
        const posted = await postSignalOffer(signal.code, offerText)
        const expiresMs = posted.matchExpiresAt ? Date.parse(posted.matchExpiresAt) : Date.now() + MATCH_TTL_MS_FALLBACK
        updateGuest(guestId, (g) => ({
          ...g,
          offerText,
          pairCode: signal.code,
          offerExpiresAt: Number.isNaN(expiresMs) ? Date.now() + MATCH_TTL_MS_FALLBACK : expiresMs,
          step: 'offer-ready',
          busy: false,
          hostHandoff: false,
          error: null,
        }))
        channel.onopen = () => {
          finalizeHostChannelOpen(guestId)
        }
        if (channel.readyState === 'open') {
          finalizeHostChannelOpen(guestId)
        }
      } catch (e) {
        updateGuest(guestId, (g) => ({
          ...g,
          busy: false,
          error: e instanceof Error ? e.message : 'Failed to create offer',
        }))
      } finally {
        hostSuppressDisconnectRef.current[guestId] = false
      }
    },
    [MATCH_TTL_MS_FALLBACK, finalizeHostChannelOpen, removeGuest, updateGuest, wireHostChannel],
  )

  const reconnectHostGuest = useCallback(
    async (guestId: string) => {
      const prevGuest = guests.find((g) => g.id === guestId)
      const previousPairCode = prevGuest?.pairCode ?? ''
      if (previousPairCode.length < 5) {
        updateGuest(guestId, (g) => ({ ...g, error: 'No prior pair code stored; use Generate new offer.' }))
        return
      }
      hostSuppressDisconnectRef.current[guestId] = true
      updateGuest(guestId, (g) => ({
        ...g,
        busy: true,
        error: null,
        linkLost: false,
        hostReconnectWaiting: true,
        hostHandoff: false,
        answerInput: '',
        offerExpiresAt: null,
        netSnap: null,
        step: 'offer-ready',
      }))
      const gen = (offerGenerationRef.current[guestId] ?? 0) + 1
      offerGenerationRef.current[guestId] = gen
      try {
        pcsRef.current[guestId]?.close()
        const { pc, channel, offerText } = await hostCreateOffer()
        if (offerGenerationRef.current[guestId] !== gen) {
          pc.close()
          return
        }
        pcsRef.current[guestId] = pc
        channelsRef.current[guestId] = channel
        wireHostChannel(guestId, pc, channel, () => {
          removeGuest(guestId, false)
        })
        const signal = await createSignalSession()
        const posted = await postSignalOffer(signal.code, offerText)
        await postLinkNextShortcode(previousPairCode, signal.code)
        const expiresMs = posted.matchExpiresAt ? Date.parse(posted.matchExpiresAt) : Date.now() + MATCH_TTL_MS_FALLBACK
        updateGuest(guestId, (g) => ({
          ...g,
          offerText,
          pairCode: signal.code,
          offerExpiresAt: Number.isNaN(expiresMs) ? Date.now() + MATCH_TTL_MS_FALLBACK : expiresMs,
          step: 'offer-ready',
          busy: false,
          hostHandoff: false,
          error: null,
        }))
        channel.onopen = () => {
          finalizeHostChannelOpen(guestId)
        }
        if (channel.readyState === 'open') {
          finalizeHostChannelOpen(guestId)
        }
      } catch (e) {
        updateGuest(guestId, (g) => ({
          ...g,
          busy: false,
          hostReconnectWaiting: false,
          error: e instanceof Error ? e.message : 'Reconnect failed',
        }))
      } finally {
        hostSuppressDisconnectRef.current[guestId] = false
      }
    },
    [MATCH_TTL_MS_FALLBACK, finalizeHostChannelOpen, guests, removeGuest, updateGuest, wireHostChannel],
  )

  const applyAnswerForGuest = useCallback(
    async (guestId: string) => {
      const pc = pcsRef.current[guestId]
      const guest = guests.find((g) => g.id === guestId)
      if (!pc || !guest || !guest.answerInput.trim()) return
      updateGuest(guestId, (g) => ({ ...g, busy: true, error: null }))
      try {
        await hostApplyAnswer(pc, guest.answerInput.trim())
        updateGuest(guestId, (g) => ({ ...g, hostHandoff: true, busy: false }))
      } catch (e) {
        updateGuest(guestId, (g) => ({
          ...g,
          hostHandoff: false,
          busy: false,
          error: e instanceof Error ? e.message : 'Invalid answer',
        }))
      }
    },
    [guests, updateGuest],
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
      broadcast({ v: 1, t: 'play', startAt, durationMs, events, initialPlayheadMs: initial })
      const now = Date.now()
      const delay0 = Math.max(0, startAt - now)
      for (const ev of events) {
        if (ev.offsetMs < initial) continue
        const t = window.setTimeout(() => {
          const p = getPresetById(ev.presetId)
          if (p) playRoutingPattern(p.pattern, { hostPairingPreviewScale: hostPreviewScale })
        }, delay0 + (ev.offsetMs - initial))
        localTimeouts.current.push(t)
      }
    },
    [broadcast, clearLocalSched, durationMs, events, hostPreviewScale, playRoutingPattern],
  )

  const broadcastPatternState = useCallback(
    (overrides?: Partial<{ playing: boolean; playheadMs: number }>) => {
      broadcast({
        v: 1,
        t: 'patternState',
        durationMs,
        events,
        playheadMs: overrides?.playheadMs ?? playheadMs,
        playing: overrides?.playing ?? playing,
      })
    },
    [broadcast, durationMs, events, playheadMs, playing],
  )

  useEffect(() => {
    if (connectedGuests.length === 0) return
    const timer = window.setInterval(() => {
      broadcast({ v: 1, t: 'hostHeartbeat', sentAt: Date.now() })
    }, 5000)
    return () => window.clearInterval(timer)
  }, [broadcast, connectedGuests.length])

  useEffect(() => {
    const timer = window.setInterval(() => setCountdownNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (connectedGuests.length === 0) return
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
        broadcast({ v: 1, t: 'pause', playheadMs: durationMs })
        broadcastPatternState({ playing: false, playheadMs: durationMs })
        return
      }
      playheadRaf.current = requestAnimationFrame(loop)
    }
    playheadRaf.current = requestAnimationFrame(loop)
    return () => {
      if (playheadRaf.current) cancelAnimationFrame(playheadRaf.current)
    }
  }, [broadcast, broadcastPatternState, connectedGuests.length, durationMs, loopMode, playing, schedulePatternCycle])

  useEffect(() => {
    if (connectedGuests.length === 0 || playing) return
    broadcastPatternState()
  }, [broadcastPatternState, connectedGuests.length, durationMs, events, playing, playheadMs])

  useEffect(() => {
    const waiting = guests.filter((g) => g.pairCode && g.step !== 'connected')
    if (waiting.length === 0) return
    const timer = window.setInterval(async () => {
      await Promise.all(
        waiting.map(async (guest) => {
          try {
            const s = await getSignalState(guest.pairCode)
            if (s.matchExpiresAt) {
              const ms = Date.parse(s.matchExpiresAt)
              if (!Number.isNaN(ms)) {
                updateGuest(guest.id, (g) => ({ ...g, offerExpiresAt: ms }))
              }
            }
            if (s.answer) {
              updateGuest(guest.id, (g) => (g.answerInput ? g : { ...g, answerInput: s.answer ?? '' }))
            }
          } catch {
            /* best-effort polling */
          }
        }),
      )
    }, 2000)
    return () => window.clearInterval(timer)
  }, [guests, updateGuest])

  useEffect(() => {
    return () => {
      clearLocalSched()
      Object.values(channelsRef.current).forEach((ch) => ch.close())
      Object.values(pcsRef.current).forEach((pc) => pc.close())
      channelsRef.current = {}
      pcsRef.current = {}
    }
  }, [clearLocalSched])

  const playInstant = (presetId: string) => {
    const p = getPresetById(presetId)
    if (p) playRoutingPattern(p.pattern, { hostPairingPreviewScale: hostPreviewScale })
    const seq = seqRef.current++
    setGuests((prev) =>
      prev.map((guest) =>
        guest.step !== 'connected'
          ? guest
          : {
              ...guest,
              deliveryDots: [...guest.deliveryDots, { seq, presetId, status: 'sent' as const }].slice(-20),
            },
      ),
    )
    window.setTimeout(() => {
      setGuests((prev) =>
        prev.map((guest) => ({
          ...guest,
          deliveryDots: guest.deliveryDots.map((d) => (d.seq === seq && d.status === 'sent' ? { ...d, status: 'timeout' } : d)),
        })),
      )
    }, 4000)
    broadcast({ v: 1, t: 'instant', presetId, seq })
  }

  const sendSustainLevel = (nextLevel: number) => {
    const clamped = Math.max(0, Math.min(100, Math.round(nextLevel)))
    setSustainLevel(clamped)
    broadcast({ v: 1, t: 'sustain', level: clamped })
  }

  const sendStopAll = () => {
    clearLocalSched()
    playAnchor.current = null
    setPlaying(false)
    setPlayheadMs(0)
    setSustainLevel(0)
    stopAllHardwareOutputs()
    broadcast({ v: 1, t: 'stopAll' })
  }

  const startPatternPlayback = () => {
    setPlaying(true)
    schedulePatternCycle(playheadMs)
  }

  const pausePatternPlayback = () => {
    clearLocalSched()
    playAnchor.current = null
    setPlaying(false)
    broadcast({ v: 1, t: 'pause', playheadMs })
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

  const loadRecommendedPattern = useCallback(() => {
    updateActivePattern((p) => ({
      ...p,
      durationMs: RECOMMENDED_PATTERN_DURATION_MS,
      events: RECOMMENDED_PATTERN_EVENTS.map((ev) => ({
        id: crypto.randomUUID(),
        offsetMs: ev.offsetMs,
        presetId: ev.presetId,
      })),
    }))
    setPlayheadMs(0)
  }, [updateActivePattern])

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
    setPlayheadMs(quantize(ratio * durationMs))
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
        Session code: <strong>{sessionId}</strong> (read this aloud to each guest for verification)
      </p>

      <section className="panel stack">
        <h2>Local preview (this device)</h2>
        <p className="muted">
          When <strong>you</strong> trigger instant taps or timelines on this page, this scales how strongly this device
          buzzes or drives Intiface motors. Commands to guests stay at full intensity.
        </p>
        <label className="field">
          <span>Strength on HOST interactions</span>
          <select
            value={String(hostPreviewScale)}
            onChange={(e) => setHostPreviewScale(Number(e.target.value))}
          >
            <option value="0">Off (0%)</option>
            <option value="0.25">Reduce 75% (25% remaining)</option>
            <option value="0.5">Reduce 50% (50% remaining)</option>
            <option value="0.75">Reduce 25% (75% remaining)</option>
            <option value="1">Full (100%)</option>
          </select>
        </label>
      </section>

      <section className="panel stack">
        <div className="row spread">
          <h2>Guest sessions</h2>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              const id = addGuest()
              void generateOfferForGuest(id)
            }}
          >
            {connectedGuests.length > 0 ? 'Add another guest' : 'Add first guest'}
          </button>
        </div>
        {guests.length === 0 && <p className="muted">Start by adding a guest. A unique pair code is generated per guest session.</p>}
        {guests.map((guest) => {
          const answerReady = Boolean(guest.answerInput.trim()) && !guest.hostHandoff
          const answerTimeoutRemainingS =
            guest.offerExpiresAt && guest.step !== 'connected'
              ? Math.max(0, Math.ceil((guest.offerExpiresAt - countdownNow) / 1000))
              : null
          const answerTimeoutExpired = typeof answerTimeoutRemainingS === 'number' && answerTimeoutRemainingS <= 0
          return (
            <section key={guest.id} className="panel stack">
              <div className="row spread">
                <h3>{guest.label}</h3>
                <div className="row wrap">
                  {guest.linkLost && (
                    <>
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={guest.busy}
                        onClick={() => void reconnectHostGuest(guest.id)}
                      >
                        Reconnect session
                      </button>
                      <button type="button" className="btn btn-ghost" onClick={() => removeGuest(guest.id, false)}>
                        Remove guest
                      </button>
                    </>
                  )}
                  {guest.step === 'connected' && !guest.linkLost && (
                    <button type="button" className="btn btn-danger" onClick={() => removeGuest(guest.id, true)}>
                      End connection
                    </button>
                  )}
                  {guest.step !== 'connected' && (
                    <button type="button" className="btn" disabled={guest.busy} onClick={() => void generateOfferForGuest(guest.id)}>
                      Generate new offer
                    </button>
                  )}
                  {guest.step !== 'connected' && (
                    <button type="button" className="btn btn-ghost" onClick={() => removeGuest(guest.id, false)}>
                      Remove
                    </button>
                  )}
                </div>
              </div>
              {guest.linkLost && (
                <p className="warn">
                  Data channel or transport dropped unexpectedly. Tap <strong>Reconnect session</strong> to publish a new
                  pair code linked from the guest’s previous code, or remove this guest and add a new one.
                </p>
              )}
              {guest.hostReconnectWaiting && guest.step !== 'connected' && (
                <p className="muted">
                  Reconnect offer published on the server. New pair code: <strong>{guest.pairCode}</strong>. Ask the guest
                  to use <strong>Reconnect</strong> on their device (they should poll their <em>old</em> code first), then
                  apply the new answer when it arrives.
                </p>
              )}
              {guest.pairCode && (
                <p className="session-code">
                  Pair code: <strong>{guest.pairCode}</strong> (share this 5-character code)
                </p>
              )}
              {guest.netSnap && guest.step !== 'connected' && <IcePathPanel snap={guest.netSnap} context="host" />}
              {guest.offerText && guest.step !== 'connected' && (
                <>
                  <p>
                    Offer ({guest.offerText.startsWith(SIGNALING_COMPACT_PREFIX) ? 'compact' : 'JSON'}) — {guest.offerText.length} chars
                  </p>
                  <div className="row wrap">
                    <button
                      type="button"
                      className="btn"
                      onClick={() => navigator.clipboard.writeText(guest.offerText).catch(() => {})}
                    >
                      Copy offer
                    </button>
                    {guest.offerText.length <= QR_SAFE_MAX_LEN ? (
                      <div className="qr-box">
                        <QRCodeSVG value={guest.offerText} size={160} level="L" />
                      </div>
                    ) : (
                      <p className="muted">Offer too large for QR ({guest.offerText.length} chars). Use copy instead.</p>
                    )}
                  </div>
                </>
              )}
              {guest.step !== 'connected' && (
                <>
                  <textarea
                    className="input mono"
                    rows={5}
                    value={guest.answerInput}
                    onChange={(e) => updateGuest(guest.id, (g) => ({ ...g, answerInput: e.target.value }))}
                    spellCheck={false}
                    placeholder={`${SIGNALING_COMPACT_PREFIX}... or paste JSON`}
                  />
                  {answerReady && (
                    <p className="apply-answer-ready" role="status" aria-live="polite">
                      Answer ready. Tap <strong>Apply answer</strong>.
                      {typeof answerTimeoutRemainingS === 'number' && (
                        <>
                          {' '}
                          Expires in <strong>{answerTimeoutRemainingS}s</strong>.
                        </>
                      )}
                    </p>
                  )}
                  {answerTimeoutExpired && <p className="warn">Pair-code match window expired. Generate a new offer.</p>}
                  <button
                    type="button"
                    className={`btn btn-primary ${answerReady ? 'btn-ready-apply' : ''}`}
                    disabled={guest.busy || !guest.answerInput.trim() || guest.hostHandoff || answerTimeoutExpired}
                    onClick={() => void applyAnswerForGuest(guest.id)}
                  >
                    Apply answer
                  </button>
                  {guest.hostHandoff && <p className="muted">Answer applied; waiting for this guest data channel to open.</p>}
                </>
              )}
              {guest.step === 'connected' && (
                <>
                  <p className="ok">Connected.</p>
                  <p className="muted">
                    Last ack:{' '}
                    {guest.lastGuestAck
                      ? `${guest.lastGuestAck.kind} @ ${new Date(guest.lastGuestAck.at).toLocaleTimeString()}`
                      : 'none yet'}
                  </p>
                  <div className="delivery-dots" aria-label={`Last 20 host sends for ${guest.label}`}>
                    {Array.from({ length: 20 }).map((_, idx) => {
                      const dot = guest.deliveryDots[idx]
                      const cls = dot ? `delivery-dot delivery-dot--${dot.status}` : 'delivery-dot delivery-dot--idle'
                      return <span key={idx} className={cls} title={dot ? `${dot.presetId} #${dot.seq} ${dot.status}` : 'idle'} />
                    })}
                  </div>
                </>
              )}
              {guest.error && <p className="warn">{guest.error}</p>}
            </section>
          )
        })}
      </section>

      {connectedGuests.length > 0 && (
        <>
          <p className="ok">
            Broadcasting to <strong>{connectedGuests.length}</strong> connected guest{connectedGuests.length === 1 ? '' : 's'}.
          </p>
          <div className="panel row wrap">
            <label className="field inline">
              <span>Compact guest footer</span>
              <input type="checkbox" checked={forceCompactFooter} onChange={(e) => setForceCompactFooter(e.target.checked)} />
            </label>
            <p className="muted">
              {forceCompactFooter
                ? 'Compact mode forced on.'
                : connectedGuests.length >= 6
                  ? 'Compact mode auto-enabled (6+ guests).'
                  : 'Auto mode: cards below 6 guests, compact at 6+.'}
            </p>
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
              <h2>Haptic actions (broadcast)</h2>
              {!supported && (
                <p className="muted">
                  This device may not expose <code>navigator.vibrate</code>. You can still broadcast; optional phone
                  haptics simulation or Bluetooth hardware is configured in the <strong>Haptics output</strong> bar above.
                </p>
              )}
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
              <h2>Pattern timeline (broadcast)</h2>
              <p className="muted">All connected guests receive the same timeline and transport commands.</p>
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
                <button type="button" className="btn" onClick={loadRecommendedPattern} disabled={playing}>
                  Load recommended pattern
                </button>
                <span className="pill">Length {(durationMs / 1000).toFixed(0)}s (1–16s)</span>
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
              <h2>Sustained buzz (broadcast)</h2>
              <p className="muted">Set a continuous buzz level on all connected guests (0 = off, 100 = strongest emulation).</p>
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

          <div className={`pairing-footer host-footer-grid ${compactFooter ? 'host-footer-grid--compact' : ''}`}>
            {!compactFooter &&
              connectedGuests.map((guest) => (
                <div key={guest.id} className="host-heartbeat-card">
                  <p>
                    <strong>{guest.label}</strong>
                  </p>
                  <p>Sustain: {guest.heartbeat?.sustainedLevel ?? 0}</p>
                  <p>30s triggers: {guest.heartbeat?.recentTriggers30s ?? 0}</p>
                  <p>Last beat: {guest.heartbeat ? `${Math.max(0, Math.floor((countdownNow - guest.heartbeat.sentAt) / 1000))}s ago` : 'n/a'}</p>
                  <p>Locked: {guest.heartbeat?.lockedMode ? 'ON' : 'OFF'}</p>
                </div>
              ))}
            {compactFooter && (
              <div className="host-heartbeat-table-wrap" role="region" aria-label="Connected guest heartbeat table">
                <table className="host-heartbeat-table">
                  <thead>
                    <tr>
                      <th>Guest</th>
                      <th>Sustain</th>
                      <th>30s</th>
                      <th>Last beat</th>
                      <th>Locked</th>
                    </tr>
                  </thead>
                  <tbody>
                    {connectedGuests.map((guest) => (
                      <tr key={guest.id}>
                        <td>{guest.label}</td>
                        <td>{guest.heartbeat?.sustainedLevel ?? 0}</td>
                        <td>{guest.heartbeat?.recentTriggers30s ?? 0}</td>
                        <td>{guest.heartbeat ? `${Math.max(0, Math.floor((countdownNow - guest.heartbeat.sentAt) / 1000))}s` : 'n/a'}</td>
                        <td>{guest.heartbeat?.lockedMode ? 'ON' : 'OFF'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="host-heartbeat-card host-heartbeat-card--actions">
              <p>
                <strong>Broadcast controls</strong>
              </p>
              <p>Connected guests: {connectedGuests.length}</p>
              {compactFooter && <p className="muted">Compact footer mode enabled (6+ guests).</p>}
              <button type="button" className="btn btn-danger" onClick={sendStopAll}>
                Stop all
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

const GUEST_LINK_WATCHDOG_MS = 60_000
const RECONNECT_HANDOFF_COOLDOWN_SEC = 10

function GuestFlow({ onBack, supported }: { onBack: () => void; supported: boolean }) {
  const bestEffort = bestEffortHapticsMode()
  const canTriggerLocal = supported || bestEffort
  const { playRoutingPattern, pulseRoutingSustain, stopAllHardwareOutputs, intifaceReady } = useHapticOutput()
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
  const [intensityCheck, setIntensityCheck] = useState<'unknown' | 'felt' | 'weak'>(loadGuestIntensityCheck)
  const [showReconnectPanel, setShowReconnectPanel] = useState(false)
  const [reconnectCooldownSec, setReconnectCooldownSec] = useState(0)
  const [emergencyStopOpen, setEmergencyStopOpen] = useState(false)
  const [savedPairCodeLabel, setSavedPairCodeLabel] = useState<string | null>(null)

  const guestUserEndedSessionRef = useRef(false)
  const lastShortPairingCodeRef = useRef<string | null>(null)
  const transportDeadRef = useRef(false)

  useEffect(() => {
    if (reconnectCooldownSec <= 0) return
    const t = window.setInterval(() => setReconnectCooldownSec((c) => Math.max(0, c - 1)), 1000)
    return () => window.clearInterval(t)
  }, [reconnectCooldownSec])

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
    stopAllHardwareOutputs()
  }, [stopAllHardwareOutputs])

  const endGuestConnection = useCallback((notifyHost: boolean, intentionalGuestEnd = false) => {
    if (intentionalGuestEnd) guestUserEndedSessionRef.current = true
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
    setShowReconnectPanel(false)
    setEmergencyStopOpen(false)
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
        if (p) {
          playRoutingPattern(p.pattern)
          setLastHapticExecution({
            at: Date.now(),
            success: canTriggerLocal || intifaceReady,
            reason: 'remote',
          })
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
            if (p) playRoutingPattern(p.pattern)
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
        if (msg.level <= 0) {
          stopAllHardwareOutputs()
        } else if (canTriggerLocal || intifaceReady) {
          const onMs = Math.max(20, Math.round((msg.level / 100) * 240))
          const offMs = Math.max(35, 180 - Math.round((msg.level / 100) * 120))
          const run = () => {
            pulseRoutingSustain(msg.level)
            setLastHapticExecution({
              at: Date.now(),
              success: canTriggerLocal || intifaceReady,
              reason: 'remote',
            })
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
        endGuestConnection(false, false)
        setShowReconnectPanel(true)
        setError('Host ended the connection. You can reconnect if they start a new session.')
      }
    },
    [canTriggerLocal, endGuestConnection, intifaceReady, playRoutingPattern, pulseRoutingSustain, stopAllGuestActions, stopAllHardwareOutputs],
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
    const timer = window.setInterval(() => {
      const last = lastHostActivityAtRef.current
      if (!last) return
      if (Date.now() - last > GUEST_LINK_WATCHDOG_MS && !guestSafetyStopped) {
        stopAllGuestActions()
        setGuestSafetyStopped(true)
        setError('Safety stop: host connection lost; haptics halted.')
        setShowReconnectPanel(true)
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

  const joinHostSession = useCallback(
    async (pairCodeOverride?: string) => {
      transportDeadRef.current = false
      setError(null)
      setGuestNetSnap(null)
      setBusy(true)
      try {
        let resolvedOffer = offerIn.trim()
        const enteredCode = (pairCodeOverride ?? sessionInput).trim().toUpperCase()
        if (pairCodeOverride) setSessionInput(enteredCode)
        if (!resolvedOffer && enteredCode.length >= 5) {
          const s = await getSignalState(enteredCode)
          if (!s.offer) throw new Error('Host offer is not ready for this code yet')
          resolvedOffer = s.offer ?? ''
          setOfferIn(resolvedOffer)
        }
        if (!resolvedOffer) throw new Error('Paste an offer or enter a valid pair code')
        pcRef.current?.close()
        const { pc, answerText: ans, waitForChannel } = await guestHandleOffer(resolvedOffer)
        pcRef.current = pc
        setAnswerText(ans)
        if (enteredCode.length >= 5) {
          await postSignalAnswer(enteredCode, ans)
          lastShortPairingCodeRef.current = enteredCode
          setSavedPairCodeLabel(enteredCode)
        }

        const onUnexpectedTransportEnd = () => {
          if (guestUserEndedSessionRef.current) {
            guestUserEndedSessionRef.current = false
            transportDeadRef.current = false
            return
          }
          if (transportDeadRef.current) return
          transportDeadRef.current = true
          stopAllGuestActions()
          try {
            pc.close()
          } catch {
            /* ignore */
          }
          channelRef.current = null
          pcRef.current = null
          setConnected(false)
          setGuestNetSnap(null)
          setShowReconnectPanel(true)
          setError('Connection lost. Use Reconnect below when the host is ready.')
        }

        const pushGuestNet = () => {
          const snap = {
            ice: pc.iceConnectionState,
            connection: pc.connectionState,
            dataChannel: channelRef.current?.readyState,
          } as const
          setGuestNetSnap(snap)
          if (snap.connection === 'failed' || snap.connection === 'closed') {
            stopAllGuestActions()
            onUnexpectedTransportEnd()
          }
          if (snap.connection === 'disconnected') {
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
          setShowReconnectPanel(false)
        })
        ch.addEventListener('close', onUnexpectedTransportEnd)
        ch.addEventListener('closing', pushGuestNet)
        pushGuestNet()
        ch.onmessage = (ev) => handleDcMessage(typeof ev.data === 'string' ? ev.data : '')
        if (ch.readyState === 'open') {
          pushGuestNet()
          lastHostActivityAtRef.current = Date.now()
          setGuestSafetyStopped(false)
          setConnected(true)
          setShowReconnectPanel(false)
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to handle offer')
      } finally {
        setBusy(false)
      }
    },
    [handleDcMessage, offerIn, sessionInput, stopAllGuestActions],
  )

  const createAnswer = () => void joinHostSession()

  const checkReconnectHandoff = useCallback(async () => {
    const code = lastShortPairingCodeRef.current ?? sessionInput.trim().toUpperCase()
    if (code.length < 5) {
      setError('Enter your previous host pair code above, or wait for the host to share a new code.')
      setReconnectCooldownSec(RECONNECT_HANDOFF_COOLDOWN_SEC)
      return
    }
    try {
      const s = await getSignalState(code)
      if (s.nextShortcode) {
        setOfferIn('')
        setAnswerText('')
        setReconnectCooldownSec(0)
        await joinHostSession(s.nextShortcode)
        return
      }
      setReconnectCooldownSec(RECONNECT_HANDOFF_COOLDOWN_SEC)
    } catch {
      setReconnectCooldownSec(RECONNECT_HANDOFF_COOLDOWN_SEC)
    }
  }, [joinHostSession, sessionInput])

  const runIntensityProbe = useCallback(() => {
    const ok = canTriggerLocal || intifaceReady
    if (ok) playRoutingPattern([90, 45, 120])
    if (!ok) setIntensityCheck('weak')
  }, [canTriggerLocal, intifaceReady, playRoutingPattern])

  useEffect(() => {
    try {
      localStorage.setItem(GUEST_INTENSITY_CHECK_STORAGE_KEY, intensityCheck)
    } catch {
      /* ignore */
    }
  }, [intensityCheck])

  return (
    <div className="page stack guest">
      <div className="row spread">
        <h1>GUEST</h1>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            endGuestConnection(connected, true)
            onBack()
          }}
        >
          Change role
        </button>
      </div>
      <p className="lede">
        Enter the HOST pair code to fetch/post signaling automatically, or use manual blob paste as fallback.
      </p>

      <GuestSignalingProgress connected={connected} busy={busy} hasAnswer={Boolean(answerText)} />

      {!connected && showReconnectPanel && (
        <section className="panel stack">
          <h2>Reconnect</h2>
          <p className="muted">
            This session ended without you choosing <strong>End connection</strong> or <strong>Emergency stop</strong>.
            The host should tap <strong>Reconnect session</strong> first. Then you can poll for a new shortcode linked to
            your previous one
            {savedPairCodeLabel ? <> (<strong>{savedPairCodeLabel}</strong>)</> : null}.
          </p>
          {!savedPairCodeLabel && sessionInput.trim().length < 5 && (
            <p className="warn">
              If you did not use shortcode mode, wait for a new pair code from the host and enter it above instead.
            </p>
          )}
          <button
            type="button"
            className="btn"
            disabled={reconnectCooldownSec > 0 || busy}
            onClick={() => void checkReconnectHandoff()}
          >
            {reconnectCooldownSec > 0 ? `Check again (${reconnectCooldownSec}s)` : 'Check again for new code'}
          </button>
        </section>
      )}

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
          {canTriggerLocal && intensityCheck !== 'felt' && (
            <p className="warn">
              Intensity check not confirmed strong. For reliable host-to-guest testing, verify device vibration intensity
              is set to max.
            </p>
          )}
          <div className="row wrap">
            <button type="button" className="btn btn-danger" onClick={() => setEmergencyStopOpen(true)}>
              Emergency stop
            </button>
            <button type="button" className="btn btn-danger" onClick={() => endGuestConnection(true, true)}>
              End connection
            </button>
            <button type="button" className="btn" onClick={() => setGuestLocked((v) => !v)}>
              {guestLocked ? 'Unlock mode' : 'Locked mode'}
            </button>
          </div>
          {emergencyStopOpen && (
            <div className="panel stack" role="dialog" aria-labelledby="emergency-stop-title">
              <h3 id="emergency-stop-title">Confirm emergency stop</h3>
              <p className="warn">
                Emergency stop immediately halts haptics and ends your session. Only continue if you need to stop right
                away.
              </p>
              <div className="row wrap">
                <button type="button" className="btn" onClick={() => setEmergencyStopOpen(false)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => {
                    setEmergencyStopOpen(false)
                    stopAllGuestActions()
                    endGuestConnection(true, true)
                  }}
                >
                  Confirm emergency stop
                </button>
              </div>
            </div>
          )}
          <div className="panel stack">
            {canTriggerLocal && (
              <div className="panel stack">
                <p className="muted">
                  Browser APIs cannot detect your system vibration-intensity setting. Run this pulse and confirm what you
                  feel.
                </p>
                <div className="row wrap">
                  <button type="button" className="btn" onClick={runIntensityProbe}>
                    Run intensity check pulse
                  </button>
                  <button type="button" className="btn" onClick={() => setIntensityCheck('felt')}>
                    Felt strong
                  </button>
                  <button type="button" className="btn btn-danger" onClick={() => setIntensityCheck('weak')}>
                    Weak / no vibration
                  </button>
                </div>
                {intensityCheck === 'weak' && (
                  <p className="warn">
                    Vibration may be reduced by system settings. For reliable host-to-guest testing, raise device
                    vibration/haptics intensity to maximum and disable battery-saver modes.
                  </p>
                )}
              </div>
            )}
            <p className="muted">
              Signal received: <strong>{lastHostMessage ? 'Yes' : 'No'}</strong> | Outputs:{' '}
              <strong>
                {[
                  supported || bestEffort ? 'Phone' : null,
                  intifaceReady ? 'Bluetooth (Intiface)' : null,
                ]
                  .filter(Boolean)
                  .join(' · ') || 'none configured'}
              </strong>
            </p>
            {lastHapticExecution && (
              <p className={lastHapticExecution.success ? 'ok' : 'warn'}>
                Last haptic execution ({lastHapticExecution.reason}) at{' '}
                {new Date(lastHapticExecution.at).toLocaleTimeString()}:{' '}
                {lastHapticExecution.success
                  ? 'output routed (see Haptics output settings)'
                  : 'no usable output routes'}
              </p>
            )}
            <div className="row wrap">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  const ok = canTriggerLocal || intifaceReady
                  if (ok) playRoutingPattern([25, 40, 25])
                  setLastHapticExecution({ at: Date.now(), success: ok, reason: 'prime' })
                }}
                disabled={!canTriggerLocal && !intifaceReady}
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
          {!supported && !(bestEffort || intifaceReady) && (
            <p className="warn">
              Phone vibration API is not available here. Configure Intiface/Bluetooth in the Haptics output bar for
              hardware feedback.
            </p>
          )}
          {!supported && bestEffort && (
            <p className="callout">
              Physical phone haptics are best effort in this Safari-based browser—timing is mirrored visually unless you add
              Bluetooth hardware via Intiface.
            </p>
          )}
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
