import { renderReconstructionCurveLayer } from './reconstruct'
import { compareLearningPixels, trainLearningComparison } from './learning'
import type { LearningModel } from './learning'
import type { TrainingSample } from './learning-store'
import type { Correction, Reconstruction, ReconstructionWidths } from './reconstruct'

async function hashPixels(images: Uint8ClampedArray[]) {
  const hashes = await Promise.all(images.map(async (image) => new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(image)))))
  const bytes = new Uint8Array(hashes.length * 32)
  hashes.forEach((hash, index) => bytes.set(hash, index * 32))
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function createLearningExample(sourceUrl: string, geometry: Reconstruction, corrections: Correction[], widths: ReconstructionWidths, model: LearningModel): Promise<{ sample: TrainingSample; model: LearningModel; updated: boolean }> {
  const source = new Image()
  source.src = sourceUrl
  await source.decode()
  if (source.naturalWidth !== geometry.width || source.naturalHeight !== geometry.height) throw new Error('The source image no longer matches the reconstruction.')
  const original = document.createElement('canvas')
  original.width = geometry.width; original.height = geometry.height
  const sourceContext = original.getContext('2d', { willReadFrequently: true })
  if (!sourceContext) throw new Error('This browser cannot read the source image for learning.')
  sourceContext.drawImage(source, 0, 0)
  const automatic = renderReconstructionCurveLayer(geometry, [], widths)
  const corrected = renderReconstructionCurveLayer(geometry, corrections, widths)
  const autoContext = automatic.getContext('2d', { willReadFrequently: true })
  const correctedContext = corrected.getContext('2d', { willReadFrequently: true })
  if (!autoContext || !correctedContext) throw new Error('This browser cannot read the curve layers for learning.')
  const pixels = {
    width: geometry.width, height: geometry.height,
    source: sourceContext.getImageData(0, 0, geometry.width, geometry.height).data,
    automatic: autoContext.getImageData(0, 0, geometry.width, geometry.height).data,
  }
  const target = correctedContext.getImageData(0, 0, geometry.width, geometry.height).data
  const comparison = compareLearningPixels(pixels, target)
  const next = trainLearningComparison(model, comparison)
  const id = await hashPixels([pixels.source, pixels.automatic, target])
  const delta = model.weights.map((weight, index) => Math.round(Math.max(-0.5, Math.min(0.5, (next?.weights[index] ?? weight) - weight)) * 10000) / 10000)
  return {
    sample: { id, createdAt: new Date().toISOString(), delta, ...(next ? { comparison } : {}) },
    model: next ?? model, updated: next !== null,
  }
}
