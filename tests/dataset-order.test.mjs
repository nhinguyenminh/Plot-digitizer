import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reorderDatasets } from '../src/lib/dataset-order.ts'

test('moves a dataset before or after a target without changing the others', () => {
  const items = ['a', 'b', 'c', 'd'].map((id) => ({ id }))
  assert.deepEqual(reorderDatasets(items, 'd', 'b', false).map(({ id }) => id), ['a', 'd', 'b', 'c'])
  assert.deepEqual(reorderDatasets(items, 'a', 'c', true).map(({ id }) => id), ['b', 'c', 'a', 'd'])
  assert.deepEqual(items.map(({ id }) => id), ['a', 'b', 'c', 'd'])
  assert.equal(reorderDatasets(items, 'a', 'a', true), items)
  assert.equal(reorderDatasets(items, 'a', 'missing', true), items)
})
