import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CURVE_PRESETS, HAPTIC_PRESETS, getPresetById } from '../lib/hapticPresets'
import { stopVibrate, vibratePattern, vibrateSupported } from '../lib/vibrate'

const STORAGE_KEY = 'haptic-tester-custom-pattern'

function parsePatternInput(text: string): number[] | null {
  const parts = text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (parts.length === 0) return null
  const nums = parts.map((p) => Number(p))
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null
  return nums.map((n) => Math.round(n))
}

function loadStoredPattern(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? '20, 40, 20, 40, 60'
  } catch {
    return '20, 40, 20, 40, 60'
  }
}

function LocalHapticsFooter({
  supported,
  mode,
  playing,
  playheadMs,
  patternDurationMs,
  sustainLevel,
  loopMode,
  lastActionAt,
  lastAction,
}: {
  supported: boolean
  mode: 'instant' | 'pattern' | 'sustained'
  playing: boolean
  playheadMs: number
  patternDurationMs: number
  sustainLevel: number
  loopMode: boolean
  lastActionAt: number | null
  lastAction: string | null
}) {
  const [now, setNow] = useState(0)
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])
  const sinceLastAction = lastActionAt ? `${Math.max(0, Math.floor((now - lastActionAt) / 1000))}s` : 'n/a'

  return (
    <div className="pairing-footer">
      <span>
        <strong>Local haptics</strong>
      </span>
      <span>Supported: {supported ? 'Yes' : 'No'}</span>
      <span>Mode: {mode}</span>
      <span>Pattern: {playing ? 'Playing' : 'Idle'}</span>
      <span>
        Playhead: {Math.round(playheadMs)} / {patternDurationMs}ms
      </span>
      <span>Loop: {loopMode ? 'ON' : 'OFF'}</span>
      <span>Sustain: {sustainLevel}</span>
      <span>Last action: {lastAction ?? 'none'}</span>
      <span>Since action: {sinceLastAction}</span>
    </div>
  )
}

