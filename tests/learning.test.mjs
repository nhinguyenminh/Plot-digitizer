import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compareLearningPixels, initialLearningModel, predictLearningEdits, trainLearningComparison, trainLearningModel } from '../src/lib/learning.ts'

function example(shift = 0) {
  const width = 120, height = 80
  const source = new Uint8ClampedArray(width * height * 4).fill(255)
  const automatic = new Uint8ClampedArray(width * height * 4)
  const corrected = new Uint8ClampedArray(width * height * 4)
  for (let x = 10 + shift; x < 100 + shift; x++) for (const y of [15 + shift, 60 - shift]) {
    const offset = (y * width + x) * 4
    source[offset] = source[offset + 1] = source[offset + 2] = 0
    if (y === 15 + shift) automatic[offset + 3] = 255
    corrected[offset + 3] = 255
  }
  for (let y = 10; y < 70; y++) {
    const offset = (y * width + 112 + shift) * 4
    source[offset] = source[offset + 1] = source[offset + 2] = 0
    automatic[offset + 3] = 255
  }
  return { pixels: { width, height, source, automatic }, corrected }
}

test('learns both missing curve ink and unwanted ink from corrected examples', () => {
  const { pixels, corrected } = example()
  let model = initialLearningModel()
  assert.equal(predictLearningEdits(model, pixels).changed, 0)
  for (let index = 0; index < 4; index++) {
    const training = example(index)
    model = trainLearningModel(model, training.pixels, training.corrected)
  }
  const heldOut = example(5)
  const prediction = predictLearningEdits(model, heldOut.pixels)
  let addedCorrectly = 0, erasedCorrectly = 0, mistakes = 0
  for (let index = 0; index < prediction.add.length; index++) {
    const target = heldOut.corrected[index * 4 + 3] >= 64
    if (prediction.add[index]) target ? addedCorrectly++ : mistakes++
    if (prediction.erase[index]) target ? mistakes++ : erasedCorrectly++
  }
  assert.ok(addedCorrectly >= 40)
  assert.ok(erasedCorrectly >= 40)
  assert.equal(mistakes, 0)
  assert.equal(model.samples, 4)
})

test('limits learned predictions and never changes pixels outside the plot', () => {
  const { pixels } = example()
  const model = { version: 1, samples: 1, weights: [20, 0, 0, 0, 0, 0, 0, 0, 0] }
  assert.throws(() => predictLearningEdits(model, pixels), /too extensive/)
  const region = { x: 0, y: 0, width: 3, height: 3 }
  const prediction = predictLearningEdits(model, { ...pixels, region })
  for (let y = 0; y < pixels.height; y++) for (let x = 0; x < pixels.width; x++) {
    if (x > 3 || y > 3) assert.equal(prediction.add[y * pixels.width + x] + prediction.erase[y * pixels.width + x], 0)
  }
  assert.throws(() => predictLearningEdits({ ...model, weights: [] }, pixels), /Invalid/)
})

test('does not train on an unchanged result and rejects inconsistent images', () => {
  const { pixels } = example()
  assert.equal(trainLearningModel(initialLearningModel(), pixels, pixels.automatic), null)
  assert.throws(() => trainLearningModel(initialLearningModel(), pixels, new Uint8ClampedArray(1)), /dimensions/)
})

test('records counts and labelled features for additions, removals and unchanged pixels', () => {
  const { pixels, corrected } = example()
  const comparison = compareLearningPixels(pixels, corrected)
  assert.deepEqual(comparison.counts, [9360, 90, 60, 90])
  assert.equal(comparison.examples.length, 1500 + 90 + 60 + 90)
  assert.ok(comparison.examples.some((row) => row[2] === 0 && row[9] === 1))
  assert.ok(comparison.examples.some((row) => row[2] === 1 && row[9] === 0))
  assert.ok(comparison.examples.every((row) => row.length === 10))
  assert.deepEqual(trainLearningComparison(initialLearningModel(), comparison), trainLearningModel(initialLearningModel(), pixels, corrected))
})
