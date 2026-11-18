import { simplifyDetectedTrace } from './digitizer.ts'
import type { PixelPoint } from './digitizer'

export interface BrushMark {
  points: PixelPoint[]
  width: number
  erase: boolean
}

export function createBrushMask(width: number, height: number, marks: BrushMark[]): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('This browser cannot draw the brush selection.')
  for (const mark of marks) {
    if (!mark.points.length) continue
    context.globalCompositeOperation = mark.erase ? 'destination-out' : 'source-over'
    context.strokeStyle = '#ffffff'
    context.fillStyle = '#ffffff'
    context.lineWidth = mark.width
    context.lineCap = 'round'
    context.lineJoin = 'round'
    context.beginPath()
    context.moveTo(mark.points[0].x, mark.points[0].y)
    if (mark.points.length === 1) {
      context.arc(mark.points[0].x, mark.points[0].y, mark.width / 2, 0, Math.PI * 2)
      context.fill()
    } else {
      for (const point of mark.points.slice(1)) context.lineTo(point.x, point.y)
      context.stroke()
    }
  }
  return canvas
}

export function extractPaintedCurves(
  image: ImageData,
  mask: Uint8ClampedArray,
  spacing: number,
  tolerance: number,
  curveColor?: [number, number, number],
  maxGap = 25,
  minFragmentSpan = 8,
  isolatedCurveLayer = false,
): PixelPoint[][] {
  const { width, height, data } = image
  if (mask.length !== width * height * 4) throw new Error('The brush selection does not match the image.')
  if (width * height > 4_000_000) throw new Error('Use an image below 4 megapixels for automatic point extraction.')
  if (!isolatedCurveLayer && curveColor && Math.hypot(255 - curveColor[0], 255 - curveColor[1], 255 - curveColor[2]) <= tolerance) {
    throw new Error('The curve color is too close to the white background for this tolerance. Adjust the color or tolerance.')
  }
  type Track = { points: PixelPoint[]; misses: number }
  const active: Track[] = []
  const finished: Track[] = []
  const selected = (x: number, y: number) => mask[(y * width + x) * 4 + 3] >= 128
  for (let x = 0; x < width; x++) {
    const candidates: number[] = []
    let start = -1
    let alphaSum = 0, weightedY = 0
    for (let y = 0; y <= height; y++) {
      const offset = (y * width + x) * 4
      const ink = y < height && selected(x, y) && (isolatedCurveLayer ? data[offset + 3] >= 16 : data[offset + 3] > 127 && (curveColor
        ? Math.hypot(data[offset] - curveColor[0], data[offset + 1] - curveColor[1], data[offset + 2] - curveColor[2]) <= tolerance
        : Math.min(data[offset], data[offset + 1], data[offset + 2]) < 185))
      if (ink && start < 0) start = y
      if (ink && isolatedCurveLayer) { alphaSum += data[offset + 3]; weightedY += (y + 0.5) * data[offset + 3] }
      if (!ink && start >= 0) {
        if (y - start <= 12) candidates.push(isolatedCurveLayer ? weightedY / alphaSum : (start + y - 1) / 2)
        start = -1; alphaSum = 0; weightedY = 0
      }
    }
    if (candidates.length > 200) throw new Error('The selection contains too many marks. Brush a smaller area and try again.')
    const matches: { track: Track; index: number; score: number }[] = []
    for (const track of active) {
      const last = track.points[track.points.length - 1]
      const previous = track.points[track.points.length - 2]
      const slope = previous ? (last.y - previous.y) / (last.x - previous.x) : 0
      const prediction = last.y + Math.max(-3, Math.min(3, slope)) * (x - last.x)
      const predictedY = Math.round(prediction)
      if (predictedY < 0 || predictedY >= height || !selected(x, predictedY)) continue
      candidates.forEach((y, index) => {
        const score = Math.abs(y - prediction)
        if (score <= 3 + track.misses * 2) matches.push({ track, index, score })
      })
    }
    matches.sort((a, b) => a.score - b.score)
    const matchedTracks = new Set<Track>()
    const matchedCandidates = new Set<number>()
    for (const match of matches) {
      if (matchedTracks.has(match.track) || matchedCandidates.has(match.index)) continue
      match.track.points.push({ x, y: candidates[match.index] })
      match.track.misses = 0
      matchedTracks.add(match.track)
      matchedCandidates.add(match.index)
    }
    for (let i = active.length - 1; i >= 0; i--) {
      const track = active[i]
      if (matchedTracks.has(track)) continue
      const last = track.points[track.points.length - 1]
      const previous = track.points[track.points.length - 2]
      const slope = previous ? (last.y - previous.y) / (last.x - previous.x) : 0
      const predictedY = Math.round(last.y + Math.max(-3, Math.min(3, slope)) * (x - last.x))
      if (predictedY < 0 || predictedY >= height || !selected(x, predictedY) || ++track.misses > 3) {
        finished.push(track)
        active.splice(i, 1)
      }
    }
    candidates.forEach((y, index) => {
      if (!matchedCandidates.has(index)) active.push({ points: [{ x, y }], misses: 0 })
    })
    if (active.length > 200 || active.length + finished.length > 1500) {
      throw new Error('The selection contains too many marks. Brush a smaller area and try again.')
    }
  }
  const tracks = [...finished, ...active]
    .map(({ points }) => points)
    .filter((points) => minFragmentSpan === 0 || (points.length >= 3 && points[points.length - 1].x - points[0].x >= 3))
  if (tracks.length > 200) throw new Error('The selection contains too many fragments. Brush a smaller area and try again.')
  const slopeAt = (points: PixelPoint[], end: boolean) => {
    const sample = end ? points.slice(-20) : points.slice(0, 20)
    const meanX = sample.reduce((sum, point) => sum + point.x, 0) / sample.length
    const meanY = sample.reduce((sum, point) => sum + point.y, 0) / sample.length
    const covariance = sample.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0)
    const variance = sample.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0)
    return variance ? covariance / variance : 0
  }
  while (true) {
    const links: { left: number; right: number; score: number }[] = []
    tracks.forEach((left, leftIndex) => tracks.forEach((right, rightIndex) => {
      if (leftIndex === rightIndex) return
      const a = left[left.length - 1]
      const b = right[0]
      const gap = b.x - a.x
      if (gap <= 0 || gap > maxGap) return
      const leftSlope = slopeAt(left, true)
      const rightSlope = slopeAt(right, false)
      const slopeDifference = Math.abs(leftSlope - rightSlope)
      if (slopeDifference > 0.6) return
      const error = Math.abs(b.y - (a.y + (leftSlope + rightSlope) * gap / 2))
      if (error > 3 + gap * 0.15) return
      for (let x = a.x + 1; x < b.x; x++) {
        const y = Math.round(a.y + (b.y - a.y) * (x - a.x) / gap)
        if (y < 0 || y >= height || !selected(x, y)) return
      }
      links.push({ left: leftIndex, right: rightIndex, score: error + slopeDifference * 4 + gap * 0.03 })
    }))
    links.sort((a, b) => a.score - b.score)
    const link = links.find((candidate) => !links.some((other) =>
      other !== candidate && (other.left === candidate.left || other.right === candidate.right) && other.score < candidate.score + 2))
    if (!link) break
    tracks[link.left] = [...tracks[link.left], ...tracks[link.right]]
    tracks.splice(link.right, 1)
  }
  return tracks
    .filter((points) => minFragmentSpan === 0 || (points.length >= 5 && points[points.length - 1].x - points[0].x >= minFragmentSpan))
    .map((points) => simplifyDetectedTrace(points, spacing))
}

