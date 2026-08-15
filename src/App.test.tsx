// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectWorkspace, StoryProject } from './domain/models'
import type { ProviderSettings } from './providers/types'

const databaseMocks = vi.hoisted(() => ({
  applyReferenceAppearanceAnalysis: vi.fn(),
  beginWritingTurn: vi.fn(),
  cancelWritingTurn: vi.fn(),
  completeWritingTurn: vi.fn(),
  confirmCharacterPortrait: vi.fn(),
  createCharacterDraft: vi.fn(),
  createProject: vi.fn(),
  deleteProject: vi.fn(),
  failWritingTurn: vi.fn(),
  getStyleCorpusSummary: vi.fn().mockResolvedValue({ sourceCount: 0, fragmentCount: 0 }),
  recordProseEvaluationEvent: vi.fn(() => Promise.resolve()),
  applyParagraphRewrite: vi.fn(),
  getActiveProjectId: vi.fn(),
  initializeStoryDatabase: vi.fn(),
  listChapterSummaryVersions: vi.fn(),
  listMessageFeedback: vi.fn(),
  listMessageParagraphsWithCurrentStyleIssues: vi.fn(),
  listGeneratingImageAssets: vi.fn(),
  listProjects: vi.fn(),
  listReadyLocalIllustrations: vi.fn(),
  loadProjectWorkspace: vi.fn(),
  markProjectOpened: vi.fn(),
  renameProject: vi.fn(),
  restoreChapterSummaryVersion: vi.fn(),
  restoreIllustrationsBlockedByReference: vi.fn(),
  retryWritingTurn: vi.fn(),
  setCharacterPortraitFailed: vi.fn(),
  setCharacterPortraitGenerating: vi.fn(),
  setCharacterPortraitReady: vi.fn(),
  setIllustrationFailed: vi.fn(),
  setIllustrationBlockedByReference: vi.fn(),
  setIllustrationGenerating: vi.fn(),
  setIllustrationReady: vi.fn(),
  setWritingTurnBackgroundTask: vi.fn(),
  toggleFeedback: vi.fn(),
  toggleFeedbackBatch: vi.fn(),
  updateIllustrationMode: vi.fn(),
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

const writingMocks = vi.hoisted(() => ({
  explicitlyRequestsNewChapter: vi.fn(),
  generateWritingTurn: vi.fn(),
  projectStreamingProse: vi.fn(),
  markStyleCorpusFragmentsUsed: vi.fn(),
  retrieveStyleExamples: vi.fn().mockResolvedValue([]),
  rewriteProseParagraph: vi.fn(),
}))


const configMocks = vi.hoisted(() => ({
  saveGlobalWritingInstructions: vi.fn((value: string) => value.trim()),
  saveProviderSettings: vi.fn(),
}))

const imageAssetMocks = vi.hoisted(() => ({
  persistImageAsset: vi.fn().mockResolvedValue({ imageUrl: 'data:image/png;base64,dGVzdA==', localUri: 'local://reference.png' }),
  recoverPersistedImageAsset: vi.fn(),
  resolveImageSource: vi.fn(),
  saveImageToDevice: vi.fn(),
}))

const referenceAnalysisMocks = vi.hoisted(() => ({
  analyzeReferenceImage: vi.fn(),
}))

const secretStoreMocks = vi.hoisted(() => ({
  has: vi.fn(),
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
vi.mock('./components/ProjectDrawer', () => ({
  default: ({
    open,
    projects,
    onDelete,
    onSelect,
  }: {
    open: boolean
    projects: StoryProject[]
    onDelete: (projectId: string) => Promise<void>
    onSelect?: (projectId: string) => Promise<void>
  }) => open ? (
    <section role="dialog" aria-label="作品列表测试入口">
      {projects[0] && <button type="button" onClick={() => void onDelete(projects[0].id)}>删除测试作品</button>}
      {projects[1] && <button type="button" onClick={() => void onSelect?.(projects[1].id)}>切换测试作品</button>}
    </section>
  ) : null,
}))
vi.mock('./components/CharacterAssetsDrawer', () => ({
  default: ({ open, onClose, onConfirm }: { open: boolean; onClose: () => void; onConfirm: (characterId: string) => Promise<void> }) => open ? (
    <section role="dialog" aria-label="角色资产测试入口">
      <button type="button" onClick={() => void onConfirm('character-1')}>确认测试角色</button>
      <button type="button" onClick={onClose}>关闭角色资产</button>
    </section>
  ) : null,
}))
vi.mock('./components/ProviderSettingsDialog', () => ({ default: () => null }))
vi.mock('./components/ReferenceImageDialog', () => ({
  default: ({
    open,
    onImport,
  }: {
    open: boolean
    onImport: (target: { characterId: string }, dataUrl: string, referenceStyleMode: 'project', autoAnalyze: boolean) => Promise<void>
  }) => open ? (
    <section role="dialog" aria-label="参考图测试入口">
      <button type="button" onClick={() => void onImport({ characterId: 'character-1' }, 'data:image/png;base64,dGVzdA==', 'project', true)}>导入测试参考图</button>
    </section>
  ) : null,
}))
vi.mock('./components/ContextUsage', () => ({
  contextUsageToolbarSummary: (plan: { contextPressureRatio?: number } | undefined, state: string) => {
    if (state === 'pending') return '待计算'
    return plan ? `${Math.round((plan.contextPressureRatio ?? 0) * 100)}%` : '待计算'
  },
  default: ({
    state,
    plan,
    compactLabel,
    showTrigger = true,
    detailsOpen,
    onDetailsOpenChange,
  }: {
    state: string
    plan?: unknown
    compactLabel?: string
    showTrigger?: boolean
    detailsOpen?: boolean
    onDetailsOpenChange?: (open: boolean) => void
  }) => <>
    <div aria-label={showTrigger ? '上下文工具栏状态' : '上下文设置状态'}>{`${state}:${plan ? 'ready' : 'none'}:${compactLabel ?? ''}`}</div>
    {showTrigger && <button type="button" aria-label="查看本轮上下文用量明细" onClick={() => onDetailsOpenChange?.(true)}>查看上下文</button>}
    {detailsOpen && <section role="dialog" aria-label="上下文用量测试明细"><button type="button" onClick={() => onDetailsOpenChange?.(false)}>关闭上下文用量测试明细</button></section>}
  </>,
}))
vi.mock('./components/WritingInstructionsDialog', () => ({ default: () => null }))
vi.mock('./components/ConfirmDialog', () => ({
  default: ({ open, onConfirm }: { open: boolean; onConfirm: () => void }) => open
    ? <button type="button" onClick={onConfirm}>确认测试操作</button>
    : null,
}))
vi.mock('./components/SettingsDrawer', () => ({
  default: ({
    open,
    onOpenContextUsage,
    onOpenSummaryHistory,
  }: {
    open: boolean
    onOpenContextUsage: () => void
    onOpenSummaryHistory: () => void
  }) => (
    open ? <>
      <button type="button" onClick={onOpenContextUsage}>查看本轮上下文用量</button>
      <button type="button" onClick={onOpenSummaryHistory}>打开摘要版本历史</button>
    </> : null
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
  loadGlobalWritingInstructions: () => '',
  saveGlobalWritingInstructions: configMocks.saveGlobalWritingInstructions,
  saveProviderSettings: configMocks.saveProviderSettings,
}))
vi.mock('./providers/modelLimits', () => ({ refreshModelLimits: vi.fn().mockResolvedValue(undefined) }))
vi.mock('./providers/imageAssetStore', () => ({
  ...imageAssetMocks,
}))
vi.mock('./providers/browserTransport', () => ({ browserTransport: {}, TransportCancelledError: class TransportCancelledError extends Error {} }))
vi.mock('./providers/images', () => ({
  buildCharacterPortraitPrompt: vi.fn(),
  editOpenAiImage: vi.fn(),
  generateOpenAiImage: vi.fn(),
}))
vi.mock('./providers/referenceAnalysis', () => referenceAnalysisMocks)
vi.mock('./providers/secretStore', () => ({ secretStore: secretStoreMocks }))
vi.mock('./providers/writing', () => ({
  ...writingMocks,
}))

import App from './App'
import { createParagraphFingerprint } from './domain/paragraphs'
import { TransportCancelledError } from './providers/browserTransport'

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
  databaseMocks.listMessageParagraphsWithCurrentStyleIssues.mockResolvedValue([])
  databaseMocks.getStyleCorpusSummary.mockResolvedValue({ sourceCount: 0, fragmentCount: 0 })
  databaseMocks.recordProseEvaluationEvent.mockResolvedValue(undefined)
  databaseMocks.applyParagraphRewrite.mockResolvedValue(undefined)
  databaseMocks.toggleFeedback.mockResolvedValue({ id: 'feedback-1', verdict: 'down' })
  databaseMocks.toggleFeedbackBatch.mockResolvedValue([])
  databaseMocks.storyDatabase.paragraphs.where.mockReturnValue({
    equals: vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) }),
  })
  databaseMocks.restoreChapterSummaryVersion.mockResolvedValue(undefined)
  writingMocks.explicitlyRequestsNewChapter.mockReset()
  writingMocks.generateWritingTurn.mockReset()
  writingMocks.projectStreamingProse.mockReset()
  writingMocks.retrieveStyleExamples.mockReset()
  writingMocks.retrieveStyleExamples.mockResolvedValue([])
  writingMocks.rewriteProseParagraph.mockReset()
  writingMocks.markStyleCorpusFragmentsUsed.mockReset()
  writingMocks.markStyleCorpusFragmentsUsed.mockResolvedValue(undefined)
  configMocks.saveGlobalWritingInstructions.mockClear()
  configMocks.saveProviderSettings.mockClear()
  imageAssetMocks.persistImageAsset.mockClear()
  referenceAnalysisMocks.analyzeReferenceImage.mockReset()
  referenceAnalysisMocks.analyzeReferenceImage.mockResolvedValue({
    narrativePronoun: 'she',
    ageAndBuild: '青年女性，身形纤细',
    fixedTraits: ['黑色长发'],
    defaultLook: '眉眼柔和',
    wardrobe: '浅色连衣裙',
  })
  providerSettings.text = { ...providerSettings.text, baseUrl: '', model: '', reasoningEffort: undefined }
  providerSettings.image = { ...providerSettings.image, baseUrl: '', model: '' }
  providerSettings.textProviders = []
  secretStoreMocks.has.mockReset()
  secretStoreMocks.has.mockResolvedValue(false)
  window.requestAnimationFrame = vi.fn(() => 1)
  window.cancelAnimationFrame = vi.fn()
  localStorage.clear()
})

afterEach(() => cleanup())

describe('empty project library', () => {
  it('keeps a fresh install empty and renders a usable first-project state', async () => {
    databaseMocks.listProjects.mockResolvedValue([])
    databaseMocks.getActiveProjectId.mockReturnValue(undefined)

    render(<App />)

    expect(await screen.findByRole('heading', { name: '还没有作品' })).toBeDefined()
    expect(screen.getByRole('button', { name: '新建作品' })).toBeDefined()
    expect(databaseMocks.createProject).not.toHaveBeenCalled()
  })

  it('does not recreate an unnamed project after deleting the last active project', async () => {
    const user = userEvent.setup()
    databaseMocks.listProjects
      .mockResolvedValueOnce([project])
      .mockResolvedValueOnce([])
    databaseMocks.deleteProject.mockResolvedValue(undefined)

    render(<App />)

    await user.click(await screen.findByRole('button', { name: '打开作品列表' }))
    await user.click(await screen.findByRole('button', { name: '删除测试作品' }))
    await user.click(await screen.findByRole('button', { name: '确认测试操作' }))

    await waitFor(() => expect(databaseMocks.deleteProject).toHaveBeenCalledWith(project.id))
    expect(databaseMocks.createProject).not.toHaveBeenCalled()
    expect(await screen.findByRole('heading', { name: '还没有作品' })).toBeDefined()
  })
})

describe('context usage and composer isolation', () => {
  const preparedPlan = {
    isOverLimit: false,
    estimator: { isFallback: false },
    contextPressureRatio: 0.615,
  }

  it('keeps the toolbar pending before first send and does not prepare context while typing', async () => {
    const user = userEvent.setup()
    render(<App />)

    const input = await screen.findByLabelText('创作要求')
    expect(screen.getByLabelText('上下文工具栏状态').textContent).toBe('pending:none:待计算')
    await user.type(input, '继续写')
    expect(writingMocks.generateWritingTurn).not.toHaveBeenCalled()
    expect(screen.getByLabelText('上下文工具栏状态').textContent).toBe('pending:none:待计算')
  })

  it('does not rerender historical timeline messages while typing', async () => {
    const user = userEvent.setup()
    databaseMocks.loadProjectWorkspace.mockResolvedValue({
      ...workspace,
      messages: [{ id: 'history-1', projectId: project.id, kind: 'user', text: '已有消息', order: 1, createdAt: 1 }],
    })
    render(<App />)

    const history = await screen.findByText('已有消息')
    await user.type(screen.getByLabelText('创作要求'), '新的草稿')
    expect(screen.getByText('已有消息')).toBe(history)
  })

  it('receives and retains the real prepared plan when sending', async () => {
    const user = userEvent.setup()
    providerSettings.text = { ...providerSettings.text, baseUrl: 'https://api.test/v1', model: 'test-model' }
    secretStoreMocks.has.mockResolvedValue(true)
    databaseMocks.beginWritingTurn.mockResolvedValue([
      { id: 'user-1', projectId: project.id, kind: 'user', text: '继续写', order: 1, createdAt: 2 },
      { id: 'notice-1', projectId: project.id, kind: 'notice', title: '生成中', order: 2, createdAt: 2 },
    ])
    databaseMocks.completeWritingTurn.mockResolvedValue(undefined)
    databaseMocks.loadProjectWorkspace.mockResolvedValue(workspace)
    writingMocks.generateWritingTurn.mockImplementation(async (_workspace, _text, _provider, _transport, _onDelta, options) => {
      options.onContextPlan(preparedPlan)
      options.onStyleFragmentsSelected(['style-1'])
      return { kind: 'prose', assistantNote: '正文已完成。', chapterAction: 'continue', paragraphs: ['正文'], visualPlan: undefined }
    })
    render(<App />)

    await user.type(await screen.findByLabelText('创作要求'), '继续写')
    await user.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(writingMocks.generateWritingTurn).toHaveBeenCalled())
    expect(screen.getByLabelText('上下文工具栏状态').textContent).toBe('ready:ready:62%')
    await waitFor(() => expect(writingMocks.markStyleCorpusFragmentsUsed).toHaveBeenCalledWith(['style-1']))
  })

  it('does not count selected style examples when body persistence fails', async () => {
    const user = userEvent.setup()
    providerSettings.text = { ...providerSettings.text, baseUrl: 'https://api.test/v1', model: 'test-model' }
    secretStoreMocks.has.mockResolvedValue(true)
    databaseMocks.beginWritingTurn.mockResolvedValue([
      { id: 'user-1', projectId: project.id, kind: 'user', text: '继续写', order: 1, createdAt: 2 },
      { id: 'notice-1', projectId: project.id, kind: 'notice', title: '生成中', order: 2, createdAt: 2 },
    ])
    databaseMocks.completeWritingTurn.mockRejectedValue(new Error('正文落库失败'))
    writingMocks.generateWritingTurn.mockImplementation(async (_workspace, _text, _provider, _transport, _onDelta, options) => {
      options.onStyleFragmentsSelected(['style-1'])
      return { kind: 'prose', assistantNote: '正文已完成。', chapterAction: 'continue', paragraphs: ['正文'], visualPlan: undefined }
    })
    render(<App />)
    await user.type(await screen.findByLabelText('创作要求'), '继续写')
    await user.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(databaseMocks.completeWritingTurn).toHaveBeenCalled())
    expect(writingMocks.markStyleCorpusFragmentsUsed).not.toHaveBeenCalled()
  })

  it('keeps a persisted writing turn successful when auxiliary style usage accounting fails', async () => {
    const user = userEvent.setup()
    providerSettings.text = { ...providerSettings.text, baseUrl: 'https://api.test/v1', model: 'test-model' }
    secretStoreMocks.has.mockResolvedValue(true)
    databaseMocks.beginWritingTurn.mockResolvedValue([
      { id: 'user-1', projectId: project.id, kind: 'user', text: '继续写', order: 1, createdAt: 2 },
      { id: 'notice-1', projectId: project.id, kind: 'notice', title: '生成中', order: 2, createdAt: 2 },
    ])
    databaseMocks.completeWritingTurn.mockResolvedValue(undefined)
    databaseMocks.loadProjectWorkspace.mockResolvedValue(workspace)
    writingMocks.markStyleCorpusFragmentsUsed.mockRejectedValue(new Error('计数写入失败'))
    writingMocks.generateWritingTurn.mockImplementation(async (_workspace, _text, _provider, _transport, _onDelta, options) => {
      options.onStyleFragmentsSelected(['style-1'])
      return { kind: 'prose', assistantNote: '正文已完成。', chapterAction: 'continue', paragraphs: ['正文'], visualPlan: undefined }
    })
    render(<App />)
    await user.type(await screen.findByLabelText('创作要求'), '继续写')
    await user.click(screen.getByRole('button', { name: '发送' }))
    expect(await screen.findByText('正文已保存')).toBeDefined()
    expect(databaseMocks.failWritingTurn).not.toHaveBeenCalled()
  })

  it('ignores Enter while a Chinese IME composition is active', async () => {
    const user = userEvent.setup()
    providerSettings.text = { ...providerSettings.text, baseUrl: 'https://api.test/v1', model: 'test-model' }
    secretStoreMocks.has.mockResolvedValue(true)
    render(<App />)
    const input = await screen.findByLabelText('创作要求')
    await user.type(input, '正在输入')
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 })
    expect(databaseMocks.beginWritingTurn).not.toHaveBeenCalled()
  })

  it('shows each 60/80/100 reminder once, permits a later re-entry, and clears the plan on project switch', async () => {
    const user = userEvent.setup()
    const secondProject = { ...project, id: 'project-2', title: '第二部作品' }
    databaseMocks.listProjects.mockResolvedValue([project, secondProject])
    providerSettings.text = { ...providerSettings.text, baseUrl: 'https://api.test/v1', model: 'test-model' }
    secretStoreMocks.has.mockResolvedValue(true)
    databaseMocks.beginWritingTurn.mockResolvedValue([
      { id: 'user-1', projectId: project.id, kind: 'user', text: '继续写', order: 1, createdAt: 2 },
      { id: 'notice-1', projectId: project.id, kind: 'notice', title: '生成中', order: 2, createdAt: 2 },
    ])
    databaseMocks.completeWritingTurn.mockResolvedValue(undefined)
    databaseMocks.loadProjectWorkspace.mockImplementation(async (id) => id === secondProject.id
      ? { ...workspace, project: secondProject }
      : workspace)
    const pressures = [0.61, 0.7, 0.81, 0.79, 1.02, 0.5, 0.61]
    writingMocks.generateWritingTurn.mockImplementation(async (_workspace, _text, _provider, _transport, _onDelta, options) => {
      options.onContextPlan({ ...preparedPlan, contextPressureRatio: pressures.shift() ?? 0.61 })
      return { kind: 'prose', assistantNote: '正文已完成。', chapterAction: 'continue', paragraphs: ['正文'], visualPlan: undefined }
    })
    render(<App />)

    const input = await screen.findByLabelText('创作要求')
    const expectedReminders = [
      '上下文达到 60%，将开始整理近期内容',
      '正文已保存',
      '上下文达到 80%，将明显压缩历史内容',
      '正文已保存',
      '上下文达到 100%，将优先保留核心规则与章节状态',
      '正文已保存',
      '上下文达到 60%，将开始整理近期内容',
    ]
    for (let index = 0; index < expectedReminders.length; index++) {
      await user.type(input, `第${index}次`)
      await user.click(screen.getByRole('button', { name: '发送' }))
      await waitFor(() => expect(writingMocks.generateWritingTurn).toHaveBeenCalledTimes(index + 1))
      expect(screen.getByText(expectedReminders[index])).toBeDefined()
    }

    await user.click(screen.getByRole('button', { name: '打开作品列表' }))
    await user.click(screen.getByRole('button', { name: '切换测试作品' }))
    await waitFor(() => expect(screen.getByLabelText('上下文工具栏状态').textContent).toBe('pending:none:待计算'))
  })

  it('keeps context details in the toolbar and settings sheet', async () => {
    const user = userEvent.setup()
    render(<App />)

    expect(await screen.findByRole('button', { name: /上下文.*明细/ })).toBeDefined()
    await user.click(await screen.findByRole('button', { name: '打开设置' }))
    await user.click(screen.getByRole('button', { name: '查看本轮上下文用量' }))
    expect(await screen.findByRole('dialog', { name: '上下文用量测试明细' })).toBeDefined()
  })
})

