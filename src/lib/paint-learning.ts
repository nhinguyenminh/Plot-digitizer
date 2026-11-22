import { compareLearningPixels, trainLearningComparison } from './learning.ts'
import type { LearningModel } from './learning.ts'
import type { TrainingSample } from './learning-store.ts'

async function hashPixels(images: Uint8ClampedArray[]) {
  const hashes = await Promise.all(images.map(async (image) => new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(image)))))
  const bytes = new Uint8Array(hashes.length * 32)
  hashes.forEach((hash, index) => bytes.set(hash, index * 32))
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function createPaintLearningExample(
  pixels: { width: number; height: number; source: Uint8ClampedArray; automatic: Uint8ClampedArray },
  additions: Uint8Array,
  removals: Uint8Array,
  model: LearningModel,
): Promise<{ sample: TrainingSample; model: LearningModel; updated: boolean; corrected: Uint8ClampedArray }> {
  const size = pixels.width * pixels.height
  if (!Number.isSafeInteger(size) || size <= 0 || pixels.source.length !== size * 4
    || pixels.automatic.length !== size * 4 || additions.length !== size || removals.length !== size) {
    throw new Error('Invalid painted learning image dimensions.')
  }
  const corrected = pixels.automatic.slice()
  for (let index = 0; index < size; index++) {
    const offset = index * 4
    if (removals[index]) {
      corrected[offset + 3] = 0
      continue
    }
    if (!additions[index]) continue
    const sourceAlpha = pixels.source[offset + 3]
    const darkness = 255 - Math.min(pixels.source[offset], pixels.source[offset + 1], pixels.source[offset + 2])
    if (sourceAlpha * darkness >= 255 * 70) corrected[offset + 3] = sourceAlpha
  }
  const comparison = compareLearningPixels(pixels, corrected)
  const next = trainLearningComparison(model, comparison)
  const id = await hashPixels([pixels.source, pixels.automatic, corrected])
  const delta = model.weights.map((weight, index) => Math.round(Math.max(-0.5, Math.min(0.5, (next?.weights[index] ?? weight) - weight)) * 10000) / 10000)
  return {
    sample: { id, createdAt: new Date().toISOString(), delta, ...(next ? { comparison } : {}) },
    model: next ?? model, updated: next !== null, corrected,
  }
}
