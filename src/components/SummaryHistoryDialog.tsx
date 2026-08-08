import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Check, Clock3, FileText, History, LoaderCircle, RotateCcw, TriangleAlert, X } from 'lucide-react'
import type { Chapter, SummaryVersion, SummaryVersionReason } from '../domain/models'
import { usePresence } from '../hooks/usePresence'
import ConfirmDialog from './ConfirmDialog'

export interface SummaryHistoryDialogProps {
  open: boolean
  projectId: string
  chapters: readonly Chapter[]
  onClose: () => void
  listVersions: (projectId: string, chapterId: string) => Promise<SummaryVersion[]>
  restoreVersion: (projectId: string, chapterId: string, versionId: string) => Promise<unknown>
}

type VersionListState = 'idle' | 'loading' | 'ready' | 'empty' | 'error'

const reasonLabels: Record<SummaryVersionReason, string> = {
  generation: '生成',
  migration: '迁移',
  restore: '恢复',
}

function chapterLabel(chapter: Chapter) {
  return `第${chapter.order}章 · ${chapter.title.trim() || '未命名章节'}`
}

function formatTimestamp(timestamp: number) {
  if (!Number.isFinite(timestamp)) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp)
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}

function sortVersionsDescending(versions: readonly SummaryVersion[]) {
  return [...versions].sort((left, right) => {
    if (left.version !== right.version) return right.version - left.version
    if (left.createdAt !== right.createdAt) return right.createdAt - left.createdAt
    return right.id.localeCompare(left.id)
  })
}

