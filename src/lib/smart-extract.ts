import type { PixelPoint } from './digitizer'
import { thinBinaryInk } from './skeleton.ts'
import { snapPointToCurveCenter } from './point-tools.ts'
import type { CurveImageSource, CurveSnapMode } from './point-tools.ts'

export interface SmartSampleOptions {
  spacing?: number
  curvatureBias?: number
  preserveExtrema?: boolean
}

export interface SmartExtractOptions {
  spacing?: number
  curvatureBias?: number
  mode?: CurveSnapMode
  curveColor?: [number, number, number]
  tolerance?: number
  mask?: Uint8ClampedArray
  minCurveLength?: number
  maxGap?: number
  scorePixel?: (x: number, y: number) => number
  gridLines?: { horizontal: number[]; vertical: number[] }
  plotRegion?: { x: number; y: number; width: number; height: number }
}

export interface SmartExtractResult {
  curves: PixelPoint[][]
  junctionCrossingsResolved: number
  gridLinesFiltered: number
  warnings: string[]
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function pointSegmentDistance(point: PixelPoint, start: PixelPoint, end: PixelPoint) {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const lenSq = dx * dx + dy * dy
  const t = lenSq ? clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / lenSq, 0, 1) : 0
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy))
}

function smoothForAnalysis(points: PixelPoint[]): PixelPoint[] {
  const n = points.length
  if (n < 5) return points
  const weights = [1, 4, 6, 4, 1]
  return points.map((point, index) => {
    if (index === 0 || index === n - 1) return point
    let sx = 0, sy = 0, sw = 0
    for (let offset = -2; offset <= 2; offset++) {
      const target = points[clamp(index + offset, 0, n - 1)]
      const w = weights[offset + 2]
      sx += target.x * w
      sy += target.y * w
      sw += w
    }
    return { x: sx / sw, y: sy / sw }
  })
}

/**
 * Curvature-adaptive arc-length point sampler.
 * Locks endpoints, prominent peaks/valleys (extrema), and high-curvature bends,
 * then places points evenly by arc length on straight segments and denser on curves.
 */
