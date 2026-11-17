export interface ImageAdjustments {
  brightness: number
  contrast: number
  grayscale: boolean
  threshold: number
  automaticThreshold: boolean
  invert: boolean
  sharpen: number
  separateGrid: boolean
  gridColor: string
}

export interface DetectedPlotGrid {
  horizontalLines: number[]
  verticalLines: number[]
  confidence: number
}

function findPlotGrid(data: Uint8ClampedArray, width: number, height: number): DetectedPlotGrid | null {
  const dark = (x: number, y: number) => {
    const offset = (y * width + x) * 4
    return data[offset] * 0.2126 + data[offset + 1] * 0.7152 + data[offset + 2] * 0.0722 < 175
  }
  const findLines = (orientation: 'horizontal' | 'vertical') => {
    const horizontal = orientation === 'horizontal'
    const start = horizontal ? Math.floor(height * 0.04) : Math.floor(width * 0.03)
    const end = horizontal ? Math.ceil(height * 0.98) : Math.ceil(width * 0.97)
    const spanStart = horizontal ? Math.floor(width * 0.08) : Math.floor(height * 0.03)
    const spanEnd = horizontal ? Math.ceil(width * 0.97) : Math.ceil(height * 0.94)
    const span = spanEnd - spanStart
    const minimumScore = span * 0.3
    const scores: number[] = []

    for (let position = start; position < end; position += 1) {
      let score = 0
      for (let offset = spanStart; offset < spanEnd; offset += 1) {
        if (horizontal ? dark(offset, position) : dark(position, offset)) score += 1
      }
      scores.push(score)
    }

    const candidates: number[] = []
    let groupStart = -1
    for (let index = 0; index <= scores.length; index += 1) {
      const qualifies = index < scores.length && scores[index] >= minimumScore
      if (qualifies && groupStart < 0) groupStart = index
      if (!qualifies && groupStart >= 0) {
        let weightedPosition = 0
        let totalScore = 0
        for (let member = groupStart; member < index; member += 1) {
          weightedPosition += (start + member) * scores[member]
          totalScore += scores[member]
        }
        candidates.push(Math.round(weightedPosition / totalScore))
        groupStart = -1
      }
    }
    return candidates.slice(0, 20)
  }

  const horizontalLines = findLines('horizontal')
  const verticalLines = findLines('vertical')
  if (horizontalLines.length < 2 || verticalLines.length < 2) return null
  return {
    horizontalLines,
    verticalLines,
    confidence: Math.min(horizontalLines.length / 5, verticalLines.length / 5, 1),
  }
}

function recolorDetectedGrid(data: Uint8ClampedArray, width: number, height: number, color: string) {
  const grid = findPlotGrid(data, width, height)
  if (!grid) return
  const red = Number.parseInt(color.slice(1, 3), 16)
  const green = Number.parseInt(color.slice(3, 5), 16)
  const blue = Number.parseInt(color.slice(5, 7), 16)
  if (![red, green, blue].every(Number.isFinite)) return

  const isDark = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return false
    const offset = (y * width + x) * 4
    return data[offset] * 0.2126 + data[offset + 1] * 0.7152 + data[offset + 2] * 0.0722 < 175
  }
  const recolor = (x: number, y: number) => {
    const offset = (y * width + x) * 4
    data[offset] = red
    data[offset + 1] = green
    data[offset + 2] = blue
  }
  const crossingOffsets = [-8, -6, -3, 0, 3, 6, 8]

  for (const y of grid.horizontalLines) {
    for (let x = Math.floor(width * 0.08); x < Math.ceil(width * 0.97); x += 1) {
      const curveCrossing = crossingOffsets.some((offset) => isDark(x + offset, y - 3))
        && crossingOffsets.some((offset) => isDark(x + offset, y + 3))
      if (isDark(x, y) && !curveCrossing) recolor(x, y)
    }
  }
  for (const x of grid.verticalLines) {
    for (let y = Math.floor(height * 0.03); y < Math.ceil(height * 0.94); y += 1) {
      const curveCrossing = crossingOffsets.some((offset) => isDark(x - 3, y + offset))
        && crossingOffsets.some((offset) => isDark(x + 3, y + offset))
      if (isDark(x, y) && !curveCrossing) recolor(x, y)
    }
  }
}

