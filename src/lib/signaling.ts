/** Manual WebRTC signaling payloads (copy/paste / QR when small enough) */

export const SIGNALING_MAX_BYTES = 120_000

export type IceCandidateInit = {
  candidate: string
  sdpMid: string | null
  sdpMLineIndex: number | null
}

export type OfferBundleV1 = {
  v: 1
  kind: 'offer'
  sdp: string
  ice: IceCandidateInit[]
}

export type AnswerBundleV1 = {
  v: 1
  kind: 'answer'
  sdp: string
  ice: IceCandidateInit[]
}

export type SignalingBundle = OfferBundleV1 | AnswerBundleV1

export function parseSignalingBundle(raw: string): SignalingBundle {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('Invalid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('Invalid payload')
  const o = parsed as Record<string, unknown>
  if (o.v !== 1) throw new Error('Unsupported version')
  if (o.kind !== 'offer' && o.kind !== 'answer') throw new Error('Invalid kind')
  if (typeof o.sdp !== 'string' || o.sdp.length === 0) throw new Error('Missing sdp')
  if (!Array.isArray(o.ice)) throw new Error('Missing ice array')
  if (raw.length > SIGNALING_MAX_BYTES) throw new Error('Payload too large')

  const ice: IceCandidateInit[] = []
  for (const c of o.ice) {
    if (typeof c !== 'object' || c === null) continue
    const ci = c as Record<string, unknown>
    if (typeof ci.candidate !== 'string') continue
    ice.push({
      candidate: ci.candidate,
      sdpMid: typeof ci.sdpMid === 'string' ? ci.sdpMid : null,
      sdpMLineIndex: typeof ci.sdpMLineIndex === 'number' ? ci.sdpMLineIndex : null,
    })
  }

  if (o.kind === 'offer') {
    return { v: 1, kind: 'offer', sdp: o.sdp, ice }
  }
  return { v: 1, kind: 'answer', sdp: o.sdp, ice }
}

export function stringifySignalingBundle(bundle: SignalingBundle): string {
  return JSON.stringify(bundle)
}

/** QR becomes unwieldy beyond this; prefer copy/paste */
export const QR_SAFE_MAX_LEN = 2000
