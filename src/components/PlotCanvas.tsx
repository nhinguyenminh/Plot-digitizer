import { useCallback, useEffect, useRef, useState } from 'react'
import type { Dataset, PixelPoint, ToolMode } from '../lib/digitizer'

interface Props {
  imageUrl: string | null
  datasets: Dataset[]
  activeDatasetId: string
  mode: ToolMode
  onCanvasClick: (point: PixelPoint) => void
  onDeletePoint: (point: PixelPoint) => void
  calibrationMarkers: PixelPoint[]
  onSeedColor: (rgb: [number, number, number]) => void
  onCropSelection: (rect: { x: number; y: number; width: number; height: number }) => void
  onMovePoint: (index: number, point: PixelPoint) => void
}

export default function PlotCanvas({ imageUrl, datasets, activeDatasetId, mode, onCanvasClick, onDeletePoint, calibrationMarkers, onSeedColor, onCropSelection, onMovePoint }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sourceCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const lensCanvasRef = useRef<HTMLCanvasElement>(null)
  const draggedPointRef = useRef<number | null>(null)
  const suppressClickRef = useRef(false)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const [cursor, setCursor] = useState<PixelPoint | null>(null)
  const [scale, setScale] = useState(1)
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 })
  const [cropStart, setCropStart] = useState<PixelPoint | null>(null)
  const [cropCursor, setCropCursor] = useState<PixelPoint | null>(null)
  const [lensPosition, setLensPosition] = useState<PixelPoint | null>(null)
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
      dataset.points.forEach((point) => {
        context.beginPath()
        context.arc(point.x, point.y, Math.max(3, image.width / 260), 0, Math.PI * 2)
        context.fill()
      })
      context.restore()
    })
    calibrationMarkers.forEach((point, index) => {
      const radius = Math.max(6, image.width / 190)
      context.strokeStyle = index % 2 === 0 ? '#f0bd78' : '#9eb6ff'
      context.lineWidth = Math.max(2, image.width / 900)
      context.beginPath()
      context.arc(point.x, point.y, radius, 0, Math.PI * 2)
      context.stroke()
      context.beginPath()
      context.moveTo(point.x - radius * 1.5, point.y)
      context.lineTo(point.x + radius * 1.5, point.y)
      context.moveTo(point.x, point.y - radius * 1.5)
      context.lineTo(point.x, point.y + radius * 1.5)
      context.stroke()
    })
  }, [datasets, calibrationMarkers])

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
    onCanvasClick(toImagePoint(event))
  }

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (mode === 'crop') {
      const point = toImagePoint(event)
      event.currentTarget.setPointerCapture(event.pointerId)
      setCropStart(point)
      setCropCursor(point)
      return
    }
    if (mode !== 'point' && mode !== 'select' && mode !== 'surge' && mode !== 'choke') return
    const point = toImagePoint(event)
    const nearest = activeDataset?.points.reduce<{ index: number; distance: number } | null>((best, candidate, index) => {
      const distance = Math.hypot(candidate.x - point.x, candidate.y - point.y)
      return distance < 18 && (!best || distance < best.distance) ? { index, distance } : best
    }, null)
    if (nearest) {
      draggedPointRef.current = nearest.index
      event.currentTarget.setPointerCapture(event.pointerId)
    }
  }

  const handleMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const point = toImagePoint(event)
    if (draggedPointRef.current !== null) onMovePoint(draggedPointRef.current, point)
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
        <div className="canvas-status"><span className="status-dot" /> Original image <span className="status-divider">/</span> {dimensions.width} × {dimensions.height} px</div>
        <div className="canvas-scroll">
          <div className="canvas-scale" style={{ transform: `scale(${scale})` }}>
            <canvas ref={canvasRef} className={`plot-canvas mode-${mode}`} onClick={handleCanvasClick} onContextMenu={handleContextMenu} onPointerDown={handlePointerDown} onPointerUp={handlePointerUp} onPointerMove={handleMove} onPointerLeave={() => { setCursor(null); setLensPosition(null) }} aria-label="Plot image canvas. Click to digitize points or calibrate axes; right click a point to remove it." />
            {cropRect && dimensions.width > 0 && <svg className="crop-overlay" viewBox={`0 0 ${dimensions.width} ${dimensions.height}`} preserveAspectRatio="none" aria-hidden="true"><rect {...cropRect} /></svg>}
          </div>
        </div>
        {cursor && lensPosition && mode !== 'crop' && <div className="magnifier-lens" style={{ left: lensPosition.x, top: lensPosition.y }} aria-hidden="true"><canvas ref={lensCanvasRef} width={120} height={120} /><span>3× <i /> {Math.round(cursor.x)}, {Math.round(cursor.y)}</span></div>}
        <div className="canvas-footer">
          <span className="coordinate-readout"><span className="readout-crosshair">⌖</span> {cursorText}</span>
          <div className="zoom-controls"><button aria-label="Zoom out" onClick={() => setScale((value) => Math.max(.5, value - .1))}>−</button><span>{Math.round(scale * 100)}%</span><button aria-label="Zoom in" onClick={() => setScale((value) => Math.min(2.5, value + .1))}>+</button><button aria-label="Reset zoom" onClick={() => setScale(1)}>↗</button></div>
          <span className="canvas-hint">{activeDataset?.name ?? 'No dataset selected'} <span>·</span> Right-click to remove a point</span>
        </div>
      </> : <div className="canvas-empty">
        <div className="upload-illustration"><div className="grid-line grid-one" /><div className="grid-line grid-two" /><div className="grid-line grid-three" /><div className="axis-x" /><div className="axis-y" /><span className="plot-dot dot-one" /><span className="plot-dot dot-two" /><span className="plot-dot dot-three" /></div>
        <h2>Bring a plot into focus</h2><p>Drop an image here or choose a file to start tracing data.</p><span className="supported-formats">PNG · JPG · WEBP · BMP</span>
      </div>}
    </div>
  )
}