export function smartSampleCurvePoints(points: PixelPoint[], options: SmartSampleOptions = {}): PixelPoint[] {
  const spacing = Math.max(2, Math.min(80, options.spacing ?? 18))
  const curvatureBias = clamp(options.curvatureBias ?? 1, 0.6, 1.6)
  const preserveExtrema = options.preserveExtrema ?? true

  // Deduplicate near-identical consecutive points
  const clean: PixelPoint[] = []
  for (const point of points) {
    const prev = clean[clean.length - 1]
    if (!prev || Math.hypot(point.x - prev.x, point.y - prev.y) >= 0.25) clean.push(point)
  }
  const n = clean.length
  if (n <= 2) return clean

  // Cumulative arc length
  const arc = new Float64Array(n)
  for (let i = 1; i < n; i++) {
    arc[i] = arc[i - 1] + Math.hypot(clean[i].x - clean[i - 1].x, clean[i].y - clean[i - 1].y)
  }
  const totalLength = arc[n - 1]
  if (totalLength < 1) return [clean[0], clean[n - 1]]

  // Smooth copy purely for stable derivative/curvature analysis
  const analyzed = smoothForAnalysis(clean)
  const kappa = new Float64Array(n)
  const turnAngles = new Float64Array(n)
  const chordStep = Math.max(2, Math.min(7, Math.floor(n / 8)))

  for (let i = 1; i < n - 1; i++) {
    const prevIdx = Math.max(0, i - chordStep)
    const nextIdx = Math.min(n - 1, i + chordStep)
    const v1x = analyzed[i].x - analyzed[prevIdx].x
    const v1y = analyzed[i].y - analyzed[prevIdx].y
    const v2x = analyzed[nextIdx].x - analyzed[i].x
    const v2y = analyzed[nextIdx].y - analyzed[i].y
    const len1 = Math.hypot(v1x, v1y)
    const len2 = Math.hypot(v2x, v2y)
    if (len1 < 0.8 || len2 < 0.8) continue
    const cos = clamp((v1x * v2x + v1y * v2y) / (len1 * len2), -1, 1)
    const angle = Math.acos(cos)
    turnAngles[i] = angle
    const localArc = Math.max(1, (arc[nextIdx] - arc[prevIdx]) / 2)
    kappa[i] = angle / localArc
  }

  // Collect candidate geometric landmarks (peaks/valleys + elbows)
  const candidates: Array<{ index: number; salience: number }> = []
  const extremaWindow = Math.max(4, Math.min(18, Math.round(n * 0.12)))
  const minProminence = Math.max(2.2, spacing * 0.13)

  if (preserveExtrema && n >= 7) {
    for (let i = 2; i < n - 2; i++) {
      const start = Math.max(0, i - extremaWindow)
      const end = Math.min(n - 1, i + extremaWindow)
      const y = analyzed[i].y
      let isMaxY = true, isMinY = true
      let minAroundY = y, maxAroundY = y
      for (let j = start; j <= end; j++) {
        if (j === i) continue
        if (analyzed[j].y > y) isMaxY = false
        if (analyzed[j].y < y) isMinY = false
        if (analyzed[j].y < minAroundY) minAroundY = analyzed[j].y
        if (analyzed[j].y > maxAroundY) maxAroundY = analyzed[j].y
      }
      if (isMaxY && y - minAroundY >= minProminence) {
        candidates.push({ index: i, salience: (y - minAroundY) * 1.5 })
      } else if (isMinY && maxAroundY - y >= minProminence) {
        candidates.push({ index: i, salience: (maxAroundY - y) * 1.5 })
      }

      // Also detect X turnarounds for vertical / multi-valued curves
      const x = analyzed[i].x
      let isMaxX = true, isMinX = true
      let minAroundX = x, maxAroundX = x
      for (let j = start; j <= end; j++) {
        if (j === i) continue
        if (analyzed[j].x > x) isMaxX = false
        if (analyzed[j].x < x) isMinX = false
        if (analyzed[j].x < minAroundX) minAroundX = analyzed[j].x
        if (analyzed[j].x > maxAroundX) maxAroundX = analyzed[j].x
      }
      if (isMaxX && x - minAroundX >= minProminence * 1.3) {
        candidates.push({ index: i, salience: (x - minAroundX) * 1.2 })
      } else if (isMinX && maxAroundX - x >= minProminence * 1.3) {
        candidates.push({ index: i, salience: (maxAroundX - x) * 1.2 })
      }
    }
  }

  // High-curvature elbows / knees
  const minTurnRad = (Math.max(14, 24 / curvatureBias)) * Math.PI / 180
  for (let i = 2; i < n - 2; i++) {
    if (turnAngles[i] < minTurnRad) continue
    let localPeak = true
    for (let j = Math.max(1, i - chordStep); j <= Math.min(n - 2, i + chordStep); j++) {
      if (turnAngles[j] > turnAngles[i]) { localPeak = false; break }
    }
    if (localPeak) candidates.push({ index: i, salience: turnAngles[i] * 10 })
  }

  // Greedily lock highest-salience landmarks separated by minLandmarkGap
  const minLandmarkGap = Math.max(4, spacing * 0.28)
  const locked = [0, n - 1]
  candidates.sort((a, b) => b.salience - a.salience)
  for (const candidate of candidates) {
    const pos = arc[candidate.index]
    if (locked.every((existing) => Math.abs(arc[existing] - pos) >= minLandmarkGap)) {
      locked.push(candidate.index)
    }
  }
  locked.sort((a, b) => a - b)

  // Curvature-weighted cumulative density for smooth adaptive spacing between landmarks
  const cumWeight = new Float64Array(n)
  for (let i = 1; i < n; i++) {
    const ds = arc[i] - arc[i - 1]
    const avgKappa = (kappa[i - 1] + kappa[i]) / 2
    const boost = 1 + 2.8 * curvatureBias * Math.min(0.65, avgKappa * 5)
    cumWeight[i] = cumWeight[i - 1] + ds * boost
  }

  const chosenIndices = new Set<number>([0, n - 1])
  for (let spanIndex = 0; spanIndex < locked.length - 1; spanIndex++) {
    const a = locked[spanIndex]
    const b = locked[spanIndex + 1]
    chosenIndices.add(a)
    chosenIndices.add(b)
    const weightedSpan = cumWeight[b] - cumWeight[a]
    const segments = Math.max(1, Math.round(weightedSpan / spacing))
    for (let step = 1; step < segments; step++) {
      const target = cumWeight[a] + (weightedSpan * step) / segments
      let lo = a, hi = b
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (cumWeight[mid] < target) lo = mid + 1
        else hi = mid
      }
      const chosen = lo > a && Math.abs(cumWeight[lo - 1] - target) < Math.abs(cumWeight[lo] - target) ? lo - 1 : lo
      chosenIndices.add(chosen)
    }
  }

  // Final chord-deviation guardrail so sharp arcs never lose geometric accuracy
  const maxChordError = Math.max(1.1, 1.9 / curvatureBias)
  const sorted = [...chosenIndices].sort((a, b) => a - b)
  const refined: number[] = [sorted[0]]
  const stack: Array<[number, number]> = []
  for (let i = sorted.length - 2; i >= 0; i--) stack.push([sorted[i], sorted[i + 1]])

  while (stack.length) {
    const [start, end] = stack.pop()!
    let worstIndex = -1
    let worstError = maxChordError
    for (let i = start + 1; i < end; i++) {
      const error = pointSegmentDistance(clean[i], clean[start], clean[end])
      if (error > worstError) {
        worstError = error
        worstIndex = i
      }
    }
    if (worstIndex >= 0 && arc[worstIndex] - arc[start] >= 2 && arc[end] - arc[worstIndex] >= 2) {
      stack.push([worstIndex, end], [start, worstIndex])
    } else {
      refined.push(end)
    }
  }

  return refined.map((index) => clean[index])
}

