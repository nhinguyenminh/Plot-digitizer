export type PlotType = 'xy' | 'bar' | 'polar' | 'ternary' | 'map' | 'measurement' | 'compressor'
export type ToolMode = 'select' | 'calibrate-x' | 'calibrate-y' | 'calibrate-four' | 'calibrate-intersections' | 'calibrate-edit' | 'point' | 'point-edit' | 'surge' | 'choke' | 'speed' | 'measure' | 'trace-region' | 'grid-horizontal' | 'grid-vertical' | 'guide-axis-x' | 'guide-axis-y' | 'crop' | 'prep-region' | 'prep-draw' | 'prep-line' | 'prep-erase' | 'prep-heal' | 'prep-straighten'
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

export function calibrationFromDrafts(axis: AxisCalibration, drafts: string[], coordinate: 'x' | 'y'): AxisCalibration {
  if (axis.points.length < 2 || drafts.length !== axis.points.length) throw new Error('Choose at least two reference points on each axis.')
  const points = axis.points.map((point, index) => {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error('Reference point coordinates must be finite.')
    const raw = drafts[index].trim()
    const value = !raw ? NaN : axis.scale === 'date' ? Date.parse(raw) : Number(raw)
    if (!Number.isFinite(value) || (axis.scale === 'log' && value <= 0) || (axis.scale === 'inverse' && value === 0)) {
      throw new Error('Enter valid values for every reference point (log values must be positive; inverse values cannot be zero).')
    }
    return { ...point, value }
  })
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      if (Math.abs(points[i][coordinate] - points[j][coordinate]) < 4 || points[i].value === points[j].value) {
        throw new Error('Reference points on each axis must have distinct values and be at least 4 pixels apart.')
      }
    }
  }
  return { ...axis, points }
}

export function calibrateFromIntersections(
  intersections: [PixelPoint, PixelPoint],
  values: [number, number, number, number],
  xScale: ScaleType,
  yScale: ScaleType,
): { xAxis: AxisCalibration; yAxis: AxisCalibration } {
  const valid = (value: number, scale: ScaleType) =>
    Number.isFinite(value) && (scale !== 'log' || value > 0) && (scale !== 'inverse' || value !== 0)
  if (!intersections.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    || Math.abs(intersections[0].x - intersections[1].x) < 4
    || Math.abs(intersections[0].y - intersections[1].y) < 4
    || !values.every((value, index) => valid(value, index < 2 ? xScale : yScale))
    || values[0] === values[1] || values[2] === values[3]) {
    throw new Error('Choose intersections separated by at least 4 pixels on both axes and enter distinct values valid for each scale.')
  }
  return {
    xAxis: { scale: xScale, points: intersections.map((point, index) => ({ ...point, value: values[index] })) },
    yAxis: { scale: yScale, points: intersections.map((point, index) => ({ ...point, value: values[index + 2] })) },
  }
}

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

function simplifyTrace(points: PixelPoint[], tolerance: number, maxSegmentLength: number): PixelPoint[] {
  if (points.length < 3) return points
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  const ranges: Array<[number, number]> = [[0, points.length - 1]]
  while (ranges.length) {
    const [start, end] = ranges.pop()!
    if (end - start < 2) continue
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
    } else if (Math.hypot(dx, dy) > maxSegmentLength) {
      const midpoint = Math.floor((start + end) / 2)
      keep[midpoint] = 1
      ranges.push([start, midpoint], [midpoint, end])
    }
  }
  return points.filter((_, index) => keep[index] === 1)
}

export function simplifyDetectedTrace(points: PixelPoint[], spacing: number): PixelPoint[] {
  return simplifyTrace(smoothTrace(points, 1), 1, Math.max(1, spacing))
}

