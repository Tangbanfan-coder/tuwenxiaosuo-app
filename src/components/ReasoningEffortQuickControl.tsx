import { Brain, Check, ChevronDown } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ReasoningEffort } from '../providers/types'
import { usePresence } from '../hooks/usePresence'

interface Props {
  value: ReasoningEffort | undefined
  onChange: (value: ReasoningEffort) => void
}

const OPTIONS: Array<{ value: ReasoningEffort; label: string }> = [
  { value: 'auto', label: '自动' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
]

export default function ReasoningEffortQuickControl({ value, onChange }: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [open, setOpen] = useState(false)
  const { present: menuPresent, closing: menuClosing } = usePresence(open, () => {}, 150)
  const current = value ?? 'auto'
  const currentOption = OPTIONS.find((option) => option.value === current) ?? OPTIONS[0]

  useEffect(() => {
    if (!open) return
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  function focusOption(index: number) {
    optionRefs.current[index]?.focus()
  }

  function openMenu(focusCurrent = false) {
    setOpen(true)
    window.requestAnimationFrame(() => {
      const index = focusCurrent ? OPTIONS.findIndex((option) => option.value === current) : 0
      focusOption(Math.max(0, index))
    })
  }

  function choose(next: ReasoningEffort) {
    onChange(next)
    setOpen(false)
    triggerRef.current?.focus()
  }

  return (
    <div ref={rootRef} className="reasoning-effort-quick">
      <button
        ref={triggerRef}
        className="reasoning-effort-quick-trigger"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`文本模型思考等级：${currentOption.label}`}
        onClick={() => open ? setOpen(false) : openMenu(true)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            openMenu(true)
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault()
            setOpen(true)
            window.requestAnimationFrame(() => focusOption(OPTIONS.length - 1))
          }
        }}
      >
        <Brain size={17} aria-hidden="true" />
        <span className="reasoning-effort-quick-name">思考</span>
        <span className="reasoning-effort-quick-value">{currentOption.label}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {menuPresent && (
        <div className={`reasoning-effort-quick-menu${menuClosing ? ' closing' : ''}`} role="menu" aria-label="文本模型思考等级">
          {OPTIONS.map((option, index) => {
            const selected = option.value === current
            return (
              <button
                key={option.value}
                ref={(element) => { optionRefs.current[index] = element }}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => choose(option.value)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault()
                    focusOption((index + 1) % OPTIONS.length)
                  } else if (event.key === 'ArrowUp') {
                    event.preventDefault()
                    focusOption((index - 1 + OPTIONS.length) % OPTIONS.length)
                  } else if (event.key === 'Home') {
                    event.preventDefault()
                    focusOption(0)
                  } else if (event.key === 'End') {
                    event.preventDefault()
                    focusOption(OPTIONS.length - 1)
                  } else if (event.key === 'Escape') {
                    event.preventDefault()
                    setOpen(false)
                    triggerRef.current?.focus()
                  }
                }}
              >
                <span>{option.label}</span>
                {selected && <Check size={15} aria-hidden="true" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
