import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractBrushCurves, extractBrushGroups, extractPaintedCurves } from '../src/lib/painted-region.ts'

test('one brush group can create multiple datasets independently of an overlapping group', () => {
  const { image, mask } = fixture()
  const green = new Uint8ClampedArray(mask.length)
  for (let x = 10; x < 90; x++) {
    mask[(30 * image.width + x) * 4 + 3] = 0
    for (let y = 37; y <= 43; y++) green[(y * image.width + x) * 4 + 3] = 255
  }
  const result = extractBrushGroups(image, [{ name: 'Red', mask }, { name: 'Green', mask: green }], 20, 76, [0, 102, 255])
  assert.equal(result.curves.filter((curve) => curve.group === 'Red').length, 2)
  assert.equal(result.curves.filter((curve) => curve.group === 'Green').length, 1)
  assert.equal(result.curves.find((curve) => curve.group === 'Green').points[0].y, 40)
})

test('overlapping brush groups are extracted independently and report empty groups', () => {
  const width = 100, height = 60
  const data = new Uint8ClampedArray(width * height * 4).fill(255)
  const red = new Uint8ClampedArray(data.length), green = new Uint8ClampedArray(data.length)
  for (let x = 10; x < 90; x++) {
    const crossingY = 10 + Math.round((x - 10) / 2)
    for (const y of [30, crossingY]) {
      const offset = (y * width + x) * 4
      data[offset] = 0; data[offset + 1] = 102; data[offset + 2] = 255
    }
    for (let dy = -2; dy <= 2; dy++) {
      red[((30 + dy) * width + x) * 4 + 3] = 255
      green[((crossingY + dy) * width + x) * 4 + 3] = 255
    }
  }
  const result = extractBrushGroups({ width, height, data }, [
    { name: 'Red', color: '#f00', mask: red },
    { name: 'Green', color: '#0f0', mask: green },
    { name: 'Empty', color: '#00f', mask: new Uint8ClampedArray(data.length) },
  ], 10, 76, [0, 102, 255])
  for (const group of ['Red', 'Green']) {
    assert.ok(result.curves.some((curve) => curve.group === group && curve.points[0].x === 10 && curve.points.at(-1).x === 89))
  }
  const horizontal = result.curves.find((curve) => curve.group === 'Red' && curve.points[0].x === 10 && curve.points.at(-1).x === 89)
  const diagonal = result.curves.find((curve) => curve.group === 'Green' && curve.points[0].x === 10 && curve.points.at(-1).x === 89)
  assert.ok(horizontal.points.every((point) => Math.abs(point.y - 30) <= 2))
  assert.ok(diagonal.points.every((point) => Math.abs(point.y - (10 + (point.x - 10) / 2)) <= 2))
  assert.ok(result.warnings.some((warning) => /Empty:.*empty/.test(warning)))
})

function fixture() {
  const width = 100
  const height = 60
  const data = new Uint8ClampedArray(width * height * 4).fill(255)
  const mask = new Uint8ClampedArray(width * height * 4)
  for (let x = 10; x < 90; x++) {
    for (const y of [20, 40]) {
      const offset = (y * width + x) * 4
      data[offset] = 0; data[offset + 1] = 102; data[offset + 2] = 255
      for (let dy = -3; dy <= 3; dy++) mask[((y + dy) * width + x) * 4 + 3] = 255
    }
    const grid = (30 * width + x) * 4
    data[grid] = 0; data[grid + 1] = 0; data[grid + 2] = 0
    mask[grid + 3] = 255
  }
  return { image: { width, height, data }, mask }
}

test('extracts multiple painted curves without treating the black grid as a curve', () => {
  const { image, mask } = fixture()
  const curves = extractPaintedCurves(image, mask, 8, 76, [0, 102, 255])
  assert.equal(curves.length, 2)
  assert.deepEqual(curves.map((curve) => curve[0].y).sort((a, b) => a - b), [20, 40])
  assert.ok(curves.every((curve) => curve[0].x === 10 && curve.at(-1).x === 89))
})

