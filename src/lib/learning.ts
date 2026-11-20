export interface LearningModel {
  version: 1
  weights: number[]
  samples: number
}

export interface LearningPixels {
  width: number
  height: number
  source: Uint8ClampedArray
  automatic: Uint8ClampedArray
  region?: { x: number; y: number; width: number; height: number }
}

export interface CurveComparison {
  version: 1
  width: number
  height: number
  counts: [number, number, number, number]
  examples: number[][]
}

const initialWeights = [-4, 0, 8, 0, 0, 0, 0, 0, 0]

export const initialLearningModel = (): LearningModel => ({ version: 1, weights: [...initialWeights], samples: 0 })

function isInk(data: Uint8ClampedArray, index: number) {
  const offset = index * 4
  return data[offset + 3] * (255 - Math.min(data[offset], data[offset + 1], data[offset + 2])) >= 255 * 70
}

function features(pixels: LearningPixels, index: number): number[] {
  const { width, height, source, automatic } = pixels
  const x = index % width, y = Math.floor(index / width)
  let sourceH = 0, sourceV = 0, autoH = 0, autoV = 0
  for (const offset of [-4, -2, -1, 1, 2, 4]) {
    if (x + offset >= 0 && x + offset < width) {
      if (isInk(source, index + offset)) sourceH++
      if (automatic[(index + offset) * 4 + 3] >= 64) autoH++
    }
    if (y + offset >= 0 && y + offset < height) {
      if (isInk(source, index + offset * width)) sourceV++
      if (automatic[(index + offset * width) * 4 + 3] >= 64) autoV++
    }
  }
  return [1, isInk(source, index) ? 1 : 0, automatic[index * 4 + 3] >= 64 ? 1 : 0,
    sourceH / 6, sourceV / 6, autoH / 6, autoV / 6, x / Math.max(1, width - 1), y / Math.max(1, height - 1)]
}

function probability(weights: number[], input: number[]) {
  let value = 0
  for (let index = 0; index < weights.length; index++) value += weights[index] * input[index]
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, value))))
}

export function compareLearningPixels(pixels: LearningPixels, corrected: Uint8ClampedArray): CurveComparison {
  const size = pixels.width * pixels.height
  if (!Number.isSafeInteger(pixels.width) || !Number.isSafeInteger(pixels.height) || pixels.width <= 0 || pixels.height <= 0
    || pixels.source.length !== size * 4 || pixels.automatic.length !== size * 4 || corrected.length !== size * 4) throw new Error('Invalid learning image dimensions.')
  const groups: number[][] = [[], [], [], []]
  const counts: [number, number, number, number] = [0, 0, 0, 0]
  for (let index = 0; index < size; index++) {
    const automatic = pixels.automatic[index * 4 + 3] >= 64
    const target = corrected[index * 4 + 3] >= 64
    const group = (automatic ? 2 : 0) + (target ? 1 : 0)
    const seen = ++counts[group]
    if (groups[group].length < 1500) groups[group].push(index)
    else {
      const hash = Math.imul(index ^ (index >>> 16), 0x45d9f3b) >>> 0
      const position = hash % seen
      if (position < 1500) groups[group][position] = index
    }
  }
  return {
    version: 1, width: pixels.width, height: pixels.height, counts,
    examples: groups.flatMap((group, category) => group.map((index) => [...features(pixels, index), category % 2])),
  }
}

export function trainLearningComparison(model: LearningModel, comparison: CurveComparison): LearningModel | null {
  if (!comparison.counts[1] && !comparison.counts[2]) return null
  const examples = comparison.examples
  const weights = [...model.weights]
  for (let epoch = 0; epoch < 80; epoch++) {
    const gradient = new Array<number>(weights.length).fill(0)
    for (const example of examples) {
      const error = probability(weights, example) - example[9]
      for (let index = 0; index < weights.length; index++) gradient[index] += error * example[index]
    }
    for (let index = 0; index < weights.length; index++) {
      weights[index] -= 0.8 * (gradient[index] / examples.length + 0.002 * (weights[index] - initialWeights[index]))
    }
  }
  return { version: 1, weights, samples: model.samples + 1 }
}

export function trainLearningModel(model: LearningModel, pixels: LearningPixels, corrected: Uint8ClampedArray): LearningModel | null {
  return trainLearningComparison(model, compareLearningPixels(pixels, corrected))
}

export function predictLearningEdits(model: LearningModel, pixels: LearningPixels) {
  const size = pixels.width * pixels.height
  if (pixels.source.length !== size * 4 || pixels.automatic.length !== size * 4 || model.weights.length !== initialWeights.length) throw new Error('Invalid learning model or image.')
  const add = new Uint8Array(size), erase = new Uint8Array(size)
  let changed = 0, automaticCount = 0
  for (let index = 0; index < size; index++) {
    const automatic = pixels.automatic[index * 4 + 3] >= 64
    if (automatic) automaticCount++
    const x = index % pixels.width, y = Math.floor(index / pixels.width)
    if (pixels.region && (x < pixels.region.x || x > pixels.region.x + pixels.region.width || y < pixels.region.y || y > pixels.region.y + pixels.region.height)) continue
    if (!automatic && !isInk(pixels.source, index)) {
      const near = [-4, -2, -1, 1, 2, 4].some((offset) =>
        (x + offset >= 0 && x + offset < pixels.width && pixels.automatic[(index + offset) * 4 + 3] >= 64)
        || (y + offset >= 0 && y + offset < pixels.height && pixels.automatic[(index + offset * pixels.width) * 4 + 3] >= 64))
      if (!near) continue
    }
    const input = features(pixels, index)
    const chance = probability(model.weights, input)
    if (automatic && chance < 0.2) { erase[index] = 1; changed++ }
    if (!automatic && chance > 0.8) { add[index] = 1; changed++ }
  }
  if (changed > Math.min(10000, Math.max(200, automaticCount * 0.3))) throw new Error('Learned changes were too extensive; the unmodified automatic result was kept.')
  return { add, erase, changed }
}
