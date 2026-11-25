import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, RefreshCw, Trash2 } from 'lucide-react'
import { DELETE_CODE_LENGTH, generateDeleteConfirmationCode, isValidDeleteConfirmationCode } from '../lib/cloud-projects'

type Props = {
  open: boolean
  projectName: string
  description: string
  busy?: boolean
  error?: string
  onCancel: () => void
  onConfirm: () => Promise<void> | void
}

export default function DeleteProjectDialog({
  open, projectName, description, busy = false, error = '', onCancel, onConfirm,
}: Props) {
  const [expectedCode, setExpectedCode] = useState('')
  const [typedCode, setTypedCode] = useState('')
  const dialogRef = useRef<HTMLElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setExpectedCode(generateDeleteConfirmationCode())
    setTypedCode('')
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus())
    return () => {
      window.cancelAnimationFrame(frame)
      previous?.focus()
    }
  }, [open, projectName])

  if (!open) return null

  const matched = isValidDeleteConfirmationCode(typedCode, expectedCode)
  const mismatch = typedCode.length === DELETE_CODE_LENGTH && !matched

  const regenerateCode = () => {
    setExpectedCode(generateDeleteConfirmationCode())
    setTypedCode('')
    inputRef.current?.focus()
  }

  return (
    <div
      className="delete-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel()
      }}
    >
      <section
        ref={dialogRef}
        className="delete-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-project-title"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !busy) {
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
        <div className="delete-heading">
          <div className="delete-title-group">
            <span className="delete-icon" aria-hidden="true"><AlertTriangle size={16} /></span>
            <h2 id="delete-project-title">Delete project</h2>
          </div>
          <button type="button" className="delete-close" onClick={onCancel} disabled={busy} aria-label="Close delete confirmation">×</button>
        </div>

        <p className="delete-description">{description}</p>
        <div className="delete-target-name" title={projectName}>
          <span>Project</span>
          <strong>{projectName}</strong>
        </div>

        <div className="delete-code-panel">
          <div className="delete-code-header">
            <span>Enter this 6-digit confirmation code</span>
            <button
              type="button"
              className="delete-code-refresh"
              onClick={regenerateCode}
              disabled={busy}
              title="Generate a new 6-digit code"
              aria-label="Generate a new 6-digit code"
            >
              <RefreshCw size={13} />
            </button>
          </div>
          <div className="delete-code-digits" aria-label={`Confirmation code ${expectedCode.split('').join(' ')}`}>
            {expectedCode.split('').map((digit, index) => (
              <span key={index} className="delete-code-digit">{digit}</span>
            ))}
          </div>
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (matched && !busy) void onConfirm()
          }}
        >
          <label className="delete-input-label">
            <span>Confirmation code ({typedCode.length}/{DELETE_CODE_LENGTH})</span>
            <input
              ref={inputRef}
              type="text"
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              maxLength={DELETE_CODE_LENGTH}
              placeholder="000000"
              disabled={busy}
              aria-invalid={mismatch || undefined}
              value={typedCode}
              onChange={(event) => setTypedCode(event.target.value.replace(/\D/g, '').slice(0, DELETE_CODE_LENGTH))}
            />
          </label>

          {mismatch && <p role="alert" className="delete-feedback error">The 6-digit code does not match. Please check and try again.</p>}
          {matched && <p role="status" className="delete-feedback matched"><Check size={13} /> Confirmation code matched.</p>}
          {error && <p role="alert" className="delete-feedback error">{error}</p>}

          <div className="delete-actions">
            <button type="button" className="delete-cancel" onClick={onCancel} disabled={busy}>Cancel</button>
            <button type="submit" className="delete-confirm" disabled={busy || !matched}>
              <Trash2 size={14} /> {busy ? 'Deleting…' : 'Delete project'}
            </button>
          </div>
        </form>
      </section>
    </div>
  )
}
