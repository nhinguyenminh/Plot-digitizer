import type { Dataset } from './digitizer'

export function reorderDatasets(datasets: Dataset[], draggedId: string, targetId: string, after: boolean): Dataset[] {
  const dragged = datasets.find((dataset) => dataset.id === draggedId)
  if (!dragged || draggedId === targetId || !datasets.some((dataset) => dataset.id === targetId)) return datasets
  const next = datasets.filter((dataset) => dataset.id !== draggedId)
  const index = next.findIndex((dataset) => dataset.id === targetId) + (after ? 1 : 0)
  next.splice(index, 0, dragged)
  return next
}
