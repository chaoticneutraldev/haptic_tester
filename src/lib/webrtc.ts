import { type OfferBundleV1, type AnswerBundleV1 } from './signaling'
import { formatSignalingForPaste, parseSignalingPaste } from './signalingCodec'

export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]

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

export function createPeerConnection(): RTCPeerConnection {
  return new RTCPeerConnection({ iceServers: DEFAULT_ICE_SERVERS })
}

async function waitIceComplete(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return
  await new Promise<void>((resolve, reject) => {
    const to = window.setTimeout(() => {
      cleanup()
      reject(new Error('ICE gathering timed out'))
    }, 25_000)
    const cleanup = () => {
      window.clearTimeout(to)
      pc.removeEventListener('icegatheringstatechange', onState)
    }
    const onState = () => {
      if (pc.iceGatheringState === 'complete') {
        cleanup()
        resolve()
      }
    }
    pc.addEventListener('icegatheringstatechange', onState)
    onState()
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
  const pc = createPeerConnection()
  const candidates: RTCIceCandidate[] = collectIce(pc)
  const channel = pc.createDataChannel('haptic', { ordered: true })
  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  await waitIceComplete(pc)
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

  const pc = createPeerConnection()
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
  await waitIceComplete(pc)

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
  const bundle = await parseSignalingPaste(answerRaw)
  if (bundle.kind !== 'answer') throw new Error('Expected answer bundle')
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
