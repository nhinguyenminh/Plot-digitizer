import { Brush, Check, Eraser, GitMerge, Minus, ScanSearch, WandSparkles } from 'lucide-react'
import type { GridGuides } from '../lib/image-processing'
import type { ToolMode } from '../lib/digitizer'
import type { AxisGuides, CorrectionLayer, ReconstructionWidths, UpscaleSetting } from '../lib/reconstruct'
import { ERASER_MIN_WIDTH, ERASER_MAX_WIDTH } from '../lib/reconstruct'
import DeskewPanel from './DeskewPanel'
import './ImagePreparationPanel.css'

interface Props {
  hasImage: boolean
  sourceImageUrl: string | null
  hasProcessedImage: boolean
  showingOriginal: boolean
  processing: boolean
  needsProcess: boolean
  hasRegion: boolean
  correctionCount: number
  correctionLayer: CorrectionLayer
  eraserWidth: number
  drawWidth: number
  snapDrawing: boolean
  healBrushWidth: number
  healingPreview: boolean
  healChoice: number
  upscale: UpscaleSetting
  customLongEdge: string
  widths: ReconstructionWidths
  widthsRequireProcess: boolean
  gridGuides: GridGuides
  axisGuides: AxisGuides
  regularGrid: boolean
  mode: ToolMode
  onProcess: () => void
  onDeskew: (degrees: number) => void
  onContinue: () => void
  onSelectTool: (mode: ToolMode) => void
  onCorrectionLayerChange: (layer: CorrectionLayer) => void
  onEraserWidthChange: (width: number) => void
  onDrawWidthChange: (width: number) => void
  onSnapDrawingChange: (enabled: boolean) => void
  onHealBrushWidthChange: (width: number) => void
  onHealChoiceChange: (choice: number) => void
  onApplyHealing: () => void
  onDiscardHealing: () => void
  onUpscaleChange: (setting: UpscaleSetting) => void
  onCustomLongEdgeChange: (value: string) => void
  onApplyCustomUpscale: () => void
  onWidthsChange: (widths: ReconstructionWidths) => void
  onClearRegion: () => void
  onClearGridGuides: () => void
  onClearAxisGuides: () => void
  onRegularGridChange: (enabled: boolean) => void
  onUndoCorrection: () => void
}