export async function adjustPlotImage(source: string, adjustments: ImageAdjustments): Promise<string> {
  const image = new Image()
  image.crossOrigin = 'anonymous'
  image.src = source
  await image.decode()

  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('This browser cannot prepare the image.')
  context.drawImage(image, 0, 0)

  const frame = context.getImageData(0, 0, canvas.width, canvas.height)
  const { data } = frame
  const contrast = (259 * (adjustments.contrast + 255)) / (255 * (259 - adjustments.contrast))
  const width = canvas.width
  const height = canvas.height
  const sharpen = Math.max(0, Math.min(1, adjustments.sharpen / 100))
  const original = sharpen > 0 ? new Uint8ClampedArray(data) : null
  const luminance = new Uint8Array(width * height)
  const histogram = new Uint32Array(256)

  for (let pixel = 0, index = 0; index < data.length; pixel += 1, index += 4) {
    let red = original?.[index] ?? data[index]
    let green = original?.[index + 1] ?? data[index + 1]
    let blue = original?.[index + 2] ?? data[index + 2]

    if (original && pixel % width > 0 && pixel % width < width - 1 && pixel >= width && pixel < width * (height - 1)) {
      const sharpenChannel = (channel: number) => {
        const center = original[index + channel]
        const neighbors = original[index - width * 4 + channel] + original[index + width * 4 + channel]
          + original[index - 4 + channel] + original[index + 4 + channel]
        return center * (1 + 4 * sharpen) - sharpen * neighbors
      }
      red = sharpenChannel(0)
      green = sharpenChannel(1)
      blue = sharpenChannel(2)
    }

    red = contrast * (red + adjustments.brightness - 128) + 128
    green = contrast * (green + adjustments.brightness - 128) + 128
    blue = contrast * (blue + adjustments.brightness - 128) + 128
    data[index] = Math.max(0, Math.min(255, red))
    data[index + 1] = Math.max(0, Math.min(255, green))
    data[index + 2] = Math.max(0, Math.min(255, blue))

    const level = Math.round(data[index] * 0.2126 + data[index + 1] * 0.7152 + data[index + 2] * 0.0722)
    luminance[pixel] = level
    histogram[level] += 1
  }

  let threshold = adjustments.automaticThreshold ? 0 : adjustments.threshold
  if (adjustments.automaticThreshold) {
    const total = width * height
    let sum = 0
    for (let level = 0; level < 256; level += 1) sum += level * histogram[level]
    let backgroundWeight = 0
    let backgroundSum = 0
    let maximumVariance = -1
    for (let level = 0; level < 256; level += 1) {
      backgroundWeight += histogram[level]
      if (!backgroundWeight) continue
      const foregroundWeight = total - backgroundWeight
      if (!foregroundWeight) break
      backgroundSum += level * histogram[level]
      const backgroundMean = backgroundSum / backgroundWeight
      const foregroundMean = (sum - backgroundSum) / foregroundWeight
      const variance = backgroundWeight * foregroundWeight * (backgroundMean - foregroundMean) ** 2
      if (variance > maximumVariance) {
        maximumVariance = variance
        threshold = level
      }
    }
  }

  const applyThreshold = adjustments.automaticThreshold || adjustments.threshold < 255
  for (let pixel = 0, index = 0; index < data.length; pixel += 1, index += 4) {
    let red = data[index]
    let green = data[index + 1]
    let blue = data[index + 2]
    if (applyThreshold) {
      const foreground = adjustments.automaticThreshold
        ? luminance[pixel] > threshold
        : luminance[pixel] >= threshold
      red = green = blue = foreground ? 255 : 0
    } else if (adjustments.grayscale) {
      red = green = blue = luminance[pixel]
    }
    if (adjustments.invert) {
      red = 255 - red
      green = 255 - green
      blue = 255 - blue
    }
    data[index] = red
    data[index + 1] = green
    data[index + 2] = blue
  }

  if (adjustments.separateGrid) recolorDetectedGrid(data, width, height, adjustments.gridColor)
  context.putImageData(frame, 0, 0)
  return canvas.toDataURL('image/png')
}

export interface DetectedAxes {
  xAxisY: number
  yAxisX: number
  intersection: { x: number; y: number }
  confidence: number
}

export async function detectPlotGrid(source: string): Promise<DetectedPlotGrid | null> {
  const image = new Image()
  image.crossOrigin = 'anonymous'
  image.src = source
  await image.decode()

  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('This browser cannot inspect the image.')
  context.drawImage(image, 0, 0)

  const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height)
  return findPlotGrid(data, width, height)
}

export async function detectPlotAxes(source: string): Promise<DetectedAxes | null> {
  const image = new Image()
  image.crossOrigin = 'anonymous'
  image.src = source
  await image.decode()

  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return null
  context.drawImage(image, 0, 0)

  const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height)
  const dark = (x: number, y: number) => {
    const offset = (y * width + x) * 4
    return data[offset] * 0.2126 + data[offset + 1] * 0.7152 + data[offset + 2] * 0.0722 < 145
  }

  const horizontalStart = Math.floor(height * 0.62)
  const verticalEnd = Math.floor(width * 0.38)
  let bestRow = -1
  let bestRowScore = 0
  for (let y = horizontalStart; y < height - 2; y += 1) {
    let score = 0
    for (let x = Math.floor(width * 0.12); x < width * 0.94; x += 2) if (dark(x, y)) score += 1
    if (score > bestRowScore) { bestRowScore = score; bestRow = y }
  }

  let bestColumn = -1
  let bestColumnScore = 0
  for (let x = 2; x < verticalEnd; x += 1) {
    let score = 0
    for (let y = Math.floor(height * 0.06); y < height * 0.9; y += 2) if (dark(x, y)) score += 1
    if (score > bestColumnScore) { bestColumnScore = score; bestColumn = x }
  }

  const minRowScore = width * 0.08
  const minColumnScore = height * 0.08
  if (bestRow < 0 || bestColumn < 0 || bestRowScore < minRowScore || bestColumnScore < minColumnScore) return null

  const confidence = Math.min(bestRowScore / (width * 0.35), bestColumnScore / (height * 0.35), 1)
  return {
    xAxisY: bestRow,
    yAxisX: bestColumn,
    intersection: { x: bestColumn, y: bestRow },
    confidence,
  }
}
