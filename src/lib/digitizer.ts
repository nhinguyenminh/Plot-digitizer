export type PlotType = 'xy' | 'bar' | 'polar' | 'ternary' | 'map' | 'measurement' | 'compressor'
export type ToolMode = 'select' | 'calibrate-x' | 'calibrate-y' | 'calibrate-four' | 'calibrate-edit' | 'point' | 'point-edit' | 'surge' | 'choke' | 'speed' | 'measure' | 'trace' | 'trace-region' | 'crop'
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

function smoothTrace(points: PixelPoint[], radius: number): PixelPoint[] {
  if (points.length < 3) return points
  return points.map((point, index) => {
    const ys = points.slice(Math.max(0, index - radius), Math.min(points.length, index + radius + 1)).map((candidate) => candidate.y).sort((a, b) => a - b)
    return { x: point.x, y: ys[Math.floor(ys.length / 2)] }
  })
}

function simplifyTrace(points: PixelPoint[], tolerance: number): PixelPoint[] {
  if (points.length < 3) return points
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  const ranges: Array<[number, number]> = [[0, points.length - 1]]
  while (ranges.length) {
    const [start, end] = ranges.pop()!
    const a = points[start]
    const b = points[end]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const lengthSquared = dx * dx + dy * dy
    let furthest = -1
    let maxDistance = tolerance
    for (let index = start + 1; index < end; index++) {
      const point = points[index]
      const projection = lengthSquared === 0
        ? 0
        : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared))
      const distance = Math.hypot(point.x - (a.x + projection * dx), point.y - (a.y + projection * dy))
      if (distance > maxDistance) {
        maxDistance = distance
        furthest = index
      }
    }
    if (furthest >= 0) {
      keep[furthest] = 1
      ranges.push([start, furthest], [furthest, end])
    }
  }
  return points.filter((_, index) => keep[index] === 1)
}

