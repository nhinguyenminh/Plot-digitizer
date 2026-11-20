import { test } from 'node:test'
import assert from 'node:assert/strict'
import { datasetColor } from '../src/lib/digitizer.ts'
import { initialPointSpacingModel, removeSpacingOutliers, trainPointSpacingModel } from '../src/lib/point-spacing.ts'

test('learns a bounded, slightly sparser interval from manually thinned datasets', () => {
  const generated = Array.from({ length: 11 }, (_, index) => ({ x: index * 10, y: 0 }))
  const corrected = generated.filter((_, index) => index % 2 === 0)
  const model = trainPointSpacingModel(initialPointSpacingModel(), [{ generated, corrected }])
  assert.equal(model.samples, 1)
  assert.equal(model.factor, 1.2)
  assert.equal(trainPointSpacingModel(model, [{ generated, corrected: generated }]).samples, 1)
})

test('filters unusually close straight-line points but keeps sharp bends', () => {
  const closePoints = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 5, y: 0 }, { x: 9, y: 0 }, { x: 10, y: 0 }]
  assert.deepEqual(removeSpacingOutliers(closePoints), [closePoints[0], closePoints[2], closePoints[4]])

  const bend = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 5, y: 5 }, { x: 5, y: 9 }, { x: 5, y: 13 }]
  assert.deepEqual(removeSpacingOutliers(bend), bend)
})

test('assigns distinct colors across datasets regardless of brush group', () => {
  const colors = Array.from({ length: 12 }, (_, index) => datasetColor(index + 1))
  assert.equal(new Set(colors).size, colors.length)
})
