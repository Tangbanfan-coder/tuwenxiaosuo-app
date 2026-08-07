import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Save, X } from 'lucide-react'
import { usePresence } from '../hooks/usePresence'

interface Props {
  open: boolean
  projectTitle: string
  value: string
  onClose: () => void
  onSave: (value: string) => Promise<void>
}

const MAX_LENGTH = 4000

export default function WritingInstructionsDialog({ open, projectTitle, value, onClose, onSave }: Props) {
  const dialogRef = useRef<HTMLElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [draft, setDraft] = useState(value)
  const [saving, setSaving] = useState(false)
  const { present, closing } = usePresence(open, onClose, 180)
  const normalizedValue = value.trim()
  const isDirty = useMemo(() => draft.trim() !== normalizedValue, [draft, normalizedValue])

  useEffect(() => {
    if (!open) return
    setDraft(value)
    setSaving(false)
    window.requestAnimationFrame(() => textareaRef.current?.focus())
  }, [open, value])

  if (!present) return null

  function close() {
    if (saving) return
    if (isDirty && !window.confirm('长期创作设定尚未保存，确定放弃更改吗？')) return
    onClose()
  }

  async function save() {
    if (saving) return
    setSaving(true)
    try {
      await onSave(draft)
      onClose()
    } catch {
      // The parent reports the specific save error without closing the editor.
    } finally {
      setSaving(false)
    }
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return
    }
    if (event.key !== 'Tab' || !dialogRef.current) return

    const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
      'button:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ))
    if (!focusable.length) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div className={`dialog-backdrop${closing ? ' closing' : ''}`} role="presentation" onMouseDown={(event) => {
      if (event.currentTarget === event.target) close()
    }}>
      <section
        ref={dialogRef}
        className="writing-instructions-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="writing-instructions-title"
        aria-describedby="writing-instructions-description"
        onKeyDown={handleKeyDown}
      >
        <header className="dialog-header">
          <div>
            <h2 id="writing-instructions-title">长期创作设定</h2>
            <p id="writing-instructions-description">仅用于《{projectTitle}》</p>
          </div>
          <button className="icon-button" type="button" aria-label="关闭长期创作设定" onClick={close}><X size={20} /></button>
        </header>

        <form className="writing-instructions-form" onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}>
          <label htmlFor="project-writing-instructions">每轮默认遵循的写作规则</label>
          <textarea
            ref={textareaRef}
            id="project-writing-instructions"
            rows={9}
            maxLength={MAX_LENGTH}
            value={draft}
            placeholder="例如：使用第三人称有限视角；文风克制；避免网络用语；每章约两千字；不要替主角作出重大决定。"
            onChange={(event) => setDraft(event.target.value)}
          />
          <p>本轮输入提出不同要求时，以本轮输入为准。留空并保存即可清除长期设定。</p>
          <footer className="dialog-footer">
            <span>{draft.length}/{MAX_LENGTH}</span>
            <div>
              <button className="quiet-button" type="button" disabled={saving} onClick={close}>取消</button>
              <button className="save-button" type="submit" disabled={saving || !isDirty}>
                <Save size={17} />{saving ? '正在保存…' : '保存设定'}
              </button>
            </div>
          </footer>
        </form>
      </section>
    </div>
  )
}