export default function SummaryHistoryDialog({
  open,
  projectId,
  chapters,
  onClose,
  listVersions,
  restoreVersion,
}: SummaryHistoryDialogProps) {
  const dialogRef = useRef<HTMLElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const listRequestIdRef = useRef(0)
  const listVersionsRef = useRef(listVersions)
  const restoreVersionRef = useRef(restoreVersion)
  const [selectedChapterId, setSelectedChapterId] = useState<string>()
  const [versions, setVersions] = useState<SummaryVersion[]>([])
  const [listState, setListState] = useState<VersionListState>('idle')
  const [listError, setListError] = useState('')
  const [restoreError, setRestoreError] = useState('')
  const [restoreSuccess, setRestoreSuccess] = useState('')
  const [restoring, setRestoring] = useState(false)
  const [pendingRestore, setPendingRestore] = useState<SummaryVersion>()
  const [restoredSummaryByChapterId, setRestoredSummaryByChapterId] = useState<Record<string, string>>({})
  const { present, closing } = usePresence(open, onClose, 180)

  listVersionsRef.current = listVersions
  restoreVersionRef.current = restoreVersion

  const selectedChapter = chapters.find((chapter) => chapter.id === selectedChapterId)
  const orderedVersions = useMemo(() => sortVersionsDescending(versions), [versions])
  const currentSummary = selectedChapterId
    ? restoredSummaryByChapterId[selectedChapterId] ?? selectedChapter?.summary
    : undefined
  const currentVersionId = useMemo(() => {
    if (typeof currentSummary !== 'string') return undefined
    return orderedVersions.find((version) => version.summary === currentSummary)?.id
  }, [currentSummary, orderedVersions])

  const reloadVersions = useCallback(async (chapterId: string) => {
    const requestId = ++listRequestIdRef.current
    setListState('loading')
    setListError('')
    setVersions([])

    try {
      const nextVersions = await listVersionsRef.current(projectId, chapterId)
      if (requestId !== listRequestIdRef.current) return
      setVersions(nextVersions)
      setListState(nextVersions.length ? 'ready' : 'empty')
    } catch (error) {
      if (requestId !== listRequestIdRef.current) return
      setListState('error')
      setListError(errorMessage(error, '读取摘要历史失败，请重试。'))
    }
  }, [projectId])

  useEffect(() => {
    if (!open) {
      listRequestIdRef.current += 1
      return
    }

    setListError('')
    setRestoreError('')
    setRestoreSuccess('')
    setPendingRestore(undefined)
    setRestoredSummaryByChapterId({})
    const focusTimer = window.setTimeout(() => closeButtonRef.current?.focus(), 0)
    return () => window.clearTimeout(focusTimer)
  }, [open])

  useEffect(() => {
    if (!open) return
    setSelectedChapterId((current) => (
      current && chapters.some((chapter) => chapter.id === current) ? current : chapters[0]?.id
    ))
  }, [chapters, open, projectId])

  useEffect(() => {
    if (!open) return
    if (!selectedChapter) {
      listRequestIdRef.current += 1
      setVersions([])
      setListError('')
      setListState('empty')
      return
    }
    void reloadVersions(selectedChapter.id)
  }, [open, reloadVersions, selectedChapter])

  if (!present) return null

  function selectChapter(chapterId: string) {
    if (chapterId === selectedChapterId) return
    listRequestIdRef.current += 1
    setSelectedChapterId(chapterId)
    setVersions([])
    setListState('loading')
    setListError('')
    setRestoreError('')
    setRestoreSuccess('')
    setPendingRestore(undefined)
  }

  async function restoreSelectedVersion(version: SummaryVersion) {
    if (!selectedChapter || restoring) return
    const chapterId = selectedChapter.id
    setRestoring(true)
    setRestoreError('')
    setRestoreSuccess('')

    try {
      await restoreVersionRef.current(projectId, chapterId, version.id)
      setRestoredSummaryByChapterId((current) => ({ ...current, [chapterId]: version.summary }))
      await reloadVersions(chapterId)
      setRestoreSuccess(`已将${chapterLabel(selectedChapter)}恢复为 v${version.version}。`)
    } catch (error) {
      setRestoreError(`恢复失败：${errorMessage(error, '请稍后重试。')}`)
    } finally {
      setRestoring(false)
    }
  }

  function handleDialogKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key !== 'Tab' || !dialogRef.current) return

    const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
      'button:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
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
      if (event.currentTarget === event.target) onClose()
    }}>
      <section
        ref={dialogRef}
        className="writing-instructions-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="summary-history-dialog-title"
        aria-describedby="summary-history-dialog-description"
        onKeyDown={handleDialogKeyDown}
      >
        <header className="dialog-header">
          <div>
            <h2 id="summary-history-dialog-title">章节摘要历史</h2>
            <p id="summary-history-dialog-description">查看摘要来源，并在需要时恢复到旧版本。</p>
          </div>
          <button ref={closeButtonRef} className="icon-button" type="button" aria-label="关闭章节摘要历史" onClick={onClose}>
            <X size={20} />
          </button>
        </header>

        <div className="dialog-body">
          {!chapters.length ? (
            <p className="context-usage-empty" role="status">当前作品还没有章节，暂时没有可查看的摘要历史。</p>
          ) : (
            <>
              <label className="field" htmlFor="summary-history-chapter">
                选择章节
                <select
                  id="summary-history-chapter"
                  value={selectedChapterId ?? ''}
                  disabled={restoring || Boolean(pendingRestore)}
                  onChange={(event) => selectChapter(event.target.value)}
                >
                  {chapters.map((chapter) => <option key={chapter.id} value={chapter.id}>{chapterLabel(chapter)}</option>)}
                </select>
              </label>

              {restoreSuccess && (
                <p className="connection-status success" role="status"><Check size={17} aria-hidden="true" />{restoreSuccess}</p>
              )}
              {restoreError && (
                <div className="context-usage-error" role="alert"><TriangleAlert size={18} aria-hidden="true" /><p>{restoreError} 历史记录没有被删除，可再次尝试。</p></div>
              )}

              {listState === 'loading' && (
                <div className="context-usage-state" role="status"><LoaderCircle className="spin" size={18} aria-hidden="true" /><p>正在读取章节摘要版本…</p></div>
              )}
              {listState === 'error' && (
                <div className="context-usage-error" role="alert">
                  <TriangleAlert size={18} aria-hidden="true" />
                  <p>摘要历史暂时无法读取：{listError}</p>
                  {selectedChapter && <button className="quiet-button" type="button" onClick={() => void reloadVersions(selectedChapter.id)}>重试</button>}
                </div>
              )}
              {listState === 'empty' && selectedChapter && (
                <p className="context-usage-empty" role="status">{chapterLabel(selectedChapter)}还没有摘要历史。</p>
              )}
              {listState === 'ready' && selectedChapter && (
                <section aria-labelledby="summary-version-list-title">
                  <div className="control-heading">
                    <History size={17} aria-hidden="true" />
                    <span id="summary-version-list-title">摘要版本</span>
                  </div>
                  <div role="list" aria-label={`${chapterLabel(selectedChapter)}的摘要版本`}>
                    {orderedVersions.map((version) => {
                      const isCurrent = version.id === currentVersionId
                      return (
                        <article
                          key={version.id}
                          className="settings-section"
                          role="listitem"
                          data-version={version.version}
                          aria-current={isCurrent ? 'true' : undefined}
                        >
                          <div className="control-heading">
                            <FileText size={17} aria-hidden="true" />
                            <span>v{version.version}</span>
                            {isCurrent && <span className="connection-status success"><Check size={15} aria-hidden="true" />当前使用</span>}
                          </div>
                          <p className="settings-help"><Clock3 size={14} aria-hidden="true" />来源：{reasonLabels[version.reason]} · {formatTimestamp(version.createdAt)}</p>
                          <p>{version.summary || '（空摘要）'}</p>
                          <p className="settings-help">来源段落：{version.sourceParagraphIds.length} 条</p>
                          <button
                            className="primary-button"
                            type="button"
                            disabled={restoring || isCurrent}
                            onClick={() => setPendingRestore(version)}
                          >
                            <RotateCcw size={16} aria-hidden="true" />
                            {isCurrent ? '当前使用' : '恢复此版本'}
                          </button>
                        </article>
                      )
                    })}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </section>

      <ConfirmDialog
        open={Boolean(pendingRestore)}
        title="恢复章节摘要？"
        message={pendingRestore && selectedChapter
          ? `将“${chapterLabel(selectedChapter)}”恢复为 v${pendingRestore.version}。恢复会创建新的 restore 版本，历史不会被删除。`
          : ''}
        confirmLabel="恢复摘要"
        cancelLabel="取消"
        onClose={() => setPendingRestore(undefined)}
        onConfirm={() => {
          if (pendingRestore) void restoreSelectedVersion(pendingRestore)
        }}
      />
    </div>
  )
}
