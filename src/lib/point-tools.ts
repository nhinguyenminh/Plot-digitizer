import type { PixelPoint } from './digitizer'

export type CurveSnapMode = 'isolated' | 'color' | 'dark'

export interface CurveImageSource {
  width: number
  height: number
  data: Uint8ClampedArray
}

export interface SnapCurveOptions {
  mode?: CurveSnapMode
  radius?: number
  curveColor?: [number, number, number]
  tolerance?: number
  scorePixel?: (x: number, y: number) => number
}

export interface SnapPointResult {
  point: PixelPoint
  distance: number
  moved: boolean
}

export interface SnapDisplacement {
  index: number
  from: PixelPoint
  to: PixelPoint
  distance: number
}

export interface SnapDatasetResult {
  points: PixelPoint[]
  movedCount: number
  totalDisplacement: number
  displacements: SnapDisplacement[]
}

function segmentDistance(point: PixelPoint, start: PixelPoint, end: PixelPoint) {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const lengthSquared = dx * dx + dy * dy
  const t = lengthSquared ? Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared)) : 0
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy))
}

/**
 * Inserts a manually added point into a dataset.
 * When `insertByX` is enabled, inserts between the closest X-bracketing neighbors
 * (respecting ascending, descending, or multi-valued curve branches) instead of appending to the end.
 */
export function insertPointInDataset(
  points: PixelPoint[],
  newPoint: PixelPoint,
  insertByX = true,
): { points: PixelPoint[]; index: number } {
  if (!insertByX || points.length === 0) {
    return { points: [...points, newPoint], index: points.length }
  }
  if (points.length === 1) {
    if (newPoint.x < points[0].x) return { points: [newPoint, points[0]], index: 0 }
    return { points: [points[0], newPoint], index: 1 }
  }

  let bestIndex = -1
  let bestScore = Infinity
  let bestVertical = Infinity
  for (let index = 0; index < points.length - 1; index++) {
    const start = points[index]
    const end = points[index + 1]
    const minX = Math.min(start.x, end.x)
    const maxX = Math.max(start.x, end.x)
    if (newPoint.x < minX || newPoint.x > maxX) continue
    const distance = segmentDistance(newPoint, start, end)
    const spanX = end.x - start.x
    const interpolatedY = Math.abs(spanX) > 1e-6
      ? start.y + ((newPoint.x - start.x) / spanX) * (end.y - start.y)
      : (start.y + end.y) / 2
    const vertical = Math.abs(newPoint.y - interpolatedY)
    if (distance < bestScore - 1e-6 || (Math.abs(distance - bestScore) <= 1e-6 && vertical < bestVertical)) {
      bestScore = distance
      bestVertical = vertical
      bestIndex = index + 1
    }
  }

  if (bestIndex >= 0) {
    const next = [...points]
    next.splice(bestIndex, 0, newPoint)
    return { points: next, index: bestIndex }
  }

  let ascendingSteps = 0
  let descendingSteps = 0
  for (let index = 1; index < points.length; index++) {
    const dx = points[index].x - points[index - 1].x
    if (dx > 0) ascendingSteps++
    else if (dx < 0) descendingSteps++
  }
  const descending = descendingSteps > ascendingSteps
    || (descendingSteps === ascendingSteps && points[points.length - 1].x < points[0].x)

  const insertAtStart = descending
    ? newPoint.x > points[0].x
    : newPoint.x < points[0].x

  if (insertAtStart) {
    return { points: [newPoint, ...points], index: 0 }
  }
  return { points: [...points, newPoint], index: points.length }
}

function pixelInkWeight(
  data: Uint8ClampedArray,
  width: number,
  x: number,
  y: number,
  mode: CurveSnapMode,
  curveColor: [number, number, number],
  tolerance: number,
): number {
  const offset = (y * width + x) * 4
  const alpha = data[offset + 3]
  if (mode === 'isolated') return alpha >= 16 ? alpha / 255 : 0
  if (alpha < 64) return 0
  const r = data[offset]
  const g = data[offset + 1]
  const b = data[offset + 2]
  if (mode === 'color') {
    if (r > 240 && g > 240 && b > 240) return 0
    const colorDistance = Math.hypot(r - curveColor[0], g - curveColor[1], b - curveColor[2])
    if (colorDistance > tolerance) return 0
    return Math.max(0.15, 1 - colorDistance / Math.max(1, tolerance * 1.15)) * (alpha / 255)
  }
  const darkness = (alpha / 255) * (255 - Math.min(r, g, b))
  if (darkness < 70) return 0
  return Math.min(1, (darkness - 55) / 200)
}

/**
 * Snaps a single slightly off-curve point onto the local centerline of the nearest curve stroke.
 */
