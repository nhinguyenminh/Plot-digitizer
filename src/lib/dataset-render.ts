import type { Dataset, PixelPoint } from './digitizer'

export function drawDatasets(
  context: CanvasRenderingContext2D,
  datasets: Dataset[],
  mapPoint: (point: PixelPoint) => PixelPoint,
  lineWidth: number,
  pointRadius: number,
) {
  for (const dataset of datasets) {
    context.save()
    context.fillStyle = dataset.color
    if (dataset.points.length > 1) {
      context.beginPath()
      dataset.points.forEach((point, index) => {
        const mapped = mapPoint(point)
        if (index) context.lineTo(mapped.x, mapped.y)
        else context.moveTo(mapped.x, mapped.y)
      })
      context.strokeStyle = '#ffffff'; context.lineWidth = lineWidth + 3; context.stroke()
      context.strokeStyle = '#000000'; context.lineWidth = lineWidth + 1.5; context.stroke()
      context.strokeStyle = dataset.color; context.lineWidth = lineWidth; context.stroke()
    }
    for (const point of dataset.points) {
      const mapped = mapPoint(point)
      context.beginPath()
      context.arc(mapped.x, mapped.y, pointRadius, 0, Math.PI * 2)
      context.strokeStyle = '#ffffff'; context.lineWidth = 3; context.stroke()
      context.strokeStyle = '#000000'; context.lineWidth = 1.5; context.stroke()
      context.fill()
    }
    context.restore()
  }
}
