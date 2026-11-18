import { test } from 'node:test'
import assert from 'node:assert/strict'
import { traceColor } from '../src/lib/digitizer.ts'

function imageWithCurve(curve, gaps = []) {
  const width = 140
  const height = 100
  const data = new Uint8ClampedArray(width * height * 4).fill(255)
  const guide = []
  for (let x = 10; x <= 130; x++) {
    const y = Math.round(curve(x))
    if (!gaps.some(([left, right]) => x >= left && x <= right)) {
      const offset = (y * width + x) * 4
      data[offset] = 0
      data[offset + 1] = 102
      data[offset + 2] = 255
    }
    if ((x - 10) % 10 === 0) guide.push({ x, y: y + 3 })
  }
  return { image: { width, height, data }, guide }
}

function paintedTrace(image, guide, spacing) {
  return traceColor(image, guide[Math.floor(guide.length / 2)], 76, spacing, guide, 8, undefined, true)
}

test('painted trace uses spacing and snaps the seed to the curve', () => {
  const { image, guide } = imageWithCurve(() => 40)
  const sparse = paintedTrace(image, guide, 12)
  const dense = paintedTrace(image, guide, 4)
  assert.ok(dense.length > sparse.length)
  assert.ok(sparse.every((point) => point.y === 40))
  assert.ok(sparse.slice(1).every((point, index) => point.x - sparse[index].x <= 12))
})

test('painted trace retains bends and crosses short gaps', () => {
  const straight = imageWithCurve(() => 35)
  const curved = imageWithCurve((x) => 35 + 18 * Math.sin((x - 10) * Math.PI / 20), [[34, 36]])
  const straightPoints = paintedTrace(straight.image, straight.guide, 12)
  const curvedPoints = paintedTrace(curved.image, curved.guide, 12)
  assert.ok(curvedPoints.length > straightPoints.length)
  assert.ok(curvedPoints[0].x < 34 && curvedPoints.at(-1).x > 36)
  assert.ok(curvedPoints.some((point) => point.y >= 50))
  assert.ok(curvedPoints.some((point) => point.y <= 20))
})
