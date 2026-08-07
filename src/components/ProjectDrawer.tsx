import { useEffect, useRef, useState } from 'react'
import { BookPlus, Check, Plus, Trash2, X } from 'lucide-react'
import { getThemePreset } from '../domain/themes'
import type { StoryProject } from '../domain/models'

interface Props {
  open: boolean
  projects: StoryProject[]
  activeProjectId?: string
  onClose: () => void
  onSelect: (projectId: string) => Promise<void>
  onCreate: (title: string) => Promise<void>
  onDelete: (projectId: string) => Promise<void>
}

const dateFormatter = new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' })

export default function ProjectDrawer({
  open,
  projects,
  activeProjectId,
  onClose,
  onSelect,
  onCreate,
  onDelete,
}: Props) {
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    closeButtonRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, open])

  if (!open) return null
  async function create() {
    const nextTitle = title.trim()
    if (!nextTitle || busy) return
    setBusy(true)
    try {
      await onCreate(nextTitle)
      setTitle('')
      setCreating(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="drawer-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose()
      }}
    >
      <aside className="project-drawer" role="dialog" aria-modal="true" aria-labelledby="project-drawer-title">
        <header className="drawer-header">
          <div>
            <h2 id="project-drawer-title">我的作品</h2>
            <p>一个会话就是一部独立作品</p>
          </div>
          <button ref={closeButtonRef} className="icon-button" type="button" aria-label="关闭作品列表" onClick={onClose}>
            <X size={20} />
          </button>
        </header>

        <div className="project-list" aria-label="作品列表">
          {projects.map((project) => {
            const theme = getThemePreset(project.themeId)
            const isActive = project.id === activeProjectId
            return (
              <div key={project.id} className="project-list-item-row">
                <button
                  className="project-list-item"
                  type="button"
                  aria-current={isActive ? 'page' : undefined}
                  onClick={() => void onSelect(project.id)}
                >
                  <span className={`theme-swatch theme-${project.themeId}`} aria-hidden="true" />
                  <span className="project-list-copy">
                    <strong>{project.title}</strong>
                    <small>{theme.label} · {dateFormatter.format(project.updatedAt)}</small>
                  </span>
                  {isActive && <Check size={17} aria-label="当前作品" />}
                </button>
                <button
                  className="project-delete-button"
                  type="button"
                  aria-label={`删除作品 ${project.title}`}
                  onClick={() => void onDelete(project.id)}
                >
                  <Trash2 size={16} aria-hidden="true" />
                </button>
              </div>
            )
          })}
        </div>

        <div className="new-project-area">
          {creating ? (
            <form
              className="new-project-form"
              onSubmit={(event) => {
                event.preventDefault()
                void create()
              }}
            >
              <label htmlFor="new-project-title">作品名称</label>
              <input
                id="new-project-title"
                autoFocus
                maxLength={60}
                value={title}
                placeholder="例如：夏日便利店"
                onChange={(event) => setTitle(event.target.value)}
              />
              <div>
                <button className="quiet-button" type="button" onClick={() => setCreating(false)}>取消</button>
                <button className="primary-button" type="submit" disabled={!title.trim() || busy}>
                  {busy ? '正在创建…' : '创建空白作品'}
                </button>
              </div>
            </form>
          ) : (
            <button className="new-project-button" type="button" onClick={() => setCreating(true)}>
              <BookPlus size={19} />
              <span><strong>新建作品</strong><small>从空白对话和独立资产开始</small></span>
              <Plus size={18} />
            </button>
          )}
        </div>

      </aside>
    </div>
  )
}
