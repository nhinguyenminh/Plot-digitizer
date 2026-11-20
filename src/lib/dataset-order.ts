import type { Dataset } from './digitizer'

export function datasetRange(datasets: Dataset[], startId: string, endId: string): string[] {
  const start = datasets.findIndex((dataset) => dataset.id === startId)
  const end = datasets.findIndex((dataset) => dataset.id === endId)
  if (start < 0 || end < 0) return []
  return datasets.slice(Math.min(start, end), Math.max(start, end) + 1).map((dataset) => dataset.id)
}

export function reorderDatasets(datasets: Dataset[], draggedId: string, targetId: string, after: boolean): Dataset[] {
  const dragged = datasets.find((dataset) => dataset.id === draggedId)
  if (!dragged || draggedId === targetId || !datasets.some((dataset) => dataset.id === targetId)) return datasets
  const next = datasets.filter((dataset) => dataset.id !== draggedId)
  const index = next.findIndex((dataset) => dataset.id === targetId) + (after ? 1 : 0)
  next.splice(index, 0, dragged)
  return next
}
