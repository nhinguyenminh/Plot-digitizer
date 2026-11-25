import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectReconstruction } from '../src/lib/reconstruct.ts'
import { smartExtractCurvesFromLayer, smartSampleCurvePoints } from '../src/lib/smart-extract.ts'

function createRgba(width, height, fill = [255, 255, 255, 255]) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let index = 0; index < width * height; index++) {
    const offset = index * 4
    data[offset] = fill[0]; data[offset + 1] = fill[1]; data[offset + 2] = fill[2]; data[offset + 3] = fill[3]
  }
  return { width, height, data }
}

function drawStroke(image, x0, y0, x1, y1, rgba, thickness = 1) {
  const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2))
  const r = Math.floor(thickness / 2)
  for (let i = 0; i <= steps; i++) {
    const cx = Math.round(x0 + (x1 - x0) * (i / steps))
    const cy = Math.round(y0 + (y1 - y0) * (i / steps))
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const x = cx + dx, y = cy + dy
      if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue
      const offset = (y * image.width + x) * 4
      image.data[offset] = rgba[0]
      image.data[offset + 1] = rgba[1]
      image.data[offset + 2] = rgba[2]
      image.data[offset + 3] = rgba[3]
    }
  }
}

test('detectReconstruction preserves colored curves intact across neutral grids and handles gray scans', () => {
  // Grayish scan paper (218, 218, 218)
  const plot = createRgba(160, 120, [218, 218, 218, 255])
  // Neutral dark gray grid lines
  for (const y of [20, 60, 100]) drawStroke(plot, 10, y, 150, y, [40, 40, 40, 255], 1)
  for (const x of [10, 80, 150]) drawStroke(plot, x, 20, x, 100, [40, 40, 40, 255], 1)
  // Blue colored curve crossing right through both horizontal y=60 and vertical x=80 grid lines
  drawStroke(plot, 18, 92, 142, 28, [10, 85, 240, 255], 2)

  const result = detectReconstruction(plot, { x: 10, y: 20, width: 140, height: 80 }, { horizontal: [], vertical: [] })
  assert.deepEqual(result.horizontal, [20, 60, 100])
  assert.deepEqual(result.vertical, [10, 80, 150])
  // The blue curve should remain present right at the grid intersection (x≈80, y≈60) without a gap!
  const curvePoints = result.curves.flat()
  assert.ok(curvePoints.some((pt) => Math.hypot(pt.x - 80, pt.y - 60) < 3), 'colored curve should pass cleanly through grid intersection')
})

test('detectReconstruction prefers a thicker primary axis over a faint outer frame border', () => {
  const plot = createRgba(160, 140, [255, 255, 255, 255])
  // Faint 1px outer frame at y=130 and x=10
  drawStroke(plot, 10, 130, 150, 130, [140, 140, 140, 255], 1)
  drawStroke(plot, 10, 10, 10, 130, [140, 140, 140, 255], 1)
  // Bold 3px primary axes at y=110 and x=28 + top grid at y=20, right grid at x=140
  drawStroke(plot, 10, 110, 150, 110, [0, 0, 0, 255], 3)
  drawStroke(plot, 28, 10, 28, 130, [0, 0, 0, 255], 3)
  drawStroke(plot, 10, 20, 150, 20, [120, 120, 120, 255], 1)
  drawStroke(plot, 140, 10, 140, 130, [120, 120, 120, 255], 1)

  const result = detectReconstruction(plot, { x: 10, y: 10, width: 140, height: 120 }, { horizontal: [], vertical: [] })
  assert.equal(result.horizontalAxis, 110)
  assert.equal(result.verticalAxis, 28)
})

