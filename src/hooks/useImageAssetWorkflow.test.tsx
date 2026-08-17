// @vitest-environment jsdom

import { act, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectWorkspace, WritingTurnResult } from '../domain/models'
import { useImageAssetWorkflow } from './useImageAssetWorkflow'

const databaseMocks = vi.hoisted(() => ({
  applyReferenceAppearanceAnalysis: vi.fn(),
  confirmCharacterPortrait: vi.fn(),
  createCharacterDraft: vi.fn(),
  restoreIllustrationsBlockedByReference: vi.fn(),
  setCharacterPortraitFailed: vi.fn(),
  setCharacterPortraitGenerating: vi.fn(),
  setCharacterPortraitReady: vi.fn(),
  setIllustrationBlockedByReference: vi.fn(),
  setIllustrationFailed: vi.fn(),
  setIllustrationGenerating: vi.fn(),
  setIllustrationReady: vi.fn(),
  updateCharacterProfile: vi.fn(),
  updateCharacterReferenceStyleMode: vi.fn(),
}))
const imageMocks = vi.hoisted(() => ({
  persistImageAsset: vi.fn(),
  resolveImageSource: vi.fn((imageUrl?: string, localUri?: string) => localUri ?? imageUrl),
  generateOpenAiImage: vi.fn(),
  editOpenAiImage: vi.fn(),
  resolveImageSize: vi.fn((_config, _orientation, fallback) => fallback),
}))
const secretStoreMocks = vi.hoisted(() => ({ has: vi.fn() }))

vi.mock('../data/storyDatabase', () => databaseMocks)
vi.mock('../providers/imageAssetStore', () => ({
  persistImageAsset: imageMocks.persistImageAsset,
  resolveImageSource: imageMocks.resolveImageSource,
}))
vi.mock('../providers/images', () => ({
  buildCharacterPortraitPrompt: vi.fn(() => 'portrait prompt'),
  generateOpenAiImage: imageMocks.generateOpenAiImage,
  editOpenAiImage: imageMocks.editOpenAiImage,
  resolveImageSize: imageMocks.resolveImageSize,
}))
vi.mock('../providers/browserTransport', () => ({ browserTransport: {} }))
vi.mock('../providers/imagePipelineLog', () => ({ logImagePipeline: vi.fn() }))
vi.mock('../providers/illustrationPrompt', () => ({ buildIllustrationPrompt: vi.fn(() => 'illustration prompt') }))
vi.mock('../providers/referenceAnalysis', () => ({ analyzeReferenceImage: vi.fn() }))
vi.mock('../providers/secretStore', () => ({ secretStore: secretStoreMocks }))

const providerSettings = {
  text: { id: 'text', name: 'text', baseUrl: 'https://text.test', model: 'text-model', protocol: 'openai-compatible' as const, secretRef: 'text-secret' },
  image: { id: 'image', name: 'image', baseUrl: 'https://image.test', model: 'image-model', protocol: 'openai-compatible' as const, secretRef: 'image-secret' },
  textProviders: [],
  imageProviders: [],
}

function createWorkspace(overrides: Partial<ProjectWorkspace> = {}): ProjectWorkspace {
  return {
    project: { id: 'project-1', title: '测试作品', themeId: 'neutral', illustrationMode: 'auto', createdAt: 1, updatedAt: 1, lastOpenedAt: 1 },
    chapters: [],
    messages: [],
    characters: [],
    illustrations: [],
    style: { id: 'unconstrained', visualPrompt: '', negativePrompt: '' },
    ...overrides,
  } as ProjectWorkspace
}

function proseResult(characterNames: string[] = []): WritingTurnResult {
  return {
    kind: 'prose',
    assistantNote: '正文完成',
    chapterAction: 'continue',
    paragraphs: ['正文'],
    visualPlan: {
      title: '画面',
      prompt: '画面描述',
      stylePrompt: '',
      negativePrompt: '',
      characters: characterNames.map((name) => ({ name, role: '主角', ageAndBuild: '', fixedTraits: [], defaultLook: '', wardrobe: '' })),
    },
  }
}

