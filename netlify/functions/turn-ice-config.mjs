const DEFAULT_EXPIRY_SECONDS = Number(process.env.DEFAULT_EXPIRY_SECONDS ?? 86400)

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  }
}

async function meteredFetch(base, path, init = {}) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const text = await res.text()
  let payload
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = { raw: text }
  }
  if (!res.ok) {
    const err = new Error(`Metered API ${res.status}`)
    err.status = res.status
    err.payload = payload
    throw err
  }
  return payload
}

export async function handler(event) {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' })
  }

  const appName = process.env.METERED_APP_NAME
  const secretKey = process.env.METERED_SECRET_KEY
  if (!appName || !secretKey) {
    return json(500, {
      error: 'TURN service misconfigured',
      details: 'Missing METERED_APP_NAME or METERED_SECRET_KEY',
    })
  }

  const base = `https://${appName}.metered.live`
  let body = {}
  try {
    body = event.body ? JSON.parse(event.body) : {}
  } catch {
    return json(400, { error: 'Invalid JSON body' })
  }

  const label = typeof body.label === 'string' ? body.label.slice(0, 100) : undefined
  const region = typeof body.region === 'string' ? body.region : undefined
  const expiryRaw = Number(body.expiryInSeconds)
  const expiryInSeconds =
    Number.isFinite(expiryRaw) && expiryRaw > 0 ? Math.floor(expiryRaw) : DEFAULT_EXPIRY_SECONDS

  try {
    const created = await meteredFetch(
      base,
      `/api/v1/turn/credential?secretKey=${encodeURIComponent(secretKey)}`,
      {
        method: 'POST',
        body: JSON.stringify({
          expiryInSeconds,
          ...(label ? { label } : {}),
        }),
      },
    )

    const params = new URLSearchParams({ apiKey: created.apiKey })
    if (region) params.set('region', region)
    const iceServers = await meteredFetch(base, `/api/v1/turn/credentials?${params.toString()}`)

    const issuedAt = new Date().toISOString()
    const expiresAt = new Date(Date.now() + expiryInSeconds * 1000).toISOString()

    return json(200, {
      iceServers,
      credential: {
        username: created.username,
        label: created.label ?? null,
        expiryInSeconds,
        issuedAt,
        expiresAt,
      },
    })
  } catch (error) {
    return json(error.status ?? 500, {
      error: 'Failed to create TURN credential',
      details: error.payload ?? error.message,
    })
  }
}
