function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  }
}

async function meteredFetch(base, path) {
  const res = await fetch(`${base}${path}`)
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
  if (event.httpMethod !== 'GET') {
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

  const username = event.path.split('/').filter(Boolean).pop()
  if (!username) {
    return json(400, { error: 'username is required' })
  }

  const base = `https://${appName}.metered.live`
  try {
    const usage = await meteredFetch(
      base,
      `/api/v1/turn/current_usage_for_user?secretKey=${encodeURIComponent(secretKey)}&username=${encodeURIComponent(username)}`,
    )
    return json(200, {
      username,
      usageInGB: usage.usageInGB,
    })
  } catch (error) {
    return json(error.status ?? 500, {
      error: 'Failed to fetch credential usage',
      details: error.payload ?? error.message,
    })
  }
}