test('smartSampleCurvePoints locks peaks, spaces straight lines evenly, and clusters denser on bends', () => {
  // Straight horizontal line of length 100
  const straight = Array.from({ length: 101 }, (_, x) => ({ x, y: 50 }))
  const straightSampled = smartSampleCurvePoints(straight, { spacing: 25 })
  assert.equal(straightSampled.length, 5)
  for (let i = 1; i < straightSampled.length; i++) {
    const gap = Math.hypot(straightSampled[i].x - straightSampled[i - 1].x, straightSampled[i].y - straightSampled[i - 1].y)
    assert.ok(Math.abs(gap - 25) <= 1.5, `expected uniform gap ~25, got ${gap}`)
  }

  // Curve with a sharp Gaussian peak at x=60 (y drops to 15) and flat flanks at y=70
  const peaked = Array.from({ length: 121 }, (_, x) => ({
    x,
    y: 70 - 55 * Math.exp(-((x - 60) ** 2) / 90),
  }))
  const sampled = smartSampleCurvePoints(peaked, { spacing: 20, curvatureBias: 1.3 })
  // Must preserve the peak near (60, 15)
  assert.ok(sampled.some((pt) => Math.abs(pt.x - 60) <= 2 && Math.abs(pt.y - 15) <= 2), 'peak extremum must be locked')
  // Density near the bend (x in [45..75]) must be higher than on the flat flank (x in [0..30])
  const nearPeak = sampled.filter((pt) => pt.x >= 45 && pt.x <= 75).length
  const flatFlank = sampled.filter((pt) => pt.x >= 0 && pt.x <= 30).length
  assert.ok(nearPeak > flatFlank, `expected denser sampling near peak (${nearPeak}) than flat flank (${flatFlank})`)
})

test('smartExtractCurvesFromLayer resolves X-crossings by tangent continuity into 2 intact curves', () => {
  const layer = createRgba(160, 140, [0, 0, 0, 0])
  // Curve A: diagonal going down-right (20,20) -> (140,120)
  drawStroke(layer, 20, 20, 140, 120, [0, 102, 255, 255], 3)
  // Curve B: diagonal going up-right (20,120) -> (140,20)
  drawStroke(layer, 20, 120, 140, 20, [0, 102, 255, 255], 3)
  // Tiny isolated noise speck
  drawStroke(layer, 80, 10, 81, 11, [0, 102, 255, 255], 1)

  const result = smartExtractCurvesFromLayer(layer, { spacing: 20, mode: 'isolated' })
  assert.equal(result.curves.length, 2, `expected 2 intact crossing curves, got ${result.curves.length}`)
  assert.ok(result.junctionCrossingsResolved >= 1, 'expected at least 1 resolved junction crossing')

  // Verify each curve spans from x~20 to x~140 without swapping branches
  const slopes = result.curves.map((curve) => {
    const start = curve[0], end = curve[curve.length - 1]
    assert.ok(start.x < 30 && end.x > 130, `expected full span, got ${start.x}..${end.x}`)
    return Math.sign(end.y - start.y)
  }).sort((a, b) => a - b)
  assert.deepEqual(slopes, [-1, 1], 'crossing curves should keep their own straight trajectories without swapping')
})

test('smartExtractCurvesFromLayer handles near-vertical curves and bridges small gaps cleanly', () => {
  const layer = createRgba(120, 160, [0, 0, 0, 0])
  // Steep near-vertical speed curve with a small 8px break in the middle
  drawStroke(layer, 55, 15, 60, 72, [0, 102, 255, 255], 3)
  drawStroke(layer, 61, 80, 66, 145, [0, 102, 255, 255], 3)

  const result = smartExtractCurvesFromLayer(layer, { spacing: 20, mode: 'isolated', maxGap: 20 })
  assert.equal(result.curves.length, 1, `expected 1 bridged steep curve, got ${result.curves.length}`)
  const curve = result.curves[0]
  assert.ok(curve[0].y < 25 && curve[curve.length - 1].y > 135, 'should trace full vertical span')
  assert.ok(curve.length >= 6, 'should sample evenly along the steep curve')
})

test('smartExtractCurvesFromLayer suppresses solid and dashed gridlines in raw dark mode', () => {
  const plot = createRgba(200, 160, [255, 255, 255, 255])
  // Solid outer border and major gridlines
  for (const y of [20, 80, 140]) drawStroke(plot, 20, y, 180, y, [30, 30, 30, 255], 1)
  for (const x of [20, 100, 180]) drawStroke(plot, x, 20, x, 140, [30, 30, 30, 255], 1)
  // Dashed minor horizontal gridline at y=50 and y=110
  for (const y of [50, 110]) {
    for (let x = 22; x < 178; x += 12) drawStroke(plot, x, y, Math.min(178, x + 5), y, [40, 40, 40, 255], 1)
  }
  // Real diagonal data curve across the grid
  drawStroke(plot, 28, 128, 172, 32, [0, 0, 0, 255], 3)

  const result = smartExtractCurvesFromLayer(plot, {
    spacing: 20,
    mode: 'dark',
    plotRegion: { x: 20, y: 20, width: 160, height: 120 },
  })
  assert.equal(result.curves.length, 1, `expected only 1 curve and no gridlines, got ${result.curves.length}`)
  const curve = result.curves[0]
  assert.ok(curve[0].x < 40 && curve[curve.length - 1].x > 160, 'curve should span across the grid')
  assert.ok(curve[0].y > 110 && curve[curve.length - 1].y < 50, 'curve should preserve diagonal slope')
})

