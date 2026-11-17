export type PlotType = 'xy' | 'bar' | 'polar' | 'ternary' | 'map' | 'measurement' | 'compressor'
export type ToolMode = 'select' | 'calibrate-x' | 'calibrate-y' | 'calibrate-four' | 'calibrate-edit' | 'point' | 'point-edit' | 'surge' | 'choke' | 'speed' | 'measure' | 'trace' | 'crop'
export type ScaleType = 'linear' | 'log' | 'inverse' | 'date'
export type DatasetKind = 'curve' | 'surge' | 'choke' | 'speed' | 'efficiency' | 'measurement'

export interface PixelPoint { x: number; y: number }
export interface CalPoint extends PixelPoint { value: number }
export interface Dataset {
  id: string
  name: string
  color: string
  kind: DatasetKind
  points: PixelPoint[]
  rpm?: number
  speedUnit?: string
  igv?: number
  igvUnit?: string
  efficiencyValue?: number
}
export interface AxisCalibration { points: CalPoint[]; scale: ScaleType }

const transformed = (value: number, scale: ScaleType) => {
  if (scale === 'log') {
    if (value <= 0) throw new Error('Logarithmic values must be greater than zero.')
    return Math.log10(value)
  }
  if (scale === 'inverse') {
    if (value === 0) throw new Error('Inverse scale values cannot be zero.')
    return 1 / value
  }
  return value
}

export function mapPixelToValue(pixel: number, axis: AxisCalibration): number | null {
  const points = axis.points
  if (points.length < 2) return null
  const ordered = [...points].sort((a, b) => a.x - b.x)
  if (ordered.some((point) => !Number.isFinite(point.value))) return null
  if (points.length === 2) {
    const [a, b] = points
    if (Math.abs(b.x - a.x) < 1e-8) return null
    const va = transformed(a.value, axis.scale)
    const vb = transformed(b.value, axis.scale)
    const value = va + (pixel - a.x) * (vb - va) / (b.x - a.x)
    return axis.scale === 'log' ? 10 ** value : axis.scale === 'inverse' ? 1 / value : value
  }
  const values = ordered.map((point) => transformed(point.value, axis.scale))
  const pos = pixel
  let i = ordered.findIndex((point, index) => index < ordered.length - 1 && pos >= point.x && pos <= ordered[index + 1].x)
  if (i < 0) i = pos < ordered[0].x ? 0 : ordered.length - 2
  const a = ordered[i]
  const b = ordered[i + 1]
  if (Math.abs(b.x - a.x) < 1e-8) return null
  const v = values[i] + (pos - a.x) * (values[i + 1] - values[i]) / (b.x - a.x)
  return axis.scale === 'log' ? 10 ** v : axis.scale === 'inverse' ? 1 / v : v
}

export function pointToData(point: PixelPoint, xAxis: AxisCalibration, yAxis: AxisCalibration) {
  const x = mapPixelToValue(point.x, xAxis)
  const y = mapPixelToValue(point.y, { ...yAxis, points: yAxis.points.map((p) => ({ ...p, x: p.y })) })
  return x === null || y === null ? null : { x, y }
}

export function csvForDataset(dataset: Dataset, xAxis: AxisCalibration, yAxis: AxisCalibration) {
  const rows = dataset.points.map((point) => pointToData(point, xAxis, yAxis)).filter((point): point is { x: number; y: number } => point !== null)
  const sorted = rows.sort((a, b) => a.x - b.x)
  return ['x,y', ...sorted.map((point) => `${Number(point.x.toPrecision(8))},${Number(point.y.toPrecision(8))}`)].join('\n')
}

export function traceColor(imageData: ImageData, seed: PixelPoint, tolerance: number, step: number): PixelPoint[] {
  const { width, height, data } = imageData
  const sx = Math.max(0, Math.min(width - 1, Math.round(seed.x)))
  const sy = Math.max(0, Math.min(height - 1, Math.round(seed.y)))
  const seedOffset = (sy * width + sx) * 4
  const target = [data[seedOffset], data[seedOffset + 1], data[seedOffset + 2]]
  const stride = Math.max(1, Math.round(step))
  const traceDirection = (direction: -1 | 1) => {
    const points: PixelPoint[] = [{ x: sx, y: sy }]
    let misses = 0
    for (let x = sx + direction * stride; x >= 0 && x < width; x += direction * stride) {
      const last = points[points.length - 1]
      const previous = points.length > 1 ? points[points.length - 2] : null
      const slope = previous ? (last.y - previous.y) / (last.x - previous.x) : 0
      const baseRadius = Math.min(
        Math.max(12, Math.round(height * 0.08)) + Math.ceil(Math.abs(slope * stride)),
        Math.max(12, Math.round(height * 0.2)),
      )
      const older = points.length > 2 ? points[points.length - 3] : null
      const previousSlope = older && previous ? (previous.y - older.y) / (previous.x - older.x) : slope
      const curvature = older ? (slope - previousSlope) / (last.x - older.x) : 0
      const dx = x - last.x
      const curveCorrection = Math.max(-baseRadius / 2, Math.min(baseRadius / 2, curvature * dx * dx / 2))
      const predictedY = last.y + slope * dx + curveCorrection
      const radius = baseRadius
      let best: PixelPoint | null = null
      let bestScore = Infinity
      for (let y = Math.max(0, Math.round(predictedY) - radius); y <= Math.min(height - 1, Math.round(predictedY) + radius); y++) {
        const index = (y * width + x) * 4
        const distance = Math.hypot(data[index] - target[0], data[index + 1] - target[1], data[index + 2] - target[2])
        if (distance > tolerance) continue
        const score = distance + Math.abs(y - predictedY) * 0.8
        if (score < bestScore) {
          bestScore = score
          best = { x, y }
        }
      }
      if (best) {
        points.push(best)
        misses = 0
      } else if (++misses >= 2) {
        break
      }
    }
    return points
  }
  const left = traceDirection(-1).reverse()
  const right = traceDirection(1).slice(1)
  return [...left, ...right]
}

export function downloadFile(name: string, content: string, mime = 'text/plain') {
  const url = URL.createObjectURL(new Blob([content], { type: mime }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  URL.revokeObjectURL(url)
}
