import { useEffect, useState } from 'react'
import { Ruler } from 'lucide-react'
import { estimateAxisAlignment, rotationGeometry } from '../lib/deskew'

export interface RotationPreview {
  url: string
  degrees: number
  width: number
  height: number
}

interface Props {
  imageUrl: string
  disabled: boolean
  rulerActive: boolean
  onRuler: () => void
  onPreview: (preview: RotationPreview | null) => void
  onApply: (degrees: number) => void
}

export default function DeskewPanel({ imageUrl, disabled, rulerActive, onRuler, onPreview, onApply }: Props) {
  const [angle, setAngle] = useState('0')
  const [message, setMessage] = useState('')
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  const degrees = Number(angle)
  const valid = angle.trim() !== '' && Number.isFinite(degrees) && Math.abs(degrees) <= 180

  useEffect(() => {
    let cancelled = false
    const next = new Image()
    setAngle('0'); setMessage(''); setImage(null)
    next.onload = () => { if (!cancelled) setImage(next) }
    next.onerror = () => { if (!cancelled) setMessage('Could not load the source image for rotation.') }
    next.src = imageUrl
    return () => { cancelled = true }
  }, [imageUrl])

  const changeAngle = (value: string) => {
    setAngle(value)
    setMessage('')
    const next = Number(value)
    if (!image || value.trim() === '' || !Number.isFinite(next) || Math.abs(next) > 180 || next === 0) {
      onPreview(null)
      return
    }
    try {
      const geometry = rotationGeometry(image.naturalWidth, image.naturalHeight, next)
      const canvas = document.createElement('canvas')
      canvas.width = geometry.width; canvas.height = geometry.height
      const context = canvas.getContext('2d')
      if (!context) throw new Error('This browser cannot rotate the image.')
      context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height)
      context.translate(canvas.width / 2, canvas.height / 2); context.rotate(geometry.radians)
      context.drawImage(image, -image.naturalWidth / 2, -image.naturalHeight / 2)
      onPreview({ url: canvas.toDataURL('image/png'), degrees: next, width: image.naturalWidth, height: image.naturalHeight })
    } catch (error) {
      onPreview(null)
      setMessage(error instanceof Error ? error.message : 'Could not preview the image rotation.')
    }
  }

  const estimate = () => {
    if (!image) return
    try {
      const scale = Math.min(1, 600 / Math.max(image.naturalWidth, image.naturalHeight))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) throw new Error('This browser cannot analyze the image.')
      context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height)
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      const result = estimateAxisAlignment(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)
      if (result === null) setMessage('No reliable grid angle found. Use the ruler or enter an angle.')
      else {
        changeAngle(String(result.degrees))
        const warning = result.axisDifference === null
          ? ' Both axis directions could not be verified; inspect the preview.'
          : result.axisDifference > 1
            ? ` Axis directions differ by about ${result.axisDifference.toFixed(1)}° from perpendicular; rotation cannot correct perspective.`
            : ' Check both axes in the preview.'
        setMessage(`Estimated correction: ${result.degrees.toFixed(1)}°. ${warning}`)
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not estimate the image angle.')
    }
  }

  return <div className="deskew-controls">
    <div>
      <form onSubmit={(event) => { event.preventDefault(); if (valid && degrees !== 0) onApply(degrees) }}>
        <label>Rotate (°) <input aria-label="Rotation angle" type="number" min="-180" max="180" step="0.1" value={angle} disabled={disabled || !image} onChange={(event) => changeAngle(event.target.value)} /></label>
        <button type="submit" disabled={disabled || !valid || degrees === 0}>Apply rotation</button>
      </form>
      <button type="button" disabled={disabled || !image} className={rulerActive ? 'active' : ''} aria-pressed={rulerActive} onClick={() => { changeAngle('0'); onRuler() }}><Ruler size={14} /> Straighten ruler</button>
      <button type="button" disabled={disabled || !image} onClick={estimate}>Auto align axes</button>
      {valid && degrees !== 0 && <button type="button" onClick={() => changeAngle('0')}>Cancel rotation</button>}
    </div>
    <small>{!valid ? 'Enter an angle from -180° to 180°.' : message || (rulerActive ? 'Drag the ruler along a horizontal or vertical axis on the image.' : 'Enter an angle and press Enter to apply; positive angles rotate clockwise.')}</small>
  </div>
}
