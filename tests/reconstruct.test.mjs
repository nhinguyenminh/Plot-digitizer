import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectReconstruction, reconstructImage, reconstructionDimensions, renderReconstruction, renderReconstructionCurveLayer } from '../src/lib/reconstruct.ts'

function image(width, height) {
  const data = new Uint8ClampedArray(width * height * 4).fill(255)
  return {
    width, height, data,
    mark(x, y) {
      const offset = (y * width + x) * 4
      data[offset] = data[offset + 1] = data[offset + 2] = 0
    },
  }
}

test('finds grid, retains a curve and removes isolated marks inside the selected area', () => {
  const plot = image(140, 120)
  for (const y of [20, 60, 100]) for (let x = 10; x <= 130; x++) plot.mark(x, y)
  for (const x of [10, 70, 130]) for (let y = 20; y <= 100; y++) plot.mark(x, y)
  for (let x = 20; x <= 120; x++) plot.mark(x, Math.round(88 - 0.55 * (x - 20)))
  plot.mark(25, 30)
  const result = detectReconstruction(plot, { x: 10, y: 20, width: 120, height: 80 }, { horizontal: [], vertical: [] })
  assert.deepEqual(result.horizontal, [20, 60, 100])
  assert.deepEqual(result.vertical, [10, 70, 130])
  const points = result.curves.flat()
  assert.ok(points.some((point) => Math.hypot(point.x - 45, point.y - 74) < 3))
  assert.ok(!points.some((point) => Math.hypot(point.x - 25, point.y - 30) < 3))
})

test('manual guides replace a nearby detected line and out-of-region guides are ignored', () => {
  const plot = image(100, 100)
  for (let x = 10; x <= 90; x++) plot.mark(x, 50)
  const result = detectReconstruction(plot, { x: 10, y: 10, width: 80, height: 80 }, { horizontal: [51, 95], vertical: [30] })
  assert.deepEqual(result.horizontal, [51])
  assert.deepEqual(result.vertical, [30])
  assert.throws(() => detectReconstruction(plot, { x: 0, y: 0, width: 10, height: 10 }, { horizontal: [], vertical: [] }))
})

test('consecutive guides rebuild regular grid in the selected area and choose axes independently', () => {
  const plot = image(140, 120)
  for (const y of [20, 42, 63, 84, 100]) for (let x = 10; x <= 130; x++) plot.mark(x, y)
  for (const x of [10, 42, 71, 102, 130]) for (let y = 10; y <= 110; y++) plot.mark(x, y)
  const options = { regularGrid: true, axisGuides: { horizontal: 102, vertical: 12 } }
  const result = detectReconstruction(plot, { x: 10, y: 10, width: 120, height: 100 }, { horizontal: [40, 60], vertical: [40, 70] }, options)
  assert.deepEqual(result.horizontal, [20, 40, 60, 80, 102])
  assert.deepEqual(result.vertical, [12, 40, 70, 100, 130])
  assert.equal(result.horizontalAxis, 102)
  assert.equal(result.verticalAxis, 12)
})

test('regular grid rejects inconsistent or duplicate guides and requires a boundary', async () => {
  const plot = image(140, 120)
  const options = { regularGrid: true, axisGuides: { horizontal: null, vertical: null } }
  const region = { x: 10, y: 10, width: 120, height: 100 }
  assert.throws(() => detectReconstruction(plot, region, { horizontal: [20, 40, 70], vertical: [] }, options), /consecutive/)
  assert.throws(() => detectReconstruction(plot, region, { horizontal: [20, 20], vertical: [] }, options), /distinct/)
  assert.throws(() => detectReconstruction(plot, region, { horizontal: [20, 22], vertical: [] }, options), /3 pixels/)
  assert.throws(() => detectReconstruction(plot, region, { horizontal: [20, 130], vertical: [] }, options), /inside/)
  await assert.rejects(reconstructImage('', null, { horizontal: [20, 40], vertical: [] }, [], {}, {}, options), /Select the plot area/)
})

test('preserves a shallow curve immediately beside a grid line', () => {
  const plot = image(140, 120)
  for (let x = 10; x <= 130; x++) plot.mark(x, 60)
  for (let x = 25; x <= 95; x++) plot.mark(x, x < 45 ? 57 : x <= 70 ? 58 : x <= 72 ? 57 : 56)
  const result = detectReconstruction(plot, { x: 10, y: 10, width: 120, height: 100 }, { horizontal: [], vertical: [] })
  assert.ok(result.curves.flat().some((point) => point.x >= 50 && point.x <= 65 && point.y === 58))
})