describe('quick reasoning effort control', () => {
  it('updates and persists the active text provider without opening model settings', async () => {
    const user = userEvent.setup()
    providerSettings.textProviders = [{ ...providerSettings.text }]
    render(<App />)

    await user.click(await screen.findByRole('button', { name: '文本模型思考等级：自动' }))
    await user.click(screen.getByRole('menuitemradio', { name: '高' }))

    expect(configMocks.saveProviderSettings).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.objectContaining({ id: 'text-provider', reasoningEffort: 'high' }),
      textProviders: [expect.objectContaining({ id: 'text-provider', reasoningEffort: 'high' })],
    }))
    expect(screen.getByRole('button', { name: '文本模型思考等级：高' })).toBeDefined()
  })
})

describe('reference image navigation', () => {
  it('returns from character assets to reference image entry after an import', async () => {
    const user = userEvent.setup()
    databaseMocks.loadProjectWorkspace.mockResolvedValue({
      ...workspace,
      characters: [{
        id: 'character-1',
        projectId: project.id,
        name: '林昭',
        role: '主角',
        identity: { ageAndBuild: '', fixedTraits: [] },
        appearance: { defaultLook: '', wardrobe: '' },
        continuity: { revision: 0, referenceStyleMode: 'project' },
        portraitStatus: 'ready',
        status: 'draft',
        createdAt: 1,
        updatedAt: 1,
      }],
    })

    render(<App />)

    await user.click(await screen.findByRole('button', { name: '素材' }))
    await user.click(screen.getByRole('button', { name: /参考图/ }))
    await user.click(await screen.findByRole('button', { name: '导入测试参考图' }))
    await waitFor(() => expect(imageAssetMocks.persistImageAsset).toHaveBeenCalledWith(
      'data:image/png;base64,dGVzdA==',
      project.id,
      'character-1',
      'imported',
    ))
    expect(await screen.findByRole('dialog', { name: '角色资产测试入口' })).toBeDefined()

    await user.click(screen.getByRole('button', { name: '关闭角色资产' }))
    expect(await screen.findByRole('dialog', { name: '参考图测试入口' })).toBeDefined()
  })

  it('analyzes an imported reference and saves the profile for user confirmation', async () => {
    const user = userEvent.setup()
    providerSettings.text = { ...providerSettings.text, baseUrl: 'https://api.test/v1', model: 'vision-model' }
    secretStoreMocks.has.mockResolvedValue(true)
    databaseMocks.loadProjectWorkspace.mockResolvedValue({
      ...workspace,
      characters: [{
        id: 'character-1', projectId: project.id, name: '林染', role: '主角',
        identity: { ageAndBuild: '', fixedTraits: [] }, appearance: { defaultLook: '', wardrobe: '' },
        continuity: { revision: 0, referenceStyleMode: 'project' }, portraitStatus: 'review', status: 'draft', createdAt: 1, updatedAt: 1,
      }],
    })

    render(<App />)
    await user.click(await screen.findByRole('button', { name: '素材' }))
    await user.click(screen.getByRole('button', { name: /参考图/ }))
    await user.click(await screen.findByRole('button', { name: '导入测试参考图' }))

    await waitFor(() => expect(referenceAnalysisMocks.analyzeReferenceImage).toHaveBeenCalledWith(
      'data:image/png;base64,dGVzdA==',
      expect.objectContaining({ model: 'vision-model' }),
      expect.anything(),
    ))
    expect(databaseMocks.applyReferenceAppearanceAnalysis).toHaveBeenCalledWith('character-1', expect.objectContaining({ narrativePronoun: 'she' }))
  })
})

