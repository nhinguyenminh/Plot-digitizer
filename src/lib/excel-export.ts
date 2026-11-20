import type { Dataset, PixelPoint } from './digitizer'

export interface WorkbookDataset {
  dataset: Dataset
  points: PixelPoint[]
}

export interface WorkbookChart {
  name: string
  datasets: WorkbookDataset[]
  xLabel: string
  yLabel: string
  image: { base64: string; width: number; height: number } | null
}

function worksheetName(name: string, used: Set<string>) {
  const cleaned = name.replace(/[\u0000-\u001f\\/*?:[\]]/g, ' ').trim().replace(/^'+|'+$/g, '').trim() || 'Chart'
  let candidate = cleaned.slice(0, 31).replace(/'+$/g, '') || 'Chart'
  let index = 2
  while (used.has(candidate.toLowerCase()) || candidate.toLowerCase() === 'history') {
    const suffix = ` (${index++})`
    candidate = cleaned.slice(0, 31 - suffix.length).replace(/'+$/g, '') + suffix
  }
  used.add(candidate.toLowerCase())
  return candidate
}

export async function createProjectWorkbook(charts: WorkbookChart[]) {
  if (!charts.length) throw new Error('The project must contain at least one chart.')
  for (const chart of charts) {
    if (chart.datasets.length * 2 > 16384) throw new Error(`Too many datasets in chart "${chart.name}" for an Excel worksheet.`)
    if (chart.image && chart.datasets.length * 2 + 2 > 16384) throw new Error(`Not enough worksheet columns for the image in chart "${chart.name}".`)
    if (chart.datasets.some(({ points }) => points.length > 1048574)) throw new Error(`A dataset in chart "${chart.name}" has too many points for an Excel worksheet.`)
  }
  const ExcelJS = (await import('exceljs')).default
  const workbook = new ExcelJS.Workbook()
  const used = new Set<string>()
  for (const chart of charts) {
    const sheet = workbook.addWorksheet(worksheetName(chart.name, used))
    chart.datasets.forEach(({ dataset, points }, index) => {
      const column = index * 2 + 1
      sheet.mergeCells(1, column, 1, column + 1)
      const title = sheet.getCell(1, column)
      title.value = dataset.name
      title.font = { bold: true }
      title.border = { bottom: { style: 'medium', color: { argb: `FF${dataset.color.slice(1).toUpperCase()}` } } }
      sheet.getCell(2, column).value = chart.xLabel
      sheet.getCell(2, column + 1).value = chart.yLabel
      sheet.getColumn(column).width = 17
      sheet.getColumn(column + 1).width = 17
      points.forEach((point, row) => {
        sheet.getCell(row + 3, column).value = point.x
        sheet.getCell(row + 3, column + 1).value = point.y
      })
    })
    sheet.views = [{ state: 'frozen', ySplit: 2 }]
    if (chart.image) {
      const imageId = workbook.addImage({ base64: chart.image.base64, extension: 'png' })
      const scale = Math.min(1, 1200 / Math.max(chart.image.width, chart.image.height))
      const column = Math.max(2, chart.datasets.length * 2 + 1)
      sheet.getCell(1, column + 1).value = 'Datasets overlaid on the original image'
      sheet.getCell(1, column + 1).font = { bold: true }
      sheet.addImage(imageId, { tl: { col: column, row: 2 }, ext: { width: chart.image.width * scale, height: chart.image.height * scale } })
    }
  }
  return workbook
}
