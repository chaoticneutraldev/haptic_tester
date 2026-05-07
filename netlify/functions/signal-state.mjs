import { getSession, json, putAnswer, putOffer } from './_signal-store.mjs'

function codeFromPath(path) {
  const parts = String(path ?? '')
    .split('/')
    .filter(Boolean)
  return parts[parts.length - 1]?.toUpperCase() ?? ''
}

export async function handler(event) {
  const code = codeFromPath(event.path)
  if (!code) return json(400, { error: 'Missing session code' })

  try {
    if (event.httpMethod === 'GET') {
      const session = await getSession(code)
      if (!session) return json(404, { error: 'Session not found or expired' })
      return json(200, {
        code: session.code,
        status: session.status,
        hasOffer: Boolean(session.offer),
        hasAnswer: Boolean(session.answer),
        offer: session.offer,
        answer: session.answer,
        matchedAt: session.matchedAt,
      })
    }

    if (event.httpMethod === 'POST') {
      let body = {}
      try {
        body = event.body ? JSON.parse(event.body) : {}
      } catch {
        return json(400, { error: 'Invalid JSON body' })
      }
      if (body.kind === 'offer') {
        if (typeof body.payload !== 'string' || body.payload.length < 10) {
          return json(400, { error: 'Invalid offer payload' })
        }
        const s = await putOffer(code, body.payload)
        return json(200, { code: s.code, status: s.status, hasOffer: true, hasAnswer: Boolean(s.answer) })
      }
      if (body.kind === 'answer') {
        if (typeof body.payload !== 'string' || body.payload.length < 10) {
          return json(400, { error: 'Invalid answer payload' })
        }
        const s = await putAnswer(code, body.payload)
        return json(200, { code: s.code, status: s.status, hasOffer: true, hasAnswer: true, matchedAt: s.matchedAt })
      }
      return json(400, { error: 'kind must be "offer" or "answer"' })
    }

    return json(405, { error: 'Method not allowed' })
  } catch (error) {
    return json(500, { error: 'Signaling request failed', details: error.message })
  }
}