test('removes straight offset grid remnants without removing a nearby bent curve', () => {
  const plot = image(160, 120)
  for (let x = 10; x <= 150; x++) plot.mark(x, 60)
  for (let x = 85; x <= 120; x++) plot.mark(x, 61)
  for (let x = 20; x <= 70; x++) plot.mark(x, x < 35 ? 56 : x === 35 ? 57 : x <= 54 ? 58 : 57)
  const result = detectReconstruction(plot, { x: 10, y: 10, width: 140, height: 100 }, { horizontal: [], vertical: [] })
  assert.ok(result.curves.flat().some((p) => p.x >= 40 && p.x <= 50 && p.y === 58))
  assert.ok(!result.curves.flat().some((p) => p.x >= 90 && p.x <= 115 && p.y === 61))
})

test('bridges a curve through a grid line without inventing a continuation for an isolated endpoint', () => {
  const plot = image(140, 120)
  for (let y = 10; y <= 110; y++) plot.mark(70, y)
  for (let x = 15; x <= 125; x++) plot.mark(x, Math.round(30 + 0.2 * (x - 15)))
  for (let x = 35; x <= 69; x++) plot.mark(x, 80)
  const result = detectReconstruction(plot, { x: 10, y: 10, width: 120, height: 100 }, { horizontal: [], vertical: [] })
  assert.ok(result.curves.some((path) => path.some((point) => point.x < 70 && point.y < 60) && path.some((point) => point.x > 70 && point.y < 60)))
  assert.ok(!result.curves.some((path) => path.some((point) => point.x < 70 && point.y === 80) && path.some((point) => point.x > 70 && point.y === 80)))
})

test('bridges nearby curves across a horizontal grid without swapping them', () => {
  const plot = image(160, 120)
  for (let x = 10; x <= 150; x++) plot.mark(x, 60)
  for (let x = 20; x <= 130; x++) {
    plot.mark(x, Math.round(90 - 0.5 * (x - 20)))
    plot.mark(x, Math.round(94 - 0.5 * (x - 20)))
  }
  const result = detectReconstruction(plot, { x: 10, y: 10, width: 140, height: 100 }, { horizontal: [], vertical: [] })
  const bridges = result.curves.filter((path) => path.length === 2 && path[0].y < 60 && path[1].y > 60)
  assert.equal(bridges.length, 2)
  for (const [a, b] of bridges) assert.ok(Math.abs((b.x - a.x) + 2 * (b.y - a.y)) <= 2)
})

test('reconnects a curve that touches and follows a horizontal grid line', () => {
  const plot = image(160, 120)
  for (let x = 10; x <= 150; x++) plot.mark(x, 60)
  for (let x = 20; x <= 140; x++) plot.mark(x, 60 - Math.min(8, Math.floor(Math.abs(x - 80) / 4)))
  const result = detectReconstruction(plot, { x: 10, y: 10, width: 140, height: 100 }, { horizontal: [], vertical: [] })
  assert.ok(result.curves.some((path) => path.some((p) => p.x < 77 && p.y < 60) && path.some((p) => p.x > 83 && p.y < 60) && path.some((p) => Math.abs(p.x - 80) <= 2 && p.y >= 59.5)))
  assert.ok(result.estimatedCurves.some((index) => result.curves[index].length > 2))
})

test('reconnects compatible curve endpoints slightly away from a grid line', () => {
  const plot = image(160, 120)
  for (let y = 10; y <= 110; y++) plot.mark(70, y)
  for (let x = 20; x <= 130; x++) if (x < 67 || x > 74) plot.mark(x, Math.round(30 + 0.2 * (x - 20)))
  const result = detectReconstruction(plot, { x: 10, y: 10, width: 140, height: 100 }, { horizontal: [], vertical: [] })
  assert.ok(result.curves.some((path) => path.some((p) => p.x <= 66 && p.y < 60) && path.some((p) => p.x >= 75 && p.y < 60)))
})

