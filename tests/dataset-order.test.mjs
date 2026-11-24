import { test } from 'node:test'
import assert from 'node:assert/strict'
import { datasetRange, reorderById, reorderDatasets, updatePendingTrace } from '../src/lib/dataset-order.ts'

test('review merge and deletion retain only remaining candidates and correct point baselines', () => {
  const pending = { ids: ['a', 'b', 'c'], previousActiveId: 'old', warnings: [], generated: {
    a: [{ x: 0, y: 1 }], b: [{ x: 2, y: 3 }], c: [{ x: 4, y: 5 }],
  } }
  const merged = { id: 'b', points: [{ x: 0, y: 1 }, { x: 2, y: 3 }] }
  const updated = updatePendingTrace(pending, ['a', 'b'], merged)
  assert.deepEqual(updated.ids, ['b', 'c'])
  assert.deepEqual(updated.generated, { b: merged.points, c: pending.generated.c })
  assert.notEqual(updated.generated.b, merged.points)
  assert.equal(updatePendingTrace(updated, ['b', 'c']), null)
  assert.deepEqual(updatePendingTrace(updated, ['b']).ids, ['c'])
  assert.throws(() => updatePendingTrace(pending, ['old']), /Only new datasets/)
  assert.deepEqual(pending.ids, ['a', 'b', 'c'])
})

test('selects an inclusive range in either dataset order direction', () => {
  const items = ['a', 'b', 'c', 'd'].map((id) => ({ id }))
  assert.deepEqual(datasetRange(items, 'b', 'd'), ['b', 'c', 'd'])
  assert.deepEqual(datasetRange(items, 'd', 'b'), ['b', 'c', 'd'])
  assert.deepEqual(datasetRange(items, 'missing', 'b'), [])
})

test('moves a dataset before or after a target without changing the others', () => {
  const items = ['a', 'b', 'c', 'd'].map((id) => ({ id }))
  assert.deepEqual(reorderDatasets(items, 'd', 'b', false).map(({ id }) => id), ['a', 'd', 'b', 'c'])
  assert.deepEqual(reorderDatasets(items, 'a', 'c', true).map(({ id }) => id), ['b', 'c', 'a', 'd'])
  assert.deepEqual(items.map(({ id }) => id), ['a', 'b', 'c', 'd'])
  assert.equal(reorderDatasets(items, 'a', 'a', true), items)
  assert.equal(reorderDatasets(items, 'a', 'missing', true), items)
})

test('reorders chart tabs by id before or after a target without mutating the source', () => {
  const tabs = [{ id: 'c1', name: 'Chart 1' }, { id: 'c2', name: 'Chart 2' }, { id: 'c3', name: 'Chart 3' }]
  assert.deepEqual(reorderById(tabs, 'c3', 'c1', false).map(({ id }) => id), ['c3', 'c1', 'c2'])
  assert.deepEqual(reorderById(tabs, 'c1', 'c2', true).map(({ id }) => id), ['c2', 'c1', 'c3'])
  assert.deepEqual(tabs.map(({ id }) => id), ['c1', 'c2', 'c3'])
  assert.equal(reorderById(tabs, 'c2', 'c2', false), tabs)
})
