import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { pointToData } from '../lib/digitizer'
import { createBrushMask } from '../lib/painted-region'
import type { BrushMark } from '../lib/painted-region'
import type { GridGuides } from '../lib/image-processing'
import type { AxisGuides, PlotRegion } from '../lib/reconstruct'
import type { AxisCalibration, Dataset, PixelPoint, ScaleType, ToolMode } from '../lib/digitizer'

interface CalibrationMarker {
  axis: 'x' | 'y'
  index: number
  point: PixelPoint
  value: number
  label: string
}

interface Props {
  imageUrl: string | null
  displayImageUrl: string | null
  onImageError: () => void
  imageLabel: string
  showBackground: boolean
  datasets: Dataset[]
  activeDatasetId: string
  mode: ToolMode
  gridGuides: GridGuides
  axisGuides: AxisGuides
  plotRegion: PlotRegion | null
  onCanvasClick: (point: PixelPoint) => void
  onDeletePoint: (point: PixelPoint) => void
  onDeleteSelectedPoint: (index: number) => void
  readOnly: boolean
  calibrationMarkers: CalibrationMarker[]
  calibrationMarkerColor: string
  pointMarkerSize: number
  showCalibrationMarkers: boolean
  xAxis: AxisCalibration
  yAxis: AxisCalibration
  coordinateLabels: { x: string; y: string }
  coordinateScales: { x: ScaleType; y: ScaleType }
  traceBrushWidth: number
  eraserWidth: number
  brushMarks: BrushMark[]
  brushErasing: boolean
  curveColor: string
  correctionColor: string
  correctionWidth: number
  onSeedColor: (rgb: [number, number, number]) => void
  onCropSelection: (rect: { x: number; y: number; width: number; height: number }) => void
  onRegionSelection: (rect: PlotRegion) => void
  onMovePoint: (index: number, point: PixelPoint) => void
  onMoveCalibrationPoint: (axis: 'x' | 'y', index: number, point: PixelPoint) => void
  onTraceRegion: (points: PixelPoint[]) => void
}

const formatCoordinate = (value: number, scale: ScaleType) => scale === 'date'
  ? new Date(value).toISOString().replace('T', ' ').replace('.000Z', 'Z')
  : Number(value.toPrecision(5)).toString()

