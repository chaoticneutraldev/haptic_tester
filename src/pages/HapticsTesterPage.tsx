import { useCallback, useMemo, useState } from 'react'
import { CURVE_PRESETS, HAPTIC_PRESETS, getPresetById } from '../lib/hapticPresets'
import { vibratePattern, vibrateSupported } from '../lib/vibrate'

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

export function HapticsTesterPage() {
  const supported = vibrateSupported()
  const [customText, setCustomText] = useState(loadStoredPattern)
  const [customError, setCustomError] = useState<string | null>(null)

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
  }, [customText, persist])

  const applyCurvePreset = useCallback(
    (name: keyof typeof CURVE_PRESETS) => {
      const pat = CURVE_PRESETS[name]
      const text = pat.join(', ')
      setCustomText(text)
      persist(text)
      vibratePattern(pat)
      setCustomError(null)
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

  return (
    <div className="page stack">
      <h1>Haptics tester</h1>
      <p className="lede">
        Each cell maps to a <code>navigator.vibrate</code> pattern. iOS-native labels are educational; Safari does not
        expose the same APIs.
      </p>
      {!supported && <p className="callout">Vibration API not available in this browser.</p>}

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
    </div>
  )
}
