import { useEffect, useRef, useState } from 'react'
import { BookPlus, Check, LoaderCircle, Pencil, Plus, Trash2, X } from 'lucide-react'
import { getThemePreset } from '../domain/themes'
import type { StoryProject } from '../domain/models'
import { usePresence } from '../hooks/usePresence'

interface Props {
  open: boolean
  projects: StoryProject[]
  activeProjectId?: string
  onClose: () => void
  onSelect: (projectId: string) => Promise<void>
  onCreate: (title: string) => Promise<void>
  onDelete: (projectId: string) => Promise<void>
  onRename: (projectId: string, title: string) => Promise<void>
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
  onRename,
}: Props) {
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [renamingId, setRenamingId] = useState<string>()
  const [renameTitle, setRenameTitle] = useState('')
  const [renameBusy, setRenameBusy] = useState(false)
  const { present, closing } = usePresence(open, onClose, 180)

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

  if (!present) return null
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

  function startRename(project: StoryProject) {
    setRenamingId(project.id)
    setRenameTitle(project.title)
  }

  async function submitRename(projectId: string) {
    const nextTitle = renameTitle.trim()
    if (!nextTitle || renameBusy) return
    setRenameBusy(true)
    try {
      await onRename(projectId, nextTitle)
      setRenamingId(undefined)
    } finally {
      setRenameBusy(false)
    }
  }

  return (
    <div
      className={`drawer-backdrop${closing ? ' closing' : ''}`}
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
          {!projects.length && (
            <div className="empty-project-list" role="status">
              <BookPlus size={24} aria-hidden="true" />
              <strong>还没有作品</strong>
              <span>从下方新建一部作品开始。</span>
            </div>
          )}
          {projects.map((project) => {
            const theme = getThemePreset(project.themeId)
            const isActive = project.id === activeProjectId
            if (renamingId === project.id) {
              return (
                <form
                  key={project.id}
                  className="project-rename-form"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void submitRename(project.id)
                  }}
                >
                  <input
                    autoFocus
                    maxLength={60}
                    value={renameTitle}
                    aria-label={`重命名作品 ${project.title}`}
                    onChange={(event) => setRenameTitle(event.target.value)}
                    onFocus={(event) => event.target.select()}
                    onKeyDown={(event) => {
                      if (event.key !== 'Escape') return
                      event.stopPropagation()
                      setRenamingId(undefined)
                    }}
                  />
                  <button className="icon-button" type="submit" aria-label="保存新名称" disabled={!renameTitle.trim() || renameBusy}>
                    {renameBusy ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}
                  </button>
                  <button className="icon-button" type="button" aria-label="取消重命名" onClick={() => setRenamingId(undefined)}>
                    <X size={17} />
                  </button>
                </form>
              )
            }
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
                  className="project-rename-button"
                  type="button"
                  aria-label={`重命名作品 ${project.title}`}
                  onClick={() => startRename(project)}
                >
                  <Pencil size={15} aria-hidden="true" />
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
