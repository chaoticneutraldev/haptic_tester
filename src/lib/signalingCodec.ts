import { SIGNALING_MAX_BYTES, parseSignalingBundle, stringifySignalingBundle, type SignalingBundle } from './signaling'

/** Prefix for gzip-compressed, base64url-encoded JSON signaling */
export const SIGNALING_COMPACT_PREFIX = 'htz1:'

function uint8ToBase64url(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 8192
  for (let i = 0; i < bytes.length; i += chunk) {
    const sub = bytes.subarray(i, i + chunk)
    binary += String.fromCharCode(...sub)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64urlToUint8(s: string): Uint8Array {
  let b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  while (b64.length % 4) b64 += '='
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function gzipCompress(bytes: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('gzip')
  const w = cs.writable.getWriter()
  void w.write(new Uint8Array(bytes))
  void w.close()
  const buf = await new Response(cs.readable).arrayBuffer()
  return new Uint8Array(buf)
}

async function gzipDecompress(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('gzip')
  const w = ds.writable.getWriter()
  void w.write(new Uint8Array(bytes))
  void w.close()
  const buf = await new Response(ds.readable).arrayBuffer()
  return new Uint8Array(buf)
}

/**
 * Produce the shortest safe string for copy/paste: gzip+base64url when smaller and supported, else JSON.
 */
export async function formatSignalingForPaste(bundle: SignalingBundle): Promise<string> {
  const json = stringifySignalingBundle(bundle)
  if (typeof CompressionStream === 'undefined') return json
  try {
    const utf8 = new TextEncoder().encode(json)
    const gz = await gzipCompress(utf8)
    const compact = `${SIGNALING_COMPACT_PREFIX}${uint8ToBase64url(gz)}`
    return compact.length < json.length ? compact : json
  } catch {
    return json
  }
}

/**
 * Accept compact (`htz1:…`) or legacy JSON signaling blobs.
 */
export async function parseSignalingPaste(raw: string): Promise<SignalingBundle> {
  const t = raw.trim()
  if (t.startsWith(SIGNALING_COMPACT_PREFIX)) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('Compressed signaling is not supported in this browser (no DecompressionStream)')
    }
    const b64 = t.slice(SIGNALING_COMPACT_PREFIX.length).trim()
    if (!b64) throw new Error('Empty compressed payload')
    try {
      const compressed = base64urlToUint8(b64)
      const out = await gzipDecompress(compressed)
      const json = new TextDecoder('utf-8').decode(out)
      if (json.length > SIGNALING_MAX_BYTES) throw new Error('Payload too large')
      return parseSignalingBundle(json)
    } catch (e) {
      if (e instanceof Error && e.message === 'Payload too large') throw e
      const err = new Error('Invalid compressed signaling (corrupt or wrong format)')
      err.cause = e
      throw err
    }
  }
  return parseSignalingBundle(t)
}
