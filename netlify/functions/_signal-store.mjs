const MATCH_TTL_SECONDS = 2 * 60 * 60
const ACTIVE_TTL_SECONDS = 12 * 60 * 60
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function redisEnv() {
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) throw new Error('Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN')
  return { url, token }
}

export function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  }
}

async function redis(command, ...args) {
  const { url, token } = redisEnv()
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify([command, ...args]),
  })
  const payload = await res.json()
  if (!res.ok || payload?.error) {
    throw new Error(payload?.error ?? `Redis command failed: ${command}`)
  }
  return payload?.result
}

function code(length = 5) {
  const arr = new Uint32Array(length)
  crypto.getRandomValues(arr)
  let out = ''
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[arr[i] % CODE_ALPHABET.length]
  return out
}

function keyFor(codeValue) {
  return `signal:${codeValue}`
}

function matchExpiresIso() {
  return new Date(Date.now() + MATCH_TTL_SECONDS * 1000).toISOString()
}

function activeExpiresIso() {
  return new Date(Date.now() + ACTIVE_TTL_SECONDS * 1000).toISOString()
}

export async function createSession() {
  for (let i = 0; i < 10; i++) {
    const c = code(5)
    const key = keyFor(c)
    const base = {
      code: c,
      status: 'waiting',
      createdAt: new Date().toISOString(),
      matchExpiresInSeconds: MATCH_TTL_SECONDS,
      activeTtlSeconds: ACTIVE_TTL_SECONDS,
      matchExpiresAt: matchExpiresIso(),
      activeExpiresAt: null,
      offer: null,
      answer: null,
      matchedAt: null,
      nextShortcode: null,
    }
    const ok = await redis('SET', key, JSON.stringify(base), 'EX', MATCH_TTL_SECONDS, 'NX')
    if (ok === 'OK') return base
  }
  throw new Error('Failed to allocate shortcode; please retry')
}

export async function getSession(codeValue) {
  const value = await redis('GET', keyFor(codeValue))
  if (!value) return null
  return JSON.parse(value)
}

export async function putOffer(codeValue, offerText) {
  const key = keyFor(codeValue)
  const session = await getSession(codeValue)
  if (!session) throw new Error('Session not found or expired')
  session.offer = offerText
  session.updatedAt = new Date().toISOString()
  session.matchExpiresAt = matchExpiresIso()
  if (session.nextShortcode === undefined) session.nextShortcode = null
  await redis('SET', key, JSON.stringify(session), 'EX', MATCH_TTL_SECONDS)
  return session
}

export async function putAnswer(codeValue, answerText) {
  const key = keyFor(codeValue)
  const session = await getSession(codeValue)
  if (!session) throw new Error('Session not found or expired')
  if (!session.offer) throw new Error('Host offer not ready yet')
  session.answer = answerText
  session.status = 'matched'
  session.matchedAt = new Date().toISOString()
  session.updatedAt = session.matchedAt
  session.activeExpiresAt = activeExpiresIso()
  session.matchExpiresAt = null
  if (session.nextShortcode === undefined) session.nextShortcode = null
  await redis('SET', key, JSON.stringify(session), 'EX', ACTIVE_TTL_SECONDS)
  return session
}

/** Guest discovers the follow-up pair code after the host starts a fresh offer. */
export async function putNextShortcode(previousCode, nextCode) {
  const prev = String(previousCode ?? '').toUpperCase()
  const next = String(nextCode ?? '').toUpperCase()
  if (prev.length < 5 || next.length < 5) throw new Error('Invalid shortcode')
  if (prev === next) throw new Error('Next shortcode must differ from the previous code')

  const session = await getSession(prev)
  if (!session) throw new Error('Session not found or expired')
  if (session.status !== 'matched') throw new Error('Previous session is not matched; use a normal pair code instead')

  const nextSession = await getSession(next)
  if (!nextSession) throw new Error('Next session not found or expired')
  if (!nextSession.offer) throw new Error('Host must publish the new offer before linking shortcodes')

  session.nextShortcode = next
  session.updatedAt = new Date().toISOString()
  session.activeExpiresAt = activeExpiresIso()
  await redis('SET', keyFor(prev), JSON.stringify(session), 'EX', ACTIVE_TTL_SECONDS)
  return session
}

export { MATCH_TTL_SECONDS, ACTIVE_TTL_SECONDS }
