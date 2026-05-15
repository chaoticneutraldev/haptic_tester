import { createSession, json } from './_signal-store.mjs'

export async function handler(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' })
  try {
    const session = await createSession()
    return json(200, {
      code: session.code,
      status: session.status,
      matchExpiresInSeconds: session.matchExpiresInSeconds,
      activeTtlSeconds: session.activeTtlSeconds,
      matchExpiresAt: session.matchExpiresAt ?? null,
      createdAt: session.createdAt,
    })
  } catch (error) {
    return json(500, { error: 'Failed to create signaling session', details: error.message })
  }
}
