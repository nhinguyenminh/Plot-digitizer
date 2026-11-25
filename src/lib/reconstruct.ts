import type { PixelPoint } from './digitizer'
import type { GridGuides } from './image-processing'
import { thinBinaryInk } from './skeleton.ts'

export interface PlotRegion { x: number; y: number; width: number; height: number }
export type CorrectionLayer = 'curve' | 'grid'
export interface Correction { points: PixelPoint[]; erase: boolean; layer?: CorrectionLayer; width?: number }
export interface ReconstructionColors { curve: string; grid: string; axis: string }
export interface ReconstructionWidths { curve: number; grid: number }
export const ERASER_WIDTH = 12
export const ERASER_MIN_WIDTH = 2
export const ERASER_MAX_WIDTH = 72
export interface AxisGuides { horizontal: number | null; vertical: number | null }
export interface ReconstructionOptions { regularGrid: boolean; axisGuides: AxisGuides }
export interface Reconstruction {
  width: number
  height: number
  region: PlotRegion
  horizontal: number[]
  vertical: number[]
  curves: PixelPoint[][]
  estimatedCurves?: number[]
  learnedCorrections?: Correction[]
  horizontalAxis?: number
  verticalAxis?: number
}

export function detectReconstruction(image: ImageData, region: PlotRegion, guides: GridGuides, options: ReconstructionOptions = { regularGrid: false, axisGuides: { horizontal: null, vertical: null } }): Reconstruction {
  const { width, height, data } = image
  if (![region.x, region.y, region.width, region.height].every(Number.isFinite)) throw new Error('Invalid plot region.')
  const left = Math.max(0, Math.ceil(region.x))
  const top = Math.max(0, Math.ceil(region.y))
  const right = Math.min(width - 1, Math.floor(region.x + region.width))
  const bottom = Math.min(height - 1, Math.floor(region.y + region.height))
  const w = right - left + 1
  const h = bottom - top + 1
  if (w < 20 || h < 20) throw new Error('Select a plot region at least 20 pixels wide and high.')
  if (w * h > 4_000_000) throw new Error('Select a smaller region or resize the image below 4 megapixels.')
  const histogram = new Uint32Array(256)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const source = ((top + y) * width + left + x) * 4
    const alpha = data[source + 3] / 255
    const level = Math.round(255 - (255 - Math.min(data[source], data[source + 1], data[source + 2])) * alpha)
    histogram[Math.max(0, Math.min(255, level))]++
  }
  const targetRank = Math.floor(w * h * 0.85)
  let cumulative = 0
  let paperLevel = 255
  for (let level = 0; level < 256; level++) {
    cumulative += histogram[level]
    if (cumulative >= targetRank) { paperLevel = level; break }
  }
  const inkThreshold = paperLevel >= 245 ? 185 : Math.max(120, Math.min(185, paperLevel - 55))

  const ink = new Uint8Array(w * h)
  const coloredCurve = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const source = ((top + y) * width + left + x) * 4
    const alpha = data[source + 3] / 255
    const minChannel = Math.min(data[source], data[source + 1], data[source + 2])
    const maxChannel = Math.max(data[source], data[source + 1], data[source + 2])
    if (255 - (255 - minChannel) * alpha < inkThreshold) {
      const idx = y * w + x
      ink[idx] = 1
      if (alpha >= 0.5 && maxChannel - minChannel >= 32) coloredCurve[idx] = 1
    }
  }
  const findLines = (horizontal: boolean, manual: number[], axis: number | null) => {
    const length = horizontal ? h : w
    const span = horizontal ? w : h
    const rowNeutral = new Uint32Array(length)
    const rowTinted = new Uint8Array(length)
    const candidates: { position: number; start: number; end: number; strength: number }[] = []
    const tintedCandidates: { position: number; start: number; end: number; strength: number }[] = []
    let start = -1; let weighted = 0; let total = 0
    let tintedStart = -1; let tintedWeighted = 0; let tintedTotal = 0
    for (let p = 0; p <= length; p++) {
      let score = 0
      let neutralCount = 0
      let rawCount = 0
      let firstNeutral = -1
      let lastNeutral = -1
      let neutralRuns = 0
      let currentRun = 0
      let maxNeutralRun = 0
      if (p < length) {
        for (let q = 0; q < span; q++) {
          const idx = horizontal ? p * w + q : q * w + p
          if (ink[idx]) {
            rawCount++
            if (coloredCurve[idx]) {
              score += 0.15
              if (currentRun > 0) { maxNeutralRun = Math.max(maxNeutralRun, currentRun); currentRun = 0 }
            } else {
              score += 1
              neutralCount++
              if (firstNeutral < 0) firstNeutral = q
              lastNeutral = q
              if (currentRun === 0) neutralRuns++
              currentRun++
            }
          } else if (currentRun > 0) {
            maxNeutralRun = Math.max(maxNeutralRun, currentRun)
            currentRun = 0
          }
        }
        if (currentRun > 0) maxNeutralRun = Math.max(maxNeutralRun, currentRun)
        rowNeutral[p] = neutralCount
      }
      const isSolidLine = score >= span * 0.35
      const isDashedLine = !isSolidLine
        && neutralRuns >= 4
        && firstNeutral >= 0
        && (lastNeutral - firstNeutral + 1) >= span * 0.55
        && neutralCount >= span * 0.14
        && maxNeutralRun <= span * 0.25
      if (isSolidLine || isDashedLine) {
        if (start < 0) start = p
        const weight = isSolidLine ? score : neutralCount
        weighted += p * weight; total += weight
      } else if (start >= 0) {
        candidates.push({ position: Math.round(weighted / total), start, end: p - 1, strength: total })
        start = -1; weighted = 0; total = 0
      }

      const isTintedFullLine = !isSolidLine && !isDashedLine && rawCount >= span * 0.65
      if (isTintedFullLine) {
        if (tintedStart < 0) tintedStart = p
        tintedWeighted += p * rawCount; tintedTotal += rawCount
      } else if (tintedStart >= 0) {
        tintedCandidates.push({ position: Math.round(tintedWeighted / tintedTotal), start: tintedStart, end: p - 1, strength: tintedTotal })
        tintedStart = -1; tintedWeighted = 0; tintedTotal = 0
      }
    }
    if (tintedCandidates.length >= 2) {
      for (const candidate of tintedCandidates) {
        candidates.push(candidate)
        for (let position = candidate.start; position <= candidate.end; position++) rowTinted[position] = 1
      }
      candidates.sort((a, b) => a.position - b.position)
    }
    const min = horizontal ? top : left
    const max = horizontal ? bottom : right
    const valid = [...new Set(manual.filter((value) => Number.isFinite(value) && value >= min && value <= max).map(Math.round))].sort((a, b) => a - b)
    if (options.regularGrid && manual.length >= 2 && valid.length !== manual.length) throw new Error(`${horizontal ? 'Horizontal' : 'Vertical'} guides must be distinct and inside the plot area.`)
    if (axis !== null && (!Number.isFinite(axis) || axis < min || axis > max)) throw new Error(`The ${horizontal ? 'X' : 'Y'} axis guide must be inside the plot area.`)
    const mask = new Uint8Array(length)
    for (const candidate of candidates) {
      for (let position = candidate.start; position <= candidate.end; position++) mask[position] = 1
      if (candidate.start > 0 && rowNeutral[candidate.start - 1] >= span * 0.12) mask[candidate.start - 1] = 1
      if (candidate.end + 1 < length && rowNeutral[candidate.end + 1] >= span * 0.12) mask[candidate.end + 1] = 1
    }
    for (const line of valid) mask[line - min] = 1
    if (axis !== null) mask[Math.round(axis) - min] = 1
    let lines = [...candidates.map((candidate) => candidate.position + min).filter((line) => !valid.some((value) => Math.abs(value - line) <= 3)), ...valid].sort((a, b) => a - b)
    let axisTolerance = 3
    if (options.regularGrid && valid.length >= 2) {
      const step = (valid[valid.length - 1] - valid[0]) / (valid.length - 1)
      if (step < 3) throw new Error(`${horizontal ? 'Horizontal' : 'Vertical'} guides must be at least 3 pixels apart.`)
      if (valid.some((value, index) => Math.abs(value - (valid[0] + index * step)) > Math.max(1.5, step * 0.1))) {
        throw new Error(`${horizontal ? 'Horizontal' : 'Vertical'} guides must mark consecutive, evenly spaced grid lines.`)
      }
      const firstIndex = Math.ceil((min - valid[0]) / step - 1e-9)
      const lastIndex = Math.floor((max - valid[0]) / step + 1e-9)
      if (lastIndex - firstIndex + 1 > 2000) throw new Error('Too many grid lines. Select a smaller plot area or check the guide spacing.')
      lines = Array.from({ length: lastIndex - firstIndex + 1 }, (_, index) => valid[0] + (firstIndex + index) * step)
      axisTolerance = step / 2 + 1e-9
    }
    if (axis !== null) {
      let nearest = -1
      for (let index = 0; index < lines.length; index++) {
        if (Math.abs(lines[index] - axis) <= axisTolerance && (nearest < 0 || Math.abs(lines[index] - axis) < Math.abs(lines[nearest] - axis))) nearest = index
      }
      if (nearest >= 0) lines.splice(nearest, 1)
      lines.push(axis)
      lines.sort((a, b) => a - b)
    }
    for (const line of lines) {
      const local = Math.round(line) - min
      if (local >= 0 && local < length) {
        mask[local] = 1
        if (local > 0 && rowNeutral[local - 1] >= span * 0.12) mask[local - 1] = 1
        if (local + 1 < length && rowNeutral[local + 1] >= span * 0.12) mask[local + 1] = 1
      }
    }
    let inferredAxis = horizontal ? lines[lines.length - 1] : lines[0]
    if (axis === null && lines.length >= 3 && candidates.length >= 3) {
      const strengthAt = (linePos: number) => candidates.find((candidate) => Math.abs(candidate.position + min - linePos) <= 3)?.strength ?? 0
      const outer = horizontal ? lines[lines.length - 1] : lines[0]
      const inner = horizontal ? lines[lines.length - 2] : lines[1]
      if (strengthAt(inner) > strengthAt(outer) * 1.55) inferredAxis = inner
    }
    return {
      lines,
      mask,
      tintedMask: rowTinted,
      inferredAxis,
    }
  }
  const horizontalResult = findLines(true, guides.horizontal, options.axisGuides.horizontal)
  const verticalResult = findLines(false, guides.vertical, options.axisGuides.vertical)
  const horizontal = horizontalResult.lines
  const vertical = verticalResult.lines
  const hMask = horizontalResult.mask
  const vMask = verticalResult.mask
  const hTinted = horizontalResult.tintedMask
  const vTinted = verticalResult.tintedMask
  const sampleTintedLineColor = (horizontalLine: boolean, p: number): [number, number, number] | null => {
    const span = horizontalLine ? w : h
    let sr = 0, sg = 0, sb = 0, count = 0
    for (let q = 0; q < span; q++) {
      const idx = horizontalLine ? p * w + q : q * w + p
      if (!ink[idx]) continue
      const source = ((top + (horizontalLine ? p : q)) * width + left + (horizontalLine ? q : p)) * 4
      sr += data[source]; sg += data[source + 1]; sb += data[source + 2]; count++
    }
    return count ? [sr / count, sg / count, sb / count] : null
  }
  const hTintedColor = new Map<number, [number, number, number]>()
  const vTintedColor = new Map<number, [number, number, number]>()
  for (let y = 0; y < h; y++) if (hTinted[y]) { const rgb = sampleTintedLineColor(true, y); if (rgb) hTintedColor.set(y, rgb) }
  for (let x = 0; x < w; x++) if (vTinted[x]) { const rgb = sampleTintedLineColor(false, x); if (rgb) vTintedColor.set(x, rgb) }
  // Clear neutral grid pixels (and matching tinted grid pixels) while keeping contrasting colored curves intact.
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const idx = y * w + x
    if (!ink[idx]) continue
    if ((hMask[y] || vMask[x]) && !coloredCurve[idx]) { ink[idx] = 0; continue }
    const tintedRgb = hTintedColor.get(y) ?? vTintedColor.get(x)
    if (tintedRgb) {
      const source = ((top + y) * width + left + x) * 4
      if (Math.hypot(data[source] - tintedRgb[0], data[source + 1] - tintedRgb[1], data[source + 2] - tintedRgb[2]) <= 45) {
        ink[idx] = 0
      }
    }
  }

  const visited = new Uint8Array(w * h)
  const queue = new Int32Array(w * h)
  const minimumExtent = Math.max(12, Math.round(Math.min(w, h) * 0.06))
  const outerHorizontal = horizontal.length >= 2 && vertical.length >= 2 ? [horizontal[0] - top, horizontal[horizontal.length - 1] - top] : []
  const outerVertical = horizontal.length >= 2 && vertical.length >= 2 ? [vertical[0] - left, vertical[vertical.length - 1] - left] : []
  for (let start = 0; start < ink.length; start++) {
    if (!ink[start] || visited[start]) continue
    let head = 0; let tail = 0
    let minX = start % w; let maxX = minX; let minY = Math.floor(start / w); let maxY = minY
    let touchesGrid = false
    queue[tail++] = start; visited[start] = 1
    while (head < tail) {
      const current = queue[head++]; const x = current % w; const y = Math.floor(current / w)
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y)
      if ((x > 0 && vMask[x - 1]) || (x + 1 < w && vMask[x + 1]) || (y > 0 && hMask[y - 1]) || (y + 1 < h && hMask[y + 1])) touchesGrid = true
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx; const ny = y + dy
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue
        const next = ny * w + nx
        if (ink[next] && !visited[next]) { visited[next] = 1; queue[tail++] = next }
      }
    }
    const extent = Math.hypot(maxX - minX, maxY - minY)
    const bboxW = maxX - minX + 1
    const bboxH = maxY - minY + 1
    const compactGlyph = !touchesGrid && bboxW <= 14 && bboxH <= 14 && tail / (bboxW * bboxH) >= 0.45 && Math.max(bboxW, bboxH) <= minimumExtent * 1.15
    const edgeTick = touchesGrid && (
      (maxX - minX <= 3 && maxY - minY <= 12 && outerHorizontal.some((line) => Math.min(Math.abs(minY - line), Math.abs(maxY - line)) <= 5))
      || (maxY - minY <= 3 && maxX - minX <= 12 && outerVertical.some((line) => Math.min(Math.abs(minX - line), Math.abs(maxX - line)) <= 5))
    )
    if (edgeTick || compactGlyph || (extent < minimumExtent && !(touchesGrid && extent >= 6))) {
      for (let index = 0; index < tail; index++) ink[queue[index]] = 0
    }
  }

  thinBinaryInk(ink, w, h)
  const get = (x: number, y: number) => x < 0 || y < 0 || x >= w || y >= h ? 0 : ink[y * w + x]

  const directions = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]]
  const neighbors = (index: number) => {
    const x = index % w; const y = Math.floor(index / w)
    return directions.flatMap(([dx, dy], direction) => {
      if (!get(x + dx, y + dy) || (dx && dy && (get(x + dx, y) || get(x, y + dy)))) return []
      return [{ index: (y + dy) * w + x + dx, direction }]
    })
  }
  const edges = new Uint8Array(w * h)
  const curves: PixelPoint[][] = []
  const walk = (start: number, initial: { index: number; direction: number }) => {
    const path: PixelPoint[] = [{ x: left + start % w, y: top + Math.floor(start / w) }]
    let current = start; let next = initial
    while (true) {
      edges[current] |= 1 << next.direction
      edges[next.index] |= 1 << ((next.direction + 4) % 8)
      current = next.index
      path.push({ x: left + current % w, y: top + Math.floor(current / w) })
      const adjacent = neighbors(current)
      const unused = adjacent.filter(({ direction }) => !(edges[current] & (1 << direction)))
      if (adjacent.length !== 2 || !unused.length) break
      next = unused[0]
    }
    curves.push(path)
  }
  for (let pass = 0; pass < 2; pass++) for (let index = 0; index < ink.length; index++) {
    if (!ink[index]) continue
    const adjacent = neighbors(index)
    if (pass === 0 && adjacent.length === 2) continue
    for (const next of adjacent) if (!(edges[index] & (1 << next.direction))) walk(index, next)
  }
  const gridResidue = (path: PixelPoint[]) => {
    let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity
    for (const point of path) {
      minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x)
      minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y)
    }
    const xSpan = maxX - minX; const ySpan = maxY - minY
    return (xSpan >= 6 && ySpan <= 1 && horizontal.some((line) => line >= maxY - 4 && line <= minY + 4))
      || (ySpan >= 6 && xSpan <= 1 && vertical.some((line) => line >= maxX - 4 && line <= minX + 4))
      || (xSpan >= 80 && ySpan <= Math.min(6, xSpan * 0.04) && horizontal.some((line) => line >= maxY - 8 && line <= minY + 8))
      || (ySpan >= 80 && xSpan <= Math.min(6, ySpan * 0.04) && vertical.some((line) => line >= maxX - 8 && line <= minX + 8))
  }
  const component = new Int32Array(w * h).fill(-1)
  let componentCount = 0
  for (let start = 0; start < ink.length; start++) {
    if (!ink[start] || component[start] !== -1) continue
    let head = 0; let tail = 0
    queue[tail++] = start; component[start] = componentCount
    while (head < tail) for (const neighbor of neighbors(queue[head++])) {
      if (component[neighbor.index] === -1) { component[neighbor.index] = componentCount; queue[tail++] = neighbor.index }
    }
    componentCount++
  }
  const strictAttachedGridResidue = (path: PixelPoint[]) => {
    let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity
    for (const point of path) {
      minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x)
      minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y)
    }
    const xSpan = maxX - minX; const ySpan = maxY - minY
    return (xSpan >= 20 && ySpan <= 1 && horizontal.some((line) => line >= maxY - 3 && line <= minY + 3))
      || (ySpan >= 20 && xSpan <= 1 && vertical.some((line) => line >= maxX - 3 && line <= minX + 3))
  }
  const componentOf = (path: PixelPoint[]) => component[(path[0].y - top) * w + path[0].x - left]
  const curveComponents = new Set(curves.filter((path) => !gridResidue(path)).map(componentOf))
  const residuePixels = new Set<number>()
  for (let index = curves.length - 1; index >= 0; index--) {
    const path = curves[index]
    if (!gridResidue(path)) continue
    if (curveComponents.has(componentOf(path)) && !strictAttachedGridResidue(path)) continue
    for (const point of path) {
      const pixel = (point.y - top) * w + point.x - left
      if (neighbors(pixel).length <= 2) residuePixels.add(pixel)
    }
    curves.splice(index, 1)
  }
  for (const pixel of residuePixels) ink[pixel] = 0
  const endpoints: { point: PixelPoint; dx: number; dy: number }[] = []
  for (const path of curves) {
    if (path.length < 3) continue
    for (const reverse of [false, true]) {
      const end = reverse ? path[path.length - 1] : path[0]
      const interior = reverse ? path[Math.max(0, path.length - 5)] : path[Math.min(path.length - 1, 4)]
      const index = (end.y - top) * w + end.x - left
      if (neighbors(index).length !== 1) continue
      const length = Math.hypot(end.x - interior.x, end.y - interior.y)
      if (length) endpoints.push({ point: end, dx: (end.x - interior.x) / length, dy: (end.y - interior.y) / length })
    }
  }
  const used = new Set<number>()
  const estimatedCurves: number[] = []
  const bridgeLines = (mask: Uint8Array, origin: number, horizontalLine: boolean) => {
    for (let start = 0; start < mask.length;) {
      if (!mask[start]) { start++; continue }
      let end = start
      while (end + 1 < mask.length && mask[end + 1]) end++
      const before: number[] = []; const after: number[] = []
      endpoints.forEach(({ point }, index) => {
        const coordinate = (horizontalLine ? point.y : point.x) - origin
        if (coordinate < start && start - coordinate <= 6) before.push(index)
        if (coordinate > end && coordinate - end <= 6) after.push(index)
      })
      const connect = (firstGroup: number[], secondGroup: number[], touchingSide: number | null) => {
        const candidates: { a: number; b: number; score: number }[] = []
        for (let firstIndex = 0; firstIndex < firstGroup.length; firstIndex++) for (let secondIndex = 0; secondIndex < secondGroup.length; secondIndex++) {
          if (touchingSide !== null && secondIndex <= firstIndex) continue
          const a = firstGroup[firstIndex]; const b = secondGroup[secondIndex]
          if (used.has(a) || used.has(b)) continue
          const first = endpoints[a]; const second = endpoints[b]
          if (touchingSide !== null) {
            const firstCoordinate = (horizontalLine ? first.point.y : first.point.x) - origin
            const secondCoordinate = (horizontalLine ? second.point.y : second.point.x) - origin
            const edge = touchingSide < 0 ? start : end
            if (Math.abs(firstCoordinate - edge) > 2 || Math.abs(secondCoordinate - edge) > 2) continue
            const firstNormal = (horizontalLine ? first.dy : first.dx) * -touchingSide
            const secondNormal = (horizontalLine ? second.dy : second.dx) * -touchingSide
            if (firstNormal < -0.1 || secondNormal < -0.1 || Math.max(firstNormal, secondNormal) < 0.1) continue
          }
          const dx = second.point.x - first.point.x; const dy = second.point.y - first.point.y
          const distance = Math.hypot(dx, dy)
          if (!distance || distance > 40) continue
          const forward = (dx * first.dx + dy * first.dy) / distance
          const backward = (-dx * second.dx - dy * second.dy) / distance
          const firstError = Math.abs(dx * first.dy - dy * first.dx)
          const secondError = Math.abs(dx * second.dy - dy * second.dx)
          if (forward < 0.7 || backward < 0.7 || firstError > 2.5 + distance * 0.12 || secondError > 2.5 + distance * 0.12) continue
          candidates.push({ a, b, score: firstError + secondError + distance * (2 - forward - backward) })
        }
        candidates.sort((a, b) => a.score - b.score)
        for (const candidate of candidates) {
          if (used.has(candidate.a) || used.has(candidate.b)) continue
          if (candidates.some((other) => other !== candidate && !used.has(other.a) && !used.has(other.b)
            && (other.a === candidate.a || other.b === candidate.b || other.a === candidate.b || other.b === candidate.a) && other.score < candidate.score + 1)) continue
          const first = endpoints[candidate.a].point; const second = endpoints[candidate.b].point
          estimatedCurves.push(curves.length)
          if (touchingSide === null) curves.push([first, second])
          else {
            const grid = origin + (touchingSide < 0 ? start : end)
            const control = horizontalLine
              ? { x: (first.x + second.x) / 2, y: 2 * grid - (first.y + second.y) / 2 }
              : { x: 2 * grid - (first.x + second.x) / 2, y: (first.y + second.y) / 2 }
            curves.push(Array.from({ length: 9 }, (_, index) => {
              const t = index / 8
              return { x: (1 - t) ** 2 * first.x + 2 * (1 - t) * t * control.x + t ** 2 * second.x,
                y: (1 - t) ** 2 * first.y + 2 * (1 - t) * t * control.y + t ** 2 * second.y }
            }))
          }
          used.add(candidate.a); used.add(candidate.b)
        }
      }
      connect(before, after, null)
      for (const [side, group] of [[-1, before], [1, after]] as const) {
        const ordered = [...group].sort((a, b) => horizontalLine ? endpoints[a].point.x - endpoints[b].point.x : endpoints[a].point.y - endpoints[b].point.y)
        connect(ordered, ordered, side)
      }
      start = end + 1
    }
  }
  bridgeLines(vMask, left, false)
  bridgeLines(hMask, top, true)
  return { width, height, region: { x: left, y: top, width: right - left, height: bottom - top }, horizontal, vertical, curves, estimatedCurves,
    horizontalAxis: options.axisGuides.horizontal ?? horizontalResult.inferredAxis, verticalAxis: options.axisGuides.vertical ?? verticalResult.inferredAxis }
}