export interface BrushExtraction {
  curves: PixelPoint[][]
  warnings: string[]
}

export function extractBrushCurves(
  image: ImageData,
  mask: Uint8ClampedArray,
  spacing: number,
  tolerance: number,
  curveColor?: [number, number, number],
  isolatedCurveLayer = false,
): BrushExtraction {
  const { width, height, data } = image
  if (mask.length !== width * height * 4) throw new Error('The brush selection does not match the image.')
  if (width * height > 4_000_000) throw new Error('Use an image below 4 megapixels for automatic point extraction.')
  const visited = new Uint8Array(width * height)
  const queue = new Int32Array(width * height)
  const curves: PixelPoint[][] = []
  const warnings: string[] = []
  let region = 0
  for (let start = 0; start < visited.length; start++) {
    if (visited[start] || mask[start * 4 + 3] < 128) continue
    region++
    if (region > 100) throw new Error('Too many separate brush regions. Clear small marks and try again.')
    let head = 0, tail = 0
    let left = start % width, right = left, top = Math.floor(start / width), bottom = top
    queue[tail++] = start
    visited[start] = 1
    while (head < tail) {
      const current = queue[head++]
      const x = current % width, y = Math.floor(current / width)
      left = Math.min(left, x); right = Math.max(right, x)
      top = Math.min(top, y); bottom = Math.max(bottom, y)
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue
        const next = ny * width + nx
        if (!visited[next] && mask[next * 4 + 3] >= 128) { visited[next] = 1; queue[tail++] = next }
      }
    }
    const regionWidth = right - left + 1, regionHeight = bottom - top + 1
    const regionData = new Uint8ClampedArray(regionWidth * regionHeight * 4)
    const regionMask = new Uint8ClampedArray(regionData.length)
    for (let y = top; y <= bottom; y++) {
      const source = (y * width + left) * 4
      regionData.set(data.subarray(source, source + regionWidth * 4), (y - top) * regionWidth * 4)
    }
    for (let i = 0; i < tail; i++) {
      const position = queue[i]
      const x = position % width, y = Math.floor(position / width)
      regionMask[((y - top) * regionWidth + x - left) * 4 + 3] = 255
    }
    const found = extractPaintedCurves(
      { width: regionWidth, height: regionHeight, data: regionData, colorSpace: image.colorSpace },
      regionMask, spacing, tolerance, curveColor, 0, 0, isolatedCurveLayer,
    )
    if (!found.length) {
      warnings.push(`Brush region ${region} has no detectable curve.`)
      continue
    }
    let regionCurves: PixelPoint[][] = []
    let joined = 0, excluded = 0
    found.sort((a, b) => a[0].x - b[0].x || a[0].y - b[0].y)
    for (const fragment of found) {
      const startPoint = fragment[0]
      const candidates = regionCurves.flatMap((curve) => {
        const end = curve[curve.length - 1]
        const gap = startPoint.x - end.x
        if (gap <= 0) return []
        for (let x = Math.ceil(end.x); x <= Math.floor(startPoint.x); x++) {
          const y = Math.round(end.y + (startPoint.y - end.y) * (x - end.x) / gap)
          if (y < 0 || y >= regionHeight || regionMask[(y * regionWidth + x) * 4 + 3] < 128) return []
        }
        return [{ curve, distance: Math.hypot(gap, startPoint.y - end.y) }]
      }).sort((a, b) => a.distance - b.distance)
      if (candidates.length && (candidates.length === 1 || candidates[1].distance > candidates[0].distance + 2)) {
        candidates[0].curve.push(...fragment)
        joined++
      } else {
        regionCurves.push([...fragment])
      }
    }
    if (isolatedCurveLayer && regionCurves.length > 1) {
      const redundant = new Set<PixelPoint[]>()
      for (const short of regionCurves) {
        const shortSpan = short[short.length - 1].x - short[0].x
        for (const long of regionCurves) {
          if (short === long) continue
          const longSpan = long[long.length - 1].x - long[0].x
          const overlap = Math.min(short[short.length - 1].x, long[long.length - 1].x) - Math.max(short[0].x, long[0].x)
          if (shortSpan > Math.min(20, longSpan * 0.1) || overlap < Math.min(3, shortSpan / 2)) continue
          const valueAt = (curve: PixelPoint[], x: number) => {
            const endIndex = curve.findIndex((point) => point.x >= x)
            if (endIndex === 0) return curve[0].y
            if (endIndex < 0) return null
            const start = curve[endIndex - 1], end = curve[endIndex]
            return start.y + (end.y - start.y) * (x - start.x) / (end.x - start.x)
          }
          const leftEdge = Math.max(short[0].x, long[0].x)
          const rightEdge = Math.min(short[short.length - 1].x, long[long.length - 1].x)
          let near = false
          for (let x = leftEdge; x <= rightEdge; x++) {
            const a = valueAt(short, x), b = valueAt(long, x)
            if (a !== null && b !== null && Math.abs(a - b) <= 6) { near = true; break }
          }
          if (near) { redundant.add(short); break }
        }
      }
      if (redundant.size) {
        regionCurves = regionCurves.filter((curve) => !redundant.has(curve))
        excluded = redundant.size
      }
    }
    const issues = [
      ...(joined ? [`${joined} disconnected fragments joined; connections across gaps are estimates.`] : []),
      ...(excluded ? [`${excluded} short overlapping mark${excluded === 1 ? ' was' : 's were'} excluded; paint separately if needed.`] : []),
      ...(regionCurves.length > 1 ? [`${regionCurves.length} separate candidates remain because fragments overlap or cannot be connected within the selection.`] : []),
    ]
    if (issues.length) warnings.push(`Brush region ${region}: ${issues.join(' ')}`)
    curves.push(...regionCurves.map((curve) => curve.map((point) => ({ x: point.x + left, y: point.y + top }))))
  }
  if (!region) throw new Error('The brush selection is empty.')
  if (!curves.length) throw new Error(warnings.join(' ') || 'No curves found in the brush selection.')
  return { curves, warnings }
}
