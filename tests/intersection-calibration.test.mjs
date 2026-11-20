import { test } from 'node:test'
import assert from 'node:assert/strict'
import { calibrationFromDrafts, calibrateFromIntersections, pointToData } from '../src/lib/digitizer.ts'

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

test('calibration drafts are validated and applied together', () => {
  const axis = { scale: 'linear', points: [{ x: 10, y: 20, value: 1 }, { x: 40, y: 50, value: 2 }] }
  const result = calibrationFromDrafts(axis, ['-5', '25'], 'x')
  assert.deepEqual(result.points.map((point) => point.value), [-5, 25])
  assert.deepEqual(axis.points.map((point) => point.value), [1, 2])
  for (const drafts of [['', '25'], ['5', '5'], ['not a number', '25']]) {
    assert.throws(() => calibrationFromDrafts(axis, drafts, 'x'))
  }
  assert.throws(() => calibrationFromDrafts({ ...axis, scale: 'log' }, ['0', '10'], 'x'))
  assert.throws(() => calibrationFromDrafts({ ...axis, scale: 'inverse' }, ['0', '10'], 'x'))
  assert.throws(() => calibrationFromDrafts({ ...axis, points: [axis.points[0], { ...axis.points[1], y: 22 }] }, ['1', '2'], 'y'), /4 pixels/)
  assert.throws(() => calibrationFromDrafts({ ...axis, points: [{ ...axis.points[0], x: NaN }, axis.points[1]] }, ['1', '2'], 'x'), /finite/)
  assert.equal(calibrationFromDrafts({ ...axis, scale: 'date' }, ['2024-01-01', '2024-02-01'], 'x').points[0].value, Date.parse('2024-01-01'))
})
