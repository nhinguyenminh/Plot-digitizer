import { test } from 'node:test'
import assert from 'node:assert/strict'
import { History } from '../src/lib/history.ts'

test('undo and redo project edits across charts, branching after undo', () => {
  const history = new History('initial')
  history.record('chart one')
  history.record('chart two')
  assert.equal(history.undo(), 'chart one')
  assert.equal(history.undo(), 'initial')
  assert.equal(history.redo(), 'chart one')
  history.record('renamed chart')
  assert.equal(history.canRedo, false)
  assert.equal(history.undo(), 'chart one')
  assert.equal(history.redo(), 'renamed chart')
})

test('a drag can be grouped into one edit and old snapshots are bounded', () => {
  const history = new History(0, 3)
  history.record(1)
  history.record(2, true)
  assert.equal(history.undo(), 0)
  assert.equal(history.redo(), 2)
  history.record(3)
  history.record(4)
  assert.deepEqual(history.snapshots, [2, 3, 4])
  assert.equal(history.undo(), 3)
  assert.equal(history.undo(), 2)
  assert.equal(history.undo(), null)
})
