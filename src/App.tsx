import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, ArrowDownToLine, Axis3D, Check, CircleHelp, Crosshair, Crop, FileImage, FileJson2,
  FileSpreadsheet, FlipHorizontal, FlipVertical, FolderOpen, Gauge, ImagePlus, Layers, LineChart,
  MousePointer2, MoveUpRight, RotateCcw, RotateCw, Ruler, ScanSearch, Settings2, Sparkles,
  Target, Trash2, Upload, WandSparkles,
} from 'lucide-react'
import PlotCanvas from './components/PlotCanvas'
import ImagePreparationPanel from './components/ImagePreparationPanel'
import { adjustPlotImage, detectPlotAxes } from './lib/image-processing'
import type { DetectedAxes, ImageAdjustments } from './lib/image-processing'
import { downloadFile, pointToData, traceColor } from './lib/digitizer'
import type { AxisCalibration, CalPoint, Dataset, DatasetKind, PixelPoint, PlotType, ScaleType, ToolMode } from './lib/digitizer'

type Notice = { message: string; type?: 'error' | 'success' }
type CompressorAxisVariable = 'flow' | 'head' | 'outletPressure' | 'pressureRatio' | 'efficiency' | 'speed' | 'igv' | 'custom'
type CompressorAxisConfig = { variable: CompressorAxisVariable; label: string; unit: string }
type CompressorAxes = { x: CompressorAxisConfig; y: CompressorAxisConfig }
const palette = ['#48d7bf', '#f4a261', '#b9a7ff', '#e87878', '#73b7ed', '#e7ca76', '#ef8bcb']
const plotOptions: { id: PlotType; label: string; icon: typeof LineChart }[] = [
  { id: 'xy', label: 'X-Y Plot', icon: LineChart }, { id: 'bar', label: 'Bar Chart', icon: Activity },
  { id: 'polar', label: 'Polar', icon: Target }, { id: 'ternary', label: 'Ternary', icon: Axis3D },
  { id: 'map', label: 'Map scale', icon: MoveUpRight }, { id: 'measurement', label: 'Image measure', icon: Ruler },
  { id: 'compressor', label: 'Compressor map', icon: Gauge },
]
const blankAxis = (): AxisCalibration => ({ points: [], scale: 'linear' })
const compressorAxisLabels: Record<CompressorAxisVariable, string> = {
  flow: 'Flow', head: 'Head', outletPressure: 'Outlet pressure', pressureRatio: 'Pressure ratio',
  efficiency: 'Efficiency', speed: 'Speed', igv: 'IGV', custom: 'Custom',
}
const compressorAxisOptions = (Object.entries(compressorAxisLabels) as [CompressorAxisVariable, string][]).map(([value, label]) => ({ value, label }))
const defaultCompressorAxes: CompressorAxes = {
  x: { variable: 'flow', label: 'Flow', unit: '' },
  y: { variable: 'pressureRatio', label: 'Pressure ratio', unit: '' },
}
type FourPointValues = { x1: string; x2: string; y1: string; y2: string }
const initialFourPointValues: FourPointValues = { x1: '0', x2: '1', y1: '0', y2: '1' }
const distanceToSegment = (point: PixelPoint, start: PixelPoint, end: PixelPoint) => {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const lengthSquared = dx * dx + dy * dy
  const t = lengthSquared ? Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared)) : 0
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy))
}

const defaultDataset = (index: number, kind: DatasetKind = 'curve'): Dataset => ({
  id: crypto.randomUUID(), name: kind === 'surge' ? 'Surge line' : kind === 'choke' ? 'Choke line' : kind === 'speed' ? `Speed line ${index}` : kind === 'efficiency' ? `Efficiency contour ${index}` : `Dataset ${index}`,
  color: palette[(index - 1) % palette.length], kind, points: [],
  rpm: kind === 'speed' ? 10500 : undefined,
  speedUnit: kind === 'speed' ? 'RPM' : undefined,
  efficiencyValue: kind === 'efficiency' ? 80 : undefined,
})
const axisName = (axis: CompressorAxisConfig) => axis.unit ? `${axis.label} (${axis.unit})` : axis.label
const csvField = (value: string) => `"${value.replace(/"/g, '""')}"`
const formatAxisValue = (value: number, scale: ScaleType, precision: number) => scale === 'date'
  ? new Date(value).toISOString().replace('T', ' ').replace('.000Z', 'Z')
  : value.toPrecision(precision)

const modeLabels: Record<ToolMode, string> = {
  select: 'Select', 'calibrate-x': 'Set X calibration', 'calibrate-y': 'Set Y calibration',
  'calibrate-four': 'Four-point calibration', point: 'Add data points',
  surge: 'Trace surge boundary', choke: 'Trace choke boundary', speed: 'Trace speed line', measure: 'Measure distance', trace: 'Seed auto-trace', crop: 'Crop image',
}