export function snapPointToCurveCenter(
  image: CurveImageSource,
  point: PixelPoint,
  options: SnapCurveOptions = {},
): SnapPointResult | null {
  const { width, height, data } = image
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || width <= 0 || height <= 0 || data.length !== width * height * 4) {
    return null
  }
  const mode = options.mode ?? 'isolated'
  const radius = Math.max(2, Math.min(48, options.radius ?? 14))
  const curveColor = options.curveColor ?? [0, 102, 255]
  const tolerance = Math.max(10, options.tolerance ?? 76)
  const scorePixel = options.scorePixel

  const left = Math.max(0, Math.floor(point.x - radius))
  const right = Math.min(width - 1, Math.ceil(point.x + radius))
  const top = Math.max(0, Math.floor(point.y - radius))
  const bottom = Math.min(height - 1, Math.ceil(point.y + radius))

  let bestX = -1
  let bestY = -1
  let bestCost = Infinity
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      const weight = pixelInkWeight(data, width, x, y, mode, curveColor, tolerance)
      if (weight <= 0) continue
      const distance = Math.hypot(x + 0.5 - point.x, y + 0.5 - point.y)
      if (distance > radius) continue
      const aiScore = scorePixel ? Math.max(0, Math.min(1, scorePixel(x, y))) : 0.5
      // Keep distance dominant so we never jump across curves, while preferring stroke cores and AI-confirmed ink.
      const bonus = weight * 0.65 + (aiScore - 0.5) * 1.5
      const cost = distance - bonus
      if (cost < bestCost) {
        bestCost = cost
        bestX = x
        bestY = y
      }
    }
  }

  if (bestX < 0 || bestY < 0) return null

  // Collect only the locally connected stroke patch around (bestX, bestY) to compute its centerline.
  const patchRadius = 4
  const patchLeft = Math.max(0, bestX - patchRadius)
  const patchRight = Math.min(width - 1, bestX + patchRadius)
  const patchTop = Math.max(0, bestY - patchRadius)
  const patchBottom = Math.min(height - 1, bestY + patchRadius)
  const patchW = patchRight - patchLeft + 1
  const patchH = patchBottom - patchTop + 1
  const visited = new Uint8Array(patchW * patchH)
  const queue: number[] = [(bestY - patchTop) * patchW + (bestX - patchLeft)]
  visited[queue[0]] = 1

  const patchPixels: Array<{ x: number; y: number; weight: number }> = []
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const local = queue[cursor]
    const lx = local % patchW
    const ly = Math.floor(local / patchW)
    const gx = patchLeft + lx
    const gy = patchTop + ly
    const weight = pixelInkWeight(data, width, gx, gy, mode, curveColor, tolerance)
    if (weight <= 0) continue
    const aiBoost = scorePixel ? 0.65 + 0.7 * Math.max(0, Math.min(1, scorePixel(gx, gy))) : 1
    patchPixels.push({ x: gx + 0.5, y: gy + 0.5, weight: weight * aiBoost })
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue
        const nx = lx + dx
        const ny = ly + dy
        if (nx < 0 || nx >= patchW || ny < 0 || ny >= patchH) continue
        const nLocal = ny * patchW + nx
        if (visited[nLocal]) continue
        if (pixelInkWeight(data, width, patchLeft + nx, patchTop + ny, mode, curveColor, tolerance) > 0) {
          visited[nLocal] = 1
          queue.push(nLocal)
        }
      }
    }
  }

  let totalWeight = 0
  let mx = 0
  let my = 0
  for (const pixel of patchPixels) {
    totalWeight += pixel.weight
    mx += pixel.x * pixel.weight
    my += pixel.y * pixel.weight
  }
  if (!totalWeight) {
    const fallback = { x: bestX + 0.5, y: bestY + 0.5 }
    const distance = Math.hypot(fallback.x - point.x, fallback.y - point.y)
    return { point: fallback, distance, moved: distance >= 0.25 }
  }
  mx /= totalWeight
  my /= totalWeight

  let xx = 0
  let xy = 0
  let yy = 0
  for (const pixel of patchPixels) {
    const dx = pixel.x - mx
    const dy = pixel.y - my
    xx += dx * dx * pixel.weight
    xy += dx * dy * pixel.weight
    yy += dy * dy * pixel.weight
  }

  let snappedX = mx
  let snappedY = my
  const spread = Math.hypot(xx - yy, 2 * xy)
  if (patchPixels.length >= 3 && spread >= (xx + yy) * 0.2) {
    const angle = Math.atan2(2 * xy, xx - yy) / 2
    const tx = Math.cos(angle)
    const ty = Math.sin(angle)
    const projection = Math.max(-2.5, Math.min(2.5, (point.x - mx) * tx + (point.y - my) * ty))
    snappedX = mx + tx * projection
    snappedY = my + ty * projection
  }

  snappedX = Math.max(0, Math.min(width - 1, Math.round(snappedX * 100) / 100))
  snappedY = Math.max(0, Math.min(height - 1, Math.round(snappedY * 100) / 100))
  const distance = Math.hypot(snappedX - point.x, snappedY - point.y)
  if (distance > radius + 1.5) return null
  if (distance < 0.25) return { point, distance, moved: false }
  return { point: { x: snappedX, y: snappedY }, distance, moved: true }
}

/**
 * Aligns all slightly off-curve points in a dataset onto the nearest curve centerline within the search radius.
 * Points with no curve ink nearby are left unchanged.
 */
export function snapDatasetPointsToCurve(
  image: CurveImageSource,
  points: PixelPoint[],
  options: SnapCurveOptions = {},
): SnapDatasetResult {
  const nextPoints: PixelPoint[] = []
  const displacements: SnapDisplacement[] = []
  let totalDisplacement = 0

  for (let index = 0; index < points.length; index++) {
    const original = points[index]
    const result = snapPointToCurveCenter(image, original, options)
    if (result && result.moved) {
      nextPoints.push(result.point)
      totalDisplacement += result.distance
      displacements.push({ index, from: original, to: result.point, distance: result.distance })
    } else {
      nextPoints.push(original)
    }
  }

  return {
    points: nextPoints,
    movedCount: displacements.length,
    totalDisplacement,
    displacements,
  }
}