export function traceColor(imageData: ImageData, seed: PixelPoint, tolerance: number, step: number, guide?: PixelPoint[], guideRadius = 16): PixelPoint[] {
  const { width, height, data } = imageData
  const sx = Math.max(0, Math.min(width - 1, Math.round(seed.x)))
  const sortedGuide = guide?.length ? [...guide].sort((a, b) => a.x - b.x) : null
  const guideMinX = sortedGuide?.[0].x ?? 0
  const guideMaxX = sortedGuide?.[sortedGuide.length - 1].x ?? width - 1
  const guideAt = (x: number) => {
    if (!sortedGuide?.length) return null
    if (x <= sortedGuide[0].x) return sortedGuide[0]
    if (x >= sortedGuide[sortedGuide.length - 1].x) return sortedGuide[sortedGuide.length - 1]
    const index = sortedGuide.findIndex((point, pointIndex) => pointIndex < sortedGuide.length - 1 && x >= point.x && x <= sortedGuide[pointIndex + 1].x)
    const start = sortedGuide[index]
    const end = sortedGuide[index + 1]
    if (Math.abs(end.x - start.x) < 1e-8) return start
    const ratio = (x - start.x) / (end.x - start.x)
    return { x, y: start.y + (end.y - start.y) * ratio }
  }
  const nearestGuide = sortedGuide?.reduce((best, point) => Math.abs(point.x - sx) < Math.abs(best.x - sx) ? point : best)
  const sy = Math.max(0, Math.min(height - 1, Math.round(nearestGuide?.y ?? seed.y)))
  const seedOffset = (sy * width + sx) * 4
  const stride = Math.max(1, Math.round(step))
  const target = [data[seedOffset], data[seedOffset + 1], data[seedOffset + 2]]
  if (sortedGuide?.length) {
    const sampleCount = Math.min(11, sortedGuide.length)
    const guideColors: number[][] = []
    const saturatedGuideColors: number[][] = []
    for (let sample = 0; sample < sampleCount; sample++) {
      const guideIndex = Math.round(sample * (sortedGuide.length - 1) / Math.max(1, sampleCount - 1))
      const center = sortedGuide[guideIndex]
      let darkest = Infinity
      let guideColor: number[] | null = null
      let highestSaturation = 24
      let saturatedGuideColor: number[] | null = null
      for (let x = Math.max(0, Math.round(center.x) - Math.max(1, Math.floor(stride / 2))); x <= Math.min(width - 1, Math.round(center.x) + Math.max(1, Math.floor(stride / 2))); x++) {
        for (let y = Math.max(0, Math.round(center.y) - guideRadius); y <= Math.min(height - 1, Math.round(center.y) + guideRadius); y++) {
          const offset = (y * width + x) * 4
          const red = data[offset]
          const green = data[offset + 1]
          const blue = data[offset + 2]
          const brightness = data[offset] * 0.2126 + data[offset + 1] * 0.7152 + data[offset + 2] * 0.0722
          if (data[offset + 3] > 127 && brightness < darkest) {
            darkest = brightness
            guideColor = [red, green, blue]
          }
          const saturation = Math.max(red, green, blue) - Math.min(red, green, blue)
          if (data[offset + 3] > 127 && saturation > highestSaturation) {
            highestSaturation = saturation
            saturatedGuideColor = [red, green, blue]
          }
        }
      }
      if (guideColor && darkest < 250) guideColors.push(guideColor)
      if (saturatedGuideColor) saturatedGuideColors.push(saturatedGuideColor)
    }
    const targetColors = saturatedGuideColors.length >= Math.max(2, Math.ceil(sampleCount / 4))
      ? saturatedGuideColors
      : guideColors
    if (targetColors.length) {
      for (let channel = 0; channel < 3; channel++) {
        const values = targetColors.map((color) => color[channel]).sort((a, b) => a - b)
        target[channel] = values[Math.floor(values.length / 2)]
      }
    }
  }
  const traceDirection = (direction: -1 | 1) => {
    const points: PixelPoint[] = [{ x: sx, y: sy }]
    let misses = 0
    for (let x = sx + direction * stride; x >= 0 && x < width && x >= guideMinX && x <= guideMaxX; x += direction * stride) {
      const last = points[points.length - 1]
      const previous = points.length > 1 ? points[points.length - 2] : null
      const guideNext = guideAt(x)
      const guidePrevious = guideAt(last.x)
      const guidedSlope = guideNext && guidePrevious && x !== last.x ? (guideNext.y - guidePrevious.y) / (x - last.x) : 0
      const slope = previous ? (last.y - previous.y) / (last.x - previous.x) : guidedSlope
      const baseRadius = Math.min(
        Math.max(12, Math.round(height * 0.08)) + Math.ceil(Math.abs(slope * stride)),
        Math.max(12, Math.round(height * 0.2)),
      )
      const older = points.length > 2 ? points[points.length - 3] : null
      const previousSlope = older && previous ? (previous.y - older.y) / (previous.x - older.x) : slope
      const curvature = older ? (slope - previousSlope) / (last.x - older.x) : 0
      const dx = x - last.x
      const curveCorrection = Math.max(-baseRadius / 2, Math.min(baseRadius / 2, curvature * dx * dx / 2))
      const predictedY = guideNext
        ? guideNext.y
        : last.y + slope * dx + curveCorrection
      const radius = guideNext ? Math.max(3, Math.round(guideRadius)) : baseRadius
      let best: PixelPoint | null = null
      let bestScore = Infinity
      for (let y = Math.max(0, Math.round(predictedY) - radius); y <= Math.min(height - 1, Math.round(predictedY) + radius); y++) {
        const index = (y * width + x) * 4
        const distance = Math.hypot(data[index] - target[0], data[index + 1] - target[1], data[index + 2] - target[2])
        if (distance > tolerance) continue
        const score = distance + Math.abs(y - predictedY) * (guideNext ? 1.5 : 0.8)
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
  const traced = [...left, ...right]
  const smoothed = smoothTrace(traced, stride >= 6 ? 1 : 2)
  return simplifyTrace(smoothed, Math.max(0.75, Math.min(3, stride * 0.3)))
}

export function downloadFile(name: string, content: string, mime = 'text/plain') {
  const url = URL.createObjectURL(new Blob([content], { type: mime }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  URL.revokeObjectURL(url)
}
