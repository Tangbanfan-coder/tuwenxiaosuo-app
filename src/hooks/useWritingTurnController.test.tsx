// @vitest-environment jsdom

import { act, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ProjectWorkspace } from '../domain/models'
import { useWritingTurnController } from './useWritingTurnController'

const databaseMocks = vi.hoisted(() => ({
  beginWritingTurn: vi.fn(),
  cancelWritingTurn: vi.fn(),
  completeWritingTurn: vi.fn(),
  failWritingTurn: vi.fn(),
  recordProseEvaluationEvent: vi.fn(),
  retryWritingTurn: vi.fn(),
  setWritingTurnBackgroundTask: vi.fn(),
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
})
