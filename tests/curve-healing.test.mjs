import { test } from 'node:test'
import assert from 'node:assert/strict'
import { proposeBrushedHealing, proposeCurveHealing, snapToCurve } from '../src/lib/curve-healing.ts'

function layer() {
  const width = 140, height = 80
  const data = new Uint8ClampedArray(width * height * 4)
  for (let x = 10; x <= 45; x++) data[(40 * width + x) * 4 + 3] = 255
  for (let x = 75; x <= 110; x++) data[(40 * width + x) * 4 + 3] = 255
  return { width, height, data }
}

test('snaps to nearby visible curve ink and rejects distant or erased ink', () => {
  const image = layer()
  assert.deepEqual(snapToCurve(image, { x: 45.5, y: 42 }), { x: 45.5, y: 40.5 })
  assert.equal(snapToCurve(image, { x: 60, y: 10 }), null)
  image.data[(40 * image.width + 45) * 4 + 3] = 0
  assert.notDeepEqual(snapToCurve(image, { x: 45.5, y: 40.5 }), { x: 45.5, y: 40.5 })
})

test('proposes a smooth gap connection snapped to the selected curve ends', () => {
  const image = layer()
  const path = proposeCurveHealing(image, { x: 45.5, y: 40.5 }, { x: 75.5, y: 40.5 })
  assert.deepEqual(path[0], { x: 45.5, y: 40.5 })
  assert.deepEqual(path.at(-1), { x: 75.5, y: 40.5 })
  assert.ok(path.every((point) => Math.abs(point.y - 40.5) < 0.001 && point.x >= 45.5 && point.x <= 75.5))
})

test('follows sloped curve directions in either selection order', () => {
  const width = 140, height = 100
  const data = new Uint8ClampedArray(width * height * 4)
  for (let x = 10; x <= 100; x++) {
    if (x > 40 && x < 70) continue
    const y = Math.round(30 + x / 2)
    data[(y * width + x) * 4 + 3] = 255
  }
  const image = { width, height, data }
  const start = { x: 40.5, y: 50.5 }, end = { x: 70.5, y: 65.5 }
  const path = proposeCurveHealing(image, start, end)
  const reversed = proposeCurveHealing(image, end, start)
  assert.ok(path.every((point) => Math.abs(point.y - (30.25 + point.x / 2)) < 1))
  assert.ok(path.every((point, index) => Math.hypot(point.x - reversed[24 - index].x, point.y - reversed[24 - index].y) < 1e-8))
})

test('rejects missing ink, identical ends and gaps beyond the limit', () => {
  const image = layer()
  assert.throws(() => proposeCurveHealing(image, { x: 45, y: 40 }, { x: 60, y: 5 }), /within 12/)
  assert.throws(() => proposeCurveHealing(image, { x: 45.5, y: 40.5 }, { x: 45.5, y: 40.5 }), /different curve ends/)
  image.data[(40 * image.width + 120) * 4 + 3] = 255
  assert.throws(() => proposeCurveHealing(image, { x: 10.5, y: 40.5 }, { x: 120.5, y: 40.5 }), /at most 100/)
})

test('rejects isolated ink without enough evidence for a tangent', () => {
  const image = layer()
  image.data.fill(0)
  image.data[(40 * image.width + 45) * 4 + 3] = 255
  image.data[(40 * image.width + 75) * 4 + 3] = 255
  assert.throws(() => proposeCurveHealing(image, { x: 45.5, y: 40.5 }, { x: 75.5, y: 40.5 }), /estimate both curve directions/)
})

test('one brushed gap offers three paths without adding unselected ink', () => {
  const image = layer(), mask = new Uint8ClampedArray(image.data.length), halo = new Uint8ClampedArray(image.data.length).fill(255)
  for (let y = 30; y <= 50; y++) for (let x = 50; x <= 70; x++) mask[(y * image.width + x) * 4 + 3] = 255
  const options = proposeBrushedHealing(image, mask, halo)
  assert.equal(options.length, 3)
  for (const path of options) {
    assert.deepEqual(path[0], { x: 45.5, y: 40.5 })
    assert.deepEqual(path.at(-1), { x: 75.5, y: 40.5 })
  }
})

test('brush refuses ambiguous gaps and selections without a gap', () => {
  const image = layer(), mask = new Uint8ClampedArray(image.data.length), halo = new Uint8ClampedArray(image.data.length).fill(255)
  for (let x = 10; x <= 110; x++) if (x <= 45 || x >= 75) image.data[(60 * image.width + x) * 4 + 3] = 255
  for (let y = 30; y <= 70; y++) for (let x = 50; x <= 70; x++) mask[(y * image.width + x) * 4 + 3] = 255
  assert.throws(() => proposeBrushedHealing(image, mask, halo), /More than one gap/)
  mask.fill(0)
  assert.throws(() => proposeBrushedHealing(image, mask, halo), /No clear gap/)
})

test('offers distinct estimates for offset curve fragments', () => {
  const image = layer(), mask = new Uint8ClampedArray(image.data.length), halo = new Uint8ClampedArray(image.data.length).fill(255)
  for (let x = 75; x <= 110; x++) {
    image.data[(40 * image.width + x) * 4 + 3] = 0
    image.data[(48 * image.width + x) * 4 + 3] = 255
  }
  for (let y = 35; y <= 53; y++) for (let x = 50; x <= 70; x++) mask[(y * image.width + x) * 4 + 3] = 255
  const [straight, gentle, curve] = proposeBrushedHealing(image, mask, halo)
  assert.notDeepEqual(straight[6], curve[6])
  assert.ok(Math.abs(gentle[6].y - (straight[6].y + curve[6].y) / 2) < 1e-8)
})

