import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, ArrowDownToLine, Axis3D, Check, CircleHelp, Crosshair, Crop, FileImage, FileJson2,
  Eye, FileSpreadsheet, FlipHorizontal, FlipVertical, FolderOpen, Gauge, GripVertical, ImagePlus, Layers, LineChart,
  MousePointer2, MoveUpRight, Pencil, RotateCcw, RotateCw, Ruler, ScanSearch, Settings2, Sparkles,
  Target, Trash2, Upload,
} from 'lucide-react'
import PlotCanvas from './components/PlotCanvas'
import ImagePreparationPanel from './components/ImagePreparationPanel'
import type { RotationPreview } from './components/DeskewPanel'
import { detectPlotAxes, detectPlotGrid } from './lib/image-processing'
import type { DetectedAxes, DetectedPlotGrid, GridGuides } from './lib/image-processing'
import { ERASER_MAX_WIDTH, ERASER_MIN_WIDTH, ERASER_WIDTH, reconstructImage, reconstructionDimensions, renderReconstruction, renderReconstructionCurveLayer } from './lib/reconstruct'
import type { UpscaleSetting } from './lib/reconstruct'
import type { AxisGuides, Correction, CorrectionLayer, PlotRegion, Reconstruction, ReconstructionColors, ReconstructionWidths } from './lib/reconstruct'
import { calibrateFromIntersections, downloadFile, pointToData, traceColor } from './lib/digitizer'
import { createBrushMask, extractBrushCurves } from './lib/painted-region'
import { proposeBrushedHealing, snapToCurve } from './lib/curve-healing'
import { mergeDatasets } from './lib/dataset-merge'
import { reorderDatasets } from './lib/dataset-order'
import { drawDatasets } from './lib/dataset-render'
import { rotationGeometry, rulerCorrection } from './lib/deskew'
import { createWorkbook } from './lib/excel-export'
import type { BrushMark } from './lib/painted-region'
import type { AxisCalibration, CalPoint, Dataset, DatasetKind, PixelPoint, PlotType, ScaleType, ToolMode } from './lib/digitizer'

type Notice = { message: string; type?: 'error' | 'success' }
type WorkflowStep = 'image' | 'calibration' | 'digitize'
type CompressorAxisVariable = 'flow' | 'head' | 'outletPressure' | 'pressureRatio' | 'efficiency' | 'speed' | 'igv' | 'custom'
type CompressorAxisConfig = { variable: CompressorAxisVariable; label: string; unit: string }
type CompressorAxes = { x: CompressorAxisConfig; y: CompressorAxisConfig }
const palette = ['#006d64', '#a34500', '#5845b0', '#b42735', '#005f99', '#795600', '#a02179']
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
  y: { variable: 'head', label: 'Head', unit: '' },
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
const formatCalibrationValue = (value: number, scale: ScaleType) => scale === 'date'
  ? new Date(value).toISOString().replace('T', ' ').replace('.000Z', 'Z')
  : String(value)
const formatAxisValue = (value: number, scale: ScaleType, precision: number) => scale === 'date'
  ? new Date(value).toISOString().replace('T', ' ').replace('.000Z', 'Z')
  : value.toPrecision(precision)

const modeLabels: Record<ToolMode, string> = {
  select: 'Select', 'calibrate-x': 'Set X calibration', 'calibrate-y': 'Set Y calibration',
  'calibrate-four': 'Four-point calibration', 'calibrate-intersections': 'Two-intersection calibration', 'calibrate-edit': 'Modify calibration',
  point: 'Add data points', 'point-edit': 'Modify curve points',
  surge: 'Trace surge boundary', choke: 'Trace choke boundary', speed: 'Trace speed line', measure: 'Measure distance',
  'trace-region': 'Paint curve region',
  'grid-horizontal': 'Guide horizontal grid', 'grid-vertical': 'Guide vertical grid', 'guide-axis-x': 'Set X axis', 'guide-axis-y': 'Set Y axis', crop: 'Crop image',
  'prep-region': 'Select plot area', 'prep-draw': 'Draw', 'prep-line': 'Draw straight line', 'prep-erase': 'Erase', 'prep-heal': 'Heal curve gap', 'prep-straighten': 'Straighten ruler',
}

