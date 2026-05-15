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
  assert(typeof code === 'string' && code.length >= 5, 'invalid shortcode')

  // Simulated host action payload delivered to guest via signaling state.
  const offerPayload = 'htz1:SMOKE_TEST_HOST_TRIGGER:instant:short-light'
  // Simulated guest response payload delivered back to host.
  const answerPayload = 'htz1:SMOKE_TEST_GUEST_RESPONSE:ack'

  const postOffer = await req(`/api/signal/state/${encodeURIComponent(code)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'offer', payload: offerPayload }),
  })
  console.log('HOST posts offer/trigger ->', postOffer.status, postOffer.json)
  assert(postOffer.status === 200, 'post offer failed')

  const afterOffer = await req(`/api/signal/state/${encodeURIComponent(code)}`)
  console.log('GUEST reads state after host trigger ->', afterOffer.status, afterOffer.json)
  assert(afterOffer.status === 200, 'get state after offer failed')
  assert(afterOffer.json?.hasOffer === true, 'offer missing in session state')
  assert(afterOffer.json?.offer === offerPayload, 'guest did not receive host trigger payload')

  const postAnswer = await req(`/api/signal/state/${encodeURIComponent(code)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'answer', payload: answerPayload }),
  })
  console.log('GUEST posts answer/response ->', postAnswer.status, postAnswer.json)
  assert(postAnswer.status === 200, 'post answer failed')

  const afterAnswer = await req(`/api/signal/state/${encodeURIComponent(code)}`)
  console.log('HOST reads state after guest response ->', afterAnswer.status, afterAnswer.json)
  assert(afterAnswer.status === 200, 'get state after answer failed')
  assert(afterAnswer.json?.status === 'matched', 'session not marked matched')
  assert(afterAnswer.json?.hasAnswer === true, 'answer missing in session state')
  assert(afterAnswer.json?.answer === answerPayload, 'host did not receive guest response payload')

  const created2 = await req('/api/signal/session', { method: 'POST' })
  assert(created2.status === 200, 'second session create failed')
  const code2 = created2.json?.code
  assert(typeof code2 === 'string' && code2.length >= 5, 'invalid second shortcode')

  const postOffer2 = await req(`/api/signal/state/${encodeURIComponent(code2)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'offer', payload: offerPayload + '_NEW' }),
  })
  assert(postOffer2.status === 200, 'post second offer failed')

  const linkNext = await req(`/api/signal/state/${encodeURIComponent(code)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'linkNext', nextCode: code2 }),
  })
  console.log('link next shortcode ->', linkNext.status, linkNext.json)
  assert(linkNext.status === 200, 'linkNext failed')

  const afterLink = await req(`/api/signal/state/${encodeURIComponent(code)}`)
  assert(afterLink.status === 200, 'get state after link failed')
  assert(afterLink.json?.nextShortcode === code2, 'nextShortcode not stored on prior session')

  console.log('Shortcode signaling smoke test passed (host<->guest payload transfer + TTL state transitions + linkNext).')
}

run().catch((err) => {
  console.error('Shortcode signaling smoke test failed:', err.message)
  process.exit(1)
})
