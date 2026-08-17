// @vitest-environment jsdom

import { act, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ProjectWorkspace } from '../domain/models'
import { useWritingTurnController } from './useWritingTurnController'

const databaseMocks = vi.hoisted(() => ({
  adoptWritingCandidate: vi.fn(),
  beginWritingTurn: vi.fn(),
  cancelWritingTurn: vi.fn(),
  completeWritingTurn: vi.fn(),
  discardWritingCandidate: vi.fn(),
  failWritingTurn: vi.fn(),
  getLatestRegenerableWritingTurn: vi.fn(),
  getLatestRetryableWritingUserMessage: vi.fn(),
  getWritingCandidate: vi.fn(),
  recordProseEvaluationEvent: vi.fn(),
  retryWritingTurn: vi.fn(),
  saveWritingCandidate: vi.fn(),
  setWritingTurnBackgroundTask: vi.fn(),
  updateLatestRetryableWritingUserMessage: vi.fn(),
}))
const writingMocks = vi.hoisted(() => ({
  explicitlyRequestsNewChapter: vi.fn(),
  generateWritingTurn: vi.fn(),
  markStyleCorpusFragmentsUsed: vi.fn(),
  parseBackgroundWritingResponse: vi.fn(),
  prepareBackgroundWritingRequest: vi.fn(),
  projectStreamingProse: vi.fn((text: string) => text),
}))
const secretStoreMocks = vi.hoisted(() => ({ has: vi.fn() }))

vi.mock('../data/storyDatabase', () => databaseMocks)
vi.mock('../providers/browserTransport', () => ({ browserTransport: {}, TransportCancelledError: class TransportCancelledError extends Error {} }))
vi.mock('../providers/backgroundGeneration', () => ({
  BackgroundTaskUncertainError: class BackgroundTaskUncertainError extends Error {},
  acknowledgeBackgroundGenerationTask: vi.fn(),
  cancelBackgroundGenerationTask: vi.fn(),
  enqueueBackgroundTextTask: vi.fn(),
  supportsBackgroundGeneration: vi.fn(() => false),
  waitForBackgroundGenerationTask: vi.fn(),
}))
vi.mock('../providers/secretStore', () => ({ secretStore: secretStoreMocks }))
vi.mock('../providers/writing', () => writingMocks)

const workspace = {
  project: { id: 'project-1', title: '测试作品', themeId: 'neutral', illustrationMode: 'manual', createdAt: 1, updatedAt: 1, lastOpenedAt: 1 },
  chapters: [],
  messages: [],
  characters: [],
  illustrations: [{ id: 'existing-illustration', projectId: 'project-1', title: '旧图', prompt: '旧图', referenceCharacterIds: [], status: 'planned', createdAt: 1, updatedAt: 1 }],
} as ProjectWorkspace
const providerSettings = {
  text: { id: 'text', name: 'text', baseUrl: 'https://text.test', model: 'text-model', protocol: 'openai-compatible' as const, secretRef: 'text-secret' },
  image: { id: 'image', name: 'image', baseUrl: '', model: '', protocol: 'openai-compatible' as const, secretRef: 'image-secret' },
  textProviders: [],
  imageProviders: [],
}