export function traceColor(
  imageData: ImageData,
  seed: PixelPoint,
  tolerance: number,
  step: number,
  guide?: PixelPoint[],
  guideRadius = 16,
  bounds: { left: number; right: number; top: number; bottom: number } = { left: 0, right: imageData.width - 1, top: 0, bottom: imageData.height - 1 },
  adaptiveSpacing = false,
): PixelPoint[] {
  const { width, height, data } = imageData
  const leftBound = Math.max(0, Math.min(width - 1, Math.round(bounds.left)))
  const rightBound = Math.max(leftBound, Math.min(width - 1, Math.round(bounds.right)))
  const topBound = Math.max(0, Math.min(height - 1, Math.round(bounds.top)))
  const bottomBound = Math.max(topBound, Math.min(height - 1, Math.round(bounds.bottom)))
  const sx = Math.max(leftBound, Math.min(rightBound, Math.round(seed.x)))
  const sortedGuide = guide?.length ? [...guide].sort((a, b) => a.x - b.x) : null
  const guideMinX = Math.max(leftBound, sortedGuide?.[0].x ?? leftBound)
  const guideMaxX = Math.min(rightBound, sortedGuide?.[sortedGuide.length - 1].x ?? rightBound)
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
  let sy = Math.max(topBound, Math.min(bottomBound, Math.round(nearestGuide?.y ?? seed.y)))
  const seedOffset = (sy * width + sx) * 4
  const stride = adaptiveSpacing ? 1 : Math.max(1, Math.round(step))
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
      for (let x = Math.max(leftBound, Math.round(center.x) - Math.max(1, Math.floor(stride / 2))); x <= Math.min(rightBound, Math.round(center.x) + Math.max(1, Math.floor(stride / 2))); x++) {
        for (let y = Math.max(topBound, Math.round(center.y) - guideRadius); y <= Math.min(bottomBound, Math.round(center.y) + guideRadius); y++) {
          const offset = (y * width + x) * 4
          const red = data[offset]
          const green = data[offset + 1]
          const blue = data[offset + 2]
          const brightness = data[offset] * 0.2126 + data[offset + 1] * 0.7152 + data[offset + 2] * 0.0722
          if (data[offset + 3] > 127 && brightness < darkest) {
            darkest = brightness
            guideColor = [red, green, blue]
          }
          if (adaptiveSpacing && sortedGuide) {
            let bestY: number | null = null
            let bestScore = Infinity
            for (let y = Math.max(topBound, sy - guideRadius); y <= Math.min(bottomBound, sy + guideRadius); y++) {
              const offset = (y * width + sx) * 4
              const distance = Math.hypot(data[offset] - target[0], data[offset + 1] - target[1], data[offset + 2] - target[2])
              const score = distance + Math.abs(y - sy) * 4
              if (distance <= tolerance && score < bestScore) { bestY = y; bestScore = score }
            }
            if (bestY === null) return []
            sy = bestY
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
        Math.max(6, Math.round(height * 0.025)) + Math.ceil(Math.abs(slope * stride) * 0.5),
        Math.max(10, Math.round(height * 0.05)),
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
      for (let y = Math.max(topBound, Math.round(predictedY) - radius); y <= Math.min(bottomBound, Math.round(predictedY) + radius); y++) {
        const index = (y * width + x) * 4
        const distance = Math.hypot(data[index] - target[0], data[index + 1] - target[1], data[index + 2] - target[2])
        if (distance > tolerance) continue
        const offPrediction = Math.abs(y - predictedY)
        const score = distance + offPrediction * (guideNext ? 4 : 1.5)
        if (score < bestScore) {
          bestScore = score
          best = { x, y }
        }
      }
      if (best) {
        points.push(best)
        misses = 0
      } else if (++misses >= (adaptiveSpacing ? Math.max(2, Math.round(step) * 2) : 2)) {
        break
      }
    }
    return points
  }
  const left = traceDirection(-1).reverse()
  const right = traceDirection(1).slice(1)
  const traced = [...left, ...right]
  const smoothed = smoothTrace(traced, adaptiveSpacing || stride >= 6 ? 1 : 2)
  return adaptiveSpacing
    ? simplifyTrace(smoothed, 0.5, Math.max(1, step))
    : simplifyTrace(smoothed, Math.max(0.75, Math.min(3, stride * 0.3)), stride * 5)
}

export function downloadFile(name: string, content: string | Blob, mime = 'text/plain') {
  const url = URL.createObjectURL(content instanceof Blob ? content : new Blob([content], { type: mime }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  URL.revokeObjectURL(url)
}
