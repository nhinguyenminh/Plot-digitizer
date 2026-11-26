import type { Dataset, PixelPoint } from './digitizer'

export type DatasetBreakMode = 'point' | 'segment'

export interface DatasetSegmentHit {
  datasetId: string
  segmentIndex: number
  distance: number
  start: PixelPoint
  end: PixelPoint
  closest: PixelPoint
}

export interface DatasetPointHit {
  datasetId: string
  pointIndex: number
  distance: number
  point: PixelPoint
}

export function pointToSegmentProjection(point: PixelPoint, start: PixelPoint, end: PixelPoint) {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const lengthSq = dx * dx + dy * dy
  const t = lengthSq > 0
    ? Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq))
    : 0
  const closest = { x: start.x + t * dx, y: start.y + t * dy }
  return { closest, distance: Math.hypot(point.x - closest.x, point.y - closest.y), t }
}

export function findNearestBreakPoint(
  datasets: Dataset[],
  point: PixelPoint,
  maxDistance: number,
  preferredDatasetId?: string,
): DatasetPointHit | null {
  let best: DatasetPointHit | null = null
  for (const dataset of datasets) {
    if (dataset.points.length < 3) continue
    for (let index = 1; index < dataset.points.length - 1; index++) {
      const candidate = dataset.points[index]
      const distance = Math.hypot(point.x - candidate.x, point.y - candidate.y)
      if (distance > maxDistance) continue
      const isBetter = !best
        || distance < best.distance - 1.5
        || (Math.abs(distance - best.distance) <= 1.5
          && dataset.id === preferredDatasetId
          && best.datasetId !== preferredDatasetId)
        || (Math.abs(distance - best.distance) <= 1.5
          && (dataset.id === preferredDatasetId) === (best.datasetId === preferredDatasetId)
          && distance < best.distance)
      if (isBetter) {
        best = { datasetId: dataset.id, pointIndex: index, distance, point: candidate }
      }
    }
  }
  return best
}

export function findNearestDatasetSegment(
  datasets: Dataset[],
  point: PixelPoint,
  maxDistance: number,
  preferredDatasetId?: string,
): DatasetSegmentHit | null {
  let best: DatasetSegmentHit | null = null
  for (const dataset of datasets) {
    if (dataset.points.length < 2) continue
    for (let index = 0; index < dataset.points.length - 1; index++) {
      const start = dataset.points[index]
      const end = dataset.points[index + 1]
      const { closest, distance } = pointToSegmentProjection(point, start, end)
      if (distance > maxDistance) continue
      const isBetter = !best
        || distance < best.distance - 1.5
        || (Math.abs(distance - best.distance) <= 1.5
          && dataset.id === preferredDatasetId
          && best.datasetId !== preferredDatasetId)
        || (Math.abs(distance - best.distance) <= 1.5
          && (dataset.id === preferredDatasetId) === (best.datasetId === preferredDatasetId)
          && distance < best.distance)
      if (isBetter) {
        best = { datasetId: dataset.id, segmentIndex: index, distance, start, end, closest }
      }
    }
  }
  return best
}

export function suggestSplitDatasetName(baseName: string, existingDatasets: Dataset[]): string {
  const trimmed = baseName.trim() || 'Dataset'
  const used = new Set(existingDatasets.map((dataset) => dataset.name.trim().toLowerCase()))
  let suffix = 2
  while (used.has(`${trimmed} (${suffix})`.toLowerCase())) suffix++
  return `${trimmed} (${suffix})`
}

export function breakDatasetAtPoint(
  dataset: Dataset,
  pointIndex: number,
  options: {
    firstName?: string
    secondName?: string
    secondColor: string
    secondId?: string
  },
): [Dataset, Dataset] {
  if (dataset.points.length < 3) {
    throw new Error('A dataset needs at least three points to break at an interior point.')
  }
  if (!Number.isInteger(pointIndex) || pointIndex < 1 || pointIndex > dataset.points.length - 2) {
    throw new Error('Select an interior point between the first and last point to break.')
  }
  const firstName = options.firstName?.trim() || dataset.name
  const secondName = options.secondName?.trim() || `${dataset.name} (2)`
  const first: Dataset = {
    ...dataset,
    name: firstName,
    points: dataset.points.slice(0, pointIndex + 1).map((point) => ({ ...point })),
  }
  const second: Dataset = {
    ...dataset,
    id: options.secondId ?? crypto.randomUUID(),
    name: secondName,
    color: options.secondColor,
    points: dataset.points.slice(pointIndex).map((point) => ({ ...point })),
  }
  return [first, second]
}

export function breakDatasetAtSegment(
  dataset: Dataset,
  segmentIndex: number,
  options: {
    firstName?: string
    secondName?: string
    secondColor: string
    secondId?: string
  },
): [Dataset, Dataset] {
  if (dataset.points.length < 2) {
    throw new Error('A dataset needs at least two points to be broken.')
  }
  if (!Number.isInteger(segmentIndex) || segmentIndex < 0 || segmentIndex >= dataset.points.length - 1) {
    throw new Error('Select a valid segment between two consecutive points.')
  }
  const firstName = options.firstName?.trim() || dataset.name
  const secondName = options.secondName?.trim() || `${dataset.name} (2)`
  const first: Dataset = {
    ...dataset,
    name: firstName,
    points: dataset.points.slice(0, segmentIndex + 1).map((point) => ({ ...point })),
  }
  const second: Dataset = {
    ...dataset,
    id: options.secondId ?? crypto.randomUUID(),
    name: secondName,
    color: options.secondColor,
    points: dataset.points.slice(segmentIndex + 1).map((point) => ({ ...point })),
  }
  return [first, second]
}
