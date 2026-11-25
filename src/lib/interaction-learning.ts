import type { PixelPoint } from './digitizer'
import { buildLearningGridMasks, predictLearningEdits } from './learning.ts'
import type { LearningModel, LearningPixels } from './learning.ts'

export interface InteractionStats {
  pointsAdded: number
  pointsMoved: number
  pointsDeleted: number
  pointsSnapped: number
  healingApplied: number
  paintSessions: number
  reconstructionEdits: number
}

export interface InteractionModel {
  version: 1
  featureWeights: number[]
  featureSamples: number
  spacingFactor: number
  spacingSamples: number
  curvatureBias: number
  snapRadius: number
  snapSamples: number
  healingScores: [number, number, number]
  stats: InteractionStats
  updatedAt: string | null
}

export interface InteractionUpdatePayload {
  featureDelta: number[]
  featureSamplesDelta: number
  spacingTarget: number | null
  curvatureDelta: number
  snapTarget: number | null
  healingChoice: number | null
  statsDelta: InteractionStats
}

export interface RichLabeledExample {
  features: number[]
  label: 0 | 1
  weight?: number
}

export const RICH_FEATURE_COUNT = 14
const INITIAL_RICH_WEIGHTS = [-3.6, 0.4, 7.2, 0, 0, 0, 0, 0, 0, 0, 0.3, 0.3, 0, 0]
export const DEFAULT_SNAP_RADIUS = 14
export const MIN_SNAP_RADIUS = 8
export const MAX_SNAP_RADIUS = 26

export const initialInteractionModel = (): InteractionModel => ({
  version: 1,
  featureWeights: [...INITIAL_RICH_WEIGHTS],
  featureSamples: 0,
  spacingFactor: 1,
  spacingSamples: 0,
  curvatureBias: 1,
  snapRadius: DEFAULT_SNAP_RADIUS,
  snapSamples: 0,
  healingScores: [0, 0, 0],
  stats: {
    pointsAdded: 0,
    pointsMoved: 0,
    pointsDeleted: 0,
    pointsSnapped: 0,
    healingApplied: 0,
    paintSessions: 0,
    reconstructionEdits: 0,
  },
  updatedAt: null,
})

export function isValidInteractionModel(value: unknown): value is InteractionModel {
  if (!value || typeof value !== 'object') return false
  const model = value as Partial<InteractionModel>
  if (model.version !== 1) return false
  if (!Array.isArray(model.featureWeights) || model.featureWeights.length !== RICH_FEATURE_COUNT
    || !model.featureWeights.every((weight) => Number.isFinite(weight) && Math.abs(weight) <= 20)) return false
  if (!Number.isInteger(model.featureSamples) || (model.featureSamples ?? -1) < 0) return false
  if (!Number.isFinite(model.spacingFactor) || (model.spacingFactor ?? 0) < 0.65 || (model.spacingFactor ?? 2) > 1.5) return false
  if (!Number.isInteger(model.spacingSamples) || (model.spacingSamples ?? -1) < 0) return false
  if (!Number.isFinite(model.curvatureBias) || (model.curvatureBias ?? 0) < 0.6 || (model.curvatureBias ?? 2) > 1.6) return false
  if (!Number.isFinite(model.snapRadius) || (model.snapRadius ?? 0) < MIN_SNAP_RADIUS || (model.snapRadius ?? 99) > MAX_SNAP_RADIUS) return false
  if (!Number.isInteger(model.snapSamples) || (model.snapSamples ?? -1) < 0) return false
  if (!Array.isArray(model.healingScores) || model.healingScores.length !== 3 || !model.healingScores.every((score) => Number.isFinite(score) && score >= 0)) return false
  const stats = model.stats
  if (!stats || typeof stats !== 'object') return false
  const statValues = [
    stats.pointsAdded, stats.pointsMoved, stats.pointsDeleted,
    stats.pointsSnapped, stats.healingApplied, stats.paintSessions, stats.reconstructionEdits,
  ]
  if (!statValues.every((count) => Number.isInteger(count) && count >= 0)) return false
  return model.updatedAt === null || typeof model.updatedAt === 'string'
}