test('bridges across a thick grid line and leaves ambiguous continuations unconnected', () => {
  const plot = image(160, 120)
  for (let x = 68; x <= 71; x++) for (let y = 10; y <= 110; y++) plot.mark(x, y)
  for (let x = 20; x <= 130; x++) plot.mark(x, Math.round(25 + 0.5 * (x - 20)))
  for (let x = 40; x <= 67; x++) plot.mark(x, 90)
  for (let x = 72; x <= 99; x++) { plot.mark(x, 89); plot.mark(x, 91) }
  const result = detectReconstruction(plot, { x: 10, y: 10, width: 140, height: 100 }, { horizontal: [], vertical: [] })
  assert.ok(result.curves.some((path) => path.length === 2 && path[0].x < 68 && path[1].x > 71 && path[0].y < 70))
  assert.ok(!result.curves.some((path) => path.length === 2 && path[0].x < 68 && path[1].x > 71 && path[0].y >= 88))
})

test('uses separate grid and curve widths for detected and drawn lines', () => {
  const strokes = []
  const previous = globalThis.document
  let layer = 0
  globalThis.document = { createElement: () => {
    const id = layer++
    const context = {
      fillRect() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, moveTo() {}, lineTo() {}, drawImage() {},
      stroke() { strokes.push({ layer: id, color: this.strokeStyle, width: this.lineWidth }) },
    }
    return { getContext: () => context, toDataURL: () => 'image' }
  } }
  try {
    renderReconstruction(
      { width: 100, height: 100, region: { x: 0, y: 0, width: 99, height: 99 }, horizontal: [10, 20], vertical: [20], horizontalAxis: 10, verticalAxis: 20, curves: [[{ x: 10, y: 20 }, { x: 40, y: 30 }]] },
      [{ points: [{ x: 30, y: 30 }, { x: 40, y: 40 }], erase: false }],
      { curve: '#f00', grid: '#000', axis: '#00f' }, { curve: 3, grid: 0.5 },
    )
    assert.deepEqual(strokes.map((stroke) => stroke.width), [0.5, 0.5, 0.5, 3, 3])
    assert.deepEqual(strokes.map((stroke) => stroke.color), ['#00f', '#000', '#00f', '#f00', '#f00'])
    assert.deepEqual(strokes.map((stroke) => stroke.layer), [1, 1, 1, 2, 2])
  } finally {
    if (previous === undefined) delete globalThis.document
    else globalThis.document = previous
  }
})

test('preserves each erasure width and replays legacy erasures on both layers', () => {
  const marks = []
  const previous = globalThis.document
  let layer = 0
  globalThis.document = { createElement: () => {
    const id = layer++
    const context = {
      fillRect() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, moveTo() {}, lineTo() {}, drawImage() {},
      arc(_x, _y, radius) { this.radius = radius },
      stroke() { marks.push({ layer: id, operation: this.globalCompositeOperation, width: this.lineWidth }) },
      fill() { marks.push({ layer: id, operation: this.globalCompositeOperation, width: this.radius * 2 }) },
    }
    return { getContext: () => context, toDataURL: () => 'image' }
  } }
  try {
    const point = { x: 50, y: 50 }
    renderReconstruction(
      { width: 100, height: 100, region: { x: 0, y: 0, width: 99, height: 99 }, horizontal: [], vertical: [], curves: [] },
      [{ points: [point], erase: true, layer: 'curve', width: 4 }, { points: [point, { x: 55, y: 50 }], erase: true, layer: 'grid', width: 24 }, { points: [point], erase: true }],
      { curve: '#0066ff', grid: '#000000', axis: '#000000' }, { curve: 1, grid: 1 },
    )
    assert.deepEqual(marks, [2, 1, 1, 2].map((id, index) => ({ layer: id, operation: 'destination-out', width: [4, 24, 12, 12][index] })))
  } finally {
    if (previous === undefined) delete globalThis.document
    else globalThis.document = previous
  }
})

