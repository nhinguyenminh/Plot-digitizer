import type { PixelPoint } from './digitizer'
import { thinBinaryInk } from './skeleton.ts'

type CurvePixels = Pick<ImageData, 'width' | 'height' | 'data'>

export function snapToCurve(image: CurvePixels, point: PixelPoint, radius = 12): PixelPoint | null {
  let best: PixelPoint | null = null
  let bestDistance = radius * radius
  const left = Math.max(0, Math.floor(point.x - radius))
  const right = Math.min(image.width - 1, Math.ceil(point.x + radius))
  const top = Math.max(0, Math.floor(point.y - radius))
  const bottom = Math.min(image.height - 1, Math.ceil(point.y + radius))
  for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
    if (image.data[(y * image.width + x) * 4 + 3] < 16) continue
    const distance = (x + 0.5 - point.x) ** 2 + (y + 0.5 - point.y) ** 2
    if (distance <= bestDistance) { bestDistance = distance; best = { x: x + 0.5, y: y + 0.5 } }
  }
  return best
}

function tangent(image: CurvePixels, point: PixelPoint, toward: PixelPoint): PixelPoint | null {
  const dx = toward.x - point.x, dy = toward.y - point.y
  const gap = Math.hypot(dx, dy)
  let xx = 0, xy = 0, yy = 0, count = 0
  const radius = 12
  for (let y = Math.max(0, Math.floor(point.y - radius)); y <= Math.min(image.height - 1, Math.ceil(point.y + radius)); y++) {
    for (let x = Math.max(0, Math.floor(point.x - radius)); x <= Math.min(image.width - 1, Math.ceil(point.x + radius)); x++) {
      if (image.data[(y * image.width + x) * 4 + 3] < 16) continue
      const px = x + 0.5 - point.x, py = y + 0.5 - point.y
      const distance = Math.hypot(px, py)
      if (distance < 1 || distance > radius || (px * dx + py * dy) / gap > 1) continue
      xx += px * px; xy += px * py; yy += py * py; count++
    }
  }
  const spread = Math.hypot(xx - yy, 2 * xy)
  if (count < 3 || spread < (xx + yy) * 0.25) return null
  const angle = Math.atan2(2 * xy, xx - yy) / 2
  let x = Math.cos(angle), y = Math.sin(angle)
  if (x * dx + y * dy < 0) { x = -x; y = -y }
  if ((x * dx + y * dy) / gap < 0.25) return null
  return { x, y }
}

function healingPath(start: PixelPoint, end: PixelPoint, a: PixelPoint, b: PixelPoint): PixelPoint[] {
  const length = Math.hypot(end.x - start.x, end.y - start.y)
  const dx = (end.x - start.x) / length, dy = (end.y - start.y) / length
  if (a.x * dx + a.y * dy >= Math.cos(Math.PI / 60) && -b.x * dx - b.y * dy >= Math.cos(Math.PI / 60)) {
    return Array.from({ length: 25 }, (_, index) => {
      const t = index / 24
      return { x: start.x + t * (end.x - start.x), y: start.y + t * (end.y - start.y) }
    })
  }
  const control = Math.min(length / 3, 25)
  return Array.from({ length: 25 }, (_, index) => {
    const t = index / 24, u = 1 - t
    return {
      x: u ** 3 * start.x + 3 * u ** 2 * t * (start.x + a.x * control) + 3 * u * t ** 2 * (end.x + b.x * control) + t ** 3 * end.x,
      y: u ** 3 * start.y + 3 * u ** 2 * t * (start.y + a.y * control) + 3 * u * t ** 2 * (end.y + b.y * control) + t ** 3 * end.y,
    }
  })
}

