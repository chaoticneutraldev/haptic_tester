import type { DeviceInfo } from '../lib/deviceDetect'

type Props = {
  formFactor: DeviceInfo['formFactor']
}

/** Illustrative only—not from device blueprints */
export function DeviceSilhouette({ formFactor }: Props) {
  const isTablet = formFactor === 'tablet'
  const w = isTablet ? 200 : 120
  const h = isTablet ? 260 : 240
  const rx = isTablet ? 18 : 28

  return (
    <figure className="silhouette" aria-label="Illustrative device outline">
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img">
        <title>Generic {formFactor} outline with typical motor regions</title>
        <rect x="8" y="8" width={w - 16} height={h - 16} rx={rx} fill="var(--surface-2)" stroke="var(--border)" strokeWidth="2" />
        <rect x={w / 2 - 24} y="14" width="48" height="5" rx="2" fill="var(--border)" opacity="0.7" />
        <circle cx={w * 0.35} cy={h * 0.72} r="10" fill="var(--accent-muted)" opacity="0.85" />
        <circle cx={w * 0.65} cy={h * 0.72} r="10" fill="var(--accent-muted)" opacity="0.85" />
        <text x={w / 2} y={h * 0.72 + 4} textAnchor="middle" fontSize="8" fill="var(--muted)" className="silhouette-caption">
          ERM / LRA (typical)
        </text>
      </svg>
      <figcaption className="silhouette-legend">
        Motor placement is <strong>generic</strong>, not model-specific. Real devices vary.
      </figcaption>
    </figure>
  )
}