test('isolated curve layer includes curve edits and erasures but excludes grid marks', () => {
  const previous = globalThis.document
  const layers = []
  globalThis.document = { createElement: () => {
    const strokes = []
    const context = {
      save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, moveTo() {}, lineTo() {}, arc() {},
      stroke() { strokes.push({ operation: this.globalCompositeOperation, color: this.strokeStyle, width: this.lineWidth }) },
      fill() { strokes.push({ operation: this.globalCompositeOperation, color: this.strokeStyle, width: this.lineWidth }) },
    }
    const canvas = { getContext: () => context, strokes }
    layers.push(canvas)
    return canvas
  } }
  try {
    const point = { x: 10, y: 20 }
    const layer = renderReconstructionCurveLayer(
      { width: 100, height: 100, region: { x: 0, y: 0, width: 99, height: 99 }, horizontal: [20], vertical: [30], curves: [[point, { x: 50, y: 20 }]] },
      [{ points: [point, { x: 20, y: 25 }], erase: false, layer: 'curve' }, { points: [point], erase: true, layer: 'curve', width: 6 }, { points: [point, { x: 20, y: 20 }], erase: false, layer: 'grid' }],
      { curve: 2, grid: 3 },
    )
    assert.equal(layer, layers[1])
    assert.equal(layers[0].strokes.length, 3)
    assert.deepEqual(layer.strokes, [
      { operation: undefined, color: '#0066ff', width: 2 },
      { operation: 'source-over', color: '#0066ff', width: 2 },
      { operation: 'destination-out', color: '#0066ff', width: 6 },
    ])
  } finally {
    if (previous === undefined) delete globalThis.document
    else globalThis.document = previous
  }
})

test('upscale presets retain proportions, never shrink, and respect the memory limit', () => {
  const setting = (preset, longEdge = 1600) => ({ preset, longEdge })
  assert.deepEqual(reconstructionDimensions(640, 480, setting('hd')), { width: 1280, height: 960 })
  assert.deepEqual(reconstructionDimensions(400, 800, setting('fullhd')), { width: 1920, height: 3840 })
  assert.deepEqual(reconstructionDimensions(640, 480, setting('custom')), { width: 1600, height: 1200 })
  assert.deepEqual(reconstructionDimensions(2000, 1500, setting('hd')), { width: 2000, height: 1500 })
  assert.throws(() => reconstructionDimensions(10000, 100, setting('hd')), /16 megapixels/)
})

test('renders enlarged geometry and retains individual drawn stroke widths', () => {
  const previous = globalThis.document
  const canvases = []
  globalThis.document = { createElement: () => {
    const strokes = [], scales = []
    const context = {
      fillRect() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, moveTo() {}, lineTo() {}, drawImage() {},
      scale(x, y) { scales.push([x, y]) },
      stroke() { strokes.push(this.lineWidth) },
    }
    const canvas = { getContext: () => context, toDataURL: () => 'image', strokes, scales }
    canvases.push(canvas)
    return canvas
  } }
  try {
    const point = { x: 10, y: 10 }, end = { x: 20, y: 20 }
    renderReconstruction(
      { width: 100, height: 50, region: { x: 0, y: 0, width: 99, height: 49 }, horizontal: [], vertical: [], curves: [] },
      [{ points: [point, end], erase: false, layer: 'curve', width: 0.5 }, { points: [point, end], erase: false, layer: 'curve', width: 4 }, { points: [point, end], erase: false, layer: 'curve' }],
      { curve: '#0066ff', grid: '#000000', axis: '#000000' }, { curve: 2, grid: 1 }, { width: 200, height: 100 },
    )
    assert.deepEqual([canvases[0].width, canvases[0].height], [200, 100])
    assert.deepEqual(canvases[2].scales, [[2, 2]])
    assert.deepEqual(canvases[2].strokes, [0.5, 4, 2])
  } finally {
    if (previous === undefined) delete globalThis.document
    else globalThis.document = previous
  }
})

test('renders pixel-step curves with bounded smoothing and preserves endpoints as PNG', () => {
  const previous = globalThis.document
  const layers = []
  let mime
  globalThis.document = { createElement: () => {
    const points = []
    const context = {
      fillRect() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, drawImage() {}, stroke() {},
      moveTo(x, y) { points.push({ x, y }) }, lineTo(x, y) { points.push({ x, y }) },
    }
    const canvas = { getContext: () => context, toDataURL: (type) => { mime = type; return 'image' }, points }
    layers.push(canvas)
    return canvas
  } }
  try {
    const path = [{ x: 10, y: 10 }, { x: 11, y: 10 }, { x: 12, y: 11 }, { x: 13, y: 11 }, { x: 14, y: 12 }]
    renderReconstruction(
      { width: 30, height: 30, region: { x: 0, y: 0, width: 29, height: 29 }, horizontal: [], vertical: [], curves: [path] },
      [], { curve: '#0066ff', grid: '#000000', axis: '#000000' }, { curve: 1, grid: 1 },
    )
    const rendered = layers[2].points
    assert.equal(mime, 'image/png')
    assert.deepEqual(rendered[0], path[0])
    assert.deepEqual(rendered.at(-1), path.at(-1))
    assert.ok(rendered.some((point, index) => point.y !== path[index].y))
    assert.ok(rendered.every((point, index) => Math.hypot(point.x - path[index].x, point.y - path[index].y) <= 0.5))
  } finally {
    if (previous === undefined) delete globalThis.document
    else globalThis.document = previous
  }
})

