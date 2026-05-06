export type HapticPreset = {
  id: string
  name: string
  /** Vibration API pattern: alternating on/off in ms */
  pattern: number[]
  /** Documentary note when web cannot match native iOS APIs */
  iosAnalogue?: string
  category: 'pulse' | 'notification' | 'rhythm' | 'game' | 'niche'
}

export const HAPTIC_PRESETS: HapticPreset[] = [
  {
    id: 'short-light',
    name: 'Short light',
    pattern: [15],
    iosAnalogue: 'UIImpactFeedbackGenerator(.light)',
    category: 'pulse',
  },
  {
    id: 'short-medium',
    name: 'Short medium',
    pattern: [30],
    iosAnalogue: 'UIImpactFeedbackGenerator(.medium)',
    category: 'pulse',
  },
  {
    id: 'short-heavy',
    name: 'Short heavy',
    pattern: [60],
    iosAnalogue: 'UIImpactFeedbackGenerator(.heavy)',
    category: 'pulse',
  },
  {
    id: 'double-tap',
    name: 'Double tap',
    pattern: [20, 40, 20],
    iosAnalogue: 'Two light impacts in sequence',
    category: 'pulse',
  },
  {
    id: 'triple-tap',
    name: 'Triple tap',
    pattern: [15, 35, 15, 35, 15],
    category: 'pulse',
  },
  {
    id: 'success',
    name: 'Success (approx.)',
    pattern: [10, 50, 10, 50, 80],
    iosAnalogue: 'UINotificationFeedbackGenerator(.success) — not reproducible on web',
    category: 'notification',
  },
  {
    id: 'warning',
    name: 'Warning (approx.)',
    pattern: [40, 30, 40, 30, 40],
    iosAnalogue: 'UINotificationFeedbackGenerator(.warning)',
    category: 'notification',
  },
  {
    id: 'error',
    name: 'Error (approx.)',
    pattern: [60, 40, 60, 40, 120],
    iosAnalogue: 'UINotificationFeedbackGenerator(.error)',
    category: 'notification',
  },
  {
    id: 'heartbeat',
    name: 'Heartbeat',
    pattern: [40, 80, 40, 400],
    category: 'rhythm',
  },
  {
    id: 'clock-tick',
    name: 'Clock tick',
    pattern: [8, 120],
    category: 'rhythm',
  },
  {
    id: 'rumble-short',
    name: 'Rumble burst',
    pattern: [120, 40, 120],
    category: 'game',
  },
  {
    id: 'machine-gun',
    name: 'Rapid taps',
    pattern: [10, 15, 10, 15, 10, 15, 10, 15, 10],
    category: 'game',
  },
  {
    id: 'morse-s',
    name: 'Morse S (···)',
    pattern: [20, 40, 20, 40, 20, 40, 20],
    category: 'niche',
  },
  {
    id: 'morse-o',
    name: 'Morse O (---)',
    pattern: [60, 40, 60, 40, 60],
    category: 'niche',
  },
  {
    id: 'crescendo',
    name: 'Crescendo',
    pattern: [15, 20, 25, 20, 35, 20, 50, 20, 70],
    category: 'game',
  },
  {
    id: 'alarm-pulse',
    name: 'Alarm pulse',
    pattern: [80, 80, 80, 80, 80, 200, 80, 80, 80, 80, 80],
    category: 'notification',
  },
]

export const CURVE_PRESETS: Record<string, number[]> = {
  'game-progress': [20, 60, 20, 60, 20, 60, 40, 120],
  footsteps: [12, 180, 12, 180, 12, 180, 12, 220],
  'urgent-attention': [30, 30, 30, 30, 30, 30, 100, 30, 30, 30, 30, 30, 30, 200],
}

export function getPresetById(id: string): HapticPreset | undefined {
  return HAPTIC_PRESETS.find((p) => p.id === id)
}
