import { useCallback, useEffect, useRef, useState } from 'react'
import type { Dataset, PixelPoint, ToolMode } from '../lib/digitizer'

interface CalibrationMarker {
  axis: 'x' | 'y'
  index: number
  point: PixelPoint
}

interface Props {
  imageUrl: string | null
  imageLabel: string
  datasets: Dataset[]
  activeDatasetId: string
  mode: ToolMode
  onCanvasClick: (point: PixelPoint) => void
  onDeletePoint: (point: PixelPoint) => void
  calibrationMarkers: CalibrationMarker[]
  onSeedColor: (rgb: [number, number, number]) => void
  onCropSelection: (rect: { x: number; y: number; width: number; height: number }) => void
  onMovePoint: (index: number, point: PixelPoint) => void
  onMoveCalibrationPoint: (axis: 'x' | 'y', index: number, point: PixelPoint) => void
}

export default function PlotCanvas({ imageUrl, imageLabel, datasets, activeDatasetId, mode, onCanvasClick, onDeletePoint, calibrationMarkers, onSeedColor, onCropSelection, onMovePoint, onMoveCalibrationPoint }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sourceCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const lensCanvasRef = useRef<HTMLCanvasElement>(null)
  const draggedPointRef = useRef<number | null>(null)
  const draggedCalibrationRef = useRef<{ axis: 'x' | 'y'; index: number } | null>(null)
  const suppressClickRef = useRef(false)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const [cursor, setCursor] = useState<PixelPoint | null>(null)
  const [scale, setScale] = useState(1)
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 })
  const [cropStart, setCropStart] = useState<PixelPoint | null>(null)
  const [cropCursor, setCropCursor] = useState<PixelPoint | null>(null)
  const [lensPosition, setLensPosition] = useState<PixelPoint | null>(null)
  const [selectedPointIndex, setSelectedPointIndex] = useState<number | null>(null)
  const [selectedCalibration, setSelectedCalibration] = useState<{ axis: 'x' | 'y'; index: number } | null>(null)
  useEffect(() => setSelectedPointIndex(null), [activeDatasetId])
  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const image = imageRef.current
    if (!canvas || !image) return
    const context = canvas.getContext('2d')
    if (!context) return
    context.clearRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0)
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
        const radius = Math.max(3, image.width / 260)
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
    calibrationMarkers.forEach(({ point, axis, index }) => {
      const radius = Math.max(6, image.width / 190)
      const selected = selectedCalibration?.axis === axis && selectedCalibration.index === index
      context.strokeStyle = selected ? '#ffffff' : axis === 'x' ? '#f0bd78' : '#9eb6ff'
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
    })
  }, [datasets, calibrationMarkers, activeDatasetId, selectedPointIndex, selectedCalibration])

  useEffect(() => {
    if (!imageUrl) { imageRef.current = null; setDimensions({ width: 0, height: 0 }); return }
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.onload = () => {
      imageRef.current = image
      const canvas = canvasRef.current
      if (!canvas) return
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const sourceCanvas = document.createElement('canvas')
      sourceCanvas.width = image.naturalWidth
      sourceCanvas.height = image.naturalHeight
      sourceCanvas.getContext('2d')!.drawImage(image, 0, 0)
      sourceCanvasRef.current = sourceCanvas
      setDimensions({ width: image.naturalWidth, height: image.naturalHeight })
      draw()
    }
    image.src = imageUrl
  }, [imageUrl, draw])

  useEffect(() => {
    const lensCanvas = lensCanvasRef.current
    const sourceCanvas = sourceCanvasRef.current
    const context = lensCanvas?.getContext('2d')
    if (!lensCanvas || !sourceCanvas || !context || !cursor) return
    const sourceSize = 42
    context.clearRect(0, 0, lensCanvas.width, lensCanvas.height)
    context.imageSmoothingEnabled = false
    context.drawImage(sourceCanvas, cursor.x - sourceSize / 2, cursor.y - sourceSize / 2, sourceSize, sourceSize, 0, 0, lensCanvas.width, lensCanvas.height)
    context.strokeStyle = '#4ce2c5'
    context.lineWidth = 1
    context.beginPath()
    context.moveTo(lensCanvas.width / 2, 0)
    context.lineTo(lensCanvas.width / 2, lensCanvas.height)
    context.moveTo(0, lensCanvas.height / 2)
    context.lineTo(lensCanvas.width, lensCanvas.height / 2)
    context.stroke()
  }, [cursor])

  const toImagePoint = (event: Pick<React.PointerEvent<HTMLCanvasElement>, 'clientX' | 'clientY'>) => {
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    return { x: (event.clientX - rect.left) * canvas.width / rect.width, y: (event.clientY - rect.top) * canvas.height / rect.height }
  }

  const activeDataset = datasets.find((dataset) => dataset.id === activeDatasetId)
  const cropRect = cropStart && cropCursor ? {
    x: Math.min(cropStart.x, cropCursor.x), y: Math.min(cropStart.y, cropCursor.y),
    width: Math.abs(cropCursor.x - cropStart.x), height: Math.abs(cropCursor.y - cropStart.y),
  } : null

  const handleCanvasClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (suppressClickRef.current) { suppressClickRef.current = false; return }
    if (mode === 'calibrate-edit' || mode === 'point-edit' || mode === 'select') return
    onCanvasClick(toImagePoint(event))
    if (mode === 'point') setSelectedPointIndex(activeDataset?.points.length ?? null)
  }

  const handleCanvasKeyDown = (event: React.KeyboardEvent<HTMLCanvasElement>) => {
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
    if (mode === 'crop') {
      const point = toImagePoint(event)
      event.currentTarget.setPointerCapture(event.pointerId)
      setCropStart(point)
      setCropCursor(point)
      return
    }
    if (mode === 'calibrate-edit') {
      event.currentTarget.focus()
      const point = toImagePoint(event)
      const nearest = calibrationMarkers.reduce<{ marker: CalibrationMarker; distance: number } | null>((best, marker) => {
        const distance = Math.hypot(marker.point.x - point.x, marker.point.y - point.y)
        return distance < 20 && (!best || distance < best.distance) ? { marker, distance } : best
      }, null)
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
      return distance < 18 && (!best || distance < best.distance) ? { index, distance } : best
    }, null)
    if (nearest) {
      draggedPointRef.current = nearest.index
      setSelectedPointIndex(nearest.index)
      event.currentTarget.focus()
      event.currentTarget.setPointerCapture(event.pointerId)
    }
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
    if (cropStart) setCropCursor(point)
    setCursor(point)
    const shell = event.currentTarget.closest('.canvas-shell')
    const shellBounds = shell?.getBoundingClientRect()
    if (shellBounds) setLensPosition({ x: Math.max(8, Math.min(shellBounds.width - 136, event.clientX - shellBounds.left + 14)), y: Math.max(8, Math.min(shellBounds.height - 148, event.clientY - shellBounds.top + 14)) })
    const sourceCanvas = sourceCanvasRef.current
    const sourceContext = sourceCanvas?.getContext('2d', { willReadFrequently: true })
    if (sourceContext && point.x >= 0 && point.y >= 0 && point.x < sourceCanvas!.width && point.y < sourceCanvas!.height) {
      const pixel = sourceContext.getImageData(Math.round(point.x), Math.round(point.y), 1, 1).data
      onSeedColor([pixel[0], pixel[1], pixel[2]])
    }
  }

  const handlePointerUp = () => {
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
    if (mode === 'crop' && cropRect && cropRect.width > 5 && cropRect.height > 5) onCropSelection(cropRect)
    setCropStart(null)
    setCropCursor(null)
  }

  const handleContextMenu = (event: React.MouseEvent<HTMLCanvasElement>) => {
    event.preventDefault()
    const canvas = canvasRef.current!
    const rect = canvas.getBoundingClientRect()
    onDeletePoint({ x: (event.clientX - rect.left) * canvas.width / rect.width, y: (event.clientY - rect.top) * canvas.height / rect.height })
  }

  const cursorText = cursor && imageRef.current ? `${Math.round(cursor.x)} px, ${Math.round(cursor.y)} px` : '—'

  return (
    <div className={`canvas-shell ${imageUrl ? 'has-image' : ''}`}>
      {imageUrl ? <>
        <div className="canvas-status"><span className="status-dot" /> {imageLabel} <span className="status-divider">/</span> {dimensions.width} × {dimensions.height} px</div>
        <div className="canvas-scroll">
          <div className="canvas-scale" style={{ transform: `scale(${scale})` }}>
            <canvas ref={canvasRef} tabIndex={0} className={`plot-canvas mode-${mode}`} onClick={handleCanvasClick} onKeyDown={handleCanvasKeyDown} onContextMenu={handleContextMenu} onPointerDown={handlePointerDown} onPointerUp={handlePointerUp} onPointerCancel={handlePointerUp} onPointerMove={handleMove} onPointerLeave={() => { setCursor(null); setLensPosition(null) }} aria-label="Plot image canvas. Add or edit curve points, edit calibration markers, and use arrow keys to nudge a selected point; hold Shift to move ten pixels." />
            {cropRect && dimensions.width > 0 && <svg className="crop-overlay" viewBox={`0 0 ${dimensions.width} ${dimensions.height}`} preserveAspectRatio="none" aria-hidden="true"><rect {...cropRect} /></svg>}
          </div>
        </div>
        {cursor && lensPosition && mode !== 'crop' && <div className="magnifier-lens" style={{ left: lensPosition.x, top: lensPosition.y }} aria-hidden="true"><canvas ref={lensCanvasRef} width={120} height={120} /><span>3× <i /> {Math.round(cursor.x)}, {Math.round(cursor.y)}</span></div>}
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