export default function App() {
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [sourceImageUrl, setSourceImageUrl] = useState<string | null>(null)
  const [processedImageUrl, setProcessedImageUrl] = useState<string | null>(null)
  const [showOriginalPreview, setShowOriginalPreview] = useState(false)
  const [imagePrepared, setImagePrepared] = useState(false)
  const [preprocessing, setPreprocessing] = useState(false)
  const [axisDetection, setAxisDetection] = useState<DetectedAxes | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const [imageName, setImageName] = useState('Untitled plot')
  const [plotType, setPlotType] = useState<PlotType>('xy')
  const [datasets, setDatasets] = useState<Dataset[]>([defaultDataset(1)])
  const [activeId, setActiveId] = useState(datasets[0].id)
  const [mode, setMode] = useState<ToolMode>('select')
  const [xAxis, setXAxis] = useState<AxisCalibration>(blankAxis())
  const [yAxis, setYAxis] = useState<AxisCalibration>(blankAxis())
  const [compressorAxes, setCompressorAxes] = useState<CompressorAxes>(defaultCompressorAxes)
  const [xValue, setXValue] = useState('0')
  const [yValue, setYValue] = useState('0')
  const [fourPointValues, setFourPointValues] = useState<FourPointValues>(initialFourPointValues)
  const [fourPointPixels, setFourPointPixels] = useState<PixelPoint[]>([])
  const [notice, setNotice] = useState<Notice | null>(null)
  const [tolerance, setTolerance] = useState(76)
  const [sampleStep, setSampleStep] = useState(3)
  const [sortBy, setSortBy] = useState<'x' | 'y'>('x')
  const [precision, setPrecision] = useState(6)
  const [seedColor, setSeedColor] = useState<[number, number, number]>([72, 215, 191])
  const [activePanel, setActivePanel] = useState<'data' | 'settings'>('data')
  const [showTable, setShowTable] = useState(false)
  const [loading, setLoading] = useState(false)
  const imageInput = useRef<HTMLInputElement>(null)
  const projectInput = useRef<HTMLInputElement>(null)
  const openImageRef = useRef<(file?: File) => void>(() => undefined)

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key === 'Escape') setMode('select')
      if (event.key.toLowerCase() === 'p') setMode('point')
      if (event.key.toLowerCase() === 'a') setMode('trace')
    }
    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [])

  const activeDataset = datasets.find((dataset) => dataset.id === activeId) ?? datasets[0]
  const totalPoints = datasets.reduce((sum, dataset) => sum + dataset.points.length, 0)
  const calibrated = xAxis.points.length >= 2 && yAxis.points.length >= 2
  const calibratedPoints = useMemo(() => activeDataset?.points.map((point) => pointToData(point, xAxis, yAxis)).filter((point) => point !== null) ?? [], [activeDataset, xAxis, yAxis])

  const showNotice = (message: string, type: Notice['type'] = 'success') => {
    setNotice({ message, type })
    window.setTimeout(() => setNotice(null), 3400)
  }

  const openImage = (file?: File) => {
    if (!file) return
    if (!file.type.startsWith('image/')) { showNotice('Choose a supported image file.', 'error'); return }
    if (file.size > 35 * 1024 * 1024) { showNotice('Images must be smaller than 35 MB.', 'error'); return }
    const nextUrl = URL.createObjectURL(file)
    setImageUrl((previous) => { if (previous?.startsWith('blob:')) URL.revokeObjectURL(previous); return nextUrl })
    setSourceImageUrl((previous) => { if (previous?.startsWith('blob:')) URL.revokeObjectURL(previous); return nextUrl })
    setProcessedImageUrl(null); setShowOriginalPreview(false); setImagePrepared(false); setAxisDetection(null)
    setImageName(file.name.replace(/\.[^.]+$/, '') || 'Untitled plot')
    const initialDataset = defaultDataset(1)
    setXAxis(blankAxis()); setYAxis(blankAxis()); setDatasets([initialDataset]); setActiveId(initialDataset.id)
    setCompressorAxes(defaultCompressorAxes)
    setFourPointPixels([])
    setMode('select')
  }

  openImageRef.current = openImage

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      const imageItem = Array.from(event.clipboardData?.items ?? []).find((item) => item.type.startsWith('image/'))
      const file = imageItem?.getAsFile()
      if (!file) return
      event.preventDefault()
      openImageRef.current(file)
    }
    window.addEventListener('paste', handlePaste)
    return () => window.removeEventListener('paste', handlePaste)
  }, [])

  const applyImageAdjustments = async (adjustments: ImageAdjustments) => {
    if (!imageUrl) return
    setPreprocessing(true)
    try {
      const nextImage = await adjustPlotImage(sourceImageUrl ?? imageUrl, adjustments)
      setImageUrl(nextImage); setProcessedImageUrl(nextImage); setShowOriginalPreview(false)
      setAxisDetection(null)
      showNotice('Scan cleanup applied. Compare it with the original before continuing.')
    } catch { showNotice('The image could not be processed in this browser.', 'error') }
    finally { setPreprocessing(false) }
  }

  const confirmPreparedImage = () => {
    if (showOriginalPreview && processedImageUrl) setShowOriginalPreview(false)
    setImagePrepared(true)
    setMode('calibrate-x')
    showNotice('Image confirmed. Continue by calibrating the axes.')
  }

  const detectAxes = async () => {
    if (!imageUrl) return
    try {
      const detected = await detectPlotAxes(imageUrl)
      if (!detected) { showNotice('Could not confidently find the bottom and left axes. Try cropping the chart or adjust the scan first.', 'error'); return }
      setAxisDetection(detected)
      const origin: CalPoint = { ...detected.intersection, value: xAxis.scale === 'date' ? Date.parse(xValue) : Number(xValue) }
      const yOrigin: CalPoint = { ...detected.intersection, value: yAxis.scale === 'date' ? Date.parse(yValue) : Number(yValue) }
      if (!Number.isFinite(origin.value) || !Number.isFinite(yOrigin.value)) { showNotice('Enter numeric axis values before detecting the origin.', 'error'); return }
      setXAxis((current) => ({ ...current, points: [origin, ...current.points.slice(1)] }))
      setYAxis((current) => ({ ...current, points: [yOrigin, ...current.points.slice(1)] }))
      setMode('calibrate-x')
      showNotice('Axes located near the lower and left edges. Their intersection was added as the first X/Y calibration point; verify it against the chart.')
    } catch { showNotice('Axis detection failed while reading this image.', 'error') }
  }

  const updateDataset = (id: string, update: (dataset: Dataset) => Dataset) => setDatasets((current) => current.map((dataset) => dataset.id === id ? update(dataset) : dataset))
  const updatePointCoordinate = (datasetId: string, pointIndex: number, coordinate: 'x' | 'y', rawValue: string) => {
    if (!rawValue.trim()) return
    const value = Number(rawValue)
    if (!Number.isFinite(value)) return
    updateDataset(datasetId, (dataset) => ({
      ...dataset,
      points: dataset.points.map((point, index) => index === pointIndex ? { ...point, [coordinate]: value } : point),
    }))
  }
  const updateCompressorAxis = (axis: 'x' | 'y', patch: Partial<CompressorAxisConfig>) => setCompressorAxes((current) => ({
    ...current,
    [axis]: { ...current[axis], ...patch },
  }))

  const addDataset = (kind?: DatasetKind) => {
    const selectedKind = kind ?? (plotType === 'compressor' ? 'speed' : 'curve')
    const next = defaultDataset(datasets.length + 1, selectedKind)
    setDatasets((current) => [...current, next])
    setActiveId(next.id)
    setMode(selectedKind === 'surge' ? 'surge' : selectedKind === 'choke' ? 'choke' : selectedKind === 'speed' ? 'speed' : selectedKind === 'efficiency' ? 'trace' : 'point')
  }

  const handleCanvasClick = async (point: PixelPoint) => {
    if (!imageUrl || !imagePrepared) return
    if (mode === 'calibrate-four') {
      const step = fourPointPixels.length
      const keys: (keyof FourPointValues)[] = ['x1', 'x2', 'y1', 'y2']
      const key = keys[step]
      if (!key) { setFourPointPixels([]); return }
      const axis = step < 2 ? xAxis : yAxis
      const rawValue = fourPointValues[key]
      const value = axis.scale === 'date' ? Date.parse(rawValue) : Number(rawValue)
      if (!Number.isFinite(value)) {
        showNotice(`Enter a valid ${axis.scale === 'date' ? 'date/time' : 'numeric'} value for ${key.toUpperCase()} before clicking the chart.`, 'error')
        return
      }
      const duplicatePixel = step === 1
        ? Math.abs(fourPointPixels[0].x - point.x) < 4
        : step === 3 && Math.abs(fourPointPixels[2].y - point.y) < 4
      if (duplicatePixel) {
        showNotice('Calibration points on the same axis must be at least 4 pixels apart.', 'error')
        return
      }
      const nextPixels = [...fourPointPixels, point]
      if (nextPixels.length === 4) {
        const values = keys.map((item) => {
          const scale = item.startsWith('x') ? xAxis.scale : yAxis.scale
          return scale === 'date' ? Date.parse(fourPointValues[item]) : Number(fourPointValues[item])
        })
        const validScaleValue = (value: number, scale: ScaleType) =>
          Number.isFinite(value) && (scale !== 'log' || value > 0) && (scale !== 'inverse' || value !== 0)
        if (!values.every((item, index) => validScaleValue(item, index < 2 ? xAxis.scale : yAxis.scale))
          || values[0] === values[1] || values[2] === values[3]) {
          showNotice('Use distinct values valid for the selected axis scales (log values must be positive; inverse values cannot be zero).', 'error')
          return
        }
        setXAxis({ ...xAxis, points: [0, 1].map((index) => ({ ...nextPixels[index], value: values[index] })) })
        setYAxis({ ...yAxis, points: [2, 3].map((index) => ({ ...nextPixels[index], value: values[index] })) })
        setFourPointPixels([])
        setMode('point')
        showNotice('Four-point calibration complete. X and Y are calibrated from two reference points each.')
      } else {
        setFourPointPixels(nextPixels)
        showNotice(`${key.toUpperCase()} captured. Click ${keys[step + 1].toUpperCase()} on the chart.`)
      }
      return
    }
    if (mode === 'calibrate-x' || mode === 'calibrate-y') {
      const current = mode === 'calibrate-x' ? xAxis : yAxis
      const rawValue = mode === 'calibrate-x' ? xValue : yValue
      const value = current.scale === 'date' ? Date.parse(rawValue) : Number(rawValue)
      if (!Number.isFinite(value)) { showNotice(current.scale === 'date' ? 'Enter a recognizable date or time first.' : 'Enter a valid numeric tick value first.', 'error'); return }
      const nextPoint: CalPoint = { ...point, value }
      if (current.points.some((p) => Math.hypot(p.x - point.x, p.y - point.y) < 4)) { showNotice('That calibration point is too close to an existing one.', 'error'); return }
      if (mode === 'calibrate-x') setXAxis({ ...xAxis, points: [...xAxis.points, nextPoint] })
      else setYAxis({ ...yAxis, points: [...yAxis.points, nextPoint] })
      showNotice(`${mode === 'calibrate-x' ? 'X' : 'Y'} calibration point ${current.points.length + 1} added.`)
      return
    }
    if (mode === 'trace' || mode === 'speed') {
      setLoading(true)
      try {
        const image = new Image()
        image.src = imageUrl
        await image.decode()
        const canvas = document.createElement('canvas')
        canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
        const context = canvas.getContext('2d', { willReadFrequently: true })!
        context.drawImage(image, 0, 0)
        let traced = traceColor(context.getImageData(0, 0, canvas.width, canvas.height), point, tolerance, sampleStep)
        if (mode === 'speed') {
          const boundaries = datasets.filter((dataset) => (dataset.kind === 'surge' || dataset.kind === 'choke') && dataset.points.length > 1)
          const meetsBoundary = (candidate: PixelPoint) => boundaries.some((line) => line.points.slice(1).some((end, index) => distanceToSegment(candidate, line.points[index], end) < 10))
          const seedIndex = traced.reduce((best, candidate, index) => Math.hypot(candidate.x - point.x, candidate.y - point.y) < Math.hypot(traced[best].x - point.x, traced[best].y - point.y) ? index : best, 0)
          const left = traced.slice(0, seedIndex + 1).reverse()
          const right = traced.slice(seedIndex + 1)
          const trimAtBoundary = (points: PixelPoint[]) => {
            const boundaryIndex = points.findIndex((candidate, index) => index > 0 && meetsBoundary(candidate))
            return boundaryIndex < 0 ? points : points.slice(0, boundaryIndex)
          }
          traced = [...trimAtBoundary(left).reverse(), ...trimAtBoundary(right)]
        }
        if (traced.length < 2) { showNotice('Could not trace that color. Try increasing tolerance or choose a clearer seed.', 'error'); return }
        const targetKind: DatasetKind = mode === 'speed'
          ? 'speed'
          : plotType === 'compressor' && (activeDataset?.kind === 'efficiency' || activeDataset?.kind === 'surge' || activeDataset?.kind === 'choke')
            ? activeDataset.kind
            : 'curve'
        if (activeDataset?.kind === targetKind && (targetKind === 'speed' || targetKind === 'efficiency' || targetKind === 'surge' || targetKind === 'choke')) {
          updateDataset(activeDataset.id, (dataset) => ({ ...dataset, points: traced }))
          setMode('point')
        } else {
          const next = defaultDataset(datasets.length + 1, targetKind)
          next.name = targetKind === 'speed'
            ? `Speed line ${datasets.filter((dataset) => dataset.kind === 'speed').length + 1}`
            : targetKind === 'efficiency'
              ? `Efficiency contour ${datasets.filter((dataset) => dataset.kind === 'efficiency').length + 1}`
              : `Trace ${datasets.filter((dataset) => dataset.kind === 'curve').length + 1}`
          next.points = traced
          setDatasets((current) => [...current, next])
          setActiveId(next.id)
          setMode('point')
        }
        showNotice(`Traced ${traced.length} points along the selected curve.`)
      } catch { showNotice('Image could not be analyzed in this browser.', 'error') }
      finally { setLoading(false) }
      return
    }
    if (mode === 'surge' || mode === 'choke' || mode === 'point' || mode === 'measure') {
      if (!activeDataset) return
      updateDataset(activeDataset.id, (dataset) => ({ ...dataset, points: [...dataset.points, point] }))
    }
  }

  const deleteNearestPoint = (point: PixelPoint) => {
    if (!activeDataset) return
    if (!activeDataset.points.length) return
    const index = activeDataset.points.reduce((best, candidate, current) => {
      const bestPoint = activeDataset.points[best]
      return Math.hypot(candidate.x - point.x, candidate.y - point.y) < Math.hypot(bestPoint.x - point.x, bestPoint.y - point.y) ? current : best
    }, 0)
    if (Math.hypot(activeDataset.points[index].x - point.x, activeDataset.points[index].y - point.y) < 24) updateDataset(activeDataset.id, (dataset) => ({ ...dataset, points: dataset.points.filter((_, pointIndex) => pointIndex !== index) }))
  }

  const cropImage = async (rect: { x: number; y: number; width: number; height: number }) => {
    if (!imageUrl) return
    const image = new Image(); image.src = imageUrl; await image.decode()
    const x = Math.max(0, Math.round(rect.x))
    const y = Math.max(0, Math.round(rect.y))
    const width = Math.min(image.naturalWidth - x, Math.round(rect.width))
    const height = Math.min(image.naturalHeight - y, Math.round(rect.height))
    if (width < 10 || height < 10) { showNotice('Select a larger crop area.', 'error'); return }
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
    canvas.getContext('2d')!.drawImage(image, x, y, width, height, 0, 0, width, height)
    const shiftPoint = (point: PixelPoint): PixelPoint => ({ x: point.x - x, y: point.y - y })
    setDatasets((current) => current.map((dataset) => ({ ...dataset, points: dataset.points.filter((point) => point.x >= x && point.x <= x + width && point.y >= y && point.y <= y + height).map(shiftPoint) })))
    setXAxis((current) => ({ ...current, points: current.points.filter((point) => point.x >= x && point.x <= x + width && point.y >= y && point.y <= y + height).map((point) => ({ ...shiftPoint(point), value: point.value })) }))
    setYAxis((current) => ({ ...current, points: current.points.filter((point) => point.x >= x && point.x <= x + width && point.y >= y && point.y <= y + height).map((point) => ({ ...shiftPoint(point), value: point.value })) }))
    const croppedImage = canvas.toDataURL('image/png')
    setImageUrl(croppedImage); setSourceImageUrl(croppedImage); setProcessedImageUrl(null); setShowOriginalPreview(false); setAxisDetection(null)
    setMode('point'); showNotice('Image cropped. Calibration points outside the crop were removed.')
  }

  const applyImageTransform = async (operation: 'rotate-left' | 'rotate-right' | 'flip-x' | 'flip-y') => {
    if (!imageUrl) return
    const image = new Image(); image.src = imageUrl; await image.decode()
    const canvas = document.createElement('canvas')
    const rotate = operation === 'rotate-left' || operation === 'rotate-right'
    canvas.width = rotate ? image.naturalHeight : image.naturalWidth
    canvas.height = rotate ? image.naturalWidth : image.naturalHeight
    const context = canvas.getContext('2d')!
    context.translate(canvas.width / 2, canvas.height / 2)
    if (operation === 'rotate-left') context.rotate(-Math.PI / 2)
    if (operation === 'rotate-right') context.rotate(Math.PI / 2)
    if (operation === 'flip-x') context.scale(-1, 1)
    if (operation === 'flip-y') context.scale(1, -1)
    context.drawImage(image, -image.naturalWidth / 2, -image.naturalHeight / 2)
    const transformPoint = ({ x, y }: PixelPoint): PixelPoint => {
      if (operation === 'rotate-left') return { x: y, y: image.naturalWidth - 1 - x }
      if (operation === 'rotate-right') return { x: image.naturalHeight - 1 - y, y: x }
      if (operation === 'flip-x') return { x: image.naturalWidth - 1 - x, y }
      return { x, y: image.naturalHeight - 1 - y }
    }
    setDatasets((current) => current.map((dataset) => ({ ...dataset, points: dataset.points.map(transformPoint) })))
    setXAxis((current) => ({ ...current, points: current.points.map((point) => ({ ...transformPoint(point), value: point.value })) }))
    setYAxis((current) => ({ ...current, points: current.points.map((point) => ({ ...transformPoint(point), value: point.value })) }))
    const updated = canvas.toDataURL('image/png')
    setImageUrl(updated); setSourceImageUrl(updated); setProcessedImageUrl(null); setShowOriginalPreview(false); setAxisDetection(null)
  }

  const getExportPoints = (dataset: Dataset) => dataset.points
    .map((point) => calibrated ? pointToData(point, xAxis, yAxis) : { x: point.x, y: point.y })
    .filter((point): point is { x: number; y: number } => point !== null)
    .sort((a, b) => sortBy === 'x' ? a.x - b.x : a.y - b.y)
    .map((point) => ({ x: Number(point.x.toPrecision(precision)), y: Number(point.y.toPrecision(precision)) }))

  const exportDataset = (dataset: Dataset, format: 'csv' | 'json') => {
    const points = getExportPoints(dataset)
    const csvRows = points.map((point) => `${point.x},${point.y}`)
    if (format === 'csv') {
      const header = plotType === 'compressor' && calibrated
        ? [axisName(compressorAxes.x), axisName(compressorAxes.y)].map(csvField).join(',')
        : calibrated ? 'x,y' : 'pixel_x,pixel_y'
      downloadFile(`${dataset.name.toLowerCase().replace(/\\s+/g, '-')}.csv`, [header, ...csvRows].join('\\n'), 'text/csv')
    }
    else {
      const data = dataset.kind === 'speed'
        ? {
            rpm: dataset.rpm, speed: dataset.rpm, speedUnit: dataset.speedUnit, igv: dataset.igv, igvUnit: dataset.igvUnit,
            xValues: points.map((point) => point.x), yValues: points.map((point) => point.y),
            axes: compressorAxes,
            ...(compressorAxes.x.variable === 'flow' ? { flow: points.map((point) => point.x) } : {}),
            ...(compressorAxes.y.variable === 'pressureRatio' ? { pressureRatio: points.map((point) => point.y) } : {}),
          }
        : dataset.kind === 'efficiency'
          ? {
              efficiencyPercent: dataset.efficiencyValue,
              xValues: points.map((point) => point.x), yValues: points.map((point) => point.y),
              axes: compressorAxes,
              ...(compressorAxes.x.variable === 'flow' ? { flow: points.map((point) => point.x) } : {}),
              ...(compressorAxes.y.variable === 'efficiency' ? { efficiency: points.map((point) => point.y) } : {}),
            }
          : { points }
      downloadFile(`${dataset.name.toLowerCase().replace(/\\s+/g, '-')}.json`, JSON.stringify({
        name: dataset.name, kind: dataset.kind, coordinateSystem: calibrated ? 'calibrated' : 'image-pixels',
        ...(plotType === 'compressor' ? { axes: compressorAxes } : {}),
        ...data,
      }, null, 2), 'application/json')
    }
  }

  const exportAllJson = () => {
    const datasetsData = datasets.map((dataset) => ({ dataset, points: getExportPoints(dataset) }))
    const project = plotType === 'compressor'
      ? {
          plotType, coordinateSystem: calibrated ? 'calibrated' : 'image-pixels',
          axes: compressorAxes,
          surgeLine: datasetsData.find(({ dataset }) => dataset.kind === 'surge')?.points.map((point) => [point.x, point.y]) ?? [],
          chokeLine: datasetsData.find(({ dataset }) => dataset.kind === 'choke')?.points.map((point) => [point.x, point.y]) ?? [],
          speedLines: datasetsData.filter(({ dataset }) => dataset.kind === 'speed').map(({ dataset, points }) => ({
            name: dataset.name, rpm: dataset.rpm, speed: dataset.rpm, speedUnit: dataset.speedUnit, igv: dataset.igv, igvUnit: dataset.igvUnit,
            xValues: points.map((point) => point.x), yValues: points.map((point) => point.y), axes: compressorAxes,
            ...(compressorAxes.x.variable === 'flow' ? { flow: points.map((point) => point.x) } : {}),
            ...(compressorAxes.y.variable === 'pressureRatio' ? { pressureRatio: points.map((point) => point.y) } : {}),
          })),
          efficiencyContours: datasetsData.filter(({ dataset }) => dataset.kind === 'efficiency').map(({ dataset, points }) => ({
            name: dataset.name, efficiencyPercent: dataset.efficiencyValue,
            xValues: points.map((point) => point.x), yValues: points.map((point) => point.y), axes: compressorAxes,
            ...(compressorAxes.x.variable === 'flow' ? { flow: points.map((point) => point.x) } : {}),
            ...(compressorAxes.y.variable === 'efficiency' ? { efficiency: points.map((point) => point.y) } : {}),
          })),
        }
      : { plotType, coordinateSystem: calibrated ? 'calibrated' : 'image-pixels', datasets: datasetsData.map(({ dataset, points }) => ({ name: dataset.name, kind: dataset.kind, points })) }
    downloadFile(`${imageName || 'plot'}-data.json`, JSON.stringify(project, null, 2), 'application/json')
  }


  const exportProject = async () => {
    let portableImage = imageUrl
    if (imageUrl?.startsWith('blob:')) {
      const blob = await fetch(imageUrl).then((response) => response.blob())
      portableImage = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(new Error('Unable to package the image'))
        reader.readAsDataURL(blob)
      })
    }
    const project = { version: 1, imageName, imageUrl: portableImage, plotType, xAxis, yAxis, datasets, compressorAxes }
    downloadFile(`${imageName.toLowerCase().replace(/\\s+/g, '-') || 'plot'}-project.json`, JSON.stringify(project), 'application/json')
  }


  const importProject = async (file?: File) => {
    if (!file) return
    try {
      const project = JSON.parse(await file.text())
      if (project.version !== 1 || !Array.isArray(project.datasets)) throw new Error('Unsupported project file')
      setImageName(project.imageName || 'Imported plot'); setImageUrl(project.imageUrl || null); setSourceImageUrl(project.imageUrl || null); setProcessedImageUrl(null); setShowOriginalPreview(false); setImagePrepared(Boolean(project.imageUrl)); setAxisDetection(null); setPlotType(project.plotType || 'xy'); setFourPointPixels([]); setCompressorAxes(project.compressorAxes || defaultCompressorAxes)
      setXAxis(project.xAxis || blankAxis()); setYAxis(project.yAxis || blankAxis()); setDatasets(project.datasets)
      setActiveId(project.datasets[0]?.id ?? ''); setMode('point'); showNotice('Project opened successfully.')
    } catch { showNotice('That project file is invalid or unsupported.', 'error') }
  }

  const addCalibrationPoint = (axis: 'x' | 'y') => setMode(axis === 'x' ? 'calibrate-x' : 'calibrate-y')
  const updateScale = (axis: 'x' | 'y', scale: ScaleType) => axis === 'x' ? setXAxis({ ...xAxis, scale }) : setYAxis({ ...yAxis, scale })
  const activePoints = activeDataset?.points.length ?? 0
  const measuredDistance = calibrated && calibratedPoints.length >= 2
    ? Math.hypot(calibratedPoints[1].x - calibratedPoints[0].x, calibratedPoints[1].y - calibratedPoints[0].y)
    : activeDataset?.points.length && activeDataset.points.length >= 2
      ? Math.hypot(activeDataset.points[1].x - activeDataset.points[0].x, activeDataset.points[1].y - activeDataset.points[0].y)
      : null
  const measuredAngle = calibrated && calibratedPoints.length >= 3
    ? (() => {
        const [a, vertex, b] = calibratedPoints
        const radians = Math.atan2(b.y - vertex.y, b.x - vertex.x) - Math.atan2(a.y - vertex.y, a.x - vertex.x)
        return Math.abs(((radians * 180 / Math.PI + 540) % 360) - 180)
      })()
    : null
  const pressPointTool = () => setMode('point')

  return (
    <main className="app-frame">
      <header className="topbar">
        <a className="brand" href="#" aria-label="Plotline home"><span className="brand-mark"><span /><span /><span /></span><span>plotline</span><span className="brand-divider" /><span className="brand-subtitle">DIGITIZER</span></a>
        <div className="project-name"><span className="project-file-icon"><FileImage size={14} /></span><input aria-label="Project name" value={imageName} onChange={(event) => setImageName(event.target.value)} /><span className="saved-status"><span /> Browser session</span></div>
        <div className="top-actions"><button className="top-quiet" onClick={() => projectInput.current?.click()}><FolderOpen size={15} /> Open project</button><button className="top-quiet" onClick={exportProject}><ArrowDownToLine size={15} /> Save project</button><button className="export-top" onClick={() => exportDataset(activeDataset, 'csv')} disabled={!activeDataset?.points.length}><FileSpreadsheet size={15} /> Export data</button></div>
      </header>

      <div className="type-ribbon"><span className="ribbon-label">PLOT TYPE</span><div className="plot-tabs" role="tablist" aria-label="Plot type">
        {plotOptions.map(({ id, label, icon: Icon }) => <button key={id} role="tab" aria-selected={plotType === id} className={plotType === id ? 'plot-tab active' : 'plot-tab'} onClick={() => { setPlotType(id); if (id === 'compressor') setMode('surge'); else setMode('point') }}><Icon size={15} /><span>{label}</span></button>)}
      </div><span className="type-ribbon-spacer" /><button className="icon-action" aria-label="Help" title="Click to add calibration or digitized points. Right-click near a point to remove it." onClick={() => showNotice('Set X/Y calibration, choose Add points, then click the chart. Right-click points to remove them.')}><CircleHelp size={17} /></button></div>

      <div className="workspace">
        <aside className="left-rail">
          <div className="rail-section"><div className="rail-heading"><span>TOOLS</span></div>
            <div className="tool-group-label">CALIBRATION</div>
            <button className={`tool-button ${mode === 'calibrate-x' ? 'selected' : ''}`} onClick={() => addCalibrationPoint('x')} disabled={!imagePrepared}><span className="tool-icon axis-x-icon">X</span><span>Calibrate X axis</span><kbd>{xAxis.points.length}/2</kbd></button>
            <button className={`tool-button ${mode === 'calibrate-y' ? 'selected' : ''}`} onClick={() => addCalibrationPoint('y')} disabled={!imagePrepared}><span className="tool-icon axis-y-icon">Y</span><span>Calibrate Y axis</span><kbd>{yAxis.points.length}/2</kbd></button>
            <div className="tool-group-label tool-gap">DIGITIZE</div>
            <button className={`tool-button ${mode === 'point' ? 'selected' : ''}`} onClick={pressPointTool} disabled={!imagePrepared}><span className="tool-icon"><Crosshair size={16} /></span><span>Manual points</span><kbd>P</kbd></button>
            <button className={`tool-button ${mode === 'trace' ? 'selected' : ''}`} onClick={() => setMode('trace')} disabled={!imagePrepared}><span className="tool-icon"><WandSparkles size={16} /></span><span>Color trace</span><kbd>A</kbd></button>
            <button className={`tool-button ${mode === 'measure' ? 'selected' : ''}`} onClick={() => { if (activeDataset?.kind !== 'measurement') addDataset('measurement'); setMode('measure') }} disabled={!imagePrepared}><span className="tool-icon"><Ruler size={16} /></span><span>Measure angle / distance</span></button>
            {plotType === 'compressor' && <>
              <div className="tool-group-label tool-gap">COMPRESSOR MAP</div>
              <button className={`tool-button ${mode === 'surge' ? 'selected' : ''}`} onClick={() => { const target = datasets.find((dataset) => dataset.kind === 'surge'); if (target) setActiveId(target.id); else addDataset('surge'); setMode('surge') }}><span className="tool-icon boundary-icon">S</span><span>Surge boundary</span><kbd>{datasets.some((dataset) => dataset.kind === 'surge' && dataset.points.length >= 2) ? <Check size={13} /> : '—'}</kbd></button>
              <button className={`tool-button ${mode === 'choke' ? 'selected' : ''}`} onClick={() => { const target = datasets.find((dataset) => dataset.kind === 'choke'); if (target) setActiveId(target.id); else addDataset('choke'); setMode('choke') }}><span className="tool-icon boundary-icon choke-icon">C</span><span>Choke boundary</span><kbd>{datasets.some((dataset) => dataset.kind === 'choke' && dataset.points.length >= 2) ? <Check size={13} /> : '—'}</kbd></button>
              <button className={`tool-button ${mode === 'speed' ? 'selected' : ''}`} onClick={() => addDataset('speed')}><span className="tool-icon"><Gauge size={16} /></span><span>New speed line</span><kbd>RPM</kbd></button>
              <button className={`tool-button ${activeDataset?.kind === 'efficiency' ? 'selected' : ''}`} onClick={() => addDataset('efficiency')}><span className="tool-icon"><Activity size={16} /></span><span>Efficiency contour</span></button>
            </>}
            <div className="tool-group-label tool-gap">IMAGE</div>
            <button className={`tool-button ${mode === 'crop' ? 'selected' : ''}`} onClick={() => setMode('crop')} disabled={!imagePrepared}><span className="tool-icon"><Crop size={16} /></span><span>Crop image</span></button>
            <button className="tool-button" onClick={() => imageInput.current?.click()}><span className="tool-icon"><ImagePlus size={16} /></span><span>Replace image</span></button>
            <div className="transform-grid"><button title="Rotate left" aria-label="Rotate left" onClick={() => void applyImageTransform('rotate-left')}><RotateCcw size={15} /></button><button title="Rotate right" aria-label="Rotate right" onClick={() => void applyImageTransform('rotate-right')}><RotateCw size={15} /></button><button title="Flip horizontal" aria-label="Flip horizontal" onClick={() => void applyImageTransform('flip-x')}><FlipHorizontal size={15} /></button><button title="Flip vertical" aria-label="Flip vertical" onClick={() => void applyImageTransform('flip-y')}><FlipVertical size={15} /></button></div>
          </div>
          <div className="rail-bottom"><span className="connection-indicator" /><span>All changes stay in this browser</span><button title="Settings" aria-label="Settings" onClick={() => setActivePanel(activePanel === 'settings' ? 'data' : 'settings')}><Settings2 size={15} /></button></div>
        </aside>

        <section className="center-workspace" aria-label="Plot workspace">
          <div className="workspace-toolbar"><div className="toolbar-left"><span className="breadcrumb-root">Workspace</span><span className="breadcrumb-separator">/</span><span className="breadcrumb-active">{imageName || 'Untitled plot'}</span><span className="image-badge">{imageUrl ? 'IMAGE LOADED' : 'NO IMAGE'}</span></div><div className="toolbar-right"><button title="Undo last point" onClick={() => activeDataset && updateDataset(activeId, (dataset) => ({ ...dataset, points: dataset.points.slice(0, -1) }))} disabled={!activePoints}><RotateCcw size={14} /> Undo</button><span className="toolbar-separator" /><button title="Show point table" className={showTable ? 'toolbar-active' : ''} onClick={() => setShowTable(!showTable)}><Layers size={14} /> Data table</button></div></div>
          {plotType === 'compressor' && <div className="compressor-banner"><Gauge size={15} /><span><strong>Compressor map mode</strong> · Trace speed/IGV and efficiency curves directly; boundaries optionally stop speed traces.</span><span className="boundary-progress"><i className={datasets.some((dataset) => dataset.kind === 'surge' && dataset.points.length >= 2) ? 'complete' : ''} />Surge <i className={datasets.some((dataset) => dataset.kind === 'choke' && dataset.points.length >= 2) ? 'complete' : ''} />Choke</span></div>}
          <div className={`canvas-zone ${dragActive ? 'drag-active' : ''}`} onDragEnter={(event) => { event.preventDefault(); setDragActive(true) }} onDragOver={(event) => event.preventDefault()} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragActive(false) }} onDrop={(event) => { event.preventDefault(); setDragActive(false); const file = Array.from(event.dataTransfer.files).find((item) => item.type.startsWith('image/')); if (file) openImage(file) }}>
            <PlotCanvas imageUrl={showOriginalPreview ? sourceImageUrl : imageUrl} imageLabel={showOriginalPreview ? 'Original scan' : processedImageUrl ? 'Processed scan' : 'Original image'} datasets={datasets} activeDatasetId={activeId} mode={mode} calibrationMarkers={[...xAxis.points, ...yAxis.points, ...(axisDetection ? [axisDetection.intersection] : [])]} onCanvasClick={(point) => { void handleCanvasClick(point) }} onDeletePoint={deleteNearestPoint} onSeedColor={(rgb) => setSeedColor((current) => current.every((channel, index) => channel === rgb[index]) ? current : rgb)} onCropSelection={(rect) => { void cropImage(rect) }} onMovePoint={(index, point) => { if (activeDataset) updateDataset(activeDataset.id, (dataset) => ({ ...dataset, points: dataset.points.map((current, pointIndex) => pointIndex === index ? point : current) })) }} />
            {!imageUrl && <button className="upload-overlay" onClick={() => imageInput.current?.click()}><Upload size={15} /> Choose image</button>}
          </div>
          <div className="mode-strip"><span className="mode-symbol"><MousePointer2 size={14} /></span><span className="mode-text"><strong>{!imageUrl ? 'Upload image' : !imagePrepared ? 'Prepare image' : modeLabels[mode]}</strong>{!imageUrl ? ' · Paste or drop a plot image, or choose a file.' : !imagePrepared ? ' · Adjust scan clarity, compare before/after, then confirm in Step 01.' : mode === 'calibrate-four' ? ` · Click ${(['X1', 'X2', 'Y1', 'Y2'][fourPointPixels.length] ?? 'the next reference point')} on the chart.` : mode.startsWith('calibrate') ? ' · Click a chart tick and enter its value in the right panel.' : mode === 'trace' ? ' · Click a curve seed; the tracer follows its local shape.' : mode === 'speed' ? ' · Click a speed-line seed; available Surge/Choke boundaries stop the trace.' : mode === 'surge' || mode === 'choke' ? ' · Click sequentially along the compressor boundary.' : ' · Click to add a point. Select one and use arrow keys; Shift moves 10 px.'}</span><span className="mode-spacer" />{loading ? <span className="tracing-state"><span className="loader-dot" /> Tracing…</span> : <span className="keyboard-tip"><kbd>Esc</kbd> select</span>}</div>
          {showTable && <div className="data-table-panel">
            <div className="data-table-head">
              <strong>{activeDataset?.name ?? 'Dataset'} · calibrated values</strong>
              <span>{calibrated ? `${calibratedPoints.length} points` : 'Set both axes to show data values'} · Edit pixel coordinates to fine-tune</span>
            </div>
            <div className="data-table-scroll"><table><thead><tr><th>#</th><th>{plotType === 'compressor' ? axisName(compressorAxes.x) : 'X'}</th><th>{plotType === 'compressor' ? axisName(compressorAxes.y) : 'Y'}</th><th>Pixel X</th><th>Pixel Y</th></tr></thead>
              <tbody>{(activeDataset?.points ?? []).slice(0, 120).map((point, index) => {
                const value = pointToData(point, xAxis, yAxis)
                return <tr key={`${point.x}-${point.y}-${index}`}>
                  <td>{index + 1}</td>
                  <td>{value ? formatAxisValue(value.x, xAxis.scale, precision) : '—'}</td>
                  <td>{value ? formatAxisValue(value.y, yAxis.scale, precision) : '—'}</td>
                  <td><input className="point-coordinate-input" aria-label={`${activeDataset?.name} point ${index + 1} pixel X`} type="number" step="0.1" value={point.x} onChange={(event) => activeDataset && updatePointCoordinate(activeDataset.id, index, 'x', event.target.value)} /></td>
                  <td><input className="point-coordinate-input" aria-label={`${activeDataset?.name} point ${index + 1} pixel Y`} type="number" step="0.1" value={point.y} onChange={(event) => activeDataset && updatePointCoordinate(activeDataset.id, index, 'y', event.target.value)} /></td>
                </tr>
              })}</tbody>
            </table></div>
          </div>}
        </section>

        <aside className="right-panel">
          <div className="panel-tabs"><button className={activePanel === 'data' ? 'active' : ''} onClick={() => setActivePanel('data')}><Layers size={14} /> Data</button><button className={activePanel === 'settings' ? 'active' : ''} onClick={() => setActivePanel('settings')}><Settings2 size={14} /> Settings</button></div>
          {activePanel === 'data' ? <div className="panel-content">
            <ImagePreparationPanel hasImage={Boolean(imageUrl)} hasProcessedImage={Boolean(processedImageUrl)} showingOriginal={showOriginalPreview} processing={preprocessing} onApply={(adjustments) => { void applyImageAdjustments(adjustments) }} onToggleCompare={() => setShowOriginalPreview((current) => !current)} onContinue={confirmPreparedImage} />
            {imagePrepared && <>
            <section className="panel-section calibration-section"><div className="section-heading"><div><span className="section-kicker">STEP 02</span><h2>Axis calibration</h2></div><span className={`calibration-state ${calibrated ? 'ready' : ''}`}>{calibrated ? <><Check size={12} /> READY</> : 'NEEDED'}</span></div>
              <p className="section-copy">Click two known ticks on each axis and enter their values.</p>
              <div className="four-point-calibration">
                <strong>Guided 4-point calibration</strong>
                <p>Enter the values for two X ticks and two Y ticks, then click them in order: X1, X2, Y1, Y2.</p>
                <div className="four-point-values">
                  {(['x1', 'x2', 'y1', 'y2'] as const).map((key) => <label key={key}>{key.toUpperCase()}<input aria-label={`${key.toUpperCase()} calibration value`} value={fourPointValues[key]} placeholder={(key.startsWith('x') ? xAxis.scale : yAxis.scale) === 'date' ? 'Date / time' : 'Tick value'} onChange={(event) => setFourPointValues((current) => ({ ...current, [key]: event.target.value }))} /></label>)}
                </div>
                <button className="axis-detect-button" onClick={() => { setFourPointPixels([]); setMode('calibrate-four') }} disabled={!imagePrepared}>
                  {mode === 'calibrate-four' && fourPointPixels.length ? 'Restart 4-point calibration' : 'Start 4-point calibration'}
                </button>
              </div>
              <AxisEditor axis="x" calibration={xAxis} setValue={setXValue} value={xValue} mode={mode} setMode={setMode} addPoint={addCalibrationPoint} setScale={updateScale} />
              <AxisEditor axis="y" calibration={yAxis} setValue={setYValue} value={yValue} mode={mode} setMode={setMode} addPoint={addCalibrationPoint} setScale={updateScale} />
              <button className="axis-detect-button" onClick={() => { void detectAxes() }}><ScanSearch size={14} /> Auto-detect axes & origin</button>
              {axisDetection && <p className="axis-detect-note">Intersection near {Math.round(axisDetection.intersection.x)}, {Math.round(axisDetection.intersection.y)} px · verify against the scan.</p>}
            </section>
            {plotType === 'compressor' && <section className="panel-section compressor-axis-config">
              <div className="section-heading"><div><span className="section-kicker">COMPRESSOR MAP</span><h2>Map axes</h2></div></div>
              <p className="section-copy">Choose what the calibrated horizontal and vertical values represent.</p>
              {(['x', 'y'] as const).map((axis) => <div className="compressor-axis-fields" key={axis}>
                <label className="format-control"><span>{axis.toUpperCase()} variable</span>
                  <select aria-label={`Compressor ${axis.toUpperCase()} variable`} value={compressorAxes[axis].variable} onChange={(event) => {
                    const variable = event.target.value as CompressorAxisVariable
                    updateCompressorAxis(axis, { variable, label: compressorAxisLabels[variable] })
                  }}>
                    {compressorAxisOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </label>
                <label className="format-control"><span>{axis.toUpperCase()} label</span><input aria-label={`Compressor ${axis.toUpperCase()} label`} value={compressorAxes[axis].label} onChange={(event) => updateCompressorAxis(axis, { label: event.target.value })} /></label>
                <label className="format-control"><span>{axis.toUpperCase()} unit</span><input aria-label={`Compressor ${axis.toUpperCase()} unit`} value={compressorAxes[axis].unit} placeholder="Optional" onChange={(event) => updateCompressorAxis(axis, { unit: event.target.value })} /></label>
              </div>)}
            </section>}
            {plotType === 'compressor' && <section className="compressor-note"><div className="note-icon"><Gauge size={15} /></div><div><strong>Optional boundaries</strong><span>Add Surge/Choke to stop speed traces near their sampled points.</span></div><span className="note-status">{datasets.filter((dataset) => dataset.kind === 'surge' || dataset.kind === 'choke').filter((dataset) => dataset.points.length >= 2).length}/2</span></section>}
            <section className="panel-section datasets-section"><div className="section-heading dataset-heading"><div><span className="section-kicker">STEP 03</span><h2>Datasets <span className="count-pill">{datasets.length}</span></h2></div><button className="add-small" aria-label="Add dataset" onClick={() => addDataset()} title="Add dataset">+</button></div>
              <div className="dataset-list">{datasets.map((dataset) => <div key={dataset.id} className={`dataset-card ${dataset.id === activeId ? 'active' : ''}`}>
                <button className="dataset-select" onClick={() => { setActiveId(dataset.id); setMode(dataset.kind === 'surge' ? 'surge' : dataset.kind === 'choke' ? 'choke' : dataset.kind === 'speed' ? 'speed' : dataset.kind === 'efficiency' && plotType === 'compressor' ? 'trace' : 'point') }} aria-label={`Select ${dataset.name}`}><span className="dataset-swatch" style={{ backgroundColor: dataset.color }} /><span className="dataset-meta"><span className="dataset-name">{dataset.name}</span><span className="dataset-detail">{dataset.kind === 'speed' ? `${dataset.rpm?.toLocaleString() ?? '—'} ${dataset.speedUnit || 'RPM'}${dataset.igv === undefined ? '' : ` · IGV ${dataset.igv}${dataset.igvUnit ? ` ${dataset.igvUnit}` : ''}`}` : dataset.kind === 'efficiency' ? `${dataset.efficiencyValue ?? '—'}% contour` : dataset.kind === 'surge' ? 'Surge boundary' : dataset.kind === 'choke' ? 'Choke boundary' : `${dataset.points.length} points`}</span></span><span className="dataset-point-count">{dataset.points.length}</span></button>
                {dataset.id === activeId && <div className="dataset-controls"><input aria-label="Dataset name" value={dataset.name} onChange={(event) => updateDataset(dataset.id, (current) => ({ ...current, name: event.target.value }))} /><label className="color-control" title="Dataset color"><input aria-label="Dataset color" type="color" value={dataset.color} onChange={(event) => updateDataset(dataset.id, (current) => ({ ...current, color: event.target.value }))} /><span style={{ backgroundColor: dataset.color }} /></label><button title="Export CSV" aria-label="Export CSV" onClick={() => exportDataset(dataset, 'csv')}><FileSpreadsheet size={14} /></button><button title="Delete dataset" aria-label={`Delete ${dataset.name}`} onClick={() => { if (datasets.length === 1) { updateDataset(dataset.id, (current) => ({ ...current, points: [] })); return } const next = datasets.filter((item) => item.id !== dataset.id); setDatasets(next); setActiveId(next[0].id) }}><Trash2 size={14} /></button></div>}
                {dataset.kind === 'speed' && dataset.id === activeId && <>
                  <label className="rpm-control">Speed value <div><input aria-label="Speed value" type="number" step="100" value={dataset.rpm ?? ''} onChange={(event) => updateDataset(dataset.id, (current) => ({ ...current, rpm: event.target.value === '' ? undefined : Number(event.target.value) }))} /><input aria-label="Speed unit" value={dataset.speedUnit ?? ''} onChange={(event) => updateDataset(dataset.id, (current) => ({ ...current, speedUnit: event.target.value }))} /></div></label>
                  <label className="rpm-control">IGV setting <div><input aria-label="IGV value" type="number" step="1" value={dataset.igv ?? ''} onChange={(event) => updateDataset(dataset.id, (current) => ({ ...current, igv: event.target.value === '' ? undefined : Number(event.target.value) }))} /><input aria-label="IGV unit" value={dataset.igvUnit ?? ''} placeholder="Optional unit" onChange={(event) => updateDataset(dataset.id, (current) => ({ ...current, igvUnit: event.target.value }))} /></div></label>
                </>}
                {dataset.kind === 'efficiency' && dataset.id === activeId && <label className="rpm-control">Efficiency contour <div><input aria-label="Efficiency contour value" type="number" min="0" max="100" step="0.1" value={dataset.efficiencyValue ?? ''} onChange={(event) => updateDataset(dataset.id, (current) => ({ ...current, efficiencyValue: event.target.value === '' ? undefined : Number(event.target.value) }))} /><span>%</span></div></label>}
              </div>)}</div>
              {activeDataset?.kind === 'measurement' && <div className="measurement-results"><div><span>Distance</span><strong>{measuredDistance === null ? 'Add two points' : calibrated ? measuredDistance.toPrecision(5) : `${measuredDistance.toFixed(1)} px`}</strong></div><div><span>Angle</span><strong>{measuredAngle === null ? 'Add 3 points' : `${measuredAngle.toFixed(2)}°`}</strong></div></div>}
              <button className="add-dataset-button" onClick={() => addDataset()}><span>+</span> Add dataset</button>
            </section>
            {mode === 'trace' || mode === 'speed' ? <section className="panel-section extraction-section"><div className="section-heading"><div><span className="section-kicker">AUTO TRACE</span><h2>Smart curve trace</h2></div><ScanSearch size={16} /></div><p className="section-copy">Sampled color <span className="color-chip" style={{ backgroundColor: `rgb(${seedColor.join(',')})` }} /> RGB {seedColor.join(', ')}</p><label className="range-row"><span>Color tolerance</span><strong>{tolerance}</strong><input type="range" min="12" max="180" value={tolerance} onChange={(event) => setTolerance(Number(event.target.value))} /></label><label className="range-row"><span>X-step sampling</span><strong>{sampleStep}px</strong><input type="range" min="1" max="12" value={sampleStep} onChange={(event) => setSampleStep(Number(event.target.value))} /></label><div className="trace-hint"><Sparkles size={13} /> Seeds both directions and favors color matches that continue the curve's local direction.</div></section> : null}
            <div className="panel-footer"><span className="footer-stat"><Crosshair size={13} /> {totalPoints} points</span><span className="footer-stat"><Layers size={13} /> {datasets.length} datasets</span></div>
            </>}
          </div> : <div className="panel-content settings-content">
            <section className="panel-section"><div className="section-heading"><div><span className="section-kicker">IMAGE TOOLS</span><h2>Pre-processing</h2></div></div><p className="section-copy">Apply transforms to the source image before digitizing.</p><div className="settings-transform"><button onClick={() => void applyImageTransform('rotate-left')}><RotateCcw size={15} /> Rotate left</button><button onClick={() => void applyImageTransform('rotate-right')}><RotateCw size={15} /> Rotate right</button><button onClick={() => void applyImageTransform('flip-x')}><FlipHorizontal size={15} /> Flip horizontal</button><button onClick={() => void applyImageTransform('flip-y')}><FlipVertical size={15} /> Flip vertical</button></div></section>
            <section className="panel-section"><div className="section-heading"><div><span className="section-kicker">PROJECT</span><h2>Export & restore</h2></div></div><p className="section-copy">Project files include the source image, calibration and all datasets.</p><button className="settings-action" onClick={exportProject}><ArrowDownToLine size={15} /> Save editable project</button><button className="settings-action" onClick={() => projectInput.current?.click()}><FolderOpen size={15} /> Open project file</button><button className="settings-action" onClick={exportAllJson}><FileJson2 size={15} /> Export all datasets as JSON</button></section>
            <section className="panel-section"><div className="section-heading"><div><span className="section-kicker">OUTPUT</span><h2>Data formatting</h2></div></div><p className="section-copy">Apply sort order and numeric precision to generated exports.</p><label className="format-control"><span>Sort points by</span><select aria-label="Export sort order" value={sortBy} onChange={(event) => setSortBy(event.target.value as 'x' | 'y')}><option value="x">X ascending</option><option value="y">Y ascending</option></select></label><label className="format-control precision-control"><span>Significant digits <strong>{precision}</strong></span><input aria-label="Export precision" type="range" min="2" max="12" step="1" value={precision} onChange={(event) => setPrecision(Number(event.target.value))} /></label></section>
            <section className="settings-disclaimer"><CircleHelp size={16} /><p>Projects are stored in files you download; images and extracted datasets are not uploaded to a server.</p></section>
          </div>}
        </aside>
      </div>

      <footer className="statusbar"><span className="statusbar-left"><span className="online-dot" /> READY <span className="statusbar-divider">/</span>{imageUrl ? imageName : 'Waiting for image'}</span><span className="statusbar-right"><span>{plotOptions.find((option) => option.id === plotType)?.label}</span><span>·</span><span>{calibrated ? 'Calibrated' : 'Uncalibrated'}</span><span>·</span><span>{totalPoints} points</span><span className="version-tag">v0.2</span></span></footer>

      <input ref={imageInput} type="file" accept="image/*" className="visually-hidden" aria-label="Choose plot image" onChange={(event) => { openImage(event.target.files?.[0]); event.target.value = '' }} />
      <input ref={projectInput} type="file" accept="application/json,.json" className="visually-hidden" aria-label="Open plot project" onChange={(event) => { void importProject(event.target.files?.[0]); event.target.value = '' }} />
      {notice && <div role="status" className={`toast ${notice.type ?? ''}`}><span className="toast-icon">{notice.type === 'error' ? '!' : <Check size={14} />}</span>{notice.message}<button aria-label="Dismiss message" onClick={() => setNotice(null)}>×</button></div>}
      {loading && <div className="loading-overlay" aria-live="polite"><span className="loading-spinner" /> Following the curve…</div>}
    </main>
  )
}

