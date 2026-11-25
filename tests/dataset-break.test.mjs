import { test } from 'node:test'
import assert from 'node:assert/strict'
import { breakDatasetAtSegment, findNearestDatasetSegment, suggestSplitDatasetName } from '../src/lib/dataset-break.ts'

const sampleDataset = {
  id: 'ds-1',
  name: 'Speed 10500',
  color: '#2dd4bf',
  kind: 'speed',
  rpm: 10500,
  speedUnit: 'RPM',
  points: [
    { x: 10, y: 100 },
    { x: 50, y: 80 },
    { x: 90, y: 60 },
    { x: 130, y: 40 },
  ],
}

test('finds the nearest segment between two consecutive points and respects maxDistance', () => {
  const other = {
    id: 'ds-2',
    name: 'Curve 2',
    color: '#60a5fa',
    kind: 'curve',
    points: [{ x: 10, y: 20 }, { x: 130, y: 20 }],
  }
  const hit = findNearestDatasetSegment([sampleDataset, other], { x: 70, y: 72 }, 10)
  assert.ok(hit)
  assert.equal(hit.datasetId, 'ds-1')
  assert.equal(hit.segmentIndex, 1)
  assert.ok(hit.distance < 3)

  assert.equal(findNearestDatasetSegment([sampleDataset, other], { x: 70, y: 200 }, 10), null)
})

test('prefers the active dataset when two datasets overlap near the click point', () => {
  const a = { id: 'a', name: 'A', color: '#2dd4bf', kind: 'curve', points: [{ x: 0, y: 50 }, { x: 100, y: 50 }] }
  const b = { id: 'b', name: 'B', color: '#fb7185', kind: 'curve', points: [{ x: 0, y: 51 }, { x: 100, y: 51 }] }
  const hit = findNearestDatasetSegment([a, b], { x: 50, y: 50.2 }, 10, 'b')
  assert.equal(hit?.datasetId, 'b')
})

test('breaks a dataset between two points into two independent datasets with custom names and metadata', () => {
  const [first, second] = breakDatasetAtSegment(sampleDataset, 1, {
    firstName: 'Left Branch',
    secondName: 'Right Branch',
    secondColor: '#fb7185',
    secondId: 'ds-1-b',
  })

  assert.equal(first.id, 'ds-1')
  assert.equal(first.name, 'Left Branch')
  assert.equal(first.color, '#2dd4bf')
  assert.deepEqual(first.points, [{ x: 10, y: 100 }, { x: 50, y: 80 }])

  assert.equal(second.id, 'ds-1-b')
  assert.equal(second.name, 'Right Branch')
  assert.equal(second.color, '#fb7185')
  assert.equal(second.kind, 'speed')
  assert.equal(second.rpm, 10500)
  assert.equal(second.speedUnit, 'RPM')
  assert.deepEqual(second.points, [{ x: 90, y: 60 }, { x: 130, y: 40 }])

  // Ensure cloned points do not mutate original dataset
  first.points[0].x = 999
  assert.equal(sampleDataset.points[0].x, 10)
})

test('suggests unique default split names and rejects invalid break indices', () => {
  const existing = [
    { ...sampleDataset, name: 'Curve 1' },
    { ...sampleDataset, id: 'ds-2', name: 'Curve 1 (2)' },
  ]
  assert.equal(suggestSplitDatasetName('Curve 1', existing), 'Curve 1 (3)')
  assert.throws(() => breakDatasetAtSegment({ ...sampleDataset, points: [{ x: 0, y: 0 }] }, 0, { secondColor: '#ffffff' }), /at least two points/)
  assert.throws(() => breakDatasetAtSegment(sampleDataset, 3, { secondColor: '#ffffff' }), /valid segment/)
})