test('accepts thick curve fragments without treating their pixels as separate gaps', () => {
  const width = 500, height = 100
  const image = { width, height, data: new Uint8ClampedArray(width * height * 4) }
  const mask = new Uint8ClampedArray(image.data.length), halo = new Uint8ClampedArray(image.data.length).fill(255)
  for (let y = 48; y <= 51; y++) for (let x = 10; x < 490; x++) {
    if (x >= 210 && x < 240) continue
    image.data[(y * width + x) * 4 + 3] = 255
  }
  for (let y = 40; y <= 60; y++) for (let x = 215; x <= 235; x++) mask[(y * width + x) * 4 + 3] = 255
  assert.equal(proposeBrushedHealing(image, mask, halo).length, 3)
})

test('heals aligned thick horizontal and vertical strokes through their center', () => {
  for (const vertical of [false, true]) {
    const width = 140, height = 140
    const image = { width, height, data: new Uint8ClampedArray(width * height * 4) }
    const mask = new Uint8ClampedArray(image.data.length), halo = new Uint8ClampedArray(image.data.length).fill(255)
    for (let along = 10; along <= 110; along++) for (let across = 48; across <= 51; across++) {
      if (along > 45 && along < 75) continue
      const x = vertical ? across : along, y = vertical ? along : across
      image.data[(y * width + x) * 4 + 3] = 255
    }
    for (let along = 50; along <= 70; along++) for (let across = 40; across <= 60; across++) {
      const x = vertical ? across : along, y = vertical ? along : across
      mask[(y * width + x) * 4 + 3] = 255
    }
    const options = proposeBrushedHealing(image, mask, halo)
    for (const path of options) for (const point of path) {
      assert.ok(Math.abs((vertical ? point.x : point.y) - 50) < 0.05)
    }
  }
})

test('heals aligned sloped strokes along the same straight centerline', () => {
  const width = 140, height = 110
  const image = { width, height, data: new Uint8ClampedArray(width * height * 4) }
  const mask = new Uint8ClampedArray(image.data.length), halo = new Uint8ClampedArray(image.data.length).fill(255)
  for (let x = 10; x <= 110; x++) {
    if (x > 40 && x < 70) continue
    const center = Math.round(30 + x / 2)
    for (let y = center - 1; y <= center + 1; y++) image.data[(y * width + x) * 4 + 3] = 255
  }
  for (let x = 45; x <= 65; x++) for (let y = 45; y <= 75; y++) mask[(y * width + x) * 4 + 3] = 255
  const options = proposeBrushedHealing(image, mask, halo)
  for (const path of options) for (const point of path) {
    assert.ok(Math.abs(point.y - (30.25 + point.x / 2)) < 0.45)
    const start = path[0], end = path.at(-1)
    assert.ok(Math.abs((point.x - start.x) * (end.y - start.y) - (point.y - start.y) * (end.x - start.x)) / Math.hypot(end.x - start.x, end.y - start.y) < 0.1)
  }
})

test('finds facing endpoints instead of the nearer side of a connected curve', () => {
  const width = 140, height = 100
  const image = { width, height, data: new Uint8ClampedArray(width * height * 4) }
  const mask = new Uint8ClampedArray(image.data.length), halo = new Uint8ClampedArray(image.data.length).fill(255)
  const mark = (x, y) => { image.data[(y * width + x) * 4 + 3] = 255 }
  for (let x = 10; x <= 45; x++) mark(x, 50)
  for (let x = 75; x <= 115; x++) mark(x, 50)
  for (let y = 44; y <= 50; y++) mark(115, y)
  for (let x = 55; x <= 115; x++) mark(x, 44)
  for (let y = 34; y <= 44; y++) mark(55, y)
  for (let x = 55; x <= 75; x++) mark(x, 34)
  for (let y = 45; y <= 55; y++) for (let x = 50; x <= 70; x++) mask[(y * width + x) * 4 + 3] = 255
  const path = proposeBrushedHealing(image, mask, halo)[0]
  assert.ok(path.some((point) => Math.hypot(point.x - 45.5, point.y - 50.5) < 1))
  assert.ok(path.some((point) => Math.hypot(point.x - 75.5, point.y - 50.5) < 1))
  assert.ok(path.every((point) => Math.abs(point.y - 50.5) < 0.5))
})

test('rejects multiple plausible endpoints within the same pair of fragments', () => {
  const width = 140, height = 100
  const image = { width, height, data: new Uint8ClampedArray(width * height * 4) }
  const mask = new Uint8ClampedArray(image.data.length), halo = new Uint8ClampedArray(image.data.length).fill(255)
  const mark = (x, y) => { image.data[(y * width + x) * 4 + 3] = 255 }
  for (let x = 10; x <= 45; x++) mark(x, 50)
  for (let x = 75; x <= 110; x++) { mark(x, 45); mark(x, 55) }
  for (let y = 45; y <= 55; y++) mark(110, y)
  for (let x = 50; x <= 70; x++) for (let y = 40; y <= 60; y++) mask[(y * width + x) * 4 + 3] = 255
  assert.throws(() => proposeBrushedHealing(image, mask, halo), /More than one gap/)
})
