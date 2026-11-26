import { useEffect, useRef, useState } from 'react'
import { Scissors } from 'lucide-react'

type Props = {
  open: boolean
  sourceName: string
  sharedPointNumber?: number
  firstCount: number
  secondCount: number
  firstColor: string
  secondColor: string
  defaultFirstName: string
  defaultSecondName: string
  onCancel: () => void
  onConfirm: (firstName: string, secondName: string) => void
}

export default function BreakDatasetDialog({
  open,
  sourceName,
  sharedPointNumber,
  firstCount,
  secondCount,
  firstColor,
  secondColor,
  defaultFirstName,
  defaultSecondName,
  onCancel,
  onConfirm,
}: Props) {
  const [firstName, setFirstName] = useState(defaultFirstName)
  const [secondName, setSecondName] = useState(defaultSecondName)
  const secondInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setFirstName(defaultFirstName)
    setSecondName(defaultSecondName)
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frame = window.requestAnimationFrame(() => {
      secondInputRef.current?.focus()
      secondInputRef.current?.select()
    })
    return () => {
      window.cancelAnimationFrame(frame)
      previous?.focus()
    }
  }, [open, defaultFirstName, defaultSecondName])

  if (!open) return null

  const valid = Boolean(firstName.trim() && secondName.trim())

  return (
    <div
      className="break-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <section
        className="break-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="break-dataset-title"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            onCancel()
          }
          if (event.key !== 'Tab') return
          const focusable = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)'),
          )
          if (!focusable.length) { event.preventDefault(); return }
          const index = focusable.indexOf(document.activeElement as HTMLElement)
          if (event.shiftKey && index <= 0) {
            event.preventDefault()
            focusable[focusable.length - 1].focus()
          } else if (!event.shiftKey && (index === -1 || index === focusable.length - 1)) {
            event.preventDefault()
            focusable[0].focus()
          }
        }}
      >
        <div className="break-heading">
          <div className="break-title-group">
            <span className="break-icon" aria-hidden="true"><Scissors size={16} /></span>
            <h2 id="break-dataset-title">Break dataset</h2>
          </div>
          <button type="button" className="break-close" onClick={onCancel} aria-label="Close break dataset">×</button>
        </div>

        <p className="break-description">
          {sharedPointNumber !== undefined
            ? <>Split <strong>{sourceName}</strong> at point <strong>#{sharedPointNumber}</strong> into two datasets (both datasets will include this point). You can keep or customize both names below.</>
            : <>Split <strong>{sourceName}</strong> ({firstCount + secondCount} points) into two separate datasets. You can keep or customize both names below.</>}
        </p>

        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (valid) onConfirm(firstName.trim(), secondName.trim())
          }}
        >
          <label className="break-field">
            <span className="break-field-header">
              <span><i className="break-swatch" style={{ backgroundColor: firstColor }} /> First dataset</span>
              <small>{firstCount} point{firstCount === 1 ? '' : 's'}</small>
            </span>
            <input
              type="text"
              maxLength={120}
              required
              value={firstName}
              onChange={(event) => setFirstName(event.target.value)}
            />
          </label>

          <label className="break-field">
            <span className="break-field-header">
              <span><i className="break-swatch" style={{ backgroundColor: secondColor }} /> Second dataset</span>
              <small>{secondCount} point{secondCount === 1 ? '' : 's'}</small>
            </span>
            <input
              ref={secondInputRef}
              type="text"
              maxLength={120}
              required
              value={secondName}
              onChange={(event) => setSecondName(event.target.value)}
            />
          </label>

          <div className="break-actions">
            <button type="button" className="break-cancel" onClick={onCancel}>Cancel</button>
            <button type="submit" className="break-confirm" disabled={!valid}>
              <Scissors size={14} /> Break into 2 datasets
            </button>
          </div>
        </form>
      </section>
    </div>
  )
}
