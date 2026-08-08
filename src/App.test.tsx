// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectWorkspace, StoryProject } from './domain/models'
import type { ProviderSettings } from './providers/types'

const databaseMocks = vi.hoisted(() => ({
  beginWritingTurn: vi.fn(),
  completeWritingTurn: vi.fn(),
  confirmCharacterPortrait: vi.fn(),
  createCharacterDraft: vi.fn(),
  createProject: vi.fn(),
  deleteProject: vi.fn(),
  failWritingTurn: vi.fn(),
  getActiveProjectId: vi.fn(),
  initializeStoryDatabase: vi.fn(),
  listChapterSummaryVersions: vi.fn(),
  listMessageFeedback: vi.fn(),
  listGeneratingImageAssets: vi.fn(),
  listProjects: vi.fn(),
  listReadyLocalIllustrations: vi.fn(),
  loadProjectWorkspace: vi.fn(),
  markProjectOpened: vi.fn(),
  renameProject: vi.fn(),
  restoreChapterSummaryVersion: vi.fn(),
  setCharacterPortraitFailed: vi.fn(),
  setCharacterPortraitGenerating: vi.fn(),
  setCharacterPortraitReady: vi.fn(),
  setIllustrationFailed: vi.fn(),
  setIllustrationGenerating: vi.fn(),
  setIllustrationReady: vi.fn(),
  toggleFeedback: vi.fn(),
  updateAutoIllustrate: vi.fn(),
  updateCharacterProfile: vi.fn(),
  updateCharacterReferenceStyleMode: vi.fn(),
  updateContextBudget: vi.fn(),
  updateIllustrationStyle: vi.fn(),
  updateProjectTheme: vi.fn(),
  updateWritingInstructions: vi.fn(),
  updateWritingStructure: vi.fn(),
  storyDatabase: {
    paragraphs: {
      where: vi.fn(),
    },
  },
}))

const providerSettings: ProviderSettings = {
  text: {
    id: 'text-provider',
    name: '文本服务',
    baseUrl: '',
    model: '',
    protocol: 'openai-compatible',
    secretRef: 'provider:text',
  },
  image: {
    id: 'image-provider',
    name: '图片服务',
    baseUrl: '',
    model: '',
    protocol: 'openai-compatible',
    secretRef: 'provider:image',
  },
  textProviders: [],
  imageProviders: [],
}

vi.mock('./data/storyDatabase', () => databaseMocks)
vi.mock('./components/ProjectDrawer', () => ({ default: () => null }))
vi.mock('./components/CharacterAssetsDrawer', () => ({ default: () => null }))
vi.mock('./components/ProviderSettingsDialog', () => ({ default: () => null }))
vi.mock('./components/ReferenceImageDialog', () => ({ default: () => null }))
vi.mock('./components/ContextUsage', () => ({ default: () => null }))
vi.mock('./components/WritingInstructionsDialog', () => ({ default: () => null }))
vi.mock('./components/ConfirmDialog', () => ({ default: () => null }))
vi.mock('./components/SettingsDrawer', () => ({
  default: ({ open, onOpenSummaryHistory }: { open: boolean; onOpenSummaryHistory: () => void }) => (
    open ? <button type="button" onClick={onOpenSummaryHistory}>打开摘要版本历史</button> : null
  ),
}))
vi.mock('./components/SummaryHistoryDialog', () => ({
  default: ({
    open,
    restoreVersion,
  }: {
    open: boolean
    restoreVersion: (projectId: string, chapterId: string, versionId: string) => Promise<unknown>
  }) => (
    open ? (
      <section role="dialog" aria-label="章节摘要历史测试入口">
        <button type="button" onClick={() => void restoreVersion('project-1', 'chapter-1', 'summary-version-1')}>恢复测试摘要</button>
      </section>
    ) : null
  ),
}))
vi.mock('./domain/illustrationStyles', () => ({
  resolveProjectIllustrationStyle: () => ({
    id: 'unconstrained',
    customPrompt: '',
    visualPrompt: '',
    negativePrompt: '',
  }),
}))
vi.mock('./providers/config', () => ({
  loadProviderSettings: () => providerSettings,
  saveProviderSettings: vi.fn(),
}))
vi.mock('./providers/modelLimits', () => ({ refreshModelLimits: vi.fn().mockResolvedValue(undefined) }))
vi.mock('./providers/imageAssetStore', () => ({
  persistImageAsset: vi.fn(),
  recoverPersistedImageAsset: vi.fn(),
  resolveImageSource: vi.fn(),
  saveImageToDevice: vi.fn(),
}))
vi.mock('./providers/browserTransport', () => ({ browserTransport: {} }))
vi.mock('./providers/images', () => ({
  buildCharacterPortraitPrompt: vi.fn(),
  editOpenAiImage: vi.fn(),
  generateOpenAiImage: vi.fn(),
}))
vi.mock('./providers/secretStore', () => ({ secretStore: { has: vi.fn().mockResolvedValue(false) } }))
vi.mock('./providers/writing', () => ({
  explicitlyRequestsNewChapter: vi.fn(),
  generateWritingTurn: vi.fn(),
  previewWritingTurnBudget: vi.fn(),
}))

