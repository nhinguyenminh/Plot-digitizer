import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, ArrowDownToLine, Axis3D, Check, ChevronDown, CircleHelp, Crosshair, Crop, FileImage, FileJson2,
  Eye, FilePlus2, FileSpreadsheet, FlipHorizontal, FlipVertical, FolderOpen, Gauge, GripVertical, ImagePlus, Layers, LineChart,
  Magnet, MousePointer2, MoveUpRight, Pencil, RotateCcw, RotateCw, Ruler, ScanSearch, Settings2, Sparkles,
  Target, Trash2, Undo2, Redo2, Upload,
} from 'lucide-react'
import PlotCanvas from './components/PlotCanvas'
import ImagePreparationPanel from './components/ImagePreparationPanel'
import CloudProjects from './components/CloudProjects'
import DeleteProjectDialog from './components/DeleteProjectDialog'
import type { CloudProjectRow } from './lib/cloud-projects'
import type { RotationPreview } from './components/DeskewPanel'
import { detectPlotAxes, detectPlotGrid } from './lib/image-processing'
import type { DetectedAxes, DetectedPlotGrid, GridGuides } from './lib/image-processing'
import { ERASER_MAX_WIDTH, ERASER_MIN_WIDTH, ERASER_WIDTH, reconstructImage, reconstructionDimensions, renderReconstruction, renderReconstructionCurveLayer } from './lib/reconstruct'
import type { UpscaleSetting } from './lib/reconstruct'
import type { AxisGuides, Correction, CorrectionLayer, PlotRegion, Reconstruction, ReconstructionColors, ReconstructionWidths } from './lib/reconstruct'
import { axisName, calibrationFromDrafts, calibrationPointsFromGrid, csvHeader, datasetColor, downloadFile, pointToData, traceColor } from './lib/digitizer'
import { BRUSH_GROUPS, createBrushLearningMasks, createBrushMask, dilateBrushMask, extractBrushGroups } from './lib/painted-region'
import { proposeBrushedHealing, snapToCurve } from './lib/curve-healing'
import { mergeDatasets } from './lib/dataset-merge'
import { datasetRange, reorderById, reorderDatasets, updatePendingTrace } from './lib/dataset-order'
import type { PendingTrace } from './lib/dataset-order'
import { drawDatasets } from './lib/dataset-render'
import { rotationGeometry, rulerCorrection } from './lib/deskew'
import { createProjectWorkbook } from './lib/excel-export'
import type { WorkbookChart } from './lib/excel-export'
import { History } from './lib/history'
import { initialLearningModel } from './lib/learning'
import {
  createInteractionUpdatePayload, effectiveSampleStep, initialInteractionModel, learnFromHealingApplied,
  learnFromLayerComparison, learnFromPointAdded, learnFromPointDeleted, learnFromPointMoved,
  learnFromPointsSnapped, predictEnhancedLearningEdits, predictRichPixelScore, preferredHealingChoice,
  totalInteractionCount,
} from './lib/interaction-learning'
import type { InteractionModel } from './lib/interaction-learning'
import { insertPointInDataset, snapDatasetPointsToCurve } from './lib/point-tools'
import type { CurveImageSource, CurveSnapMode } from './lib/point-tools'
import { smartExtractCurvesFromLayer } from './lib/smart-extract'
import { createLocalLearningStore } from './lib/learning-store'
import { learningMasksToCorrections } from './lib/learning-edits'
import { createLearningExample } from './lib/learning-example'
import { createPaintLearningExample } from './lib/paint-learning'
import { readOnlineLearningConfig, syncOnlineLearning } from './lib/online-learning'
import { initialPointSpacingModel, pointSpacingTargets, trainPointSpacingModel } from './lib/point-spacing'
import type { PointSpacingModel } from './lib/point-spacing'
import type { LearningState, LearningStore } from './lib/learning-store'
import type { BrushMark } from './lib/painted-region'
import type { AxisCalibration, CalPoint, Dataset, DatasetKind, PixelPoint, PlotType, ScaleType, ToolMode } from './lib/digitizer'

declare global {
  interface Window { plotlineDesktop?: boolean }
}

type Notice = { message: string; type?: 'error' | 'success' }
type WorkflowStep = 'image' | 'calibration' | 'digitize'
type CompressorAxisVariable = 'flow' | 'head' | 'outletPressure' | 'pressureRatio' | 'efficiency' | 'speed' | 'igv' | 'custom'
type CompressorAxisConfig = { variable: CompressorAxisVariable; label: string; unit: string }
type CompressorAxes = { x: CompressorAxisConfig; y: CompressorAxisConfig }
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

const nextDatasetColor = (index: number, datasets: Dataset[]) => {
  const used = new Set(datasets.map((dataset) => dataset.color.toLowerCase()))
  let candidate = index
  while (used.has(datasetColor(candidate).toLowerCase())) candidate++
  return datasetColor(candidate)
}
const defaultDataset = (index: number, kind: DatasetKind = 'curve', existing: Dataset[] = []): Dataset => ({
  id: crypto.randomUUID(), name: kind === 'surge' ? 'Surge line' : kind === 'choke' ? 'Choke line' : kind === 'speed' ? `Speed line ${index}` : kind === 'efficiency' ? `Efficiency contour ${index}` : `Dataset ${index}`,
  color: nextDatasetColor(index, existing), kind, points: [],
  rpm: kind === 'speed' ? 10500 : undefined,
  speedUnit: kind === 'speed' ? 'RPM' : undefined,
  efficiencyValue: kind === 'efficiency' ? 80 : undefined,
})
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

interface ChartState {
  imageName: string
  imageUrl: string | null
  sourceImageUrl: string | null
  processedImageUrl: string | null
  processedPreviewUrl: string | null
  upscale: UpscaleSetting
  gridGuides: GridGuides
  axisGuides: AxisGuides
  regularGrid: boolean
  plotRegion: PlotRegion | null
  reconstruction: Reconstruction | null
  corrections: Correction[]
  reconstructionColors: ReconstructionColors
  reconstructionWidths: ReconstructionWidths
  eraserWidth: number
  drawWidth: number
  needsProcess: boolean
  imagePrepared: boolean
  plotType: PlotType
  datasets: Dataset[]
  activeId: string
  xAxis: AxisCalibration
  yAxis: AxisCalibration
  compressorAxes: CompressorAxes
  axisUnits: { x: string; y: string }
  calibrationConfirmed: boolean
  digitizeUnlocked: boolean
  calibrationDrafts: { x: string[]; y: string[] }
  calibrationScales: { x: ScaleType; y: ScaleType }
  workflowStep: WorkflowStep
  pointMarkerSize: number
  fourPointValues: FourPointValues
  xValue: string
  yValue: string
  mode: ToolMode
}

interface ChartRecord { id: string; name: string; state: ChartState }
interface ProjectSnapshot { name: string; activeId: string; charts: ChartRecord[] }

const blankChart = (): ChartState => ({
  imageName: 'Untitled plot', imageUrl: null, sourceImageUrl: null, processedImageUrl: null, processedPreviewUrl: null,
  upscale: { preset: 'hd', longEdge: 1920 }, gridGuides: { horizontal: [], vertical: [] },
  axisGuides: { horizontal: null, vertical: null }, regularGrid: true, plotRegion: null,
  reconstruction: null, corrections: [], reconstructionColors: { curve: '#0066ff', grid: '#000000', axis: '#000000' },
  reconstructionWidths: { curve: 1, grid: 1 }, eraserWidth: ERASER_WIDTH, drawWidth: 1,
  needsProcess: true, imagePrepared: false, plotType: 'xy', datasets: [], activeId: '',
  xAxis: blankAxis(), yAxis: blankAxis(), compressorAxes: defaultCompressorAxes,
  axisUnits: { x: '', y: '' }, calibrationConfirmed: false, digitizeUnlocked: false, workflowStep: 'image', pointMarkerSize: 100,
  calibrationDrafts: { x: [], y: [] }, calibrationScales: { x: 'linear', y: 'linear' },
  fourPointValues: initialFourPointValues, xValue: '0', yValue: '0', mode: 'select',
})

const sameChartContent = (a: ChartState, b: ChartState) =>
  (Object.keys(a) as (keyof ChartState)[]).every((key) =>
    key === 'activeId' || key === 'mode' || a[key] === b[key]
    || (key === 'datasets' && a.datasets.length === b.datasets.length && a.datasets.every((dataset, index) => dataset === b.datasets[index])))