export function totalInteractionCount(model: InteractionModel): number {
  const { stats } = model
  return stats.pointsAdded + stats.pointsMoved + stats.pointsDeleted
    + stats.pointsSnapped + stats.healingApplied + stats.paintSessions + stats.reconstructionEdits
}

export function createInteractionUpdatePayload(
  before: InteractionModel,
  after: InteractionModel,
  healingChoice?: number,
): InteractionUpdatePayload | null {
  const featureDelta = after.featureWeights.map((weight, index) =>
    Math.round(clamp(weight - before.featureWeights[index], -0.5, 0.5) * 10000) / 10000,
  )
  const featureSamplesDelta = Math.min(50, Math.max(0, after.featureSamples - before.featureSamples))
  const spacingTarget = after.spacingSamples > before.spacingSamples
    ? Math.round(clamp(after.spacingFactor, 0.65, 1.5) * 10000) / 10000
    : null
  const curvatureDelta = Math.round(clamp(after.curvatureBias - before.curvatureBias, -0.2, 0.2) * 10000) / 10000
  const snapTarget = after.snapSamples > before.snapSamples
    ? Math.round(clamp(after.snapRadius, MIN_SNAP_RADIUS, MAX_SNAP_RADIUS) * 10) / 10
    : null
  const validHealingChoice = healingChoice !== undefined && Number.isInteger(healingChoice) && healingChoice >= 0 && healingChoice <= 2
    ? healingChoice
    : null
  const statsDelta: InteractionStats = {
    pointsAdded: Math.min(1000, Math.max(0, after.stats.pointsAdded - before.stats.pointsAdded)),
    pointsMoved: Math.min(1000, Math.max(0, after.stats.pointsMoved - before.stats.pointsMoved)),
    pointsDeleted: Math.min(1000, Math.max(0, after.stats.pointsDeleted - before.stats.pointsDeleted)),
    pointsSnapped: Math.min(1000, Math.max(0, after.stats.pointsSnapped - before.stats.pointsSnapped)),
    healingApplied: Math.min(100, Math.max(0, after.stats.healingApplied - before.stats.healingApplied)),
    paintSessions: Math.min(100, Math.max(0, after.stats.paintSessions - before.stats.paintSessions)),
    reconstructionEdits: Math.min(100, Math.max(0, after.stats.reconstructionEdits - before.stats.reconstructionEdits)),
  }
  const hasStats = Object.values(statsDelta).some((count) => count > 0)
  const hasFeature = featureSamplesDelta > 0 || featureDelta.some((value) => Math.abs(value) > 0)
  if (!hasStats && !hasFeature && spacingTarget === null && Math.abs(curvatureDelta) === 0
    && snapTarget === null && validHealingChoice === null) {
    return null
  }
  return {
    featureDelta,
    featureSamplesDelta,
    spacingTarget,
    curvatureDelta,
    snapTarget,
    healingChoice: validHealingChoice,
    statsDelta,
  }
}

export function isValidInteractionUpdatePayload(value: unknown): value is InteractionUpdatePayload {
  if (!value || typeof value !== 'object') return false
  const payload = value as Partial<InteractionUpdatePayload>
  if (!Array.isArray(payload.featureDelta) || payload.featureDelta.length !== RICH_FEATURE_COUNT
    || !payload.featureDelta.every((item) => Number.isFinite(item) && Math.abs(item) <= 0.5)) return false
  if (!Number.isInteger(payload.featureSamplesDelta) || (payload.featureSamplesDelta ?? -1) < 0 || (payload.featureSamplesDelta ?? 99) > 50) return false
  if (payload.spacingTarget !== null && (!Number.isFinite(payload.spacingTarget) || (payload.spacingTarget ?? 0) < 0.65 || (payload.spacingTarget ?? 2) > 1.5)) return false
  if (!Number.isFinite(payload.curvatureDelta) || Math.abs(payload.curvatureDelta ?? 99) > 0.2) return false
  if (payload.snapTarget !== null && (!Number.isFinite(payload.snapTarget) || (payload.snapTarget ?? 0) < MIN_SNAP_RADIUS || (payload.snapTarget ?? 99) > MAX_SNAP_RADIUS)) return false
  if (payload.healingChoice !== null && (!Number.isInteger(payload.healingChoice) || (payload.healingChoice ?? -1) < 0 || (payload.healingChoice ?? 9) > 2)) return false
  const stats = payload.statsDelta
  if (!stats || typeof stats !== 'object') return false
  const bounded = (count: unknown, max: number) => Number.isInteger(count) && (count as number) >= 0 && (count as number) <= max
  return bounded(stats.pointsAdded, 1000) && bounded(stats.pointsMoved, 1000) && bounded(stats.pointsDeleted, 1000)
    && bounded(stats.pointsSnapped, 1000) && bounded(stats.healingApplied, 100)
    && bounded(stats.paintSessions, 100) && bounded(stats.reconstructionEdits, 100)
}