test('erased selection cannot be bridged and unselected curves are excluded', () => {
  const { image, mask } = fixture()
  for (let x = 45; x <= 50; x++) {
    for (let y = 17; y <= 23; y++) mask[(y * image.width + x) * 4 + 3] = 0
  }
  for (let x = 0; x < image.width; x++) {
    for (let y = 37; y <= 43; y++) mask[(y * image.width + x) * 4 + 3] = 0
  }
  const curves = extractPaintedCurves(image, mask, 8, 76, [0, 102, 255])
  assert.equal(curves.length, 2)
  assert.ok(curves.every((curve) => curve.every((point) => point.y === 20)))
  assert.ok(curves.some((curve) => curve[0].x === 10 && curve.at(-1).x === 44))
  assert.ok(curves.some((curve) => curve[0].x === 51 && curve.at(-1).x === 89))
})

test('joins compatible fragments across a selected gap without swapping adjacent curves', () => {
  const { image, mask } = fixture()
  for (let x = 43; x <= 52; x++) {
    for (const y of [20, 40]) {
      const offset = (y * image.width + x) * 4
      image.data[offset] = 255; image.data[offset + 1] = 255; image.data[offset + 2] = 255
    }
  }
  const curves = extractPaintedCurves(image, mask, 8, 76, [0, 102, 255])
  assert.equal(curves.length, 2)
  assert.ok(curves.every((curve) => curve[0].x === 10 && curve.at(-1).x === 89))
  assert.ok(curves.every((curve) => curve.every((point) => point.y === curve[0].y)))
})

test('joins a shallow curve across a gap despite pixel jitter at its endpoints', () => {
  const width = 120, height = 80
  const data = new Uint8ClampedArray(width * height * 4).fill(255)
  const mask = new Uint8ClampedArray(width * height * 4)
  for (let x = 10; x <= 100; x++) {
    for (let y = 20; y <= 45; y++) mask[(y * width + x) * 4 + 3] = 255
    if (x >= 43 && x <= 52) continue
    let y = 30
    if (x >= 37 && x <= 42) y = 30 + Math.round((x - 36) / 2)
    if (x >= 53 && x <= 58) y = 33 - Math.round((x - 52) / 2)
    const offset = (y * width + x) * 4
    data[offset] = 0; data[offset + 1] = 102; data[offset + 2] = 255
  }
  const curves = extractPaintedCurves({ width, height, data }, mask, 16, 76, [0, 102, 255])
  assert.equal(curves.length, 1)
  assert.equal(curves[0][0].x, 10)
  assert.equal(curves[0].at(-1).x, 100)
})

test('rejects a curve color indistinguishable from the white background', () => {
  const { image, mask } = fixture()
  assert.throws(() => extractPaintedCurves(image, mask, 8, 76, [255, 255, 255]), /background/)
})

test('one continuous brush region joins a compatible long gap', () => {
  const { image, mask } = fixture()
  for (let x = 0; x < image.width; x++) {
    mask[(30 * image.width + x) * 4 + 3] = 0
    for (let y = 37; y <= 43; y++) mask[(y * image.width + x) * 4 + 3] = 0
  }
  for (let x = 30; x <= 65; x++) {
    const offset = (20 * image.width + x) * 4
    image.data[offset] = image.data[offset + 1] = image.data[offset + 2] = 255
  }
  const { curves } = extractBrushCurves(image, mask, 20, 76, [0, 102, 255])
  assert.equal(curves.length, 1)
  assert.equal(curves[0][0].x, 10)
  assert.equal(curves[0].at(-1).x, 89)
})

test('separate and erased brush regions produce separate curves', () => {
  const { image, mask } = fixture()
  for (let x = 0; x < image.width; x++) mask[(30 * image.width + x) * 4 + 3] = 0
  for (let x = 45; x <= 50; x++) for (let y = 17; y <= 23; y++) mask[(y * image.width + x) * 4 + 3] = 0
  const { curves } = extractBrushCurves(image, mask, 20, 76, [0, 102, 255])
  assert.equal(curves.length, 3)
  assert.ok(curves.every((curve) => !curve.some((point) => point.y === 20 && point.x > 44 && point.x < 51)))
  assert.ok(curves.some((curve) => curve[0].y === 20 && curve.at(-1).x === 44))
  assert.ok(curves.some((curve) => curve[0].y === 20 && curve[0].x === 51))
})

test('touching regions with overlapping curves return separate candidates and warn', () => {
  const { image, mask } = fixture()
  for (let y = 20; y <= 40; y++) mask[(y * image.width + 20) * 4 + 3] = 255
  const { curves, warnings } = extractBrushCurves(image, mask, 20, 76, [0, 102, 255])
  assert.equal(curves.length, 2)
  assert.ok(warnings.some((warning) => /separate candidates/.test(warning)))
  assert.deepEqual(curves.map((curve) => curve[0].y).sort((a, b) => a - b), [20, 40])
})

