import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeDatasets } from '../src/lib/dataset-merge.ts'

const dataset = (id, xs, extra = {}) => ({
  id, name: id, color: '#123456', kind: 'curve', points: xs.map((x) => ({ x, y: 0 })), ...extra,
})

test('joins the closest endpoints, reversing segments without losing or altering points', () => {
  const first = dataset('a', [0, 10])
  const second = dataset('b', [30, 20])
  const third = dataset('c', [50, 40])
  const result = mergeDatasets([first, third, second], 'b')
  assert.equal(result.id, 'b')
  assert.deepEqual(result.points.map((point) => point.x), [0, 10, 20, 30, 40, 50])
  assert.deepEqual(second.points.map((point) => point.x), [30, 20])
})

test('retains duplicate and single points and permits empty datasets', () => {
  const result = mergeDatasets([dataset('a', [0, 10]), dataset('b', [10]), dataset('c', [])], 'c')
  assert.equal(result.id, 'c')
  assert.deepEqual(result.points.map((point) => point.x), [0, 10, 10])
  assert.deepEqual(mergeDatasets([dataset('a', []), dataset('b', [])], 'a').points, [])
})

test('rejects incompatible types or metadata rather than discarding them', () => {
  assert.throws(() => mergeDatasets([dataset('a', [0]), dataset('b', [1], { kind: 'speed' })], 'a'), /same curve type/)
  assert.throws(() => mergeDatasets([dataset('a', [0], { kind: 'speed', rpm: 1000 }), dataset('b', [1], { kind: 'speed', rpm: 2000 })], 'a'), /matching/)
  assert.throws(() => mergeDatasets([dataset('a', [0], { kind: 'measurement' }), dataset('b', [1], { kind: 'measurement' })], 'a'), /measurement/)
})
