import type { Dataset, PixelPoint } from './digitizer'

export interface WorkbookDataset {
  dataset: Dataset
  points: PixelPoint[]
}

export async function createWorkbook(
  datasets: WorkbookDataset[],
  xLabel: string,
  yLabel: string,
  image: { base64: string; width: number; height: number },
) {
  if (datasets.length * 2 > 16384) throw new Error('Too many datasets for an Excel worksheet.')
  if (datasets.some(({ points }) => points.length > 1048574)) throw new Error('A dataset has too many points for an Excel worksheet.')
  const ExcelJS = (await import('exceljs')).default
  const workbook = new ExcelJS.Workbook()
  const data = workbook.addWorksheet('Data')
  datasets.forEach(({ dataset, points }, index) => {
    const column = index * 2 + 1
    data.mergeCells(1, column, 1, column + 1)
    const title = data.getCell(1, column)
    title.value = dataset.name
    title.font = { bold: true }
    title.border = { bottom: { style: 'medium', color: { argb: `FF${dataset.color.slice(1).toUpperCase()}` } } }
    data.getCell(2, column).value = xLabel
    data.getCell(2, column + 1).value = yLabel
    data.getColumn(column).width = 17
    data.getColumn(column + 1).width = 17
    points.forEach((point, row) => {
      data.getCell(row + 3, column).value = point.x
      data.getCell(row + 3, column + 1).value = point.y
    })
  })
  data.views = [{ state: 'frozen', ySplit: 2 }]
  const plot = workbook.addWorksheet('Plot')
  plot.getCell('A1').value = 'Datasets overlaid on the original image'
  plot.getCell('A1').font = { bold: true }
  datasets.forEach(({ dataset }, index) => {
    const swatch = plot.getCell(index + 2, 1)
    swatch.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${dataset.color.slice(1).toUpperCase()}` } }
    swatch.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } }
    plot.getCell(index + 2, 2).value = dataset.name
  })
  plot.getColumn(1).width = 5
  plot.getColumn(2).width = 30
  const imageId = workbook.addImage({ base64: image.base64, extension: 'png' })
  const scale = Math.min(1, 1200 / Math.max(image.width, image.height))
  plot.addImage(imageId, { tl: { col: 0, row: datasets.length + 2 }, ext: { width: image.width * scale, height: image.height * scale } })
  return workbook
}
