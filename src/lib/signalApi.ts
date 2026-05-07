export type SignalState = {
  code: string
  status: 'waiting' | 'matched'
  hasOffer: boolean
  hasAnswer: boolean
  offer?: string | null
  answer?: string | null
  matchedAt?: string | null
}

export async function createSignalSession(): Promise<{
  code: string
  matchExpiresInSeconds: number
  activeTtlSeconds: number
}> {
  const res = await fetch('/api/signal/session', { method: 'POST' })
  if (!res.ok) throw new Error(`Failed creating session (${res.status})`)
  return res.json()
}

export async function postSignalOffer(code: string, payload: string): Promise<void> {
  const res = await fetch(`/api/signal/state/${encodeURIComponent(code)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'offer', payload }),
  })
  if (!res.ok) throw new Error(`Failed publishing offer (${res.status})`)
}

export async function postSignalAnswer(code: string, payload: string): Promise<void> {
  const res = await fetch(`/api/signal/state/${encodeURIComponent(code)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'answer', payload }),
  })
  if (!res.ok) throw new Error(`Failed publishing answer (${res.status})`)
}

export async function getSignalState(code: string): Promise<SignalState> {
  const res = await fetch(`/api/signal/state/${encodeURIComponent(code)}`)
  if (!res.ok) throw new Error(`Signal state unavailable (${res.status})`)
  return res.json()
}
