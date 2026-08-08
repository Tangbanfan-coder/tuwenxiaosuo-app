// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Chapter, SummaryVersion } from '../domain/models'
import SummaryHistoryDialog from './SummaryHistoryDialog'

const projectId = 'project-summary-history'
const chapters: Chapter[] = [
  {
    id: 'chapter-one',
    projectId,
    title: '雾港来信',
    order: 1,
    content: '第一章正文',
    status: 'draft',
    summary: '当前摘要',
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: 'chapter-two',
    projectId,
    title: '钟楼回声',
    order: 2,
    content: '第二章正文',
    status: 'draft',
    summary: '第二章摘要',
    createdAt: 2,
    updatedAt: 2,
  },
]

function version(overrides: Partial<SummaryVersion> = {}): SummaryVersion {
  return {
    id: 'summary-version-1',
    projectId,
    chapterId: 'chapter-one',
    version: 1,
    summary: '旧摘要',
    sourceContentHash: 'hash-1',
    sourceParagraphIds: ['paragraph-1'],
    reason: 'generation',
    createdAt: 1_700_000_000_000,
    ...overrides,
  }
}

function renderDialog(overrides: Partial<React.ComponentProps<typeof SummaryHistoryDialog>> = {}) {
  const listVersions = overrides.listVersions ?? vi.fn().mockResolvedValue([])
  const restoreVersion = overrides.restoreVersion ?? vi.fn().mockResolvedValue(undefined)
  const onClose = overrides.onClose ?? vi.fn()
  render(
    <SummaryHistoryDialog
      open
      projectId={projectId}
      chapters={chapters}
      onClose={onClose}
      listVersions={listVersions}
      restoreVersion={restoreVersion}
      {...overrides}
    />,
  )
  return { listVersions, restoreVersion, onClose }
}

afterEach(() => cleanup())