describe('useWritingTurnController', () => {
  it('refreshes persisted prose before handing its visual plan to the image workflow', async () => {
    databaseMocks.getLatestRegenerableWritingTurn.mockResolvedValue(undefined)
    databaseMocks.getWritingCandidate.mockResolvedValue(undefined)
    databaseMocks.beginWritingTurn.mockResolvedValue([
      { id: 'user-1', projectId: 'project-1', kind: 'user', text: '继续写', order: 1, createdAt: 1 },
      { id: 'notice-1', projectId: 'project-1', kind: 'notice', title: '生成中', order: 2, createdAt: 1 },
    ])
    databaseMocks.completeWritingTurn.mockResolvedValue(undefined)
    databaseMocks.recordProseEvaluationEvent.mockResolvedValue(undefined)
    writingMocks.explicitlyRequestsNewChapter.mockReturnValue(false)
    writingMocks.generateWritingTurn.mockResolvedValue({ kind: 'prose', assistantNote: '完成', chapterAction: 'continue', paragraphs: ['正文'], visualPlan: { title: '画面', prompt: '画面', stylePrompt: '', negativePrompt: '', characters: [] } })
    writingMocks.markStyleCorpusFragmentsUsed.mockResolvedValue(undefined)
    secretStoreMocks.has.mockResolvedValue(true)

    const events: string[] = []
    const refreshWorkspace = vi.fn().mockImplementation(async () => { events.push('workspace'); return workspace })
    const refreshProjects = vi.fn().mockImplementation(async () => { events.push('projects') })
    const onWritingCompleted = vi.fn().mockImplementation(async (input) => { events.push('images'); expect(input.previousIllustrationIds).toEqual(new Set(['existing-illustration'])) })
    const setWorkspace = vi.fn()
    let controller: ReturnType<typeof useWritingTurnController> | undefined
    function Probe() {
      controller = useWritingTurnController({
        workspace,
        providerSettings,
        setWorkspace: setWorkspace as never,
        refreshWorkspace,
        refreshProjects,
        showToast: vi.fn(),
        openTextProviderSettings: vi.fn(),
        onWritingCompleted,
      })
      return null
    }
    render(<Probe />)

    await act(async () => { await controller!.sendMessage('继续写') })

    expect(events).toEqual(['projects', 'workspace', 'projects', 'images'])
    expect(onWritingCompleted).toHaveBeenCalledWith(expect.objectContaining({
      nextWorkspace: workspace,
      illustrationMode: 'manual',
    }))
  })

  it('generates a foreground candidate from the pre-turn workspace and persists it without replacing prose', async () => {
    const prose = { id: 'prose-1', projectId: 'project-1', chapterId: 'chapter-1', kind: 'prose' as const, order: 3, createdAt: 3, paragraphs: ['旧版正文'], status: 'ready' as const, turnId: 'turn-1' }
    const userMessage = { id: 'user-1', projectId: 'project-1', kind: 'user' as const, order: 1, createdAt: 1, text: '继续写', turnId: 'turn-1' }
    const notice = { id: 'notice-1', projectId: 'project-1', kind: 'notice' as const, order: 2, createdAt: 2, text: '完成', status: 'ready' as const, turnId: 'turn-1' }
    const chapter = { id: 'chapter-1', projectId: 'project-1', title: '第一章', order: 1, content: '前文\n\n旧版正文', summary: '旧摘要', status: 'draft' as const, createdAt: 1, updatedAt: 3 }
    const currentWorkspace = { ...workspace, project: { ...workspace.project, activeChapterId: chapter.id }, chapters: [chapter], messages: [userMessage, notice, prose] }
    const target = { prose, user: userMessage, notice, chapter, baseChapterHash: 'chapter-hash', baseChapterContent: '前文', baseChapterSummary: '前文摘要', baseParagraphCount: 1 }
    const result = { kind: 'prose' as const, assistantNote: '完成', chapterAction: 'continue' as const, paragraphs: ['新版正文'] }
    databaseMocks.getLatestRegenerableWritingTurn.mockResolvedValue(target)
    databaseMocks.getWritingCandidate.mockResolvedValue(undefined)
    databaseMocks.saveWritingCandidate.mockImplementation(async (input) => ({ ...input, id: 'candidate-1', status: 'ready', createdAt: 4, updatedAt: 4 }))
    writingMocks.generateWritingTurn.mockResolvedValue(result)
    writingMocks.markStyleCorpusFragmentsUsed.mockResolvedValue(undefined)
    secretStoreMocks.has.mockResolvedValue(true)
    const showToast = vi.fn()
    const onWritingCompleted = vi.fn()
    let controller: ReturnType<typeof useWritingTurnController> | undefined
    function Probe() {
      controller = useWritingTurnController({
        workspace: currentWorkspace,
        providerSettings,
        setWorkspace: vi.fn() as never,
        refreshWorkspace: vi.fn(),
        refreshProjects: vi.fn(),
        showToast,
        openTextProviderSettings: vi.fn(),
        onWritingCompleted,
      })
      return null
    }
    render(<Probe />)

    await act(async () => { await controller!.regenerateLatestProse(prose) })

    expect(writingMocks.generateWritingTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messages: [],
        chapters: [expect.objectContaining({ id: chapter.id, content: '前文', summary: '前文摘要' })],
      }),
      expect.stringContaining('重新生成要求'),
      providerSettings.text,
      expect.anything(),
      undefined,
      expect.objectContaining({ regeneration: { turnId: 'turn-1', proseMessageId: prose.id, chapterId: chapter.id, baseParagraphCount: 1 } }),
    )
    expect(databaseMocks.saveWritingCandidate).toHaveBeenCalledWith(expect.objectContaining({ result, baseChapterHash: 'chapter-hash', baseChapterContent: '前文' }))
    expect(databaseMocks.completeWritingTurn).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), result, expect.anything())
    expect(onWritingCompleted).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith('候选正文已生成，请比较后选择')
  })

  it('treats the database write as the edit commit even when project-list refresh fails', async () => {
    databaseMocks.getLatestRegenerableWritingTurn.mockResolvedValue(undefined)
    databaseMocks.getLatestRetryableWritingUserMessage.mockResolvedValue(undefined)
    databaseMocks.updateLatestRetryableWritingUserMessage.mockResolvedValue('已修改的要求')
    const userMessage = { id: 'user-1', projectId: 'project-1', kind: 'user' as const, order: 1, createdAt: 1, text: '原要求' }
    const refreshWorkspace = vi.fn().mockResolvedValue(workspace)
    const refreshProjects = vi.fn().mockRejectedValue(new Error('项目列表暂不可用'))
    const setWorkspace = vi.fn()
    const showToast = vi.fn()
    let controller: ReturnType<typeof useWritingTurnController> | undefined
    function Probe() {
      controller = useWritingTurnController({
        workspace: { ...workspace, messages: [userMessage] },
        providerSettings,
        setWorkspace: setWorkspace as never,
        refreshWorkspace,
        refreshProjects,
        showToast,
        openTextProviderSettings: vi.fn(),
        onWritingCompleted: vi.fn(),
      })
      return null
    }
    render(<Probe />)

    let saved = false
    await act(async () => { saved = await controller!.editLatestRetryableUserMessage(userMessage, ' 已修改的要求 ') })

    expect(saved).toBe(true)
    expect(databaseMocks.updateLatestRetryableWritingUserMessage).toHaveBeenCalledWith('project-1', 'user-1', ' 已修改的要求 ')
    expect(refreshWorkspace).not.toHaveBeenCalled()
    expect(refreshProjects).toHaveBeenCalledTimes(1)
    const workspaceUpdater = setWorkspace.mock.calls[0][0] as (current: ProjectWorkspace) => ProjectWorkspace
    const nextWorkspace = workspaceUpdater({ ...workspace, messages: [userMessage] })
    expect(nextWorkspace.messages[0].text).toBe('已修改的要求')
    expect(nextWorkspace.project.updatedAt).toBeGreaterThan(workspace.project.updatedAt)
    expect(showToast).toHaveBeenCalledWith('已更新发送内容，可重新生成')
  })
})
