import { useEffect, useRef } from 'react'
import { TriangleAlert, X } from 'lucide-react'
import { usePresence } from '../hooks/usePresence'

interface Props {
  open: boolean
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  onClose: () => void
  onConfirm: () => void
}

export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = '确定',
  cancelLabel = '取消',
  danger = false,
  onClose,
  onConfirm,
}: Props) {
  const cancelButtonRef = useRef<HTMLButtonElement>(null)
  const { present, closing } = usePresence(open, onClose, 180)

  useEffect(() => {
    if (!open) return
    cancelButtonRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, open])

  if (!present) return null

  return (
    <div
      className={`dialog-backdrop confirm-backdrop${closing ? ' closing' : ''}`}
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose()
      }}
    >
      <section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-dialog-title">
        <header className="confirm-dialog-header">
          <TriangleAlert size={19} aria-hidden="true" />
          <h2 id="confirm-dialog-title">{title}</h2>
          <button className="icon-button" type="button" aria-label="关闭" onClick={onClose}><X size={19} /></button>
        </header>
        <p className="confirm-dialog-message">{message}</p>
        <footer className="confirm-dialog-actions">
          <button ref={cancelButtonRef} className="secondary-button" type="button" onClick={onClose}>{cancelLabel}</button>
          <button
            className={`primary-button${danger ? ' danger-button' : ''}`}
            type="button"
            onClick={() => {
              onClose()
              onConfirm()
            }}
          >
            {confirmLabel}
          </button>
        </footer>
      </section>
    </div>
  )
}