function sourceDarkness(data: Uint8ClampedArray, index: number): number {
  const offset = index * 4
  const alpha = data[offset + 3] / 255
  const minChannel = Math.min(data[offset], data[offset + 1], data[offset + 2])
  return alpha * (255 - minChannel) / 255
}

function sourceChroma(data: Uint8ClampedArray, index: number): number {
  const offset = index * 4
  const alpha = data[offset + 3] / 255
  const maxChannel = Math.max(data[offset], data[offset + 1], data[offset + 2])
  const minChannel = Math.min(data[offset], data[offset + 1], data[offset + 2])
  return alpha * (maxChannel - minChannel) / 255
}

function isSourceInk(data: Uint8ClampedArray, index: number): boolean {
  const offset = index * 4
  return data[offset + 3] * (255 - Math.min(data[offset], data[offset + 1], data[offset + 2])) >= 255 * 70
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, value))))
}

function dotProbability(weights: number[], input: number[]): number {
  let sum = 0
  for (let index = 0; index < weights.length; index++) sum += weights[index] * input[index]
  return sigmoid(sum)
}

/**
 * Extracts 14 local features: bias, source darkness, auto ink, horizontal/vertical/diagonal densities,
 * local contrast against 5x5 perimeter, chroma saturation, and normalized coordinates.
 */
export function extractRichFeatures(pixels: LearningPixels, index: number): number[] {
  const { width, height, source, automatic } = pixels
  const x = index % width
  const y = Math.floor(index / width)
  const centerDarkness = sourceDarkness(source, index)
  const centerAuto = automatic[index * 4 + 3] / 255

  let sourceH = 0, sourceV = 0, autoH = 0, autoV = 0
  for (const offset of [-4, -2, -1, 1, 2, 4]) {
    if (x + offset >= 0 && x + offset < width) {
      if (isSourceInk(source, index + offset)) sourceH++
      if (automatic[(index + offset) * 4 + 3] >= 64) autoH++
    }
    if (y + offset >= 0 && y + offset < height) {
      if (isSourceInk(source, index + offset * width)) sourceV++
      if (automatic[(index + offset * width) * 4 + 3] >= 64) autoV++
    }
  }

  let sourceDiag1 = 0, sourceDiag2 = 0, autoDiag = 0
  for (const step of [-3, -2, -1, 1, 2, 3]) {
    const x1 = x + step
    const y1 = y + step
    if (x1 >= 0 && x1 < width && y1 >= 0 && y1 < height) {
      const target = y1 * width + x1
      if (isSourceInk(source, target)) sourceDiag1++
      if (automatic[target * 4 + 3] >= 64) autoDiag++
    }
    const x2 = x + step
    const y2 = y - step
    if (x2 >= 0 && x2 < width && y2 >= 0 && y2 < height) {
      const target = y2 * width + x2
      if (isSourceInk(source, target)) sourceDiag2++
      if (automatic[target * 4 + 3] >= 64) autoDiag++
    }
  }

  let ringSum = 0
  let ringCount = 0
  for (const [dx, dy] of [[-2, -2], [0, -2], [2, -2], [-2, 0], [2, 0], [-2, 2], [0, 2], [2, 2]]) {
    const nx = x + dx
    const ny = y + dy
    if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
      ringSum += sourceDarkness(source, ny * width + nx)
      ringCount++
    }
  }
  const localContrast = Math.max(-1, Math.min(1, centerDarkness - (ringCount ? ringSum / ringCount : 0)))

  return [
    1,
    centerDarkness,
    centerAuto,
    sourceH / 6,
    sourceV / 6,
    sourceDiag1 / 6,
    sourceDiag2 / 6,
    autoH / 6,
    autoV / 6,
    autoDiag / 12,
    localContrast,
    sourceChroma(source, index),
    x / Math.max(1, width - 1),
    y / Math.max(1, height - 1),
  ]
}