export type UpscaleSetting = { preset: 'original' | 'hd' | 'fullhd' | 'custom'; longEdge: number }

export function reconstructionDimensions(width: number, height: number, setting: UpscaleSetting) {
  const factor = setting.preset === 'hd' ? Math.max(1, 1280 / width, 720 / height)
    : setting.preset === 'fullhd' ? Math.max(1, 1920 / width, 1080 / height)
    : setting.preset === 'custom' ? Math.max(1, setting.longEdge / Math.max(width, height)) : 1
  const result = { width: Math.ceil(width * factor), height: Math.ceil(height * factor) }
  if (result.width * result.height > 16_000_000) throw new Error('Upscaled image exceeds 16 megapixels. Choose a smaller size.')
  return result
}

function smoothPixelPath(path: PixelPoint[]): PixelPoint[] {
  if (path.length < 4 || path.some((point, index) =>
    !Number.isInteger(point.x) || !Number.isInteger(point.y)
    || (index > 0 && Math.hypot(point.x - path[index - 1].x, point.y - path[index - 1].y) > Math.SQRT2 + 1e-6))) return path
  const weights = [1, 8, 28, 56, 70, 56, 28, 8, 1]
  return path.map((point, index) => {
    if (index === 0 || index === path.length - 1) return point
    let x = 0, y = 0
    for (let offset = -4; offset <= 4; offset++) {
      const neighbor = path[Math.max(0, Math.min(path.length - 1, index + offset))]
      const weight = weights[offset + 4] / 256
      x += neighbor.x * weight; y += neighbor.y * weight
    }
    const dx = x - point.x, dy = y - point.y
    const distance = Math.hypot(dx, dy)
    const factor = distance > 0.5 ? 0.5 / distance : 1
    return { x: point.x + dx * factor, y: point.y + dy * factor }
  })
}