export default function App() {
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [sourceImageUrl, setSourceImageUrl] = useState<string | null>(null)
  const [processedImageUrl, setProcessedImageUrl] = useState<string | null>(null)
  const [processedPreviewUrl, setProcessedPreviewUrl] = useState<string | null>(null)
  const [upscale, setUpscale] = useState<UpscaleSetting>({ preset: 'hd', longEdge: 1920 })
  const [customLongEdge, setCustomLongEdge] = useState('1920')
  const [showOriginalPreview, setShowOriginalPreview] = useState(false)
  const [rotationPreview, setRotationPreview] = useState<RotationPreview | null>(null)
  const [showBackground, setShowBackground] = useState(true)
  const [imagePrepared, setImagePrepared] = useState(false)
  const [preprocessing, setPreprocessing] = useState(false)
  const [axisDetection, setAxisDetection] = useState<DetectedAxes | null>(null)
  const [gridDetection, setGridDetection] = useState<DetectedPlotGrid | null>(null)
  const [gridDetecting, setGridDetecting] = useState(false)
  const [gridGuides, setGridGuides] = useState<GridGuides>({ horizontal: [], vertical: [] })
  const [axisGuides, setAxisGuides] = useState<AxisGuides>({ horizontal: null, vertical: null })
  const [regularGrid, setRegularGrid] = useState(true)
  const [plotRegion, setPlotRegion] = useState<PlotRegion | null>(null)
  const [reconstruction, setReconstruction] = useState<Reconstruction | null>(null)
  const [corrections, setCorrections] = useState<Correction[]>([])
  const [correctionLayer, setCorrectionLayer] = useState<CorrectionLayer>('curve')
  const [eraserWidth, setEraserWidth] = useState(ERASER_WIDTH)
  const [drawWidth, setDrawWidth] = useState(1)
  const [snapDrawing, setSnapDrawing] = useState(false)
  const [healBrushWidth, setHealBrushWidth] = useState(24)
  const [healMark, setHealMark] = useState<BrushMark | null>(null)
  const [healOptions, setHealOptions] = useState<PixelPoint[][]>([])
  const [healChoice, setHealChoice] = useState(0)
  const healPreview = healOptions[healChoice] ?? null
  const [reconstructionColors, setReconstructionColors] = useState<ReconstructionColors>({ curve: '#0066ff', grid: '#000000', axis: '#000000' })
  const [reconstructionWidths, setReconstructionWidths] = useState<ReconstructionWidths>({ curve: 1, grid: 1 })
  const [needsProcess, setNeedsProcess] = useState(true)
  const [dragActive, setDragActive] = useState(false)
  const [imageName, setImageName] = useState('Untitled plot')
  const [plotType, setPlotType] = useState<PlotType>('xy')
  const [datasets, setDatasets] = useState<Dataset[]>([defaultDataset(1)])
  const [activeId, setActiveId] = useState(datasets[0].id)
  const [selectedDatasetIds, setSelectedDatasetIds] = useState<string[]>([datasets[0].id])
  const [editingDatasetName, setEditingDatasetName] = useState<{ id: string; value: string } | null>(null)
  const [datasetDropTarget, setDatasetDropTarget] = useState<{ id: string; after: boolean } | null>(null)
  const [pointSelectionVersion, setPointSelectionVersion] = useState(0)
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
  const [sampleStep, setSampleStep] = useState(20)
  const [traceBrushWidth, setTraceBrushWidth] = useState(24)
  const [pointMarkerSize, setPointMarkerSize] = useState(100)
  const [brushMarks, setBrushMarks] = useState<BrushMark[]>([])
  const [brushErasing, setBrushErasing] = useState(false)
  const [pendingTrace, setPendingTrace] = useState<{ ids: string[]; previousActiveId: string; warnings: string[] } | null>(null)
  const [workflowStep, setWorkflowStep] = useState<WorkflowStep>('image')
  const [calibrationMarkerColor, setCalibrationMarkerColor] = useState('#36d399')
  const [calibrationConfirmed, setCalibrationConfirmed] = useState(false)
  const [sortBy, setSortBy] = useState<'x' | 'y'>('x')
  const [precision, setPrecision] = useState(6)
  const [seedColor, setSeedColor] = useState<[number, number, number]>([72, 215, 191])
  const [activePanel, setActivePanel] = useState<'data' | 'settings'>('data')
  const [showTable, setShowTable] = useState(false)
  const [loading, setLoading] = useState(false)
  const imageInput = useRef<HTMLInputElement>(null)
  const projectInput = useRef<HTMLInputElement>(null)
  const openImageRef = useRef<(file?: File) => void>(() => undefined)
  const processingRun = useRef(0)
  const draggedDatasetId = useRef<string | null>(null)
  const activateDataset = (id: string) => { setActiveId(id); setSelectedDatasetIds(id ? [id] : []); setEditingDatasetName(null) }

  useEffect(() => { setBrushMarks([]) }, [imageUrl, sourceImageUrl])
  useEffect(() => { setRotationPreview(null) }, [sourceImageUrl])
  useEffect(() => { setHealMark(null); setHealOptions([]); setHealChoice(0) }, [mode, reconstruction, corrections, correctionLayer])

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (pendingTrace) return
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key === 'Escape') setMode('select')
      if (workflowStep === 'digitize' && event.key.toLowerCase() === 'p') setMode('point')
      if (workflowStep === 'digitize' && event.key.toLowerCase() === 'a') setMode('trace-region')
      if (workflowStep === 'digitize' && event.key.toLowerCase() === 'm') setMode('point-edit')
      if (workflowStep === 'calibration' && event.key.toLowerCase() === 'c') setMode('calibrate-edit')
    }
    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [workflowStep, pendingTrace])

  const activeDataset = datasets.find((dataset) => dataset.id === activeId) ?? datasets[0]
  const showGuides = needsProcess || mode === 'grid-horizontal' || mode === 'grid-vertical' || mode === 'guide-axis-x' || mode === 'guide-axis-y' || mode === 'prep-region'
  const totalPoints = datasets.reduce((sum, dataset) => sum + dataset.points.length, 0)
  const calibrated = xAxis.points.length >= 2 && yAxis.points.length >= 2
  const calibratedPoints = useMemo(() => activeDataset?.points.map((point) => pointToData(point, xAxis, yAxis)).filter((point) => point !== null) ?? [], [activeDataset, xAxis, yAxis])
  const previewDatasets = useMemo(() => {
    if (!rotationPreview) return datasets
    const geometry = rotationGeometry(rotationPreview.width, rotationPreview.height, rotationPreview.degrees)
    return datasets.map((dataset) => ({ ...dataset, points: dataset.points.map(geometry.transformPoint) }))
  }, [datasets, rotationPreview])

  const showNotice = (message: string, type: Notice['type'] = 'success') => {
    setNotice({ message, type })
    window.setTimeout(() => setNotice(null), 3400)
  }

  const openImage = (file?: File) => {
    if (!file) return
    if (pendingTrace) { showNotice('Confirm or discard the new points before replacing the image.', 'error'); return }
    if (!file.type.startsWith('image/')) { showNotice('Choose a supported image file.', 'error'); return }
    if (file.size > 35 * 1024 * 1024) { showNotice('Images must be smaller than 35 MB.', 'error'); return }
    processingRun.current++; setPreprocessing(false)
    const nextUrl = URL.createObjectURL(file)
    setImageUrl((previous) => { if (previous?.startsWith('blob:')) URL.revokeObjectURL(previous); return nextUrl })
    setSourceImageUrl((previous) => { if (previous?.startsWith('blob:')) URL.revokeObjectURL(previous); return nextUrl })
    setProcessedImageUrl(null); setProcessedPreviewUrl(null); setShowOriginalPreview(false); setShowBackground(true); setImagePrepared(false); setAxisDetection(null); setGridDetection(null); setGridGuides({ horizontal: [], vertical: [] })
    setPlotRegion(null); setAxisGuides({ horizontal: null, vertical: null }); setRegularGrid(true); setReconstruction(null); setCorrections([]); setNeedsProcess(true)
    setImageName(file.name.replace(/\.[^.]+$/, '') || 'Untitled plot')
    const initialDataset = defaultDataset(1)
    setXAxis(blankAxis()); setYAxis(blankAxis()); setDatasets([initialDataset]); activateDataset(initialDataset.id)
    setCompressorAxes(defaultCompressorAxes)
    setFourPointPixels([])
    setWorkflowStep('image'); setCalibrationConfirmed(false); setBrushErasing(false)
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

  const processImage = async () => {
    if (!sourceImageUrl || preprocessing) return
    const run = ++processingRun.current
    setPreprocessing(true)
    try {
      const result = await reconstructImage(sourceImageUrl, plotRegion, gridGuides, corrections, reconstructionColors, reconstructionWidths, { regularGrid, axisGuides })
      if (run !== processingRun.current) return
      const preview = renderUpscaled(result.geometry, corrections, reconstructionColors, reconstructionWidths, upscale, result.dataUrl)
      setImageUrl(result.dataUrl); setProcessedImageUrl(result.dataUrl); setShowOriginalPreview(false)
      setProcessedPreviewUrl(preview)
      setReconstruction(result.geometry); setNeedsProcess(false); setShowBackground(true)
      setAxisDetection(null); setGridDetection(null); setCalibrationConfirmed(false); setImagePrepared(false); setMode('select')
      showNotice(`Rebuilt ${result.geometry.horizontal.length} horizontal and ${result.geometry.vertical.length} vertical lines and ${result.geometry.curves.length} curve fragments. Inspect the result against the original.`)
    } catch (error) { if (run === processingRun.current) showNotice(error instanceof Error ? error.message : 'The image could not be processed in this browser.', 'error') }
    finally { if (run === processingRun.current) setPreprocessing(false) }
  }

  const renderUpscaled = (geometry: Reconstruction, edits: Correction[], colors: ReconstructionColors, widths: ReconstructionWidths, setting: UpscaleSetting, original: string) => {
    const size = reconstructionDimensions(geometry.width, geometry.height, setting)
    return size.width === geometry.width && size.height === geometry.height ? original : renderReconstruction(geometry, edits, colors, widths, size)
  }

  const updateUpscale = (setting: UpscaleSetting) => {
    try {
      if (reconstruction && processedImageUrl && !needsProcess) {
        setProcessedPreviewUrl(renderUpscaled(reconstruction, corrections, reconstructionColors, reconstructionWidths, setting, processedImageUrl))
      } else if (processedImageUrl) {
        showNotice('Process the image again to apply the selected upscale.', 'error')
      }
      setUpscale(setting)
    } catch (error) {
      showNotice(error instanceof Error ? error.message : 'Could not upscale the reconstruction.', 'error')
    }
  }

  const updateCorrections = (next: Correction[]) => {
    if (!reconstruction || preprocessing || needsProcess) { showNotice('Process the image before editing the reconstruction.', 'error'); return false }
    try {
      const result = renderReconstruction(reconstruction, next, reconstructionColors, reconstructionWidths)
      const preview = renderUpscaled(reconstruction, next, reconstructionColors, reconstructionWidths, upscale, result)
      setCorrections(next); setImageUrl(result); setProcessedImageUrl(result)
      setProcessedPreviewUrl(preview)
      return true
    } catch (error) {
      showNotice(error instanceof Error ? error.message : 'Could not update the reconstruction.', 'error')
      return false
    }
  }

  const applyHealing = () => {
    if (healPreview && updateCorrections([...corrections, { points: healPreview, erase: false, layer: 'curve', width: drawWidth }])) {
      setHealMark(null); setHealOptions([]); setShowOriginalPreview(false)
      showNotice('Connection applied. Inspect it against the original; use Undo edit if needed.')
    }
  }

  const curveLayerPixels = () => {
    if (!reconstruction || needsProcess || preprocessing) throw new Error('Process the image before editing the curve.')
    const canvas = renderReconstructionCurveLayer(reconstruction, corrections, reconstructionWidths)
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('This browser cannot read the curve layer.')
    return context.getImageData(0, 0, canvas.width, canvas.height)
  }

  const updateReconstructionAppearance = (colors: ReconstructionColors, widths: ReconstructionWidths) => {
    if (reconstruction && !needsProcess) {
      try {
        const result = renderReconstruction(reconstruction, corrections, colors, widths)
        const preview = renderUpscaled(reconstruction, corrections, colors, widths, upscale, result)
        setImageUrl(result); setProcessedImageUrl(result)
        setProcessedPreviewUrl(preview)
      } catch (error) {
        showNotice(error instanceof Error ? error.message : 'Could not update reconstruction appearance.', 'error')
        return
      }
    }
    setReconstructionColors(colors); setReconstructionWidths(widths)
  }

  const confirmPreparedImage = () => {
    if (showOriginalPreview && processedImageUrl) setShowOriginalPreview(false)
    setImagePrepared(true)
    setWorkflowStep('calibration')
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

  const calibrateFromDetectedGrid = async () => {
    if (!imageUrl) return
    setGridDetecting(true)
    try {
      const detected = await detectPlotGrid(imageUrl)
      if (!detected) {
        setGridDetection(null)
        showNotice('Could not find at least two clear horizontal and vertical grid lines. Try cleaning or cropping the image.', 'error')
        return
      }

      const values = (['x1', 'x2', 'y1', 'y2'] as const).map((key, index) => {
        const scale = index < 2 ? xAxis.scale : yAxis.scale
        return scale === 'date' ? Date.parse(fourPointValues[key]) : Number(fourPointValues[key])
      })
      const isValid = (value: number, scale: ScaleType) =>
        Number.isFinite(value) && (scale !== 'log' || value > 0) && (scale !== 'inverse' || value !== 0)
      if (!values.every((value, index) => isValid(value, index < 2 ? xAxis.scale : yAxis.scale))
        || values[0] === values[1] || values[2] === values[3]) {
        showNotice('Enter distinct, valid X1, X2, Y1 and Y2 tick values before automatic calibration.', 'error')
        return
      }

      const left = detected.verticalLines[0]
      const right = detected.verticalLines[detected.verticalLines.length - 1]
      const top = detected.horizontalLines[0]
      const bottom = detected.horizontalLines[detected.horizontalLines.length - 1]
      setXAxis({
        ...xAxis,
        points: [
          { x: left, y: bottom, value: values[0] },
          { x: right, y: bottom, value: values[1] },
        ],
      })
      setYAxis({
        ...yAxis,
        points: [
          { x: left, y: top, value: values[2] },
          { x: left, y: bottom, value: values[3] },
        ],
      })
      setCalibrationConfirmed(false)
      setGridDetection(detected)
      setMode('calibrate-edit')
      showNotice(`Detected ${detected.verticalLines.length} vertical and ${detected.horizontalLines.length} horizontal grid lines. Check the highlighted calibration points and adjust them if needed.`)
    } catch {
      showNotice('Grid detection failed while reading this image.', 'error')
    } finally {
      setGridDetecting(false)
    }
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
  const updateCalibrationPoint = (axis: 'x' | 'y', index: number, point: PixelPoint) => {
    const update = axis === 'x' ? setXAxis : setYAxis
    update((current) => ({ ...current, points: current.points.map((calPoint, pointIndex) => pointIndex === index ? { ...calPoint, ...point } : calPoint) }))
    setCalibrationConfirmed(false)
  }
  const updateCalibrationValue = (axis: 'x' | 'y', index: number, rawValue: string) => {
    const calibration = axis === 'x' ? xAxis : yAxis
    const value = calibration.scale === 'date' ? Date.parse(rawValue) : Number(rawValue)
    if (!Number.isFinite(value) || (calibration.scale === 'log' && value <= 0) || (calibration.scale === 'inverse' && value === 0)) return
    const update = axis === 'x' ? setXAxis : setYAxis
    update((current) => ({ ...current, points: current.points.map((point, pointIndex) => pointIndex === index ? { ...point, value } : point) }))
    setCalibrationConfirmed(false)
  }
  const updateCompressorAxis = (axis: 'x' | 'y', patch: Partial<CompressorAxisConfig>) => setCompressorAxes((current) => ({
    ...current,
    [axis]: { ...current[axis], ...patch },
  }))

  const addDataset = (kind?: DatasetKind) => {
    const selectedKind = kind ?? (plotType === 'compressor' ? 'speed' : 'curve')
    const next = defaultDataset(datasets.length + 1, selectedKind)
    setDatasets((current) => [...current, next])
    activateDataset(next.id)
    setMode(selectedKind === 'surge' ? 'surge' : selectedKind === 'choke' ? 'choke' : selectedKind === 'speed' ? 'speed' : selectedKind === 'efficiency' ? 'trace-region' : 'point')
  }

  const selectDataset = (dataset: Dataset, additive: boolean) => {
    setEditingDatasetName(null)
    if (additive && !pendingTrace) {
      const selected = selectedDatasetIds.includes(dataset.id)
      if (selected && selectedDatasetIds.length === 1) return
      const next = selected ? selectedDatasetIds.filter((id) => id !== dataset.id) : [...selectedDatasetIds, dataset.id]
      setSelectedDatasetIds(next)
      if (!selected || activeId === dataset.id) setActiveId(selected ? next[next.length - 1] : dataset.id)
      return
    }
    activateDataset(dataset.id)
    if (!pendingTrace && mode !== 'point-edit') setMode(dataset.kind === 'surge' ? 'surge' : dataset.kind === 'choke' ? 'choke' : dataset.kind === 'speed' ? 'speed' : dataset.kind === 'efficiency' && plotType === 'compressor' ? 'trace-region' : 'point')
  }

  const mergeSelectedDatasets = () => {
    if (pendingTrace) return
    try {
      const selected = datasets.filter((dataset) => selectedDatasetIds.includes(dataset.id))
      const merged = mergeDatasets(selected, activeId)
      if (!window.confirm(`Merge ${selected.length} datasets into "${merged.name}"? The selected datasets will be replaced. Check the resulting connections afterwards.`)) return
      setDatasets((current) => current.flatMap((dataset) => dataset.id === merged.id ? [merged] : selectedDatasetIds.includes(dataset.id) ? [] : [dataset]))
      activateDataset(merged.id)
      setPointSelectionVersion((version) => version + 1)
      setMode('point-edit')
      showNotice(`Merged ${selected.length} datasets into ${merged.name}. Check the joined points.`)
    } catch (error) {
      showNotice(error instanceof Error ? error.message : 'Could not merge the selected datasets.', 'error')
    }
  }

  const deleteSelectedDatasets = () => {
    if (pendingTrace || selectedDatasetIds.length < 2) return
    const remaining = datasets.filter((dataset) => !selectedDatasetIds.includes(dataset.id))
    const message = remaining.length
      ? `Delete ${selectedDatasetIds.length} selected datasets and all their points?`
      : `Delete all ${selectedDatasetIds.length} selected datasets and their points? A new empty dataset will be created.`
    if (!window.confirm(message)) return
    const next = remaining.length ? remaining : [defaultDataset(1, plotType === 'compressor' ? 'speed' : 'curve')]
    setDatasets(next)
    activateDataset(next[0].id)
    setPointSelectionVersion((version) => version + 1)
    showNotice(`Deleted ${selectedDatasetIds.length} datasets.`)
  }

  const moveDataset = (id: string, direction: -1 | 1) => {
    const index = datasets.findIndex((dataset) => dataset.id === id)
    const target = datasets[index + direction]
    if (target) setDatasets((current) => reorderDatasets(current, id, target.id, direction > 0))
  }

  const saveDatasetName = () => {
    if (!editingDatasetName) return
    updateDataset(editingDatasetName.id, (dataset) => ({ ...dataset, name: editingDatasetName.value }))
    setEditingDatasetName(null)
  }

  const traceCurve = async (seed: PixelPoint, guide?: PixelPoint[], reviewCandidate = false) => {
    const traceImageUrl = showOriginalPreview ? sourceImageUrl : imageUrl
    if (!traceImageUrl || !imagePrepared) return
    const traceMode = mode
    setLoading(true)
    try {
      const image = new Image()
      image.src = traceImageUrl
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) throw new Error('This browser cannot analyze the plot image.')
      context.drawImage(image, 0, 0)
      let traced = traceColor(
        context.getImageData(0, 0, canvas.width, canvas.height),
        seed,
        tolerance,
        sampleStep,
        guide,
        traceBrushWidth / 2,
        calibrated && !reviewCandidate ? {
          left: Math.min(...xAxis.points.map((point) => point.x)),
          right: Math.max(...xAxis.points.map((point) => point.x)),
          top: Math.min(...yAxis.points.map((point) => point.y)),
          bottom: Math.max(...yAxis.points.map((point) => point.y)),
        } : undefined,
      )
      const tracingSpeedLine = traceMode === 'speed' || (traceMode === 'trace-region' && activeDataset?.kind === 'speed')
      if (tracingSpeedLine) {
        const boundaries = datasets.filter((dataset) => (dataset.kind === 'surge' || dataset.kind === 'choke') && dataset.points.length > 1)
        const meetsBoundary = (candidate: PixelPoint) => boundaries.some((line) => line.points.slice(1).some((end, index) => distanceToSegment(candidate, line.points[index], end) < 10))
        const seedIndex = traced.reduce((best, candidate, index) => Math.hypot(candidate.x - seed.x, candidate.y - seed.y) < Math.hypot(traced[best].x - seed.x, traced[best].y - seed.y) ? index : best, 0)
        const left = traced.slice(0, seedIndex + 1).reverse()
        const right = traced.slice(seedIndex + 1)
        const trimAtBoundary = (points: PixelPoint[]) => {
          const boundaryIndex = points.findIndex((candidate, index) => index > 0 && meetsBoundary(candidate))
          return boundaryIndex < 0 ? points : points.slice(0, boundaryIndex)
        }
        traced = [...trimAtBoundary(left).reverse(), ...trimAtBoundary(right)]
      }
      if (traced.length < 2) {
        showNotice('Could not follow that curve. Try painting closer to the line or adjusting color tolerance and point spacing.', 'error')
        return
      }
      const targetKind: DatasetKind = tracingSpeedLine
        ? 'speed'
        : plotType === 'compressor' && (activeDataset?.kind === 'speed' || activeDataset?.kind === 'efficiency')
          ? activeDataset.kind
          : 'curve'
      if (reviewCandidate && activeDataset) {
        const next = { ...activeDataset, id: crypto.randomUUID(), name: `${activeDataset.name} (retrace candidate)`, color: palette.find((color) => color !== activeDataset.color) ?? palette[0], points: traced }
        setDatasets((current) => [...current, next])
        activateDataset(next.id)
      } else if (plotType === 'compressor' && activeDataset?.kind === targetKind && (targetKind === 'speed' || targetKind === 'efficiency')) {
        updateDataset(activeDataset.id, (dataset) => ({ ...dataset, points: traced }))
      } else {
        const next = defaultDataset(datasets.length + 1, targetKind)
        next.name = targetKind === 'speed'
          ? `Speed line ${datasets.filter((dataset) => dataset.kind === 'speed').length + 1}`
          : targetKind === 'efficiency'
            ? `Efficiency contour ${datasets.filter((dataset) => dataset.kind === 'efficiency').length + 1}`
            : `Trace ${datasets.filter((dataset) => dataset.kind === 'curve').length + 1}`
        next.points = traced
        setDatasets((current) => [...current, next])
        activateDataset(next.id)
      }
      setMode('point-edit')
      showNotice(reviewCandidate
        ? `Created a ${traced.length}-point candidate. Compare it with the original before deleting either dataset.`
        : `Found ${traced.length} curve points. Select a point to fine-tune its position.`)
    } catch (error) {
      showNotice(error instanceof Error ? error.message : 'Image could not be analyzed in this browser.', 'error')
    } finally {
      setLoading(false)
    }
  }

  const tracePaintedRegion = (guide: PixelPoint[]) => {
    if (!guide.length || (guide.length < 2 && mode !== 'prep-erase' && mode !== 'trace-region' && mode !== 'prep-heal')) return
    if (mode === 'prep-heal') {
      try {
        if (!reconstruction || needsProcess || preprocessing) throw new Error('Process the image before healing a curve.')
        const margin = 110 + healBrushWidth / 2
        const bounds = guide.reduce((area, p) => ({ left: Math.min(area.left, p.x), top: Math.min(area.top, p.y), right: Math.max(area.right, p.x), bottom: Math.max(area.bottom, p.y) }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity })
        const left = Math.max(0, Math.floor(bounds.left - margin))
        const top = Math.max(0, Math.floor(bounds.top - margin))
        const right = Math.min(reconstruction.width, Math.ceil(bounds.right + margin))
        const bottom = Math.min(reconstruction.height, Math.ceil(bounds.bottom + margin))
        const width = right - left, height = bottom - top
        if (width * height > 1_000_000) throw new Error('Brush a smaller area around one gap.')
        const canvas = renderReconstructionCurveLayer(reconstruction, corrections, reconstructionWidths)
        const context = canvas.getContext('2d', { willReadFrequently: true })
        if (!context) throw new Error('This browser cannot read the curve layer.')
        const mark: BrushMark = { points: guide.map((p) => ({ x: p.x - left, y: p.y - top })), width: healBrushWidth, erase: false }
        const selection = createBrushMask(width, height, [mark]).getContext('2d', { willReadFrequently: true })
        const nearby = createBrushMask(width, height, [{ ...mark, width: mark.width + 200 }]).getContext('2d', { willReadFrequently: true })
        if (!selection || !nearby) throw new Error('This browser cannot read the healing brush.')
        const options = proposeBrushedHealing(context.getImageData(left, top, width, height), selection.getImageData(0, 0, width, height).data, nearby.getImageData(0, 0, width, height).data)
        setHealMark({ points: guide, width: healBrushWidth, erase: false })
        setHealOptions(options.map((path) => path.map((p) => ({ x: p.x + left, y: p.y + top }))))
        setHealChoice(0)
      } catch (error) {
        setHealMark(null); setHealOptions([])
        showNotice(error instanceof Error ? error.message : 'Could not propose a connection.', 'error')
      }
      return
    }
    if (mode === 'prep-draw' || mode === 'prep-line' || mode === 'prep-erase') {
      const bounds = reconstruction?.region
      if (bounds && !guide.some((point) => point.x >= bounds.x && point.x <= bounds.x + bounds.width && point.y >= bounds.y && point.y <= bounds.y + bounds.height)) {
        showNotice('Draw inside the detected plot area. Select a different area and process again if needed.', 'error')
        return
      }
      let points = mode === 'prep-line' ? [guide[0], guide[guide.length - 1]] : [...guide]
      if (mode !== 'prep-erase' && correctionLayer === 'curve' && snapDrawing) {
        try {
          const pixels = curveLayerPixels()
          points[0] = snapToCurve(pixels, points[0]) ?? points[0]
          points[points.length - 1] = snapToCurve(pixels, points[points.length - 1]) ?? points[points.length - 1]
        } catch (error) { showNotice(error instanceof Error ? error.message : 'Could not snap the stroke.', 'error'); return }
      }
      updateCorrections([...corrections, { points, erase: mode === 'prep-erase', layer: correctionLayer, width: mode === 'prep-erase' ? eraserWidth : drawWidth }])
      return
    }
    if (mode === 'trace-region') setBrushMarks((current) => [...current, { points: guide, width: traceBrushWidth, erase: brushErasing }])
  }

  const autoPaintedPoints = async () => {
    const traceImageUrl = showOriginalPreview ? sourceImageUrl : imageUrl
    if (!traceImageUrl || !imagePrepared || !brushMarks.length || loading) return
    setLoading(true)
    try {
      const image = new Image()
      image.src = traceImageUrl
      await image.decode()
      if (image.naturalWidth * image.naturalHeight > 4_000_000) throw new Error('Use an image below 4 megapixels for automatic point extraction.')
      const isolatedCurveLayer = !showOriginalPreview && processedImageUrl && reconstruction && !needsProcess
        ? renderReconstructionCurveLayer(reconstruction, corrections, reconstructionWidths)
        : null
      const canvas = isolatedCurveLayer ?? document.createElement('canvas')
      if (!isolatedCurveLayer) { canvas.width = image.naturalWidth; canvas.height = image.naturalHeight }
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) throw new Error('This browser cannot analyze the plot image.')
      if (!isolatedCurveLayer) context.drawImage(image, 0, 0)
      const mask = createBrushMask(canvas.width, canvas.height, brushMarks)
      const maskContext = mask.getContext('2d', { willReadFrequently: true })
      if (!maskContext) throw new Error('This browser cannot read the brush selection.')
      const color: [number, number, number] | undefined = isolatedCurveLayer
        ? [0, 102, 255]
        : !showOriginalPreview && processedImageUrl
        ? [1, 3, 5].map((index) => parseInt(reconstructionColors.curve.slice(index, index + 2), 16)) as [number, number, number]
        : undefined
      const extraction = extractBrushCurves(context.getImageData(0, 0, canvas.width, canvas.height), maskContext.getImageData(0, 0, canvas.width, canvas.height).data, sampleStep, tolerance, color, Boolean(isolatedCurveLayer))
      let curves = extraction.curves
      const kind: DatasetKind = plotType === 'compressor' && (activeDataset?.kind === 'speed' || activeDataset?.kind === 'efficiency') ? activeDataset.kind : 'curve'
      let excluded = 0
      if (kind === 'speed') {
        const boundaries = datasets.filter((dataset) => (dataset.kind === 'surge' || dataset.kind === 'choke') && dataset.points.length > 1)
        const meetsBoundary = (candidate: PixelPoint) => boundaries.some((line) => line.points.slice(1).some((end, index) => distanceToSegment(candidate, line.points[index], end) < 10))
        curves = curves.map((curve) => {
          const segments: PixelPoint[][] = [[]]
          for (const point of curve) {
            if (meetsBoundary(point)) {
              if (segments[segments.length - 1].length) segments.push([])
            } else segments[segments.length - 1].push(point)
          }
          return segments.sort((a, b) => b.length - a.length)[0]
        }).filter((curve) => {
          if (curve.length >= 2) return true
          excluded++
          return false
        })
      }
      if (!curves.length) {
        showNotice(excluded ? 'No speed curves remain after applying the surge and choke boundaries.' : 'No curves found in the painted region. Check the selection, color, and tolerance.', 'error')
        return
      }
      const next = curves.map((points, index) => {
        const dataset = defaultDataset(datasets.length + index + 1, kind)
        dataset.name = kind === 'speed' ? `Speed line ${datasets.filter((item) => item.kind === kind).length + index + 1}`
          : kind === 'efficiency' ? `Efficiency contour ${datasets.filter((item) => item.kind === kind).length + index + 1}`
            : `Trace ${datasets.filter((item) => item.kind === kind).length + index + 1}`
        dataset.points = points
        return dataset
      })
      setDatasets((current) => [...current, ...next])
      setPendingTrace({ ids: next.map((dataset) => dataset.id), previousActiveId: activeId, warnings: [...extraction.warnings, ...(!showOriginalPreview && processedImageUrl && !isolatedCurveLayer ? ['Using the composite image; process it again to separate the curve layer from the grid.'] : []), ...(excluded ? [`${excluded} speed curve candidates were removed by the boundaries.`] : [])] })
      activateDataset(next[0].id)
      setMode('select')
      showNotice(`Created ${next.length} curve${next.length === 1 ? '' : 's'}.${excluded ? ` ${excluded} removed by boundaries.` : ''} Review before confirming.`)
    } catch (error) {
      showNotice(error instanceof Error ? error.message : 'Image could not be analyzed in this browser.', 'error')
    } finally {
      setLoading(false)
    }
  }

  const retraceActiveDataset = () => {
    if (!activeDataset || activeDataset.points.length < 2) return
    const guide = [...activeDataset.points].sort((a, b) => a.x - b.x)
    const differences = activeDataset.points.slice(1).map((point, index) => point.x - activeDataset.points[index].x)
    if (guide[guide.length - 1].x - guide[0].x < 4
      || !(differences.every((difference) => difference > 0) || differences.every((difference) => difference < 0))) {
      showNotice('Retracing requires a curve with one point per X position, ordered along X.', 'error')
      return
    }
    void traceCurve(guide[Math.floor(guide.length / 2)], guide, true)
  }

  const handleCanvasClick = async (point: PixelPoint) => {
    if (!imageUrl) return
    if (mode === 'grid-horizontal' || mode === 'grid-vertical' || mode === 'guide-axis-x' || mode === 'guide-axis-y') {
      if (preprocessing) return
      const isAxis = mode === 'guide-axis-x' || mode === 'guide-axis-y'
      const orientation = mode === 'grid-horizontal' || mode === 'guide-axis-x' ? 'horizontal' : 'vertical'
      const position = orientation === 'horizontal' ? point.y : point.x
      if (plotRegion && (point.x < plotRegion.x || point.x > plotRegion.x + plotRegion.width || point.y < plotRegion.y || point.y > plotRegion.y + plotRegion.height)) {
        showNotice('Place guides inside the selected plot area.', 'error')
        return
      }
      if (isAxis) setAxisGuides((current) => ({ ...current, [orientation]: position }))
      else setGridGuides((current) => ({ ...current, [orientation]: [...current[orientation], position] }))
      setNeedsProcess(true); setImagePrepared(false)
      showNotice(`${isAxis ? orientation === 'horizontal' ? 'X axis' : 'Y axis' : orientation === 'horizontal' ? 'Horizontal guide' : 'Vertical guide'} set at ${Math.round(position)} px. Press Process image to apply it.`)
      return
    }
    if (!imagePrepared) return
    if (mode === 'calibrate-intersections') {
      if (!fourPointPixels.length) {
        setFourPointPixels([point])
        showNotice('First intersection captured. Click the second intersection.')
        return
      }
      const parseValue = (key: keyof FourPointValues, scale: ScaleType) =>
        !fourPointValues[key].trim() ? NaN : scale === 'date' ? Date.parse(fourPointValues[key]) : Number(fourPointValues[key])
      const values: [number, number, number, number] = [
        parseValue('x1', xAxis.scale), parseValue('x2', xAxis.scale),
        parseValue('y1', yAxis.scale), parseValue('y2', yAxis.scale),
      ]
      try {
        const calibration = calibrateFromIntersections([fourPointPixels[0], point], values, xAxis.scale, yAxis.scale)
        setXAxis(calibration.xAxis)
        setYAxis(calibration.yAxis)
        setCalibrationConfirmed(false)
        setFourPointPixels([])
        setMode('calibrate-edit')
        showNotice('Calibration created from two intersections. Review and adjust the markers before confirming.')
      } catch (error) {
        showNotice(error instanceof Error ? error.message : 'Invalid calibration.', 'error')
      }
      return
    }
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
        setCalibrationConfirmed(false)
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
      setCalibrationConfirmed(false)
      showNotice(`${mode === 'calibrate-x' ? 'X' : 'Y'} calibration point ${current.points.length + 1} added.`)
      return
    }
    if (mode === 'speed') {
      await traceCurve(point)
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
    if (Math.hypot(activeDataset.points[index].x - point.x, activeDataset.points[index].y - point.y) < 24) {
      updateDataset(activeDataset.id, (dataset) => ({ ...dataset, points: dataset.points.filter((_, pointIndex) => pointIndex !== index) }))
      setPointSelectionVersion((version) => version + 1)
    }
  }

  const deleteDataset = (id: string) => {
    if (pendingTrace && !pendingTrace.ids.includes(id)) return
    setEditingDatasetName(null)
    if (datasets.length === 1) {
      updateDataset(id, (dataset) => ({ ...dataset, points: [] }))
      setPointSelectionVersion((version) => version + 1)
      return
    }
    const remaining = datasets.filter((dataset) => dataset.id !== id)
    setDatasets(remaining)
    if (pendingTrace) {
      const ids = pendingTrace.ids.filter((item) => item !== id)
      if (!ids.length) {
        activateDataset(pendingTrace.previousActiveId)
        setPendingTrace(null)
        setMode('trace-region')
      } else {
        setPendingTrace({ ...pendingTrace, ids })
        if (activeId === id) activateDataset(ids[0])
      }
    } else if (activeId === id) activateDataset(remaining[0].id)
    else setSelectedDatasetIds((current) => current.filter((item) => item !== id))
  }

  const cropImage = async (rect: { x: number; y: number; width: number; height: number }) => {
    if (!imageUrl || preprocessing) return
    if (processedImageUrl && !window.confirm('Cropping clears the reconstruction and its edits. Crop the original image instead?')) { setMode('select'); return }
    const image = new Image(); image.src = sourceImageUrl ?? imageUrl; await image.decode()
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
    setImageUrl(croppedImage); setSourceImageUrl(croppedImage); setProcessedImageUrl(null); setProcessedPreviewUrl(null); setShowOriginalPreview(false); setAxisDetection(null); setGridDetection(null); setGridGuides({ horizontal: [], vertical: [] })
    setPlotRegion(null); setAxisGuides({ horizontal: null, vertical: null }); setReconstruction(null); setCorrections([]); setNeedsProcess(true); setImagePrepared(false); setWorkflowStep('image'); setCalibrationConfirmed(false)
    setMode('select'); showNotice('Image cropped. Calibration points outside the crop were removed; process the cropped image before continuing.')
  }

  const applyImageTransform = async (operation: 'rotate-left' | 'rotate-right' | 'flip-x' | 'flip-y') => {
    if (!imageUrl || preprocessing) return
    if (processedImageUrl && !window.confirm('Transforming clears the reconstruction and its edits. Transform the original image instead?')) return
    const image = new Image(); image.src = sourceImageUrl ?? imageUrl; await image.decode()
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
    setImageUrl(updated); setSourceImageUrl(updated); setProcessedImageUrl(null); setProcessedPreviewUrl(null); setShowOriginalPreview(false); setAxisDetection(null); setGridDetection(null); setGridGuides({ horizontal: [], vertical: [] })
    setPlotRegion(null); setAxisGuides({ horizontal: null, vertical: null }); setReconstruction(null); setCorrections([]); setNeedsProcess(true); setImagePrepared(false); setWorkflowStep('image'); setCalibrationConfirmed(false); setMode('select')
    showNotice('Image transformed. Process it again before continuing.')
  }

  const applyDeskew = async (degrees: number) => {
    if (!sourceImageUrl || preprocessing || !Number.isFinite(degrees) || Math.abs(degrees) > 180) return
    if (Math.abs(degrees) < 1e-10) { setMode('select'); showNotice('The selected line is already straight.'); return }
    if ((processedImageUrl || xAxis.points.length || yAxis.points.length) && !window.confirm('Rotating clears the reconstruction, edits and calibration. Existing dataset points will be rotated; process the image and calibrate again. Continue?')) return
    const run = ++processingRun.current
    setPreprocessing(true)
    try {
      const image = new Image(); image.src = sourceImageUrl; await image.decode()
      if (run !== processingRun.current) return
      const geometry = rotationGeometry(image.naturalWidth, image.naturalHeight, degrees)
      const canvas = document.createElement('canvas'); canvas.width = geometry.width; canvas.height = geometry.height
      const context = canvas.getContext('2d')
      if (!context) throw new Error('This browser cannot rotate the image.')
      context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height)
      context.translate(canvas.width / 2, canvas.height / 2); context.rotate(geometry.radians)
      context.drawImage(image, -image.naturalWidth / 2, -image.naturalHeight / 2)
      const rotated = canvas.toDataURL('image/png')
      setDatasets((current) => current.map((dataset) => ({ ...dataset, points: dataset.points.map(geometry.transformPoint) })))
      setXAxis(blankAxis()); setYAxis(blankAxis()); setFourPointPixels([])
      setImageUrl(rotated); setSourceImageUrl(rotated); setProcessedImageUrl(null); setProcessedPreviewUrl(null); setShowOriginalPreview(false)
      setRotationPreview(null); setShowBackground(true)
      setAxisDetection(null); setGridDetection(null); setGridGuides({ horizontal: [], vertical: [] }); setPlotRegion(null)
      setAxisGuides({ horizontal: null, vertical: null }); setReconstruction(null); setCorrections([])
      setNeedsProcess(true); setImagePrepared(false); setWorkflowStep('image'); setCalibrationConfirmed(false); setMode('select')
      setPointSelectionVersion((version) => version + 1)
      showNotice('Rotation applied. Process the image and calibrate again before exporting values.')
    } catch (error) {
      if (run === processingRun.current) showNotice(error instanceof Error ? error.message : 'Could not deskew the image.', 'error')
    } finally {
      if (run === processingRun.current) setPreprocessing(false)
    }
  }

  const straightenFromRuler = (start: PixelPoint, end: PixelPoint) => {
    try { void applyDeskew(rulerCorrection(start, end)) }
    catch (error) { showNotice(error instanceof Error ? error.message : 'Could not straighten the image.', 'error') }
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

  const exportExcel = async () => {
    if (!sourceImageUrl || pendingTrace) return
    try {
      const image = new Image(); image.src = sourceImageUrl; await image.decode()
      const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
      const context = canvas.getContext('2d')
      if (!context) throw new Error('This browser cannot draw the plot for Excel.')
      context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height)
      context.drawImage(image, 0, 0)
      drawDatasets(context, datasets, (point) => point, Math.max(2, image.width / 700), Math.max(3, image.width / 260) * pointMarkerSize / 100)
      const xLabel = calibrated ? plotType === 'compressor' ? axisName(compressorAxes.x) : 'X' : 'Pixel X'
      const yLabel = calibrated ? plotType === 'compressor' ? axisName(compressorAxes.y) : 'Y' : 'Pixel Y'
      const workbook = await createWorkbook(datasets.map((dataset) => ({ dataset, points: getExportPoints(dataset) })), xLabel, yLabel, {
        base64: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height,
      })
      const buffer = await workbook.xlsx.writeBuffer()
      const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
      downloadFile(`${imageName || 'plot'}-data.xlsx`, blob)
    } catch (error) {
      showNotice(error instanceof Error ? error.message : 'Could not export the Excel workbook.', 'error')
    }
  }


  const exportProject = async () => {
    const portable = async (url: string | null) => {
      if (!url?.startsWith('blob:')) return url
      const blob = await fetch(url).then((response) => response.blob())
      return new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(new Error('Unable to package the image'))
        reader.readAsDataURL(blob)
      })
    }
    try {
      const project = { version: 1, imageName, imageUrl: await portable(imageUrl), sourceImageUrl: await portable(sourceImageUrl),
        processedImageUrl, processedPreviewUrl, upscale, plotRegion, gridGuides, axisGuides, regularGrid, corrections, eraserWidth, drawWidth, reconstructionColors, reconstructionWidths, pointMarkerSize, imagePrepared, calibrationConfirmed, workflowStep, plotType, xAxis, yAxis, datasets, compressorAxes }
      downloadFile(`${imageName.toLowerCase().replace(/\\s+/g, '-') || 'plot'}-project.json`, JSON.stringify(project), 'application/json')
    } catch (error) {
      showNotice(error instanceof Error ? error.message : 'Unable to save the project.', 'error')
    }
  }


  const importProject = async (file?: File) => {
    if (!file) return
    try {
      const project = JSON.parse(await file.text())
      if (project.version !== 1 || !Array.isArray(project.datasets)) throw new Error('Unsupported project file')
      const validPoint = (value: PixelPoint) => value && Number.isFinite(value.x) && Number.isFinite(value.y)
      const validEraserWidth = (value: number) => Number.isFinite(value) && value >= ERASER_MIN_WIDTH && value <= ERASER_MAX_WIDTH
      if (project.plotRegion && ![project.plotRegion.x, project.plotRegion.y, project.plotRegion.width, project.plotRegion.height].every(Number.isFinite)) throw new Error('Invalid plot region')
      if (project.gridGuides && (!Array.isArray(project.gridGuides.horizontal) || !Array.isArray(project.gridGuides.vertical)
        || !project.gridGuides.horizontal.every(Number.isFinite) || !project.gridGuides.vertical.every(Number.isFinite))) throw new Error('Invalid grid guides')
      if (project.axisGuides && !['horizontal', 'vertical'].every((key) => project.axisGuides[key] === null || Number.isFinite(project.axisGuides[key]))) throw new Error('Invalid axis guides')
      if (project.regularGrid !== undefined && typeof project.regularGrid !== 'boolean') throw new Error('Invalid regular grid setting')
      if (project.workflowStep !== undefined && !['image', 'calibration', 'digitize'].includes(project.workflowStep)) throw new Error('Invalid workflow step')
      if (project.calibrationConfirmed !== undefined && typeof project.calibrationConfirmed !== 'boolean') throw new Error('Invalid calibration confirmation')
      if (project.corrections && (!Array.isArray(project.corrections) || !project.corrections.every((item: Correction) =>
        item && typeof item.erase === 'boolean' && (item.layer === undefined || item.layer === 'curve' || item.layer === 'grid') && (item.width === undefined || (item.erase ? validEraserWidth(item.width) : Number.isFinite(item.width) && item.width >= 0.5 && item.width <= 8)) && Array.isArray(item.points) && item.points.every(validPoint)))) throw new Error('Invalid corrections')
      if (project.eraserWidth !== undefined && !validEraserWidth(project.eraserWidth)) throw new Error('Invalid eraser width')
      if (project.drawWidth !== undefined && (!Number.isFinite(project.drawWidth) || project.drawWidth < 0.5 || project.drawWidth > 8)) throw new Error('Invalid drawing width')
      if (project.upscale !== undefined && (!['original', 'hd', 'fullhd', 'custom'].includes(project.upscale?.preset) || !Number.isInteger(project.upscale?.longEdge) || project.upscale.longEdge < 128 || project.upscale.longEdge > 4096)) throw new Error('Invalid upscale setting')
      if (project.pointMarkerSize !== undefined && (!Number.isFinite(project.pointMarkerSize) || project.pointMarkerSize < 25 || project.pointMarkerSize > 200)) throw new Error('Invalid point marker size')
      if (project.reconstructionColors && !['curve', 'grid', 'axis'].every((key) =>
        typeof project.reconstructionColors[key] === 'string' && /^#[0-9a-f]{6}$/i.test(project.reconstructionColors[key]))) throw new Error('Invalid reconstruction colors')
      if (project.reconstructionWidths && !['curve', 'grid'].every((key) =>
        Number.isFinite(project.reconstructionWidths[key]) && project.reconstructionWidths[key] >= 0.5 && project.reconstructionWidths[key] <= 8)) throw new Error('Invalid reconstruction widths')
      processingRun.current++; setPreprocessing(false)
      setImageName(project.imageName || 'Imported plot'); setImageUrl(project.imageUrl || null); setSourceImageUrl(project.sourceImageUrl || project.imageUrl || null)
      setProcessedImageUrl(project.processedImageUrl || null); setProcessedPreviewUrl(project.processedPreviewUrl || null); setShowOriginalPreview(false); setShowBackground(true)
      setUpscale(project.upscale ?? { preset: 'hd', longEdge: 1920 }); setCustomLongEdge(String(project.upscale?.longEdge ?? 1920))
      setImagePrepared(project.imagePrepared ?? Boolean(project.imageUrl)); setAxisDetection(null); setGridDetection(null)
      setGridGuides(project.gridGuides || { horizontal: [], vertical: [] }); setPlotRegion(project.plotRegion || null); setCorrections(project.corrections || [])
      setAxisGuides(project.axisGuides || { horizontal: null, vertical: null }); setRegularGrid(project.regularGrid ?? false)
      setReconstructionColors(project.reconstructionColors || { curve: '#000000', grid: '#000000', axis: '#000000' })
      setReconstructionWidths(project.reconstructionWidths || { curve: 1, grid: 1 })
      setEraserWidth(project.eraserWidth ?? ERASER_WIDTH)
      setDrawWidth(project.drawWidth ?? 1)
      setPointMarkerSize(project.pointMarkerSize ?? 100)
      setReconstruction(null); setNeedsProcess(true); setPlotType(project.plotType || 'xy'); setFourPointPixels([]); setCompressorAxes(project.compressorAxes || defaultCompressorAxes)
      setXAxis(project.xAxis || blankAxis()); setYAxis(project.yAxis || blankAxis()); setDatasets(project.datasets)
      const hasCalibration = (project.xAxis?.points?.length ?? 0) >= 2 && (project.yAxis?.points?.length ?? 0) >= 2
      const prepared = project.imagePrepared ?? Boolean(project.imageUrl)
      const confirmed = hasCalibration && (project.calibrationConfirmed ?? true)
      const step: WorkflowStep = !prepared ? 'image' : project.workflowStep === 'image' ? 'image' : confirmed && project.workflowStep !== 'calibration' ? 'digitize' : 'calibration'
      setCalibrationConfirmed(confirmed); setWorkflowStep(step); setBrushErasing(false)
      activateDataset(project.datasets[0]?.id ?? ''); setPointSelectionVersion((version) => version + 1); setMode(step === 'digitize' ? 'point' : 'select'); showNotice('Project opened. Process the image again before editing its reconstruction.')
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
  const toggleCompare = () => {
    if (!processedImageUrl || !sourceImageUrl) return
    setShowBackground(true)
    if (workflowStep === 'image' && !showOriginalPreview && mode !== 'prep-heal') setMode('select')
    setShowOriginalPreview((current) => !current)
  }
  const steps: { id: WorkflowStep; label: string; caption: string }[] = [
    { id: 'image', label: 'Process image', caption: 'Prepare & repair' },
    { id: 'calibration', label: 'Calibrate axes', caption: 'Set reference values' },
    { id: 'digitize', label: 'Extract points', caption: 'Review & export' },
  ]
  const currentStepIndex = steps.findIndex((step) => step.id === workflowStep)
  const returnToStep = (step: WorkflowStep) => {
    const target = steps.findIndex((item) => item.id === step)
    if (target >= currentStepIndex || pendingTrace || loading || preprocessing || gridDetecting) return
    if (step === 'image') setImagePrepared(false)
    setCalibrationConfirmed(false)
    setWorkflowStep(step)
    setMode(step === 'calibration' ? 'calibrate-edit' : 'select')
    setActivePanel('data')
  }

  return (
    <main className="app-frame">
      <header className="topbar">
        <a className="brand" href="#" aria-label="Plotline home"><span className="brand-mark"><span /><span /><span /></span><span>plotline</span><span className="brand-divider" /><span className="brand-subtitle">DIGITIZER</span></a>
        <div className="project-name"><span className="project-file-icon"><FileImage size={14} /></span><input aria-label="Project name" value={imageName} onChange={(event) => setImageName(event.target.value)} /><span className="saved-status"><span /> Browser session</span></div>
        <div className="top-actions" inert={Boolean(rotationPreview)}><button className="top-quiet" disabled={Boolean(pendingTrace)} onClick={() => projectInput.current?.click()}><FolderOpen size={15} /> Open project</button><button className="top-quiet" onClick={exportProject}><ArrowDownToLine size={15} /> Save project</button><button className="top-quiet" onClick={() => void exportExcel()} disabled={!sourceImageUrl || Boolean(pendingTrace)}><FileSpreadsheet size={15} /> Export Excel</button><button className="export-top" onClick={() => exportDataset(activeDataset, 'csv')} disabled={!activeDataset?.points.length}><FileSpreadsheet size={15} /> Export data</button></div>
      </header>

      <div className="type-ribbon" inert={Boolean(pendingTrace || rotationPreview)}><span className="ribbon-label">PLOT TYPE</span><div className="plot-tabs" role="tablist" aria-label="Plot type">
        {plotOptions.map(({ id, label, icon: Icon }) => <button key={id} role="tab" aria-selected={plotType === id} className={plotType === id ? 'plot-tab active' : 'plot-tab'} onClick={() => { setPlotType(id); setMode(workflowStep === 'digitize' ? (id === 'compressor' ? 'surge' : 'point') : 'select') }}><Icon size={15} /><span>{label}</span></button>)}
      </div><span className="type-ribbon-spacer" /><button className="icon-action" aria-label="Help" title="Click to add calibration or digitized points. Right-click for canvas actions." onClick={() => showNotice('Set X/Y calibration, choose Add points, then click the chart. Right-click for canvas actions.')}><CircleHelp size={17} /></button></div>

      <nav className="workflow-tabs" aria-label="Workflow steps">
        {steps.map((step, index) => <button key={step.id} type="button" className={`workflow-tab ${index === currentStepIndex ? 'current' : index < currentStepIndex ? 'complete' : 'locked'}`} aria-current={index === currentStepIndex ? 'step' : undefined} disabled={index >= currentStepIndex || Boolean(pendingTrace) || loading || preprocessing || gridDetecting} onClick={() => returnToStep(step.id)} title={index > currentStepIndex ? 'Complete the current step first' : index < currentStepIndex ? 'Return and confirm following steps again' : 'Current step'}><span className="workflow-number">{index < currentStepIndex ? <Check size={14} /> : `0${index + 1}`}</span><span className="workflow-label"><strong>{step.label}</strong><small>{step.caption}</small></span></button>)}
      </nav>

      <div className="workspace">
        <aside className="left-rail" inert={Boolean(pendingTrace || rotationPreview)}>
          <div className="rail-section"><div className="rail-heading"><span>TOOLS</span></div>
            {workflowStep === 'calibration' && <><div className="tool-group-label">CALIBRATION</div>
            <button className={`tool-button ${mode === 'calibrate-x' ? 'selected' : ''}`} onClick={() => addCalibrationPoint('x')} disabled={!imagePrepared}><span className="tool-icon axis-x-icon">X</span><span>Calibrate X axis</span><kbd>{xAxis.points.length}/2</kbd></button>
            <button className={`tool-button ${mode === 'calibrate-y' ? 'selected' : ''}`} onClick={() => addCalibrationPoint('y')} disabled={!imagePrepared}><span className="tool-icon axis-y-icon">Y</span><span>Calibrate Y axis</span><kbd>{yAxis.points.length}/2</kbd></button>
            <button className={`tool-button ${mode === 'calibrate-edit' ? 'selected' : ''}`} onClick={() => setMode(mode === 'calibrate-edit' ? 'select' : 'calibrate-edit')} disabled={!imagePrepared || xAxis.points.length + yAxis.points.length === 0}><span className="tool-icon"><MoveUpRight size={16} /></span><span>Modify calibration</span><kbd>C</kbd></button>
            </>}
            {workflowStep === 'digitize' && <><div className="tool-group-label tool-gap">DIGITIZE</div>
            <button className={`tool-button ${mode === 'point' ? 'selected' : ''}`} onClick={pressPointTool} disabled={!imagePrepared}><span className="tool-icon"><Crosshair size={16} /></span><span>Manual points</span><kbd>P</kbd></button>
            <button className={`tool-button ${mode === 'point-edit' ? 'selected' : ''}`} onClick={() => setMode(mode === 'point-edit' ? 'select' : 'point-edit')} disabled={!imagePrepared || !totalPoints}><span className="tool-icon"><MousePointer2 size={16} /></span><span>Modify curve points</span><kbd>M</kbd></button>
            <button className={`tool-button ${mode === 'trace-region' ? 'selected' : ''}`} onClick={() => setMode('trace-region')} disabled={!imagePrepared}><span className="tool-icon"><Crosshair size={16} /></span><span>Paint curve region</span><kbd>A</kbd></button>
            <button className="tool-button" onClick={retraceActiveDataset} disabled={!imagePrepared || loading || activePoints < 2}><span className="tool-icon"><ScanSearch size={16} /></span><span>Retrace edited curve</span></button>
            <button className={`tool-button ${mode === 'measure' ? 'selected' : ''}`} onClick={() => { if (activeDataset?.kind !== 'measurement') addDataset('measurement'); setMode('measure') }} disabled={!imagePrepared}><span className="tool-icon"><Ruler size={16} /></span><span>Measure angle / distance</span></button>
            {plotType === 'compressor' && <>
              <div className="tool-group-label tool-gap">COMPRESSOR MAP</div>
              <button className={`tool-button ${mode === 'surge' ? 'selected' : ''}`} onClick={() => { const target = datasets.find((dataset) => dataset.kind === 'surge'); if (target) activateDataset(target.id); else addDataset('surge'); setMode('surge') }}><span className="tool-icon boundary-icon">S</span><span>Surge boundary</span><kbd>{datasets.some((dataset) => dataset.kind === 'surge' && dataset.points.length >= 2) ? <Check size={13} /> : '—'}</kbd></button>
              <button className={`tool-button ${mode === 'choke' ? 'selected' : ''}`} onClick={() => { const target = datasets.find((dataset) => dataset.kind === 'choke'); if (target) activateDataset(target.id); else addDataset('choke'); setMode('choke') }}><span className="tool-icon boundary-icon choke-icon">C</span><span>Choke boundary</span><kbd>{datasets.some((dataset) => dataset.kind === 'choke' && dataset.points.length >= 2) ? <Check size={13} /> : '—'}</kbd></button>
              <button className={`tool-button ${mode === 'speed' ? 'selected' : ''}`} onClick={() => addDataset('speed')}><span className="tool-icon"><Gauge size={16} /></span><span>New speed line</span><kbd>RPM</kbd></button>
              <button className={`tool-button ${activeDataset?.kind === 'efficiency' ? 'selected' : ''}`} onClick={() => addDataset('efficiency')}><span className="tool-icon"><Activity size={16} /></span><span>Efficiency contour</span></button>
            </>}
            </>}
            <div className="tool-group-label tool-gap">IMAGE</div>
            <button className={`tool-button ${mode === 'crop' ? 'selected' : ''}`} onClick={() => setMode('crop')} disabled={!imagePrepared}><span className="tool-icon"><Crop size={16} /></span><span>Crop image</span></button>
            <button className="tool-button" onClick={() => imageInput.current?.click()}><span className="tool-icon"><ImagePlus size={16} /></span><span>Replace image</span></button>
            <div className="transform-grid"><button title="Rotate left" aria-label="Rotate left" onClick={() => void applyImageTransform('rotate-left')}><RotateCcw size={15} /></button><button title="Rotate right" aria-label="Rotate right" onClick={() => void applyImageTransform('rotate-right')}><RotateCw size={15} /></button><button title="Flip horizontal" aria-label="Flip horizontal" onClick={() => void applyImageTransform('flip-x')}><FlipHorizontal size={15} /></button><button title="Flip vertical" aria-label="Flip vertical" onClick={() => void applyImageTransform('flip-y')}><FlipVertical size={15} /></button></div>
          </div>
          <div className="rail-bottom"><span className="connection-indicator" /><span>All changes stay in this browser</span><button title="Settings" aria-label="Settings" onClick={() => setActivePanel(activePanel === 'settings' ? 'data' : 'settings')}><Settings2 size={15} /></button></div>
        </aside>

        <section className="center-workspace" aria-label="Plot workspace">
          <div className="workspace-toolbar"><div className="toolbar-left"><span className="breadcrumb-root">Workspace</span><span className="breadcrumb-separator">/</span><span className="breadcrumb-active">{imageName || 'Untitled plot'}</span><span className="image-badge">{imageUrl ? 'IMAGE LOADED' : 'NO IMAGE'}</span></div><div className="toolbar-right" inert={Boolean(rotationPreview)}><button onClick={toggleCompare} disabled={!processedImageUrl || !sourceImageUrl || mode === 'prep-straighten'} aria-label={showOriginalPreview ? 'Show reconstruction' : 'Compare original'} title={showOriginalPreview ? 'Show reconstruction' : 'Compare original'} aria-pressed={showOriginalPreview}><Eye size={14} /> {showOriginalPreview ? 'Show reconstruction' : 'Compare original'}</button><button onClick={() => setShowBackground((current) => !current)} disabled={!imageUrl || mode === 'prep-straighten'} aria-pressed={showBackground}>{showBackground ? 'Hide image' : 'Show image'}</button><button title="Undo last point" onClick={() => { if (activeDataset) { updateDataset(activeId, (dataset) => ({ ...dataset, points: dataset.points.slice(0, -1) })); setPointSelectionVersion((version) => version + 1) } }} disabled={Boolean(pendingTrace) || workflowStep !== 'digitize' || !activePoints}><RotateCcw size={14} /> Undo</button><span className="toolbar-separator" /><button title="Show point table" disabled={workflowStep !== 'digitize'} className={showTable && workflowStep === 'digitize' ? 'toolbar-active' : ''} onClick={() => setShowTable(!showTable)}><Layers size={14} /> Data table</button></div></div>
          {plotType === 'compressor' && <div className="compressor-banner"><Gauge size={15} /><span><strong>Compressor map mode</strong> · Trace speed/IGV and efficiency curves directly; boundaries optionally stop speed traces.</span><span className="boundary-progress"><i className={datasets.some((dataset) => dataset.kind === 'surge' && dataset.points.length >= 2) ? 'complete' : ''} />Surge <i className={datasets.some((dataset) => dataset.kind === 'choke' && dataset.points.length >= 2) ? 'complete' : ''} />Choke</span></div>}
          <div className={`canvas-zone ${dragActive ? 'drag-active' : ''}`} onDragEnter={(event) => { event.preventDefault(); setDragActive(true) }} onDragOver={(event) => event.preventDefault()} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragActive(false) }} onDrop={(event) => { event.preventDefault(); setDragActive(false); const file = Array.from(event.dataTransfer.files).find((item) => item.type.startsWith('image/')); if (file) openImage(file) }}>
            <PlotCanvas imageUrl={rotationPreview?.url ?? (showOriginalPreview ? sourceImageUrl : imageUrl)} displayImageUrl={!rotationPreview && !showOriginalPreview && processedImageUrl ? processedPreviewUrl : null} onImageError={() => showNotice('Could not load the plot image or upscaled preview.', 'error')} onSaveError={(message) => showNotice(message, 'error')} imageName={imageName} imageLabel={rotationPreview ? 'Rotation preview — not applied' : showOriginalPreview ? 'Original scan' : processedImageUrl ? 'Reconstructed plot' : 'Original image'} showBackground={Boolean(rotationPreview) || showBackground} datasets={previewDatasets} activeDatasetId={activeId} selectionVersion={pointSelectionVersion} onSelectDataset={activateDataset} mode={mode} gridGuides={!rotationPreview && showGuides && mode !== 'prep-straighten' ? gridGuides : { horizontal: [], vertical: [] }} axisGuides={!rotationPreview && showGuides && mode !== 'prep-straighten' ? axisGuides : { horizontal: null, vertical: null }} plotRegion={!rotationPreview && showGuides && mode !== 'prep-straighten' ? plotRegion : null}
              calibrationMarkers={rotationPreview || mode === 'prep-straighten' || (calibrationConfirmed && mode !== 'calibrate-edit') ? [] : [
                ...xAxis.points.map((point, index) => ({ axis: 'x' as const, index, point, value: point.value, label: `X${index + 1}` })),
                ...yAxis.points.map((point, index) => ({ axis: 'y' as const, index, point, value: point.value, label: `Y${index + 1}` })),
              ]}
              calibrationMarkerColor={calibrationMarkerColor}
              pointMarkerSize={pointMarkerSize}
              showCalibrationMarkers={!calibrationConfirmed || mode === 'calibrate-edit'}
              xAxis={xAxis}
              yAxis={yAxis}
              coordinateLabels={plotType === 'compressor'
                ? { x: axisName(compressorAxes.x), y: axisName(compressorAxes.y) }
                : { x: 'X', y: 'Y' }}
              coordinateScales={{ x: xAxis.scale, y: yAxis.scale }}
              traceBrushWidth={traceBrushWidth}
              eraserWidth={eraserWidth}
              brushMarks={brushMarks}
              brushErasing={brushErasing}
              curveColor={reconstructionColors.curve}
              correctionColor={reconstructionColors[correctionLayer]}
              correctionWidth={drawWidth}
              healMark={healMark}
              healBrushWidth={healBrushWidth}
              healPreview={healPreview}
              onApplyHealing={applyHealing}
              onHealChoiceChange={setHealChoice}
              readOnly={Boolean(pendingTrace || rotationPreview)}
              onCanvasClick={(point) => { void handleCanvasClick(point) }} onDeletePoint={deleteNearestPoint} canDeletePoint={workflowStep === 'digitize'}
              onDeleteSelectedPoint={(datasetId, index) => updateDataset(datasetId, (dataset) => ({ ...dataset, points: dataset.points.filter((_, pointIndex) => pointIndex !== index) }))}
              onSeedColor={(rgb) => setSeedColor((current) => current.every((channel, index) => channel === rgb[index]) ? current : rgb)}
              onCropSelection={(rect) => { void cropImage(rect) }}
              onRegionSelection={(rect) => {
                if (preprocessing) return
                if (rect.width < 20 || rect.height < 20) { showNotice('Select a plot area at least 20 pixels wide and high.', 'error'); return }
                setPlotRegion(rect); setNeedsProcess(true); setImagePrepared(false); setMode('select')
                showNotice('Plot area selected. Press Process image to rebuild it.')
              }}
              onStraighten={straightenFromRuler}
              onMovePoint={(datasetId, index, point) => updateDataset(datasetId, (dataset) => ({ ...dataset, points: dataset.points.map((current, pointIndex) => pointIndex === index ? point : current) }))}
              onMoveCalibrationPoint={updateCalibrationPoint}
              onTraceRegion={tracePaintedRegion} />
            {!imageUrl && <button className="upload-overlay" onClick={() => imageInput.current?.click()}><Upload size={15} /> Choose image</button>}
          </div>
          <div className="mode-strip"><span className="mode-symbol"><MousePointer2 size={14} /></span><span className="mode-text"><strong>{pendingTrace ? 'Review points' : !imageUrl ? 'Upload image' : modeLabels[mode]}</strong>{pendingTrace ? ' · Compare the new curves, then confirm or discard them.' : !imageUrl ? ' · Paste or drop a plot image, or choose a file.' : mode === 'prep-heal' ? ' · Brush over one gap, then choose and review a connection.' : mode === 'prep-region' ? ' · Drag around the plot area, including its axes.' : mode === 'prep-erase' ? ' · Click or drag to erase the selected layer.' : mode === 'prep-draw' || mode === 'prep-line' ? ' · Drag over the image to edit the reconstruction.' : mode === 'grid-horizontal' || mode === 'grid-vertical' ? ' · Click adjacent grid lines on the original, then process again.' : mode === 'guide-axis-x' || mode === 'guide-axis-y' ? ' · Click the axis on the original, then process again.' : !imagePrepared ? ' · Process, compare and correct the reconstruction before confirming.' : mode === 'calibrate-four' ? ` · Click ${(['X1', 'X2', 'Y1', 'Y2'][fourPointPixels.length] ?? 'the next reference point')} on the chart.` : mode === 'calibrate-intersections' ? ` · Click intersection ${fourPointPixels.length + 1}, corresponding to X${fourPointPixels.length + 1} and Y${fourPointPixels.length + 1}.` : mode === 'calibrate-edit' ? ' · Click or drag a calibration marker; arrow keys move 1 px, Shift + arrows 10 px.' : mode === 'point-edit' || mode === 'select' ? ' · Select a curve point, then drag or use arrow keys to fine-tune; Shift moves 10 px. In Modify mode, Delete removes the selected point.' : mode === 'trace-region' ? ' · Brush curves, then press Auto point.' : mode === 'speed' ? ' · Click a speed line, or use Paint curve region to guide it.' : mode === 'surge' || mode === 'choke' ? ' · Click sequentially along the compressor boundary.' : ' · Click to add a point. Use Modify curve points to adjust existing points.'}</span><span className="mode-spacer" />{loading ? <span className="tracing-state"><span className="loader-dot" /> Tracing…</span> : !pendingTrace && <span className="keyboard-tip"><kbd>Esc</kbd> select · <kbd>M</kbd> modify</span>}</div>
          {showTable && workflowStep === 'digitize' && <div className="data-table-panel">
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
                  <td><input className="point-coordinate-input" aria-label={`${activeDataset?.name} point ${index + 1} pixel X`} type="number" step="0.1" disabled={Boolean(pendingTrace)} value={point.x} onChange={(event) => activeDataset && updatePointCoordinate(activeDataset.id, index, 'x', event.target.value)} /></td>
                  <td><input className="point-coordinate-input" aria-label={`${activeDataset?.name} point ${index + 1} pixel Y`} type="number" step="0.1" disabled={Boolean(pendingTrace)} value={point.y} onChange={(event) => activeDataset && updatePointCoordinate(activeDataset.id, index, 'y', event.target.value)} /></td>
                </tr>
              })}</tbody>
            </table></div>
          </div>}
        </section>

        <aside className="right-panel">
          <div className="panel-tabs"><button className={activePanel === 'data' ? 'active' : ''} onClick={() => setActivePanel('data')}><Layers size={14} /> Data</button><button className={activePanel === 'settings' ? 'active' : ''} disabled={Boolean(pendingTrace || rotationPreview)} onClick={() => setActivePanel('settings')}><Settings2 size={14} /> Settings</button></div>
          {activePanel === 'data' ? <div className="panel-content">
            {workflowStep === 'image' && <ImagePreparationPanel hasImage={Boolean(imageUrl)} sourceImageUrl={sourceImageUrl} hasProcessedImage={Boolean(processedImageUrl)} showingOriginal={showOriginalPreview} processing={preprocessing} needsProcess={needsProcess} hasRegion={Boolean(plotRegion)} correctionCount={corrections.length} correctionLayer={correctionLayer} eraserWidth={eraserWidth} drawWidth={drawWidth} snapDrawing={snapDrawing} healBrushWidth={healBrushWidth} healingPreview={Boolean(healPreview)} healChoice={healChoice} upscale={upscale} customLongEdge={customLongEdge} widths={reconstructionWidths} widthsRequireProcess={!reconstruction || needsProcess} gridGuides={gridGuides} axisGuides={axisGuides} regularGrid={regularGrid} mode={mode} rotationPreviewActive={Boolean(rotationPreview)}
              onProcess={() => { void processImage() }}
              onDeskew={(degrees) => { void applyDeskew(degrees) }}
              onRotationPreview={(preview) => { setRotationPreview(preview); if (preview) setMode('select') }}
              onSelectTool={(next) => {
                if (preprocessing) return
                if ((next === 'prep-draw' || next === 'prep-line' || next === 'prep-erase' || next === 'prep-heal') && (!reconstruction || needsProcess)) { showNotice('Process the image before editing the reconstruction.', 'error'); return }
                if (mode !== next && (next === 'grid-horizontal' || next === 'grid-vertical' || next === 'guide-axis-x' || next === 'guide-axis-y' || next === 'prep-region' || next === 'prep-straighten')) setShowOriginalPreview(true)
                if (mode !== next && (next === 'prep-draw' || next === 'prep-line' || next === 'prep-erase' || next === 'prep-heal')) setShowOriginalPreview(false)
                if (next === 'prep-heal') setCorrectionLayer('curve')
                setShowBackground(true); setMode(mode === next ? 'select' : next)
              }}
              onCorrectionLayerChange={(layer) => { setCorrectionLayer(layer); if (layer !== 'curve' && mode === 'prep-heal') setMode('select') }}
              onEraserWidthChange={setEraserWidth}
              onDrawWidthChange={setDrawWidth}
              onSnapDrawingChange={setSnapDrawing}
              onHealBrushWidthChange={setHealBrushWidth}
              onHealChoiceChange={setHealChoice}
              onApplyHealing={applyHealing}
              onDiscardHealing={() => { setHealMark(null); setHealOptions([]) }}
              onUpscaleChange={updateUpscale}
              onCustomLongEdgeChange={setCustomLongEdge}
              onApplyCustomUpscale={() => {
                const longEdge = Number(customLongEdge)
                if (!Number.isInteger(longEdge) || longEdge < 128 || longEdge > 4096) { showNotice('Enter a long edge between 128 and 4096 pixels.', 'error'); return }
                updateUpscale({ preset: 'custom', longEdge })
              }}
              onWidthsChange={(widths) => updateReconstructionAppearance(reconstructionColors, widths)}
              onClearRegion={() => { if (!preprocessing) { setPlotRegion(null); setNeedsProcess(true); setImagePrepared(false) } }}
              onClearGridGuides={() => { if (!preprocessing) { setGridGuides({ horizontal: [], vertical: [] }); setNeedsProcess(true); setImagePrepared(false); setMode('select') } }}
              onClearAxisGuides={() => { if (!preprocessing) { setAxisGuides({ horizontal: null, vertical: null }); setNeedsProcess(true); setImagePrepared(false); setMode('select') } }}
              onRegularGridChange={(enabled) => { if (!preprocessing) { setRegularGrid(enabled); setNeedsProcess(true); setImagePrepared(false) } }}
              onUndoCorrection={() => updateCorrections(corrections.slice(0, -1))}
              onContinue={() => { if (healPreview) { showNotice('Apply or discard the proposed connection before continuing.', 'error'); return }; confirmPreparedImage() }} />}
            {imagePrepared && <>
            {workflowStep === 'calibration' && <><section className="panel-section calibration-section"><div className="section-heading"><div><span className="section-kicker">STEP 02</span><h2>Axis calibration</h2></div><span className={`calibration-state ${calibrated ? 'ready' : ''}`}>{calibrated ? <><Check size={12} /> READY</> : 'NEEDED'}</span></div>
              <p className="section-copy">Click two known ticks on each axis and enter their values.</p>
              <div className="four-point-calibration">
                <strong>Guided 4-point calibration</strong>
                <p>Enter tick values for X1 (left), X2 (right), Y1 (top), and Y2 (bottom), then click each matching point in order.</p>
                <div className="four-point-values">
                  {(['x1', 'x2', 'y1', 'y2'] as const).map((key) => {
                    const coordinate = key.startsWith('x') ? 'x' : 'y'
                    const label = plotType === 'compressor' ? axisName(compressorAxes[coordinate]) : `${coordinate.toUpperCase()} value`
                    return <label key={key}>{key.toUpperCase()} · {label}<input aria-label={`${key.toUpperCase()} ${label} calibration value`} value={fourPointValues[key]} placeholder={(key.startsWith('x') ? xAxis.scale : yAxis.scale) === 'date' ? 'Date / time' : 'Tick value'} onChange={(event) => setFourPointValues((current) => ({ ...current, [key]: event.target.value }))} /></label>
                  })}
                </div>
                <button className="axis-detect-button" onClick={() => { setFourPointPixels([]); setMode('calibrate-four') }} disabled={!imagePrepared}>
                  {mode === 'calibrate-four' && fourPointPixels.length ? 'Restart 4-point calibration' : 'Start 4-point calibration'}
                </button>
                <p>Alternatively, enter X1/Y1 and X2/Y2 for two grid intersections, in the order you click them.</p>
                <button className="axis-detect-button" onClick={() => { setFourPointPixels([]); setMode('calibrate-intersections') }}>
                  {mode === 'calibrate-intersections' && fourPointPixels.length ? 'Restart 2-intersection calibration' : 'Calibrate from 2 intersections'}
                </button>
              </div>
              <AxisEditor axis="x" coordinateLabel={plotType === 'compressor' ? axisName(compressorAxes.x) : 'X value'} calibration={xAxis} setValue={setXValue} value={xValue} mode={mode} setMode={setMode} addPoint={addCalibrationPoint} setScale={updateScale} updatePointValue={updateCalibrationValue} />
              <AxisEditor axis="y" coordinateLabel={plotType === 'compressor' ? axisName(compressorAxes.y) : 'Y value'} calibration={yAxis} setValue={setYValue} value={yValue} mode={mode} setMode={setMode} addPoint={addCalibrationPoint} setScale={updateScale} updatePointValue={updateCalibrationValue} />
              {calibrated && <div className="calibration-confirm-row">
                <span>{calibrationConfirmed ? 'Calibration confirmed · markers hidden' : 'Review the labeled points, then confirm calibration.'}</span>
                <button className="axis-detect-button" onClick={() => {
                  if (calibrationConfirmed) {
                    setCalibrationConfirmed(false)
                    setMode('calibrate-edit')
                  } else {
                    setCalibrationConfirmed(true)
                    setWorkflowStep('digitize')
                    setMode('point')
                  }
                }}>{calibrationConfirmed ? 'Modify calibration' : 'Confirm calibration'}</button>
              </div>}
              <button className="axis-detect-button" onClick={() => { void calibrateFromDetectedGrid() }} disabled={gridDetecting || !imagePrepared}>
                <ScanSearch size={14} /> {gridDetecting ? 'Detecting grid…' : 'Detect grid & calibrate'}
              </button>
              <p className="axis-detect-note">Uses the outermost detected grid lines: X1 left, X2 right, Y1 top, Y2 bottom. Enter their tick values above.</p>
              {gridDetection && <p className="axis-detect-note">Found {gridDetection.verticalLines.length} vertical × {gridDetection.horizontalLines.length} horizontal lines. Calibration markers are ready to fine-tune.</p>}
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
            </section>}</>}
            {workflowStep === 'digitize' && <>
            {plotType === 'compressor' && <section className="compressor-note"><div className="note-icon"><Gauge size={15} /></div><div><strong>Optional boundaries</strong><span>Add Surge/Choke to stop speed traces near their sampled points.</span></div><span className="note-status">{datasets.filter((dataset) => dataset.kind === 'surge' || dataset.kind === 'choke').filter((dataset) => dataset.points.length >= 2).length}/2</span></section>}
            <section className="panel-section datasets-section"><div className="section-heading dataset-heading"><div><span className="section-kicker">STEP 03</span><h2>Datasets <span className="count-pill">{datasets.length}</span></h2></div>{!pendingTrace && selectedDatasetIds.length > 1 && <div className="dataset-bulk-actions"><span>{selectedDatasetIds.length} selected</span><button onClick={mergeSelectedDatasets} title="Merge selected datasets">Merge</button><button className="bulk-delete" onClick={deleteSelectedDatasets} title="Delete selected datasets">Delete</button></div>}<button className="add-small" aria-label="Add dataset" disabled={Boolean(pendingTrace)} onClick={() => addDataset()} title="Add dataset">+</button></div>
              <label className="range-row"><span>Curve point marker size</span><strong>{pointMarkerSize}%</strong><input aria-label="Curve point marker size" type="range" min="25" max="200" step="25" value={pointMarkerSize} onChange={(event) => setPointMarkerSize(Number(event.target.value))} /></label>
              <p className="dataset-selection-hint">Drag the handle to reorder. Ctrl-click to merge or delete several.</p>
              <div className="dataset-list">{datasets.map((dataset) => <div key={dataset.id} className={`dataset-card ${dataset.id === activeId ? 'active' : ''} ${selectedDatasetIds.includes(dataset.id) ? 'multi-selected' : ''} ${datasetDropTarget?.id === dataset.id ? datasetDropTarget.after ? 'drop-after' : 'drop-before' : ''}`}
                onDragOver={(event) => { if (draggedDatasetId.current && draggedDatasetId.current !== dataset.id) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; const after = event.clientY > event.currentTarget.getBoundingClientRect().top + event.currentTarget.offsetHeight / 2; setDatasetDropTarget((current) => current?.id === dataset.id && current.after === after ? current : { id: dataset.id, after }) } }}
                onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDatasetDropTarget(null) }}
                onDrop={(event) => { if (!draggedDatasetId.current) return; event.preventDefault(); event.stopPropagation(); const after = event.clientY > event.currentTarget.getBoundingClientRect().top + event.currentTarget.offsetHeight / 2; const id = draggedDatasetId.current; setDatasets((current) => reorderDatasets(current, id, dataset.id, after)); draggedDatasetId.current = null; setDatasetDropTarget(null) }}
              >
                <div className="dataset-row">
                {!pendingTrace && <button className="dataset-drag" draggable aria-label={`Reorder ${dataset.name}`} title="Drag to reorder; arrow keys move the dataset" onDragStart={(event) => { draggedDatasetId.current = dataset.id; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', dataset.id) }} onDragEnd={() => { draggedDatasetId.current = null; setDatasetDropTarget(null) }} onKeyDown={(event) => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); moveDataset(dataset.id, event.key === 'ArrowUp' ? -1 : 1) } }}><GripVertical size={14} /></button>}
                <div className="dataset-entry">
                  <button className="dataset-select" onClick={(event) => selectDataset(dataset, event.ctrlKey || event.metaKey)} onKeyDown={(event) => { if (event.key === 'Delete' && !pendingTrace && selectedDatasetIds.length > 1) { event.preventDefault(); event.stopPropagation(); deleteSelectedDatasets() } }} aria-label={`Select ${dataset.name}`} aria-pressed={selectedDatasetIds.includes(dataset.id)} />
                  <label className="dataset-swatch" title="Change dataset color"><input aria-label={`Color ${dataset.name}`} type="color" disabled={Boolean(pendingTrace)} value={dataset.color} onChange={(event) => updateDataset(dataset.id, (current) => ({ ...current, color: event.target.value }))} /><span style={{ backgroundColor: dataset.color }} /></label>
                  <span className="dataset-meta">
                    <span className="dataset-title">{editingDatasetName?.id === dataset.id ? <form className="dataset-name-editor" onSubmit={(event) => { event.preventDefault(); saveDatasetName() }}><input autoFocus aria-label={`Rename ${dataset.name}`} value={editingDatasetName.value} onChange={(event) => setEditingDatasetName({ id: dataset.id, value: event.target.value })} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setEditingDatasetName(null) } }} /><button type="submit" title="Confirm name" aria-label="Confirm name"><Check size={12} /></button></form> : <><span className="dataset-name">{dataset.name}</span>{!pendingTrace && <button className="dataset-edit-name" title="Rename dataset" aria-label={`Rename ${dataset.name}`} onClick={() => setEditingDatasetName({ id: dataset.id, value: dataset.name })}><Pencil size={12} /></button>}</>}</span>
                    <span className="dataset-detail">{dataset.kind === 'speed' ? `${dataset.rpm?.toLocaleString() ?? '—'} ${dataset.speedUnit || 'RPM'}${dataset.igv === undefined ? '' : ` · IGV ${dataset.igv}${dataset.igvUnit ? ` ${dataset.igvUnit}` : ''}`}` : dataset.kind === 'efficiency' ? `${dataset.efficiencyValue ?? '—'}% contour` : dataset.kind === 'surge' ? 'Surge boundary' : dataset.kind === 'choke' ? 'Choke boundary' : `${dataset.points.length} points`}</span>
                  </span>
                  <span className="dataset-point-count">{dataset.points.length}</span>
                </div>
                {(pendingTrace || selectedDatasetIds.length < 2) && <button className="dataset-delete" title={datasets.length === 1 ? 'Clear dataset points' : 'Delete dataset'} aria-label={`${datasets.length === 1 ? 'Clear' : 'Delete'} ${dataset.name}`} disabled={Boolean(pendingTrace && !pendingTrace.ids.includes(dataset.id))} onClick={() => deleteDataset(dataset.id)}><Trash2 size={14} /><span>{datasets.length === 1 ? 'Clear' : 'Delete'}</span></button>}
                </div>
                {!pendingTrace && dataset.id === activeId && <div className="dataset-controls"><button title="Export CSV" aria-label="Export CSV" onClick={() => exportDataset(dataset, 'csv')}><FileSpreadsheet size={14} /></button></div>}
                {!pendingTrace && dataset.kind === 'speed' && dataset.id === activeId && <>
                  <label className="rpm-control">Speed value <div><input aria-label="Speed value" type="number" step="100" value={dataset.rpm ?? ''} onChange={(event) => updateDataset(dataset.id, (current) => ({ ...current, rpm: event.target.value === '' ? undefined : Number(event.target.value) }))} /><input aria-label="Speed unit" value={dataset.speedUnit ?? ''} onChange={(event) => updateDataset(dataset.id, (current) => ({ ...current, speedUnit: event.target.value }))} /></div></label>
                  <label className="rpm-control">IGV setting <div><input aria-label="IGV value" type="number" step="1" value={dataset.igv ?? ''} onChange={(event) => updateDataset(dataset.id, (current) => ({ ...current, igv: event.target.value === '' ? undefined : Number(event.target.value) }))} /><input aria-label="IGV unit" value={dataset.igvUnit ?? ''} placeholder="Optional unit" onChange={(event) => updateDataset(dataset.id, (current) => ({ ...current, igvUnit: event.target.value }))} /></div></label>
                </>}
                {!pendingTrace && dataset.kind === 'efficiency' && dataset.id === activeId && <label className="rpm-control">Efficiency contour <div><input aria-label="Efficiency contour value" type="number" min="0" max="100" step="0.1" value={dataset.efficiencyValue ?? ''} onChange={(event) => updateDataset(dataset.id, (current) => ({ ...current, efficiencyValue: event.target.value === '' ? undefined : Number(event.target.value) }))} /><span>%</span></div></label>}
              </div>)}</div>
              {activeDataset?.kind === 'measurement' && <div className="measurement-results"><div><span>Distance</span><strong>{measuredDistance === null ? 'Add two points' : calibrated ? measuredDistance.toPrecision(5) : `${measuredDistance.toFixed(1)} px`}</strong></div><div><span>Angle</span><strong>{measuredAngle === null ? 'Add 3 points' : `${measuredAngle.toFixed(2)}°`}</strong></div></div>}
              <button className="add-dataset-button" disabled={Boolean(pendingTrace)} onClick={() => addDataset()}><span>+</span> Add dataset</button>
            </section>
            {pendingTrace && <section className="panel-section extraction-section"><div className="section-heading"><div><span className="section-kicker">REVIEW POINTS</span><h2>Check extracted curves</h2></div></div><p className="section-copy">Compare the new points with the image and select datasets to inspect. Confirm before editing, or discard the new datasets to adjust the brush selection.</p>{pendingTrace.warnings.map((warning) => <div className="trace-hint" role="status" key={warning}>{warning}</div>)}<div className="prep-actions"><button className="prep-apply" onClick={() => { activateDataset(pendingTrace.ids.includes(activeId) ? activeId : pendingTrace.ids[0]); setPendingTrace(null); setBrushMarks([]); setBrushErasing(false); setMode('point-edit') }}>Confirm points &amp; modify</button><button className="prep-compare" onClick={() => { setDatasets((current) => current.filter((dataset) => !pendingTrace.ids.includes(dataset.id))); activateDataset(pendingTrace.previousActiveId); setPendingTrace(null); setMode('trace-region') }}>Discard points / adjust brush</button></div></section>}
            {mode === 'trace-region' || mode === 'speed' ? <section className="panel-section extraction-section">
              <div className="section-heading"><div><span className="section-kicker">CURVE EXTRACTION</span><h2>{mode === 'trace-region' ? 'Painted curve finder' : 'Automatic curve finder'}</h2></div><ScanSearch size={16} /></div>
              <p className="section-copy">{mode === 'speed' ? <>Click the speed line, or use Paint curve region for a guided trace. Sampled color <span className="color-chip" style={{ backgroundColor: `rgb(${seedColor.join(',')})` }} /> RGB {seedColor.join(', ')}</> : 'Brush over one or more curves. Erase parts of the selection if needed, then press Auto point.'}</p>
              <label className="range-row"><span>Color tolerance</span><strong>{tolerance}</strong><input aria-label="Curve color tolerance" type="range" min="12" max="180" disabled={mode === 'trace-region' && (showOriginalPreview || !processedImageUrl || Boolean(reconstruction && !needsProcess))} value={tolerance} onChange={(event) => setTolerance(Number(event.target.value))} /></label>
              <label className="range-row"><span>Point spacing</span><strong>{sampleStep} px</strong><input aria-label="Curve point spacing" type="range" min="1" max="60" value={sampleStep} onChange={(event) => setSampleStep(Number(event.target.value))} /></label>
              <label className="range-row"><span>Paint brush width</span><strong>{traceBrushWidth} px</strong><input aria-label="Curve brush width" type="range" min="8" max="72" step="2" value={traceBrushWidth} onChange={(event) => setTraceBrushWidth(Number(event.target.value))} /></label>
              {mode === 'trace-region' && <><div className="brush-tools" role="group" aria-label="Brush selection tool"><button aria-pressed={!brushErasing} onClick={() => setBrushErasing(false)}>Brush</button><button aria-pressed={brushErasing} onClick={() => setBrushErasing(true)}>Erase selection</button></div><div className="prep-actions"><button className="prep-apply" disabled={!brushMarks.some((mark) => !mark.erase) || loading} onClick={() => { void autoPaintedPoints() }}>Auto point</button><button className="prep-compare" disabled={!brushMarks.length || loading} onClick={() => setBrushMarks([])}>Clear brush</button></div></>}
              <div className="trace-hint"><Sparkles size={13} /> Each separate brush region should contain one curve. Erase between touching regions. Auto point uses the curve layer when available; color tolerance applies to composite images. Inspect gaps and every result.</div>
            </section> : null}
            <div className="panel-footer"><span className="footer-stat"><Crosshair size={13} /> {totalPoints} points</span><span className="footer-stat"><Layers size={13} /> {datasets.length} datasets</span></div>
            </>}
            </>}
          </div> : <div className="panel-content settings-content">
            <section className="panel-section"><div className="section-heading"><div><span className="section-kicker">RECONSTRUCTION</span><h2>Line appearance</h2></div></div><p className="section-copy">Select axes in Process image, or use the leftmost vertical and lowest horizontal lines by default. Verify them against the scan.</p>{(['curve', 'grid', 'axis'] as const).map((kind) => <label className="format-control" key={kind}><span>{kind} color</span><input aria-label={`Reconstructed ${kind} color`} type="color" disabled={preprocessing} value={reconstructionColors[kind]} onChange={(event) => updateReconstructionAppearance({ ...reconstructionColors, [kind]: event.target.value }, reconstructionWidths)} /></label>)}{(['curve', 'grid'] as const).map((kind) => <label className="range-row" key={kind}><span>{kind === 'grid' ? 'Grid and axis' : 'Curve'} thickness</span><strong>{reconstructionWidths[kind]} px</strong><input aria-label={`Reconstructed ${kind} thickness`} type="range" min="0.5" max="8" step="0.5" disabled={preprocessing} value={reconstructionWidths[kind]} onChange={(event) => updateReconstructionAppearance(reconstructionColors, { ...reconstructionWidths, [kind]: Number(event.target.value) })} /></label>)}</section>
            <section className="panel-section"><div className="section-heading"><div><span className="section-kicker">CALIBRATION</span><h2>Marker appearance</h2></div></div><p className="section-copy">The selected calibration point uses this color. Confirmed calibration hides the markers.</p><label className="format-control"><span>Selected marker color</span><input aria-label="Selected calibration marker color" type="color" value={calibrationMarkerColor} onChange={(event) => setCalibrationMarkerColor(event.target.value)} /></label></section>
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