describe('composer asset and illustration controls', () => {
  it('opens character assets through the material menu', async () => {
    const user = userEvent.setup()
    render(<App />)

    await user.click(await screen.findByRole('button', { name: '素材' }))
    await user.click(screen.getByRole('button', { name: /人物资产/ }))
    expect(await screen.findByRole('dialog', { name: '角色资产测试入口' })).toBeDefined()
  })

  it('selects and persists all illustration modes', async () => {
    const user = userEvent.setup()
    databaseMocks.loadProjectWorkspace.mockResolvedValue({
      ...workspace,
      project: { ...project, illustrationMode: 'auto' },
    })
    render(<App />)

    const button = await screen.findByRole('button', { name: '配图模式：自动' })
    expect(button.textContent).toContain('配图')
    expect(button.textContent).toContain('自动')
    await user.click(button)
    await user.click(screen.getByRole('menuitemradio', { name: /无图/ }))
    await waitFor(() => expect(databaseMocks.updateIllustrationMode).toHaveBeenCalledWith(project.id, 'none'))
    expect(screen.getByRole('button', { name: '配图模式：无图' })).toBeDefined()
    await user.click(screen.getByRole('button', { name: '配图模式：无图' }))
    await user.click(screen.getByRole('menuitemradio', { name: /按需/ }))
    expect(databaseMocks.updateIllustrationMode).toHaveBeenCalledWith(project.id, 'manual')
  })

  it.each([
    [false, '按需'],
    [true, '自动'],
  ] as const)('renders legacy autoIllustrate=%s as %s mode', async (autoIllustrate, label) => {
    databaseMocks.loadProjectWorkspace.mockResolvedValue({
      ...workspace,
      project: { ...project, autoIllustrate },
    })
    render(<App />)

    expect(await screen.findByRole('button', { name: `配图模式：${label}` })).toBeDefined()
  })

  it('restores reference-blocked illustrations after confirmation even when auto illustration is off', async () => {
    const user = userEvent.setup()
    providerSettings.image = { ...providerSettings.image, baseUrl: 'https://api.test/v1', model: 'image-model' }
    secretStoreMocks.has.mockResolvedValue(true)
    const reviewCharacter = {
      id: 'character-1', projectId: project.id, name: '林染', role: '主角', narrativePronoun: 'she' as const,
      identity: { ageAndBuild: '青年', fixedTraits: ['黑发'] }, appearance: { defaultLook: '齐肩黑发', wardrobe: '深色外套' },
      continuity: { revision: 1, referenceImageUrl: 'data:image/png;base64,dGVzdA==', referenceStyleMode: 'project' as const },
      portraitStatus: 'review' as const, status: 'draft' as const, createdAt: 1, updatedAt: 1,
    }
    const confirmedCharacter = {
      id: 'character-1', projectId: project.id, name: '林染', role: '主角', narrativePronoun: 'she' as const,
      identity: { ageAndBuild: '青年', fixedTraits: ['黑发'] }, appearance: { defaultLook: '齐肩黑发', wardrobe: '深色外套' },
      continuity: { revision: 1, referenceImageUrl: 'data:image/png;base64,dGVzdA==', referenceStyleMode: 'project' as const },
      portraitStatus: 'confirmed' as const, status: 'confirmed' as const, createdAt: 1, updatedAt: 1,
    }
    const blockedIllustration = {
      id: 'illustration-1', projectId: project.id, title: '雨夜', prompt: '林染走进雨夜街头', referenceCharacterIds: ['character-1'],
      status: 'failed' as const,
      errorMessage: '角色“林染”的参考图尚未确认或图片不可用。请在角色资产中补全档案并确认。',
      createdAt: 1, updatedAt: 1,
    }
    const ordinaryFailure = {
      id: 'illustration-2', projectId: project.id, title: '网络失败', prompt: '林染站在雨中', referenceCharacterIds: ['character-1'],
      status: 'failed' as const, errorMessage: '网络错误', createdAt: 2, updatedAt: 2,
    }
    const classifiedIllustration = { ...blockedIllustration, failureKind: 'reference-unavailable' as const }
    const restoredIllustration = { ...classifiedIllustration, status: 'planned' as const, failureKind: undefined, errorMessage: undefined }
    const illustrationMessage = {
      id: 'illustration-message-1', projectId: project.id, chapterId: 'chapter-1', kind: 'illustration' as const,
      title: '雨夜', illustrationId: 'illustration-1', order: 1, createdAt: 1,
    }
    databaseMocks.loadProjectWorkspace
      .mockResolvedValueOnce({ ...workspace, messages: [illustrationMessage], characters: [reviewCharacter], illustrations: [blockedIllustration, ordinaryFailure] })
      .mockResolvedValueOnce({ ...workspace, messages: [illustrationMessage], characters: [confirmedCharacter], illustrations: [classifiedIllustration, ordinaryFailure] })
      .mockResolvedValueOnce({ ...workspace, messages: [illustrationMessage], characters: [confirmedCharacter], illustrations: [restoredIllustration, ordinaryFailure] })
    render(<App />)

    await user.click(await screen.findByRole('button', { name: '素材' }))
    await user.click(screen.getByRole('button', { name: /人物资产/ }))
    await user.click(await screen.findByRole('button', { name: '确认测试角色' }))

    await waitFor(() => expect(databaseMocks.confirmCharacterPortrait).toHaveBeenCalledWith('character-1'))
    expect(databaseMocks.setIllustrationBlockedByReference).toHaveBeenCalledWith(
      'illustration-1',
      blockedIllustration.errorMessage,
    )
    expect(databaseMocks.setIllustrationBlockedByReference).not.toHaveBeenCalledWith('illustration-2', expect.anything())
    await waitFor(() => expect(databaseMocks.restoreIllustrationsBlockedByReference).toHaveBeenCalledWith(project.id, ['illustration-1']))
    expect(databaseMocks.restoreIllustrationsBlockedByReference).not.toHaveBeenCalledWith(project.id, expect.arrayContaining(['illustration-2']))
    expect(await screen.findByRole('button', { name: '生成插画' })).toBeDefined()
  })

  it('guides the blocked illustration card to character confirmation once the portrait is ready', async () => {
    providerSettings.image = { ...providerSettings.image, baseUrl: 'https://api.test/v1', model: 'image-model' }
    secretStoreMocks.has.mockResolvedValue(true)
    const reviewCharacter = {
      id: 'character-1', projectId: project.id, name: '林染', role: '主角', narrativePronoun: 'she' as const,
      identity: { ageAndBuild: '青年', fixedTraits: ['黑发'] }, appearance: { defaultLook: '齐肩黑发', wardrobe: '深色外套' },
      continuity: { revision: 1, referenceImageUrl: 'data:image/png;base64,dGVzdA==', referenceStyleMode: 'project' as const },
      portraitStatus: 'review' as const, status: 'draft' as const, createdAt: 1, updatedAt: 1,
    }
    const blockedIllustration = {
      id: 'illustration-1', projectId: project.id, title: '雨夜', prompt: '林染走进雨夜街头', referenceCharacterIds: ['character-1'],
      status: 'failed' as const, failureKind: 'reference-unavailable' as const,
      errorMessage: '角色“林染”的参考图尚未确认或图片不可用。请在角色资产中补全档案并确认。',
      createdAt: 1, updatedAt: 1,
    }
    const illustrationMessage = {
      id: 'illustration-message-1', projectId: project.id, chapterId: 'chapter-1', kind: 'illustration' as const,
      title: '雨夜', illustrationId: 'illustration-1', order: 1, createdAt: 1,
    }
    databaseMocks.loadProjectWorkspace.mockResolvedValue({ ...workspace, messages: [illustrationMessage], characters: [reviewCharacter], illustrations: [blockedIllustration] })
    render(<App />)

    expect(await screen.findByRole('button', { name: '去确认角色，解锁插画' })).toBeDefined()
    expect(screen.getByText('插画生成失败，可检查指令后重试')).toBeDefined()
    expect(screen.queryByRole('img', { name: /插画生成占位图/ })).toBeNull()
  })

  it('keeps the generic character asset entry while the portrait is not ready yet', async () => {
    providerSettings.image = { ...providerSettings.image, baseUrl: 'https://api.test/v1', model: 'image-model' }
    secretStoreMocks.has.mockResolvedValue(true)
    const pendingCharacter = {
      id: 'character-1', projectId: project.id, name: '林染', role: '主角', narrativePronoun: 'she' as const,
      identity: { ageAndBuild: '青年', fixedTraits: ['黑发'] }, appearance: { defaultLook: '齐肩黑发', wardrobe: '深色外套' },
      continuity: { revision: 0, referenceStyleMode: 'project' as const },
      portraitStatus: 'planned' as const, status: 'draft' as const, createdAt: 1, updatedAt: 1,
    }
    const blockedIllustration = {
      id: 'illustration-1', projectId: project.id, title: '雨夜', prompt: '林染走进雨夜街头', referenceCharacterIds: ['character-1'],
      status: 'failed' as const, failureKind: 'reference-unavailable' as const,
      errorMessage: '角色“林染”的参考图尚未确认或图片不可用。请在角色资产中补全档案并确认。',
      createdAt: 1, updatedAt: 1,
    }
    const illustrationMessage = {
      id: 'illustration-message-1', projectId: project.id, chapterId: 'chapter-1', kind: 'illustration' as const,
      title: '雨夜', illustrationId: 'illustration-1', order: 1, createdAt: 1,
    }
    databaseMocks.loadProjectWorkspace.mockResolvedValue({ ...workspace, messages: [illustrationMessage], characters: [pendingCharacter], illustrations: [blockedIllustration] })
    render(<App />)

    expect(await screen.findByRole('button', { name: '查看角色资产' })).toBeDefined()
    expect(screen.queryByRole('button', { name: '去确认角色，解锁插画' })).toBeNull()
  })
})

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
    const storedParagraphFirst = {
      ...storedParagraph,
      id: 'paragraph-message-message-1-0',
      index: 0,
      text: proseMessage.paragraphs[0],
      fingerprint: createParagraphFingerprint(proseMessage.paragraphs[0]),
    }
    databaseMocks.storyDatabase.paragraphs.where.mockReturnValue({
      equals: vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue([storedParagraphFirst, storedParagraph]) }),
    })
    renderProse()
    await user.click(await screen.findByRole('button', { name: '点踩这条正文' }))
    await user.click(screen.getByLabelText('仅针对某段'))
    await user.click(screen.getByRole('option', { name: /第 1 段/ }))
    await user.click(screen.getByRole('option', { name: /第 2 段/ }))
    await user.click(screen.getByRole('button', { name: '节奏' }))
    await user.type(screen.getByPlaceholderText('告诉我们更多想法…'), '冲突推进得太快')
    await user.click(screen.getByRole('button', { name: '提交反馈' }))
    await waitFor(() => expect(databaseMocks.toggleFeedbackBatch).toHaveBeenCalled())
    expect(databaseMocks.toggleFeedbackBatch).toHaveBeenLastCalledWith(expect.objectContaining({
      targets: [
        expect.objectContaining({ scope: 'paragraph', paragraphIndex: 0, paragraphId: storedParagraphFirst.id }),
        expect.objectContaining({ scope: 'paragraph', paragraphIndex: 1, paragraphId: storedParagraph.id, paragraphFingerprint: storedParagraph.fingerprint }),
      ],
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
    await waitFor(() => expect(databaseMocks.toggleFeedbackBatch).toHaveBeenCalledTimes(1))

    await user.click(await screen.findByRole('button', { name: '点赞这条正文' }))
    await user.click(screen.getByRole('button', { name: '提交反馈' }))
    await waitFor(() => expect(databaseMocks.toggleFeedbackBatch).toHaveBeenCalledTimes(2))
    expect(databaseMocks.toggleFeedbackBatch.mock.calls[1][0]).toEqual(expect.objectContaining({ targets: [expect.objectContaining({ scope: 'message' })], verdict: 'up' }))

    await user.click(await screen.findByRole('button', { name: '点踩这条正文' }))
    await user.click(screen.getByRole('button', { name: '提交反馈' }))
    await waitFor(() => expect(databaseMocks.toggleFeedbackBatch).toHaveBeenCalledTimes(3))
    expect(databaseMocks.toggleFeedbackBatch.mock.calls[2][0]).toEqual(expect.objectContaining({ targets: [expect.objectContaining({ scope: 'message' })], verdict: 'down' }))
  })

  it('仅在检测命中后按用户操作生成并采用段落建议稿', async () => {
    const user = userEvent.setup()
    providerSettings.text = { ...providerSettings.text, baseUrl: 'https://api.test/v1', model: 'rewrite-model' }
    const paragraph = {
      id: 'paragraph-message-message-1-0', projectId: project.id, sourceType: 'message' as const,
      messageId: proseMessage.id, chapterId: 'chapter-1', index: 0, text: proseMessage.paragraphs[0],
      fingerprint: createParagraphFingerprint(proseMessage.paragraphs[0]), createdAt: 2,
      styleIssues: [{ ruleId: 'stock-physical-reaction', category: 'stock-reaction' as const, severity: 'warning' as const, explanation: '动作反应过于模板化', rewriteGoal: '保留关键动作' }],
    }
    databaseMocks.listMessageParagraphsWithCurrentStyleIssues.mockResolvedValue([paragraph])
    writingMocks.rewriteProseParagraph.mockResolvedValue('她把杯子推到桌子中央。')
    renderProse()
    const trigger = await screen.findByRole('button', { name: '优化第 1 段，1 个建议' })
    expect(writingMocks.rewriteProseParagraph).not.toHaveBeenCalled()
    await user.click(trigger)
    expect(screen.getAllByText('第一段正文，介绍场景。')).toHaveLength(2)
    await user.click(screen.getByRole('button', { name: /生成建议稿/ }))
    expect(await screen.findByText('她把杯子推到桌子中央。')).toBeDefined()
    await user.click(screen.getByRole('button', { name: /采用建议稿/ }))
    await waitFor(() => expect(databaseMocks.applyParagraphRewrite).toHaveBeenCalledWith(expect.objectContaining({
      messageId: proseMessage.id, paragraphId: paragraph.id, originalFingerprint: paragraph.fingerprint,
      rewrittenText: '她把杯子推到桌子中央。',
    })))
  })

  it('语料使用计数失败时仍展示已经生成的段落建议稿', async () => {
    const user = userEvent.setup()
    providerSettings.text = { ...providerSettings.text, baseUrl: 'https://api.test/v1', model: 'rewrite-model' }
    const paragraph = {
      id: 'paragraph-message-message-1-0', projectId: project.id, sourceType: 'message' as const,
      messageId: proseMessage.id, chapterId: 'chapter-1', index: 0, text: proseMessage.paragraphs[0],
      fingerprint: createParagraphFingerprint(proseMessage.paragraphs[0]), createdAt: 2,
      styleIssues: [{ ruleId: 'stock-physical-reaction', category: 'stock-reaction' as const, severity: 'warning' as const, explanation: '动作反应过于模板化', rewriteGoal: '保留关键动作' }],
    }
    databaseMocks.listMessageParagraphsWithCurrentStyleIssues.mockResolvedValue([paragraph])
    writingMocks.retrieveStyleExamples.mockResolvedValue([{ fragment: { id: 'style-1', text: '参考语料' } }])
    writingMocks.rewriteProseParagraph.mockResolvedValue('她把杯子推到桌子中央。')
    writingMocks.markStyleCorpusFragmentsUsed.mockRejectedValue(new Error('计数写入失败'))
    renderProse()
    await user.click(await screen.findByRole('button', { name: '优化第 1 段，1 个建议' }))
    await user.click(screen.getByRole('button', { name: /生成建议稿/ }))
    expect(await screen.findByText('她把杯子推到桌子中央。')).toBeDefined()
  })

  it('允许用户保留原文而不写入数据库', async () => {
    const user = userEvent.setup()
    const paragraph = {
      id: 'paragraph-message-message-1-0', projectId: project.id, sourceType: 'message' as const,
      messageId: proseMessage.id, chapterId: 'chapter-1', index: 0, text: proseMessage.paragraphs[0],
      fingerprint: createParagraphFingerprint(proseMessage.paragraphs[0]), createdAt: 2,
      styleIssues: [{ ruleId: 'dialogue-explained-afterward', category: 'dialogue-explanation' as const, severity: 'hint' as const, explanation: '对白后重复解释', rewriteGoal: '删除复述' }],
    }
    databaseMocks.listMessageParagraphsWithCurrentStyleIssues.mockResolvedValue([paragraph])
    renderProse()
    await user.click(await screen.findByRole('button', { name: '优化第 1 段，1 个建议' }))
    await user.click(screen.getByRole('button', { name: '保留原文' }))
    expect(databaseMocks.applyParagraphRewrite).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: '段落优化建议' })).toBeNull()
  })

  it('切换强度清空旧建议，采用失败时保留面板并显示错误', async () => {
    const user = userEvent.setup()
    providerSettings.text = { ...providerSettings.text, baseUrl: 'https://api.test/v1', model: 'rewrite-model' }
    const paragraph = {
      id: 'paragraph-message-message-1-0', projectId: project.id, sourceType: 'message' as const,
      messageId: proseMessage.id, chapterId: 'chapter-1', index: 0, text: proseMessage.paragraphs[0],
      fingerprint: createParagraphFingerprint(proseMessage.paragraphs[0]), createdAt: 2,
      styleIssues: [{ ruleId: 'stock-physical-reaction', category: 'stock-reaction' as const, severity: 'warning' as const, explanation: '动作模板化', rewriteGoal: '保留关键动作' }],
    }
    databaseMocks.listMessageParagraphsWithCurrentStyleIssues.mockResolvedValue([paragraph])
    writingMocks.rewriteProseParagraph.mockResolvedValue('第一版建议。')
    databaseMocks.applyParagraphRewrite.mockRejectedValue(new Error('正文已变化'))
    renderProse()
    await user.click(await screen.findByRole('button', { name: '优化第 1 段，1 个建议' }))
    await user.click(screen.getByRole('button', { name: /生成建议稿/ }))
    expect(await screen.findByText('第一版建议。')).toBeDefined()
    await user.click(screen.getByRole('radio', { name: '强力' }))
    expect(screen.queryByText('第一版建议。')).toBeNull()
    await user.click(screen.getByRole('button', { name: /生成建议稿/ }))
    await user.click(await screen.findByRole('button', { name: /采用建议稿/ }))
    expect((await screen.findByRole('alert')).textContent).toContain('正文已变化')
    expect(screen.getByRole('dialog', { name: '段落优化建议' })).toBeDefined()
  })
})