function renderReconstructionLayers(geometry: Reconstruction, corrections: Correction[], colors: ReconstructionColors, widths: ReconstructionWidths, output = { width: geometry.width, height: geometry.height }) {
  const r = geometry.region
  const createLayer = () => {
    const layer = document.createElement('canvas')
    layer.width = output.width; layer.height = output.height
    const ctx = layer.getContext('2d')
    if (!ctx) throw new Error('This browser cannot process the image.')
    if (output.width !== geometry.width || output.height !== geometry.height) ctx.scale(output.width / geometry.width, output.height / geometry.height)
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'
    ctx.save()
    ctx.beginPath(); ctx.rect(r.x, r.y, r.width, r.height); ctx.clip()
    return { canvas: layer, context: ctx }
  }
  const grid = createLayer()
  const curve = createLayer()
  const gridContext = grid.context
  const curveContext = curve.context
  gridContext.lineWidth = widths.grid
  for (const y of geometry.horizontal) { gridContext.strokeStyle = y === (geometry.horizontalAxis ?? geometry.horizontal[geometry.horizontal.length - 1]) ? colors.axis : colors.grid; gridContext.beginPath(); gridContext.moveTo(r.x, y); gridContext.lineTo(r.x + r.width, y); gridContext.stroke() }
  for (const x of geometry.vertical) { gridContext.strokeStyle = x === (geometry.verticalAxis ?? geometry.vertical[0]) ? colors.axis : colors.grid; gridContext.beginPath(); gridContext.moveTo(x, r.y); gridContext.lineTo(x, r.y + r.height); gridContext.stroke() }
  curveContext.strokeStyle = colors.curve
  curveContext.lineWidth = widths.curve
  const estimatedCurves = new Set(geometry.estimatedCurves)
  for (const [index, path] of geometry.curves.entries()) {
    const points = estimatedCurves.has(index) ? path : smoothPixelPath(path)
    curveContext.beginPath(); curveContext.moveTo(points[0].x, points[0].y)
    for (const point of points.slice(1)) curveContext.lineTo(point.x, point.y)
    curveContext.stroke()
  }
  for (const correction of [...(geometry.learnedCorrections ?? []), ...corrections]) {
    if (!correction.points.length || (!correction.erase && correction.points.length < 2)) continue
    const targets = correction.layer === 'grid' ? [grid] : correction.layer === 'curve' || !correction.erase ? [curve] : [grid, curve]
    for (const target of targets) {
      const ctx = target.context
      ctx.globalCompositeOperation = correction.erase ? 'destination-out' : 'source-over'
      ctx.strokeStyle = target === grid ? colors.grid : colors.curve
      ctx.lineWidth = correction.width ?? (correction.erase ? ERASER_WIDTH : target === grid ? widths.grid : widths.curve)
      ctx.beginPath()
      if (correction.points.length === 1) {
        ctx.arc(correction.points[0].x, correction.points[0].y, ctx.lineWidth / 2, 0, Math.PI * 2)
        ctx.fill()
      } else {
        ctx.moveTo(correction.points[0].x, correction.points[0].y)
        for (const point of correction.points.slice(1)) ctx.lineTo(point.x, point.y)
        ctx.stroke()
      }
    }
  }
  gridContext.restore(); curveContext.restore()
  return { grid: grid.canvas, curve: curve.canvas }
}

