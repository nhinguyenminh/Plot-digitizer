import type { PixelPoint } from './digitizer'

export function rotationGeometry(width: number, height: number, degrees: number) {
  const radians = degrees * Math.PI / 180
  const cosine = Math.abs(Math.cos(radians)) < 1e-12 ? 0 : Math.cos(radians)
  const sine = Math.abs(Math.sin(radians)) < 1e-12 ? 0 : Math.sin(radians)
  const rotatedWidth = Math.ceil(Math.abs(width * cosine) + Math.abs(height * sine))
  const rotatedHeight = Math.ceil(Math.abs(width * sine) + Math.abs(height * cosine))
  const transformPoint = ({ x, y }: PixelPoint): PixelPoint => {
    const dx = x + 0.5 - width / 2
    const dy = y + 0.5 - height / 2
    return {
      x: cosine * dx - sine * dy + rotatedWidth / 2 - 0.5,
      y: sine * dx + cosine * dy + rotatedHeight / 2 - 0.5,
    }
  }
  return { radians, width: rotatedWidth, height: rotatedHeight, transformPoint }
}

export function rulerCorrection(start: PixelPoint, end: PixelPoint): number {
  const dx = end.x - start.x
  const dy = end.y - start.y
  if (![start.x, start.y, end.x, end.y].every(Number.isFinite) || Math.hypot(dx, dy) < 10) {
    throw new Error('Draw the ruler along an axis or grid line at least 10 pixels long.')
  }
  const angle = Math.atan2(dy, dx) * 180 / Math.PI
  return Math.round((Math.round(angle / 90) * 90 - angle) * 1e10) / 1e10
}

export function estimateDeskew(data: Uint8ClampedArray, width: number, height: number): number | null {
  if (width < 32 || height < 32 || data.length !== width * height * 4) return null
  const dark: PixelPoint[] = []
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4
    if (data[offset + 3] >= 128 && data[offset] * 0.2126 + data[offset + 1] * 0.7152 + data[offset + 2] * 0.0722 < 175) dark.push({ x, y })
  }
  if (dark.length < Math.min(width, height) || dark.length > width * height * 0.45) return null

  const margin = Math.ceil(Math.hypot(width, height))
  const length = margin * 2 + 1
  const results: { angle: number; score: number; horizontal: number; vertical: number }[] = []
  for (let step = -80; step <= 80; step++) {
    const angle = step / 10
    const radians = angle * Math.PI / 180
    const cosine = Math.cos(radians)
    const sine = Math.sin(radians)
    const rows = new Uint32Array(length)
    const columns = new Uint32Array(length)
    for (const point of dark) {
      rows[Math.round(point.y * cosine - point.x * sine) + margin]++
      columns[Math.round(point.x * cosine + point.y * sine) + margin]++
    }
    let score = 0
    let horizontal = 0
    let vertical = 0
    let inHorizontal = false
    let inVertical = false
    for (let i = 0; i < length; i++) {
      const row = rows[i] / width
      const column = columns[i] / height
      const horizontalLine = row >= 0.22
      const verticalLine = column >= 0.22
      if (horizontalLine && !inHorizontal) horizontal++
      if (verticalLine && !inVertical) vertical++
      inHorizontal = horizontalLine
      inVertical = verticalLine
      score += Math.max(0, row - 0.12) ** 2 + Math.max(0, column - 0.12) ** 2
    }
    results.push({ angle, score, horizontal, vertical })
  }
  const best = results.reduce((a, b) => b.score > a.score ? b : a)
  const distant = Math.max(...results.filter((result) => Math.abs(result.angle - best.angle) >= 2).map((result) => result.score))
  if (best.horizontal + best.vertical < 2 || best.score < 0.03 || best.score < distant * 1.15 || Math.abs(best.angle) === 8) return null
  return -best.angle
}
