export type DeviceInfo = {
  userAgent: string
  platformHint: string
  browserHint: string
  isIOSLike: boolean
  isCoarsePointer: boolean
  maxTouchPoints: number
  screenCss: string
  dpr: number
  formFactor: 'phone' | 'tablet' | 'desktop' | 'unknown'
}

function classifyFormFactor(width: number, height: number, coarse: boolean, touches: number): DeviceInfo['formFactor'] {
  const min = Math.min(width, height)
  const max = Math.max(width, height)
  if (!coarse && touches === 0) return 'desktop'
  if (min >= 600 && max >= 900) return 'tablet'
  if (coarse || touches > 0) return 'phone'
  if (min < 768) return 'phone'
  return 'unknown'
}

export async function collectDeviceInfo(): Promise<DeviceInfo> {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  const coarse =
    typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(pointer: coarse)').matches : false
  const touches = typeof navigator !== 'undefined' ? navigator.maxTouchPoints ?? 0 : 0
  const w = typeof window !== 'undefined' ? window.screen.width : 0
  const h = typeof window !== 'undefined' ? window.screen.height : 0
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio ?? 1 : 1

  const isIOSLike = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && touches > 1)
  let browserHint = 'Unknown browser'
  if (/CriOS/i.test(ua)) browserHint = 'Chrome (iOS)'
  else if (/FxiOS/i.test(ua)) browserHint = 'Firefox (iOS)'
  else if (/EdgiOS/i.test(ua)) browserHint = 'Edge (iOS)'
  else if (/OPiOS/i.test(ua)) browserHint = 'Opera (iOS)'
  else if (/Version\/[\d.]+.*Safari/i.test(ua)) browserHint = isIOSLike ? 'Safari (iOS)' : 'Safari'
  else if (/Chrome\/[\d.]+/i.test(ua)) browserHint = 'Chrome'
  else if (/Firefox\/[\d.]+/i.test(ua)) browserHint = 'Firefox'

  let platformHint = 'Unknown'
  if (typeof navigator !== 'undefined' && 'userAgentData' in navigator) {
    const ud = (navigator as Navigator & { userAgentData?: { platform?: string; brands?: { brand: string }[] } })
      .userAgentData
    if (ud?.platform) platformHint = ud.platform
    else if (ud?.brands?.length) platformHint = ud.brands.map((b) => b.brand).join(', ')
  }
  if (platformHint === 'Unknown') {
    if (/iPhone|iPad|iPod/i.test(ua)) platformHint = /iPad/i.test(ua) ? 'iPadOS (heuristic)' : 'iOS (heuristic)'
    else if (/Android/i.test(ua)) platformHint = 'Android (heuristic)'
    else if (/Mac OS X/i.test(ua)) platformHint = 'macOS (heuristic)'
    else if (/Windows/i.test(ua)) platformHint = 'Windows (heuristic)'
    else if (/Linux/i.test(ua)) platformHint = 'Linux (heuristic)'
  }

  return {
    userAgent: ua,
    platformHint,
    browserHint,
    isIOSLike,
    isCoarsePointer: coarse,
    maxTouchPoints: touches,
    screenCss: `${w}×${h} CSS px`,
    dpr,
    formFactor: classifyFormFactor(w, h, coarse, touches),
  }
}
