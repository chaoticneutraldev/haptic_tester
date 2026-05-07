export const STUN_ONLY_ICE_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
]

type IceConfigResponse = {
  iceServers: RTCIceServer[]
}

export async function fetchTurnIceServers(label?: string): Promise<RTCIceServer[]> {
  const response = await fetch('/api/turn/ice-config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      expiryInSeconds: 86_400,
      ...(label ? { label } : {}),
    }),
  })

  if (!response.ok) {
    const details = await response.text().catch(() => '')
    throw new Error(`TURN endpoint failed (${response.status}) ${details}`.trim())
  }

  const payload = (await response.json()) as IceConfigResponse
  if (!Array.isArray(payload.iceServers) || payload.iceServers.length === 0) {
    throw new Error('TURN endpoint returned no ICE servers')
  }
  return payload.iceServers
}