function isInkPixel(
  data: Uint8ClampedArray,
  offset: number,
  mode: CurveSnapMode,
  curveColor: [number, number, number],
  tolerance: number,
) {
  const alpha = data[offset + 3]
  if (mode === 'isolated') return alpha >= 16
  if (alpha < 64) return false
  const r = data[offset], g = data[offset + 1], b = data[offset + 2]
  if (mode === 'color') {
    if (r > 240 && g > 240 && b > 240) return false
    return Math.hypot(r - curveColor[0], g - curveColor[1], b - curveColor[2]) <= tolerance
  }
  return (alpha / 255) * (255 - Math.min(r, g, b)) >= 70
}

function fitOutgoingTangent(points: PixelPoint[], fromEnd: boolean): PixelPoint | null {
  if (points.length < 3) return null
  const ordered = fromEnd ? [...points].reverse() : points
  const start = ordered[0]
  const skip = Math.min(2, ordered.length - 2)
  const limit = Math.min(ordered.length - 1, 14)
  let dxSum = 0, dySum = 0, count = 0
  for (let i = skip; i <= limit; i++) {
    const dx = ordered[i].x - start.x
    const dy = ordered[i].y - start.y
    const len = Math.hypot(dx, dy)
    if (len < 1.5) continue
    dxSum += dx / len
    dySum += dy / len
    count++
  }
  const mag = Math.hypot(dxSum, dySum)
  if (!count || mag < 1e-6) return null
  return { x: dxSum / mag, y: dySum / mag }
}

function pathArcLength(points: PixelPoint[]) {
  let total = 0
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
  }
  return total
}

/**
 * Extracts clean curves across a curve layer (full plot or masked region) using skeletonization,
 * junction-cluster tangent continuation across crossings, short-gap bridging,
 * curvature-adaptive sampling, and sub-pixel centerline refinement.
 */
