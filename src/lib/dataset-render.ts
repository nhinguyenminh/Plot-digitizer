import type { Dataset, PixelPoint } from './digitizer'

export function drawDatasets(
  context: CanvasRenderingContext2D,
  datasets: Dataset[],
  mapPoint: (point: PixelPoint) => PixelPoint,
  lineWidth: number,
  pointRadius: number,
  activeDatasetId?: string,
  selectedDatasetIds?: readonly string[],
) {
  const highlighted = new Set<string>()
  if (selectedDatasetIds?.length) {
    for (const id of selectedDatasetIds) highlighted.add(id)
  } else if (activeDatasetId) {
    highlighted.add(activeDatasetId)
  }
  const ordered = highlighted.size
    ? [
        ...datasets.filter((dataset) => !highlighted.has(dataset.id)),
        ...datasets.filter((dataset) => highlighted.has(dataset.id)),
      ]
    : datasets
  for (const dataset of ordered) {
    context.save()
    const active = !highlighted.size || highlighted.has(dataset.id)
    context.globalAlpha = active ? 1 : 0.32
    context.fillStyle = dataset.color
    if (dataset.points.length > 1) {
      context.beginPath()
      dataset.points.forEach((point, index) => {
        const mapped = mapPoint(point)
        if (index) context.lineTo(mapped.x, mapped.y)
        else context.moveTo(mapped.x, mapped.y)
      })
      context.strokeStyle = '#ffffff'; context.lineWidth = lineWidth + (active ? 6 : 3); context.stroke()
      context.strokeStyle = '#000000'; context.lineWidth = lineWidth + (active ? 3 : 1.5); context.stroke()
      context.strokeStyle = dataset.color; context.lineWidth = lineWidth + (active ? 1.5 : 0); context.stroke()
    }
    for (const point of dataset.points) {
      const mapped = mapPoint(point)
      context.beginPath()
      context.arc(mapped.x, mapped.y, pointRadius + (active ? 1.5 : 0), 0, Math.PI * 2)
      context.strokeStyle = '#ffffff'; context.lineWidth = active ? 4 : 3; context.stroke()
      context.strokeStyle = '#000000'; context.lineWidth = active ? 2 : 1.5; context.stroke()
      context.fill()
    }
    context.restore()
  }
}