export function HapticsTesterPage() {
  const supported = vibrateSupported()
  const [mode, setMode] = useState<'instant' | 'pattern' | 'sustained'>('instant')
  const [customText, setCustomText] = useState(loadStoredPattern)
  const [customError, setCustomError] = useState<string | null>(null)
  const [sustainLevel, setSustainLevel] = useState(0)
  const sustainTimerRef = useRef<number | null>(null)
  const [loopMode, setLoopMode] = useState(false)

  type LocalPattern = { id: string; name: string; durationMs: number; events: { id: string; offsetMs: number; presetId: string }[] }
  const [patterns, setPatterns] = useState<LocalPattern[]>([
    { id: 'a', name: 'Pattern A', durationMs: 2000, events: [] },
    { id: 'b', name: 'Pattern B', durationMs: 3000, events: [] },
    { id: 'c', name: 'Pattern C', durationMs: 4000, events: [] },
  ])
  const [activePatternId, setActivePatternId] = useState('a')
  const [playheadMs, setPlayheadMs] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [lastActionAt, setLastActionAt] = useState<number | null>(null)
  const [lastAction, setLastAction] = useState<string | null>(null)
  const playAnchorRef = useRef<{ startAt: number; startPlayhead: number } | null>(null)
  const playheadRafRef = useRef<number | null>(null)
  const patternTimeoutsRef = useRef<number[]>([])

  const persist = useCallback((text: string) => {
    try {
      localStorage.setItem(STORAGE_KEY, text)
    } catch {
      /* ignore */
    }
  }, [])

  const playPreset = useCallback(
    (id: string) => {
      const p = getPresetById(id)
      if (!p) return
      vibratePattern(p.pattern)
      setLastActionAt(Date.now())
      setLastAction(`Instant: ${p.name}`)
    },
    [],
  )

  const playCustom = useCallback(() => {
    const p = parsePatternInput(customText)
    if (!p) {
      setCustomError('Use comma or space separated milliseconds (non-negative numbers).')
      return
    }
    setCustomError(null)
    persist(customText)
    vibratePattern(p)
    setLastActionAt(Date.now())
    setLastAction('Instant: Custom curve')
  }, [customText, persist])

  const applyCurvePreset = useCallback(
    (name: keyof typeof CURVE_PRESETS) => {
      const pat = CURVE_PRESETS[name]
      const text = pat.join(', ')
      setCustomText(text)
      persist(text)
      vibratePattern(pat)
      setCustomError(null)
      setLastActionAt(Date.now())
      setLastAction(`Instant preset: ${name}`)
    },
    [persist],
  )

  const grouped = useMemo(() => {
    const m = new Map<string, typeof HAPTIC_PRESETS>()
    for (const p of HAPTIC_PRESETS) {
      const k = p.category
      if (!m.has(k)) m.set(k, [])
      m.get(k)!.push(p)
    }
    return m
  }, [])

  const activePattern = useMemo(
    () => patterns.find((p) => p.id === activePatternId) ?? patterns[0],
    [patterns, activePatternId],
  )
  const patternDurationMs = activePattern.durationMs
  const patternEvents = useMemo(() => activePattern.events, [activePattern])

  const clearPatternTimers = useCallback(() => {
    patternTimeoutsRef.current.forEach((t) => window.clearTimeout(t))
    patternTimeoutsRef.current = []
  }, [])

  const stopAll = useCallback(() => {
    clearPatternTimers()
    if (playheadRafRef.current) cancelAnimationFrame(playheadRafRef.current)
    playheadRafRef.current = null
    playAnchorRef.current = null
    setPlaying(false)
    setPlayheadMs(0)
    if (sustainTimerRef.current) window.clearInterval(sustainTimerRef.current)
    sustainTimerRef.current = null
    setSustainLevel(0)
    stopVibrate()
    setLastActionAt(Date.now())
    setLastAction('Stop all')
  }, [clearPatternTimers])

  const schedulePatternCycle = useCallback(
    (initial: number) => {
      clearPatternTimers()
      const startAt = Date.now() + 120
      playAnchorRef.current = { startAt, startPlayhead: initial }
      const now = Date.now()
      const delay0 = Math.max(0, startAt - now)
      for (const ev of patternEvents) {
        if (ev.offsetMs < initial) continue
        const t = window.setTimeout(() => {
          const p = getPresetById(ev.presetId)
          if (p) {
            vibratePattern(p.pattern)
            setLastActionAt(Date.now())
            setLastAction(`Pattern: ${p.name}`)
          }
        }, delay0 + (ev.offsetMs - initial))
        patternTimeoutsRef.current.push(t)
      }
    },
    [clearPatternTimers, patternEvents],
  )

  const startPattern = useCallback(() => {
    setPlaying(true)
    setLastActionAt(Date.now())
    setLastAction('Pattern: Play')
    schedulePatternCycle(playheadMs)
  }, [playheadMs, schedulePatternCycle])

  const pausePattern = useCallback(() => {
    clearPatternTimers()
    playAnchorRef.current = null
    setPlaying(false)
    setLastActionAt(Date.now())
    setLastAction('Pattern: Pause')
  }, [clearPatternTimers])

  useEffect(() => {
    if (mode !== 'pattern' || !playing) {
      if (playheadRafRef.current) cancelAnimationFrame(playheadRafRef.current)
      playheadRafRef.current = null
      return
    }
    const loop = () => {
      const anchor = playAnchorRef.current
      if (!anchor) return
      const elapsed = Date.now() - anchor.startAt
      const next = Math.min(patternDurationMs, anchor.startPlayhead + elapsed)
      setPlayheadMs(next)
      if (next >= patternDurationMs) {
        if (loopMode) {
          setPlayheadMs(0)
          schedulePatternCycle(0)
          playheadRafRef.current = requestAnimationFrame(loop)
          return
        }
        setPlaying(false)
        playAnchorRef.current = null
        return
      }
      playheadRafRef.current = requestAnimationFrame(loop)
    }
    playheadRafRef.current = requestAnimationFrame(loop)
    return () => {
      if (playheadRafRef.current) cancelAnimationFrame(playheadRafRef.current)
    }
  }, [mode, playing, patternDurationMs, loopMode, schedulePatternCycle])

  const updateActivePattern = useCallback(
    (updater: (p: LocalPattern) => LocalPattern) => {
      setPatterns((prev) => prev.map((p) => (p.id === activePatternId ? updater(p) : p)))
    },
    [activePatternId],
  )

  const adjustPatternDuration = (delta: number) => {
    const nextDuration = Math.min(16000, Math.max(1000, patternDurationMs + delta))
    updateActivePattern((p) => ({ ...p, durationMs: nextDuration }))
    setPlayheadMs((prev) => Math.min(prev, nextDuration))
  }

  const addPatternEvent = (presetId: string) => {
    updateActivePattern((p) => ({
      ...p,
      events: [...p.events, { id: crypto.randomUUID(), offsetMs: Math.round(playheadMs / 50) * 50, presetId }],
    }))
  }

  const removePatternEvent = (id: string) => {
    updateActivePattern((p) => ({ ...p, events: p.events.filter((e) => e.id !== id) }))
  }

  const sendSustainLevel = (nextLevel: number) => {
    const clamped = Math.max(0, Math.min(100, Math.round(nextLevel)))
    setSustainLevel(clamped)
    if (sustainTimerRef.current) {
      window.clearInterval(sustainTimerRef.current)
      sustainTimerRef.current = null
    }
    if (!supported || clamped === 0) {
      stopVibrate()
      setLastActionAt(Date.now())
      setLastAction('Sustained: Off')
      return
    }
    const onMs = Math.max(20, Math.round((clamped / 100) * 240))
    const offMs = Math.max(35, 180 - Math.round((clamped / 100) * 120))
    const run = () => {
      vibratePattern([onMs, offMs])
      setLastActionAt(Date.now())
      setLastAction(`Sustained: ${clamped}`)
    }
    run()
    sustainTimerRef.current = window.setInterval(run, onMs + offMs)
  }

  useEffect(() => {
    return () => {
      if (sustainTimerRef.current) window.clearInterval(sustainTimerRef.current)
      clearPatternTimers()
      if (playheadRafRef.current) cancelAnimationFrame(playheadRafRef.current)
    }
  }, [clearPatternTimers])

  return (
    <div className="page stack">
      <h1>Haptics tester</h1>
      <p className="lede">
        Each cell maps to a <code>navigator.vibrate</code> pattern. iOS-native labels are educational; Safari does not
        expose the same APIs.
      </p>
      {!supported && <p className="callout">Vibration API not available in this browser.</p>}

      <section className="panel row wrap">
        <label className="toggle">
          <span>Mode</span>
          <select value={mode} onChange={(e) => setMode(e.target.value as 'instant' | 'pattern' | 'sustained')}>
            <option value="instant">Instant</option>
            <option value="pattern">Pattern</option>
            <option value="sustained">Sustained</option>
          </select>
        </label>
        <button type="button" className="btn btn-danger" onClick={stopAll}>
          Stop all
        </button>
      </section>

      {mode === 'instant' && (
        <>
          {Array.from(grouped.entries()).map(([category, presets]) => (
            <section key={category} className="panel stack">
              <h2 className="cap-title">{category}</h2>
              <div className="preset-grid">
                {presets.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="preset-cell"
                    onClick={() => playPreset(p.id)}
                    disabled={!supported}
                  >
                    <span className="preset-name">{p.name}</span>
                    <span className="preset-pattern">{p.pattern.join(' · ')} ms</span>
                    {p.iosAnalogue && <span className="preset-ios">{p.iosAnalogue}</span>}
                  </button>
                ))}
              </div>
            </section>
          ))}

          <section className="panel stack">
            <h2>Custom pattern (“curve”)</h2>
            <p className="muted">
              Web vibration is on/off timing only. “Intensity” is approximated by varying pulse lengths and gaps.
            </p>
            <label className="field">
              <span>Pattern (ms)</span>
              <textarea
                className="input"
                rows={3}
                value={customText}
                onChange={(e) => setCustomText(e.target.value)}
                spellCheck={false}
              />
            </label>
            {customError && <p className="warn">{customError}</p>}
            <div className="row wrap">
              <button type="button" className="btn btn-primary" onClick={playCustom} disabled={!supported}>
                Play custom
              </button>
              <button type="button" className="btn" onClick={() => applyCurvePreset('game-progress')} disabled={!supported}>
                Preset: game progress
              </button>
              <button type="button" className="btn" onClick={() => applyCurvePreset('footsteps')} disabled={!supported}>
                Preset: footsteps
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => applyCurvePreset('urgent-attention')}
                disabled={!supported}
              >
                Preset: urgent attention
              </button>
            </div>
          </section>
        </>
      )}

      {mode === 'pattern' && (
        <section className="panel stack">
          <h2>Pattern mode</h2>
          <p className="muted">Three local pattern slots, each with its own timeline and duration. Loop mode is global.</p>
          <div className="row wrap">
            {patterns.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`btn ${p.id === activePatternId ? 'btn-primary' : ''}`}
                disabled={playing}
                onClick={() => {
                  setActivePatternId(p.id)
                  setPlayheadMs(0)
                }}
              >
                {p.name}
              </button>
            ))}
          </div>
          <div className="row wrap">
            <button type="button" className="btn" onClick={() => adjustPatternDuration(-1000)} disabled={patternDurationMs <= 1000}>
              -1s
            </button>
            <button type="button" className="btn" onClick={() => adjustPatternDuration(1000)} disabled={patternDurationMs >= 16000}>
              +1s
            </button>
            <span className="pill">{(patternDurationMs / 1000).toFixed(0)}s</span>
            <label className="field inline">
              <span>Loop</span>
              <input type="checkbox" checked={loopMode} onChange={(e) => setLoopMode(e.target.checked)} />
            </label>
            {!playing ? (
              <button type="button" className="btn btn-primary" onClick={startPattern} disabled={!supported}>
                Play
              </button>
            ) : (
              <button type="button" className="btn" onClick={pausePattern}>
                Pause
              </button>
            )}
          </div>
          <div
            className="timeline"
            onClick={(e) => {
              if (playing) return
              const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect()
              const x = e.clientX - rect.left
              const ratio = Math.min(1, Math.max(0, x / rect.width))
              setPlayheadMs(Math.round((ratio * patternDurationMs) / 50) * 50)
            }}
          >
            <div className="timeline-inner">
              {patternEvents.map((ev) => (
                <button
                  key={ev.id}
                  type="button"
                  className="timeline-note"
                  style={{ left: `${(ev.offsetMs / patternDurationMs) * 100}%` }}
                  onClick={(e) => {
                    e.stopPropagation()
                    if (!playing) setPlayheadMs(ev.offsetMs)
                  }}
                />
              ))}
              <div className="timeline-playhead" style={{ left: `${(playheadMs / patternDurationMs) * 100}%` }} />
            </div>
          </div>
          <div className="row wrap">
            <label className="field inline">
              <span>Add at playhead</span>
              <select
                key={patternEvents.length}
                defaultValue=""
                onChange={(e) => {
                  const v = e.target.value
                  if (v) addPatternEvent(v)
                }}
                disabled={playing}
              >
                <option value="">Select preset...</option>
                {HAPTIC_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <ul className="event-list">
            {patternEvents.map((ev) => {
              const p = getPresetById(ev.presetId)
              return (
                <li key={ev.id} className="event-row">
                  <span>
                    {p?.name ?? ev.presetId} @ {ev.offsetMs}ms
                  </span>
                  <button type="button" className="btn btn-ghost" disabled={playing} onClick={() => removePatternEvent(ev.id)}>
                    Remove
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {mode === 'sustained' && (
        <section className="panel stack">
          <h2>Sustained mode</h2>
          <p className="muted">Set a continuous local buzz level. 0 turns sustained buzz off.</p>
          <div className="row wrap">
            <button type="button" className="btn" onClick={() => sendSustainLevel(sustainLevel - 10)} disabled={!supported}>
              -10
            </button>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={sustainLevel}
              onChange={(e) => sendSustainLevel(Number(e.target.value))}
              disabled={!supported}
            />
            <button type="button" className="btn" onClick={() => sendSustainLevel(sustainLevel + 10)} disabled={!supported}>
              +10
            </button>
            <span className="pill">Level {sustainLevel}</span>
          </div>
          <div className="row wrap">
            <button type="button" className="btn" onClick={() => sendSustainLevel(0)} disabled={!supported}>
              Stop
            </button>
            <button type="button" className="btn btn-primary" onClick={() => sendSustainLevel(60)} disabled={!supported}>
              Medium
            </button>
            <button type="button" className="btn" onClick={() => sendSustainLevel(90)} disabled={!supported}>
              Strong
            </button>
          </div>
        </section>
      )}
      <LocalHapticsFooter
        supported={supported}
        mode={mode}
        playing={playing}
        playheadMs={playheadMs}
        patternDurationMs={patternDurationMs}
        sustainLevel={sustainLevel}
        loopMode={loopMode}
        lastActionAt={lastActionAt}
        lastAction={lastAction}
      />
    </div>
  )
}
