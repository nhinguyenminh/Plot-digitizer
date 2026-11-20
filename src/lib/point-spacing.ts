import type { PixelPoint } from './digitizer'

export interface PointSpacingModel {
  version: 1
  samples: number
  factor: number
}

export interface PointSpacingComparison {
  generated: PixelPoint[]
  corrected: PixelPoint[]
}

export const initialPointSpacingModel = (): PointSpacingModel => ({ version: 1, samples: 0, factor: 1 })

function medianPointDistance(points: PixelPoint[]) {
  const distances = points.slice(1).map((point, index) =>
    Math.hypot(point.x - points[index].x, point.y - points[index].y),
  ).filter((distance) => Number.isFinite(distance) && distance > 0).sort((a, b) => a - b)
  return distances.length ? distances[Math.floor(distances.length / 2)] : 0
}

export function pointSpacingTargets(comparisons: PointSpacingComparison[]): number[] {
  const targets: number[] = []
  for (const { generated, corrected } of comparisons) {
    if (generated.length < 3 || corrected.length < 3 || corrected.length >= generated.length) continue
    const generatedSpacing = medianPointDistance(generated)
    const correctedSpacing = medianPointDistance(corrected)
    if (!generatedSpacing || !correctedSpacing) continue
    targets.push(Math.max(1.05, Math.min(1.2, correctedSpacing / generatedSpacing)))
  }
  return targets
}

export function trainPointSpacingModel(model: PointSpacingModel, comparisons: PointSpacingComparison[]): PointSpacingModel {
  let factor = model.factor
  let samples = model.samples
  for (const target of pointSpacingTargets(comparisons)) {
    factor = samples ? factor * 0.75 + target * 0.25 : target
    samples++
  }
  return { version: 1, samples, factor }
}

export function removeSpacingOutliers(points: PixelPoint[]): PixelPoint[] {
  if (points.length < 4) return points
  const keep = new Uint8Array(points.length).fill(1)
  for (let index = 1; index < points.length - 1; index++) {
    const before = points[index - 1]
    const point = points[index]
    const after = points[index + 1]
    const previousGap = Math.hypot(point.x - before.x, point.y - before.y)
    const nextGap = Math.hypot(after.x - point.x, after.y - point.y)
    const reference = [index > 1 ? Math.hypot(before.x - points[index - 2].x, before.y - points[index - 2].y) : 0,
      index + 2 < points.length ? Math.hypot(points[index + 2].x - after.x, points[index + 2].y - after.y) : 0]
      .filter((distance) => distance > 0)
    if (!reference.length) continue
    const typicalGap = Math.max(...reference)
    if (Math.min(previousGap, nextGap) >= typicalGap * 0.45) continue
    const chordLength = Math.hypot(after.x - before.x, after.y - before.y)
    const deviation = chordLength
      ? Math.abs((point.x - before.x) * (after.y - before.y) - (point.y - before.y) * (after.x - before.x)) / chordLength
      : Math.hypot(point.x - before.x, point.y - before.y)
    if (deviation <= Math.max(0.75, typicalGap * 0.15)) keep[index] = 0
  }
  return points.filter((_, index) => keep[index] === 1)
}