describe('useImageAssetWorkflow', () => {
  beforeEach(() => {
    for (const mock of Object.values(databaseMocks)) mock.mockReset()
    imageMocks.persistImageAsset.mockReset().mockResolvedValue({ imageUrl: 'data:image/png;base64,stored' })
    imageMocks.generateOpenAiImage.mockReset().mockResolvedValue({ kind: 'inline', dataUrl: 'data:image/png;base64,generated' })
    imageMocks.editOpenAiImage.mockReset()
    imageMocks.resolveImageSize.mockClear()
    secretStoreMocks.has.mockReset().mockResolvedValue(true)
  })

  it('stops only portraits not yet started when the automatic portrait queue is cancelled', async () => {
    const workspace = createWorkspace({
      characters: [
        { id: 'character-1', projectId: 'project-1', name: '甲', role: '主角', identity: { ageAndBuild: '', fixedTraits: [] }, appearance: { defaultLook: '', wardrobe: '' }, continuity: { revision: 0, referenceStyleMode: 'project' }, portraitStatus: 'planned', status: 'draft', createdAt: 1, updatedAt: 1 },
        { id: 'character-2', projectId: 'project-1', name: '乙', role: '主角', identity: { ageAndBuild: '', fixedTraits: [] }, appearance: { defaultLook: '', wardrobe: '' }, continuity: { revision: 0, referenceStyleMode: 'project' }, portraitStatus: 'planned', status: 'draft', createdAt: 1, updatedAt: 1 },
      ],
    })
    let releaseFirst!: () => void
    imageMocks.generateOpenAiImage.mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = () => resolve({ kind: 'inline', dataUrl: 'data:image/png;base64,generated' }) }))
    let workflow: ReturnType<typeof useImageAssetWorkflow> | undefined
    const refreshWorkspace = vi.fn().mockResolvedValue(workspace)
    const showToast = vi.fn()

    function Probe() {
      workflow = useImageAssetWorkflow({
        workspace,
        providerSettings,
        refreshWorkspace,
        showToast,
        openProviderSettings: vi.fn(),
        onRequireImageProviderForCharacter: vi.fn(),
        onOpenCharacterAssets: vi.fn(),
        onReferenceImported: vi.fn(),
        onCharacterCreated: vi.fn(),
      })
      return null
    }
    render(<Probe />)

    await act(async () => {
      await workflow!.handleWritingCompleted({ result: proseResult(['甲', '乙']), nextWorkspace: workspace, previousIllustrationIds: new Set(), illustrationMode: 'auto' })
    })
    await waitFor(() => expect(imageMocks.generateOpenAiImage).toHaveBeenCalledTimes(1))
    act(() => workflow!.cancelPortraitGeneration())
    await act(async () => { releaseFirst() })

    await waitFor(() => expect(databaseMocks.setCharacterPortraitReady).toHaveBeenCalledWith('character-1', 'data:image/png;base64,stored', undefined))
    expect(databaseMocks.setCharacterPortraitGenerating).toHaveBeenCalledTimes(1)
    expect(databaseMocks.setCharacterPortraitGenerating).toHaveBeenCalledWith('character-1')
    expect(showToast).toHaveBeenCalledWith('已停止后续定妆照生成；当前请求结束后不会继续排队')
  })

  it('queues only illustrations created by the completed writing turn', async () => {
    const workspace = createWorkspace({
      illustrations: [
        { id: 'existing', projectId: 'project-1', title: '旧图', prompt: '旧画面', referenceCharacterIds: [], status: 'planned', createdAt: 1, updatedAt: 1 },
        { id: 'new', projectId: 'project-1', title: '新图', prompt: '新画面', referenceCharacterIds: [], status: 'planned', createdAt: 2, updatedAt: 2 },
      ],
    })
    let workflow: ReturnType<typeof useImageAssetWorkflow> | undefined
    const showToast = vi.fn()
    function Probe() {
      workflow = useImageAssetWorkflow({
        workspace,
        providerSettings,
        refreshWorkspace: vi.fn().mockResolvedValue(workspace),
        showToast,
        openProviderSettings: vi.fn(),
        onRequireImageProviderForCharacter: vi.fn(),
        onOpenCharacterAssets: vi.fn(),
        onReferenceImported: vi.fn(),
        onCharacterCreated: vi.fn(),
      })
      return null
    }
    render(<Probe />)

    await act(async () => {
      await workflow!.handleWritingCompleted({ result: proseResult(), nextWorkspace: workspace, previousIllustrationIds: new Set(['existing']), illustrationMode: 'auto' })
    })

    await waitFor(() => expect(databaseMocks.setIllustrationReady).toHaveBeenCalledWith('new', 'data:image/png;base64,stored', undefined))
    expect(databaseMocks.setIllustrationGenerating).toHaveBeenCalledWith('new')
    expect(databaseMocks.setIllustrationGenerating).not.toHaveBeenCalledWith('existing')
    expect(showToast).toHaveBeenCalledWith('正文已保存，插画已进入生成队列')
  })
})