export function predictRichPixelScore(model: InteractionModel, pixels: LearningPixels, x: number, y: number): number {
  const px = Math.max(0, Math.min(pixels.width - 1, Math.round(x)))
  const py = Math.max(0, Math.min(pixels.height - 1, Math.round(y)))
  return dotProbability(model.featureWeights, extractRichFeatures(pixels, py * pixels.width + px))
}

export function trainRichExamples(
  model: InteractionModel,
  examples: RichLabeledExample[],
  epochs = 24,
  learningRate = 0.45,
): InteractionModel {
  if (!examples.length) return model
  const weights = [...model.featureWeights]
  let totalWeight = 0
  for (const example of examples) totalWeight += example.weight ?? 1
  if (!totalWeight) return model

  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradient = new Array<number>(RICH_FEATURE_COUNT).fill(0)
    for (const example of examples) {
      const sampleWeight = example.weight ?? 1
      const error = (dotProbability(weights, example.features) - example.label) * sampleWeight
      for (let index = 0; index < RICH_FEATURE_COUNT; index++) {
        gradient[index] += error * example.features[index]
      }
    }
    for (let index = 0; index < RICH_FEATURE_COUNT; index++) {
      const step = learningRate * (gradient[index] / totalWeight + 0.004 * (weights[index] - INITIAL_RICH_WEIGHTS[index]))
      weights[index] = Math.max(-16, Math.min(16, weights[index] - Math.max(-0.35, Math.min(0.35, step))))
    }
  }

  return {
    ...model,
    featureWeights: weights,
    featureSamples: model.featureSamples + 1,
    updatedAt: new Date().toISOString(),
  }
}

function samplePositiveAround(pixels: LearningPixels, point: PixelPoint, weight = 1.2): RichLabeledExample[] {
  const cx = Math.round(point.x)
  const cy = Math.round(point.y)
  const results: RichLabeledExample[] = []
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = cx + dx
      const y = cy + dy
      if (x < 0 || x >= pixels.width || y < 0 || y >= pixels.height) continue
      const index = y * pixels.width + x
      if ((dx === 0 && dy === 0) || isSourceInk(pixels.source, index)) {
        results.push({ features: extractRichFeatures(pixels, index), label: 1, weight: dx === 0 && dy === 0 ? weight : weight * 0.65 })
      }
    }
  }
  return results
}