function AxisEditor({ axis, coordinateLabel, calibration, value, setValue, mode, setMode, addPoint, setScale, updatePointValue }: {
  axis: 'x' | 'y'; coordinateLabel: string; calibration: AxisCalibration; value: string; setValue: (value: string) => void; mode: ToolMode;
  setMode: (mode: ToolMode) => void; addPoint: (axis: 'x' | 'y') => void; setScale: (axis: 'x' | 'y', scale: ScaleType) => void;
  updatePointValue: (axis: 'x' | 'y', index: number, value: string) => void
}) {
  const [pointValueDrafts, setPointValueDrafts] = useState(() => calibration.points.map((point) => formatCalibrationValue(point.value, calibration.scale)))
  useEffect(() => {
    setPointValueDrafts(calibration.points.map((point) => formatCalibrationValue(point.value, calibration.scale)))
  }, [calibration.points, calibration.scale])

  return <div className={`axis-editor ${mode === `calibrate-${axis}` ? 'axis-editor-active' : ''}`}>
    <div className="axis-editor-top"><span className={`axis-letter axis-${axis}`}>{axis.toUpperCase()}</span><span className="axis-label">{axis === 'x' ? 'Horizontal axis' : 'Vertical axis'}</span><select aria-label={`${axis.toUpperCase()} axis scale`} value={calibration.scale} onChange={(event) => setScale(axis, event.target.value as ScaleType)}><option value="linear">Linear</option><option value="log">Log₁₀</option><option value="inverse">Inverse</option><option value="date">Date/time</option></select></div>
    <div className="axis-point-entry"><span className="axis-point-index">P{calibration.points.length + 1}</span><input aria-label={`${coordinateLabel} tick value`} value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229) addPoint(axis) }} placeholder={calibration.scale === 'date' ? 'e.g. 2026-04-14T09:30' : `${coordinateLabel} value`} /><button className={mode === `calibrate-${axis}` ? 'waiting' : ''} onClick={() => setMode(`calibrate-${axis}`)}>{mode === `calibrate-${axis}` ? 'Click chart' : 'Set point'}</button></div>
    {calibration.points.length > 0 && <div className="axis-point-list">{calibration.points.map((point, index) => <label key={`${point.x}:${point.y}`}><span>P{index + 1}</span><input aria-label={`${coordinateLabel} calibration point ${index + 1} value`} value={pointValueDrafts[index] ?? ''} onChange={(event) => { setPointValueDrafts((current) => current.map((draft, draftIndex) => draftIndex === index ? event.target.value : draft)); updatePointValue(axis, index, event.target.value) }} /><small>{Math.round(point.x)}, {Math.round(point.y)} px</small></label>)}</div>}
  </div>
}
