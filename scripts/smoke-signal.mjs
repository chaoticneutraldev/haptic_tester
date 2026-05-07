const base = process.env.BASE_URL ?? 'https://boisterous-sundae-56358a.netlify.app'

async function req(path, init) {
  const res = await fetch(`${base}${path}`, init)
  const text = await res.text()
  let json
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = { raw: text }
  }
  return { status: res.status, json }
}

function assert(ok, message) {
  if (!ok) throw new Error(message)
}

async function run() {
  console.log(`Smoke testing shortcode signaling at: ${base}`)

  const created = await req('/api/signal/session', { method: 'POST' })
  console.log('create session ->', created.status, created.json)
  assert(created.status === 200, 'session create failed')
  const code = created.json?.code
  assert(typeof code === 'string' && code.length >= 6, 'invalid shortcode')

  const offerPayload = 'htz1:SMOKE_TEST_OFFER'
  const answerPayload = 'htz1:SMOKE_TEST_ANSWER'

  const postOffer = await req(`/api/signal/state/${encodeURIComponent(code)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'offer', payload: offerPayload }),
  })
  console.log('post offer ->', postOffer.status, postOffer.json)
  assert(postOffer.status === 200, 'post offer failed')

  const afterOffer = await req(`/api/signal/state/${encodeURIComponent(code)}`)
  console.log('get state after offer ->', afterOffer.status, afterOffer.json)
  assert(afterOffer.status === 200, 'get state after offer failed')
  assert(afterOffer.json?.hasOffer === true, 'offer missing in session state')

  const postAnswer = await req(`/api/signal/state/${encodeURIComponent(code)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'answer', payload: answerPayload }),
  })
  console.log('post answer ->', postAnswer.status, postAnswer.json)
  assert(postAnswer.status === 200, 'post answer failed')

  const afterAnswer = await req(`/api/signal/state/${encodeURIComponent(code)}`)
  console.log('get state after answer ->', afterAnswer.status, afterAnswer.json)
  assert(afterAnswer.status === 200, 'get state after answer failed')
  assert(afterAnswer.json?.status === 'matched', 'session not marked matched')
  assert(afterAnswer.json?.hasAnswer === true, 'answer missing in session state')

  console.log('Shortcode signaling smoke test passed.')
}

run().catch((err) => {
  console.error('Shortcode signaling smoke test failed:', err.message)
  process.exit(1)
})
