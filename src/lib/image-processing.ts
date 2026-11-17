export interface ImageAdjustments {
  brightness: number
  contrast: number
  grayscale: boolean
  threshold: number
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

  for (let index = 0; index < data.length; index += 4) {
    let red = data[index] + adjustments.brightness
    let green = data[index + 1] + adjustments.brightness
    let blue = data[index + 2] + adjustments.brightness

    red = contrast * (red - 128) + 128
    green = contrast * (green - 128) + 128
    blue = contrast * (blue - 128) + 128

    if (adjustments.grayscale || adjustments.threshold < 255) {
      const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722
      const level = adjustments.threshold < 255
        ? luminance >= adjustments.threshold ? 255 : 0
        : luminance
      red = level
      green = level
      blue = level
    }

    data[index] = Math.max(0, Math.min(255, red))
    data[index + 1] = Math.max(0, Math.min(255, green))
    data[index + 2] = Math.max(0, Math.min(255, blue))
  }

  context.putImageData(frame, 0, 0)
  return canvas.toDataURL('image/png')
}

export interface DetectedAxes {
  xAxisY: number
  yAxisX: number
  intersection: { x: number; y: number }
  confidence: number
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
