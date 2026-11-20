import { test } from 'node:test'
import assert from 'node:assert/strict'
import { estimateAxisAlignment, estimateDeskew, rotationGeometry, rulerCorrection } from '../src/lib/deskew.ts'

function grid(width, height, angle, verticalAngle = angle) {
  const data = new Uint8ClampedArray(width * height * 4).fill(255)
  const slope = Math.tan(angle * Math.PI / 180)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const horizontal = [40, 100, 160].some((line) => Math.abs(y - line - slope * x) < 0.6)
    const vertical = [40, 120, 200].some((line) => Math.abs(x - line + Math.tan(verticalAngle * Math.PI / 180) * y) < 0.6)
    if (horizontal || vertical) {
      const offset = (y * width + x) * 4
      data[offset] = data[offset + 1] = data[offset + 2] = 0
    }
  }
  return data
}

test('estimates small positive and negative grid rotations and leaves aligned grid aligned', () => {
  for (const angle of [-4.3, -1.7, 0, 2.4, 5.2]) {
    const result = estimateDeskew(grid(280, 220, angle), 280, 220)
    assert.notEqual(result, null)
    assert.ok(Math.abs(result + angle) <= 0.3, `${angle}: ${result}`)
  }
})

test('reports non-perpendicular axes and chooses the horizontal correction when rotation alone cannot align both', () => {
  const result = estimateAxisAlignment(grid(280, 220, 2, -3), 280, 220)
  assert.ok(result)
  assert.ok(Math.abs(result.degrees + 2) <= 0.3)
  assert.ok(result.axisDifference > 4.5 && result.axisDifference < 5.5)
  const aligned = estimateAxisAlignment(grid(280, 220, 2, 2), 280, 220)
  assert.ok(aligned && aligned.axisDifference !== null && aligned.axisDifference < 0.5)
})

test('estimates rotation from one horizontal and one vertical axis without a grid', () => {
  const width = 280, height = 220
  const data = new Uint8ClampedArray(width * height * 4).fill(255)
  const slope = Math.tan(4 * Math.PI / 180)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if ((x >= 20 && x <= 250 && Math.abs(y - 170 - slope * x) < 1)
      || (y >= 10 && y <= 190 && Math.abs(x - 50 + slope * y) < 1)) {
      const offset = (y * width + x) * 4
      data[offset] = data[offset + 1] = data[offset + 2] = 0
    }
  }
  const result = estimateAxisAlignment(data, width, height)
  assert.ok(result && Math.abs(result.degrees + 4) <= 0.3)
})

test('does not claim a skew for blank or random noise', () => {
  const blank = new Uint8ClampedArray(200 * 150 * 4).fill(255)
  assert.equal(estimateDeskew(blank, 200, 150), null)
  const noise = blank.slice()
  for (let i = 0; i < 1500; i++) {
    const offset = ((i * 197 + 719) % (200 * 150)) * 4
    noise[offset] = noise[offset + 1] = noise[offset + 2] = 0
  }
  assert.equal(estimateDeskew(noise, 200, 150), null)
  const singleLine = blank.slice()
  for (let x = 0; x < 200; x++) for (let dy = -1; dy <= 1; dy++) {
    const y = Math.round(40 + x * 0.05) + dy
    const offset = (y * 200 + x) * 4
    singleLine[offset] = singleLine[offset + 1] = singleLine[offset + 2] = 0
  }
  assert.equal(estimateDeskew(singleLine, 200, 150), null)
})

test('rotation geometry encloses the source and transforms pixel centers consistently', () => {
  const geometry = rotationGeometry(400, 300, 3)
  assert.ok(geometry.width > 400 && geometry.height > 300)
  const center = geometry.transformPoint({ x: 199.5, y: 149.5 })
  assert.ok(Math.abs(center.x - (geometry.width - 1) / 2) < 1e-8)
  assert.ok(Math.abs(center.y - (geometry.height - 1) / 2) < 1e-8)
  assert.deepEqual([rotationGeometry(400, 300, 90).width, rotationGeometry(400, 300, 90).height], [300, 400])
})

test('straightens horizontal and vertical rulers in either drawing direction', () => {
  for (const [a, b, expected] of [
    [{ x: 10, y: 10 }, { x: 110, y: 15 }, -Math.atan(0.05) * 180 / Math.PI],
    [{ x: 110, y: 15 }, { x: 10, y: 10 }, -Math.atan(0.05) * 180 / Math.PI],
    [{ x: 10, y: 10 }, { x: 15, y: 110 }, Math.atan(0.05) * 180 / Math.PI],
    [{ x: 15, y: 110 }, { x: 10, y: 10 }, Math.atan(0.05) * 180 / Math.PI],
  ]) assert.ok(Math.abs(rulerCorrection(a, b) - expected) < 1e-8)
  assert.throws(() => rulerCorrection({ x: 0, y: 0 }, { x: 3, y: 4 }), /10 pixels/)
  assert.throws(() => rulerCorrection({ x: NaN, y: 0 }, { x: 20, y: 0 }), /10 pixels/)
})