describe('生成停止与重试', () => {
  const failedWorkspace: ProjectWorkspace = {
    ...workspace,
    messages: [
      { id: 'user-1', projectId: project.id, kind: 'user', text: '继续写', order: 0, createdAt: 1 },
      { id: 'notice-1', projectId: project.id, kind: 'notice', title: '生成中', text: '网络失败', order: 1, createdAt: 2, status: 'failed', userMessageId: 'user-1' },
    ],
  }

  function configureSendable() {
    providerSettings.text = { ...providerSettings.text, baseUrl: 'https://api.test/v1', model: 'test-model' }
    secretStoreMocks.has.mockResolvedValue(true)
  }

  it('发送按钮在生成中切换为停止按钮，停止后恢复且不落库', async () => {
    const user = userEvent.setup()
    configureSendable()
    databaseMocks.beginWritingTurn.mockResolvedValue([
      { id: 'user-1', projectId: project.id, kind: 'user', text: '继续写', order: 0, createdAt: 1 },
      { id: 'notice-1', projectId: project.id, kind: 'notice', title: '生成中', order: 1, createdAt: 1 },
    ])
    databaseMocks.completeWritingTurn.mockResolvedValue(undefined)
    databaseMocks.cancelWritingTurn.mockResolvedValue(undefined)
    writingMocks.generateWritingTurn.mockImplementation((_w: unknown, _t: unknown, _p: unknown, _transport: unknown, _onDelta: unknown, options: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(new TransportCancelledError('已取消')))
      }))
    render(<App />)

    await user.type(await screen.findByLabelText('创作要求'), '继续写')
    await user.click(screen.getByRole('button', { name: '发送' }))
    await screen.findByRole('button', { name: '停止生成' })
    expect(screen.queryByRole('button', { name: '发送' })).toBeNull()

    await user.click(screen.getByRole('button', { name: '停止生成' }))
    await waitFor(() => expect(databaseMocks.cancelWritingTurn).toHaveBeenCalled())
    expect(await screen.findByRole('button', { name: '发送' })).toBeDefined()
    expect(databaseMocks.completeWritingTurn).not.toHaveBeenCalled()
  })

  it('无图模式把 none 传给写作落库边界', async () => {
    const user = userEvent.setup()
    configureSendable()
    databaseMocks.beginWritingTurn.mockResolvedValue([
      { id: 'user-1', projectId: project.id, kind: 'user', text: '继续写', order: 0, createdAt: 1 },
      { id: 'notice-1', projectId: project.id, kind: 'notice', title: '生成中', order: 1, createdAt: 1 },
    ])
    databaseMocks.completeWritingTurn.mockResolvedValue(undefined)
    writingMocks.generateWritingTurn.mockResolvedValue({ kind: 'prose', assistantNote: '正文已完成。', chapterAction: 'continue', paragraphs: ['正文。'] })
    render(<App />)

    await user.click(await screen.findByRole('button', { name: '配图模式：按需' }))
    await user.click(screen.getByRole('menuitemradio', { name: /无图/ }))
    await user.type(screen.getByLabelText('创作要求'), '继续写')
    await user.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(databaseMocks.completeWritingTurn).toHaveBeenCalledWith(
      project.id, 'user-1', 'notice-1', expect.anything(), 'none', undefined, undefined,
    ))
  })

  it('停止后迟到的模型结果不会写入正文', async () => {
    const user = userEvent.setup()
    configureSendable()
    databaseMocks.beginWritingTurn.mockResolvedValue([
      { id: 'user-1', projectId: project.id, kind: 'user', text: '继续写', order: 0, createdAt: 1 },
      { id: 'notice-1', projectId: project.id, kind: 'notice', title: '生成中', order: 1, createdAt: 1 },
    ])
    databaseMocks.cancelWritingTurn.mockResolvedValue(undefined)
    let resolveGeneration: (value: unknown) => void = () => undefined
    writingMocks.generateWritingTurn.mockImplementation(() => new Promise((resolve) => { resolveGeneration = resolve }))
    render(<App />)

    await user.type(await screen.findByLabelText('创作要求'), '继续写')
    await user.click(screen.getByRole('button', { name: '发送' }))
    await screen.findByRole('button', { name: '停止生成' })
    await user.click(screen.getByRole('button', { name: '停止生成' }))

    resolveGeneration({ kind: 'prose', assistantNote: '正文已完成。', chapterAction: 'continue', paragraphs: ['迟到正文。'], visualPlan: undefined })
    await waitFor(() => expect(databaseMocks.cancelWritingTurn).toHaveBeenCalled())
    expect(await screen.findByRole('button', { name: '发送' })).toBeDefined()
    expect(databaseMocks.completeWritingTurn).not.toHaveBeenCalled()
  })

  it('本地保存开始后禁用停止按钮，旧点击不会取消已开始的事务', async () => {
    const user = userEvent.setup()
    configureSendable()
    databaseMocks.beginWritingTurn.mockResolvedValue([
      { id: 'user-1', projectId: project.id, kind: 'user', text: '继续写', order: 0, createdAt: 1 },
      { id: 'notice-1', projectId: project.id, kind: 'notice', title: '生成中', order: 1, createdAt: 1 },
    ])
    let completeSave: () => void = () => undefined
    databaseMocks.completeWritingTurn.mockImplementation(() => new Promise<void>((resolve) => { completeSave = resolve }))
    writingMocks.generateWritingTurn.mockResolvedValue({ kind: 'prose', assistantNote: '正文已完成。', chapterAction: 'continue', paragraphs: ['已保存正文。'], visualPlan: undefined })
    render(<App />)

    await user.type(await screen.findByLabelText('创作要求'), '继续写')
    await user.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(databaseMocks.completeWritingTurn).toHaveBeenCalledWith(
      project.id,
      'user-1',
      'notice-1',
      expect.anything(),
      'manual',
      undefined,
      undefined,
    ))

    const savingButton = await screen.findByRole('button', { name: '正在保存' })
    expect((savingButton as HTMLButtonElement).disabled).toBe(true)
    expect(savingButton.querySelector('svg.lucide-save')).not.toBeNull()
    expect(savingButton.querySelector('svg.lucide-square')).toBeNull()
    fireEvent.click(savingButton)
    expect(databaseMocks.cancelWritingTurn).not.toHaveBeenCalled()

    completeSave()
    expect(await screen.findByRole('button', { name: '发送' })).toBeDefined()
  })

  it('失败后重新生成复用原用户消息，不重复发送用户气泡', async () => {
    const user = userEvent.setup()
    configureSendable()
    databaseMocks.loadProjectWorkspace.mockResolvedValue(failedWorkspace)
    databaseMocks.retryWritingTurn.mockResolvedValue({ userText: '继续写', illustrationMode: 'manual' })
    databaseMocks.completeWritingTurn.mockResolvedValue(undefined)
    writingMocks.generateWritingTurn.mockResolvedValue({ kind: 'prose', assistantNote: '正文已完成。', chapterAction: 'continue', paragraphs: ['重试正文。'], visualPlan: undefined })
    render(<App />)

    await user.click(await screen.findByRole('button', { name: '重新生成' }))
    await waitFor(() => expect(databaseMocks.retryWritingTurn).toHaveBeenCalledWith(project.id, 'notice-1'))
    await waitFor(() => expect(writingMocks.generateWritingTurn).toHaveBeenCalled())
    expect(databaseMocks.beginWritingTurn).not.toHaveBeenCalled()
    expect(writingMocks.generateWritingTurn.mock.calls[0][1]).toBe('继续写')
  })

  it('重试请求从上下文排除本轮原用户消息，避免重复注入', async () => {
    const user = userEvent.setup()
    configureSendable()
    databaseMocks.loadProjectWorkspace.mockResolvedValue(failedWorkspace)
    databaseMocks.retryWritingTurn.mockResolvedValue({ userText: '继续写', illustrationMode: 'manual' })
    databaseMocks.completeWritingTurn.mockResolvedValue(undefined)
    writingMocks.generateWritingTurn.mockResolvedValue({ kind: 'prose', assistantNote: '正文已完成。', chapterAction: 'continue', paragraphs: ['重试正文。'], visualPlan: undefined })
    render(<App />)

    await user.click(await screen.findByRole('button', { name: '重新生成' }))
    await waitFor(() => expect(writingMocks.generateWritingTurn).toHaveBeenCalled())
    const options = writingMocks.generateWritingTurn.mock.calls[0][5] as { excludeUserMessageId?: string }
    expect(options.excludeUserMessageId).toBe('user-1')
  })

  it('取消后的消息同样显示重新生成入口', async () => {
    databaseMocks.loadProjectWorkspace.mockResolvedValue({
      ...workspace,
      messages: [
        { id: 'user-1', projectId: project.id, kind: 'user', text: '继续写', order: 0, createdAt: 1 },
        { id: 'notice-1', projectId: project.id, kind: 'notice', title: '生成中', text: '已停止生成，未写入正文。', order: 1, createdAt: 2, status: 'cancelled', userMessageId: 'user-1' },
      ],
    })
    render(<App />)
    expect(await screen.findByRole('button', { name: '重新生成' })).toBeDefined()
  })

  it('点击停止立即持久化取消状态，不等模型结果返回', async () => {
    const user = userEvent.setup()
    configureSendable()
    databaseMocks.beginWritingTurn.mockResolvedValue([
      { id: 'user-1', projectId: project.id, kind: 'user', text: '继续写', order: 0, createdAt: 1 },
      { id: 'notice-1', projectId: project.id, kind: 'notice', title: '生成中', order: 1, createdAt: 1 },
    ])
    databaseMocks.cancelWritingTurn.mockResolvedValue(undefined)
    writingMocks.generateWritingTurn.mockImplementation(() => new Promise(() => { /* 永不返回 */ }))
    render(<App />)

    await user.type(await screen.findByLabelText('创作要求'), '继续写')
    await user.click(screen.getByRole('button', { name: '发送' }))
    await screen.findByRole('button', { name: '停止生成' })
    await user.click(screen.getByRole('button', { name: '停止生成' }))

    // 停止动作本身就把 notice 持久化为 cancelled，后续任何迟到完成都无法提交。
    await waitFor(() => expect(databaseMocks.cancelWritingTurn).toHaveBeenCalledWith('notice-1'))
    expect(databaseMocks.completeWritingTurn).not.toHaveBeenCalled()
  })

  it('创建写作任务失败时保留输入并提示，不进入生成流程', async () => {
    const user = userEvent.setup()
    configureSendable()
    databaseMocks.beginWritingTurn.mockRejectedValue(new Error('本地写入失败'))
    render(<App />)

    const input = await screen.findByLabelText('创作要求')
    await user.type(input, '继续写')
    await user.click(screen.getByRole('button', { name: '发送' }))

    expect(await screen.findByText('本地写入失败')).toBeDefined()
    expect((input as HTMLTextAreaElement).value).toBe('继续写')
    expect(writingMocks.generateWritingTurn).not.toHaveBeenCalled()
  })

  it('作品列表刷新失败时失败本轮任务并恢复输入，不留下永久 pending', async () => {
    const user = userEvent.setup()
    configureSendable()
    databaseMocks.beginWritingTurn.mockResolvedValue([
      { id: 'user-1', projectId: project.id, kind: 'user', text: '继续写', order: 0, createdAt: 1 },
      { id: 'notice-1', projectId: project.id, kind: 'notice', title: '生成中', order: 1, createdAt: 1 },
    ])
    databaseMocks.failWritingTurn.mockResolvedValue(undefined)
    render(<App />)

    await screen.findByLabelText('创作要求')
    databaseMocks.listProjects.mockRejectedValue(new Error('列表刷新失败'))
    await user.type(screen.getByLabelText('创作要求'), '继续写')
    await user.click(screen.getByRole('button', { name: '发送' }))

    await waitFor(() => expect(databaseMocks.failWritingTurn).toHaveBeenCalledWith('notice-1', expect.stringContaining('作品列表刷新失败')))
    expect(writingMocks.generateWritingTurn).not.toHaveBeenCalled()
    expect(await screen.findByText('本轮写作未能启动，请重试')).toBeDefined()
    expect((screen.getByLabelText('创作要求') as HTMLTextAreaElement).value).toBe('继续写')
  })
})