test('smartExtractCurvesFromLayer filters leaked gridline remnants in isolated mode', () => {
  const layer = createRgba(200, 160, [0, 0, 0, 0])
  // Leaked horizontal and vertical gridlines on the isolated curve layer
  drawStroke(layer, 15, 40, 185, 40, [0, 102, 255, 255], 2)
  drawStroke(layer, 15, 110, 185, 110, [0, 102, 255, 255], 2)
  drawStroke(layer, 90, 15, 90, 145, [0, 102, 255, 255], 2)
  // Real curved parabola
  for (let x = 25; x < 175; x++) {
    const y0 = 130 - 0.012 * (x - 100) ** 2
    const y1 = 130 - 0.012 * (x + 1 - 100) ** 2
    drawStroke(layer, x, y0, x + 1, y1, [0, 102, 255, 255], 3)
  }

  const result = smartExtractCurvesFromLayer(layer, {
    spacing: 20,
    mode: 'isolated',
    gridLines: { horizontal: [40, 110], vertical: [90] },
    plotRegion: { x: 15, y: 15, width: 170, height: 130 },
  })
  assert.equal(result.curves.length, 1, `expected only the real curve after filtering grid remnants, got ${result.curves.length}`)
  assert.ok(result.gridLinesFiltered >= 1, 'expected leaked gridlines to be counted as filtered')
})

test('detectReconstruction strips dashed and tinted gridlines while keeping real curves intact', () => {
  const plot = createRgba(180, 140, [255, 255, 255, 255])
  // Dashed neutral horizontal gridlines at y=40 and y=100
  for (const y of [40, 100]) {
    for (let x = 15; x < 165; x += 12) drawStroke(plot, x, y, Math.min(165, x + 4), y, [40, 40, 40, 255], 1)
  }
  // Light blue-tinted vertical gridlines at x=50 and x=130 (chroma = 60 >= 32)
  for (const x of [50, 130]) drawStroke(plot, x, 15, x, 125, [110, 150, 170, 255], 1)
  // Vivid red curve crossing both dashed horizontal and tinted vertical gridlines
  drawStroke(plot, 20, 115, 160, 25, [220, 20, 30, 255], 2)

  const result = detectReconstruction(plot, { x: 15, y: 15, width: 150, height: 110 }, { horizontal: [], vertical: [] })
  assert.ok(result.horizontal.some((y) => Math.abs(y - 40) <= 1), `expected dashed horizontal grid at 40, got ${result.horizontal}`)
  assert.ok(result.horizontal.some((y) => Math.abs(y - 100) <= 1), `expected dashed horizontal grid at 100, got ${result.horizontal}`)
  assert.ok(result.vertical.some((x) => Math.abs(x - 50) <= 1), `expected tinted vertical grid at 50, got ${result.vertical}`)
  assert.ok(result.vertical.some((x) => Math.abs(x - 130) <= 1), `expected tinted vertical grid at 130, got ${result.vertical}`)
  // No leftover horizontal/vertical gridline paths in curves
  const curvePts = result.curves.flat()
  assert.ok(curvePts.some((pt) => Math.hypot(pt.x - 90, pt.y - 70) < 4), 'red curve should survive across dashed and tinted grids')
  assert.ok(!curvePts.some((pt) => Math.abs(pt.y - 40) <= 1 && pt.x < 60), 'dashed gridline away from curve should not remain as curve')
  assert.ok(!curvePts.some((pt) => Math.abs(pt.x - 50) <= 1 && pt.y < 55), 'tinted vertical gridline away from curve should not remain as curve')
})