export default function ImagePreparationPanel({ hasImage, sourceImageUrl, hasProcessedImage, showingOriginal, processing, needsProcess, hasRegion, correctionCount, correctionLayer, eraserWidth, drawWidth, snapDrawing, healBrushWidth, healingPreview, healChoice, upscale, customLongEdge, widths, widthsRequireProcess, gridGuides, axisGuides, regularGrid, mode, onProcess, onDeskew, onContinue, onSelectTool, onCorrectionLayerChange, onEraserWidthChange, onDrawWidthChange, onSnapDrawingChange, onHealBrushWidthChange, onHealChoiceChange, onApplyHealing, onDiscardHealing, onUpscaleChange, onCustomLongEdgeChange, onApplyCustomUpscale, onWidthsChange, onClearRegion, onClearGridGuides, onClearAxisGuides, onRegularGridChange, onUndoCorrection }: Props) {
  return <section className="panel-section image-prep-section">
    <div className="section-heading"><div><span className="section-kicker">STEP 01 · FIRST</span><h2>Process image</h2></div><span className="prep-step-icon"><WandSparkles size={14} /></span></div>
    <p className="section-copy">Rebuild lines on a white background, then compare and correct them. This is an experimental detector: check every curve and intersection.</p>
    {!hasImage ? <div className="prep-empty"><ScanSearch size={17} /><span>Paste, drop, or choose a plot image to begin.</span></div> : <>
      {sourceImageUrl && <DeskewPanel imageUrl={sourceImageUrl} disabled={processing} onApply={onDeskew} />}
      <button className="prep-apply prep-main" onClick={onProcess} disabled={processing}><WandSparkles size={14} /> {processing ? 'Processing…' : 'Process image'}</button>
      <div className="grid-guide-controls">
        <label className="format-control"><span>Upscale reconstruction</span><select aria-label="Upscale reconstruction" disabled={processing} value={upscale.preset} onChange={(event) => onUpscaleChange({ ...upscale, preset: event.target.value as UpscaleSetting['preset'] })}><option value="original">Original size</option><option value="hd">HD (at least 1280 × 720)</option><option value="fullhd">Full HD (at least 1920 × 1080)</option><option value="custom">Custom long edge</option></select></label>
        {upscale.preset === 'custom' && <label className="format-control"><span>Long edge (128–4096 px)</span><input aria-label="Upscale long edge" type="number" min="128" max="4096" step="1" value={customLongEdge} onChange={(event) => onCustomLongEdgeChange(event.target.value)} /><button disabled={processing} onClick={onApplyCustomUpscale}>Apply</button></label>}
        <small>Aspect ratio and source coordinates are retained. Upscaling improves rendering, not source detail.</small>
      </div>
      {(['curve', 'grid'] as const).map((kind) => <label className="range-row" key={kind}><span>{kind === 'grid' ? 'Grid and axis' : 'Curve'} thickness</span><strong>{widths[kind]} px</strong><input aria-label={`Process ${kind} thickness`} type="range" min="0.5" max="8" step="0.5" disabled={processing} value={widths[kind]} onChange={(event) => onWidthsChange({ ...widths, [kind]: Number(event.target.value) })} /></label>)}
      {widthsRequireProcess && <small>Thickness applies when you press Process image.</small>}
      <div className="grid-guide-controls">
        <span>Define the plot area, then guide the grid and axes on the original image.</span>
        <div>
          <button className={mode === 'prep-region' ? 'active' : ''} onClick={() => onSelectTool('prep-region')}>Select plot area</button>
          <button onClick={onClearRegion} disabled={!hasRegion}>Use full image</button>
          <button className={mode === 'grid-horizontal' ? 'active' : ''} onClick={() => onSelectTool('grid-horizontal')}>Guide horizontal</button>
          <button className={mode === 'grid-vertical' ? 'active' : ''} onClick={() => onSelectTool('grid-vertical')}>Guide vertical</button>
          <button className={mode === 'guide-axis-x' ? 'active' : ''} onClick={() => onSelectTool('guide-axis-x')}>Set X axis</button>
          <button className={mode === 'guide-axis-y' ? 'active' : ''} onClick={() => onSelectTool('guide-axis-y')}>Set Y axis</button>
        </div>
        <label><input type="checkbox" checked={regularGrid} disabled={processing} onChange={(event) => onRegularGridChange(event.target.checked)} /> Rebuild a regular grid from consecutive guides</label>
        <span>For each direction, click at least two adjacent grid lines. Select the plot area to limit the rebuilt grid. One guide adjusts only that line.</span>
        <small>{gridGuides.horizontal.length} horizontal · {gridGuides.vertical.length} vertical <button onClick={onClearGridGuides} disabled={!gridGuides.horizontal.length && !gridGuides.vertical.length}>Clear guides</button></small>
        <small>X axis: {axisGuides.horizontal === null ? 'auto' : `${Math.round(axisGuides.horizontal)} px`} · Y axis: {axisGuides.vertical === null ? 'auto' : `${Math.round(axisGuides.vertical)} px`} <button onClick={onClearAxisGuides} disabled={axisGuides.horizontal === null && axisGuides.vertical === null}>Clear axes</button></small>
      </div>
      {hasProcessedImage && <>
        <div className="prep-actions">
          <button className="prep-compare" onClick={onUndoCorrection} disabled={!correctionCount}>Undo edit</button>
        </div>
        <div className="grid-guide-controls layer-selector">
          <span>Editing layer</span>
          <div role="group" aria-label="Fine-tune layer">
            <button className={correctionLayer === 'curve' ? 'active' : ''} aria-pressed={correctionLayer === 'curve'} onClick={() => onCorrectionLayerChange('curve')}>Curve layer</button>
            <button className={correctionLayer === 'grid' ? 'active' : ''} aria-pressed={correctionLayer === 'grid'} onClick={() => onCorrectionLayerChange('grid')}>Grid / axis layer</button>
          </div>
        </div>
        <div className="grid-guide-controls">
          <span>Editing tools</span>
          <div>
            <button className={mode === 'prep-draw' ? 'active' : ''} onClick={() => onSelectTool('prep-draw')}><Brush size={13} /> Draw</button>
            <button className={mode === 'prep-line' ? 'active' : ''} onClick={() => onSelectTool('prep-line')}><Minus size={13} /> Draw straight line</button>
            <button className={mode === 'prep-heal' ? 'active' : ''} onClick={() => onSelectTool('prep-heal')}><GitMerge size={13} /> Heal curve gap</button>
            <button className={mode === 'prep-erase' ? 'active' : ''} onClick={() => onSelectTool('prep-erase')}><Eraser size={13} /> Erase</button>
          </div>
          <label><input type="checkbox" checked={snapDrawing} onChange={(event) => onSnapDrawingChange(event.target.checked)} /> Snap drawn endpoints to curve ink (within 12 px)</label>
          {mode === 'prep-heal' && <div className="heal-review">
            <span>{healingPreview ? 'Check both marked endpoints and compare the estimated connection with the original.' : 'Brush over one gap, including its nearby ends.'}</span>
            <label className="range-row"><span>Heal brush width</span><strong>{healBrushWidth} px</strong><input aria-label="Heal brush width" type="range" min="8" max="72" step="2" value={healBrushWidth} onChange={(event) => onHealBrushWidthChange(Number(event.target.value))} /></label>
            {healingPreview && <><div role="group" aria-label="Connection estimate">{['Straight', 'Gentle curve', 'Follow curve'].map((label, index) => <button key={label} aria-pressed={healChoice === index} className={healChoice === index ? 'active' : ''} onClick={() => onHealChoiceChange(index)}>{index + 1} · {label}</button>)}</div><small>After brushing, press 1–3 to choose and Space to apply while the canvas is focused.</small><div className="prep-actions"><button className="prep-apply" onClick={onApplyHealing}>Apply connection</button><button className="prep-compare" onClick={onDiscardHealing}>Discard</button></div></>}
          </div>}
          <label className="range-row"><span>Eraser width</span><strong>{eraserWidth} px</strong><input aria-label="Eraser width" type="range" min={ERASER_MIN_WIDTH} max={ERASER_MAX_WIDTH} step="1" value={eraserWidth} disabled={processing} onChange={(event) => onEraserWidthChange(Number(event.target.value))} /></label>
          <label className="range-row"><span>Draw / line width</span><strong>{drawWidth} px</strong><input aria-label="Draw and line width" type="range" min="0.5" max="8" step="0.5" value={drawWidth} disabled={processing} onChange={(event) => onDrawWidthChange(Number(event.target.value))} /></label>
          <small>{correctionCount} edits · erase affects only the selected layer</small>
        </div>
        <p className="prep-compare-note">{showingOriginal ? 'Showing original scan.' : 'Showing reconstruction.'} {needsProcess ? 'Region or guides changed; press Process image again.' : 'Curves and text may be missed or confused; inspect before continuing.'}</p>
      </>}
      <button className="prep-continue" onClick={onContinue} disabled={processing || !hasProcessedImage || needsProcess}><Check size={14} /> Confirm image & continue</button>
    </>}
  </section>
}