import App from './App'
import { createParagraphFingerprint } from './domain/paragraphs'

const project: StoryProject = {
  id: 'project-1',
  title: '测试作品',
  themeId: 'neutral',
  activeChapterId: 'chapter-1',
  autoIllustrate: false,
  createdAt: 1,
  updatedAt: 1,
  lastOpenedAt: 1,
}

const workspace: ProjectWorkspace = {
  project,
  messages: [],
  chapters: [{
    id: 'chapter-1',
    projectId: project.id,
    title: '第一章',
    order: 1,
    content: '正文',
    status: 'draft',
    summary: '当前摘要',
    createdAt: 1,
    updatedAt: 1,
  }],
  characters: [],
  illustrations: [],
}

beforeEach(() => {
  for (const [key, mock] of Object.entries(databaseMocks)) {
    if (typeof (mock as { mockReset?: unknown }).mockReset === 'function') (mock as { mockReset: () => void }).mockReset()
    else if (key === 'storyDatabase') databaseMocks.storyDatabase.paragraphs.where.mockReset()
  }
  databaseMocks.initializeStoryDatabase.mockResolvedValue(undefined)
  databaseMocks.listGeneratingImageAssets.mockResolvedValue({ illustrations: [], characters: [] })
  databaseMocks.listReadyLocalIllustrations.mockResolvedValue([])
  databaseMocks.listProjects.mockResolvedValue([project])
  databaseMocks.getActiveProjectId.mockReturnValue(project.id)
  databaseMocks.markProjectOpened.mockResolvedValue(undefined)
  databaseMocks.loadProjectWorkspace.mockResolvedValue(workspace)
  databaseMocks.listChapterSummaryVersions.mockResolvedValue([])
  databaseMocks.listMessageFeedback.mockResolvedValue([])
  databaseMocks.toggleFeedback.mockResolvedValue({ id: 'feedback-1', verdict: 'down' })
  databaseMocks.storyDatabase.paragraphs.where.mockReturnValue({
    equals: vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) }),
  })
  databaseMocks.restoreChapterSummaryVersion.mockResolvedValue(undefined)
  window.requestAnimationFrame = vi.fn(() => 1)
  window.cancelAnimationFrame = vi.fn()
  localStorage.clear()
})

afterEach(() => cleanup())

describe('App summary history integration', () => {
  it('opens summary history from settings and reloads the workspace after a successful restore', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(await screen.findByRole('button', { name: '打开设置' }))
    await user.click(await screen.findByRole('button', { name: '打开摘要版本历史' }))
    expect(await screen.findByRole('dialog', { name: '章节摘要历史测试入口' })).toBeDefined()

    databaseMocks.loadProjectWorkspace.mockClear()
    await user.click(screen.getByRole('button', { name: '恢复测试摘要' }))

    await waitFor(() => expect(databaseMocks.restoreChapterSummaryVersion).toHaveBeenCalledWith('project-1', 'chapter-1', 'summary-version-1'))
    await waitFor(() => expect(databaseMocks.loadProjectWorkspace).toHaveBeenCalledWith('project-1'))
    expect(await screen.findByText('章节摘要已恢复，后续写作将立即使用恢复后的摘要')).toBeDefined()
  })
})

