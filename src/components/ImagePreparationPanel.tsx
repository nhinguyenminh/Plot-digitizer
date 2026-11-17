import { useState } from 'react'
import { Check, Eye, EyeOff, ScanSearch, SlidersHorizontal, WandSparkles } from 'lucide-react'
import type { ImageAdjustments } from '../lib/image-processing'
import './ImagePreparationPanel.css'

interface Props {
  hasImage: boolean
  hasProcessedImage: boolean
  showingOriginal: boolean
  processing: boolean
  onApply: (adjustments: ImageAdjustments) => void
  onToggleCompare: () => void
  onContinue: () => void
}

const initialAdjustments: ImageAdjustments = {
  brightness: 0, contrast: 0, grayscale: false, threshold: 255,
  automaticThreshold: false, invert: false, sharpen: 0,
}

export default function ImagePreparationPanel({ hasImage, hasProcessedImage, showingOriginal, processing, onApply, onToggleCompare, onContinue }: Props) {
  const [adjustments, setAdjustments] = useState(initialAdjustments)
  const update = (patch: Partial<ImageAdjustments>) => setAdjustments((current) => ({ ...current, ...patch }))

  return (
    <section className="panel-section image-prep-section">
      <div className="section-heading">
        <div><span className="section-kicker">STEP 01 · FIRST</span><h2>Prepare scan</h2></div>
        <span className="prep-step-icon"><SlidersHorizontal size={14} /></span>
      </div>
      <p className="section-copy">Clean up a low-quality scan before marking axes or tracing curves. Your image stays in this browser.</p>
      {!hasImage ? <div className="prep-empty"><ScanSearch size={17} /><span>Paste, drop, or choose a plot image to begin.</span></div> : <>
        <label className="range-row prep-range"><span>Brightness</span><strong>{adjustments.brightness}</strong><input aria-label="Image brightness" type="range" min="-80" max="80" value={adjustments.brightness} onChange={(event) => update({ brightness: Number(event.target.value) })} /></label>
        <label className="range-row prep-range"><span>Contrast</span><strong>{adjustments.contrast}</strong><input aria-label="Image contrast" type="range" min="-80" max="120" value={adjustments.contrast} onChange={(event) => update({ contrast: Number(event.target.value) })} /></label>
        <label className="prep-check"><input type="checkbox" checked={adjustments.grayscale} onChange={(event) => update({ grayscale: event.target.checked })} /><span>Convert to grayscale</span></label>
        <label className="prep-check"><input type="checkbox" checked={adjustments.automaticThreshold} onChange={(event) => update({ automaticThreshold: event.target.checked })} /><span>Automatic background threshold</span></label>
        <label className="range-row prep-range"><span>Manual threshold</span><strong>{adjustments.threshold === 255 ? 'Off' : adjustments.threshold}</strong><input aria-label="Background cleanup threshold" type="range" min="120" max="255" value={adjustments.threshold} disabled={adjustments.automaticThreshold} onChange={(event) => update({ threshold: Number(event.target.value), automaticThreshold: false })} /></label>
        <label className="range-row prep-range"><span>Sharpen details</span><strong>{adjustments.sharpen}%</strong><input aria-label="Image sharpening" type="range" min="0" max="100" value={adjustments.sharpen} onChange={(event) => update({ sharpen: Number(event.target.value) })} /></label>
        <label className="prep-check"><input type="checkbox" checked={adjustments.invert} onChange={(event) => update({ invert: event.target.checked })} /><span>Invert colors</span></label>
        <div className="prep-actions">
          <button className="prep-apply" onClick={() => onApply(adjustments)} disabled={processing}>
            <WandSparkles size={14} /> {processing ? 'Preparing…' : hasProcessedImage ? 'Update processed image' : 'Apply cleanup'}
          </button>
          {hasProcessedImage && <button className="prep-compare" onClick={onToggleCompare} aria-pressed={!showingOriginal}>
            {showingOriginal ? <Eye size={14} /> : <EyeOff size={14} />} {showingOriginal ? 'Show processed' : 'Compare original'}
          </button>}
        </div>
        {hasProcessedImage && <p className="prep-compare-note">{showingOriginal ? 'Showing the untouched scan.' : 'Showing the cleaned image.'} Compare both, then confirm when the axes and curves look clear.</p>}
        <button className="prep-continue" onClick={onContinue} disabled={processing}>
          <Check size={14} /> Confirm image & continue
        </button>
      </>}
    </section>
  )
}
