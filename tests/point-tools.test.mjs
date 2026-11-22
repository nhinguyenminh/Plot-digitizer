import { test } from 'node:test'
import assert from 'node:assert/strict'
import { insertPointInDataset, snapDatasetPointsToCurve, snapPointToCurveCenter } from '../src/lib/point-tools.ts'

function createCanvasImage(width, height, fill = [255, 255, 255, 0]) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let index = 0; index < width * height; index++) {
    const offset = index * 4
    data[offset] = fill[0]
    data[offset + 1] = fill[1]
    data[offset + 2] = fill[2]
    data[offset + 3] = fill[3]
  }
  return { width, height, data }
}

function paintPixel(image, x, y, rgba) {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return
  const offset = (y * image.width + x) * 4
  image.data[offset] = rgba[0]
  image.data[offset + 1] = rgba[1]
  image.data[offset + 2] = rgba[2]
  image.data[offset + 3] = rgba[3]
}

test('insertPointInDataset inserts between bracketing X neighbors by default', () => {
  const existing = [{ x: 10, y: 50 }, { x: 50, y: 40 }, { x: 100, y: 20 }]
  const middle = insertPointInDataset(existing, { x: 30, y: 44 }, true)
  assert.equal(middle.index, 1)
  assert.deepEqual(middle.points.map((p) => p.x), [10, 30, 50, 100])

  const before = insertPointInDataset(existing, { x: 4, y: 55 }, true)
  assert.equal(before.index, 0)
  assert.deepEqual(before.points.map((p) => p.x), [4, 10, 50, 100])

  const after = insertPointInDataset(existing, { x: 140, y: 10 }, true)
  assert.equal(after.index, 3)
  assert.deepEqual(after.points.map((p) => p.x), [10, 50, 100, 140])
})

test('insertPointInDataset preserves descending X order and picks nearest branch on multi-valued curves', () => {
  const descending = [{ x: 100, y: 20 }, { x: 60, y: 30 }, { x: 20, y: 50 }]
  const mid = insertPointInDataset(descending, { x: 80, y: 25 }, true)
  assert.equal(mid.index, 1)
  assert.deepEqual(mid.points.map((p) => p.x), [100, 80, 60, 20])

  const beforeDesc = insertPointInDataset(descending, { x: 130, y: 15 }, true)
  assert.equal(beforeDesc.index, 0)
  assert.deepEqual(beforeDesc.points.map((p) => p.x), [130, 100, 60, 20])

  // C-shaped contour: top branch at y=20, bottom branch at y=80
  const contour = [{ x: 20, y: 20 }, { x: 80, y: 20 }, { x: 80, y: 80 }, { x: 20, y: 80 }]
  const nearBottom = insertPointInDataset(contour, { x: 50, y: 78 }, true)
  assert.equal(nearBottom.index, 3)
  assert.deepEqual(nearBottom.points[3], { x: 50, y: 78 })
})

test('insertPointInDataset appends to end when insertByX is false', () => {
  const existing = [{ x: 10, y: 50 }, { x: 100, y: 20 }]
  const appended = insertPointInDataset(existing, { x: 40, y: 35 }, false)
  assert.equal(appended.index, 2)
  assert.deepEqual(appended.points.map((p) => p.x), [10, 100, 40])
})

test('snapPointToCurveCenter aligns off-curve points onto thick stroke centerline without sideways drift', () => {
  const image = createCanvasImage(120, 80)
  // Draw a 3px thick horizontal curve centered at y = 30.5 (rows 29, 30, 31)
  for (let x = 10; x <= 110; x++) {
    for (const y of [29, 30, 31]) paintPixel(image, x, y, [0, 102, 255, 255])
  }

  const snapped = snapPointToCurveCenter(image, { x: 54.2, y: 35.8 }, { mode: 'isolated', radius: 12 })
  assert.ok(snapped)
  assert.equal(snapped.moved, true)
  assert.ok(Math.abs(snapped.point.x - 54.2) < 0.8, `expected minimal x drift, got ${snapped.point.x}`)
  assert.ok(Math.abs(snapped.point.y - 30.5) < 0.6, `expected y near 30.5, got ${snapped.point.y}`)

  // Distant point beyond radius stays unsnapped
  assert.equal(snapPointToCurveCenter(image, { x: 54, y: 60 }, { mode: 'isolated', radius: 12 }), null)
})

test('snapDatasetPointsToCurve isolates nearest parallel curve and supports color and dark modes', () => {
  const colorImg = createCanvasImage(100, 80, [255, 255, 255, 255])
  // Black horizontal grid line at y=20
  for (let x = 5; x < 95; x++) paintPixel(colorImg, x, 20, [0, 0, 0, 255])
  // Blue curve at y=26
  for (let x = 5; x < 95; x++) {
    paintPixel(colorImg, x, 25, [0, 102, 255, 255])
    paintPixel(colorImg, x, 26, [0, 102, 255, 255])
  }
  // Second parallel blue curve at y=50
  for (let x = 5; x < 95; x++) paintPixel(colorImg, x, 50, [0, 102, 255, 255])

  // Point at y=22 is closer to the black grid (y=20) than blue curve (y=25.5), must snap to blue curve!
  const result = snapDatasetPointsToCurve(colorImg, [{ x: 30, y: 22 }, { x: 60, y: 47 }, { x: 80, y: 74 }], {
    mode: 'color',
    curveColor: [0, 102, 255],
    tolerance: 70,
    radius: 10,
  })
  assert.equal(result.movedCount, 2)
  assert.ok(Math.abs(result.points[0].y - 26) < 0.8)
  assert.ok(Math.abs(result.points[1].y - 50.5) < 0.8)
  assert.deepEqual(result.points[2], { x: 80, y: 74 })

  // Dark mode on original grayscale scan
  const darkImg = createCanvasImage(100, 60, [255, 255, 255, 255])
  for (let x = 10; x < 90; x++) paintPixel(darkImg, x, 30, [20, 20, 20, 255])
  const darkSnap = snapPointToCurveCenter(darkImg, { x: 45, y: 34 }, { mode: 'dark', radius: 10 })
  assert.ok(darkSnap && darkSnap.moved)
  assert.ok(Math.abs(darkSnap.point.y - 30.5) < 0.6)
})