describe('prose feedback UI', () => {
  const proseMessage = {
    id: 'message-1',
    projectId: 'project-1',
    chapterId: 'chapter-1',
    kind: 'prose' as const,
    order: 1,
    createdAt: 2,
    paragraphs: ['第一段正文，介绍场景。', '第二段正文，推进冲突。'],
  }

  function renderProse() {
    databaseMocks.loadProjectWorkspace.mockResolvedValue({ ...workspace, messages: [proseMessage] })
    return render(<App />)
  }

  it('显示消息级按钮并可打开/关闭反馈面板', async () => {
    const user = userEvent.setup()
    renderProse()
    await user.click(await screen.findByRole('button', { name: '点赞这条正文' }))
    expect(await screen.findByRole('dialog', { name: '正文反馈面板' })).toBeDefined()
    await user.click(screen.getByRole('button', { name: '关闭反馈面板' }))
    expect(screen.queryByRole('dialog', { name: '正文反馈面板' })).toBeNull()
  })

  it('可选择段落、填写点踩原因和说明，并提交稳定段落锚点', async () => {
    const user = userEvent.setup()
    const storedParagraph = {
      id: 'paragraph-message-message-1-1',
      projectId: 'project-1',
      sourceType: 'message' as const,
      messageId: 'message-1',
      chapterId: 'chapter-1',
      index: 1,
      text: proseMessage.paragraphs[1],
      fingerprint: createParagraphFingerprint(proseMessage.paragraphs[1]),
      createdAt: 2,
    }
    databaseMocks.storyDatabase.paragraphs.where.mockReturnValue({
      equals: vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue([storedParagraph]) }),
    })
    renderProse()
    await user.click(await screen.findByRole('button', { name: '点踩这条正文' }))
    await user.click(screen.getByLabelText('仅针对某段'))
    await user.click(screen.getByRole('option', { name: /第 2 段/ }))
    await user.click(screen.getByRole('button', { name: '节奏' }))
    await user.type(screen.getByPlaceholderText('告诉我们更多想法…'), '冲突推进得太快')
    await user.click(screen.getByRole('button', { name: '提交反馈' }))
    await waitFor(() => expect(databaseMocks.toggleFeedback).toHaveBeenCalled())
    expect(databaseMocks.toggleFeedback).toHaveBeenLastCalledWith(expect.objectContaining({
      scope: 'paragraph',
      paragraphId: storedParagraph.id,
      paragraphIndex: 1,
      paragraphFingerprint: storedParagraph.fingerprint,
      verdict: 'down',
      reason: '节奏',
      customNote: '冲突推进得太快',
    }))
  })

  it('相同 verdict 再次提交撤销，切换 verdict 传递新 verdict', async () => {
    const user = userEvent.setup()
    renderProse()
    await user.click(await screen.findByRole('button', { name: '点赞这条正文' }))
    await user.click(screen.getByRole('button', { name: '提交反馈' }))
    await waitFor(() => expect(databaseMocks.toggleFeedback).toHaveBeenCalledTimes(1))

    await user.click(await screen.findByRole('button', { name: '点赞这条正文' }))
    await user.click(screen.getByRole('button', { name: '提交反馈' }))
    await waitFor(() => expect(databaseMocks.toggleFeedback).toHaveBeenCalledTimes(2))
    expect(databaseMocks.toggleFeedback.mock.calls[1][0]).toEqual(expect.objectContaining({ scope: 'message', verdict: 'up' }))

    await user.click(await screen.findByRole('button', { name: '点踩这条正文' }))
    await user.click(screen.getByRole('button', { name: '提交反馈' }))
    await waitFor(() => expect(databaseMocks.toggleFeedback).toHaveBeenCalledTimes(3))
    expect(databaseMocks.toggleFeedback.mock.calls[2][0]).toEqual(expect.objectContaining({ scope: 'message', verdict: 'down' }))
  })
})