export function renderReconstructionCurveLayer(geometry: Reconstruction, corrections: Correction[], widths: ReconstructionWidths) {
  return renderReconstructionLayers(geometry, corrections, { curve: '#0066ff', grid: '#000000', axis: '#000000' }, widths).curve
}

export function renderReconstruction(geometry: Reconstruction, corrections: Correction[], colors: ReconstructionColors, widths: ReconstructionWidths, output = { width: geometry.width, height: geometry.height }) {
  const canvas = document.createElement('canvas')
  canvas.width = output.width; canvas.height = output.height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('This browser cannot process the image.')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  const { grid, curve } = renderReconstructionLayers(geometry, corrections, colors, widths, output)
  context.drawImage(grid, 0, 0); context.drawImage(curve, 0, 0)
  return canvas.toDataURL('image/png')
}

export async function reconstructImage(source: string, region: PlotRegion | null, guides: GridGuides, corrections: Correction[], colors: ReconstructionColors, widths: ReconstructionWidths, options: ReconstructionOptions) {
  if (!region && options.regularGrid && (guides.horizontal.length >= 2 || guides.vertical.length >= 2)) throw new Error('Select the plot area before rebuilding a regular grid from guides.')
  const image = new Image()
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () => reject(new Error('Could not load the source image.'))
    image.src = source
  })
  if (image.naturalWidth * image.naturalHeight > 16_000_000) throw new Error('Resize the image below 16 megapixels first.')
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('This browser cannot process the image.')
  context.drawImage(image, 0, 0)
  const sourcePixels = context.getImageData(0, 0, canvas.width, canvas.height)
  const geometry = detectReconstruction(sourcePixels,
    region ?? { x: 0, y: 0, width: canvas.width - 1, height: canvas.height - 1 }, guides, options)
  if (!geometry.curves.length && !geometry.horizontal.length && !geometry.vertical.length) throw new Error('No plot lines found. Select the plot area and try again.')
  if (!region && geometry.horizontal.length >= 2 && geometry.vertical.length >= 2) {
    const left = geometry.vertical[0]
    const right = geometry.vertical[geometry.vertical.length - 1]
    const top = geometry.horizontal[0]
    const bottom = geometry.horizontal[geometry.horizontal.length - 1]
    if (right - left >= 20 && bottom - top >= 20) geometry.region = { x: left, y: top, width: right - left, height: bottom - top }
  }
  return { dataUrl: renderReconstruction(geometry, corrections, colors, widths), geometry, sourcePixels }
}