test('empty selections and regions without curve ink report errors', () => {
  const { image, mask } = fixture()
  mask.fill(0)
  assert.throws(() => extractBrushCurves(image, mask, 20, 76, [0, 102, 255]), /empty/)
  for (let x = 10; x < 20; x++) mask[(5 * image.width + x) * 4 + 3] = 255
  assert.throws(() => extractBrushCurves(image, mask, 20, 76, [0, 102, 255]), /no detectable curve/)
})

test('four separate painted regions create four curves', () => {
  const width = 140, height = 100
  const data = new Uint8ClampedArray(width * height * 4).fill(255)
  const mask = new Uint8ClampedArray(data.length)
  for (const base of [15, 35, 55, 75]) for (let x = 10; x < 130; x++) {
    const y = base + Math.round((x - 10) ** 2 / 5000)
    const offset = (y * width + x) * 4
    data[offset] = 0; data[offset + 1] = 102; data[offset + 2] = 255
    for (let dy = -3; dy <= 3; dy++) mask[((y + dy) * width + x) * 4 + 3] = 255
  }
  const { curves } = extractBrushCurves({ width, height, data }, mask, 20, 76, [0, 102, 255])
  assert.equal(curves.length, 4)
  assert.deepEqual(curves.map((curve) => Math.round(curve[0].y)).sort((a, b) => a - b), [15, 35, 55, 75])
})

test('larger spacing reduces points while retaining a substantial bend', () => {
  const width = 200, height = 80
  const data = new Uint8ClampedArray(width * height * 4).fill(255)
  const mask = new Uint8ClampedArray(data.length)
  for (let x = 10; x < 190; x++) {
    const y = 20 + Math.round((x - 10) ** 2 / 1000)
    const offset = (y * width + x) * 4
    data[offset] = 0; data[offset + 1] = 102; data[offset + 2] = 255
    for (let dy = -3; dy <= 3; dy++) mask[((y + dy) * width + x) * 4 + 3] = 255
  }
  const dense = extractBrushCurves({ width, height, data }, mask, 8, 76, [0, 102, 255]).curves[0]
  const sparse = extractBrushCurves({ width, height, data }, mask, 20, 76, [0, 102, 255]).curves[0]
  assert.ok(sparse.length < dense.length)
  assert.ok(sparse.some((point) => point.x > 60 && point.x < 140))
  assert.equal(sparse[0].x, 10)
  assert.equal(sparse.at(-1).x, 189)
})

test('returns two painted curves even when one has a very long gap and isolated ink', () => {
  const width = 220, height = 80
  const data = new Uint8ClampedArray(width * height * 4).fill(255)
  const mask = new Uint8ClampedArray(data.length)
  for (let x = 10; x < 210; x++) for (const y of [20, 55]) {
    for (let dy = -4; dy <= 4; dy++) mask[((y + dy) * width + x) * 4 + 3] = 255
    if (y === 20 && x >= 50 && x <= 145 && x !== 95) continue
    const offset = (y * width + x) * 4
    data[offset] = 0; data[offset + 1] = 102; data[offset + 2] = 255
  }
  const { curves, warnings } = extractBrushCurves({ width, height, data }, mask, 20, 76, [0, 102, 255])
  assert.equal(curves.length, 2)
  const broken = curves.find((curve) => curve[0].y === 20)
  assert.equal(broken[0].x, 10)
  assert.equal(broken.at(-1).x, 209)
  assert.ok(broken.some((point) => point.x === 95))
  assert.ok(warnings.some((warning) => /fragments/.test(warning)))
})

test('does not connect fragments through an erased hole inside a connected selection', () => {
  const width = 140, height = 60
  const data = new Uint8ClampedArray(width * height * 4).fill(255)
  const mask = new Uint8ClampedArray(data.length)
  for (let x = 10; x < 130; x++) {
    for (let y = 10; y <= 30; y++) mask[(y * width + x) * 4 + 3] = 255
    if (x >= 55 && x <= 70) continue
    const offset = (20 * width + x) * 4
    data[offset] = 0; data[offset + 1] = 102; data[offset + 2] = 255
  }
  for (let x = 55; x <= 70; x++) for (let y = 17; y <= 30; y++) mask[(y * width + x) * 4 + 3] = 0
  const { curves, warnings } = extractBrushCurves({ width, height, data }, mask, 20, 76, [0, 102, 255])
  assert.equal(curves.length, 2)
  assert.ok(warnings.some((warning) => /separate candidates/.test(warning)))
})

