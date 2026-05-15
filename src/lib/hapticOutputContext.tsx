import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  ButtplugBrowserWebsocketClientConnector,
  ButtplugClient,
  type ButtplugClientDevice,
  DeviceOutput,
  OutputType,
} from 'buttplug'
import { bestEffortHapticsMode, stopVibrate, vibratePattern, vibrateSupported } from './vibrate'

const WS_KEY = 'haptic-intiface-ws-url'
const PREF_KEY = 'haptic-output-preference'

export type HapticOutputPreference = 'auto' | 'mobile' | 'intiface' | 'both'

export type HapticConnStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export type HapticOutputContextValue = {
  wsUrl: string
  setWsUrl: (u: string) => void
  outputPreference: HapticOutputPreference
  setOutputPreference: (p: HapticOutputPreference) => void
  connectionStatus: HapticConnStatus
  connectionError: string | null
  scanning: boolean
  intifaceDevices: { index: number; name: string }[]
  /** Intiface websocket is up and at least one device exposes Vibrate output. */
  intifaceReady: boolean
  phoneHapticsCapable: boolean
  connectIntiface: () => Promise<void>
  disconnectIntiface: () => Promise<void>
  startIntifaceScan: () => Promise<void>
  stopIntifaceScan: () => Promise<void>
  /** Phone (`navigator.vibrate` / simulation) plus optional Intiface, honoring output preference. */
  playRoutingPattern: (pattern: number[], opts?: { hostPairingPreviewScale?: number }) => void
  /** Matches guest sustained buzz cadence; one tick of the sustaining loop. */
  pulseRoutingSustain: (level0to100: number, opts?: { hostPairingPreviewScale?: number }) => void
  stopAllHardwareOutputs: () => void
}

const HapticOutputContext = createContext<HapticOutputContextValue | null>(null)

function loadWs(): string {
  try {
    const u = localStorage.getItem(WS_KEY)
    if (u?.trim()) return u.trim()
  } catch {
    /* ignore */
  }
  return 'ws://127.0.0.1:12345'
}

function loadPref(): HapticOutputPreference {
  try {
    const v = localStorage.getItem(PREF_KEY)
    if (v === 'mobile' || v === 'intiface' || v === 'both' || v === 'auto') return v
  } catch {
    /* ignore */
  }
  return 'auto'
}

function deviceVibrates(d: ButtplugClientDevice): boolean {
  try {
    return d.hasOutput(OutputType.Vibrate)
  } catch {
    return false
  }
}

function scalePhonePattern(pattern: number[], scale: number): number[] {
  if (scale <= 0) return []
  if (scale >= 1) return pattern
  return pattern.map((ms, i) => {
    if (i % 2 === 1) return ms
    if (ms <= 0) return 0
    return Math.max(1, Math.round(ms * scale))
  })
}

function resolveFlags(
  pref: HapticOutputPreference,
  intifaceReady: boolean,
  phoneCapable: boolean,
): { phone: boolean; intiface: boolean } {
  switch (pref) {
    case 'mobile':
      return { phone: phoneCapable, intiface: false }
    case 'intiface':
      return { phone: false, intiface: intifaceReady }
    case 'both':
      return { phone: phoneCapable, intiface: intifaceReady }
    case 'auto':
    default:
      if (intifaceReady) return { phone: false, intiface: true }
      return { phone: phoneCapable, intiface: false }
  }
}