test('reduces pixel stair-steps without shifting the detected path by more than half a source pixel', () => {
  const previous = globalThis.document
  const layers = []
  globalThis.document = { createElement: () => {
    const points = []
    const context = {
      fillRect() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, drawImage() {}, stroke() {},
      moveTo(x, y) { points.push({ x, y }) }, lineTo(x, y) { points.push({ x, y }) },
    }
    const canvas = { getContext: () => context, toDataURL: () => 'image', points }
    layers.push(canvas)
    return canvas
  } }
  try {
    const path = Array.from({ length: 120 }, (_, x) => ({ x, y: Math.round(30 + 0.37 * x) }))
    renderReconstruction(
      { width: 140, height: 100, region: { x: 0, y: 0, width: 139, height: 99 }, horizontal: [], vertical: [], curves: [path] },
      [], { curve: '#0066ff', grid: '#000000', axis: '#000000' }, { curve: 1, grid: 1 },
    )
    const result = layers[2].points
    const roughness = (points) => points.slice(4, -4).reduce((sum, point, offset) => {
      const index = offset + 4
      return sum + (points[index + 1].y - 2 * point.y + points[index - 1].y) ** 2
    }, 0)
    const old = path.map((point, index) => index === 0 || index === path.length - 1 ? point : {
      x: (path[index - 1].x + 2 * point.x + path[index + 1].x) / 4,
      y: (path[index - 1].y + 2 * point.y + path[index + 1].y) / 4,
    })
    const rms = Math.sqrt(result.slice(4, -4).reduce((sum, point) => sum + (point.y - (30 + 0.37 * point.x)) ** 2, 0) / (result.length - 8))
    assert.ok(roughness(result) < roughness(old) * 0.2)
    assert.ok(rms < 0.08)
    assert.ok(result.every((point, index) => Math.hypot(point.x - path[index].x, point.y - path[index].y) <= 0.5 + 1e-9))
    assert.deepEqual(result[0], path[0])
    assert.deepEqual(result.at(-1), path.at(-1))
  } finally {
    if (previous === undefined) delete globalThis.document
    else globalThis.document = previous
  }
})

test('keeps estimated bridges and short paths unchanged when rendering', () => {
  const previous = globalThis.document
  const strokes = []
  globalThis.document = { createElement: () => {
    let points = []
    const context = {
      fillRect() {}, save() {}, restore() {}, rect() {}, clip() {}, drawImage() {},
      beginPath() { points = [] }, moveTo(x, y) { points.push({ x, y }) }, lineTo(x, y) { points.push({ x, y }) },
      stroke() { strokes.push(points) },
    }
    return { getContext: () => context, toDataURL: () => 'image' }
  } }
  try {
    const bridge = [{ x: 1, y: 1 }, { x: 1.5, y: 1.3 }, { x: 2, y: 1.8 }, { x: 2.5, y: 2.4 }, { x: 3, y: 3 }]
    const short = [{ x: 8, y: 8 }, { x: 9, y: 8 }, { x: 10, y: 9 }]
    const integerBridge = [{ x: 15, y: 15 }, { x: 16, y: 15 }, { x: 17, y: 16 }, { x: 18, y: 16 }, { x: 19, y: 17 }]
    renderReconstruction(
      { width: 30, height: 30, region: { x: 0, y: 0, width: 29, height: 29 }, horizontal: [], vertical: [], curves: [bridge, short, integerBridge], estimatedCurves: [0, 2] },
      [], { curve: '#0066ff', grid: '#000000', axis: '#000000' }, { curve: 1, grid: 1 },
    )
    assert.deepEqual(strokes, [bridge, short, integerBridge])
  } finally {
    if (previous === undefined) delete globalThis.document
    else globalThis.document = previous
  }
})