const sameProjectContent = (a: ProjectSnapshot, b: ProjectSnapshot) =>
  a.name === b.name && a.charts.length === b.charts.length && a.charts.every((chart, index) =>
    chart.id === b.charts[index].id && chart.name === b.charts[index].name && sameChartContent(chart.state, b.charts[index].state))

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
  const [datasets, setDatasets] = useState<Dataset[]>([])
  const [activeId, setActiveId] = useState('')
  const [selectedDatasetIds, setSelectedDatasetIds] = useState<string[]>([])
  const [editingDatasetName, setEditingDatasetName] = useState<{ id: string; value: string } | null>(null)
  const [datasetDropTarget, setDatasetDropTarget] = useState<{ id: string; after: boolean } | null>(null)
  const [pointSelectionVersion, setPointSelectionVersion] = useState(0)
  const [selectedPointHint, setSelectedPointHint] = useState<{ datasetId: string; index: number; version: number } | null>(null)
  const [insertPointsByX, setInsertPointsByX] = useState(true)
  const [mode, setMode] = useState<ToolMode>('select')
  const [xAxis, setXAxis] = useState<AxisCalibration>(blankAxis())
  const [yAxis, setYAxis] = useState<AxisCalibration>(blankAxis())
  const [compressorAxes, setCompressorAxes] = useState<CompressorAxes>(defaultCompressorAxes)
  const [axisUnits, setAxisUnits] = useState({ x: '', y: '' })
  const [xValue, setXValue] = useState('0')
  const [yValue, setYValue] = useState('0')
  const [fourPointValues, setFourPointValues] = useState<FourPointValues>(initialFourPointValues)
  const [fourPointPixels, setFourPointPixels] = useState<PixelPoint[]>([])
  const [calibrationPhase, setCalibrationPhase] = useState<'points' | 'values'>('points')
  const [calibrationDrafts, setCalibrationDrafts] = useState<{ x: string[]; y: string[] }>({ x: [], y: [] })
  const [calibrationScales, setCalibrationScales] = useState<{ x: ScaleType; y: ScaleType }>({ x: 'linear', y: 'linear' })
  const [notice, setNotice] = useState<Notice | null>(null)
  const [tolerance, setTolerance] = useState(76)
  const [sampleStep, setSampleStep] = useState(20)
  const [traceBrushWidth, setTraceBrushWidth] = useState(24)
  const [brushGroup, setBrushGroup] = useState(BRUSH_GROUPS[0].color)
  const [pointMarkerSize, setPointMarkerSize] = useState(100)
  const [brushMarks, setBrushMarks] = useState<BrushMark[]>([])
  const [brushErasing, setBrushErasing] = useState(false)
  const [pendingTrace, setPendingTrace] = useState<PendingTrace | null>(null)
  const [workflowStep, setWorkflowStep] = useState<WorkflowStep>('image')
  const [calibrationMarkerColor, setCalibrationMarkerColor] = useState('#36d399')
  const [calibrationConfirmed, setCalibrationConfirmed] = useState(false)
  const [digitizeUnlocked, setDigitizeUnlocked] = useState(false)
  const [sortBy, setSortBy] = useState<'x' | 'y'>('x')
  const [precision, setPrecision] = useState(6)
  const [seedColor, setSeedColor] = useState<[number, number, number]>([72, 215, 191])
  const [activePanel, setActivePanel] = useState<'data' | 'settings'>('data')
  const [imageDisplayMode, setImageDisplayMode] = useState<'fit' | 'original'>('fit')
  const [showTable, setShowTable] = useState(false)
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportMenuOpen, setExportMenuOpen] = useState(false)
  const [learningLoading, setLearningLoading] = useState(true)
  const [learningWorking, setLearningWorking] = useState(false)
  const [learningState, setLearningState] = useState<LearningState | null>(null)
  const [pointSpacingModel, setPointSpacingModel] = useState<PointSpacingModel>(initialPointSpacingModel)
  const [interactionModel, setInteractionModel] = useState<InteractionModel>(initialInteractionModel)
  const [learningError, setLearningError] = useState<string | null>(null)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [pendingUpdates, setPendingUpdates] = useState(0)
  const [lastComparison, setLastComparison] = useState<[number, number, number, number] | null>(null)
  const [syncing, setSyncing] = useState(false)
  const onlineConfiguration = useMemo(() => {
    try { return { config: readOnlineLearningConfig(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY), error: null } }
    catch (error) { return { config: null, error: error instanceof Error ? error.message : 'Invalid Supabase configuration.' } }
  }, [])
  const [projectName, setProjectName] = useState('Untitled project')
  const [charts, setCharts] = useState<ChartRecord[]>(() => [{ id: crypto.randomUUID(), name: 'Chart 1', state: blankChart() }])
  const [activeChartId, setActiveChartId] = useState(() => charts[0].id)
  const [editingChartName, setEditingChartName] = useState<{ id: string; value: string } | null>(null)
  const [draggingChartId, setDraggingChartId] = useState<string | null>(null)
  const [chartDropTarget, setChartDropTarget] = useState<{ id: string; after: boolean } | null>(null)
  const [cloudOpen, setCloudOpen] = useState(false)
  const [cloudResetKey, setCloudResetKey] = useState(0)
  const [activeCloudProject, setActiveCloudProject] = useState<CloudProjectRow | null>(null)
  const [deleteProjectOpen, setDeleteProjectOpen] = useState(false)
  const [deletingProject, setDeletingProject] = useState(false)
  const [deleteProjectError, setDeleteProjectError] = useState('')
  const [historyAvailability, setHistoryAvailability] = useState({ undo: false, redo: false })
  const imageInput = useRef<HTMLInputElement>(null)
  const projectInput = useRef<HTMLInputElement>(null)
  const deleteActiveCloudRef = useRef<((target: CloudProjectRow) => Promise<void>) | null>(null)
  const registerDeleteActive = useCallback((fn: ((target: CloudProjectRow) => Promise<void>) | null) => {
    deleteActiveCloudRef.current = fn
  }, [])
  const chartTabList = useRef<HTMLDivElement>(null)
  const exportMenu = useRef<HTMLDivElement>(null)
  const exportMenuButton = useRef<HTMLButtonElement>(null)
  const openImageRef = useRef<(file?: File) => void>(() => undefined)
  const processingRun = useRef(0)
  const draggedChartId = useRef<string | null>(null)
  const draggedDatasetId = useRef<string | null>(null)
  const datasetSelectionAnchor = useRef<string | null>(null)
  const brushTraceIds = useRef<string[]>([])
  const history = useRef<History<ProjectSnapshot> | null>(null)
  const learningStore = useRef<LearningStore | null>(null)
  const pointTrainingBaselines = useRef<Record<string, PixelPoint[]>>({})
  const learningStateRef = useRef<LearningState | null>(null)
  const interactionModelRef = useRef<InteractionModel>(initialInteractionModel())
  const interactionPixelsCache = useRef<{ key: string; pixels: { width: number; height: number; source: Uint8ClampedArray; automatic: Uint8ClampedArray; gridLines: { horizontal: number[]; vertical: number[] } } } | null>(null)
  const learningWorkRef = useRef(false)
  const syncRef = useRef<Promise<void> | null>(null)
  const latestProject = useRef<ProjectSnapshot | null>(null)
  const ownedUrls = useRef(new Set<string>())
  const pinnedUrls = useRef(new Set<string>())
  const pointerTransaction = useRef(false)
  const pointerRecorded = useRef(false)
  const activateDataset = (id: string) => {
    setActiveId(id)
    setSelectedDatasetIds(id ? [id] : [])
    datasetSelectionAnchor.current = id || null
    setEditingDatasetName(null)
  }

  const chartState: ChartState = {
    imageName, imageUrl, sourceImageUrl, processedImageUrl, processedPreviewUrl, upscale, gridGuides, axisGuides,
    regularGrid, plotRegion, reconstruction, corrections, reconstructionColors, reconstructionWidths, eraserWidth,
    drawWidth, needsProcess, imagePrepared, plotType, datasets, activeId, xAxis, yAxis, compressorAxes,
    axisUnits, calibrationConfirmed, digitizeUnlocked, calibrationDrafts, calibrationScales, workflowStep, pointMarkerSize, fourPointValues, xValue, yValue, mode,
  }
  const currentProject = (): ProjectSnapshot => ({
    name: projectName, activeId: activeChartId,
    charts: charts.map((chart) => chart.id === activeChartId ? { ...chart, state: chartState } : chart),
  })

  const applyChartState = (state: ChartState) => {
    processingRun.current++
    brushTraceIds.current = []
    setImageName(state.imageName); setImageUrl(state.imageUrl); setSourceImageUrl(state.sourceImageUrl)
    setProcessedImageUrl(state.processedImageUrl); setProcessedPreviewUrl(state.processedPreviewUrl)
    setUpscale(state.upscale); setCustomLongEdge(String(state.upscale.longEdge))
    setGridGuides(state.gridGuides); setAxisGuides(state.axisGuides); setRegularGrid(state.regularGrid)
    setPlotRegion(state.plotRegion); setReconstruction(state.reconstruction); setCorrections(state.corrections)
    setReconstructionColors(state.reconstructionColors); setReconstructionWidths(state.reconstructionWidths)
    setEraserWidth(state.eraserWidth); setDrawWidth(state.drawWidth); setNeedsProcess(state.needsProcess)
    setImagePrepared(state.imagePrepared); setPlotType(state.plotType); setDatasets(state.datasets)
    setXAxis(state.xAxis); setYAxis(state.yAxis); setCompressorAxes(state.compressorAxes); setAxisUnits(state.axisUnits)
    setCalibrationConfirmed(state.calibrationConfirmed); setDigitizeUnlocked(state.digitizeUnlocked); setWorkflowStep(state.workflowStep)
    setPointMarkerSize(state.pointMarkerSize); setBrushMarks([]); setFourPointValues(state.fourPointValues)
    setXValue(state.xValue); setYValue(state.yValue)
    setMode(state.workflowStep === 'calibration' ? 'calibrate-edit' : state.mode); activateDataset(state.activeId)
    setAxisDetection(null); setGridDetection(null); setFourPointPixels([]); setBrushErasing(false)
    setCalibrationPhase(state.calibrationConfirmed ? 'values' : 'points')
    setCalibrationDrafts(state.calibrationDrafts)
    setCalibrationScales(state.calibrationScales)
    setShowOriginalPreview(false); setShowBackground(true); setRotationPreview(null)
    setSelectedPointHint(null)
    interactionPixelsCache.current = null
    setPointSelectionVersion((version) => version + 1)
  }

  const applyProject = (snapshot: ProjectSnapshot) => {
    const active = snapshot.charts.find((chart) => chart.id === snapshot.activeId)
    if (!active) throw new Error('The active chart was not found.')
    setProjectName(snapshot.name); setCharts(snapshot.charts); setActiveChartId(snapshot.activeId)
    setEditingChartName(null); setPendingTrace(null); applyChartState(active.state)
  }

  useLayoutEffect(() => {
    const snapshot = currentProject()
    latestProject.current = snapshot
    if (pendingTrace || learningWorking) return
    if (!history.current) history.current = new History(snapshot)
    else if (!sameProjectContent(history.current.current, snapshot)) {
      history.current.record(snapshot, pointerTransaction.current && pointerRecorded.current)
      if (pointerTransaction.current) pointerRecorded.current = true
    } else history.current.replace({ ...snapshot, activeId: history.current.current.activeId })
    const available = { undo: history.current.canUndo, redo: history.current.canRedo }
    setHistoryAvailability((previous) => previous.undo === available.undo && previous.redo === available.redo ? previous : available)
    const referenced = new Set(history.current.snapshots.flatMap((entry) => entry.charts.flatMap(({ state }) => [state.imageUrl, state.sourceImageUrl])))
    for (const url of pinnedUrls.current) referenced.add(url)
    for (const url of ownedUrls.current) {
      if (!referenced.has(url)) { URL.revokeObjectURL(url); ownedUrls.current.delete(url) }
    }
  })

  useEffect(() => {
    const urls = ownedUrls.current
    return () => { for (const url of urls) URL.revokeObjectURL(url); urls.clear() }
  }, [])

  useEffect(() => {
    chartTabList.current?.querySelector('[role="tab"][aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeChartId])

  useEffect(() => {
    const finish = () => { pointerTransaction.current = false; pointerRecorded.current = false }
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    return () => { window.removeEventListener('pointerup', finish); window.removeEventListener('pointercancel', finish) }
  }, [])

  useEffect(() => {
    if (!exportMenuOpen) return
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !exportMenu.current?.contains(event.target)) setExportMenuOpen(false)
    }
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); setExportMenuOpen(false); exportMenuButton.current?.focus() }
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', handleKey)
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', handleKey) }
  }, [exportMenuOpen])

  useEffect(() => { setBrushMarks([]) }, [imageUrl, sourceImageUrl])
  useEffect(() => { setRotationPreview(null) }, [sourceImageUrl])
  useEffect(() => { setHealMark(null); setHealOptions([]); setHealChoice(0) }, [mode, reconstruction, corrections, correctionLayer])

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (pendingTrace || cloudOpen || deleteProjectOpen) return
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key === 'Escape') setMode('select')
      if (workflowStep === 'digitize' && event.key.toLowerCase() === 'p') setMode('point')
      if (workflowStep === 'digitize' && event.key.toLowerCase() === 'a') setMode('trace-region')
      if (workflowStep === 'digitize' && event.key.toLowerCase() === 'm') setMode('point-edit')
      if (workflowStep === 'calibration' && calibrationPhase === 'points' && event.key.toLowerCase() === 'c') setMode('calibrate-edit')
    }
    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [workflowStep, calibrationPhase, pendingTrace, learningWorking, cloudOpen, deleteProjectOpen])

  const activeDataset = datasets.find((dataset) => dataset.id === activeId) ?? datasets[0]
  const learnedSampleStep = effectiveSampleStep(sampleStep, pointSpacingModel.factor, interactionModel)
  const showGuides = needsProcess || mode === 'grid-horizontal' || mode === 'grid-vertical' || mode === 'guide-axis-x' || mode === 'guide-axis-y' || mode === 'prep-region'
  const totalPoints = datasets.reduce((sum, dataset) => sum + dataset.points.length, 0)
  const calibrated = calibrationConfirmed && xAxis.points.length >= 2 && yAxis.points.length >= 2
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

  useEffect(() => {
    let active = true
    if (!learningStore.current) learningStore.current = createLocalLearningStore()
    Promise.all([
      learningStore.current.load(),
      learningStore.current.pendingSamples(),
      learningStore.current.loadPointSpacingModel(),
      learningStore.current.loadInteractionModel(),
    ]).then(([state, pending, spacingModel, loadedInteraction]) => {
      if (active) {
        learningStateRef.current = state; setLearningState(state)
        setPendingUpdates(pending.length); setPointSpacingModel(spacingModel)
        interactionModelRef.current = loadedInteraction; setInteractionModel(loadedInteraction)
        setLearningError(null)
      }
    }).catch((error: unknown) => {
      if (active) {
        const message = error instanceof Error ? error.message : 'Could not load local learning data.'
        setLearningError(message); showNotice(message, 'error')
      }
    }).finally(() => { if (active) setLearningLoading(false) })
    return () => { active = false }
  }, [])

  const persistInteractionUpdate = (updater: (current: InteractionModel) => InteractionModel, healingChoice?: number) => {
    if (!learningStateRef.current?.enabled) return
    const current = interactionModelRef.current
    const next = updater(current)
    if (next === current) return
    interactionModelRef.current = next
    setInteractionModel(next)
    const store = learningStore.current
    if (!store) return
    const config = onlineConfiguration.config
    const payload = config ? createInteractionUpdatePayload(current, next, healingChoice) : null
    if (config && payload) {
      const sample = {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        delta: [],
        updateId: crypto.randomUUID(),
        status: 'pending' as const,
        target: config.url,
        interactionUpdate: payload,
      }
      void store.saveInteractionSample(sample, next)
        .then(() => store.pendingSamples())
        .then((pending) => setPendingUpdates(pending.length))
        .catch(() => undefined)
    } else {
      void store.saveInteractionModel(next).catch(() => undefined)
    }
  }

  const getInteractionPixels = async (): Promise<{ width: number; height: number; source: Uint8ClampedArray; automatic: Uint8ClampedArray; gridLines: { horizontal: number[]; vertical: number[] } } | undefined> => {
    if (!sourceImageUrl || !reconstruction || needsProcess) return undefined
    if (reconstruction.width * reconstruction.height > 4_000_000) return undefined
    const key = `${sourceImageUrl}|${reconstruction.width}x${reconstruction.height}|${reconstruction.curves.length}|${reconstruction.horizontal.length}x${reconstruction.vertical.length}|${reconstructionWidths.curve}`
    if (interactionPixelsCache.current?.key === key) return interactionPixelsCache.current.pixels
    try {
      const source = new Image()
      source.src = sourceImageUrl
      await source.decode()
      if (source.naturalWidth !== reconstruction.width || source.naturalHeight !== reconstruction.height) return undefined
      const sourceCanvas = document.createElement('canvas')
      sourceCanvas.width = reconstruction.width
      sourceCanvas.height = reconstruction.height
      const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true })
      const autoLayer = renderReconstructionCurveLayer({ ...reconstruction, learnedCorrections: [] }, [], reconstructionWidths)
      const autoContext = autoLayer.getContext('2d', { willReadFrequently: true })
      if (!sourceContext || !autoContext) return undefined
      sourceContext.drawImage(source, 0, 0)
      const pixels = {
        width: reconstruction.width,
        height: reconstruction.height,
        source: sourceContext.getImageData(0, 0, reconstruction.width, reconstruction.height).data,
        automatic: autoContext.getImageData(0, 0, reconstruction.width, reconstruction.height).data,
        gridLines: { horizontal: reconstruction.horizontal, vertical: reconstruction.vertical },
      }
      interactionPixelsCache.current = { key, pixels }
      return pixels
    } catch {
      return undefined
    }
  }

  const synchronizeLearning = () => {
    const config = onlineConfiguration.config
    const store = learningStore.current
    if (!config || !store || !learningStateRef.current?.enabled || learningWorkRef.current || syncRef.current) return
    setSyncing(true)
    const operation = syncOnlineLearning(store, config).then(({ model, pointSpacingModel, interactionModel: syncedInteraction, pending }) => {
      const current = learningStateRef.current
      if (current) { const state = { ...current, model }; learningStateRef.current = state; setLearningState(state) }
      setPointSpacingModel(pointSpacingModel)
      interactionModelRef.current = syncedInteraction
      setInteractionModel(syncedInteraction)
      setPendingUpdates(pending); setSyncError(null)
    }).catch(async (error: unknown) => {
      setSyncError(error instanceof Error ? error.message : 'Could not synchronize learning updates.')
      try { setPendingUpdates((await store.pendingSamples()).length) }
      catch (storageError) { setLearningError(storageError instanceof Error ? storageError.message : 'Could not read the learning queue.') }
    }).finally(() => { syncRef.current = null; setSyncing(false) })
    syncRef.current = operation
  }

  useEffect(() => {
    if (!learningState?.enabled || !onlineConfiguration.config) return
    synchronizeLearning()
    const timer = window.setInterval(synchronizeLearning, 30000)
    window.addEventListener('online', synchronizeLearning)
    return () => { window.clearInterval(timer); window.removeEventListener('online', synchronizeLearning) }
  }, [learningState?.enabled, onlineConfiguration.config, pendingUpdates])

  const projectBusy = Boolean(pendingTrace || rotationPreview || preprocessing || loading || gridDetecting || exporting || deletingProject || learningLoading || learningWorking)
  const changeHistory = (direction: 'undo' | 'redo') => {
    if (projectBusy || !history.current) return
    const snapshot = direction === 'undo' ? history.current.undo() : history.current.redo()
    if (!snapshot) return
    pointerTransaction.current = false; pointerRecorded.current = false
    applyProject(snapshot)
    setHistoryAvailability({ undo: history.current.canUndo, redo: history.current.canRedo })
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      if (cloudOpen || deleteProjectOpen || !(event.ctrlKey || event.metaKey) || event.altKey || target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
        || (target instanceof HTMLElement && target.isContentEditable)) return
      const key = event.key.toLowerCase()
      if (key !== 'z' && key !== 'y') return
      event.preventDefault()
      changeHistory(key === 'y' || event.shiftKey ? 'redo' : 'undo')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  const switchChart = (id: string) => {
    if (projectBusy || id === activeChartId) return
    const snapshot = currentProject()
    const target = snapshot.charts.find((chart) => chart.id === id)
    if (!target) return
    setCharts(snapshot.charts); setActiveChartId(id); setEditingChartName(null)
    applyChartState(target.state)
  }

  const addChart = () => {
    if (projectBusy) return
    const snapshot = currentProject()
    let number = snapshot.charts.length + 1
    while (snapshot.charts.some((chart) => chart.name.toLowerCase() === `chart ${number}`)) number++
    const next = { id: crypto.randomUUID(), name: `Chart ${number}`, state: blankChart() }
    setCharts([...snapshot.charts, next]); setActiveChartId(next.id); setEditingChartName(null)
    applyChartState(next.state)
  }

  const deleteChart = (id: string) => {
    if (projectBusy || charts.length < 2) return
    const snapshot = currentProject()
    const chart = snapshot.charts.find((item) => item.id === id)
    if (!chart || !window.confirm(`Delete chart "${chart.name}" and its data? You can undo this action.`)) return
    const remaining = snapshot.charts.filter((item) => item.id !== id)
    setCharts(remaining); setEditingChartName(null)
    if (id === activeChartId) {
      const next = remaining[Math.min(snapshot.charts.findIndex((item) => item.id === id), remaining.length - 1)]
      setActiveChartId(next.id); applyChartState(next.state)
    }
  }

  const saveChartName = () => {
    if (!editingChartName) return
    const name = editingChartName.value.trim()
    if (!name) { showNotice('Chart name cannot be empty.', 'error'); return }
    setCharts((current) => current.map((chart) => chart.id === editingChartName.id ? { ...chart, name } : chart))
    setEditingChartName(null)
  }

  const reorderChartTabs = (draggedId: string, targetId: string, after: boolean) => {
    if (projectBusy || charts.length < 2 || draggedId === targetId) return
    const snapshot = currentProject()
    const reordered = reorderById(snapshot.charts, draggedId, targetId, after)
    if (reordered !== snapshot.charts) setCharts(reordered)
  }

  const moveChartTab = (id: string, direction: -1 | 1) => {
    if (projectBusy || charts.length < 2) return
    const index = charts.findIndex((chart) => chart.id === id)
    const target = charts[index + direction]
    if (target) reorderChartTabs(id, target.id, direction > 0)
  }

  const openImage = (file?: File) => {
    if (!file || learningWorking) return
    if (pendingTrace) { showNotice('Confirm or discard the new points before replacing the image.', 'error'); return }
    if (!file.type.startsWith('image/')) { showNotice('Choose a supported image file.', 'error'); return }
    if (file.size > 35 * 1024 * 1024) { showNotice('Images must be smaller than 35 MB.', 'error'); return }
    processingRun.current++; setPreprocessing(false)
    const nextUrl = URL.createObjectURL(file)
    ownedUrls.current.add(nextUrl)
    setImageUrl(nextUrl); setSourceImageUrl(nextUrl)
    setProcessedImageUrl(null); setProcessedPreviewUrl(null); setShowOriginalPreview(false); setShowBackground(true); setImagePrepared(false); setAxisDetection(null); setGridDetection(null); setGridGuides({ horizontal: [], vertical: [] })
    setPlotRegion(null); setAxisGuides({ horizontal: null, vertical: null }); setRegularGrid(true); setReconstruction(null); setCorrections([]); setNeedsProcess(true)
    setImageName(file.name.replace(/\.[^.]+$/, '') || 'Untitled plot')
    setXAxis(blankAxis()); setYAxis(blankAxis()); setDatasets([]); activateDataset('')
    setCompressorAxes(defaultCompressorAxes); setAxisUnits({ x: '', y: '' }); setDigitizeUnlocked(false)
    setFourPointPixels([])
    setCalibrationPhase('points'); setCalibrationDrafts({ x: [], y: [] }); setCalibrationScales({ x: 'linear', y: 'linear' })
    setWorkflowStep('image'); setCalibrationConfirmed(false); setBrushErasing(false)
    setMode('select')
  }

  openImageRef.current = openImage

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      if (cloudOpen || deleteProjectOpen) return
      const imageItem = Array.from(event.clipboardData?.items ?? []).find((item) => item.type.startsWith('image/'))
      const file = imageItem?.getAsFile()
      if (!file) return
      event.preventDefault()
      openImageRef.current(file)
    }
    window.addEventListener('paste', handlePaste)
    return () => window.removeEventListener('paste', handlePaste)
  }, [cloudOpen, deleteProjectOpen])

  const processImage = async () => {
    if (!sourceImageUrl || preprocessing || learningWorking) return
    const run = ++processingRun.current
    setPreprocessing(true)
    try {
      const result = await reconstructImage(sourceImageUrl, plotRegion, gridGuides, corrections, reconstructionColors, reconstructionWidths, { regularGrid, axisGuides })
      if (run !== processingRun.current) return
      let output = result.dataUrl
      let warning: string | null = null
      if (learningState?.enabled && (learningState.model.samples > 0 || interactionModelRef.current.featureSamples > 0)) {
        try {
          const layer = renderReconstructionCurveLayer(result.geometry, [], reconstructionWidths)
          const context = layer.getContext('2d', { willReadFrequently: true })
          if (!context) throw new Error('Could not read the automatic curve layer.')
          const prediction = predictEnhancedLearningEdits(learningState.model, interactionModelRef.current, {
            width: layer.width, height: layer.height, source: result.sourcePixels.data,
            automatic: context.getImageData(0, 0, layer.width, layer.height).data, region: result.geometry.region,
            gridLines: { horizontal: result.geometry.horizontal, vertical: result.geometry.vertical },
          })
          result.geometry.learnedCorrections = learningMasksToCorrections(prediction.add, prediction.erase, layer.width, layer.height)
          output = renderReconstruction(result.geometry, corrections, reconstructionColors, reconstructionWidths)
        } catch (error) {
          result.geometry.learnedCorrections = []
          warning = error instanceof Error ? error.message : 'Local prediction failed; the automatic result was kept.'
        }
      }
      const preview = renderUpscaled(result.geometry, corrections, reconstructionColors, reconstructionWidths, upscale, output)
      setImageUrl(output); setProcessedImageUrl(output); setShowOriginalPreview(false)
      setProcessedPreviewUrl(preview)
      setReconstruction(result.geometry); setNeedsProcess(false); setShowBackground(true)
      setAxisDetection(null); setGridDetection(null); setCalibrationConfirmed(false); setImagePrepared(false); setMode('select')
      showNotice(warning ?? `Rebuilt ${result.geometry.horizontal.length} horizontal and ${result.geometry.vertical.length} vertical lines and ${result.geometry.curves.length} curve fragments. Inspect the result against the original.`, warning ? 'error' : 'success')
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
      persistInteractionUpdate((current) => learnFromHealingApplied(current, healChoice), healChoice)
      setHealMark(null); setHealOptions([]); setShowOriginalPreview(false)
      showNotice('Connection applied. Inspect it against the original; use Undo if needed.')
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
    if (widths.curve !== reconstructionWidths.curve && drawWidth === reconstructionWidths.curve) setDrawWidth(widths.curve)
    setReconstructionColors(colors); setReconstructionWidths(widths)
  }

  const confirmPreparedImage = async () => {
    if (learningWorking || learningWorkRef.current || preprocessing) return
    if (learningState?.enabled && reconstruction && sourceImageUrl && corrections.length && !needsProcess) {
      const store = learningStore.current
      if (!store) { showNotice('Local learning storage is unavailable.', 'error'); return }
      learningWorkRef.current = true
      setLearningWorking(true)
      showNotice('Saving the numeric learning update…')
      try {
        if (syncRef.current) await syncRef.current
        const state = learningStateRef.current
        if (!state?.enabled) throw new Error('Learning is disabled.')
        const example = await createLearningExample(sourceImageUrl, reconstruction, corrections, reconstructionWidths, state.model)
        if (!(await store.hasSample(example.sample.id))) {
          if (onlineConfiguration.config && example.updated) {
            example.sample.updateId = crypto.randomUUID(); example.sample.status = 'pending'
            example.sample.target = onlineConfiguration.config.url
          }
          await store.saveSample(example.sample, example.model)
          const nextState = { ...state, model: example.model }
          learningStateRef.current = nextState; setLearningState(nextState)
          if (example.updated) {
            const beforeInteraction = interactionModelRef.current
            const nextInteraction = learnFromLayerComparison(beforeInteraction, example.pixels, example.corrected, 'reconstruction')
            interactionModelRef.current = nextInteraction; setInteractionModel(nextInteraction)
            const interactionPayload = onlineConfiguration.config ? createInteractionUpdatePayload(beforeInteraction, nextInteraction) : null
            if (onlineConfiguration.config && interactionPayload) {
              await store.saveInteractionSample({
                id: crypto.randomUUID(), createdAt: new Date().toISOString(), delta: [],
                updateId: crypto.randomUUID(), status: 'pending', target: onlineConfiguration.config.url,
                interactionUpdate: interactionPayload,
              }, nextInteraction)
            } else {
              await store.saveInteractionModel(nextInteraction)
            }
          }
          if (onlineConfiguration.config && example.updated) setPendingUpdates((await store.pendingSamples()).length)
          showNotice(example.updated ? onlineConfiguration.config ? 'Image confirmed; numeric update saved for Supabase synchronization.' : 'Image confirmed and local curve model updated.' : 'Image confirmed. No curve edits were available to update the model.')
        } else showNotice('Image confirmed. This learning sample was already saved.')
        if (example.sample.comparison) setLastComparison(example.sample.comparison.counts)
      } catch (error) {
        showNotice(error instanceof Error ? `Local learning failed: ${error.message}` : 'Local learning failed. Retry or disable learning before confirming.', 'error')
        return
      } finally { learningWorkRef.current = false; setLearningWorking(false) }
    } else if (learningError) {
      showNotice(`Image confirmed, but learning storage is unavailable: ${learningError}`, 'error')
    } else {
      showNotice('Image confirmed. Continue by calibrating the axes.')
    }
    if (showOriginalPreview && processedImageUrl) setShowOriginalPreview(false)
    setImagePrepared(true)
    setWorkflowStep('calibration')
    setCalibrationPhase('points')
    setMode('calibrate-edit')
  }

  const setLearningEnabled = async (enabled: boolean) => {
    if (!learningStore.current || !learningState || learningWorking || syncing) return
    learningWorkRef.current = true
    setLearningWorking(true)
    try {
      await learningStore.current.setEnabled(enabled)
      const nextState = { ...learningState, enabled }
      learningStateRef.current = nextState; setLearningState(nextState)
      showNotice(enabled ? 'Learning enabled.' : 'Learning disabled. Existing data was kept.')
    } catch (error) {
      showNotice(error instanceof Error ? `Could not change local learning: ${error.message}` : 'Could not change local learning.', 'error')
    } finally { learningWorkRef.current = false; setLearningWorking(false) }
  }

  const clearLearning = async () => {
    if (!learningStore.current || !learningState || learningWorking || syncing) return
    if (!window.confirm('Delete all local learning data, including any older saved images and pending updates? Shared online updates cannot be deleted here.')) return
    learningWorkRef.current = true
    setLearningWorking(true)
    try {
      await learningStore.current.clear()
      const nextState = { ...learningState, model: initialLearningModel() }
      learningStateRef.current = nextState; setLearningState(nextState); setPendingUpdates(0); setLastComparison(null)
      setPointSpacingModel(initialPointSpacingModel()); pointTrainingBaselines.current = {}
      const resetInteraction = initialInteractionModel()
      interactionModelRef.current = resetInteraction; setInteractionModel(resetInteraction)
      showNotice('Local learning data deleted.')
    } catch (error) {
      showNotice(error instanceof Error ? `Could not delete local learning data: ${error.message}` : 'Could not delete local learning data.', 'error')
    } finally { learningWorkRef.current = false; setLearningWorking(false) }
  }

  const detectAxes = async () => {
    if (!imageUrl) return
    const run = processingRun.current
    setGridDetecting(true)
    try {
      const detected = await detectPlotAxes(imageUrl)
      if (run !== processingRun.current) return
      if (!detected) { showNotice('Could not confidently find the bottom and left axes. Try cropping the chart or adjust the scan first.', 'error'); return }
      setAxisDetection(detected)
      const origin: CalPoint = { ...detected.intersection, value: 1 }
      const yOrigin: CalPoint = { ...detected.intersection, value: 1 }
      setXAxis((current) => ({ ...current, points: [origin, ...current.points.slice(1)] }))
      setYAxis((current) => ({ ...current, points: [yOrigin, ...current.points.slice(1)] }))
      setCalibrationDrafts((current) => ({ x: ['', ...current.x.slice(1)], y: ['', ...current.y.slice(1)] }))
      setCalibrationConfirmed(false)
      setMode('calibrate-x')
      showNotice('Axes located near the lower and left edges. Their intersection was added as the first X/Y calibration point; verify it against the chart.')
    } catch { if (run === processingRun.current) showNotice('Axis detection failed while reading this image.', 'error') }
    finally { setGridDetecting(false) }
  }

  const calibrateFromDetectedGrid = async () => {
    if (!imageUrl) return
    const run = processingRun.current
    setGridDetecting(true)
    try {
      const detected = await detectPlotGrid(imageUrl)
      if (run !== processingRun.current) return
      if (!detected) {
        setGridDetection(null)
        showNotice('Could not find at least two clear horizontal and vertical grid lines. Try cleaning or cropping the image.', 'error')
        return
      }

      const points = calibrationPointsFromGrid(detected)
      setXAxis((current) => ({ ...current, points: points.x }))
      setYAxis((current) => ({ ...current, points: points.y }))
      setCalibrationConfirmed(false)
      setCalibrationDrafts({ x: ['', ''], y: ['', ''] })
      setGridDetection(detected)
      setMode('calibrate-edit')
      showNotice(`Detected ${detected.verticalLines.length} vertical and ${detected.horizontalLines.length} horizontal grid lines. Check the highlighted calibration points and adjust them if needed.`)
    } catch {
      if (run === processingRun.current) showNotice('Grid detection failed while reading this image.', 'error')
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
  const updateCompressorAxis = (axis: 'x' | 'y', patch: Partial<CompressorAxisConfig>) => setCompressorAxes((current) => ({
    ...current,
    [axis]: { ...current[axis], ...patch },
  }))

  const addDataset = (kind?: DatasetKind) => {
    const selectedKind = kind ?? (plotType === 'compressor' ? 'speed' : 'curve')
    const next = defaultDataset(datasets.length + 1, selectedKind, datasets)
    setDatasets((current) => [...current, next])
    activateDataset(next.id)
    setMode(selectedKind === 'surge' ? 'surge' : selectedKind === 'choke' ? 'choke' : selectedKind === 'speed' ? 'speed' : selectedKind === 'efficiency' ? 'trace-region' : 'point')
  }

  const selectDataset = (dataset: Dataset, additive: boolean, range: boolean) => {
    setEditingDatasetName(null)
    const selectable = pendingTrace ? datasets.filter((item) => pendingTrace.ids.includes(item.id)) : datasets
    const canMultiSelect = !pendingTrace || pendingTrace.ids.includes(dataset.id)
    if (range && canMultiSelect) {
      const anchorId = datasetSelectionAnchor.current && selectable.some((item) => item.id === datasetSelectionAnchor.current)
        ? datasetSelectionAnchor.current
        : activeId
      const rangeIds = datasetRange(selectable, anchorId, dataset.id)
      if (rangeIds.length) {
        setSelectedDatasetIds((current) => additive ? [...new Set([...current.filter((id) => selectable.some((item) => item.id === id)), ...rangeIds])] : rangeIds)
        setActiveId(dataset.id)
        return
      }
    }
    if (additive && canMultiSelect) {
      const current = selectedDatasetIds.filter((id) => selectable.some((item) => item.id === id))
      const selected = current.includes(dataset.id)
      datasetSelectionAnchor.current = dataset.id
      if (selected && current.length === 1) return
      const next = selected ? current.filter((id) => id !== dataset.id) : [...current, dataset.id]
      setSelectedDatasetIds(next)
      if (!selected || activeId === dataset.id) setActiveId(selected ? next[next.length - 1] : dataset.id)
      return
    }
    activateDataset(dataset.id)
    if (!pendingTrace && mode !== 'point-edit') setMode(dataset.kind === 'surge' ? 'surge' : dataset.kind === 'choke' ? 'choke' : dataset.kind === 'speed' ? 'speed' : dataset.kind === 'efficiency' && plotType === 'compressor' ? 'trace-region' : 'point')
  }

  const mergeSelectedDatasets = () => {
    if (pendingTrace && selectedDatasetIds.some((id) => !pendingTrace.ids.includes(id))) return
    try {
      const selected = datasets.filter((dataset) => selectedDatasetIds.includes(dataset.id))
      const merged = mergeDatasets(selected, activeId)
      if (!window.confirm(`Merge ${selected.length} datasets into "${merged.name}"? The selected datasets will be replaced. Check the resulting connections afterwards.`)) return
      const updatedPending = pendingTrace ? updatePendingTrace(pendingTrace, selectedDatasetIds, merged) : null
      setDatasets((current) => current.flatMap((dataset) => dataset.id === merged.id ? [merged] : selectedDatasetIds.includes(dataset.id) ? [] : [dataset]))
      if (pendingTrace) setPendingTrace(updatedPending)
      activateDataset(merged.id)
      setPointSelectionVersion((version) => version + 1)
      if (!pendingTrace) setMode('point-edit')
      showNotice(`Merged ${selected.length} datasets into ${merged.name}. Check the joined points.`)
    } catch (error) {
      showNotice(error instanceof Error ? error.message : 'Could not merge the selected datasets.', 'error')
    }
  }

  const deleteSelectedDatasets = () => {
    if (selectedDatasetIds.length < 2 || (pendingTrace && selectedDatasetIds.some((id) => !pendingTrace.ids.includes(id)))) return
    const remaining = datasets.filter((dataset) => !selectedDatasetIds.includes(dataset.id))
    const message = remaining.length
      ? `Delete ${selectedDatasetIds.length} selected datasets and all their points?`
      : `Delete all ${selectedDatasetIds.length} selected datasets and their points?`
    if (!window.confirm(message)) return
    const updatedPending = pendingTrace ? updatePendingTrace(pendingTrace, selectedDatasetIds) : null
    setDatasets(remaining)
    for (const id of selectedDatasetIds) delete pointTrainingBaselines.current[id]
    if (pendingTrace) {
      if (updatedPending) {
        setPendingTrace(updatedPending)
        activateDataset(updatedPending.ids[0])
      } else {
        setPendingTrace(null)
        activateDataset(pendingTrace.previousActiveId)
        setMode('trace-region')
      }
    } else activateDataset(remaining[0]?.id ?? '')
    setPointSelectionVersion((version) => version + 1)
    showNotice(`Deleted ${selectedDatasetIds.length} datasets.`)
  }

  const clearData = () => {
    if (!datasets.some((dataset) => dataset.points.length)) return
    if (!window.confirm('Clear all points from every dataset? The image and calibration will be kept.')) return
    setDatasets((current) => current.map((dataset) => ({ ...dataset, points: [] })))
    brushTraceIds.current = []
    pointTrainingBaselines.current = {}
    setPendingTrace(null)
    setPointSelectionVersion((version) => version + 1)
    activateDataset(activeId || datasets[0]?.id || '')
    showNotice('All dataset points cleared. Image and calibration were kept.')
  }

  const moveDataset = (id: string, direction: -1 | 1) => {
    const index = datasets.findIndex((dataset) => dataset.id === id)
    const target = datasets[index + direction]
    if (target && (!pendingTrace || (pendingTrace.ids.includes(id) && pendingTrace.ids.includes(target.id)))) {
      setDatasets((current) => reorderDatasets(current, id, target.id, direction > 0))
    }
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
    const run = processingRun.current
    setLoading(true)
    try {
      const image = new Image()
      image.src = traceImageUrl
      await image.decode()
      if (run !== processingRun.current) return
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
        learnedSampleStep,
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
        const next = { ...activeDataset, id: crypto.randomUUID(), name: `${activeDataset.name} (retrace candidate)`, color: nextDatasetColor(datasets.length + 1, datasets), points: traced }
        setDatasets((current) => [...current, next])
        activateDataset(next.id)
      } else if (plotType === 'compressor' && activeDataset?.kind === targetKind && (targetKind === 'speed' || targetKind === 'efficiency')) {
        updateDataset(activeDataset.id, (dataset) => ({ ...dataset, points: traced }))
      } else {
        const next = defaultDataset(datasets.length + 1, targetKind, datasets)
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
      if (run === processingRun.current) showNotice(error instanceof Error ? error.message : 'Image could not be analyzed in this browser.', 'error')
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
        setHealChoice(preferredHealingChoice(interactionModelRef.current))
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
    if (mode === 'trace-region') setBrushMarks((current) => [...current, { points: guide, width: traceBrushWidth, erase: brushErasing, group: brushGroup }])
  }

  const stageTraceCurves = (extraction: ReturnType<typeof extractBrushGroups>, excluded = 0, additionalWarnings: string[] = []) => {
    let curves = extraction.curves
    const kind: DatasetKind = plotType === 'compressor' && (activeDataset?.kind === 'speed' || activeDataset?.kind === 'efficiency') ? activeDataset.kind : 'curve'
    if (kind === 'speed') {
      const boundaries = datasets.filter((dataset) => (dataset.kind === 'surge' || dataset.kind === 'choke') && dataset.points.length > 1)
      const meetsBoundary = (candidate: PixelPoint) => boundaries.some((line) => line.points.slice(1).some((end, index) => distanceToSegment(candidate, line.points[index], end) < 10))
      curves = curves.map((curve) => {
        const segments: PixelPoint[][] = [[]]
        for (const point of curve.points) {
          if (meetsBoundary(point)) {
            if (segments[segments.length - 1].length) segments.push([])
          } else segments[segments.length - 1].push(point)
        }
        return { ...curve, points: segments.sort((a, b) => b.length - a.length)[0] }
      }).filter((curve) => {
        if (curve.points.length >= 2) return true
        excluded++
        return false
      })
    }
    if (!curves.length) {
      showNotice(excluded ? 'No speed curves remain after applying the surge and choke boundaries.' : 'No curves found in the painted region. Check the selection, color, and tolerance.', 'error')
      return
    }
    const retained = datasets.filter((dataset) => !brushTraceIds.current.includes(dataset.id))
    const next: Dataset[] = []
    for (const curve of curves) {
      const index = next.length
      const dataset = defaultDataset(retained.length + index + 1, kind, [...retained, ...next])
      dataset.name = kind === 'speed' ? `Speed line ${retained.filter((item) => item.kind === kind).length + index + 1}`
        : kind === 'efficiency' ? `Efficiency contour ${retained.filter((item) => item.kind === kind).length + index + 1}`
          : `Trace ${retained.filter((item) => item.kind === kind).length + index + 1}`
      dataset.name += ` (${curve.group})`
      dataset.points = curve.points
      next.push(dataset)
    }
    const warnings = [
      ...extraction.warnings,
      ...additionalWarnings,
      ...(!showOriginalPreview && processedImageUrl && !(reconstruction && !needsProcess) ? ['Using the composite image; the saved processed reconstruction is unavailable.'] : []),
      ...(excluded ? [`${excluded} speed curve candidates were removed by the boundaries.`] : []),
    ]
    for (const id of brushTraceIds.current) delete pointTrainingBaselines.current[id]
    setDatasets([...retained, ...next])
    brushTraceIds.current = next.map((dataset) => dataset.id)
    for (const dataset of next) pointTrainingBaselines.current[dataset.id] = dataset.points.map((point) => ({ ...point }))
    activateDataset(next[0].id)
    setMode('point-edit')
    showNotice([
      `Generated ${next.length} editable curve${next.length === 1 ? '' : 's'}.`,
      excluded ? `${excluded} removed by boundaries.` : '',
      warnings[0] ?? '',
    ].filter(Boolean).join(' '))
  }

  const autoPaintWithModel = async () => {
    if (!sourceImageUrl || !imagePrepared || loading || !reconstruction || needsProcess
      || !learningState?.enabled || (learningState.model.samples < 1 && interactionModelRef.current.featureSamples < 1)) return
    const run = processingRun.current
    setLoading(true)
    try {
      const image = new Image()
      image.src = sourceImageUrl
      await image.decode()
      if (run !== processingRun.current) return
      if (image.naturalWidth !== reconstruction.width || image.naturalHeight !== reconstruction.height) {
        throw new Error('The source image no longer matches the processed plot.')
      }
      if (image.naturalWidth * image.naturalHeight > 4_000_000) throw new Error('Use an image below 4 megapixels for automatic point extraction.')
      const sourceCanvas = document.createElement('canvas')
      sourceCanvas.width = image.naturalWidth; sourceCanvas.height = image.naturalHeight
      const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true })
      if (!sourceContext) throw new Error('This browser cannot read the source plot image.')
      sourceContext.drawImage(image, 0, 0)
      const automatic = renderReconstructionCurveLayer({ ...reconstruction, learnedCorrections: [] }, [], reconstructionWidths)
      const automaticContext = automatic.getContext('2d', { willReadFrequently: true })
      if (!automaticContext) throw new Error('This browser cannot read the automatic curve layer.')
      const prediction = predictEnhancedLearningEdits(learningState.model, interactionModelRef.current, {
        width: automatic.width, height: automatic.height,
        source: sourceContext.getImageData(0, 0, automatic.width, automatic.height).data,
        automatic: automaticContext.getImageData(0, 0, automatic.width, automatic.height).data,
        region: reconstruction.region,
        gridLines: { horizontal: reconstruction.horizontal, vertical: reconstruction.vertical },
      })
      const learnedCorrections = learningMasksToCorrections(prediction.add, prediction.erase, automatic.width, automatic.height)
      const curveLayer = renderReconstructionCurveLayer(
        { ...reconstruction, learnedCorrections: [] },
        [...corrections, ...learnedCorrections],
        reconstructionWidths,
      )
      const curveContext = curveLayer.getContext('2d', { willReadFrequently: true })
      if (!curveContext) throw new Error('This browser cannot prepare the automatic paint selection.')
      const curvePixels = curveContext.getImageData(0, 0, curveLayer.width, curveLayer.height).data
      const curveMask = new Uint8Array(curveLayer.width * curveLayer.height)
      for (let index = 0; index < curveMask.length; index++) curveMask[index] = curvePixels[index * 4 + 3] >= 64 ? 255 : 0
      const mask = dilateBrushMask(curveMask, curveLayer.width, curveLayer.height, Math.max(4, Math.round(traceBrushWidth / 2)))
      setBrushMarks((current) => [
        { points: [], width: 1, erase: false, group: brushGroup, mask, generated: true },
        ...current.filter((mark) => !mark.generated),
      ])
      showNotice(`Auto paint marked the predicted curve regions. Add or erase paint, then use Get points. ${prediction.changed} learned pixel correction${prediction.changed === 1 ? '' : 's'} applied.`)
    } catch (error) {
      if (run === processingRun.current) showNotice(error instanceof Error ? error.message : 'The local ML model could not analyze the plot.', 'error')
    } finally {
      setLoading(false)
    }
  }

  const smartAutoExtractPoints = async () => {
    const traceImageUrl = showOriginalPreview ? sourceImageUrl : imageUrl
    if (!traceImageUrl || !imagePrepared || loading || preprocessing) return
    const run = processingRun.current
    setLoading(true)
    try {
      let curveImage: CurveImageSource
      let extractMode: CurveSnapMode
      let curveColor: [number, number, number] | undefined
      let aiPixelCorrections = 0

      if (!showOriginalPreview && processedImageUrl && reconstruction && !needsProcess) {
        let learnedEdits = reconstruction.learnedCorrections ?? []
        const learningPixels = learningStateRef.current?.enabled
          && (learningStateRef.current.model.samples > 0 || interactionModelRef.current.featureSamples > 0)
          ? await getInteractionPixels()
          : undefined
        if (run !== processingRun.current) return
        if (learningPixels && learningStateRef.current) {
          const prediction = predictEnhancedLearningEdits(learningStateRef.current.model, interactionModelRef.current, {
            ...learningPixels,
            region: reconstruction.region,
          })
          aiPixelCorrections = prediction.changed
          learnedEdits = learningMasksToCorrections(prediction.add, prediction.erase, learningPixels.width, learningPixels.height)
        }
        const layer = renderReconstructionCurveLayer(
          { ...reconstruction, learnedCorrections: [] },
          [...learnedEdits, ...corrections],
          reconstructionWidths,
        )
        const context = layer.getContext('2d', { willReadFrequently: true })
        if (!context) throw new Error('This browser cannot read the curve layer.')
        curveImage = context.getImageData(0, 0, layer.width, layer.height)
        extractMode = 'isolated'
      } else {
        const image = new Image()
        image.src = traceImageUrl
        await image.decode()
        if (run !== processingRun.current) return
        if (image.naturalWidth * image.naturalHeight > 4_000_000) throw new Error('Use an image below 4 megapixels for smart automatic point extraction.')
        const canvas = document.createElement('canvas')
        canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
        const context = canvas.getContext('2d', { willReadFrequently: true })
        if (!context) throw new Error('This browser cannot analyze the plot image.')
        context.drawImage(image, 0, 0)
        curveImage = context.getImageData(0, 0, canvas.width, canvas.height)
        if (!showOriginalPreview && processedImageUrl) {
          extractMode = 'color'
          curveColor = [1, 3, 5].map((index) => parseInt(reconstructionColors.curve.slice(index, index + 2), 16)) as [number, number, number]
        } else {
          extractMode = 'dark'
        }
      }

      const learningPixels = learningStateRef.current?.enabled && interactionModelRef.current.featureSamples > 0
        ? await getInteractionPixels()
        : undefined
      if (run !== processingRun.current) return
      const scorePixel = learningPixels && learningPixels.width === curveImage.width && learningPixels.height === curveImage.height
        ? (x: number, y: number) => predictRichPixelScore(interactionModelRef.current, learningPixels, x, y)
        : undefined

      const smart = smartExtractCurvesFromLayer(curveImage, {
        spacing: learnedSampleStep,
        curvatureBias: interactionModelRef.current.curvatureBias,
        mode: extractMode,
        curveColor,
        tolerance,
        scorePixel,
        gridLines: reconstruction ? { horizontal: reconstruction.horizontal, vertical: reconstruction.vertical } : undefined,
        plotRegion: reconstruction?.region ?? plotRegion ?? undefined,
      })

      if (!smart.curves.length) {
        showNotice(smart.warnings[0] ?? 'No curves found. Try processing the image cleanly or painting a curve region.', 'error')
        return
      }

      const extraWarnings: string[] = []
      if (smart.junctionCrossingsResolved > 0) {
        extraWarnings.push(`Resolved ${smart.junctionCrossingsResolved} crossing${smart.junctionCrossingsResolved === 1 ? '' : 's'} by tangent continuity.`)
      }
      if (aiPixelCorrections > 0) {
        extraWarnings.push(`Applied ${aiPixelCorrections} AI pixel refinement${aiPixelCorrections === 1 ? '' : 's'}.`)
      }
      stageTraceCurves({
        curves: smart.curves.map((points) => ({ points, group: 'AI Smart' })),
        warnings: smart.warnings,
      }, 0, extraWarnings)
    } catch (error) {
      if (run === processingRun.current) showNotice(error instanceof Error ? error.message : 'Smart AI extraction failed.', 'error')
    } finally {
      if (run === processingRun.current) setLoading(false)
    }
  }

  const autoPaintedPoints = async () => {
    const traceImageUrl = showOriginalPreview ? sourceImageUrl : imageUrl
    if (!traceImageUrl || !imagePrepared || !brushMarks.length || loading) return
    const run = processingRun.current
    setLoading(true)
    try {
      const image = new Image()
      image.src = traceImageUrl
      await image.decode()
      if (run !== processingRun.current) return
      if (image.naturalWidth * image.naturalHeight > 4_000_000) throw new Error('Use an image below 4 megapixels for automatic point extraction.')
      const isolatedCurveLayer = !showOriginalPreview && processedImageUrl && reconstruction && !needsProcess
        ? renderReconstructionCurveLayer(reconstruction, corrections, reconstructionWidths)
        : null
      const canvas = isolatedCurveLayer ?? document.createElement('canvas')
      if (!isolatedCurveLayer) { canvas.width = image.naturalWidth; canvas.height = image.naturalHeight }
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) throw new Error('This browser cannot analyze the plot image.')
      if (!isolatedCurveLayer) context.drawImage(image, 0, 0)
      const groups = BRUSH_GROUPS.filter((group) => brushMarks.some((mark) => mark.group === group.color && !mark.erase)).map((group) => {
        const mask = createBrushMask(canvas.width, canvas.height, brushMarks.filter((mark) => mark.group === group.color))
        const maskContext = mask.getContext('2d', { willReadFrequently: true })
        if (!maskContext) throw new Error('This browser cannot read the brush selection.')
        return { ...group, mask: maskContext.getImageData(0, 0, canvas.width, canvas.height).data }
      })
      const color: [number, number, number] | undefined = isolatedCurveLayer
        ? [0, 102, 255]
        : !showOriginalPreview && processedImageUrl
        ? [1, 3, 5].map((index) => parseInt(reconstructionColors.curve.slice(index, index + 2), 16)) as [number, number, number]
        : undefined
      const extraction = extractBrushGroups(
        context.getImageData(0, 0, canvas.width, canvas.height),
        groups,
        learnedSampleStep,
        tolerance,
        color,
        Boolean(isolatedCurveLayer),
        interactionModelRef.current.curvatureBias,
      )
      let learningNotice: { message: string; type: Notice['type'] } | null = null
      const manualMarks = brushMarks.filter((mark) => !mark.generated)
      const state = learningStateRef.current
      const store = learningStore.current
      if (state?.enabled && store && reconstruction && manualMarks.length) {
        learningWorkRef.current = true
        setLearningWorking(true)
        try {
          if (syncRef.current) await syncRef.current
          const current = learningStateRef.current
          if (!current?.enabled) throw new Error('Learning is disabled.')
          if (!sourceImageUrl || canvas.width !== reconstruction.width || canvas.height !== reconstruction.height) {
            throw new Error('The painted selection does not match the processed plot.')
          }
          const source = new Image()
          source.src = sourceImageUrl
          await source.decode()
          if (source.naturalWidth !== reconstruction.width || source.naturalHeight !== reconstruction.height) {
            throw new Error('The source image no longer matches the processed plot.')
          }
          const sourceCanvas = document.createElement('canvas')
          sourceCanvas.width = source.naturalWidth
          sourceCanvas.height = source.naturalHeight
          const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true })
          const automatic = renderReconstructionCurveLayer({ ...reconstruction, learnedCorrections: [] }, [], reconstructionWidths)
          const automaticContext = automatic.getContext('2d', { willReadFrequently: true })
          if (!sourceContext || !automaticContext) throw new Error('This browser cannot prepare painted learning data.')
          sourceContext.drawImage(source, 0, 0)
          const { additions, removals } = createBrushLearningMasks(canvas.width, canvas.height, manualMarks)
          if (additions.some(Boolean) || removals.some(Boolean)) {
            const paintPixels = {
              width: canvas.width, height: canvas.height,
              source: sourceContext.getImageData(0, 0, canvas.width, canvas.height).data,
              automatic: automaticContext.getImageData(0, 0, canvas.width, canvas.height).data,
            }
            const example = await createPaintLearningExample(paintPixels, additions, removals, current.model)
            if (example.updated && !(await store.hasSample(example.sample.id))) {
              if (onlineConfiguration.config) {
                example.sample.updateId = crypto.randomUUID()
                example.sample.status = 'pending'
                example.sample.target = onlineConfiguration.config.url
              }
              await store.saveSample(example.sample, example.model)
              const nextState = { ...current, model: example.model }
              learningStateRef.current = nextState
              setLearningState(nextState)
              const beforeInteraction = interactionModelRef.current
              const nextInteraction = learnFromLayerComparison(beforeInteraction, paintPixels, example.corrected, 'paint')
              interactionModelRef.current = nextInteraction
              setInteractionModel(nextInteraction)
              const interactionPayload = onlineConfiguration.config ? createInteractionUpdatePayload(beforeInteraction, nextInteraction) : null
              if (onlineConfiguration.config && interactionPayload) {
                await store.saveInteractionSample({
                  id: crypto.randomUUID(), createdAt: new Date().toISOString(), delta: [],
                  updateId: crypto.randomUUID(), status: 'pending', target: onlineConfiguration.config.url,
                  interactionUpdate: interactionPayload,
                }, nextInteraction)
              } else {
                await store.saveInteractionModel(nextInteraction)
              }
              if (onlineConfiguration.config) setPendingUpdates((await store.pendingSamples()).length)
              if (example.sample.comparison) setLastComparison(example.sample.comparison.counts)
              learningNotice = { message: onlineConfiguration.config ? 'Painted edits saved for local learning and Supabase synchronization.' : 'Painted edits learned by the local curve model.', type: 'success' }
            }
          }
        } catch (error) {
          learningNotice = { message: error instanceof Error ? `Curves extracted, but painted edits could not be learned: ${error.message}` : 'Curves extracted, but painted edits could not be learned.', type: 'error' }
        } finally {
          learningWorkRef.current = false
          setLearningWorking(false)
        }
      }
      stageTraceCurves(extraction)
      if (learningNotice) showNotice(learningNotice.message, learningNotice.type)
    } catch (error) {
      if (run === processingRun.current) showNotice(error instanceof Error ? error.message : 'Image could not be analyzed in this browser.', 'error')
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
      if (fourPointPixels.length && (Math.abs(fourPointPixels[0].x - point.x) < 4 || Math.abs(fourPointPixels[0].y - point.y) < 4)) {
        showNotice('Intersections must be at least 4 pixels apart on both axes.', 'error')
        return
      }
      const points = [...fourPointPixels, point]
      setFourPointPixels(points)
      setXAxis((current) => ({ ...current, points: points.map((pixel, index) => ({ ...pixel, value: index + 1 })) }))
      setYAxis((current) => ({ ...current, points: points.map((pixel, index) => ({ ...pixel, value: index + 1 })) }))
      setCalibrationDrafts({ x: points.map(() => ''), y: points.map(() => '') })
      setCalibrationConfirmed(false)
      if (points.length === 2) { setMode('calibrate-edit'); showNotice('Review the markers, then confirm their positions.') }
      else showNotice('First intersection captured. Click the second intersection.')
      return
    }
    if (mode === 'calibrate-four') {
      const step = fourPointPixels.length
      const keys: (keyof FourPointValues)[] = ['x1', 'x2', 'y1', 'y2']
      const key = keys[step]
      if (!key) { setFourPointPixels([]); return }
      const duplicatePixel = step === 1
        ? Math.abs(fourPointPixels[0].x - point.x) < 4
        : step === 3 && Math.abs(fourPointPixels[2].y - point.y) < 4
      if (duplicatePixel) {
        showNotice('Calibration points on the same axis must be at least 4 pixels apart.', 'error')
        return
      }
      const nextPixels = [...fourPointPixels, point]
      setFourPointPixels(nextPixels)
      const axis = step < 2 ? 'x' : 'y'
      const update = axis === 'x' ? setXAxis : setYAxis
      update((current) => ({ ...current, points: [...current.points, { ...point, value: current.points.length + 1 }] }))
      setCalibrationDrafts((current) => ({ ...current, [axis]: [...current[axis], ''] }))
      setCalibrationConfirmed(false)
      if (nextPixels.length === 4) {
        setMode('calibrate-edit')
        showNotice('Review the markers, then confirm their positions.')
      } else {
        showNotice(`${key.toUpperCase()} captured. Click ${keys[step + 1].toUpperCase()} on the chart.`)
      }
      return
    }
    if (mode === 'calibrate-x' || mode === 'calibrate-y') {
      const current = mode === 'calibrate-x' ? xAxis : yAxis
      const nextPoint: CalPoint = { ...point, value: current.points.length + 1 }
      if (current.points.some((p) => Math.abs(mode === 'calibrate-x' ? p.x - point.x : p.y - point.y) < 4)) { showNotice('Points on the same axis must be at least 4 pixels apart.', 'error'); return }
      if (mode === 'calibrate-x') setXAxis({ ...xAxis, points: [...xAxis.points, nextPoint] })
      else setYAxis({ ...yAxis, points: [...yAxis.points, nextPoint] })
      const axis = mode === 'calibrate-x' ? 'x' : 'y'
      setCalibrationDrafts((drafts) => ({ ...drafts, [axis]: [...drafts[axis], ''] }))
      setCalibrationConfirmed(false)
      showNotice(`${mode === 'calibrate-x' ? 'X' : 'Y'} calibration point ${current.points.length + 1} added.`)
      return
    }
    if (mode === 'speed') {
      await traceCurve(point)
      return
    }
    if (mode === 'surge' || mode === 'choke' || mode === 'point' || mode === 'measure') {
      const kind: DatasetKind = mode === 'surge' || mode === 'choke'
        ? mode
        : mode === 'measure'
          ? 'measurement'
          : 'curve'
      if (!activeDataset || (kind !== 'curve' && activeDataset.kind !== kind)) {
        const next = defaultDataset(datasets.length + 1, kind, datasets)
        next.points = [point]
        setDatasets((current) => [...current, next])
        activateDataset(next.id)
        setSelectedPointHint((previous) => ({ datasetId: next.id, index: 0, version: (previous?.version ?? 0) + 1 }))
        if (kind !== 'measurement' && learningStateRef.current?.enabled) {
          void getInteractionPixels().then((pixels) => {
            persistInteractionUpdate((current) => learnFromPointAdded(current, {
              point, insertedIndex: 0, pointsAfter: [point], pixels,
            }))
          })
        }
        return
      }
      const inserted = insertPointInDataset(activeDataset.points, point, insertPointsByX && activeDataset.kind !== 'measurement')
      updateDataset(activeDataset.id, (dataset) => ({ ...dataset, points: inserted.points }))
      setSelectedPointHint((previous) => ({ datasetId: activeDataset.id, index: inserted.index, version: (previous?.version ?? 0) + 1 }))
      if (activeDataset.kind !== 'measurement' && learningStateRef.current?.enabled) {
        void getInteractionPixels().then((pixels) => {
          persistInteractionUpdate((current) => learnFromPointAdded(current, {
            point, insertedIndex: inserted.index, pointsAfter: inserted.points, pixels,
          }))
        })
      }
    }
  }

  const handlePointMoveEnd = (datasetId: string, _index: number, from: PixelPoint, to: PixelPoint) => {
    const dataset = datasets.find((item) => item.id === datasetId)
    if (!dataset || dataset.kind === 'measurement' || !learningStateRef.current?.enabled) return
    if (Math.hypot(to.x - from.x, to.y - from.y) < 1.5) return
    void getInteractionPixels().then((pixels) => {
      persistInteractionUpdate((current) => learnFromPointMoved(current, { from, to, pixels }))
    })
  }

  const deletePointAtIndex = (datasetId: string, pointIndex: number) => {
    const dataset = datasets.find((item) => item.id === datasetId)
    if (!dataset || !dataset.points[pointIndex]) return
    const removed = dataset.points[pointIndex]
    const prev = dataset.points[pointIndex - 1]
    const next = dataset.points[pointIndex + 1]
    const wasAutoGenerated = Boolean(pointTrainingBaselines.current[datasetId])
    updateDataset(datasetId, (current) => ({ ...current, points: current.points.filter((_, index) => index !== pointIndex) }))
    if (dataset.kind !== 'measurement' && learningStateRef.current?.enabled) {
      void getInteractionPixels().then((pixels) => {
        persistInteractionUpdate((current) => learnFromPointDeleted(current, { removed, prev, next, wasAutoGenerated, pixels }))
      })
    }
  }

  const snapPointsToCurve = async (scope: 'selected' | 'all' = 'selected') => {
    const snapImageUrl = showOriginalPreview ? sourceImageUrl : imageUrl
    if (!snapImageUrl || !imagePrepared || loading || preprocessing) return
    const targetIds = scope === 'all'
      ? datasets.map((dataset) => dataset.id)
      : selectedDatasetIds.length > 1
        ? selectedDatasetIds
        : activeDataset ? [activeDataset.id] : []
    const targets = datasets.filter((dataset) => targetIds.includes(dataset.id) && dataset.kind !== 'measurement' && dataset.points.length > 0)
    if (!targets.length) {
      showNotice(scope === 'all' ? 'Add at least one curve dataset with points before snapping all datasets.' : 'Select a curve dataset with at least one point before snapping.', 'error')
      return
    }
    const run = processingRun.current
    setLoading(true)
    try {
      let curveImage: CurveImageSource
      let snapMode: CurveSnapMode
      let curveColor: [number, number, number] | undefined
      if (!showOriginalPreview && processedImageUrl && reconstruction && !needsProcess) {
        const layer = renderReconstructionCurveLayer(reconstruction, corrections, reconstructionWidths)
        const context = layer.getContext('2d', { willReadFrequently: true })
        if (!context) throw new Error('This browser cannot read the curve layer.')
        curveImage = context.getImageData(0, 0, layer.width, layer.height)
        snapMode = 'isolated'
      } else {
        const image = new Image()
        image.src = snapImageUrl
        await image.decode()
        if (run !== processingRun.current) return
        const canvas = document.createElement('canvas')
        canvas.width = image.naturalWidth
        canvas.height = image.naturalHeight
        const context = canvas.getContext('2d', { willReadFrequently: true })
        if (!context) throw new Error('This browser cannot read the plot image.')
        context.drawImage(image, 0, 0)
        curveImage = context.getImageData(0, 0, canvas.width, canvas.height)
        if (!showOriginalPreview && processedImageUrl) {
          snapMode = 'color'
          curveColor = [1, 3, 5].map((index) => parseInt(reconstructionColors.curve.slice(index, index + 2), 16)) as [number, number, number]
        } else {
          snapMode = 'dark'
        }
      }

      const learningPixels = learningStateRef.current?.enabled ? await getInteractionPixels() : undefined
      if (run !== processingRun.current) return
      const model = interactionModelRef.current
      const scorePixel = learningPixels && model.featureSamples > 0
        && learningPixels.width === curveImage.width && learningPixels.height === curveImage.height
        ? (x: number, y: number) => predictRichPixelScore(model, learningPixels, x, y)
        : undefined
      const radius = model.snapRadius

      const updatedById = new Map<string, PixelPoint[]>()
      let totalMoved = 0
      let totalInspected = 0
      const allDisplacements: Array<{ from: PixelPoint; to: PixelPoint; distance: number }> = []

      for (const dataset of targets) {
        totalInspected += dataset.points.length
        const result = snapDatasetPointsToCurve(curveImage, dataset.points, {
          mode: snapMode,
          radius,
          curveColor,
          tolerance,
          scorePixel,
        })
        if (result.movedCount > 0) {
          updatedById.set(dataset.id, result.points)
          totalMoved += result.movedCount
          allDisplacements.push(...result.displacements)
        }
      }

      if (!totalMoved) {
        showNotice(`All ${totalInspected} point${totalInspected === 1 ? '' : 's'} are already aligned with the curve or outside the ${Math.round(radius)} px snap radius.`)
        return
      }

      setDatasets((current) => current.map((dataset) => {
        const snapped = updatedById.get(dataset.id)
        return snapped ? { ...dataset, points: snapped } : dataset
      }))

      if (learningStateRef.current?.enabled) {
        persistInteractionUpdate((current) => learnFromPointsSnapped(current, {
          displacements: allDisplacements,
          pixels: learningPixels,
        }))
      }
      const datasetSuffix = updatedById.size > 1 ? ` across ${updatedById.size} datasets` : ''
      showNotice(`Snapped ${totalMoved} of ${totalInspected} point${totalInspected === 1 ? '' : 's'}${datasetSuffix} onto the curve (radius ${Math.round(radius)} px). Use Undo if needed.`)
    } catch (error) {
      if (run === processingRun.current) showNotice(error instanceof Error ? error.message : 'Could not snap points to the curve.', 'error')
    } finally {
      if (run === processingRun.current) setLoading(false)
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
      deletePointAtIndex(activeDataset.id, index)
      setPointSelectionVersion((version) => version + 1)
    }
  }

  const deleteDataset = (id: string) => {
    if (pendingTrace && !pendingTrace.ids.includes(id)) return
    setEditingDatasetName(null)
    const remaining = datasets.filter((dataset) => dataset.id !== id)
    delete pointTrainingBaselines.current[id]
    setDatasets(remaining)
    if (pendingTrace) {
      const updatedPending = updatePendingTrace(pendingTrace, [id])
      if (!updatedPending) {
        activateDataset(pendingTrace.previousActiveId)
        setPendingTrace(null)
        setMode('trace-region')
      } else {
        setPendingTrace(updatedPending)
        if (activeId === id) activateDataset(updatedPending.ids[0])
        else setSelectedDatasetIds((current) => current.filter((item) => item !== id))
      }
    } else if (activeId === id) activateDataset(remaining[0]?.id ?? '')
    else setSelectedDatasetIds((current) => current.filter((item) => item !== id))
    setPointSelectionVersion((version) => version + 1)
  }

  const cropImage = async (rect: { x: number; y: number; width: number; height: number }) => {
    if (!imageUrl || preprocessing) return
    if (processedImageUrl && !window.confirm('Cropping clears the reconstruction and its edits. Crop the original image instead?')) { setMode('select'); return }
    const run = processingRun.current
    const image = new Image(); image.src = sourceImageUrl ?? imageUrl
    try { await image.decode() }
    catch { if (run === processingRun.current) showNotice('Could not load the image for cropping.', 'error'); return }
    if (run !== processingRun.current) return
    const x = Math.max(0, Math.round(rect.x))
    const y = Math.max(0, Math.round(rect.y))
    const width = Math.min(image.naturalWidth - x, Math.round(rect.width))
    const height = Math.min(image.naturalHeight - y, Math.round(rect.height))
    if (width < 10 || height < 10) { showNotice('Select a larger crop area.', 'error'); return }
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) { showNotice('This browser cannot crop the image.', 'error'); return }
    context.drawImage(image, x, y, width, height, 0, 0, width, height)
    const shiftPoint = (point: PixelPoint): PixelPoint => ({ x: point.x - x, y: point.y - y })
    const insideCrop = (point: PixelPoint) => point.x >= x && point.x <= x + width && point.y >= y && point.y <= y + height
    setCalibrationDrafts((current) => ({
      x: current.x.filter((_, index) => insideCrop(xAxis.points[index])),
      y: current.y.filter((_, index) => insideCrop(yAxis.points[index])),
    }))
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
    const run = processingRun.current
    const image = new Image(); image.src = sourceImageUrl ?? imageUrl
    try { await image.decode() }
    catch { if (run === processingRun.current) showNotice('Could not load the image for transformation.', 'error'); return }
    if (run !== processingRun.current) return
    const canvas = document.createElement('canvas')
    const rotate = operation === 'rotate-left' || operation === 'rotate-right'
    canvas.width = rotate ? image.naturalHeight : image.naturalWidth
    canvas.height = rotate ? image.naturalWidth : image.naturalHeight
    const context = canvas.getContext('2d')
    if (!context) { showNotice('This browser cannot transform the image.', 'error'); return }
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
      setCalibrationDrafts({ x: [], y: [] }); setCalibrationScales({ x: 'linear', y: 'linear' })
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

  const getChartExportPoints = (dataset: Dataset, state: ChartState) => dataset.points
    .map((point) => state.calibrationConfirmed && state.xAxis.points.length >= 2 && state.yAxis.points.length >= 2 ? pointToData(point, state.xAxis, state.yAxis) : { x: point.x, y: point.y })
    .filter((point): point is { x: number; y: number } => point !== null)
    .sort((a, b) => sortBy === 'x' ? a.x - b.x : a.y - b.y)
    .map((point) => ({ x: Number(point.x.toPrecision(precision)), y: Number(point.y.toPrecision(precision)) }))

  const getExportPoints = (dataset: Dataset) => getChartExportPoints(dataset, chartState)
  const exportAxisLabel = (state: ChartState, axis: 'x' | 'y', isCalibrated: boolean, label: string) =>
    !isCalibrated ? `Pixel ${axis.toUpperCase()}`
      : state.plotType === 'compressor' ? axisName(state.compressorAxes[axis])
        : axisName({ label, unit: state.axisUnits[axis] })

  const exportDataset = (dataset: Dataset, format: 'csv' | 'json') => {
    const points = getExportPoints(dataset)
    const csvRows = points.map((point) => `${point.x},${point.y}`)
    if (format === 'csv') {
      const labels = (['x', 'y'] as const).map((axis) => calibrated
        ? exportAxisLabel(chartState, axis, true, axis)
        : `pixel_${axis}`)
      const header = csvHeader(labels, plotType === 'compressor' && calibrated)
      downloadFile(`${dataset.name.toLowerCase().replace(/\s+/g, '-')}.csv`, [header, ...csvRows].join('\n'), 'text/csv')
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
      downloadFile(`${dataset.name.toLowerCase().replace(/\s+/g, '-')}.json`, JSON.stringify({
        name: dataset.name, kind: dataset.kind, coordinateSystem: calibrated ? 'calibrated' : 'image-pixels',
        ...(plotType === 'compressor' ? { axes: compressorAxes } : {}),
        ...(plotType !== 'compressor' && calibrated && (axisUnits.x.trim() || axisUnits.y.trim()) ? { units: axisUnits } : {}),
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
      : { plotType, coordinateSystem: calibrated ? 'calibrated' : 'image-pixels', ...(calibrated && (axisUnits.x.trim() || axisUnits.y.trim()) ? { units: axisUnits } : {}), datasets: datasetsData.map(({ dataset, points }) => ({ name: dataset.name, kind: dataset.kind, points })) }
    downloadFile(`${imageName || 'plot'}-data.json`, JSON.stringify(project, null, 2), 'application/json')
  }

  const exportExcel = async () => {
    if (projectBusy) return
    const snapshot = currentProject()
    for (const { state } of snapshot.charts) if (state.sourceImageUrl?.startsWith('blob:')) pinnedUrls.current.add(state.sourceImageUrl)
    setExporting(true)
    try {
      const output: WorkbookChart[] = []
      for (const chart of snapshot.charts) {
        const state = chart.state
        let overlay: WorkbookChart['image'] = null
        if (state.sourceImageUrl) {
          const image = new Image(); image.src = state.sourceImageUrl; await image.decode()
          const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
          const context = canvas.getContext('2d')
          if (!context) throw new Error('This browser cannot draw the plot for Excel.')
          context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height)
          context.drawImage(image, 0, 0)
          drawDatasets(context, state.datasets, (point) => point, Math.max(2, image.width / 700), Math.max(3, image.width / 260) * state.pointMarkerSize / 100)
          overlay = { base64: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height }
        }
        const isCalibrated = state.calibrationConfirmed && state.xAxis.points.length >= 2 && state.yAxis.points.length >= 2
        output.push({
          name: chart.name,
          datasets: state.datasets.map((dataset) => ({ dataset, points: getChartExportPoints(dataset, state) })),
          xLabel: exportAxisLabel(state, 'x', isCalibrated, 'X'),
          yLabel: exportAxisLabel(state, 'y', isCalibrated, 'Y'),
          image: overlay,
        })
      }
      const workbook = await createProjectWorkbook(output)
      const buffer = await workbook.xlsx.writeBuffer()
      const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
      downloadFile(`${snapshot.name || 'project'}-data.xlsx`, blob)
    } catch (error) {
      showNotice(error instanceof Error ? error.message : 'Could not export the Excel workbook.', 'error')
    } finally {
      pinnedUrls.current.clear(); setExporting(false)
    }
  }


  const exportProject = async (cloud?: { name: string; save: (project: object) => Promise<void> }): Promise<boolean> => {
    if (rotationPreview || preprocessing || loading || gridDetecting || exporting || pendingTrace || learningWorking) return false
    const snapshot = currentProject()
    if (cloud) snapshot.name = cloud.name
    for (const { state } of snapshot.charts) {
      for (const url of [state.imageUrl, state.sourceImageUrl]) if (url?.startsWith('blob:')) pinnedUrls.current.add(url)
    }
    setExporting(true)
    const spacingBaselineIds = Object.keys(pointTrainingBaselines.current)
    let spacingUpdate: PointSpacingModel | null = null
    let spacingTargets: number[] = []
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
      if (learningState?.enabled && spacingBaselineIds.length) {
        const savedDatasets = snapshot.charts.flatMap((chart) => chart.state.datasets)
        const comparisons = Object.entries(pointTrainingBaselines.current).flatMap(([id, generated]) => {
          const corrected = savedDatasets.find((dataset) => dataset.id === id)?.points
          return corrected ? [{ generated, corrected }] : []
        })
        if (comparisons.length) {
          spacingTargets = pointSpacingTargets(comparisons)
          spacingUpdate = trainPointSpacingModel(pointSpacingModel, comparisons)
        }
      }
      const savedCharts = []
      for (const chart of snapshot.charts) {
        savedCharts.push({ id: chart.id, name: chart.name, state: {
          ...chart.state, imageUrl: await portable(chart.state.imageUrl), sourceImageUrl: await portable(chart.state.sourceImageUrl),
        } })
      }
      const project = { version: 2, name: snapshot.name, activeChartId: snapshot.activeId, charts: savedCharts }
      if (cloud) {
        await cloud.save(project)
        setProjectName(snapshot.name)
      } else {
        downloadFile(`${snapshot.name.toLowerCase().replace(/\s+/g, '-') || 'project'}-project.json`, JSON.stringify(project), 'application/json')
      }
      if (spacingBaselineIds.length && learningState?.enabled) {
        try {
          if (spacingUpdate && spacingUpdate.samples > pointSpacingModel.samples) {
            const store = learningStore.current
            if (!store) throw new Error('Local learning storage is unavailable.')
            if (onlineConfiguration.config) {
              const target = onlineConfiguration.config.url
              const samples = spacingTargets.map((spacingTarget) => ({
                id: crypto.randomUUID(), createdAt: new Date().toISOString(), delta: [],
                updateId: crypto.randomUUID(), status: 'pending' as const,
                target, spacingTarget,
              }))
              await store.savePointSpacingSamples(samples, spacingUpdate)
              setPendingUpdates((await store.pendingSamples()).length)
            } else {
              await store.savePointSpacingModel(spacingUpdate)
            }
            setPointSpacingModel(spacingUpdate)
            showNotice(onlineConfiguration.config
              ? `Queued ${spacingTargets.length} point-spacing update${spacingTargets.length === 1 ? '' : 's'} for Supabase.`
              : `Saved point-spacing learning from ${spacingTargets.length} edited dataset${spacingTargets.length === 1 ? '' : 's'}.`)
          }
          for (const id of spacingBaselineIds) delete pointTrainingBaselines.current[id]
        } catch (error) {
          showNotice(error instanceof Error ? `Project saved, but point-spacing learning could not be saved: ${error.message}` : 'Project saved, but point-spacing learning could not be saved.', 'error')
        }
      }
      return true
    } catch (error) {
      if (cloud) throw error
      showNotice(error instanceof Error ? error.message : 'Unable to save the project.', 'error')
      return false
    } finally {
      pinnedUrls.current.clear(); setExporting(false)
    }
  }


  const importProject = async (file?: File, fromCloud = false): Promise<boolean> => {
    if (!file || projectBusy) return false
    const run = ++processingRun.current
    const before = currentProject()
    try {
      const fileData = JSON.parse(await file.text())
      if (run !== processingRun.current) return false
      if (latestProject.current && !sameProjectContent(before, latestProject.current)) {
        showNotice('The project changed while the file was opening. Please open it again.', 'error')
        return false
      }
      const parseChart = (project: typeof fileData): ChartState => {
      if (!project || !Array.isArray(project.datasets)) throw new Error('Invalid chart data')
      const validPoint = (value: PixelPoint) => value && Number.isFinite(value.x) && Number.isFinite(value.y)
      const validEraserWidth = (value: number) => Number.isFinite(value) && value >= ERASER_MIN_WIDTH && value <= ERASER_MAX_WIDTH
      if (!project.datasets.every((dataset: Dataset) => dataset && typeof dataset.id === 'string' && typeof dataset.name === 'string'
        && typeof dataset.color === 'string' && /^#[0-9a-f]{6}$/i.test(dataset.color) && Array.isArray(dataset.points) && dataset.points.every(validPoint)
        && ['curve', 'surge', 'choke', 'speed', 'efficiency', 'measurement'].includes(dataset.kind))) throw new Error('Invalid datasets')
      if (project.datasets.some((dataset: Dataset) => !dataset.id) || new Set(project.datasets.map((dataset: Dataset) => dataset.id)).size !== project.datasets.length) throw new Error('Invalid dataset ids')
      for (const axis of [project.xAxis, project.yAxis]) {
        if (axis && (!Array.isArray(axis.points) || !axis.points.every((point: CalPoint) => validPoint(point) && Number.isFinite(point.value))
          || !['linear', 'log', 'inverse', 'date'].includes(axis.scale))) throw new Error('Invalid calibration')
      }
      if (project.plotType && !plotOptions.some((option) => option.id === project.plotType)) throw new Error('Invalid plot type')
      if (project.imagePrepared !== undefined && typeof project.imagePrepared !== 'boolean') throw new Error('Invalid image confirmation')
      if (project.fourPointValues && !['x1', 'x2', 'y1', 'y2'].every((key) => typeof project.fourPointValues[key] === 'string')) throw new Error('Invalid calibration inputs')
      if (project.calibrationDrafts && !['x', 'y'].every((key) => Array.isArray(project.calibrationDrafts[key])
        && project.calibrationDrafts[key].length === (project[`${key}Axis`]?.points?.length ?? 0)
        && project.calibrationDrafts[key].every((value: unknown) => typeof value === 'string'))) throw new Error('Invalid calibration drafts')
      if (project.calibrationScales && !['x', 'y'].every((key) => ['linear', 'log', 'inverse', 'date'].includes(project.calibrationScales[key]))) throw new Error('Invalid calibration scales')
      if (project.compressorAxes && !['x', 'y'].every((key) => {
        const axis = project.compressorAxes[key]
        return axis && typeof axis.label === 'string' && typeof axis.unit === 'string'
          && Object.hasOwn(compressorAxisLabels, axis.variable)
      })) throw new Error('Invalid compressor axes')
      if (project.axisUnits !== undefined && (!project.axisUnits || !['x', 'y'].every((key) => typeof project.axisUnits[key] === 'string'))) throw new Error('Invalid axis units')
      if (project.digitizeUnlocked !== undefined && typeof project.digitizeUnlocked !== 'boolean') throw new Error('Invalid workflow progress')
      for (const key of ['imageUrl', 'sourceImageUrl', 'processedImageUrl', 'processedPreviewUrl']) {
        if (project[key] != null && typeof project[key] !== 'string') throw new Error('Invalid image')
      }
      if (project.plotRegion && ![project.plotRegion.x, project.plotRegion.y, project.plotRegion.width, project.plotRegion.height].every(Number.isFinite)) throw new Error('Invalid plot region')
      if (project.gridGuides && (!Array.isArray(project.gridGuides.horizontal) || !Array.isArray(project.gridGuides.vertical)
        || !project.gridGuides.horizontal.every(Number.isFinite) || !project.gridGuides.vertical.every(Number.isFinite))) throw new Error('Invalid grid guides')
      if (project.axisGuides && !['horizontal', 'vertical'].every((key) => project.axisGuides[key] === null || Number.isFinite(project.axisGuides[key]))) throw new Error('Invalid axis guides')
      if (project.regularGrid !== undefined && typeof project.regularGrid !== 'boolean') throw new Error('Invalid regular grid setting')
      if (project.workflowStep !== undefined && !['image', 'calibration', 'digitize'].includes(project.workflowStep)) throw new Error('Invalid workflow step')
      if (project.needsProcess !== undefined && typeof project.needsProcess !== 'boolean') throw new Error('Invalid processing state')
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
      if (project.reconstruction && (
        !Number.isFinite(project.reconstruction.width) || project.reconstruction.width <= 0
        || !Number.isFinite(project.reconstruction.height) || project.reconstruction.height <= 0
        || !project.reconstruction.region
        || ![project.reconstruction.region.x, project.reconstruction.region.y, project.reconstruction.region.width, project.reconstruction.region.height].every(Number.isFinite)
        || !Array.isArray(project.reconstruction.horizontal) || !project.reconstruction.horizontal.every(Number.isFinite)
        || !Array.isArray(project.reconstruction.vertical) || !project.reconstruction.vertical.every(Number.isFinite)
        || !Array.isArray(project.reconstruction.curves)
        || !project.reconstruction.curves.every((curve: PixelPoint[]) => Array.isArray(curve) && curve.every(validPoint))
      )) throw new Error('Invalid reconstruction')
      const hasCalibration = (project.xAxis?.points?.length ?? 0) >= 2 && (project.yAxis?.points?.length ?? 0) >= 2
      const prepared = project.imagePrepared ?? Boolean(project.imageUrl)
      const confirmed = hasCalibration && (project.calibrationConfirmed ?? true)
      const step: WorkflowStep = !prepared ? 'image' : project.workflowStep === 'image' ? 'image' : confirmed && project.workflowStep !== 'calibration' ? 'digitize' : 'calibration'
      return {
        ...blankChart(), imageName: typeof project.imageName === 'string' ? project.imageName : 'Imported plot',
        imageUrl: project.imageUrl || null, sourceImageUrl: project.sourceImageUrl || project.imageUrl || null,
        processedImageUrl: project.processedImageUrl || null, processedPreviewUrl: project.processedPreviewUrl || null,
        upscale: project.upscale ?? { preset: 'hd', longEdge: 1920 },
        imagePrepared: prepared, gridGuides: project.gridGuides || { horizontal: [], vertical: [] },
        plotRegion: project.plotRegion || null, corrections: project.corrections || [],
        axisGuides: project.axisGuides || { horizontal: null, vertical: null }, regularGrid: project.regularGrid ?? false,
        reconstructionColors: project.reconstructionColors || { curve: '#000000', grid: '#000000', axis: '#000000' },
        reconstructionWidths: project.reconstructionWidths || { curve: 1, grid: 1 },
        eraserWidth: project.eraserWidth ?? ERASER_WIDTH, drawWidth: project.drawWidth ?? project.reconstructionWidths?.curve ?? 1,
        pointMarkerSize: project.pointMarkerSize ?? 100,
        reconstruction: project.reconstruction ?? null,
        needsProcess: project.needsProcess ?? !project.processedImageUrl,
        plotType: project.plotType || 'xy', compressorAxes: project.compressorAxes || defaultCompressorAxes,
        axisUnits: project.axisUnits ?? { x: '', y: '' },
        xAxis: project.xAxis || blankAxis(), yAxis: project.yAxis || blankAxis(), datasets: project.datasets,
        calibrationDrafts: project.calibrationDrafts ?? {
          x: (project.xAxis?.points ?? []).map((point: CalPoint) => formatCalibrationValue(point.value, project.xAxis.scale)),
          y: (project.yAxis?.points ?? []).map((point: CalPoint) => formatCalibrationValue(point.value, project.yAxis.scale)),
        },
        calibrationScales: project.calibrationScales ?? { x: project.xAxis?.scale ?? 'linear', y: project.yAxis?.scale ?? 'linear' },
        calibrationConfirmed: confirmed, digitizeUnlocked: project.digitizeUnlocked ?? confirmed, workflowStep: step,
        activeId: project.datasets.some((dataset: Dataset) => dataset.id === project.activeId) ? project.activeId : project.datasets[0]?.id ?? '',
        fourPointValues: project.fourPointValues ?? initialFourPointValues,
        xValue: typeof project.xValue === 'string' ? project.xValue : '0',
        yValue: typeof project.yValue === 'string' ? project.yValue : '0',
        mode: step === 'digitize' ? 'point' : 'select',
      }
      }
      let snapshot: ProjectSnapshot
      if (fileData.version === 1) {
        const state = parseChart(fileData)
        const id = crypto.randomUUID()
        snapshot = { name: state.imageName, activeId: id, charts: [{ id, name: state.imageName, state }] }
      } else if (fileData.version === 2 && typeof fileData.name === 'string' && Array.isArray(fileData.charts) && fileData.charts.length) {
        const ids = new Set<string>()
        const imported: ChartRecord[] = fileData.charts.map((chart: ChartRecord) => {
          if (!chart || typeof chart.id !== 'string' || !chart.id || ids.has(chart.id) || typeof chart.name !== 'string' || !chart.name.trim()) throw new Error('Invalid chart name or id')
          ids.add(chart.id)
          return { id: chart.id, name: chart.name, state: parseChart(chart.state) }
        })
        if (!ids.has(fileData.activeChartId)) throw new Error('Invalid active chart')
        snapshot = { name: fileData.name, activeId: fileData.activeChartId, charts: imported }
      } else throw new Error('Unsupported project file')
      applyProject(snapshot)
      if (!fromCloud) setCloudResetKey((key) => key + 1)
      showNotice('Project opened. Saved image processing, calibration and datasets were restored.')
      return true
    } catch (error) {
      if (fromCloud) throw error
      showNotice(error instanceof Error ? `Could not open project: ${error.message}` : 'That project file is invalid or unsupported.', 'error')
      return false
    }
  }

  const resetWorkspaceToBlank = (detachCloud = true) => {
    const id = crypto.randomUUID()
    const fresh: ProjectSnapshot = {
      name: 'Untitled project',
      activeId: id,
      charts: [{ id, name: 'Chart 1', state: blankChart() }],
    }
    pointTrainingBaselines.current = {}
    history.current = null
    setHistoryAvailability({ undo: false, redo: false })
    setShowTable(false)
    setExportMenuOpen(false)
    applyProject(fresh)
    if (detachCloud) {
      setActiveCloudProject(null)
      setCloudResetKey((key) => key + 1)
    }
  }

  const hasWorkspaceWork = () => {
    const snapshot = currentProject()
    if (activeCloudProject) return true
    if (snapshot.name.trim() !== 'Untitled project') return true
    if (snapshot.charts.length > 1) return true
    const first = snapshot.charts[0]
    if (!first) return false
    if (first.name !== 'Chart 1') return true
    return Boolean(
      first.state.imageUrl
      || first.state.sourceImageUrl
      || first.state.datasets.length
      || first.state.xAxis.points.length
      || first.state.yAxis.points.length
      || first.state.corrections.length,
    )
  }

  const startNewProject = (): boolean => {
    if (projectBusy) return false
    if (hasWorkspaceWork() && !window.confirm('Start a new project? The current workspace will be cleared; save it first if needed.')) {
      return false
    }
    resetWorkspaceToBlank(true)
    showNotice('Started a new project.')
    return true
  }

  const requestDeleteProject = () => {
    if (projectBusy) return
    setDeleteProjectError('')
    setDeleteProjectOpen(true)
  }

  const handleActiveCloudProjectDeleted = (deleted: CloudProjectRow) => {
    resetWorkspaceToBlank(false)
    setActiveCloudProject(null)
    showNotice(`Deleted cloud project "${deleted.name}".`)
  }

  const confirmDeleteCurrentProject = async () => {
    setDeletingProject(true)
    setDeleteProjectError('')
    try {
      if (activeCloudProject) {
        const deleteFn = deleteActiveCloudRef.current
        if (!deleteFn) throw new Error('Cloud project service is unavailable.')
        await deleteFn(activeCloudProject)
      } else {
        const deletedName = projectName.trim() || 'Untitled project'
        resetWorkspaceToBlank(true)
        showNotice(`Deleted project "${deletedName}".`)
      }
      setDeleteProjectOpen(false)
    } catch (error) {
      setDeleteProjectError(error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
        ? error.message : 'Could not delete the project.')
    } finally {
      setDeletingProject(false)
    }
  }

  const addCalibrationPoint = (axis: 'x' | 'y') => setMode(axis === 'x' ? 'calibrate-x' : 'calibrate-y')
  const updateScale = (axis: 'x' | 'y', scale: ScaleType) => {
    setCalibrationScales((current) => ({ ...current, [axis]: scale }))
    setCalibrationConfirmed(false)
  }
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
  const confirmCalibration = () => {
    try {
      const nextX = calibrationFromDrafts({ ...xAxis, scale: calibrationScales.x }, calibrationDrafts.x, 'x')
      const nextY = calibrationFromDrafts({ ...yAxis, scale: calibrationScales.y }, calibrationDrafts.y, 'y')
      setXAxis(nextX); setYAxis(nextY); setCalibrationConfirmed(true); setDigitizeUnlocked(true)
      return true
    } catch (error) {
      showNotice(error instanceof Error ? error.message : 'Invalid calibration values.', 'error')
      return false
    }
  }
  const goToStep = (step: WorkflowStep) => {
    if (step === workflowStep || projectBusy || healPreview) return
    if (step !== 'image' && !imagePrepared) return
    if (step === 'digitize' && (!digitizeUnlocked || !confirmCalibration())) return
    if (step === 'calibration') setCalibrationPhase(calibrationConfirmed ? 'values' : 'points')
    if (step !== 'image' && showOriginalPreview && processedImageUrl) setShowOriginalPreview(false)
    setWorkflowStep(step)
    setMode(step === 'calibration' ? (calibrationConfirmed ? 'select' : 'calibrate-edit') : step === 'digitize' ? 'point' : 'select')
    setActivePanel('data')
  }

  return (
    <main className="app-frame" inert={learningWorking} onPointerDownCapture={() => { pointerTransaction.current = true; pointerRecorded.current = false }}>
      <header className="topbar">
        <a className="brand" href="#" aria-label="Plotline home"><span className="brand-mark"><span /><span /><span /></span><span>plotline</span><span className="brand-divider" /><span className="brand-subtitle">DIGITIZER</span></a>
        <div className="project-name"><span className="project-file-icon"><FileImage size={14} /></span><input aria-label="Project name" value={projectName} onChange={(event) => setProjectName(event.target.value)} /><span className="saved-status" title={activeCloudProject ? `Linked to cloud project "${activeCloudProject.name}"` : 'Stored in current browser session'}><span /> {activeCloudProject ? 'Cloud project' : 'Browser session'}</span></div>
        <div className="top-actions" inert={Boolean(rotationPreview)}>
          <button className="top-quiet" disabled={projectBusy} onClick={() => { startNewProject() }}><FilePlus2 size={15} /> New project</button>
          <button className="top-quiet" disabled={projectBusy} onClick={() => projectInput.current?.click()}><FolderOpen size={15} /> Open project</button>
          <button className="top-quiet" disabled={projectBusy} onClick={() => setCloudOpen(true)}><FolderOpen size={15} /> Cloud projects</button>
          <button className="top-quiet" disabled={Boolean(preprocessing || loading || gridDetecting || exporting || deletingProject)} onClick={() => void exportProject()}><ArrowDownToLine size={15} /> Save project</button>
          <button className="top-quiet top-danger" disabled={projectBusy} onClick={requestDeleteProject} title={activeCloudProject ? `Delete cloud project "${activeCloudProject.name}"` : 'Delete current project'}><Trash2 size={15} /> Delete project</button>
          <div className="export-control" ref={exportMenu}>
            <button className="export-top export-main" onClick={() => { setExportMenuOpen(false); void exportExcel() }} disabled={projectBusy}><FileSpreadsheet size={15} /> Export Excel</button>
            <button ref={exportMenuButton} className="export-top export-toggle" aria-label="Other export formats" aria-expanded={exportMenuOpen} aria-controls="export-formats" disabled={projectBusy} onClick={() => setExportMenuOpen((open) => !open)}><ChevronDown size={15} /></button>
            {exportMenuOpen && <div className="export-menu" id="export-formats">
              <button disabled={projectBusy || !activeDataset?.points.length} onClick={() => { setExportMenuOpen(false); exportDataset(activeDataset, 'csv') }}>CSV · current dataset</button>
              <button disabled={projectBusy} onClick={() => { setExportMenuOpen(false); exportAllJson() }}>JSON · current chart</button>
            </div>}
          </div>
        </div>
      </header>

      <nav className="chart-tabs" aria-label="Project charts">
        <div
          ref={chartTabList}
          className="chart-tab-list"
          role="tablist"
          aria-label="Charts"
          onDragOver={(event) => {
            if (!draggedChartId.current || projectBusy || event.target !== event.currentTarget) return
            const last = charts[charts.length - 1]
            if (!last || last.id === draggedChartId.current) return
            event.preventDefault()
            event.dataTransfer.dropEffect = 'move'
            setChartDropTarget((current) => current?.id === last.id && current.after ? current : { id: last.id, after: true })
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node)) setChartDropTarget(null)
          }}
          onDrop={(event) => {
            if (!draggedChartId.current || projectBusy || event.target !== event.currentTarget) return
            const last = charts[charts.length - 1]
            if (!last || last.id === draggedChartId.current) return
            event.preventDefault()
            event.stopPropagation()
            reorderChartTabs(draggedChartId.current, last.id, true)
            draggedChartId.current = null; setDraggingChartId(null); setChartDropTarget(null)
          }}
        >
          {charts.map((chart) => {
            const canDrag = !projectBusy && charts.length > 1 && editingChartName?.id !== chart.id
            return <div
              key={chart.id}
              draggable={canDrag}
              className={`chart-tab-item ${chart.id === activeChartId ? 'active' : ''} ${draggingChartId === chart.id ? 'dragging' : ''} ${chartDropTarget?.id === chart.id ? chartDropTarget.after ? 'drop-after' : 'drop-before' : ''}`}
              onDragStart={(event) => {
                if (!canDrag) { event.preventDefault(); return }
                draggedChartId.current = chart.id
                setDraggingChartId(chart.id)
                event.dataTransfer.effectAllowed = 'move'
                event.dataTransfer.setData('text/plain', chart.id)
              }}
              onDragOver={(event) => {
                if (!draggedChartId.current || draggedChartId.current === chart.id || projectBusy) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                const rect = event.currentTarget.getBoundingClientRect()
                const after = event.clientX > rect.left + rect.width / 2
                setChartDropTarget((current) => current?.id === chart.id && current.after === after ? current : { id: chart.id, after })
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                  setChartDropTarget((current) => current?.id === chart.id ? null : current)
                }
              }}
              onDrop={(event) => {
                if (!draggedChartId.current || draggedChartId.current === chart.id || projectBusy) return
                event.preventDefault()
                event.stopPropagation()
                const rect = event.currentTarget.getBoundingClientRect()
                const after = event.clientX > rect.left + rect.width / 2
                reorderChartTabs(draggedChartId.current, chart.id, after)
                draggedChartId.current = null; setDraggingChartId(null); setChartDropTarget(null)
              }}
              onDragEnd={() => {
                draggedChartId.current = null; setDraggingChartId(null); setChartDropTarget(null)
              }}
            >
              {editingChartName?.id === chart.id
                ? <form onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) saveChartName() }} onSubmit={(event) => { event.preventDefault(); saveChartName() }}><input autoFocus aria-label={`Rename chart ${chart.name}`} value={editingChartName.value} onChange={(event) => setEditingChartName({ id: chart.id, value: event.target.value })} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setEditingChartName(null) } }} /><button type="submit" aria-label="Confirm chart name"><Check size={13} /></button></form>
                : <><button role="tab" title={charts.length > 1 ? `${chart.name} · Drag to reorder (Alt+←/→)` : chart.name} aria-selected={chart.id === activeChartId} disabled={projectBusy} onClick={() => switchChart(chart.id)} onKeyDown={(event) => { if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) { event.preventDefault(); moveChartTab(chart.id, event.key === 'ArrowLeft' ? -1 : 1) } }}>{chart.name}</button><button className="chart-tab-action" disabled={projectBusy} title="Rename chart" aria-label={`Rename chart ${chart.name}`} onClick={() => setEditingChartName({ id: chart.id, value: chart.name })}><Pencil size={12} /></button><button className="chart-tab-action" disabled={projectBusy || charts.length < 2} title="Delete chart" aria-label={`Delete chart ${chart.name}`} onClick={() => deleteChart(chart.id)}><Trash2 size={12} /></button></>}
            </div>
          })}
        </div>
        <button className="chart-add" onClick={addChart} disabled={projectBusy} aria-label="Add chart" title="Add chart">+</button>
      </nav>

      <div className="type-ribbon" inert={Boolean(pendingTrace || rotationPreview)}><span className="ribbon-label">PLOT TYPE</span><div className="plot-tabs" role="tablist" aria-label="Plot type">
        {plotOptions.map(({ id, label, icon: Icon }) => <button key={id} role="tab" aria-selected={plotType === id} className={plotType === id ? 'plot-tab active' : 'plot-tab'} onClick={() => { setPlotType(id); setMode(workflowStep === 'digitize' ? (id === 'compressor' ? 'surge' : 'point') : 'select') }}><Icon size={15} /><span>{label}</span></button>)}
      </div><span className="type-ribbon-spacer" /><button className="icon-action" aria-label="Help" title="Click to add calibration or digitized points. Right-click for canvas actions." onClick={() => showNotice('Set X/Y calibration, choose Add points, then click the chart. Right-click for canvas actions.')}><CircleHelp size={17} /></button></div>

      <nav className="workflow-tabs" aria-label="Workflow steps">
        {steps.map((step, index) => {
          const accessible = step.id === 'image' || (imagePrepared && (step.id === 'calibration' || digitizeUnlocked))
          return <button key={step.id} type="button" className={`workflow-tab ${index === currentStepIndex ? 'current' : accessible ? 'complete' : 'locked'}`} aria-current={index === currentStepIndex ? 'step' : undefined} disabled={index === currentStepIndex || !accessible || projectBusy || Boolean(healPreview)} onClick={() => goToStep(step.id)} title={!accessible ? 'Complete the previous steps first' : index === currentStepIndex ? 'Current step' : 'Open step'}><span className="workflow-number">{index !== currentStepIndex && accessible ? <Check size={14} /> : `0${index + 1}`}</span><span className="workflow-label"><strong>{step.label}</strong><small>{step.caption}</small></span></button>
        })}
      </nav>

      <div className="workspace">
        <aside className="left-rail" inert={Boolean(pendingTrace || rotationPreview || gridDetecting)}>
          <div className="rail-section"><div className="rail-heading"><span>TOOLS</span></div>
            {workflowStep === 'calibration' && calibrationPhase === 'points' && <><div className="tool-group-label">CALIBRATION</div>
            <button className={`tool-button ${mode === 'calibrate-x' ? 'selected' : ''}`} onClick={() => addCalibrationPoint('x')} disabled={!imagePrepared}><span className="tool-icon axis-x-icon">X</span><span>Calibrate X axis</span><kbd>{xAxis.points.length}/2</kbd></button>
            <button className={`tool-button ${mode === 'calibrate-y' ? 'selected' : ''}`} onClick={() => addCalibrationPoint('y')} disabled={!imagePrepared}><span className="tool-icon axis-y-icon">Y</span><span>Calibrate Y axis</span><kbd>{yAxis.points.length}/2</kbd></button>
            <button className={`tool-button ${mode === 'calibrate-edit' ? 'selected' : ''}`} onClick={() => setMode(mode === 'calibrate-edit' ? 'select' : 'calibrate-edit')} disabled={!imagePrepared || xAxis.points.length + yAxis.points.length === 0}><span className="tool-icon"><MoveUpRight size={16} /></span><span>Modify calibration</span><kbd>C</kbd></button>
            </>}
            {workflowStep === 'digitize' && <><div className="tool-group-label tool-gap">DIGITIZE</div>
            <button className="tool-button" onClick={() => { void smartAutoExtractPoints() }} disabled={!imagePrepared || loading || preprocessing} title="Automatically trace all curves through crossings and place curvature-adaptive points on curve centerlines"><span className="tool-icon"><Sparkles size={16} /></span><span>Smart auto points (AI)</span></button>
            <button className={`tool-button ${mode === 'trace-region' ? 'selected' : ''}`} onClick={() => setMode('trace-region')} disabled={!imagePrepared}><span className="tool-icon"><Crosshair size={16} /></span><span>Paint curve region</span><kbd>A</kbd></button>
            <button className={`tool-button ${mode === 'point' ? 'selected' : ''}`} onClick={pressPointTool} disabled={!imagePrepared}><span className="tool-icon"><Crosshair size={16} /></span><span>Manual points</span><kbd>P</kbd></button>
            <button className={`tool-button ${mode === 'point-edit' ? 'selected' : ''}`} onClick={() => setMode(mode === 'point-edit' ? 'select' : 'point-edit')} disabled={!imagePrepared || !totalPoints}><span className="tool-icon"><MousePointer2 size={16} /></span><span>Modify curve points</span><kbd>M</kbd></button>
            <div className="tool-split">
              <button className="tool-button" onClick={() => { void snapPointsToCurve('selected') }} disabled={!imagePrepared || loading || !datasets.some((dataset) => (selectedDatasetIds.length > 1 ? selectedDatasetIds.includes(dataset.id) : dataset.id === activeDataset?.id) && dataset.kind !== 'measurement' && dataset.points.length > 0)} title={`Align slightly off-curve points in the active/selected dataset onto the curve centerline (radius ${Math.round(interactionModel.snapRadius)} px)`}><span className="tool-icon"><Magnet size={16} /></span><span>Snap to curve</span></button>
              <button className="tool-sub-action" onClick={() => { void snapPointsToCurve('all') }} disabled={!imagePrepared || loading || !datasets.some((dataset) => dataset.kind !== 'measurement' && dataset.points.length > 0)} aria-label="Snap all datasets to curve" title={`Snap ALL curve datasets in this chart onto the curve centerline (radius ${Math.round(interactionModel.snapRadius)} px)`}>All</button>
            </div>
            <button className="tool-button" onClick={retraceActiveDataset} disabled={!imagePrepared || loading || activePoints < 2}><span className="tool-icon"><ScanSearch size={16} /></span><span>Retrace edited curve</span></button>
            <button className={`tool-button ${mode === 'measure' ? 'selected' : ''}`} onClick={() => setMode('measure')} disabled={!imagePrepared}><span className="tool-icon"><Ruler size={16} /></span><span>Measure angle / distance</span></button>
            {plotType === 'compressor' && <>
              <div className="tool-group-label tool-gap">COMPRESSOR MAP</div>
              <button className={`tool-button ${mode === 'surge' ? 'selected' : ''}`} onClick={() => { const target = datasets.find((dataset) => dataset.kind === 'surge'); if (target) activateDataset(target.id); else activateDataset(''); setMode('surge') }}><span className="tool-icon boundary-icon">S</span><span>Surge boundary</span><kbd>{datasets.some((dataset) => dataset.kind === 'surge' && dataset.points.length >= 2) ? <Check size={13} /> : '—'}</kbd></button>
              <button className={`tool-button ${mode === 'choke' ? 'selected' : ''}`} onClick={() => { const target = datasets.find((dataset) => dataset.kind === 'choke'); if (target) activateDataset(target.id); else activateDataset(''); setMode('choke') }}><span className="tool-icon boundary-icon choke-icon">C</span><span>Choke boundary</span><kbd>{datasets.some((dataset) => dataset.kind === 'choke' && dataset.points.length >= 2) ? <Check size={13} /> : '—'}</kbd></button>
              <button className={`tool-button ${mode === 'speed' ? 'selected' : ''}`} onClick={() => addDataset('speed')}><span className="tool-icon"><Gauge size={16} /></span><span>New speed line</span><kbd>RPM</kbd></button>
              <button className={`tool-button ${activeDataset?.kind === 'efficiency' ? 'selected' : ''}`} onClick={() => addDataset('efficiency')}><span className="tool-icon"><Activity size={16} /></span><span>Efficiency contour</span></button>
            </>}
            </>}
            <div className="tool-group-label tool-gap">IMAGE</div>
            <button className={`tool-button ${mode === 'crop' ? 'selected' : ''}`} onClick={() => setMode('crop')} disabled={!imagePrepared}><span className="tool-icon"><Crop size={16} /></span><span>Crop image</span></button>
            <button className="tool-button" onClick={() => imageInput.current?.click()}><span className="tool-icon"><ImagePlus size={16} /></span><span>Replace image</span></button>
            <div className="transform-grid"><button title="Rotate left" aria-label="Rotate left" onClick={() => void applyImageTransform('rotate-left')}><RotateCcw size={15} /></button><button title="Rotate right" aria-label="Rotate right" onClick={() => void applyImageTransform('rotate-right')}><RotateCw size={15} /></button><button title="Flip horizontal" aria-label="Flip horizontal" onClick={() => void applyImageTransform('flip-x')}><FlipHorizontal size={15} /></button><button title="Flip vertical" aria-label="Flip vertical" onClick={() => void applyImageTransform('flip-y')}><FlipVertical size={15} /></button></div>
          </div>
          <div className="rail-bottom"><span className="connection-indicator" /><span>{onlineConfiguration.config ? 'Supabase AI sync active' : 'Learning stays on this device'}</span><button title="Settings" aria-label="Settings" onClick={() => setActivePanel(activePanel === 'settings' ? 'data' : 'settings')}><Settings2 size={15} /></button></div>
        </aside>

        <section className="center-workspace" aria-label="Plot workspace">
          <div className="workspace-toolbar"><div className="toolbar-left"><span className="breadcrumb-root">Workspace</span><span className="breadcrumb-separator">/</span><span className="breadcrumb-active">{charts.find((chart) => chart.id === activeChartId)?.name}</span><span className="image-badge">{imageUrl ? 'IMAGE LOADED' : 'NO IMAGE'}</span></div><div className="toolbar-right" inert={Boolean(rotationPreview)}><button onClick={toggleCompare} disabled={!processedImageUrl || !sourceImageUrl || mode === 'prep-straighten'} aria-label={showOriginalPreview ? 'Show reconstruction' : 'Compare original'} title={showOriginalPreview ? 'Show reconstruction' : 'Compare original'} aria-pressed={showOriginalPreview}><Eye size={14} /> {showOriginalPreview ? 'Show reconstruction' : 'Compare original'}</button><button onClick={() => setShowBackground((current) => !current)} disabled={!imageUrl || mode === 'prep-straighten'} aria-pressed={showBackground}>{showBackground ? 'Hide image' : 'Show image'}</button><button title="Undo (Ctrl+Z)" onClick={() => changeHistory('undo')} disabled={projectBusy || !historyAvailability.undo}><Undo2 size={14} /> Undo</button><button title="Redo (Ctrl+Shift+Z)" onClick={() => changeHistory('redo')} disabled={projectBusy || !historyAvailability.redo}><Redo2 size={14} /> Redo</button><span className="toolbar-separator" /><button title="Show point table" disabled={workflowStep !== 'digitize'} className={showTable && workflowStep === 'digitize' ? 'toolbar-active' : ''} onClick={() => setShowTable(!showTable)}><Layers size={14} /> Data table</button></div></div>
          {plotType === 'compressor' && <div className="compressor-banner"><Gauge size={15} /><span><strong>Compressor map mode</strong> · Trace speed/IGV and efficiency curves directly; boundaries optionally stop speed traces.</span><span className="boundary-progress"><i className={datasets.some((dataset) => dataset.kind === 'surge' && dataset.points.length >= 2) ? 'complete' : ''} />Surge <i className={datasets.some((dataset) => dataset.kind === 'choke' && dataset.points.length >= 2) ? 'complete' : ''} />Choke</span></div>}
          <div className={`canvas-zone ${dragActive ? 'drag-active' : ''}`} onDragEnter={(event) => { event.preventDefault(); setDragActive(true) }} onDragOver={(event) => event.preventDefault()} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragActive(false) }} onDrop={(event) => { event.preventDefault(); setDragActive(false); const file = Array.from(event.dataTransfer.files).find((item) => item.type.startsWith('image/')); if (file) openImage(file) }}>
            <PlotCanvas imageUrl={rotationPreview?.url ?? (showOriginalPreview ? sourceImageUrl : imageUrl)} imageDisplayMode={imageDisplayMode} displayImageUrl={!rotationPreview && !showOriginalPreview && processedImageUrl ? processedPreviewUrl : null} onImageError={() => showNotice('Could not load the plot image or upscaled preview.', 'error')} onSaveError={(message) => showNotice(message, 'error')} imageName={imageName} imageLabel={rotationPreview ? 'Rotation preview — not applied' : showOriginalPreview ? 'Original scan' : processedImageUrl ? 'Reconstructed plot' : 'Original image'} showBackground={Boolean(rotationPreview) || showBackground} datasets={previewDatasets} activeDatasetId={activeId} selectionVersion={pointSelectionVersion} selectedPointHint={selectedPointHint} onSelectDataset={activateDataset} mode={mode} gridGuides={!rotationPreview && showGuides && mode !== 'prep-straighten' ? gridGuides : { horizontal: [], vertical: [] }} axisGuides={!rotationPreview && showGuides && mode !== 'prep-straighten' ? axisGuides : { horizontal: null, vertical: null }} plotRegion={!rotationPreview && showGuides && mode !== 'prep-straighten' ? plotRegion : null}
              calibrationMarkers={rotationPreview || mode === 'prep-straighten' || (calibrationConfirmed && mode !== 'calibrate-edit') ? [] : [
                ...xAxis.points.map((point, index) => ({ axis: 'x' as const, index, point, value: point.value, label: `X${index + 1}` })),
                ...yAxis.points.map((point, index) => ({ axis: 'y' as const, index, point, value: point.value, label: `Y${index + 1}` })),
              ]}
              calibrationMarkerColor={calibrationMarkerColor}
              pointMarkerSize={pointMarkerSize}
              showCalibrationMarkers={!calibrationConfirmed || mode === 'calibrate-edit'}
              xAxis={workflowStep === 'calibration' ? blankAxis() : xAxis}
              yAxis={workflowStep === 'calibration' ? blankAxis() : yAxis}
              coordinateLabels={plotType === 'compressor'
                ? { x: axisName(compressorAxes.x), y: axisName(compressorAxes.y) }
                : { x: 'X', y: 'Y' }}
              coordinateScales={{ x: xAxis.scale, y: yAxis.scale }}
              traceBrushWidth={traceBrushWidth}
              brushGroup={brushGroup}
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
              readOnly={Boolean(pendingTrace || rotationPreview || gridDetecting)}
              onCanvasClick={(point) => { void handleCanvasClick(point) }} onDeletePoint={deleteNearestPoint} canDeletePoint={workflowStep === 'digitize'}
              onDeleteSelectedPoint={deletePointAtIndex}
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
              onPointMoveEnd={handlePointMoveEnd}
              onMoveCalibrationPoint={updateCalibrationPoint}
              onTraceRegion={tracePaintedRegion} />
            {!imageUrl && <button className="upload-overlay" onClick={() => imageInput.current?.click()}><Upload size={15} /> Choose image</button>}
          </div>
          <div className="mode-strip"><span className="mode-symbol"><MousePointer2 size={14} /></span><span className="mode-text"><strong>{pendingTrace ? 'Review points' : !imageUrl ? 'Upload image' : workflowStep === 'calibration' && calibrationPhase === 'values' ? 'Enter calibration values' : modeLabels[mode]}</strong>{pendingTrace ? ' · Compare the new curves, then confirm or discard them.' : !imageUrl ? ' · Paste or drop a plot image, or choose a file.' : mode === 'prep-heal' ? ' · Brush over one gap, then choose and review a connection.' : mode === 'prep-region' ? ' · Drag around the plot area, including its axes.' : mode === 'prep-erase' ? ' · Click or drag to erase the selected layer.' : mode === 'prep-draw' || mode === 'prep-line' ? ' · Drag over the image to edit the reconstruction.' : mode === 'grid-horizontal' || mode === 'grid-vertical' ? ' · Click adjacent grid lines on the original, then process again.' : mode === 'guide-axis-x' || mode === 'guide-axis-y' ? ' · Click the axis on the original, then process again.' : !imagePrepared ? ' · Process, compare and correct the reconstruction before confirming.' : workflowStep === 'calibration' && calibrationPhase === 'values' ? ' · Enter the actual values for the labeled markers.' : mode === 'calibrate-four' ? ` · Click ${(['X1', 'X2', 'Y1', 'Y2'][fourPointPixels.length] ?? 'the next reference point')} on the chart.` : mode === 'calibrate-intersections' ? ` · Click intersection ${fourPointPixels.length + 1}, corresponding to X${fourPointPixels.length + 1} and Y${fourPointPixels.length + 1}.` : mode === 'calibrate-edit' ? ' · Click or drag a calibration marker; arrow keys move 1 px, Shift + arrows 10 px.' : mode === 'point-edit' || mode === 'select' ? ' · Select a curve point, then drag or use arrow keys to fine-tune; Shift moves 10 px. In Modify mode, Delete removes the selected point.' : mode === 'trace-region' ? ' · Auto paint only marks regions; refine the paint, then use Get points to extract and learn from your edits.' : mode === 'speed' ? ' · Click a speed line, or use Paint curve region to guide it.' : mode === 'surge' || mode === 'choke' ? ' · Click sequentially along the compressor boundary.' : ' · Click to add a point; use arrow keys right away to nudge (Shift moves 10 px).'}</span><span className="mode-spacer" />{loading ? <span className="tracing-state"><span className="loader-dot" /> Tracing…</span> : !pendingTrace && workflowStep !== 'calibration' && <span className="keyboard-tip"><kbd>Esc</kbd> select · <kbd>M</kbd> modify</span>}</div>
          {showTable && workflowStep === 'digitize' && <div className="data-table-panel">
            <div className="data-table-head">
              <strong>{activeDataset?.name ?? 'Dataset'} · calibrated values</strong>
              <span>{calibrated ? `${calibratedPoints.length} points` : 'Set both axes to show data values'} · Edit pixel coordinates to fine-tune</span>
            </div>
            <div className="data-table-scroll"><table><thead><tr><th>#</th><th>{exportAxisLabel(chartState, 'x', true, 'X')}</th><th>{exportAxisLabel(chartState, 'y', true, 'Y')}</th><th>Pixel X</th><th>Pixel Y</th></tr></thead>
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
              onContinue={() => { if (healPreview) { showNotice('Apply or discard the proposed connection before continuing.', 'error'); return }; confirmPreparedImage() }} />}
            {imagePrepared && <>
            {workflowStep === 'calibration' && <><section className="panel-section calibration-section"><div className="section-heading"><div><span className="section-kicker">STEP 02</span><h2>Axis calibration</h2></div><span className="calibration-state">{calibrationPhase === 'points' ? '1 / 2' : '2 / 2'}</span></div>
              {calibrationPhase === 'points' ? <>
                <p className="section-copy"><strong>1. Select reference points</strong><br />Select at least two points on each axis. Drag markers to adjust them, then confirm their positions.</p>
                <button className="axis-detect-button" onClick={() => { void calibrateFromDetectedGrid() }} disabled={gridDetecting}>
                  <ScanSearch size={14} /> {gridDetecting ? 'Detecting grid…' : 'Auto-detect calibration points'}
                </button>
                <p className="axis-detect-note">Uses the outermost grid lines: X1 left, X2 right, Y1 bottom, Y2 top. Check the markers and enter their actual values.</p>
                {gridDetection && <p className="axis-detect-note">Found {gridDetection.verticalLines.length} vertical × {gridDetection.horizontalLines.length} horizontal lines. Check the markers.</p>}
                <div className="four-point-calibration">
                  <strong>Guided selection</strong>
                  <p>Click X1, X2, Y1 and Y2 in order.</p>
                  <button className="axis-detect-button" disabled={gridDetecting} onClick={() => {
                    setXAxis((current) => ({ ...current, points: [] })); setYAxis((current) => ({ ...current, points: [] }))
                    setCalibrationDrafts({ x: [], y: [] }); setFourPointPixels([]); setCalibrationConfirmed(false); setMode('calibrate-four')
                  }}>{mode === 'calibrate-four' ? 'Restart selection' : 'Select 4 points'}</button>
                </div>
                <p className="axis-detect-note">X: {xAxis.points.length} points · Y: {yAxis.points.length} points</p>
                <details><summary>Other selection methods</summary>
                  <p className="axis-detect-note">Use the X/Y tools to add individual points, or select two intersections.</p>
                  <button className="axis-detect-button" disabled={gridDetecting} onClick={() => {
                    setXAxis((current) => ({ ...current, points: [] })); setYAxis((current) => ({ ...current, points: [] }))
                    setCalibrationDrafts({ x: [], y: [] }); setFourPointPixels([]); setCalibrationConfirmed(false); setMode('calibrate-intersections')
                  }}>Select 2 intersections</button>
                  <button className="axis-detect-button" disabled={gridDetecting} onClick={() => { void detectAxes() }}><ScanSearch size={14} /> Auto-detect axes & origin</button>
                  {axisDetection && <p className="axis-detect-note">Intersection near {Math.round(axisDetection.intersection.x)}, {Math.round(axisDetection.intersection.y)} px · verify against the scan.</p>}
                </details>
                <button className="axis-detect-button calibration-primary" disabled={gridDetecting} onClick={() => {
                  try {
                    for (const [axis, coordinate] of [[xAxis, 'x'], [yAxis, 'y']] as const) {
                      calibrationFromDrafts({ ...axis, scale: 'linear' }, axis.points.map((_, index) => String(index + 1)), coordinate)
                    }
                    setCalibrationPhase('values'); setMode('select')
                  } catch (error) { showNotice(error instanceof Error ? error.message : 'Invalid reference points.', 'error') }
                }}>Confirm positions</button>
              </> : <>
                <p className="section-copy"><strong>2. Enter actual values</strong><br />Enter the value corresponding to each labeled marker, select the axis scales and optionally enter units.</p>
                {(['x', 'y'] as const).map((axis) => <AxisEditor key={axis} axis={axis}
                  coordinateLabel={plotType === 'compressor' ? axisName(compressorAxes[axis]) : axis.toUpperCase()}
                  calibration={axis === 'x' ? xAxis : yAxis} scale={calibrationScales[axis]} drafts={calibrationDrafts[axis]}
                  unit={plotType === 'compressor' ? compressorAxes[axis].unit : axisUnits[axis]}
                  setUnit={(value) => plotType === 'compressor' ? updateCompressorAxis(axis, { unit: value }) : setAxisUnits((current) => ({ ...current, [axis]: value }))}
                  setScale={updateScale} updatePointValue={(index, value) => {
                    setCalibrationDrafts((current) => ({ ...current, [axis]: current[axis].map((draft, draftIndex) => draftIndex === index ? value : draft) }))
                    setCalibrationConfirmed(false)
                  }} />)}
                <div className="calibration-confirm-row">
                  <button className="axis-detect-button" onClick={() => { setCalibrationPhase('points'); setMode('calibrate-edit') }}>Back to positions</button>
                  <button className="axis-detect-button calibration-primary" onClick={() => {
                    if (confirmCalibration()) { setWorkflowStep('digitize'); setMode('point') }
                  }}>Confirm calibration & continue</button>
                </div>
              </>}
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
            <section className="panel-section datasets-section"><div className="section-heading dataset-heading"><div><span className="section-kicker">STEP 03</span><h2>Datasets <span className="count-pill">{datasets.length}</span></h2></div><button className="add-small" aria-label="Add dataset" disabled={Boolean(pendingTrace)} onClick={() => addDataset()} title="Add dataset">+</button></div>
              <div className="dataset-bulk-actions"><span>{selectedDatasetIds.length ? `${selectedDatasetIds.length} selected` : 'Select multiple'}</span><button disabled={!imagePrepared || loading || Boolean(pendingTrace) || !datasets.some((dataset) => dataset.kind !== 'measurement' && dataset.points.length > 0)} onClick={() => { void snapPointsToCurve('all') }} title={`Snap all curve datasets onto the curve centerline (radius ${Math.round(interactionModel.snapRadius)} px)`}>Snap all</button><button disabled={selectedDatasetIds.length < 2} onClick={mergeSelectedDatasets} title="Merge selected datasets">Merge</button><button className="bulk-delete" disabled={selectedDatasetIds.length < 2} onClick={deleteSelectedDatasets} title="Delete selected datasets">Delete</button><button className="bulk-delete" disabled={!datasets.some((dataset) => dataset.points.length) || Boolean(pendingTrace)} onClick={clearData}>Clear data</button></div>
              <label className="range-row"><span>Curve point marker size</span><strong>{pointMarkerSize}%</strong><input aria-label="Curve point marker size" type="range" min="25" max="200" step="25" value={pointMarkerSize} onChange={(event) => setPointMarkerSize(Number(event.target.value))} /></label>
              <label className="format-control"><span>Insert manual points by X</span><input aria-label="Insert manual points between X neighbors" type="checkbox" checked={insertPointsByX} onChange={(event) => setInsertPointsByX(event.target.checked)} /></label>
              <p className="dataset-selection-hint">Drag the handle to reorder. Shift-click a range or Ctrl/Cmd-click datasets to select several.{pendingTrace ? ' During review, only new datasets can be reordered, merged or deleted.' : ''}</p>
              <div className="dataset-list">{datasets.map((dataset) => <div key={dataset.id} className={`dataset-card ${dataset.id === activeId ? 'active' : ''} ${selectedDatasetIds.includes(dataset.id) ? 'multi-selected' : ''} ${datasetDropTarget?.id === dataset.id ? datasetDropTarget.after ? 'drop-after' : 'drop-before' : ''}`}
                onDragOver={(event) => { if (draggedDatasetId.current && draggedDatasetId.current !== dataset.id && (!pendingTrace || (pendingTrace.ids.includes(draggedDatasetId.current) && pendingTrace.ids.includes(dataset.id)))) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; const after = event.clientY > event.currentTarget.getBoundingClientRect().top + event.currentTarget.offsetHeight / 2; setDatasetDropTarget((current) => current?.id === dataset.id && current.after === after ? current : { id: dataset.id, after }) } }}
                onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDatasetDropTarget(null) }}
                onDrop={(event) => { if (!draggedDatasetId.current || (pendingTrace && (!pendingTrace.ids.includes(draggedDatasetId.current) || !pendingTrace.ids.includes(dataset.id)))) return; event.preventDefault(); event.stopPropagation(); const after = event.clientY > event.currentTarget.getBoundingClientRect().top + event.currentTarget.offsetHeight / 2; const id = draggedDatasetId.current; setDatasets((current) => reorderDatasets(current, id, dataset.id, after)); draggedDatasetId.current = null; setDatasetDropTarget(null) }}
              >
                <div className="dataset-row">
                {(!pendingTrace || pendingTrace.ids.includes(dataset.id)) && <button className="dataset-drag" draggable aria-label={`Reorder ${dataset.name}`} title="Drag to reorder; arrow keys move the dataset" onDragStart={(event) => { draggedDatasetId.current = dataset.id; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', dataset.id) }} onDragEnd={() => { draggedDatasetId.current = null; setDatasetDropTarget(null) }} onKeyDown={(event) => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); moveDataset(dataset.id, event.key === 'ArrowUp' ? -1 : 1) } }}><GripVertical size={14} /></button>}
                <div className="dataset-entry">
                  <button className="dataset-select" onClick={(event) => selectDataset(dataset, event.ctrlKey || event.metaKey, event.shiftKey)} onKeyDown={(event) => { if (event.key === 'Delete' && selectedDatasetIds.length > 1) { event.preventDefault(); event.stopPropagation(); deleteSelectedDatasets() } }} aria-label={`Select ${dataset.name}`} aria-pressed={selectedDatasetIds.includes(dataset.id)} />
                  <label className="dataset-swatch" title="Change dataset color"><input aria-label={`Color ${dataset.name}`} type="color" disabled={Boolean(pendingTrace)} value={dataset.color} onChange={(event) => updateDataset(dataset.id, (current) => ({ ...current, color: event.target.value }))} /><span style={{ backgroundColor: dataset.color }} /></label>
                  <span className="dataset-meta">
                    <span className="dataset-title">{editingDatasetName?.id === dataset.id ? <form className="dataset-name-editor" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) saveDatasetName() }} onSubmit={(event) => { event.preventDefault(); saveDatasetName() }}><input autoFocus aria-label={`Rename ${dataset.name}`} value={editingDatasetName.value} onChange={(event) => setEditingDatasetName({ id: dataset.id, value: event.target.value })} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setEditingDatasetName(null) } }} /><button type="submit" title="Confirm name" aria-label="Confirm name"><Check size={12} /></button></form> : <><span className="dataset-name">{dataset.name}</span>{!pendingTrace && <button className="dataset-edit-name" title="Rename dataset" aria-label={`Rename ${dataset.name}`} onClick={() => setEditingDatasetName({ id: dataset.id, value: dataset.name })}><Pencil size={12} /></button>}</>}</span>
                    <span className="dataset-detail">{dataset.kind === 'speed' ? `${dataset.rpm?.toLocaleString() ?? '—'} ${dataset.speedUnit || 'RPM'}${dataset.igv === undefined ? '' : ` · IGV ${dataset.igv}${dataset.igvUnit ? ` ${dataset.igvUnit}` : ''}`}` : dataset.kind === 'efficiency' ? `${dataset.efficiencyValue ?? '—'}% contour` : dataset.kind === 'surge' ? 'Surge boundary' : dataset.kind === 'choke' ? 'Choke boundary' : `${dataset.points.length} points`}</span>
                  </span>
                  <span className="dataset-point-count">{dataset.points.length}</span>
                </div>
                {(pendingTrace || selectedDatasetIds.length < 2) && <button className="dataset-delete" title="Delete dataset" aria-label={`Delete ${dataset.name}`} disabled={Boolean(pendingTrace && !pendingTrace.ids.includes(dataset.id))} onClick={() => deleteDataset(dataset.id)}><Trash2 size={14} /><span>Delete</span></button>}
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
            {mode === 'trace-region' || mode === 'speed' || (mode === 'point-edit' && brushMarks.some((mark) => !mark.erase)) ? <section className="panel-section extraction-section">
              <div className="section-heading"><div><span className="section-kicker">CURVE EXTRACTION</span><h2>{mode === 'trace-region' ? 'Painted curve finder' : 'Automatic curve finder'}</h2></div><ScanSearch size={16} /></div>
              <p className="section-copy">{mode === 'speed' ? <>Click the speed line, or use Paint curve region for a guided trace. Sampled color <span className="color-chip" style={{ backgroundColor: `rgb(${seedColor.join(',')})` }} /> RGB {seedColor.join(', ')}</> : 'Auto paint marks likely curve regions only. Add or erase paint manually, then press Get points to extract and learn from your edits.'}</p>
              <label className="range-row"><span>Color tolerance</span><strong>{tolerance}</strong><input aria-label="Curve color tolerance" type="range" min="12" max="180" disabled={mode === 'trace-region' && (showOriginalPreview || !processedImageUrl || Boolean(reconstruction && !needsProcess))} value={tolerance} onChange={(event) => setTolerance(Number(event.target.value))} /></label>
              <label className="range-row"><span>Point spacing</span><strong>{sampleStep} px</strong><input aria-label="Curve point spacing" type="range" min="1" max="60" value={sampleStep} onChange={(event) => setSampleStep(Number(event.target.value))} /></label>
              <label className="range-row"><span>Paint brush width</span><strong>{traceBrushWidth} px</strong><input aria-label="Curve brush width" type="range" min="8" max="72" step="2" value={traceBrushWidth} onChange={(event) => setTraceBrushWidth(Number(event.target.value))} /></label>
              {(mode === 'trace-region' || mode === 'point-edit') && <>
                {mode === 'trace-region' && <><div className="brush-groups" role="group" aria-label="Brush color group">{BRUSH_GROUPS.map((group) => <button key={group.color} aria-label={`${group.name} brush`} aria-pressed={brushGroup === group.color} onClick={() => { setBrushGroup(group.color); setBrushErasing(false) }}><span style={{ backgroundColor: group.color }} />{group.name}</button>)}</div><div className="brush-tools" role="group" aria-label="Brush selection tool"><button aria-pressed={!brushErasing} onClick={() => setBrushErasing(false)}>Brush</button><button aria-pressed={brushErasing} onClick={() => setBrushErasing(true)}>Erase selected color</button></div></>}
                <div className="prep-actions trace-actions">
                  {mode === 'trace-region' && <button className="prep-apply clear-brushes" disabled={!imagePrepared || loading || preprocessing} title="Trace all detected curves cleanly through crossings with curvature-adaptive points" onClick={() => { void smartAutoExtractPoints() }}><Sparkles size={13} /> Smart auto points (AI)</button>}
                  {mode === 'trace-region' && <button className="prep-compare" disabled={!imagePrepared || !processedImageUrl || !reconstruction || needsProcess || !learningState?.enabled || ((learningState?.model.samples ?? 0) < 1 && interactionModel.featureSamples < 1) || loading} title="Requires a processed image and an enabled, trained local curve or interaction model" onClick={() => { void autoPaintWithModel() }}><Sparkles size={13} /> Auto paint (ML)</button>}
                  <button className="prep-apply" disabled={!brushMarks.some((mark) => !mark.erase) || loading} onClick={() => { void autoPaintedPoints() }}>{mode === 'point-edit' ? 'Regenerate points' : 'Get points'}</button>
                  <button className="prep-compare clear-brushes" disabled={!brushMarks.length || loading} onClick={() => setBrushMarks([])}>Clear all brushes</button>
                </div>
                <div className="trace-hint">{mode === 'point-edit' ? 'Generated points are editable now. Adjust the extraction settings and regenerate to replace this automatic result.' : 'Auto paint uses the trained local model to mark curve regions; it does not create points. Manual paint additions and removals are learned when you use Get points.'}</div>
              </>}
              <div className="trace-hint"><Sparkles size={13} /> Each color is extracted separately, even where brushes overlap. Short spacing anomalies are filtered while sharp bends are retained. Get points uses the curve layer when available; inspect crossings, gaps and every result. {(pointSpacingModel.samples > 0 || interactionModel.spacingSamples > 0) && `Learned interactions adjust sampling to ${learnedSampleStep} px (from ${sampleStep} px).`}</div>
            </section> : null}
            <div className="panel-footer"><span className="footer-stat"><Crosshair size={13} /> {totalPoints} points</span><span className="footer-stat"><Layers size={13} /> {datasets.length} datasets</span></div>
            </>}
            </>}
          </div> : <div className="panel-content settings-content">
            <section className="panel-section"><div className="section-heading"><div><span className="section-kicker">DISPLAY</span><h2>Image size</h2></div></div><p className="section-copy">Fit keeps the whole image visible without scrollbars. Original size displays one source pixel per CSS pixel and allows scrolling.</p><label className="format-control"><span>Image display</span><select aria-label="Image display" value={imageDisplayMode} onChange={(event) => setImageDisplayMode(event.target.value === 'original' ? 'original' : 'fit')}><option value="fit">Fit in workspace</option><option value="original">Original size</option></select></label></section>
            <section className="panel-section"><div className="section-heading"><div><span className="section-kicker">RECONSTRUCTION</span><h2>Line appearance</h2></div></div><p className="section-copy">Select axes in Process image, or use the leftmost vertical and lowest horizontal lines by default. Verify them against the scan.</p>{(['curve', 'grid', 'axis'] as const).map((kind) => <label className="format-control" key={kind}><span>{kind} color</span><input aria-label={`Reconstructed ${kind} color`} type="color" disabled={preprocessing} value={reconstructionColors[kind]} onChange={(event) => updateReconstructionAppearance({ ...reconstructionColors, [kind]: event.target.value }, reconstructionWidths)} /></label>)}{(['curve', 'grid'] as const).map((kind) => <label className="range-row" key={kind}><span>{kind === 'grid' ? 'Grid and axis' : 'Curve'} thickness</span><strong>{reconstructionWidths[kind]} px</strong><input aria-label={`Reconstructed ${kind} thickness`} type="range" min="0.5" max="8" step="0.5" disabled={preprocessing} value={reconstructionWidths[kind]} onChange={(event) => updateReconstructionAppearance(reconstructionColors, { ...reconstructionWidths, [kind]: Number(event.target.value) })} /></label>)}</section>
            <section className="panel-section"><div className="section-heading"><div><span className="section-kicker">CALIBRATION</span><h2>Marker appearance</h2></div></div><p className="section-copy">The selected calibration point uses this color. Confirmed calibration hides the markers.</p><label className="format-control"><span>Selected marker color</span><input aria-label="Selected calibration marker color" type="color" value={calibrationMarkerColor} onChange={(event) => setCalibrationMarkerColor(event.target.value)} /></label></section>
            <section className="panel-section"><div className="section-heading"><div><span className="section-kicker">IMAGE TOOLS</span><h2>Pre-processing</h2></div></div><p className="section-copy">Apply transforms to the source image before digitizing.</p><div className="settings-transform"><button onClick={() => void applyImageTransform('rotate-left')}><RotateCcw size={15} /> Rotate left</button><button onClick={() => void applyImageTransform('rotate-right')}><RotateCw size={15} /> Rotate right</button><button onClick={() => void applyImageTransform('flip-x')}><FlipHorizontal size={15} /> Flip horizontal</button><button onClick={() => void applyImageTransform('flip-y')}><FlipVertical size={15} /> Flip vertical</button></div></section>
            <section className="panel-section"><div className="section-heading"><div><span className="section-kicker">PROJECT</span><h2>Export & restore</h2></div></div><p className="section-copy">Project files include the source image, calibration and all datasets.</p><button className="settings-action" disabled={projectBusy} onClick={() => { startNewProject() }}><FilePlus2 size={15} /> New project</button><button className="settings-action" onClick={() => void exportProject()}><ArrowDownToLine size={15} /> Save editable project</button><button className="settings-action" onClick={() => projectInput.current?.click()}><FolderOpen size={15} /> Open project file</button><button className="settings-action" onClick={exportAllJson}><FileJson2 size={15} /> Export all datasets as JSON</button><button className="settings-action settings-danger" disabled={projectBusy} onClick={requestDeleteProject}><Trash2 size={15} /> Delete project</button></section>
            <section className="panel-section"><div className="section-heading"><div><span className="section-kicker">DIGITIZING</span><h2>Manual point editing</h2></div></div><p className="section-copy">By default, manually added points are inserted between their nearest X neighbors instead of appended to the end of the dataset.</p><label className="format-control"><span>Insert manual points between X neighbors</span><input aria-label="Settings insert manual points between X neighbors" type="checkbox" checked={insertPointsByX} onChange={(event) => setInsertPointsByX(event.target.checked)} /></label><p className="section-copy">Snap-to-curve search radius: {Math.round(interactionModel.snapRadius)} px (adapts from manual drags &amp; snaps).</p></section>
            <section className="panel-section"><div className="section-heading"><div><span className="section-kicker">PRIVACY</span><h2>{onlineConfiguration.config ? 'Shared learning' : 'Local learning'}</h2></div></div>
              <p className="section-copy">{onlineConfiguration.config ? 'Learning syncs bounded numeric model updates (curve, point-spacing, and interaction AI) to Supabase, never images or raw coordinates. Updates are queued offline in IndexedDB and synced automatically.' : 'Learning stores numeric models and interaction preferences locally in IndexedDB, not training images.'} Grid edits do not train the curve model. Review every result; Undo does not undo learning.</p>
              {learningError ? <p className="section-copy" role="alert">Storage unavailable: {learningError}. Restart the app to retry.</p> : learningState ? <>
                <label className="format-control"><span>Enable learning</span><input type="checkbox" disabled={syncing} checked={learningState.enabled} onChange={(event) => { void setLearningEnabled(event.target.checked) }} /></label>
                <div className="ai-stats-grid">
                  <div className="ai-stat-card"><span>Interactions</span><strong>{totalInteractionCount(interactionModel)}</strong></div>
                  <div className="ai-stat-card"><span>AI updates</span><strong>{learningState.model.samples + interactionModel.featureSamples}</strong></div>
                  <div className="ai-stat-card"><span>Spacing</span><strong>{Math.round(interactionModel.spacingFactor * 100)}%</strong></div>
                  <div className="ai-stat-card"><span>Snap radius</span><strong>{Math.round(interactionModel.snapRadius)} px</strong></div>
                </div>
                <p className="ai-breakdown">{interactionModel.stats.pointsAdded} added · {interactionModel.stats.pointsMoved} moved · {interactionModel.stats.pointsDeleted} deleted · {interactionModel.stats.pointsSnapped} snapped · {interactionModel.stats.healingApplied} healed</p>
                <p className="section-copy">Preferred gap healing: <strong>{['Straight', 'Gentle', 'Tangent curved'][preferredHealingChoice(interactionModel)]}</strong></p>
                {lastComparison && <p className="section-copy">Last curve comparison: {lastComparison[1]} pixels added, {lastComparison[2]} removed, {lastComparison[3]} retained. Counts use exact pixel overlap.</p>}
                <p className="section-copy">Pending online updates: {pendingUpdates}{syncing ? ' · Synchronizing…' : ''}</p>
                {(onlineConfiguration.error || !onlineConfiguration.config) && <p className="section-copy" role="alert">{onlineConfiguration.error ?? 'Supabase is not configured; updates remain on this device.'}</p>}
                {syncError && <p className="section-copy" role="alert">Synchronization failed: {syncError} Updates remain queued.</p>}
                <button className="settings-action" disabled={!learningState.enabled || !onlineConfiguration.config || syncing} onClick={synchronizeLearning}>Retry synchronization</button>
                <button className="settings-action" disabled={syncing} onClick={() => { void clearLearning() }}>Delete local learning data</button>
              </> : <p className="section-copy">Loading local learning settings…</p>}
            </section>
            <section className="panel-section"><div className="section-heading"><div><span className="section-kicker">OUTPUT</span><h2>Data formatting</h2></div></div><p className="section-copy">Apply sort order and numeric precision to generated exports.</p><label className="format-control"><span>Sort points by</span><select aria-label="Export sort order" value={sortBy} onChange={(event) => setSortBy(event.target.value as 'x' | 'y')}><option value="x">X ascending</option><option value="y">Y ascending</option></select></label><label className="format-control precision-control"><span>Significant digits <strong>{precision}</strong></span><input aria-label="Export precision" type="range" min="2" max="12" step="1" value={precision} onChange={(event) => setPrecision(Number(event.target.value))} /></label></section>
            <section className="settings-disclaimer"><CircleHelp size={16} /><p>Project images and extracted datasets are not uploaded by learning. {onlineConfiguration.config ? 'When enabled, bounded numeric learning updates sync to Supabase.' : 'Learning stays on this device.'}</p></section>
          </div>}
        </aside>
      </div>

      <footer className="statusbar"><span className="statusbar-left"><span className="online-dot" /> READY <span className="statusbar-divider">/</span>{imageUrl ? imageName : 'Waiting for image'}</span><span className="statusbar-right"><span>{plotOptions.find((option) => option.id === plotType)?.label}</span><span>·</span><span>{calibrated ? 'Calibrated' : 'Uncalibrated'}</span><span>·</span><span>{totalPoints} points</span><span className="version-tag">v0.2</span></span></footer>

      <input ref={imageInput} type="file" accept="image/*" className="visually-hidden" aria-label="Choose plot image" onChange={(event) => { openImage(event.target.files?.[0]); event.target.value = '' }} />
      <input ref={projectInput} type="file" accept="application/json,.json" className="visually-hidden" aria-label="Open plot project" onChange={(event) => { void importProject(event.target.files?.[0]); event.target.value = '' }} />
      <CloudProjects
        open={cloudOpen}
        onClose={() => setCloudOpen(false)}
        name={projectName}
        resetKey={cloudResetKey}
        saveProject={(name, save) => exportProject({ name, save })}
        openProject={(project) => importProject(new File([JSON.stringify(project)], 'cloud-project.json', { type: 'application/json' }), true)}
        newProject={startNewProject}
        onActiveProjectChange={setActiveCloudProject}
        onActiveProjectDeleted={handleActiveCloudProjectDeleted}
        registerDeleteActive={registerDeleteActive}
      />
      <DeleteProjectDialog
        open={deleteProjectOpen}
        projectName={activeCloudProject ? activeCloudProject.name : (projectName.trim() || 'Untitled project')}
        description={activeCloudProject
          ? 'Permanently delete this cloud project from your account and clear the current workspace? This action cannot be undone.'
          : 'Delete this project and clear all charts, images, calibrations, and datasets in the current workspace? This action cannot be undone.'}
        busy={deletingProject}
        error={deleteProjectError}
        onCancel={() => { if (!deletingProject) { setDeleteProjectOpen(false); setDeleteProjectError('') } }}
        onConfirm={confirmDeleteCurrentProject}
      />
      {notice && <div role="status" className={`toast ${notice.type ?? ''}`}><span className="toast-icon">{notice.type === 'error' ? '!' : <Check size={14} />}</span>{notice.message}<button aria-label="Dismiss message" onClick={() => setNotice(null)}>×</button></div>}
      {loading && <div className="loading-overlay" aria-live="polite"><span className="loading-spinner" /> Following the curve…</div>}
    </main>
  )
}