export function HapticOutputProvider({ children }: { children: ReactNode }) {
  const [wsUrl, setWsUrlState] = useState(loadWs)
  const [outputPreference, setOutputPreferenceState] = useState<HapticOutputPreference>(loadPref)
  const [connectionStatus, setConnectionStatus] = useState<HapticConnStatus>('disconnected')
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [intifaceDevices, setIntifaceDevices] = useState<{ index: number; name: string }[]>([])

  const clientRef = useRef<ButtplugClient | null>(null)
  const patternTimersRef = useRef<number[]>([])

  const setWsUrl = useCallback((u: string) => {
    setWsUrlState(u)
    try {
      localStorage.setItem(WS_KEY, u)
    } catch {
      /* ignore */
    }
  }, [])

  const setOutputPreference = useCallback((p: HapticOutputPreference) => {
    setOutputPreferenceState(p)
    try {
      localStorage.setItem(PREF_KEY, p)
    } catch {
      /* ignore */
    }
  }, [])

  const phoneHapticsCapable = vibrateSupported() || bestEffortHapticsMode()

  const syncDevicesFromClient = useCallback(() => {
    const c = clientRef.current
    if (!c?.connected) {
      setIntifaceDevices([])
      return
    }
    setIntifaceDevices(
      Array.from(c.devices.values())
        .filter(deviceVibrates)
        .map((d) => ({ index: d.index, name: d.displayName ?? d.name })),
    )
  }, [])

  const intifaceReady = connectionStatus === 'connected' && intifaceDevices.length > 0

  const clearPatternTimers = useCallback(() => {
    patternTimersRef.current.forEach((id) => window.clearTimeout(id))
    patternTimersRef.current = []
  }, [])

  const getVibrateDevices = useCallback((): ButtplugClientDevice[] => {
    const c = clientRef.current
    if (!c?.connected) return []
    return Array.from(c.devices.values()).filter(deviceVibrates)
  }, [])

  const scheduleIntifacePattern = useCallback(
    (pattern: number[], intensity: number) => {
      const devices = getVibrateDevices()
      if (devices.length === 0 || intensity <= 0) return
      let at = 0
      for (let i = 0; i < pattern.length; i++) {
        const ms = Math.max(0, Math.min(pattern[i] ?? 0, 10_000))
        if (i % 2 === 0 && ms > 0) {
          const startId = window.setTimeout(() => {
            const p = Math.min(1, Math.max(0, intensity))
            for (const d of devices) {
              void d.runOutput(DeviceOutput.Vibrate.percent(p)).catch(() => {})
            }
          }, at)
          patternTimersRef.current.push(startId)
          const onDur = ms
          const endId = window.setTimeout(() => {
            for (const d of devices) {
              void d.runOutput(DeviceOutput.Vibrate.percent(0)).catch(() => {})
            }
          }, at + onDur)
          patternTimersRef.current.push(endId)
        }
        at += ms
        if (at > 20_000) break
      }
    },
    [getVibrateDevices],
  )

  const playRoutingPattern = useCallback(
    (pattern: number[], opts?: { hostPairingPreviewScale?: number }) => {
      const scale = opts?.hostPairingPreviewScale ?? 1
      const flags = resolveFlags(outputPreference, intifaceReady, phoneHapticsCapable)
      if (flags.phone && scale > 0) {
        const scaled = scalePhonePattern(pattern, scale)
        if (scaled.length > 0) vibratePattern(scaled)
      }
      if (flags.intiface && scale > 0) {
        scheduleIntifacePattern(pattern, scale)
      }
    },
    [intifaceReady, outputPreference, phoneHapticsCapable, scheduleIntifacePattern],
  )

  const pulseRoutingSustain = useCallback(
    (level0to100: number, opts?: { hostPairingPreviewScale?: number }) => {
      const scale = opts?.hostPairingPreviewScale ?? 1
      const level = Math.max(0, Math.min(100, level0to100))
      if (level <= 0 || scale <= 0) return
      const flags = resolveFlags(outputPreference, intifaceReady, phoneHapticsCapable)
      const onMs = Math.max(20, Math.round((level / 100) * 240))
      const offMs = Math.max(35, 180 - Math.round((level / 100) * 120))
      if (flags.phone && phoneHapticsCapable) {
        const scaled = scalePhonePattern([onMs, offMs], scale)
        if (scaled.length > 0) vibratePattern(scaled)
      }
      if (flags.intiface) {
        const p = Math.min(1, Math.max(0, (level / 100) * scale))
        const devices = getVibrateDevices()
        for (const d of devices) {
          void d.runOutput(DeviceOutput.Vibrate.percent(p)).catch(() => {})
        }
        const endId = window.setTimeout(() => {
          for (const d of devices) {
            void d.runOutput(DeviceOutput.Vibrate.percent(0)).catch(() => {})
          }
        }, onMs)
        patternTimersRef.current.push(endId)
      }
    },
    [getVibrateDevices, intifaceReady, outputPreference, phoneHapticsCapable],
  )

  const stopAllHardwareOutputs = useCallback(() => {
    clearPatternTimers()
    stopVibrate()
    const c = clientRef.current
    if (c?.connected) {
      void c.stopAllDevices().catch(() => {})
    }
  }, [clearPatternTimers])

  const connectIntiface = useCallback(async () => {
    if (clientRef.current?.connected) return
    setConnectionError(null)
    setConnectionStatus('connecting')
    try {
      const client = new ButtplugClient('haptic_tester')
      const connector = new ButtplugBrowserWebsocketClientConnector(wsUrl)
      await client.connect(connector)
      clientRef.current = client
      client.on('disconnect', () => {
        clientRef.current = null
        setConnectionStatus('disconnected')
        setScanning(false)
        syncDevicesFromClient()
      })
      client.on('deviceadded', syncDevicesFromClient)
      client.on('deviceremoved', syncDevicesFromClient)
      client.on('scanningfinished', () => {
        setScanning(false)
        syncDevicesFromClient()
      })
      setConnectionStatus('connected')
      syncDevicesFromClient()
    } catch (e) {
      clientRef.current = null
      setIntifaceDevices([])
      setConnectionStatus('error')
      setConnectionError(e instanceof Error ? e.message : 'Intiface connection failed')
    }
  }, [syncDevicesFromClient, wsUrl])

  const disconnectIntiface = useCallback(async () => {
    clearPatternTimers()
    const c = clientRef.current
    if (!c) {
      setConnectionStatus('disconnected')
      setIntifaceDevices([])
      return
    }
    try {
      await c.disconnect()
    } catch {
      /* ignore */
    }
    clientRef.current = null
    setConnectionStatus('disconnected')
    setScanning(false)
    setIntifaceDevices([])
  }, [clearPatternTimers])

  const startIntifaceScan = useCallback(async () => {
    const c = clientRef.current
    if (!c?.connected) return
    try {
      setScanning(true)
      await c.startScanning()
    } catch (e) {
      setScanning(false)
      setConnectionError(e instanceof Error ? e.message : 'Bluetooth scan failed')
    }
  }, [])

  const stopIntifaceScan = useCallback(async () => {
    const c = clientRef.current
    if (!c?.connected) return
    try {
      await c.stopScanning()
    } catch {
      /* ignore */
    }
    setScanning(false)
  }, [])

  const value = useMemo(
    (): HapticOutputContextValue => ({
      wsUrl,
      setWsUrl,
      outputPreference,
      setOutputPreference,
      connectionStatus,
      connectionError,
      scanning,
      intifaceDevices,
      intifaceReady,
      phoneHapticsCapable,
      connectIntiface,
      disconnectIntiface,
      startIntifaceScan,
      stopIntifaceScan,
      playRoutingPattern,
      pulseRoutingSustain,
      stopAllHardwareOutputs,
    }),
    [
      wsUrl,
      setWsUrl,
      outputPreference,
      setOutputPreference,
      connectionStatus,
      connectionError,
      scanning,
      intifaceDevices,
      intifaceReady,
      phoneHapticsCapable,
      connectIntiface,
      disconnectIntiface,
      startIntifaceScan,
      stopIntifaceScan,
      playRoutingPattern,
      pulseRoutingSustain,
      stopAllHardwareOutputs,
    ],
  )

  return <HapticOutputContext.Provider value={value}>{children}</HapticOutputContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components -- hook colocated with provider
export function useHapticOutput(): HapticOutputContextValue {
  const v = useContext(HapticOutputContext)
  if (!v) throw new Error('useHapticOutput must be used within HapticOutputProvider')
  return v
}
