import { ImagePlus, UserRound, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

interface Props {
  onOpenCharacterAssets: () => void
  onOpenReferenceImage: () => void
}

export default function ComposerAssetsMenu({ onOpenCharacterAssets, onOpenReferenceImage }: Props) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const firstActionRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)

  function closeMenu() {
    setOpen(false)
    window.setTimeout(() => triggerRef.current?.focus(), 0)
  }

  useEffect(() => {
    if (!open) return
    const focusTimer = window.setTimeout(() => firstActionRef.current?.focus(), 0)
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeMenu()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? [])
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
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.clearTimeout(focusTimer)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  function choose(action: () => void) {
    setOpen(false)
    action()
  }

  return (
    <div className="composer-assets-menu">
      <button
        ref={triggerRef}
        className="composer-tool-button"
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <ImagePlus size={17} aria-hidden="true" />
        <span>素材</span>
      </button>
      {open && (
        <div className="composer-assets-menu-surface" role="presentation" onMouseDown={(event) => {
          if (event.currentTarget === event.target) closeMenu()
        }}>
          <section ref={dialogRef} className="composer-assets-menu-dialog" role="dialog" aria-modal="true" aria-labelledby="composer-assets-menu-title">
            <header>
              <div>
                <h2 id="composer-assets-menu-title">添加素材</h2>
                <p>为人物设定或参考画面补充资料</p>
              </div>
              <button className="icon-button" type="button" aria-label="关闭素材菜单" onClick={closeMenu}><X size={20} /></button>
            </header>
            <div className="composer-assets-menu-actions">
              <button ref={firstActionRef} type="button" onClick={() => choose(onOpenCharacterAssets)}>
                <UserRound size={20} aria-hidden="true" />
                <span><strong>人物资产</strong><small>查看、确认和管理角色定妆照</small></span>
              </button>
              <button type="button" onClick={() => choose(onOpenReferenceImage)}>
                <ImagePlus size={20} aria-hidden="true" />
                <span><strong>参考图</strong><small>导入图片作为角色外貌参考</small></span>
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
