import { useEffect, useRef, useState } from 'react'
import { estimateDeskew, rotationGeometry } from '../lib/deskew'

interface Props {
  imageUrl: string
  disabled: boolean
  onApply: (degrees: number) => void
}

export default function DeskewPanel({ imageUrl, disabled, onApply }: Props) {
  const [open, setOpen] = useState(false)
  const [angle, setAngle] = useState('0')
  const [message, setMessage] = useState('')
  const [image, setImage] = useState<HTMLImageElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const degrees = Number(angle)
  const valid = angle.trim() !== '' && Number.isFinite(degrees) && Math.abs(degrees) <= 15

  useEffect(() => {
    let cancelled = false
    const next = new Image()
    setOpen(false); setAngle('0'); setMessage(''); setImage(null)
    next.onload = () => { if (!cancelled) setImage(next) }
    next.onerror = () => { if (!cancelled) setMessage('Could not load the source image for deskewing.') }
    next.src = imageUrl
    return () => { cancelled = true }
  }, [imageUrl])

  useEffect(() => {
    if (!open || !image || !valid) return
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    const geometry = rotationGeometry(image.naturalWidth, image.naturalHeight, degrees)
    const scale = Math.min(1, 600 / Math.max(geometry.width, geometry.height))
    canvas.width = Math.max(1, Math.round(geometry.width * scale))
    canvas.height = Math.max(1, Math.round(geometry.height * scale))
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.save()
    context.scale(canvas.width / geometry.width, canvas.height / geometry.height)
    context.translate(geometry.width / 2, geometry.height / 2)
    context.rotate(geometry.radians)
    context.drawImage(image, -image.naturalWidth / 2, -image.naturalHeight / 2)
    context.restore()
    context.strokeStyle = '#00a991'
    context.lineWidth = 1
    context.setLineDash([6, 4])
    context.beginPath()
    context.moveTo(0, canvas.height / 2); context.lineTo(canvas.width, canvas.height / 2)
    context.moveTo(canvas.width / 2, 0); context.lineTo(canvas.width / 2, canvas.height)
    context.stroke()
  }, [open, image, degrees, valid])

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
      const result = estimateDeskew(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)
      if (result === null) setMessage('No reliable grid angle found. Adjust the angle manually and check the preview.')
      else { setAngle(String(result)); setMessage(`Estimated correction: ${result.toFixed(1)}°. Check the preview before applying.`) }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not estimate the image angle.')
    }
  }

  return <div className="deskew-controls">
    <button type="button" disabled={disabled || !image} onClick={() => setOpen(!open)}>{open ? 'Close deskew' : 'Deskew scan'}</button>
    {open && <>
      <div><button type="button" disabled={disabled || !image} onClick={estimate}>Estimate angle</button>
        <label>Correction (°) <input aria-label="Deskew correction angle" type="number" min="-15" max="15" step="0.1" value={angle} onChange={(event) => { setAngle(event.target.value); setMessage('') }} /></label>
      </div>
      <canvas ref={canvasRef} aria-label="Deskew preview" />
      <small>{!valid ? 'Enter an angle from -15° to 15°.' : message || 'Align grid lines with the dashed guides. Positive angles rotate clockwise.'}</small>
      <div><button type="button" disabled={disabled || !valid || degrees === 0} onClick={() => onApply(degrees)}>Apply deskew</button><button type="button" onClick={() => setOpen(false)}>Cancel</button></div>
    </>}
    {!open && message && <small>{message}</small>}
  </div>
}