export function proposeCurveHealing(image: CurvePixels, first: PixelPoint, second: PixelPoint): PixelPoint[] {
  const start = snapToCurve(image, first), end = snapToCurve(image, second)
  if (!start || !end) throw new Error('Select two points within 12 source pixels of the curve layer.')
  const length = Math.hypot(end.x - start.x, end.y - start.y)
  if (length < 3 || length > 100) throw new Error('Choose two different curve ends at most 100 source pixels apart.')
  const a = tangent(image, start, end), b = tangent(image, end, start)
  if (!a || !b) throw new Error('Could not estimate both curve directions. Select closer to the ends or draw the connection manually.')
  return healingPath(start, end, a, b)
}

function centeredEnd(image: CurvePixels, points: PixelPoint[], end: PixelPoint, toward: PixelPoint): PixelPoint {
  const dx = toward.x - end.x, dy = toward.y - end.y, gap = Math.hypot(dx, dy)
  const nearby = points.filter((point) => {
    const x = point.x - end.x, y = point.y - end.y
    const along = (x * dx + y * dy) / gap
    return along >= -12 && along <= 1 && Math.abs(x * dy - y * dx) / gap <= 4
  })
  let weight = 0, x = 0, y = 0
  for (const point of nearby) {
    const alpha = image.data[(Math.floor(point.y) * image.width + Math.floor(point.x)) * 4 + 3]
    weight += alpha; x += point.x * alpha; y += point.y * alpha
  }
  if (!weight) return end
  x /= weight; y /= weight
  let xx = 0, xy = 0, yy = 0
  for (const point of nearby) {
    const alpha = image.data[(Math.floor(point.y) * image.width + Math.floor(point.x)) * 4 + 3]
    xx += (point.x - x) ** 2 * alpha
    xy += (point.x - x) * (point.y - y) * alpha
    yy += (point.y - y) ** 2 * alpha
  }
  if (Math.hypot(xx - yy, 2 * xy) < (xx + yy) * 0.25) return end
  const angle = Math.atan2(2 * xy, xx - yy) / 2
  const nx = -Math.sin(angle), ny = Math.cos(angle)
  const offset = Math.max(-4, Math.min(4, (x - end.x) * nx + (y - end.y) * ny))
  return { x: end.x + nx * offset, y: end.y + ny * offset }
}

function findEnds(pixels: number[], width: number, height: number, halo: Uint8ClampedArray) {
  let left = width, right = 0, top = height, bottom = 0
  for (const index of pixels) {
    const x = index % width, y = Math.floor(index / width)
    left = Math.min(left, x); right = Math.max(right, x)
    top = Math.min(top, y); bottom = Math.max(bottom, y)
  }
  const w = right - left + 1, h = bottom - top + 1
  const ink = new Uint8Array(w * h)
  for (const index of pixels) ink[(Math.floor(index / width) - top) * w + index % width - left] = 1
  thinBinaryInk(ink, w, h)
  const get = (x: number, y: number) => x < 0 || y < 0 || x >= w || y >= h ? 0 : ink[y * w + x]
  const neighbors = (index: number) => {
    const x = index % w, y = Math.floor(index / w)
    const result: number[] = []
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if ((!dx && !dy) || !get(x + dx, y + dy) || (dx && dy && (get(x + dx, y) || get(x, y + dy)))) continue
      result.push((y + dy) * w + x + dx)
    }
    return result
  }
  const ends: { point: PixelPoint; direction: PixelPoint }[] = []
  for (let index = 0; index < ink.length; index++) {
    if (!ink[index]) continue
    const x = left + index % w, y = top + Math.floor(index / w)
    if (x === 0 || y === 0 || x === width - 1 || y === height - 1 || halo[(y * width + x) * 4 + 3] < 128) continue
    const adjacent = neighbors(index)
    if (adjacent.length !== 1) continue
    let previous = index, current = adjacent[0]
    for (let step = 1; step < 12; step++) {
      const next = neighbors(current)
      if (next.length !== 2) break
      const nextIndex = next[0] === previous ? next[1] : next[0]
      previous = current; current = nextIndex
    }
    const dx = index % w - current % w, dy = Math.floor(index / w) - Math.floor(current / w)
    const length = Math.hypot(dx, dy)
    if (length < 2) continue
    ends.push({ point: { x: x + 0.5, y: y + 0.5 }, direction: { x: dx / length, y: dy / length } })
  }
  return ends
}

