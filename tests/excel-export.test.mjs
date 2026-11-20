import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createProjectWorkbook } from '../src/lib/excel-export.ts'
import ExcelJS from 'exceljs'

test('exports one sheet per chart, with datasets and each image overlay', async () => {
  const datasets = [
    { dataset: { name: 'Second', color: '#123456' }, points: [{ x: 2.5, y: 3.5 }] },
    { dataset: { name: 'First', color: '#abcdef' }, points: [{ x: 1, y: 4 }, { x: 3, y: 6 }] },
  ]
  const image = { base64: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL6WQAAAABJRU5ErkJggg==', width: 100, height: 50 }
  const original = await createProjectWorkbook([
    { name: 'Chart / 1', datasets, xLabel: 'Flow', yLabel: 'Head', image },
    { name: 'chart   1', datasets: [{ dataset: { name: 'Other', color: '#123456' }, points: [{ x: 8, y: 9 }] }], xLabel: 'X', yLabel: 'Y', image },
    { name: 'Empty', datasets: [], xLabel: 'X', yLabel: 'Y', image: null },
  ])
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(await original.xlsx.writeBuffer())
  assert.equal(workbook.worksheets.length, 3)
  const data = workbook.getWorksheet('Chart   1')
  assert.equal(data.getCell('A1').value, 'Second')
  assert.equal(data.getCell('C1').value, 'First')
  assert.equal(data.getCell('A2').value, 'Flow')
  assert.equal(data.getCell('B2').value, 'Head')
  assert.equal(data.getCell('A3').value, 2.5)
  assert.equal(data.getCell('D4').value, 6)
  assert.equal(data.getCell('A4').value, null)
  assert.equal(data.getImages().length, 1)
  assert.equal(workbook.getWorksheet('chart   1 (2)').getCell('A3').value, 8)
  assert.equal(workbook.getWorksheet('chart   1 (2)').getImages().length, 1)
  assert.equal(workbook.getWorksheet('Empty').getImages().length, 0)
})

test('Excel sheet names are valid, bounded and unique after truncation', async () => {
  const chart = { datasets: [], xLabel: 'X', yLabel: 'Y', image: null }
  const workbook = await createProjectWorkbook([
    { ...chart, name: "'bad:*name?'" },
    { ...chart, name: 'A'.repeat(40) },
    { ...chart, name: 'a'.repeat(40) },
    { ...chart, name: '[]' },
    { ...chart, name: 'History' },
    { ...chart, name: `${'x'.repeat(30)}'long` },
  ])
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ['bad  name', 'A'.repeat(31), `${'a'.repeat(27)} (2)`, 'Chart', 'History (2)', 'x'.repeat(30)])
})

test('rejects a chart whose image cannot fit beside its dataset columns', async () => {
  const dataset = { dataset: { name: 'A', color: '#000000' }, points: [] }
  await assert.rejects(createProjectWorkbook([{ name: 'Full', datasets: Array(8192).fill(dataset), xLabel: 'X', yLabel: 'Y', image: { base64: '', width: 1, height: 1 } }]), /columns/)
})
