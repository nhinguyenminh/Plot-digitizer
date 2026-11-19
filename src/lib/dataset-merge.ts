import type { Dataset, PixelPoint } from './digitizer'

export function mergeDatasets(datasets: Dataset[], primaryId: string): Dataset {
  const primary = datasets.find((dataset) => dataset.id === primaryId)
  if (datasets.length < 2 || !primary || new Set(datasets.map((dataset) => dataset.id)).size !== datasets.length) {
    throw new Error('Select at least two different datasets to merge.')
  }
  if (primary.kind === 'measurement' || datasets.some((dataset) => dataset.kind !== primary.kind)) {
    throw new Error('Merge datasets of the same curve type; measurement datasets cannot be merged.')
  }
  const fields = ['rpm', 'speedUnit', 'igv', 'igvUnit', 'efficiencyValue'] as const
  if (datasets.some((dataset) => fields.some((field) => dataset[field] !== primary[field]))) {
    throw new Error('Datasets must have matching speed, IGV, and efficiency settings before merging.')
  }

  const segments: PixelPoint[][] = datasets.filter((dataset) => dataset.points.length).map((dataset) => [...dataset.points])
  while (segments.length > 1) {
    let best = { first: 0, second: 1, reverseFirst: false, reverseSecond: false, distance: Infinity }
    for (let first = 0; first < segments.length; first++) for (let second = first + 1; second < segments.length; second++) {
      for (const reverseFirst of [false, true]) for (const reverseSecond of [false, true]) {
        const a = reverseFirst ? segments[first][0] : segments[first][segments[first].length - 1]
        const b = reverseSecond ? segments[second][segments[second].length - 1] : segments[second][0]
        const distance = Math.hypot(a.x - b.x, a.y - b.y)
        if (distance < best.distance) best = { first, second, reverseFirst, reverseSecond, distance }
      }
    }
    const first = best.reverseFirst ? [...segments[best.first]].reverse() : segments[best.first]
    const second = best.reverseSecond ? [...segments[best.second]].reverse() : segments[best.second]
    segments[best.first] = [...first, ...second]
    segments.splice(best.second, 1)
  }
  return { ...primary, points: segments[0] ?? [] }
}
