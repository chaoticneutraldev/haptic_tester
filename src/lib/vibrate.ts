/** Max pattern length browsers may accept (ms entries) */
const MAX_PATTERN_ENTRIES = 128

export function vibrateSupported(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function'
}

export function vibratePattern(pattern: number[]): boolean {
  if (!vibrateSupported()) return false
  const flat = pattern.slice(0, MAX_PATTERN_ENTRIES).map((n) => Math.max(0, Math.min(n, 10000)))
  if (flat.length === 0) return true
  try {
    return navigator.vibrate(flat)
  } catch {
    return false
  }
}

export function stopVibrate(): void {
  if (vibrateSupported()) navigator.vibrate(0)
}
