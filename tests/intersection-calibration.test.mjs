import { test } from 'node:test'
import assert from 'node:assert/strict'
import { calibrateFromIntersections, pointToData } from '../src/lib/digitizer.ts'

test('two intersections calibrate both axes in click order', () => {
  const result = calibrateFromIntersections(
    [{ x: 200, y: 30 }, { x: 100, y: 130 }],
    [20, 10, 3000, 1000], 'linear', 'linear',
  )
  assert.deepEqual(pointToData({ x: 150, y: 80 }, result.xAxis, result.yAxis), { x: 15, y: 2000 })
})

test('rejects coincident axes, invalid scale values, and non-finite coordinates', () => {
  const points = [{ x: 10, y: 20 }, { x: 30, y: 40 }]
  assert.throws(() => calibrateFromIntersections([{ x: 10, y: 20 }, { x: 10, y: 40 }], [1, 2, 1, 2], 'linear', 'linear'))
  assert.throws(() => calibrateFromIntersections([{ x: 10, y: 20 }, { x: 30, y: 20 }], [1, 2, 1, 2], 'linear', 'linear'))
  assert.throws(() => calibrateFromIntersections(points, [0, 10, 1, 2], 'log', 'linear'))
  assert.throws(() => calibrateFromIntersections(points, [1, 10, 0, 2], 'linear', 'inverse'))
  assert.throws(() => calibrateFromIntersections([{ x: NaN, y: 20 }, points[1]], [1, 2, 1, 2], 'linear', 'linear'))
})