function sampleNegativeAt(pixels: LearningPixels, point: PixelPoint, weight = 1.0): RichLabeledExample[] {
  const cx = Math.round(point.x)
  const cy = Math.round(point.y)
  if (cx < 0 || cx >= pixels.width || cy < 0 || cy >= pixels.height) return []
  return [{ features: extractRichFeatures(pixels, cy * pixels.width + cx), label: 0, weight }]
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function segmentDeviation(point: PixelPoint, start: PixelPoint, end: PixelPoint) {
  const chord = Math.hypot(end.x - start.x, end.y - start.y)
  if (!chord) return Math.hypot(point.x - start.x, point.y - start.y)
  return Math.abs((point.x - start.x) * (end.y - start.y) - (point.y - start.y) * (end.x - start.x)) / chord
}

export function learnFromPointAdded(
  model: InteractionModel,
  event: {
    point: PixelPoint
    insertedIndex: number
    pointsAfter: PixelPoint[]
    pixels?: LearningPixels
  },
): InteractionModel {
  let next: InteractionModel = {
    ...model,
    stats: { ...model.stats, pointsAdded: model.stats.pointsAdded + 1 },
    updatedAt: new Date().toISOString(),
  }

  const { point, insertedIndex, pointsAfter, pixels } = event
  if (insertedIndex > 0 && insertedIndex < pointsAfter.length - 1) {
    const prev = pointsAfter[insertedIndex - 1]
    const after = pointsAfter[insertedIndex + 1]
    const span = Math.hypot(after.x - prev.x, after.y - prev.y)
    if (span >= 4) {
      // User inserted a point between two existing points → slightly denser sampling preference.
      const targetSpacing = clamp(0.86, 0.65, 1.5)
      next = {
        ...next,
        spacingFactor: clamp(next.spacingSamples ? next.spacingFactor * 0.85 + targetSpacing * 0.15 : 0.94, 0.65, 1.5),
        spacingSamples: next.spacingSamples + 1,
      }
      const v1x = point.x - prev.x, v1y = point.y - prev.y
      const v2x = after.x - point.x, v2y = after.y - point.y
      const len1 = Math.hypot(v1x, v1y), len2 = Math.hypot(v2x, v2y)
      if (len1 > 1 && len2 > 1) {
        const cosAngle = clamp((v1x * v2x + v1y * v2y) / (len1 * len2), -1, 1)
        const bendDegrees = Math.acos(cosAngle) * 180 / Math.PI
        if (bendDegrees > 18) next = { ...next, curvatureBias: clamp(next.curvatureBias + 0.04, 0.6, 1.6) }
        else if (bendDegrees < 8) next = { ...next, curvatureBias: clamp(next.curvatureBias - 0.02, 0.6, 1.6) }
      }
    }
  }

  if (pixels) {
    const examples = samplePositiveAround(pixels, point, 1.15)
    // Add a few nearby clearly-empty background pixels as gentle negative contrast.
    for (const [dx, dy] of [[-7, 0], [7, 0], [0, -7], [0, 7]]) {
      const bx = Math.round(point.x + dx)
      const by = Math.round(point.y + dy)
      if (bx < 0 || bx >= pixels.width || by < 0 || by >= pixels.height) continue
      const nearOther = pointsAfter.some((other) => Math.hypot(other.x - bx, other.y - by) < 5)
      const index = by * pixels.width + bx
      if (!nearOther && !isSourceInk(pixels.source, index) && pixels.automatic[index * 4 + 3] < 32) {
        examples.push({ features: extractRichFeatures(pixels, index), label: 0, weight: 0.45 })
      }
    }
    // Also sample neutral gridline pixels away from curve points as negative contrast so AI never confuses gridlines with curves.
    if (pixels.gridLines) {
      let gridNegatives = 0
      for (const lineY of pixels.gridLines.horizontal) {
        if (gridNegatives >= 4) break
        const gy = Math.round(lineY)
        if (gy < 0 || gy >= pixels.height) continue
        const gx = clamp(Math.round(point.x + (gridNegatives % 2 === 0 ? 18 : -18)), 0, pixels.width - 1)
        const index = gy * pixels.width + gx
        if (Math.hypot(point.x - gx, point.y - gy) < 6 || pointsAfter.some((other) => Math.hypot(other.x - gx, other.y - gy) < 6)) continue
        if (isSourceInk(pixels.source, index) && pixels.automatic[index * 4 + 3] < 32 && sourceChroma(pixels.source, index) < 32 / 255) {
          examples.push({ features: extractRichFeatures(pixels, index), label: 0, weight: 0.85 })
          gridNegatives++
        }
      }
      for (const lineX of pixels.gridLines.vertical) {
        if (gridNegatives >= 8) break
        const gx = Math.round(lineX)
        if (gx < 0 || gx >= pixels.width) continue
        const gy = clamp(Math.round(point.y + (gridNegatives % 2 === 0 ? 18 : -18)), 0, pixels.height - 1)
        const index = gy * pixels.width + gx
        if (Math.hypot(point.x - gx, point.y - gy) < 6 || pointsAfter.some((other) => Math.hypot(other.x - gx, other.y - gy) < 6)) continue
        if (isSourceInk(pixels.source, index) && pixels.automatic[index * 4 + 3] < 32 && sourceChroma(pixels.source, index) < 32 / 255) {
          examples.push({ features: extractRichFeatures(pixels, index), label: 0, weight: 0.85 })
          gridNegatives++
        }
      }
    }
    next = trainRichExamples(next, examples, 16, 0.35)
  }

  return next
}

export function learnFromPointMoved(
  model: InteractionModel,
  event: {
    from: PixelPoint
    to: PixelPoint
    pixels?: LearningPixels
  },
): InteractionModel {
  const distance = Math.hypot(event.to.x - event.from.x, event.to.y - event.from.y)
  if (!Number.isFinite(distance) || distance < 1.5) return model

  let next: InteractionModel = {
    ...model,
    stats: { ...model.stats, pointsMoved: model.stats.pointsMoved + 1 },
    updatedAt: new Date().toISOString(),
  }

  if (distance <= 28) {
    const targetRadius = clamp(distance * 1.45 + 4, MIN_SNAP_RADIUS, MAX_SNAP_RADIUS)
    next = {
      ...next,
      snapRadius: Math.round((next.snapSamples ? next.snapRadius * 0.8 + targetRadius * 0.2 : targetRadius) * 10) / 10,
      snapSamples: next.snapSamples + 1,
    }
  }

  if (event.pixels) {
    const examples = [
      ...samplePositiveAround(event.pixels, event.to, 1.35),
      ...(distance >= 2.5 ? sampleNegativeAt(event.pixels, event.from, 1.2) : []),
    ]
    next = trainRichExamples(next, examples, 20, 0.4)
  }

  return next
}

export function learnFromPointDeleted(
  model: InteractionModel,
  event: {
    removed: PixelPoint
    prev?: PixelPoint
    next?: PixelPoint
    wasAutoGenerated?: boolean
    pixels?: LearningPixels
  },
): InteractionModel {
  let next: InteractionModel = {
    ...model,
    stats: { ...model.stats, pointsDeleted: model.stats.pointsDeleted + 1 },
    updatedAt: new Date().toISOString(),
  }

  const deviation = event.prev && event.next ? segmentDeviation(event.removed, event.prev, event.next) : Infinity
  const isSmoothRedundant = event.prev && event.next && deviation <= 2.5

  if (isSmoothRedundant) {
    const targetSpacing = event.wasAutoGenerated ? 1.16 : 1.1
    next = {
      ...next,
      spacingFactor: clamp(next.spacingSamples ? next.spacingFactor * 0.85 + targetSpacing * 0.15 : 1.06, 0.65, 1.5),
      spacingSamples: next.spacingSamples + 1,
    }
  } else if (event.pixels) {
    // Deleted point looks like an off-curve outlier / false detection → learn negative pixel example.
    const examples = sampleNegativeAt(event.pixels, event.removed, 1.15)
    next = trainRichExamples(next, examples, 16, 0.35)
  }

  return next
}

export function learnFromPointsSnapped(
  model: InteractionModel,
  event: {
    displacements: Array<{ from: PixelPoint; to: PixelPoint; distance: number }>
    pixels?: LearningPixels
  },
): InteractionModel {
  if (!event.displacements.length) return model

  const sortedDistances = event.displacements.map((item) => item.distance).filter(Number.isFinite).sort((a, b) => a - b)
  const p85 = sortedDistances[Math.min(sortedDistances.length - 1, Math.floor(sortedDistances.length * 0.85))] ?? DEFAULT_SNAP_RADIUS
  const targetRadius = clamp(p85 * 1.4 + 4, MIN_SNAP_RADIUS, MAX_SNAP_RADIUS)

  let next: InteractionModel = {
    ...model,
    snapRadius: Math.round((model.snapSamples ? model.snapRadius * 0.8 + targetRadius * 0.2 : targetRadius) * 10) / 10,
    snapSamples: model.snapSamples + 1,
    stats: { ...model.stats, pointsSnapped: model.stats.pointsSnapped + event.displacements.length },
    updatedAt: new Date().toISOString(),
  }

  if (event.pixels) {
    const examples: RichLabeledExample[] = []
    const stride = Math.max(1, Math.floor(event.displacements.length / 25))
    for (let index = 0; index < event.displacements.length; index += stride) {
      const item = event.displacements[index]
      examples.push(...samplePositiveAround(event.pixels, item.to, 1.1))
      if (item.distance >= 2) examples.push(...sampleNegativeAt(event.pixels, item.from, 0.9))
    }
    next = trainRichExamples(next, examples, 18, 0.35)
  }

  return next
}

export function learnFromHealingApplied(model: InteractionModel, choice: number): InteractionModel {
  if (!Number.isInteger(choice) || choice < 0 || choice > 2) return model
  const scores: [number, number, number] = [
    Math.round(model.healingScores[0] * 0.92 * 1000) / 1000,
    Math.round(model.healingScores[1] * 0.92 * 1000) / 1000,
    Math.round(model.healingScores[2] * 0.92 * 1000) / 1000,
  ]
  scores[choice] = Math.round((scores[choice] + 1) * 1000) / 1000
  return {
    ...model,
    healingScores: scores,
    stats: { ...model.stats, healingApplied: model.stats.healingApplied + 1 },
    updatedAt: new Date().toISOString(),
  }
}

export function preferredHealingChoice(model: InteractionModel): number {
  let best = 0
  for (let index = 1; index < 3; index++) {
    if (model.healingScores[index] > model.healingScores[best] + 0.05) best = index
  }
  return best
}

export function learnFromLayerComparison(
  model: InteractionModel,
  pixels: LearningPixels,
  corrected: Uint8ClampedArray,
  sourceKind: 'reconstruction' | 'paint',
): InteractionModel {
  const size = pixels.width * pixels.height
  if (!Number.isSafeInteger(size) || size <= 0 || pixels.source.length !== size * 4
    || pixels.automatic.length !== size * 4 || corrected.length !== size * 4) {
    throw new Error('Invalid learning image dimensions.')
  }

  const groups: number[][] = [[], [], [], []]
  const counts: [number, number, number, number] = [0, 0, 0, 0]
  const cap = 900
  for (let index = 0; index < size; index++) {
    const auto = pixels.automatic[index * 4 + 3] >= 64
    const target = corrected[index * 4 + 3] >= 64
    const group = (auto ? 2 : 0) + (target ? 1 : 0)
    const seen = ++counts[group]
    if (groups[group].length < cap) groups[group].push(index)
    else {
      const hash = Math.imul(index ^ (index >>> 16), 0x45d9f3b) >>> 0
      const position = hash % seen
      if (position < cap) groups[group][position] = index
    }
  }

  if (!counts[1] && !counts[2]) return model

  const examples: RichLabeledExample[] = groups.flatMap((group, category) =>
    group.map((index) => ({
      features: extractRichFeatures(pixels, index),
      label: (category % 2) as 0 | 1,
      weight: category === 1 || category === 2 ? 1.35 : 0.85,
    })),
  )

  const trained = trainRichExamples(model, examples, 45, 0.65)
  return {
    ...trained,
    stats: {
      ...trained.stats,
      ...(sourceKind === 'paint'
        ? { paintSessions: trained.stats.paintSessions + 1 }
        : { reconstructionEdits: trained.stats.reconstructionEdits + 1 }),
    },
  }
}

export function effectiveSampleStep(baseStep: number, legacySpacingFactor: number, interactionModel: InteractionModel): number {
  const combined = interactionModel.spacingSamples > 0
    ? interactionModel.spacingFactor * (0.5 + 0.5 * legacySpacingFactor)
    : legacySpacingFactor
  return Math.min(60, Math.max(1, Math.round(baseStep * combined)))
}

function legacyFeatures(pixels: LearningPixels, index: number): number[] {
  const { width, height, source, automatic } = pixels
  const x = index % width
  const y = Math.floor(index / width)
  let sourceH = 0, sourceV = 0, autoH = 0, autoV = 0
  for (const offset of [-4, -2, -1, 1, 2, 4]) {
    if (x + offset >= 0 && x + offset < width) {
      if (isSourceInk(source, index + offset)) sourceH++
      if (automatic[(index + offset) * 4 + 3] >= 64) autoH++
    }
    if (y + offset >= 0 && y + offset < height) {
      if (isSourceInk(source, index + offset * width)) sourceV++
      if (automatic[(index + offset * width) * 4 + 3] >= 64) autoV++
    }
  }
  return [
    1,
    isSourceInk(source, index) ? 1 : 0,
    automatic[index * 4 + 3] >= 64 ? 1 : 0,
    sourceH / 6, sourceV / 6, autoH / 6, autoV / 6,
    x / Math.max(1, width - 1), y / Math.max(1, height - 1),
  ]
}

/**
 * Predicts pixel-level curve refinements by combining the upgraded 14-feature interaction model
 * with the legacy 9-feature curve model (when available).
 */
export function predictEnhancedLearningEdits(
  legacyModel: LearningModel,
  interactionModel: InteractionModel,
  pixels: LearningPixels,
): { add: Uint8Array; erase: Uint8Array; changed: number } {
  const hasLegacy = legacyModel.samples > 0
  const hasInteraction = interactionModel.featureSamples > 0
  if (!hasLegacy && !hasInteraction) {
    const size = pixels.width * pixels.height
    return { add: new Uint8Array(size), erase: new Uint8Array(size), changed: 0 }
  }
  if (!hasInteraction) return predictLearningEdits(legacyModel, pixels)

  const size = pixels.width * pixels.height
  if (pixels.source.length !== size * 4 || pixels.automatic.length !== size * 4
    || interactionModel.featureWeights.length !== RICH_FEATURE_COUNT) {
    throw new Error('Invalid learning model or image.')
  }

  const interactionWeight = hasLegacy
    ? Math.min(0.75, 0.35 + interactionModel.featureSamples * 0.08)
    : 1
  const add = new Uint8Array(size)
  const erase = new Uint8Array(size)
  const gridMasks = buildLearningGridMasks(pixels.width, pixels.height, pixels.gridLines)
  let changed = 0
  let automaticCount = 0

  for (let index = 0; index < size; index++) {
    const automatic = pixels.automatic[index * 4 + 3] >= 64
    if (automatic) automaticCount++
    const x = index % pixels.width
    const y = Math.floor(index / pixels.width)
    if (pixels.region && (x < pixels.region.x || x > pixels.region.x + pixels.region.width
      || y < pixels.region.y || y > pixels.region.y + pixels.region.height)) continue

    if (!automatic && !isSourceInk(pixels.source, index)) {
      const near = [-4, -2, -1, 1, 2, 4].some((offset) =>
        (x + offset >= 0 && x + offset < pixels.width && pixels.automatic[(index + offset) * 4 + 3] >= 64)
        || (y + offset >= 0 && y + offset < pixels.height && pixels.automatic[(index + offset * pixels.width) * 4 + 3] >= 64))
      if (!near) continue
    }

    const richChance = dotProbability(interactionModel.featureWeights, extractRichFeatures(pixels, index))
    const chance = hasLegacy
      ? richChance * interactionWeight + dotProbability(legacyModel.weights, legacyFeatures(pixels, index)) * (1 - interactionWeight)
      : richChance

    if (automatic && chance < 0.22) { erase[index] = 1; changed++ }
    if (!automatic && chance > 0.78) {
      // Never allow learned pixel additions to re-introduce neutral gridlines onto the curve layer.
      const onNeutralGrid = Boolean(gridMasks && (gridMasks.horizontal[y] || gridMasks.vertical[x]) && sourceChroma(pixels.source, index) < 32 / 255)
      if (!onNeutralGrid) { add[index] = 1; changed++ }
    }
  }

  if (changed > Math.max(400, automaticCount * 0.65)) {
    return { add: new Uint8Array(size), erase: new Uint8Array(size), changed: 0 }
  }
  return { add, erase, changed }
}