describe('SummaryHistoryDialog', () => {
  it('switches chapters and requests each chapter history independently', async () => {
    const user = userEvent.setup()
    const listVersions = vi.fn(async (_requestedProjectId: string, chapterId: string) => (
      chapterId === 'chapter-one' ? [version()] : [version({ id: 'summary-version-2', chapterId: 'chapter-two', version: 2, summary: '第二章摘要' })]
    ))
    renderDialog({ listVersions })

    await waitFor(() => expect(listVersions).toHaveBeenCalledWith(projectId, 'chapter-one'))
    await user.selectOptions(screen.getByLabelText('选择章节'), 'chapter-two')
    await waitFor(() => expect(listVersions).toHaveBeenCalledWith(projectId, 'chapter-two'))
    expect(await screen.findByText('v2')).toBeDefined()
  })

  it('shows versions in descending order and marks the newest matching summary as current', async () => {
    const listVersions = vi.fn().mockResolvedValue([
      version({ id: 'summary-version-1', version: 1, summary: '当前摘要', reason: 'generation', sourceParagraphIds: [] }),
      version({ id: 'summary-version-3', version: 3, summary: '当前摘要', reason: 'restore', sourceParagraphIds: ['p1', 'p2'] }),
      version({ id: 'summary-version-2', version: 2, summary: '中间摘要', reason: 'migration' }),
    ])
    renderDialog({ listVersions })

    await screen.findByText('v3')
    const rows = screen.getAllByRole('listitem')
    expect(rows.map((row) => row.getAttribute('data-version'))).toEqual(['3', '2', '1'])
    expect(rows[0]?.getAttribute('aria-current')).toBe('true')
    expect(rows[2]?.getAttribute('aria-current')).toBeNull()
    expect(within(rows[0]!).getByText('来源：恢复', { exact: false })).toBeDefined()
    expect(within(rows[0]!).getByText('来源段落：2 条')).toBeDefined()
  })

  it('renders loading and empty states', async () => {
    let resolveVersions: ((versions: SummaryVersion[]) => void) | undefined
    const listVersions = vi.fn(() => new Promise<SummaryVersion[]>((resolve) => {
      resolveVersions = resolve
    }))
    renderDialog({ listVersions })

    expect(await screen.findByText('正在读取章节摘要版本…')).toBeDefined()
    resolveVersions?.([])
    expect(await screen.findByText(/第1章 · 雾港来信还没有摘要历史/)).toBeDefined()
  })

  it('renders a recoverable list error and retries without closing the dialog', async () => {
    const user = userEvent.setup()
    const listVersions = vi.fn().mockRejectedValueOnce(new Error('数据库暂不可用')).mockResolvedValueOnce([])
    renderDialog({ listVersions })

    expect(await screen.findByText(/摘要历史暂时无法读取：数据库暂不可用/)).toBeDefined()
    await user.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(listVersions).toHaveBeenCalledTimes(2))
    expect(await screen.findByText(/还没有摘要历史/)).toBeDefined()
    expect(screen.getByRole('dialog', { name: '章节摘要历史' })).toBeDefined()
  })

  it('requires an explicit confirmation before restoring a version', async () => {
    const user = userEvent.setup()
    renderDialog({ listVersions: vi.fn().mockResolvedValue([version({ id: 'summary-version-2', version: 2, summary: '当前摘要' }), version()]) })

    await screen.findByText('v1')
    const oldVersionRow = screen.getAllByRole('listitem').find((row) => row.getAttribute('data-version') === '1')
    await user.click(within(oldVersionRow!).getByRole('button', { name: '恢复此版本' }))

    const confirmation = await screen.findByRole('alertdialog', { name: '恢复章节摘要？' })
    expect(confirmation.textContent).toContain('第1章 · 雾港来信')
    expect(confirmation.textContent).toContain('v1')
    expect(confirmation.textContent).toContain('会创建新的 restore 版本，历史不会被删除')
  })

  it('refreshes the list after a successful restore and identifies the newly created restore version as current', async () => {
    const user = userEvent.setup()
    let restored = false
    const listVersions = vi.fn(async () => (
      restored
        ? [
            version({ id: 'summary-version-3', version: 3, summary: '旧摘要', reason: 'restore', restoredFromId: 'summary-version-1' }),
            version({ id: 'summary-version-2', version: 2, summary: '当前摘要' }),
            version(),
          ]
        : [version({ id: 'summary-version-2', version: 2, summary: '当前摘要' }), version()]
    ))
    const restoreVersion = vi.fn(async () => {
      restored = true
    })
    renderDialog({ listVersions, restoreVersion })

    await screen.findByText('v1')
    const oldVersionRow = screen.getAllByRole('listitem').find((row) => row.getAttribute('data-version') === '1')
    await user.click(within(oldVersionRow!).getByRole('button', { name: '恢复此版本' }))
    await user.click(await screen.findByRole('button', { name: '恢复摘要' }))

    await waitFor(() => expect(restoreVersion).toHaveBeenCalledWith(projectId, 'chapter-one', 'summary-version-1'))
    await waitFor(() => expect(listVersions).toHaveBeenCalledTimes(2))
    expect(await screen.findByText(/已将第1章 · 雾港来信恢复为 v1/)).toBeDefined()
    const newestRow = screen.getAllByRole('listitem').find((row) => row.getAttribute('data-version') === '3')
    expect(newestRow?.getAttribute('aria-current')).toBe('true')
  })

  it('keeps the history dialog open when restoration fails', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const restoreVersion = vi.fn().mockRejectedValue(new Error('章节摘要版本不属于当前章节'))
    renderDialog({
      onClose,
      restoreVersion,
      listVersions: vi.fn().mockResolvedValue([version({ id: 'summary-version-2', version: 2, summary: '当前摘要' }), version()]),
    })

    await screen.findByText('v1')
    const oldVersionRow = screen.getAllByRole('listitem').find((row) => row.getAttribute('data-version') === '1')
    await user.click(within(oldVersionRow!).getByRole('button', { name: '恢复此版本' }))
    await user.click(await screen.findByRole('button', { name: '恢复摘要' }))

    expect(await screen.findByText(/恢复失败：章节摘要版本不属于当前章节/)).toBeDefined()
    expect(screen.getByRole('dialog', { name: '章节摘要历史' })).toBeDefined()
    expect(onClose).not.toHaveBeenCalled()
  })
})
