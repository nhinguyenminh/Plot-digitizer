import { test } from 'node:test'
import assert from 'node:assert/strict'
import { drawDatasets } from '../src/lib/dataset-render.ts'

test('drawDatasets highlights all multi-selected curves on top and dims unselected curves', () => {
  const rendered = []
  const context = {
    globalAlpha: 1,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    save() {},
    restore() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    stroke() {},
    fill() {
      rendered.push({ color: this.fillStyle, alpha: this.globalAlpha })
    },
  }
  const datasets = [
    { id: 'd1', name: 'Curve 1', color: '#ff0000', kind: 'curve', points: [{ x: 10, y: 10 }] },
    { id: 'd2', name: 'Curve 2', color: '#00ff00', kind: 'curve', points: [{ x: 20, y: 20 }] },
    { id: 'd3', name: 'Curve 3', color: '#0000ff', kind: 'curve', points: [{ x: 30, y: 30 }] },
  ]

  drawDatasets(context, datasets, (point) => point, 2, 4, 'd3', ['d1', 'd3'])

  // Unselected d2 drawn first (dimmed), then selected d1 and d3 drawn on top at full opacity
  assert.deepEqual(rendered, [
    { color: '#00ff00', alpha: 0.32 },
    { color: '#ff0000', alpha: 1 },
    { color: '#0000ff', alpha: 1 },
  ])
})
