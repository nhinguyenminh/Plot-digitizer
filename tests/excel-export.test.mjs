import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createWorkbook } from '../src/lib/excel-export.ts'
import ExcelJS from 'exceljs'

test('exports dataset columns in order and includes the original-image overlay', async () => {
  const datasets = [
    { dataset: { name: 'Second', color: '#123456' }, points: [{ x: 2.5, y: 3.5 }] },
    { dataset: { name: 'First', color: '#abcdef' }, points: [{ x: 1, y: 4 }, { x: 3, y: 6 }] },
  ]
  const image = { base64: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL6WQAAAABJRU5ErkJggg==', width: 100, height: 50 }
  const original = await createWorkbook(datasets, 'Flow', 'Head', image)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(await original.xlsx.writeBuffer())
  const data = workbook.getWorksheet('Data')
  assert.equal(data.getCell('A1').value, 'Second')
  assert.equal(data.getCell('C1').value, 'First')
  assert.equal(data.getCell('A2').value, 'Flow')
  assert.equal(data.getCell('B2').value, 'Head')
  assert.equal(data.getCell('A3').value, 2.5)
  assert.equal(data.getCell('D4').value, 6)
  assert.equal(data.getCell('A4').value, null)
  assert.equal(workbook.getWorksheet('Plot').getImages().length, 1)
  assert.equal(workbook.getWorksheet('Plot').getCell('B2').value, 'Second')
})
