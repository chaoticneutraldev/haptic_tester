/** Max pattern length browsers may accept (ms entries) */
const MAX_PATTERN_ENTRIES = 128

let simTimers: number[] = []

function isiOSLikeWeb(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  const isIOS = /iPhone|iPad|iPod/i.test(ua)
  const isIPadDesktopUA = /Macintosh/i.test(ua) && (navigator.maxTouchPoints ?? 0) > 1
  return isIOS || isIPadDesktopUA
}

function clearSimulation(): void {
  simTimers.forEach((id) => window.clearTimeout(id))
  simTimers = []
  if (typeof document !== 'undefined') document.body.classList.remove('haptic-sim-active')
}

function pulseSimulation(onMs: number): void {
  if (typeof document === 'undefined') return
  document.body.classList.add('haptic-sim-active')
  const off = window.setTimeout(() => {
    document.body.classList.remove('haptic-sim-active')
  }, Math.max(24, Math.min(onMs, 180)))
  simTimers.push(off)
}

function simulatePattern(pattern: number[]): void {
  if (typeof window === 'undefined') return
  clearSimulation()
  let at = 0
  for (let i = 0; i < pattern.length; i++) {
    const ms = Math.max(0, Math.min(pattern[i] ?? 0, 10_000))
    if (i % 2 === 0 && ms > 0) {
      const t = window.setTimeout(() => pulseSimulation(ms), at)
      simTimers.push(t)
    }
    at += ms
    if (at > 20_000) break
  }
}

export function vibrateSupported(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function'
}

export function bestEffortHapticsMode(): boolean {
  return !vibrateSupported() && isiOSLikeWeb()
}

export function vibratePattern(pattern: number[]): boolean {
  const flat = pattern.slice(0, MAX_PATTERN_ENTRIES).map((n) => Math.max(0, Math.min(n, 10000)))
  if (flat.length === 0) return true
  if (!vibrateSupported()) {
    if (bestEffortHapticsMode()) {
      simulatePattern(flat)
      return true
    }
    return false
  }
  try {
    clearSimulation()
    return navigator.vibrate(flat)
  } catch {
    return false
  }
}

export function stopVibrate(): void {
  clearSimulation()
  if (vibrateSupported()) navigator.vibrate(0)
}
