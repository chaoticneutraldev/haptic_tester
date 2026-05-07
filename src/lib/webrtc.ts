import { type OfferBundleV1, type AnswerBundleV1 } from './signaling'
import { formatSignalingForPaste, parseSignalingPaste } from './signalingCodec'
import { fetchTurnIceServers, STUN_ONLY_ICE_SERVERS } from './turnApi'

export const DEFAULT_ICE_SERVERS: RTCIceServer[] = STUN_ONLY_ICE_SERVERS

/** Browsers (especially Safari / iOS) may never set iceGatheringState to "complete"; stop waiting after this. */
const ICE_GATHER_SOFT_TIMEOUT_MS = 20_000

export type TimelineEvent = {
  id: string
  offsetMs: number
  presetId: string
}

export type DcMessage =
  | { v: 1; t: 'instant'; presetId: string }
  | {
      v: 1
      t: 'patternState'
      durationMs: number
      events: TimelineEvent[]
      playheadMs: number
      playing: boolean
    }
  | {
      v: 1
      t: 'play'
      startAt: number
      durationMs: number
      events: TimelineEvent[]
      /** Playhead at scheduled start (ms) */
      initialPlayheadMs: number
    }
  | { v: 1; t: 'pause'; playheadMs: number }
  | { v: 1; t: 'ack'; kind: 'instant' | 'patternState' | 'play' | 'pause'; at: number }

export async function createPeerConnection(label?: string): Promise<RTCPeerConnection> {
  let iceServers: RTCIceServer[]
  try {
    iceServers = await fetchTurnIceServers(label)
  } catch {
    // Fallback keeps pairing usable if function is unavailable.
    iceServers = DEFAULT_ICE_SERVERS
  }
  return new RTCPeerConnection({ iceServers })
}

/**
 * Wait until ICE gathering is done, or we have waited long enough.
 * Never rejects: manual signaling still works with SDP + candidates collected so far.
 */
async function waitIceGatheringDone(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return

  await new Promise<void>((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      pc.removeEventListener('icegatheringstatechange', onGathering)
      pc.removeEventListener('icecandidate', onIce)
      resolve()
    }

    const timer = window.setTimeout(finish, ICE_GATHER_SOFT_TIMEOUT_MS)

    const onGathering = () => {
      if (pc.iceGatheringState === 'complete') finish()
    }

    /** Standard end-of-trickle signal; some WebKit builds omit "complete" but fire this. */
    const onIce = (e: RTCPeerConnectionIceEvent) => {
      if (e.candidate === null) finish()
    }

    pc.addEventListener('icegatheringstatechange', onGathering)
    pc.addEventListener('icecandidate', onIce)
    onGathering()
  })
}

function collectIce(pc: RTCPeerConnection): RTCIceCandidate[] {
  const out: RTCIceCandidate[] = []
  pc.addEventListener('icecandidate', (e) => {
    if (e.candidate) out.push(e.candidate)
  })
  return out
}

/** HOST: create channel, offer, return bundle string */
export async function hostCreateOffer(): Promise<{
  pc: RTCPeerConnection
  channel: RTCDataChannel
  offerText: string
}> {
  const pc = await createPeerConnection('host-pairing')
  const candidates: RTCIceCandidate[] = collectIce(pc)
  const channel = pc.createDataChannel('haptic', { ordered: true })
  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  await waitIceGatheringDone(pc)
  const ice = candidates.map((c) => ({
    candidate: c.candidate,
    sdpMid: c.sdpMid,
    sdpMLineIndex: c.sdpMLineIndex,
  }))
  const bundle: OfferBundleV1 = {
    v: 1,
    kind: 'offer',
    sdp: pc.localDescription?.sdp ?? '',
    ice,
  }
  return { pc, channel, offerText: await formatSignalingForPaste(bundle) }
}

/** GUEST: apply offer, create answer */
export async function guestHandleOffer(offerRaw: string): Promise<{
  pc: RTCPeerConnection
  answerText: string
  waitForChannel: () => Promise<RTCDataChannel>
}> {
  const bundle = await parseSignalingPaste(offerRaw)
  if (bundle.kind !== 'offer') throw new Error('Expected offer bundle')

  const pc = await createPeerConnection('guest-pairing')
  const candidates: RTCIceCandidate[] = collectIce(pc)

  let resolveChannel: (ch: RTCDataChannel) => void
  const channelPromise = new Promise<RTCDataChannel>((res) => {
    resolveChannel = res
  })
  pc.ondatachannel = (ev) => resolveChannel(ev.channel)

  await pc.setRemoteDescription({ type: 'offer', sdp: bundle.sdp })
  for (const c of bundle.ice) {
    try {
      await pc.addIceCandidate(c)
    } catch {
      /* ignore bad candidates */
    }
  }

  const answer = await pc.createAnswer()
  await pc.setLocalDescription(answer)
  await waitIceGatheringDone(pc)

  const ice = candidates.map((c) => ({
    candidate: c.candidate,
    sdpMid: c.sdpMid,
    sdpMLineIndex: c.sdpMLineIndex,
  }))
  const answerBundle: AnswerBundleV1 = {
    v: 1,
    kind: 'answer',
    sdp: pc.localDescription?.sdp ?? '',
    ice,
  }

  return {
    pc,
    answerText: await formatSignalingForPaste(answerBundle),
    waitForChannel: () => channelPromise,
  }
}

/** HOST: apply answer from guest */
export async function hostApplyAnswer(pc: RTCPeerConnection, answerRaw: string): Promise<void> {
  if (pc.signalingState === 'closed') {
    throw new Error('Connection was closed. Generate a new offer and pair again.')
  }

  const bundle = await parseSignalingPaste(answerRaw)
  if (bundle.kind !== 'answer') throw new Error('Expected answer bundle')

  if (pc.signalingState === 'stable') {
    if (pc.localDescription?.type === 'offer' && pc.remoteDescription?.type === 'answer') {
      return
    }
    throw new Error(
      'This device is not waiting for an answer (wrong signaling state). Tap “Generate offer” once, send that offer to the guest, then paste only the answer that matches it—avoid double-tapping Generate.',
    )
  }

  if (pc.signalingState !== 'have-local-offer') {
    throw new Error(
      `Cannot apply answer while signaling is “${pc.signalingState}”. Generate a new offer and run through pairing again.`,
    )
  }

  await pc.setRemoteDescription({ type: 'answer', sdp: bundle.sdp })
  for (const c of bundle.ice) {
    try {
      await pc.addIceCandidate(c)
    } catch {
      /* ignore */
    }
  }
}

export function parseDcMessage(raw: string): DcMessage | null {
  try {
    const o = JSON.parse(raw) as DcMessage
    if (o?.v !== 1 || typeof o.t !== 'string') return null
    return o
  } catch {
    return null
  }
}

export function stringifyDcMessage(msg: DcMessage): string {
  return JSON.stringify(msg)
}