function AxisEditor({ axis, coordinateLabel, calibration, scale, drafts, unit, setUnit, setScale, updatePointValue }: {
  axis: 'x' | 'y'; coordinateLabel: string; calibration: AxisCalibration; scale: ScaleType; drafts: string[];
  unit: string; setUnit: (value: string) => void;
  setScale: (axis: 'x' | 'y', scale: ScaleType) => void;
  updatePointValue: (index: number, value: string) => void
}) {
  return <div className="axis-editor">
    <div className="axis-editor-top"><span className={`axis-letter axis-${axis}`}>{axis.toUpperCase()}</span><span className="axis-label">{axis === 'x' ? 'Horizontal axis' : 'Vertical axis'}</span><select aria-label={`${axis.toUpperCase()} axis scale`} value={scale} onChange={(event) => setScale(axis, event.target.value as ScaleType)}><option value="linear">Linear</option><option value="log">Log₁₀</option><option value="inverse">Inverse</option><option value="date">Date/time</option></select></div>
    <div className="axis-point-list">{calibration.points.map((point, index) => <label key={index}><span>{axis.toUpperCase()}{index + 1}</span><input aria-label={`${coordinateLabel} calibration point ${index + 1} value`} value={drafts[index] ?? ''} placeholder={scale === 'date' ? 'Date / time' : 'Value'} onChange={(event) => updatePointValue(index, event.target.value)} /><small>{Math.round(point.x)}, {Math.round(point.y)} px</small></label>)}</div>
    <label className="format-control"><span>{axis.toUpperCase()} unit</span><input aria-label={`${axis.toUpperCase()} axis unit`} value={unit} placeholder="Optional" onChange={(event) => setUnit(event.target.value)} /></label>
  </div>
}
