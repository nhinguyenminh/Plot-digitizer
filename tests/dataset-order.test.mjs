import { test } from 'node:test'
import assert from 'node:assert/strict'
import { datasetRange, reorderDatasets } from '../src/lib/dataset-order.ts'

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