export function proposeBrushedHealing(image: CurvePixels, mask: Uint8ClampedArray, halo: Uint8ClampedArray): PixelPoint[][] {
  const { width, height, data } = image
  if (mask.length !== data.length || halo.length !== data.length) throw new Error('The healing brush does not match the curve layer.')
  if (width * height > 1_000_000) throw new Error('Brush a smaller area around one gap.')
  const visited = new Uint8Array(width * height)
  const components: { ends: ReturnType<typeof findEnds>; points: PixelPoint[] }[] = []
  for (let index = 0; index < width * height; index++) {
    if (visited[index] || data[index * 4 + 3] < 16) continue
    const queue = [index], nearby: PixelPoint[] = []
    visited[index] = 1
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const current = queue[cursor], x = current % width, y = Math.floor(current / width)
      if (halo[current * 4 + 3] >= 128) nearby.push({ x: x + 0.5, y: y + 0.5 })
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy
        if ((!dx && !dy) || nx < 0 || nx >= width || ny < 0 || ny >= height) continue
        const next = ny * width + nx
        if (!visited[next] && data[next * 4 + 3] >= 16) { visited[next] = 1; queue.push(next) }
      }
    }
    if (queue.length >= 4 && nearby.length) {
      let samples = nearby
      if (nearby.length > 600) {
        const buckets = new Map<string, PixelPoint>()
        for (const point of nearby) {
          const key = `${Math.floor(point.x / 2)},${Math.floor(point.y / 2)}`
          if (!buckets.has(key)) buckets.set(key, point)
        }
        samples = [...buckets.values()]
      }
      if (samples.length > 600) throw new Error('Too much curve ink near the brush. Brush a smaller area.')
      components.push({ ends: findEnds(queue, width, height, halo), points: nearby })
      if (components.length > 12) throw new Error('Too many curve fragments near the brush. Brush a smaller area.')
    }
  }
  const candidates: PixelPoint[][] = []
  for (let a = 0; a < components.length; a++) for (let b = a + 1; b < components.length; b++) {
    for (const first of components[a].ends) for (const second of components[b].ends) {
      const distance = Math.hypot(first.point.x - second.point.x, first.point.y - second.point.y)
      if (distance < 3 || distance > 100) continue
      const mx = Math.floor((first.point.x + second.point.x) / 2), my = Math.floor((first.point.y + second.point.y) / 2)
      if (mask[(my * width + mx) * 4 + 3] < 128) continue
      const start = centeredEnd(image, components[a].points, first.point, { x: first.point.x + first.direction.x * 12, y: first.point.y + first.direction.y * 12 })
      const end = centeredEnd(image, components[b].points, second.point, { x: second.point.x + second.direction.x * 12, y: second.point.y + second.direction.y * 12 })
      const length = Math.hypot(end.x - start.x, end.y - start.y)
      if (length < 3 || length > 100) continue
      const dx = (end.x - start.x) / length, dy = (end.y - start.y) / length
      if (first.direction.x * dx + first.direction.y * dy < 0.6 || -second.direction.x * dx - second.direction.y * dy < 0.6) continue
      candidates.push(healingPath(start, end, first.direction, second.direction))
    }
  }
  if (!candidates.length) throw new Error('No clear gap found. Brush over one gap and include the nearby curve ends.')
  if (candidates.length > 1) throw new Error('More than one gap may be present. Brush a smaller area around one gap.')
  const curved = candidates[0], start = curved[0], end = curved[curved.length - 1]
  const line = curved.map((_, index) => {
    const t = index / (curved.length - 1)
    return { x: start.x + t * (end.x - start.x), y: start.y + t * (end.y - start.y) }
  })
  const gentle = curved.map((point, index) => ({ x: (point.x + line[index].x) / 2, y: (point.y + line[index].y) / 2 }))
  return [line, gentle, curved]
}
