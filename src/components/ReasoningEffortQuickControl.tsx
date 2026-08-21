import { Brain, Check, ChevronDown } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { LEGACY_REASONING_EFFORT_OPTIONS, normalizeReasoningEffortSelection } from '../providers/endpointReasoningAdapters'
import type { ReasoningEffort, ReasoningEffortOption } from '../providers/types'
import { usePresence } from '../hooks/usePresence'

interface Props {
  value: ReasoningEffort | undefined
  onChange: (value: ReasoningEffort) => void
  options?: readonly ReasoningEffortOption[]
}

export default function ReasoningEffortQuickControl({ value, onChange, options = LEGACY_REASONING_EFFORT_OPTIONS }: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [open, setOpen] = useState(false)
  const { present: menuPresent, closing: menuClosing } = usePresence(open, () => {}, 150)
  const effectiveOptions = options.length ? options : LEGACY_REASONING_EFFORT_OPTIONS
  const current = normalizeReasoningEffortSelection(value, effectiveOptions)
  const currentOption = effectiveOptions.find((option) => option.value === current) ?? effectiveOptions[0]

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
      const index = focusCurrent ? effectiveOptions.findIndex((option) => option.value === current) : 0
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
            window.requestAnimationFrame(() => focusOption(effectiveOptions.length - 1))
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
          {effectiveOptions.map((option, index) => {
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
                    focusOption((index + 1) % effectiveOptions.length)
                  } else if (event.key === 'ArrowUp') {
                    event.preventDefault()
                    focusOption((index - 1 + effectiveOptions.length) % effectiveOptions.length)
                  } else if (event.key === 'Home') {
                    event.preventDefault()
                    focusOption(0)
                  } else if (event.key === 'End') {
                    event.preventDefault()
                    focusOption(effectiveOptions.length - 1)
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