test('returns detected regions and warns about a separate region with no ink', () => {
  const { image, mask } = fixture()
  for (let x = 0; x < image.width; x++) {
    mask[(30 * image.width + x) * 4 + 3] = 0
    for (let y = 37; y <= 43; y++) mask[(y * image.width + x) * 4 + 3] = 0
  }
  for (let x = 10; x < 20; x++) mask[(5 * image.width + x) * 4 + 3] = 255
  const { curves, warnings } = extractBrushCurves(image, mask, 20, 76, [0, 102, 255])
  assert.equal(curves.length, 1)
  assert.ok(warnings.some((warning) => /no detectable curve/.test(warning)))
})

test('isolated curve layer follows translucent antialiased ink without color matching', () => {
  const width = 140, height = 50
  const data = new Uint8ClampedArray(width * height * 4)
  const mask = new Uint8ClampedArray(data.length)
  for (let x = 10; x < 130; x++) {
    for (let y = 16; y <= 25; y++) mask[(y * width + x) * 4 + 3] = 255
    for (const [y, alpha] of [[20, 45], [21, 95]]) {
      const offset = (y * width + x) * 4
      data[offset] = 190; data[offset + 1] = 30; data[offset + 2] = 40; data[offset + 3] = alpha
    }
  }
  const { curves, warnings } = extractBrushCurves({ width, height, data }, mask, 20, 12, [0, 102, 255], true)
  assert.equal(curves.length, 1)
  assert.equal(curves[0][0].x, 10)
  assert.equal(curves[0].at(-1).x, 129)
  assert.ok(curves[0].every((point) => Math.abs(point.y - (20.5 + 95 / 140)) < 0.01))
  assert.deepEqual(warnings, [])
})

test('isolated layer still keeps genuinely separate overlapping curves apart', () => {
  const width = 100, height = 50
  const data = new Uint8ClampedArray(width * height * 4)
  const mask = new Uint8ClampedArray(data.length)
  for (let x = 10; x < 90; x++) for (let y = 10; y <= 30; y++) mask[(y * width + x) * 4 + 3] = 255
  for (let x = 10; x < 90; x++) for (const y of [15, 25]) data[(y * width + x) * 4 + 3] = 90
  const { curves, warnings } = extractBrushCurves({ width, height, data }, mask, 20, 12, [0, 102, 255], true)
  assert.equal(curves.length, 2)
  assert.ok(warnings.some((warning) => /separate candidates/.test(warning)))
})

test('excludes a short overlapping branch of a long curve with an explicit warning', () => {
  const width = 200, height = 60
  const data = new Uint8ClampedArray(width * height * 4)
  const mask = new Uint8ClampedArray(data.length)
  for (let x = 10; x < 190; x++) for (let y = 20; y <= 45; y++) mask[(y * width + x) * 4 + 3] = 255
  for (let x = 20; x <= 180; x++) data[(30 * width + x) * 4 + 3] = 255
  for (let x = 10; x <= 26; x++) data[(Math.round(40 - (x - 10) * 0.55) * width + x) * 4 + 3] = 255
  const { curves, warnings } = extractBrushCurves({ width, height, data }, mask, 20, 76, [0, 102, 255], true)
  assert.equal(curves.length, 1)
  assert.equal(curves[0][0].x, 20)
  assert.equal(curves[0].at(-1).x, 180)
  assert.ok(warnings.some((warning) => /short overlapping mark was excluded/.test(warning)))
})

test('preserves a short but spatially distinct curve in the same selection', () => {
  const width = 200, height = 60
  const data = new Uint8ClampedArray(width * height * 4)
  const mask = new Uint8ClampedArray(data.length)
  for (let x = 10; x < 190; x++) for (let y = 10; y <= 40; y++) mask[(y * width + x) * 4 + 3] = 255
  for (let x = 20; x <= 180; x++) data[(30 * width + x) * 4 + 3] = 255
  for (let x = 60; x <= 75; x++) data[(15 * width + x) * 4 + 3] = 255
  const { curves, warnings } = extractBrushCurves({ width, height, data }, mask, 20, 76, [0, 102, 255], true)
  assert.equal(curves.length, 2)
  assert.ok(warnings.some((warning) => /separate candidates/.test(warning)))
})