export default function PlotCanvas({ imageUrl, displayImageUrl, onImageError, imageLabel, showBackground, datasets, activeDatasetId, mode, gridGuides, axisGuides, plotRegion, onCanvasClick, onDeletePoint, onDeleteSelectedPoint, readOnly, calibrationMarkers, calibrationMarkerColor, pointMarkerSize, showCalibrationMarkers, xAxis, yAxis, coordinateLabels, coordinateScales, traceBrushWidth, eraserWidth, brushMarks, brushErasing, curveColor, correctionColor, correctionWidth, onSeedColor, onCropSelection, onRegionSelection, onMovePoint, onMoveCalibrationPoint, onTraceRegion }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sourceCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const lensCanvasRef = useRef<HTMLCanvasElement>(null)
  const draggedPointRef = useRef<number | null>(null)
  const draggedCalibrationRef = useRef<{ axis: 'x' | 'y'; index: number } | null>(null)
  const traceStrokeRef = useRef<PixelPoint[]>([])
  const cropStartRef = useRef<PixelPoint | null>(null)
  const cropCursorRef = useRef<PixelPoint | null>(null)
  const lastSeedColorRef = useRef<[number, number, number] | null>(null)
  const suppressClickRef = useRef(false)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const displayImageRef = useRef<HTMLImageElement | null>(null)
  const [cursor, setCursor] = useState<PixelPoint | null>(null)
  const [scale, setScale] = useState(1)
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 })
  const [renderDimensions, setRenderDimensions] = useState({ width: 0, height: 0 })
  const [cropStart, setCropStart] = useState<PixelPoint | null>(null)
  const [cropCursor, setCropCursor] = useState<PixelPoint | null>(null)
  const [lensPosition, setLensPosition] = useState<PixelPoint | null>(null)
  const [selectedPointIndex, setSelectedPointIndex] = useState<number | null>(null)
  const [selectedCalibration, setSelectedCalibration] = useState<{ axis: 'x' | 'y'; index: number } | null>(null)
  const [traceStroke, setTraceStroke] = useState<PixelPoint[]>([])
  const previewWidth = mode === 'prep-erase' ? eraserWidth : traceBrushWidth
  const lensSourceSize = mode === 'prep-erase' || mode === 'trace-region' ? Math.max(42, Math.ceil(previewWidth * 1.25)) : 42
  const brushColor = useMemo(() => {
    const candidates = ['#ff4f35', '#00ce88', '#b747ff', '#ff35b8', '#00b9e8']
    const colors = [curveColor, ...datasets.map((dataset) => dataset.color), '#ffffff', '#000000']
      .filter((color) => /^#[0-9a-f]{6}$/i.test(color))
      .map((color) => [1, 3, 5].map((index) => parseInt(color.slice(index, index + 2), 16)))
    const source = sourceCanvasRef.current
    if (source) {
      const sample = document.createElement('canvas')
      sample.width = 64
      sample.height = 64
      const sourceContext = sample.getContext('2d', { willReadFrequently: true })
      sourceContext?.drawImage(source, 0, 0, sample.width, sample.height)
      const pixels = sourceContext?.getImageData(0, 0, sample.width, sample.height).data
      for (let index = 0; pixels && index < sample.width * sample.height; index++) {
        const offset = index * 4
        if (pixels[offset + 3] > 127) colors.push([pixels[offset], pixels[offset + 1], pixels[offset + 2]])
      }
    }
    return candidates.reduce((best, color) => {
      const channels = [1, 3, 5].map((index) => parseInt(color.slice(index, index + 2), 16))
      const score = Math.min(...colors.map((other) => Math.hypot(...channels.map((value, index) => value - other[index]))))
      return score > best.score ? { color, score } : best
    }, { color: candidates[0], score: -1 }).color
  }, [curveColor, datasets, dimensions, imageUrl])
  const brushOverlay = useMemo(() => {
    if (!dimensions.width || !dimensions.height || mode !== 'trace-region') return null
    const liveMark = traceStroke.length ? [{ points: traceStroke, width: traceBrushWidth, erase: brushErasing }] : []
    const overlay = createBrushMask(dimensions.width, dimensions.height, [...brushMarks, ...liveMark])
    const context = overlay.getContext('2d')!
    context.globalCompositeOperation = 'source-in'
    context.fillStyle = brushColor
    context.fillRect(0, 0, overlay.width, overlay.height)
    return overlay
  }, [dimensions, mode, brushMarks, traceStroke, traceBrushWidth, brushErasing, brushColor])
  useEffect(() => setSelectedPointIndex(null), [activeDatasetId])
  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const image = imageRef.current
    if (!canvas || !image) return
    const context = canvas.getContext('2d')
    if (!context) return
    context.clearRect(0, 0, canvas.width, canvas.height)
    context.save()
    context.scale(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight)
    if (showBackground) context.drawImage(displayImageRef.current ?? image, 0, 0, image.naturalWidth, image.naturalHeight)
    else {
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, image.naturalWidth, image.naturalHeight)
    }
    datasets.forEach((dataset) => {
      context.save()
      context.strokeStyle = dataset.color
      context.fillStyle = dataset.color
      context.lineWidth = Math.max(2, image.width / 700)
      if (dataset.points.length > 1) {
        context.beginPath()
        dataset.points.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y))
        context.stroke()
      }
      dataset.points.forEach((point, index) => {
        const radius = Math.max(3, image.width / 260) * pointMarkerSize / 100
        if (dataset.id === activeDatasetId && index === selectedPointIndex) {
          context.beginPath()
          context.arc(point.x, point.y, radius + 4, 0, Math.PI * 2)
          context.strokeStyle = '#ffffff'
          context.lineWidth = Math.max(1.5, image.width / 850)
          context.stroke()
        }
        context.beginPath()
        context.arc(point.x, point.y, radius, 0, Math.PI * 2)
        context.fill()
      })
      context.restore()
    })
    const calibrationLabelRects: Array<{ x: number; y: number; width: number; height: number }> = []
    calibrationMarkers.forEach(({ point, axis, index }) => {
      const radius = Math.max(6, image.width / 190)
      const selected = selectedCalibration?.axis === axis && selectedCalibration.index === index
      context.strokeStyle = selected ? calibrationMarkerColor : axis === 'x' ? '#f0bd78' : '#9eb6ff'
      context.lineWidth = Math.max(2, image.width / 900)
      context.beginPath()
      context.arc(point.x, point.y, radius + (selected ? 3 : 0), 0, Math.PI * 2)
      context.stroke()
      context.beginPath()
      context.moveTo(point.x - radius * 1.5, point.y)
      context.lineTo(point.x + radius * 1.5, point.y)
      context.moveTo(point.x, point.y - radius * 1.5)
      context.lineTo(point.x, point.y + radius * 1.5)
      context.stroke()
      const fontSize = Math.max(9, image.width / 48)
      context.font = `bold ${fontSize}px sans-serif`
      const labelWidth = context.measureText(`${axis.toUpperCase()}${index + 1}`).width
      const labelHeight = Math.max(15, image.width / 40)
      const labelRectWidth = labelWidth + 8
      const labelCandidates = [
        { x: point.x + radius + 3, y: point.y - radius - labelHeight - 3 },
        { x: point.x + radius + 3, y: point.y + radius + 3 },
        { x: point.x - radius - labelRectWidth - 3, y: point.y - radius - labelHeight - 3 },
        { x: point.x - radius - labelRectWidth - 3, y: point.y + radius + 3 },
      ].map(({ x, y }) => ({
        x: Math.max(0, Math.min(image.naturalWidth - labelRectWidth, x)),
        y: Math.max(0, Math.min(image.naturalHeight - labelHeight, y)),
        width: labelRectWidth,
        height: labelHeight,
      }))
      const labelRect = labelCandidates.find((candidate) => calibrationLabelRects.every((existing) =>
        candidate.x + candidate.width <= existing.x ||
        existing.x + existing.width <= candidate.x ||
        candidate.y + candidate.height <= existing.y ||
        existing.y + existing.height <= candidate.y,
      )) ?? labelCandidates[0]
      calibrationLabelRects.push(labelRect)
      context.fillStyle = '#101313'
      context.fillRect(labelRect.x, labelRect.y, labelRect.width, labelRect.height)
      context.fillStyle = selected ? calibrationMarkerColor : axis === 'x' ? '#f0bd78' : '#9eb6ff'
      context.fillText(`${axis.toUpperCase()}${index + 1}`, labelRect.x + 4, labelRect.y + labelHeight / 2 + fontSize * 0.35)
    })
    context.restore()
  }, [datasets, calibrationMarkers, activeDatasetId, selectedPointIndex, selectedCalibration, calibrationMarkerColor, pointMarkerSize, showBackground])

  useEffect(() => {
    if (!imageUrl) { imageRef.current = null; displayImageRef.current = null; sourceCanvasRef.current = null; setDimensions({ width: 0, height: 0 }); return }
    const image = new Image()
    let cancelled = false
    image.crossOrigin = 'anonymous'
    const finish = (display: HTMLImageElement) => {
      if (cancelled) return
      imageRef.current = image
      displayImageRef.current = display
      const canvas = canvasRef.current
      if (!canvas) return
      canvas.width = display.naturalWidth
      canvas.height = display.naturalHeight
      const sourceCanvas = document.createElement('canvas')
      sourceCanvas.width = image.naturalWidth
      sourceCanvas.height = image.naturalHeight
      sourceCanvas.getContext('2d')!.drawImage(image, 0, 0)
      sourceCanvasRef.current = sourceCanvas
      setDimensions({ width: image.naturalWidth, height: image.naturalHeight })
      setRenderDimensions({ width: display.naturalWidth, height: display.naturalHeight })
    }
    image.onload = () => {
      if (!displayImageUrl || displayImageUrl === imageUrl) { finish(image); return }
      const display = new Image()
      display.onload = () => finish(display)
      display.onerror = () => { if (!cancelled) { onImageError(); finish(image) } }
      display.src = displayImageUrl
    }
    image.onerror = () => { if (!cancelled) onImageError() }
    image.src = imageUrl
    return () => { cancelled = true }
  }, [imageUrl, displayImageUrl])

  useEffect(() => { draw() }, [draw, dimensions])

  useEffect(() => {
    const lensCanvas = lensCanvasRef.current
    const sourceCanvas = sourceCanvasRef.current
    const context = lensCanvas?.getContext('2d')
    if (!lensCanvas || !sourceCanvas || !context || !cursor) return
    const sourceSize = lensSourceSize
    const sourceLeft = cursor.x - sourceSize / 2
    const sourceTop = cursor.y - sourceSize / 2
    context.clearRect(0, 0, lensCanvas.width, lensCanvas.height)
    context.imageSmoothingEnabled = false
    const display = displayImageRef.current
    const scaleX = display ? display.naturalWidth / sourceCanvas.width : 1
    const scaleY = display ? display.naturalHeight / sourceCanvas.height : 1
    context.drawImage(display ?? sourceCanvas, sourceLeft * scaleX, sourceTop * scaleY, sourceSize * scaleX, sourceSize * scaleY, 0, 0, lensCanvas.width, lensCanvas.height)
    const mapX = (x: number) => (x - sourceLeft) * lensCanvas.width / sourceSize
    const mapY = (y: number) => (y - sourceTop) * lensCanvas.height / sourceSize
    datasets.forEach((dataset) => {
      context.strokeStyle = dataset.color
      context.fillStyle = dataset.color
      context.lineWidth = 2
      if (dataset.points.length > 1) {
        context.beginPath()
        dataset.points.forEach((point, index) => index ? context.lineTo(mapX(point.x), mapY(point.y)) : context.moveTo(mapX(point.x), mapY(point.y)))
        context.stroke()
      }
      dataset.points.forEach((point, index) => {
        const x = mapX(point.x)
        const y = mapY(point.y)
        if (x < 0 || y < 0 || x > lensCanvas.width || y > lensCanvas.height) return
        context.beginPath()
        context.arc(x, y, (dataset.id === activeDatasetId && index === selectedPointIndex ? 4 : 2.5) * pointMarkerSize / 100, 0, Math.PI * 2)
        context.fill()
        if (dataset.id === activeDatasetId && index === selectedPointIndex) {
          context.strokeStyle = '#ffffff'
          context.lineWidth = 1.5
          context.stroke()
          context.strokeStyle = dataset.color
        }
      })
    })
    if (showCalibrationMarkers) calibrationMarkers.forEach(({ point, axis, index }) => {
      const x = mapX(point.x)
      const y = mapY(point.y)
      if (x < 0 || y < 0 || x > lensCanvas.width || y > lensCanvas.height) return
      context.strokeStyle = selectedCalibration?.axis === axis && selectedCalibration.index === index ? calibrationMarkerColor : axis === 'x' ? '#f0bd78' : '#9eb6ff'
      context.lineWidth = 1.5
      context.strokeRect(x - 4, y - 4, 8, 8)
      context.font = 'bold 9px sans-serif'
      context.fillStyle = '#101313'
      context.fillRect(x + 5, y - 10, 20, 12)
      context.fillStyle = context.strokeStyle
      context.fillText(`${axis.toUpperCase()}${index + 1}`, x + 7, y - 1)
    })
    if (brushOverlay) {
      context.globalAlpha = 0.5
      context.drawImage(brushOverlay, sourceLeft, sourceTop, sourceSize, sourceSize, 0, 0, lensCanvas.width, lensCanvas.height)
      context.globalAlpha = 1
    }
    const lensStroke = mode === 'prep-line' && traceStroke.length > 1
      ? [traceStroke[0], traceStroke[traceStroke.length - 1]]
      : mode === 'prep-erase' || mode === 'prep-draw' || mode === 'prep-line' ? traceStroke : []
    if (lensStroke.length) {
      context.beginPath()
      if (lensStroke.length === 1) {
        context.moveTo(mapX(lensStroke[0].x), mapY(lensStroke[0].y))
        context.lineTo(mapX(lensStroke[0].x) + 0.01, mapY(lensStroke[0].y))
      } else lensStroke.forEach((point, index) => index ? context.lineTo(mapX(point.x), mapY(point.y)) : context.moveTo(mapX(point.x), mapY(point.y)))
      context.strokeStyle = mode === 'prep-erase' ? 'rgba(232, 120, 120, 0.7)' : correctionColor
      context.lineWidth = (mode === 'prep-erase' ? eraserWidth : correctionWidth) * lensCanvas.width / sourceSize
      context.lineCap = 'round'
      context.lineJoin = 'round'
      context.stroke()
    }
    if (mode === 'prep-erase' || mode === 'trace-region') {
      context.beginPath()
      context.arc(lensCanvas.width / 2, lensCanvas.height / 2, previewWidth * lensCanvas.width / sourceSize / 2, 0, Math.PI * 2)
      context.fillStyle = mode === 'trace-region' && !brushErasing ? brushColor : 'rgba(232, 120, 120, 0.3)'
      context.globalAlpha = mode === 'trace-region' && !brushErasing ? 0.3 : 1
      context.fill()
      context.globalAlpha = 1
      context.strokeStyle = mode === 'trace-region' && !brushErasing ? brushColor : '#dc3030'
      context.lineWidth = 1.5
      context.stroke()
    }
    context.strokeStyle = '#4ce2c5'
    context.lineWidth = 1
    context.beginPath()
    context.moveTo(lensCanvas.width / 2, 0)
    context.lineTo(lensCanvas.width / 2, lensCanvas.height)
    context.moveTo(0, lensCanvas.height / 2)
    context.lineTo(lensCanvas.width, lensCanvas.height / 2)
    context.stroke()
  }, [cursor, datasets, activeDatasetId, selectedPointIndex, calibrationMarkers, showCalibrationMarkers, selectedCalibration, calibrationMarkerColor, pointMarkerSize, dimensions, imageUrl, displayImageUrl, mode, eraserWidth, lensSourceSize, traceStroke, brushOverlay, brushErasing, brushColor, previewWidth, correctionColor, correctionWidth])

  const toImagePoint = (event: Pick<React.PointerEvent<HTMLCanvasElement>, 'clientX' | 'clientY'>) => {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    return { x: (event.clientX - rect.left) * dimensions.width / rect.width, y: (event.clientY - rect.top) * dimensions.height / rect.height }
  }

  const activeDataset = datasets.find((dataset) => dataset.id === activeDatasetId)
  const cropRect = cropStart && cropCursor ? {
    x: Math.min(cropStart.x, cropCursor.x), y: Math.min(cropStart.y, cropCursor.y),
    width: Math.abs(cropCursor.x - cropStart.x), height: Math.abs(cropCursor.y - cropStart.y),
  } : null

  const handleCanvasClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (readOnly) return
    if (suppressClickRef.current) { suppressClickRef.current = false; return }
    if (mode === 'calibrate-edit' || mode === 'point-edit' || mode === 'select') return
    onCanvasClick(toImagePoint(event))
    if (mode === 'point') setSelectedPointIndex(activeDataset?.points.length ?? null)
  }

  const handleCanvasKeyDown = (event: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (readOnly) return
    if (event.key === 'Delete' && mode === 'point-edit' && selectedPointIndex !== null && activeDataset?.points[selectedPointIndex]) {
      event.preventDefault()
      onDeleteSelectedPoint(selectedPointIndex)
      setSelectedPointIndex(null)
      return
    }
    const directions: Record<string, PixelPoint> = {
      ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 },
      ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 },
    }
    const direction = directions[event.key]
    if (!direction) return
    event.preventDefault()
    const step = event.shiftKey ? 10 : 1
    if (mode === 'calibrate-edit' && selectedCalibration) {
      const marker = calibrationMarkers.find(({ axis, index }) => axis === selectedCalibration.axis && index === selectedCalibration.index)
      if (!marker) return
      onMoveCalibrationPoint(marker.axis, marker.index, {
        x: Math.max(0, Math.min(dimensions.width - 1, marker.point.x + direction.x * step)),
        y: Math.max(0, Math.min(dimensions.height - 1, marker.point.y + direction.y * step)),
      })
      return
    }
    if ((mode !== 'point-edit' && mode !== 'select') || selectedPointIndex === null || !activeDataset) return
    const point = activeDataset.points[selectedPointIndex]
    if (!point) return
    onMovePoint(selectedPointIndex, {
      x: Math.max(0, Math.min(dimensions.width - 1, point.x + direction.x * step)),
      y: Math.max(0, Math.min(dimensions.height - 1, point.y + direction.y * step)),
    })
  }

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (readOnly || event.button !== 0) return
    if (mode === 'crop' || mode === 'prep-region') {
      const point = toImagePoint(event)
      event.currentTarget.setPointerCapture(event.pointerId)
      cropStartRef.current = point
      cropCursorRef.current = point
      setCropStart(point)
      setCropCursor(point)
      return
    }
    if (mode === 'trace-region' || mode === 'prep-draw' || mode === 'prep-line' || mode === 'prep-erase') {
      event.currentTarget.setPointerCapture(event.pointerId)
      const point = toImagePoint(event)
      const stroke = [point]
      traceStrokeRef.current = stroke
      setTraceStroke(stroke)
      return
    }
    if (mode === 'calibrate-edit') {
      event.currentTarget.focus()
      const point = toImagePoint(event)
      const candidates = calibrationMarkers.map((marker) => ({ marker, distance: Math.hypot(marker.point.x - point.x, marker.point.y - point.y) }))
        .filter(({ distance }) => distance < 20)
        .sort((a, b) => a.distance - b.distance)
      const nearestDistance = candidates[0]?.distance
      const overlapping = candidates.filter(({ distance }) => nearestDistance !== undefined && Math.abs(distance - nearestDistance) < 0.01)
      const selectedIndex = overlapping.findIndex(({ marker }) => marker.axis === selectedCalibration?.axis && marker.index === selectedCalibration.index)
      const nearest = overlapping[(selectedIndex + 1) % overlapping.length]
      if (nearest) {
        const selected = { axis: nearest.marker.axis, index: nearest.marker.index }
        draggedCalibrationRef.current = selected
        setSelectedCalibration(selected)
        event.currentTarget.setPointerCapture(event.pointerId)
      }
      return
    }
    if (mode !== 'point' && mode !== 'point-edit' && mode !== 'select' && mode !== 'surge' && mode !== 'choke' && mode !== 'speed') return
    event.currentTarget.focus()
    const point = toImagePoint(event)
    const nearest = activeDataset?.points.reduce<{ index: number; distance: number } | null>((best, candidate, index) => {
      const distance = Math.hypot(candidate.x - point.x, candidate.y - point.y)
      return distance < Math.max(18, Math.max(3, dimensions.width / 260) * pointMarkerSize / 100) && (!best || distance < best.distance) ? { index, distance } : best
    }, null)
    if (nearest) {
      draggedPointRef.current = nearest.index
      setSelectedPointIndex(nearest.index)
      event.currentTarget.focus()
      event.currentTarget.setPointerCapture(event.pointerId)
    } else if (mode === 'point-edit' || mode === 'select') setSelectedPointIndex(null)
  }

  const handleMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rawPoint = toImagePoint(event)
    const point = {
      x: Math.max(0, Math.min(dimensions.width - 1, rawPoint.x)),
      y: Math.max(0, Math.min(dimensions.height - 1, rawPoint.y)),
    }
    if (draggedPointRef.current !== null) onMovePoint(draggedPointRef.current, point)
    if (draggedCalibrationRef.current) {
      const { axis, index } = draggedCalibrationRef.current
      onMoveCalibrationPoint(axis, index, point)
    }
    if ((mode === 'trace-region' || mode === 'prep-draw' || mode === 'prep-line' || mode === 'prep-erase') && event.buttons !== 0 && traceStrokeRef.current.length) {
      const stroke = traceStrokeRef.current
      const last = stroke[stroke.length - 1]
      if (Math.hypot(point.x - last.x, point.y - last.y) >= 2) {
        const nextStroke = [...stroke, point]
        traceStrokeRef.current = nextStroke
        setTraceStroke(nextStroke)
      }
    }
    if (cropStartRef.current) { cropCursorRef.current = point; setCropCursor(point) }
    setCursor(point)
    const shell = event.currentTarget.closest('.canvas-shell')
    const shellBounds = shell?.getBoundingClientRect()
    if (shellBounds) setLensPosition({ x: Math.max(8, Math.min(shellBounds.width - 136, event.clientX - shellBounds.left + 14)), y: Math.max(8, Math.min(shellBounds.height - 148, event.clientY - shellBounds.top + 14)) })
    const sourceCanvas = sourceCanvasRef.current
    const sourceContext = sourceCanvas?.getContext('2d', { willReadFrequently: true })
    if (mode === 'speed' && sourceContext && point.x >= 0 && point.y >= 0 && point.x < sourceCanvas!.width && point.y < sourceCanvas!.height) {
      const pixel = sourceContext.getImageData(Math.round(point.x), Math.round(point.y), 1, 1).data
      const color: [number, number, number] = [pixel[0], pixel[1], pixel[2]]
      if (!lastSeedColorRef.current || color.some((channel, index) => channel !== lastSeedColorRef.current?.[index])) {
        lastSeedColorRef.current = color
        onSeedColor(color)
      }
    }
  }

  const handlePointerUp = () => {
    if (traceStrokeRef.current.length) {
      const stroke = traceStrokeRef.current
      traceStrokeRef.current = []
      setTraceStroke([])
      if (stroke.length > 1 || mode === 'prep-erase' || mode === 'trace-region') {
        const middle = stroke[Math.floor(stroke.length / 2)]
        const sourceCanvas = sourceCanvasRef.current
        const sourceContext = sourceCanvas?.getContext('2d', { willReadFrequently: true })
        if (mode === 'trace-region' && !brushErasing && sourceContext && middle.x >= 0 && middle.y >= 0 && middle.x < sourceCanvas!.width && middle.y < sourceCanvas!.height) {
          const pixel = sourceContext.getImageData(Math.round(middle.x), Math.round(middle.y), 1, 1).data
          const color: [number, number, number] = [pixel[0], pixel[1], pixel[2]]
          lastSeedColorRef.current = color
          onSeedColor(color)
        }
        onTraceRegion(stroke)
      }
      suppressClickRef.current = true
      return
    }
    if (draggedCalibrationRef.current) {
      draggedCalibrationRef.current = null
      suppressClickRef.current = true
      return
    }
    if (draggedPointRef.current !== null) {
      draggedPointRef.current = null
      suppressClickRef.current = true
      return
    }
    const start = cropStartRef.current
    const end = cropCursorRef.current
    const selection = start && end ? {
      x: Math.min(start.x, end.x), y: Math.min(start.y, end.y),
      width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y),
    } : null
    if (mode === 'crop' && selection && selection.width > 5 && selection.height > 5) onCropSelection(selection)
    if (mode === 'prep-region' && selection && selection.width > 5 && selection.height > 5) onRegionSelection(selection)
    if (mode === 'crop' || mode === 'prep-region') suppressClickRef.current = true
    cropStartRef.current = null
    cropCursorRef.current = null
    setCropStart(null)
    setCropCursor(null)
  }

  const handleContextMenu = (event: React.MouseEvent<HTMLCanvasElement>) => {
    event.preventDefault()
    if (readOnly) return
    setSelectedPointIndex(null)
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    if (mode !== 'prep-region' && mode !== 'prep-draw' && mode !== 'prep-line' && mode !== 'prep-erase') onDeletePoint({ x: (event.clientX - rect.left) * dimensions.width / rect.width, y: (event.clientY - rect.top) * dimensions.height / rect.height })
  }

  const calibratedCursor = cursor ? pointToData(cursor, xAxis, yAxis) : null
  const cursorText = cursor && imageRef.current
    ? calibratedCursor
      ? `${coordinateLabels.x} ${formatCoordinate(calibratedCursor.x, coordinateScales.x)} · ${coordinateLabels.y} ${formatCoordinate(calibratedCursor.y, coordinateScales.y)}`
      : `${Math.round(cursor.x)} px, ${Math.round(cursor.y)} px`
    : '—'

  return (
    <div className={`canvas-shell ${imageUrl ? 'has-image' : ''}`}>
      {imageUrl ? <>
        <div className="canvas-status"><span className="status-dot" /> {imageLabel} <span className="status-divider">/</span> {dimensions.width} × {dimensions.height} source px{(renderDimensions.width !== dimensions.width || renderDimensions.height !== dimensions.height) && ` · ${renderDimensions.width} × ${renderDimensions.height} rendered px`}</div>
        <div className="canvas-scroll">
          <div className="canvas-scale" style={{ transform: `scale(${scale})` }}>
            <canvas ref={canvasRef} style={{ width: dimensions.width, height: 'auto', aspectRatio: `${dimensions.width} / ${dimensions.height}` }} tabIndex={0} className={`plot-canvas mode-${mode}`} onClick={handleCanvasClick} onKeyDown={handleCanvasKeyDown} onContextMenu={handleContextMenu} onPointerDown={handlePointerDown} onPointerUp={handlePointerUp} onPointerCancel={() => { traceStrokeRef.current = []; cropStartRef.current = null; cropCursorRef.current = null; setTraceStroke([]); setCropStart(null); setCropCursor(null); draggedPointRef.current = null; draggedCalibrationRef.current = null }} onPointerMove={handleMove} onPointerLeave={() => { setCursor(null); setLensPosition(null) }} aria-label="Plot image canvas. Select a curve point in Modify mode and press Delete to remove it, or use arrow keys to move it; hold Shift to move ten pixels." />
            {brushOverlay && <canvas className="brush-overlay" width={dimensions.width} height={dimensions.height} ref={(canvas) => { if (canvas) { const ctx = canvas.getContext('2d'); if (ctx) { ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(brushOverlay, 0, 0) } } }} />}
            {(cropRect || plotRegion || (mode !== 'trace-region' && traceStroke.length > 0) || ((mode === 'prep-erase' || mode === 'trace-region') && cursor) || gridGuides.horizontal.length > 0 || gridGuides.vertical.length > 0 || axisGuides.horizontal !== null || axisGuides.vertical !== null) && dimensions.width > 0 && <svg className="crop-overlay" viewBox={`0 0 ${dimensions.width} ${dimensions.height}`} preserveAspectRatio="none" aria-hidden="true">
              {(cropRect || plotRegion) && <rect {...(cropRect ?? plotRegion!)} />}
              {mode !== 'trace-region' && traceStroke.length > 1 && <polyline style={{ vectorEffect: 'none' }} points={(mode === 'prep-line' ? [traceStroke[0], traceStroke[traceStroke.length - 1]] : traceStroke).map((point) => `${point.x},${point.y}`).join(' ')} fill="none" stroke={mode === 'prep-erase' ? '#e87878' : correctionColor} strokeOpacity={mode === 'prep-erase' ? '.7' : '1'} strokeWidth={mode === 'prep-erase' ? eraserWidth : correctionWidth} strokeLinecap="round" strokeLinejoin="round" />}
              {(mode === 'prep-draw' || mode === 'prep-line') && traceStroke.length === 1 && <circle cx={traceStroke[0].x} cy={traceStroke[0].y} r={Math.max(correctionWidth / 2, 1)} fill={correctionColor} />}
              {mode === 'prep-erase' && cursor && <circle className="eraser-preview" cx={cursor.x} cy={cursor.y} r={eraserWidth / 2} fill="#e87878" fillOpacity=".3" stroke="#dc3030" strokeWidth="1" />}
              {mode === 'trace-region' && cursor && <circle cx={cursor.x} cy={cursor.y} r={traceBrushWidth / 2} fill={brushErasing ? '#e87878' : brushColor} fillOpacity=".25" stroke={brushErasing ? '#dc3030' : brushColor} strokeWidth="1" />}
              {gridGuides.horizontal.map((y, index) => <line key={`horizontal-${index}`} x1="0" x2={dimensions.width} y1={y} y2={y} stroke="#c7b5ff" strokeOpacity=".85" strokeWidth="1.5" strokeDasharray="8 5" />)}
              {gridGuides.vertical.map((x, index) => <line key={`vertical-${index}`} x1={x} x2={x} y1="0" y2={dimensions.height} stroke="#c7b5ff" strokeOpacity=".85" strokeWidth="1.5" strokeDasharray="8 5" />)}
              {axisGuides.horizontal !== null && <line x1="0" x2={dimensions.width} y1={axisGuides.horizontal} y2={axisGuides.horizontal} stroke="#f0bd78" strokeWidth="1.5" strokeDasharray="4 4" />}
              {axisGuides.vertical !== null && <line x1={axisGuides.vertical} x2={axisGuides.vertical} y1="0" y2={dimensions.height} stroke="#f0bd78" strokeWidth="1.5" strokeDasharray="4 4" />}
            </svg>}
          </div>
        </div>
        {cursor && lensPosition && mode !== 'crop' && <div className="magnifier-lens" style={{ left: lensPosition.x, top: lensPosition.y }} aria-hidden="true"><canvas ref={lensCanvasRef} width={120} height={120} /><span>{(120 / lensSourceSize).toFixed(1)}× <i /> {Math.round(cursor.x)}, {Math.round(cursor.y)}</span></div>}
        <div className="canvas-footer">
          <span className="coordinate-readout"><span className="readout-crosshair">⌖</span> {cursorText}</span>
          <div className="zoom-controls"><button aria-label="Zoom out" onClick={() => setScale((value) => Math.max(.5, value - .1))}>−</button><span>{Math.round(scale * 100)}%</span><button aria-label="Zoom in" onClick={() => setScale((value) => Math.min(2.5, value + .1))}>+</button><button aria-label="Reset zoom" onClick={() => setScale(1)}>↗</button></div>
          <span className="canvas-hint">{activeDataset?.name ?? 'No dataset selected'} <span>·</span> Select a point · arrows nudge, Shift + arrows moves 10 px</span>
        </div>
      </> : <div className="canvas-empty">
        <div className="upload-illustration"><div className="grid-line grid-one" /><div className="grid-line grid-two" /><div className="grid-line grid-three" /><div className="axis-x" /><div className="axis-y" /><span className="plot-dot dot-one" /><span className="plot-dot dot-two" /><span className="plot-dot dot-three" /></div>
        <h2>Bring a plot into focus</h2><p>Paste an image, drop it here, or choose a file to start.</p><span className="supported-formats">PNG · JPG · WEBP · BMP</span>
      </div>}
    </div>
  )
}
