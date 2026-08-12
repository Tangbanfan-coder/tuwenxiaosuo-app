// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectWorkspace, StoryProject } from './domain/models'
import type { ProviderSettings } from './providers/types'

const databaseMocks = vi.hoisted(() => ({
  applyReferenceAppearanceAnalysis: vi.fn(),
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
  toggleFeedbackBatch: vi.fn(),
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

const writingMocks = vi.hoisted(() => ({
  explicitlyRequestsNewChapter: vi.fn(),
  generateWritingTurn: vi.fn(),
  projectStreamingProse: vi.fn(),
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
  default: ({ open, onClose }: { open: boolean; onClose: () => void }) => open ? (
    <section role="dialog" aria-label="角色资产测试入口">
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
vi.mock('./providers/browserTransport', () => ({ browserTransport: {} }))
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
  databaseMocks.toggleFeedbackBatch.mockResolvedValue([])
  databaseMocks.storyDatabase.paragraphs.where.mockReturnValue({
    equals: vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) }),
  })
  databaseMocks.restoreChapterSummaryVersion.mockResolvedValue(undefined)
  writingMocks.explicitlyRequestsNewChapter.mockReset()
  writingMocks.generateWritingTurn.mockReset()
  writingMocks.projectStreamingProse.mockReset()
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
      return { prose: { title: '第一章', paragraphs: ['正文'] }, visualPlan: undefined }
    })
    render(<App />)

    await user.type(await screen.findByLabelText('创作要求'), '继续写')
    await user.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(writingMocks.generateWritingTurn).toHaveBeenCalled())
    expect(screen.getByLabelText('上下文工具栏状态').textContent).toBe('ready:ready:62%')
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
      return { prose: { title: '第一章', paragraphs: ['正文'] }, visualPlan: undefined }
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

  it('shows the explicit auto-illustration state and keeps its persistence flow', async () => {
    const user = userEvent.setup()
    databaseMocks.loadProjectWorkspace.mockResolvedValue({
      ...workspace,
      project: { ...project, autoIllustrate: true },
    })
    render(<App />)

    const button = await screen.findByRole('button', { name: '自动配图：自动' })
    expect(button.textContent).toContain('配图')
    expect(button.textContent).toContain('自动')
    await user.click(button)
    await waitFor(() => expect(databaseMocks.updateAutoIllustrate).toHaveBeenCalledWith(project.id, false))
    expect(screen.getByRole('button', { name: '自动配图：关闭' })).toBeDefined()
  })

  it('enables auto illustration optimistically without reloading the workspace', async () => {
    const user = userEvent.setup()
    providerSettings.image = { ...providerSettings.image, baseUrl: 'https://example.test', model: 'image-test' }
    secretStoreMocks.has.mockResolvedValue(true)
    render(<App />)

    const button = await screen.findByRole('button', { name: '自动配图：关闭' })
    databaseMocks.loadProjectWorkspace.mockClear()
    secretStoreMocks.has.mockClear()
    await user.click(button)

    expect(databaseMocks.updateAutoIllustrate).toHaveBeenCalledWith(project.id, true)
    expect(screen.getByRole('button', { name: '自动配图：自动' })).toBeDefined()
    expect(secretStoreMocks.has).toHaveBeenCalledWith('provider:image')
    expect(databaseMocks.loadProjectWorkspace).not.toHaveBeenCalled()
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
})
