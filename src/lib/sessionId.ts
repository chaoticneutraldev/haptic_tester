const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function generateSessionId(length = 8): string {
  const a = new Uint32Array(length)
  crypto.getRandomValues(a)
  let s = ''
  for (let i = 0; i < length; i++) s += ALPHABET[a[i]! % ALPHABET.length]
  return s
}