describe('流式滚动行为', () => {
  const secondProject = { ...project, id: 'project-2', title: '第二部作品' }
  const secondWorkspace: ProjectWorkspace = { ...workspace, project: secondProject }

  function stickyFrame() {
    window.requestAnimationFrame = ((callback: FrameRequestCallback) => { callback(0); return 1 }) as typeof window.requestAnimationFrame
  }

  function trackScroll(timeline: HTMLElement, scrollHeight: number, initialTop: number) {
    let top = initialTop
    Object.defineProperty(timeline, 'scrollHeight', { value: scrollHeight, configurable: true })
    Object.defineProperty(timeline, 'clientHeight', { value: 400, configurable: true })
    Object.defineProperty(timeline, 'scrollTop', { get: () => top, set: (value: number) => { top = value }, configurable: true })
    return { get top() { return top } }
  }

  it('用户上滑离开底部后停止跟随并显示回到最新按钮', async () => {
    stickyFrame()
    render(<App />)
    const timeline = await screen.findByLabelText('创作对话')
    const tracked = trackScroll(timeline, 1000, 100)
    fireEvent.scroll(timeline)
    expect(await screen.findByRole('button', { name: '回到最新内容' })).toBeDefined()
    expect(tracked.top).toBe(100)
  })

  it('点击回到最新按钮恢复跟随并隐藏按钮', async () => {
    const user = userEvent.setup()
    stickyFrame()
    render(<App />)
    const timeline = await screen.findByLabelText('创作对话')
    const scrollTo = vi.fn()
    timeline.scrollTo = scrollTo
    trackScroll(timeline, 1000, 100)
    fireEvent.scroll(timeline)
    await user.click(await screen.findByRole('button', { name: '回到最新内容' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: '回到最新内容' })).toBeNull())
    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: 'smooth' })
  })

  it('停留在底部时不显示回到最新按钮', async () => {
    stickyFrame()
    render(<App />)
    const timeline = await screen.findByLabelText('创作对话')
    trackScroll(timeline, 1000, 960)
    fireEvent.scroll(timeline)
    expect(screen.queryByRole('button', { name: '回到最新内容' })).toBeNull()
  })

  it('切换作品后强制滚动到底部并清除回到最新状态', async () => {
    const user = userEvent.setup()
    stickyFrame()
    databaseMocks.listProjects.mockResolvedValue([project, secondProject])
    databaseMocks.loadProjectWorkspace.mockImplementation(async (id) => id === secondProject.id ? secondWorkspace : workspace)
    render(<App />)
    const timeline = await screen.findByLabelText('创作对话')
    const tracked = trackScroll(timeline, 1000, 100)
    fireEvent.scroll(timeline)
    expect(await screen.findByRole('button', { name: '回到最新内容' })).toBeDefined()

    await user.click(screen.getByRole('button', { name: '打开作品列表' }))
    await user.click(await screen.findByRole('button', { name: '切换测试作品' }))

    await waitFor(() => expect(screen.queryByRole('button', { name: '回到最新内容' })).toBeNull())
    await waitFor(() => expect(tracked.top).toBe(1000))
  })
})