function AxisEditor({ axis, calibration, value, setValue, mode, setMode, addPoint, setScale }: {
  axis: 'x' | 'y'; calibration: AxisCalibration; value: string; setValue: (value: string) => void; mode: ToolMode;
  setMode: (mode: ToolMode) => void; addPoint: (axis: 'x' | 'y') => void; setScale: (axis: 'x' | 'y', scale: ScaleType) => void
}) {
  return <div className={`axis-editor ${mode === `calibrate-${axis}` ? 'axis-editor-active' : ''}`}>
    <div className="axis-editor-top"><span className={`axis-letter axis-${axis}`}>{axis.toUpperCase()}</span><span className="axis-label">{axis === 'x' ? 'Horizontal axis' : 'Vertical axis'}</span><select aria-label={`${axis.toUpperCase()} axis scale`} value={calibration.scale} onChange={(event) => setScale(axis, event.target.value as ScaleType)}><option value="linear">Linear</option><option value="log">Log₁₀</option><option value="inverse">Inverse</option><option value="date">Date/time</option></select></div>
    <div className="axis-point-entry"><span className="axis-point-index">P{calibration.points.length + 1}</span><input aria-label={`${axis.toUpperCase()} tick value`} value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229) addPoint(axis) }} placeholder={calibration.scale === 'date' ? 'e.g. 2026-04-14T09:30' : 'Tick value'} /><button className={mode === `calibrate-${axis}` ? 'waiting' : ''} onClick={() => setMode(`calibrate-${axis}`)}>{mode === `calibrate-${axis}` ? 'Click chart' : 'Set point'}</button></div>
    {calibration.points.length > 0 && <div className="axis-point-list">{calibration.points.map((point, index) => <span key={`${point.x}:${point.y}`}>P{index + 1} <strong>{point.value}</strong> <small>{Math.round(point.x)}, {Math.round(point.y)} px</small></span>)}</div>}
  </div>
}