export function smartExtractCurvesFromLayer(
  image: CurveImageSource,
  options: SmartExtractOptions = {},
): SmartExtractResult {
  const { width, height, data } = image
  if (width <= 0 || height <= 0 || data.length !== width * height * 4) {
    throw new Error('Invalid curve image dimensions.')
  }
  if (width * height > 4_000_000) {
    throw new Error('Use an image below 4 megapixels for smart automatic point extraction.')
  }
  const spacing = Math.max(2, Math.min(80, options.spacing ?? 18))
  const curvatureBias = clamp(options.curvatureBias ?? 1, 0.6, 1.6)
  const mode = options.mode ?? 'isolated'
  const curveColor = options.curveColor ?? [0, 102, 255]
  const tolerance = options.tolerance ?? 76
  const mask = options.mask
  const minCurveLength = Math.max(6, options.minCurveLength ?? 14)
  const maxGap = Math.max(0, options.maxGap ?? 24)
  const scorePixel = options.scorePixel
  const plotRegion = options.plotRegion

  if (mask && mask.length !== data.length) throw new Error('Selection mask does not match image dimensions.')

  // 1. Build clean binary ink map (optionally clipped to plotRegion)
  const regionLeft = plotRegion ? Math.max(0, Math.floor(plotRegion.x)) : 0
  const regionTop = plotRegion ? Math.max(0, Math.floor(plotRegion.y)) : 0
  const regionRight = plotRegion ? Math.min(width - 1, Math.ceil(plotRegion.x + plotRegion.width)) : width - 1
  const regionBottom = plotRegion ? Math.min(height - 1, Math.ceil(plotRegion.y + plotRegion.height)) : height - 1

  const ink = new Uint8Array(width * height)
  const coloredInk = new Uint8Array(width * height)
  let inkCount = 0
  let inkMinX = width, inkMaxX = -1, inkMinY = height, inkMaxY = -1
  for (let y = regionTop; y <= regionBottom; y++) {
    for (let x = regionLeft; x <= regionRight; x++) {
      const index = y * width + x
      const offset = index * 4
      if (mask && mask[offset + 3] < 128) continue
      if (isInkPixel(data, offset, mode, curveColor, tolerance)) {
        ink[index] = 1
        inkCount++
        if (x < inkMinX) inkMinX = x
        if (x > inkMaxX) inkMaxX = x
        if (y < inkMinY) inkMinY = y
        if (y > inkMaxY) inkMaxY = y
        const maxC = Math.max(data[offset], data[offset + 1], data[offset + 2])
        const minC = Math.min(data[offset], data[offset + 1], data[offset + 2])
        if (data[offset + 3] >= 128 && maxC - minC >= 36) coloredInk[index] = 1
      }
    }
  }
  if (!inkCount) {
    return { curves: [], junctionCrossingsResolved: 0, gridLinesFiltered: 0, warnings: ['No detectable curve ink found.'] }
  }

  const horizontalGrid = [...(options.gridLines?.horizontal ?? [])].filter(Number.isFinite)
  const verticalGrid = [...(options.gridLines?.vertical ?? [])].filter(Number.isFinite)

  // 1b. In raw dark-ink mode (unprocessed/original scan), detect and suppress axis/gridlines before thinning
  if (mode === 'dark') {
    const boxLeft = plotRegion ? regionLeft : inkMinX
    const boxRight = plotRegion ? regionRight : inkMaxX
    const boxTop = plotRegion ? regionTop : inkMinY
    const boxBottom = plotRegion ? regionBottom : inkMaxY
    const boxW = Math.max(1, boxRight - boxLeft + 1)
    const boxH = Math.max(1, boxBottom - boxTop + 1)

    const detectRawGrid = (horizontal: boolean) => {
      const pStart = horizontal ? boxTop : boxLeft
      const pEnd = horizontal ? boxBottom : boxRight
      const qStart = horizontal ? boxLeft : boxTop
      const qEnd = horizontal ? boxRight : boxBottom
      const span = horizontal ? boxW : boxH
      const maskLine = new Uint8Array(horizontal ? height : width)
      const neutralByP = new Uint32Array(horizontal ? height : width)
      const detected: number[] = []
      let runStart = -1, weighted = 0, total = 0

      for (let p = pStart; p <= pEnd + 1; p++) {
        let score = 0, neutralCount = 0, firstNeutral = -1, lastNeutral = -1, runs = 0, curRun = 0, maxRun = 0
        if (p <= pEnd) {
          for (let q = qStart; q <= qEnd; q++) {
            const idx = horizontal ? p * width + q : q * width + p
            if (ink[idx]) {
              if (coloredInk[idx]) {
                score += 0.15
                if (curRun > 0) { maxRun = Math.max(maxRun, curRun); curRun = 0 }
              } else {
                score += 1
                neutralCount++
                if (firstNeutral < 0) firstNeutral = q
                lastNeutral = q
                if (curRun === 0) runs++
                curRun++
              }
            } else if (curRun > 0) {
              maxRun = Math.max(maxRun, curRun)
              curRun = 0
            }
          }
          if (curRun > 0) maxRun = Math.max(maxRun, curRun)
          neutralByP[p] = neutralCount
        }
        const solid = score >= span * 0.35
        const dashed = !solid && runs >= 4 && firstNeutral >= 0
          && (lastNeutral - firstNeutral + 1) >= span * 0.55
          && neutralCount >= span * 0.14
          && maxRun <= span * 0.25
        if (solid || dashed) {
          if (runStart < 0) runStart = p
          const weight = solid ? score : neutralCount
          weighted += p * weight; total += weight
        } else if (runStart >= 0) {
          const center = Math.round(weighted / total)
          detected.push(center)
          for (let pos = runStart; pos <= p - 1; pos++) maskLine[pos] = 1
          if (runStart > pStart && neutralByP[runStart - 1] >= span * 0.12) maskLine[runStart - 1] = 1
          if (p <= pEnd && neutralByP[p] >= span * 0.12) maskLine[p] = 1
          runStart = -1; weighted = 0; total = 0
        }
      }
      const existing = horizontal ? horizontalGrid : verticalGrid
      for (const line of existing) {
        const pos = Math.round(line)
        if (pos >= 0 && pos < maskLine.length) {
          maskLine[pos] = 1
          if (pos > 0 && neutralByP[pos - 1] >= span * 0.12) maskLine[pos - 1] = 1
          if (pos + 1 < maskLine.length && neutralByP[pos + 1] >= span * 0.12) maskLine[pos + 1] = 1
        }
      }
      for (const pos of detected) {
        if (!existing.some((line) => Math.abs(line - pos) <= 2)) existing.push(pos)
      }
      return maskLine
    }

    const hRawMask = detectRawGrid(true)
    const vRawMask = detectRawGrid(false)
    for (let y = regionTop; y <= regionBottom; y++) {
      for (let x = regionLeft; x <= regionRight; x++) {
        const idx = y * width + x
        if (ink[idx] && (hRawMask[y] || vRawMask[x]) && !coloredInk[idx]) {
          ink[idx] = 0
          inkCount--
        }
      }
    }
    if (!inkCount) {
      return { curves: [], junctionCrossingsResolved: 0, gridLinesFiltered: horizontalGrid.length + verticalGrid.length, warnings: ['No detectable curve ink found after removing gridlines.'] }
    }
  }

  // 2. Remove tiny isolated noise blobs before thinning
  const visited = new Uint8Array(width * height)
  const bfsQueue = new Int32Array(width * height)
  const minBlobPixels = Math.max(5, Math.round(minCurveLength * 0.4))
  for (let start = 0; start < ink.length; start++) {
    if (!ink[start] || visited[start]) continue
    let head = 0, tail = 0
    bfsQueue[tail++] = start
    visited[start] = 1
    while (head < tail) {
      const current = bfsQueue[head++]
      const x = current % width, y = Math.floor(current / width)
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue
        const nx = x + dx, ny = y + dy
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue
        const next = ny * width + nx
        if (ink[next] && !visited[next]) { visited[next] = 1; bfsQueue[tail++] = next }
      }
    }
    if (tail < minBlobPixels) {
      for (let i = 0; i < tail; i++) ink[bfsQueue[i]] = 0
    }
  }

  // 3. Skeletonize to 1px centerlines
  thinBinaryInk(ink, width, height)

  const dirs = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]]
  const getInk = (x: number, y: number) => (x < 0 || y < 0 || x >= width || y >= height ? 0 : ink[y * width + x])
  const getNeighbors = (index: number) => {
    const x = index % width, y = Math.floor(index / width)
    const result: Array<{ index: number; dir: number }> = []
    for (let dir = 0; dir < 8; dir++) {
      const [dx, dy] = dirs[dir]
      if (!getInk(x + dx, y + dy)) continue
      if (dx && dy && (getInk(x + dx, y) || getInk(x, y + dy))) continue
      result.push({ index: (y + dy) * width + (x + dx), dir })
    }
    return result
  }

  // 4. Prune tiny skeleton spurs (whiskers <= 5px attached to junctions)
  const degree = new Uint8Array(width * height)
  for (let idx = 0; idx < ink.length; idx++) {
    if (ink[idx]) degree[idx] = getNeighbors(idx).length
  }
  for (let idx = 0; idx < ink.length; idx++) {
    if (!ink[idx] || degree[idx] !== 1) continue
    const chain = [idx]
    let prev = -1
    let current = idx
    while (chain.length <= 6) {
      const next = getNeighbors(current).find((neighbor) => neighbor.index !== prev)
      if (!next) break
      if (degree[next.index] >= 3) {
        if (chain.length <= 5) {
          for (const pixel of chain) { ink[pixel] = 0; degree[pixel] = 0 }
          degree[next.index] = getNeighbors(next.index).length
        }
        break
      }
      prev = current
      current = next.index
      chain.push(current)
      if (degree[current] !== 2) break
    }
  }

  // Recompute degrees after spur pruning
  degree.fill(0)
  for (let idx = 0; idx < ink.length; idx++) {
    if (ink[idx]) degree[idx] = getNeighbors(idx).length
  }

  // 5. Merge adjacent junction pixels (degree >= 3 within distance <= 3px) into Junction Clusters
  const junctionPixels: number[] = []
  for (let idx = 0; idx < ink.length; idx++) {
    if (ink[idx] && degree[idx] >= 3) junctionPixels.push(idx)
  }
  const pixelToCluster = new Map<number, number>()
  const clusters: Array<{ id: number; pixels: number[]; cx: number; cy: number }> = []
  for (const jp of junctionPixels) {
    if (pixelToCluster.has(jp)) continue
    const clusterId = clusters.length
    const members = [jp]
    pixelToCluster.set(jp, clusterId)
    for (let cursor = 0; cursor < members.length; cursor++) {
      const cur = members[cursor]
      const cx = cur % width, cy = Math.floor(cur / width)
      for (const other of junctionPixels) {
        if (pixelToCluster.has(other)) continue
        const ox = other % width, oy = Math.floor(other / width)
        if (Math.hypot(ox - cx, oy - cy) <= 3.5) {
          pixelToCluster.set(other, clusterId)
          members.push(other)
        }
      }
    }
    let sx = 0, sy = 0
    for (const m of members) { sx += (m % width) + 0.5; sy += Math.floor(m / width) + 0.5 }
    clusters.push({ id: clusterId, pixels: members, cx: sx / members.length, cy: sy / members.length })
  }

  // 6. Trace elementary branches outside junction clusters
  interface Branch {
    id: number
    points: PixelPoint[]
    startCluster: number | null
    endCluster: number | null
  }
  const usedEdges = new Uint8Array(width * height)
  const branches: Branch[] = []

  const markEdge = (from: number, dir: number, to: number) => {
    usedEdges[from] |= 1 << dir
    usedEdges[to] |= 1 << ((dir + 4) % 8)
  }

  const traceBranch = (startPixel: number, firstStep: { index: number; dir: number }) => {
    const startCluster = pixelToCluster.get(startPixel) ?? null
    const pts: PixelPoint[] = [
      startCluster !== null
        ? { x: clusters[startCluster].cx, y: clusters[startCluster].cy }
        : { x: (startPixel % width) + 0.5, y: Math.floor(startPixel / width) + 0.5 },
    ]
    let current = startPixel
    let step = firstStep
    let endCluster: number | null = null

    while (true) {
      markEdge(current, step.dir, step.index)
      current = step.index
      const hitCluster = pixelToCluster.get(current)
      if (hitCluster !== undefined) {
        endCluster = hitCluster
        pts.push({ x: clusters[hitCluster].cx, y: clusters[hitCluster].cy })
        break
      }
      pts.push({ x: (current % width) + 0.5, y: Math.floor(current / width) + 0.5 })
      const adj = getNeighbors(current)
      const unused = adj.filter((neighbor) => !(usedEdges[current] & (1 << neighbor.dir)))
      if (adj.length !== 2 || !unused.length) break
      step = unused[0]
    }
    // Skip zero-length intra-cluster hops
    if (startCluster !== null && endCluster === startCluster && pts.length <= 3) return
    branches.push({ id: branches.length, points: pts, startCluster, endCluster })
  }

  // First pass: trace from all non-degree-2 nodes (endpoints + junction pixels)
  for (let idx = 0; idx < ink.length; idx++) {
    if (!ink[idx]) continue
    const inCluster = pixelToCluster.has(idx)
    if (!inCluster && degree[idx] === 2) continue
    for (const neighbor of getNeighbors(idx)) {
      if (usedEdges[idx] & (1 << neighbor.dir)) continue
      if (inCluster && pixelToCluster.get(neighbor.index) === pixelToCluster.get(idx)) {
        markEdge(idx, neighbor.dir, neighbor.index)
        continue
      }
      traceBranch(idx, neighbor)
    }
  }
  // Second pass: trace any pure closed loops (every pixel has degree 2)
  for (let idx = 0; idx < ink.length; idx++) {
    if (!ink[idx] || degree[idx] !== 2) continue
    for (const neighbor of getNeighbors(idx)) {
      if (usedEdges[idx] & (1 << neighbor.dir)) continue
      traceBranch(idx, neighbor)
    }
  }

  // 7. Trajectory-aware pairing at each Junction Cluster
  type BranchEndKey = string // `${branchId}:start` | `${branchId}:end`
  const keyOf = (branchId: number, end: 'start' | 'end'): BranchEndKey => `${branchId}:${end}`
  const pairings = new Map<BranchEndKey, BranchEndKey>()
  let junctionCrossingsResolved = 0

  for (const cluster of clusters) {
    const incident: Array<{ branchId: number; end: 'start' | 'end'; tangent: PixelPoint }> = []
    for (const branch of branches) {
      if (branch.points.length < 3) continue
      if (branch.startCluster === cluster.id) {
        const tangent = fitOutgoingTangent(branch.points, false)
        if (tangent) incident.push({ branchId: branch.id, end: 'start', tangent })
      }
      if (branch.endCluster === cluster.id) {
        const tangent = fitOutgoingTangent(branch.points, true)
        if (tangent) incident.push({ branchId: branch.id, end: 'end', tangent })
      }
    }
    if (incident.length < 2) continue

    const pairs: Array<{ a: number; b: number; alignment: number }> = []
    for (let i = 0; i < incident.length; i++) {
      for (let j = i + 1; j < incident.length; j++) {
        if (incident[i].branchId === incident[j].branchId) continue
        // Outgoing tangents pointing in opposite directions => smooth straight-through continuation
        const alignment = -(incident[i].tangent.x * incident[j].tangent.x + incident[i].tangent.y * incident[j].tangent.y)
        if (alignment >= 0.72) pairs.push({ a: i, b: j, alignment })
      }
    }
    pairs.sort((x, y) => y.alignment - x.alignment)
    const pairedIndices = new Set<number>()
    for (const pair of pairs) {
      if (pairedIndices.has(pair.a) || pairedIndices.has(pair.b)) continue
      const ambiguous = pairs.some((other) => other !== pair
        && !pairedIndices.has(other.a) && !pairedIndices.has(other.b)
        && (other.a === pair.a || other.b === pair.a || other.a === pair.b || other.b === pair.b)
        && other.alignment > pair.alignment - 0.08)
      if (ambiguous) continue
      const keyA = keyOf(incident[pair.a].branchId, incident[pair.a].end)
      const keyB = keyOf(incident[pair.b].branchId, incident[pair.b].end)
      pairings.set(keyA, keyB)
      pairings.set(keyB, keyA)
      pairedIndices.add(pair.a)
      pairedIndices.add(pair.b)
      junctionCrossingsResolved++
    }
  }

  // 8. Chain paired branches into continuous curves
  const visitedBranches = new Set<number>()
  const stitched: PixelPoint[][] = []

  const followChain = (startBranchId: number, initialDirection: 'forward' | 'backward') => {
    const chain: PixelPoint[] = []
    let branchId: number | null = startBranchId
    let direction: 'forward' | 'backward' = initialDirection
    while (branchId !== null && !visitedBranches.has(branchId)) {
      visitedBranches.add(branchId)
      const branch = branches[branchId]
      const segment = direction === 'forward' ? branch.points : [...branch.points].reverse()
      if (!chain.length) chain.push(...segment)
      else chain.push(...segment.slice(1))
      const exitEnd: 'start' | 'end' = direction === 'forward' ? 'end' : 'start'
      const nextKey = pairings.get(keyOf(branchId, exitEnd))
      if (!nextKey) break
      const [nextIdStr, enterEnd] = nextKey.split(':') as [string, 'start' | 'end']
      branchId = Number(nextIdStr)
      direction = enterEnd === 'start' ? 'forward' : 'backward'
    }
    return chain
  }

  // Start from open (unpaired) branch ends first
  for (const branch of branches) {
    if (visitedBranches.has(branch.id)) continue
    const startPaired = pairings.has(keyOf(branch.id, 'start'))
    const endPaired = pairings.has(keyOf(branch.id, 'end'))
    if (!startPaired) stitched.push(followChain(branch.id, 'forward'))
    else if (!endPaired) stitched.push(followChain(branch.id, 'backward'))
  }
  // Remaining closed loops of paired branches
  for (const branch of branches) {
    if (!visitedBranches.has(branch.id)) stitched.push(followChain(branch.id, 'forward'))
  }

  // 8b. Helper to identify gridline, axis, or plot-frame candidates
  const plotW = plotRegion ? Math.max(1, plotRegion.width) : Math.max(1, inkMaxX - inkMinX + 1)
  const plotH = plotRegion ? Math.max(1, plotRegion.height) : Math.max(1, inkMaxY - inkMinY + 1)
  let gridLinesFiltered = 0

  const filterGridCandidates = (candidates: PixelPoint[][], strictOnly: boolean) => {
    const metaList = candidates.map((raw) => {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
      let sumX = 0, sumY = 0
      for (const pt of raw) {
        if (pt.x < minX) minX = pt.x
        if (pt.x > maxX) maxX = pt.x
        if (pt.y < minY) minY = pt.y
        if (pt.y > maxY) maxY = pt.y
        sumX += pt.x
        sumY += pt.y
      }
      const xSpan = maxX - minX
      const ySpan = maxY - minY
      const midX = raw.length ? sumX / raw.length : 0
      const midY = raw.length ? sumY / raw.length : 0
      const strictHorizontal = xSpan >= 18 && ySpan <= Math.max(2.5, xSpan * 0.015)
      const strictVertical = ySpan >= 18 && xSpan <= Math.max(2.5, ySpan * 0.015)
      return { raw, minX, maxX, minY, maxY, xSpan, ySpan, midX, midY, strictHorizontal, strictVertical }
    })

    const distinctParallelCount = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b)
      let groups = 0
      let last = -Infinity
      for (const value of sorted) {
        if (value - last >= 4) { groups++; last = value }
      }
      return groups
    }
    const parallelHorizontalCount = distinctParallelCount(
      metaList.filter((m) => m.strictHorizontal && m.xSpan >= plotW * 0.30).map((m) => m.midY),
    )
    const parallelVerticalCount = distinctParallelCount(
      metaList.filter((m) => m.strictVertical && m.ySpan >= plotH * 0.30).map((m) => m.midX),
    )

    const kept: PixelPoint[][] = []
    for (const meta of metaList) {
      let isGrid = false
      // 1) Hugs a known/detected horizontal or vertical gridline
      if (horizontalGrid.length && meta.ySpan <= 6 && meta.xSpan >= 8) {
        for (const lineY of horizontalGrid) {
          let onLine = 0
          for (const pt of meta.raw) if (Math.abs(pt.y - lineY) <= 4) onLine++
          if (onLine / meta.raw.length >= 0.82) { isGrid = true; break }
        }
      }
      if (!isGrid && verticalGrid.length && meta.xSpan <= 6 && meta.ySpan >= 8) {
        for (const lineX of verticalGrid) {
          let onLine = 0
          for (const pt of meta.raw) if (Math.abs(pt.x - lineX) <= 4) onLine++
          if (onLine / meta.raw.length >= 0.82) { isGrid = true; break }
        }
      }
      // 2) Undetected axis-aligned gridline / plot border / parallel grid family
      if (!isGrid && !strictOnly && meta.strictHorizontal) {
        if (meta.xSpan >= plotW * 0.65 || (parallelHorizontalCount >= 2 && meta.xSpan >= plotW * 0.30)) {
          isGrid = true
        } else {
          const collinearSpan = metaList
            .filter((other) => other.strictHorizontal && Math.abs(other.midY - meta.midY) <= 3.5)
            .reduce((sum, other) => sum + other.xSpan, 0)
          if (collinearSpan >= plotW * 0.45) isGrid = true
        }
      }
      if (!isGrid && !strictOnly && meta.strictVertical) {
        if (meta.ySpan >= plotH * 0.65 || (parallelVerticalCount >= 2 && meta.ySpan >= plotH * 0.30)) {
          isGrid = true
        } else {
          const collinearSpan = metaList
            .filter((other) => other.strictVertical && Math.abs(other.midX - meta.midX) <= 3.5)
            .reduce((sum, other) => sum + other.ySpan, 0)
          if (collinearSpan >= plotH * 0.45) isGrid = true
        }
      }
      if (isGrid) gridLinesFiltered++
      else kept.push(meta.raw)
    }
    return kept
  }

  // 9. Remove known-gridline remnants first, then bridge short clean gaps between compatible facing endpoints
  const curvesRaw = filterGridCandidates(
    stitched.filter((curve) => pathArcLength(curve) >= Math.max(4, minCurveLength * 0.45)),
    true,
  )
  const sameEndpoint = (i1: number, e1: boolean, i2: number, e2: boolean) => i1 === i2 && e1 === e2
  if (maxGap > 0) {
    while (curvesRaw.length > 1) {
      type GapCandidate = { a: number; aEnd: boolean; b: number; bEnd: boolean; score: number }
      const gapCandidates: GapCandidate[] = []
      for (let i = 0; i < curvesRaw.length; i++) {
        for (let j = i + 1; j < curvesRaw.length; j++) {
          for (const aEnd of [false, true]) {
            const pA = aEnd ? curvesRaw[i][curvesRaw[i].length - 1] : curvesRaw[i][0]
            const tA = fitOutgoingTangent(curvesRaw[i], aEnd)
            if (!tA) continue
            for (const bEnd of [false, true]) {
              const pB = bEnd ? curvesRaw[j][curvesRaw[j].length - 1] : curvesRaw[j][0]
              const dx = pB.x - pA.x, dy = pB.y - pA.y
              const dist = Math.hypot(dx, dy)
              if (dist < 1 || dist > maxGap) continue
              const tB = fitOutgoingTangent(curvesRaw[j], bEnd)
              if (!tB) continue
              // Outgoing tangent at pA points AWAY from the curve end => (-tA) points into the gap toward pB!
              const forward = (-tA.x * dx - tA.y * dy) / dist
              const backward = (-tB.x * (-dx) - tB.y * (-dy)) / dist
              const tangentAlign = -(tA.x * tB.x + tA.y * tB.y)
              const crossesGrid = dist <= 12 && (
                horizontalGrid.some((lineY) => lineY >= Math.min(pA.y, pB.y) - 3 && lineY <= Math.max(pA.y, pB.y) + 3)
                || verticalGrid.some((lineX) => lineX >= Math.min(pA.x, pB.x) - 3 && lineX <= Math.max(pA.x, pB.x) + 3)
              )
              const minProgress = dist <= 4 ? 0.25 : crossesGrid ? 0.45 : dist <= 8 ? 0.55 : 0.80
              if (forward < minProgress || backward < minProgress || tangentAlign < 0.78) continue
              const errA = Math.abs(dx * (-tA.y) - dy * (-tA.x))
              const errB = Math.abs((-dx) * (-tB.y) - (-dy) * (-tB.x))
              const maxErr = (crossesGrid ? 6 : dist <= 8 ? 4 : 3) + dist * 0.12
              if (errA > maxErr || errB > maxErr) continue
              gapCandidates.push({ a: i, aEnd, b: j, bEnd, score: dist * 0.35 + errA + errB + (2 - forward - backward) * 10 + (1 - tangentAlign) * 8 })
            }
          }
        }
      }
      gapCandidates.sort((x, y) => x.score - y.score)
      const best = gapCandidates.find((candidate) => !gapCandidates.some((other) => other !== candidate
        && (sameEndpoint(other.a, other.aEnd, candidate.a, candidate.aEnd)
          || sameEndpoint(other.b, other.bEnd, candidate.a, candidate.aEnd)
          || sameEndpoint(other.a, other.aEnd, candidate.b, candidate.bEnd)
          || sameEndpoint(other.b, other.bEnd, candidate.b, candidate.bEnd))
        && other.score < candidate.score + 2))
      if (!best) break
      const first = best.aEnd ? curvesRaw[best.a] : [...curvesRaw[best.a]].reverse()
      const second = best.bEnd ? [...curvesRaw[best.b]].reverse() : curvesRaw[best.b]
      curvesRaw[best.a] = [...first, ...second]
      curvesRaw.splice(best.b, 1)
    }
  }

  // 9b. Final gridline/border filter after gap bridging
  const filteredCurves = filterGridCandidates(curvesRaw, false)

  // 10. Filter short noise, orient consistently, curvature-adaptively sample, and sub-pixel refine
  const finalCurves: PixelPoint[][] = []
  for (const raw of filteredCurves) {
    if (pathArcLength(raw) < minCurveLength) continue
    const first = raw[0], last = raw[raw.length - 1]
    const dx = last.x - first.x, dy = last.y - first.y
    const oriented = Math.abs(dx) >= Math.abs(dy)
      ? (dx < 0 ? [...raw].reverse() : raw)
      : (dy < 0 ? [...raw].reverse() : raw)

    const sampled = smartSampleCurvePoints(oriented, { spacing, curvatureBias, preserveExtrema: true })
    if (sampled.length < 2) continue

    const refined = sampled.map((pt) => {
      const snapped = snapPointToCurveCenter(image, pt, { mode, radius: 3.5, curveColor, tolerance, scorePixel })
      return snapped ? snapped.point : pt
    })
    finalCurves.push(refined)
  }

  // Sort curves cleanly top-to-bottom, then left-to-right
  finalCurves.sort((a, b) => {
    const midA = a[Math.floor(a.length / 2)]
    const midB = b[Math.floor(b.length / 2)]
    return Math.abs(midA.y - midB.y) > 8 ? midA.y - midB.y : a[0].x - b[0].x
  })

  const warnings: string[] = []
  if (!finalCurves.length) warnings.push('No curves long enough to extract were found.')
  return { curves: finalCurves, junctionCrossingsResolved, gridLinesFiltered, warnings }
}
