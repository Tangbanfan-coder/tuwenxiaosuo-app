// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectWorkspace, StoryProject } from '../domain/models'
import { useAppBootstrap } from './useAppBootstrap'

const databaseMocks = vi.hoisted(() => ({
  getActiveProjectId: vi.fn(),
  initializeStoryDatabase: vi.fn(),
  listGeneratingImageAssets: vi.fn(),
  listProjects: vi.fn(),
  listReadyLocalIllustrations: vi.fn(),
  loadProjectWorkspace: vi.fn(),
  markProjectOpened: vi.fn(),
  setCharacterPortraitFailed: vi.fn(),
  setCharacterPortraitReady: vi.fn(),
  setIllustrationFailed: vi.fn(),
  setIllustrationReady: vi.fn(),
}))

const imageAssetMocks = vi.hoisted(() => ({
  recoverPersistedImageAsset: vi.fn(),
}))

const modelLimitMocks = vi.hoisted(() => ({
  refreshModelLimits: vi.fn(),
}))

vi.mock('../data/storyDatabase', () => databaseMocks)
vi.mock('../providers/imageAssetStore', () => imageAssetMocks)
vi.mock('../providers/modelLimits', () => modelLimitMocks)

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
    summary: '',
    createdAt: 1,
    updatedAt: 1,
  }],
  characters: [],
  illustrations: [],
}

beforeEach(() => {
  for (const mock of Object.values(databaseMocks)) mock.mockReset()
  for (const mock of Object.values(imageAssetMocks)) mock.mockReset()
  for (const mock of Object.values(modelLimitMocks)) mock.mockReset()

  databaseMocks.initializeStoryDatabase.mockResolvedValue(undefined)
  databaseMocks.listGeneratingImageAssets.mockResolvedValue({ illustrations: [], characters: [] })
  databaseMocks.listReadyLocalIllustrations.mockResolvedValue([])
  databaseMocks.listProjects.mockResolvedValue([project])
  databaseMocks.getActiveProjectId.mockReturnValue(project.id)
  databaseMocks.markProjectOpened.mockResolvedValue(undefined)
  databaseMocks.loadProjectWorkspace.mockResolvedValue(workspace)
  modelLimitMocks.refreshModelLimits.mockResolvedValue(undefined)
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('useAppBootstrap', () => {
  it('restores the active project and finishes booting with projects and workspace', async () => {
    const onEmptyLibrary = vi.fn()
    const onToast = vi.fn()
    const { result } = renderHook(() => useAppBootstrap({ onEmptyLibrary, onToast }))

    await waitFor(() => expect(result.current.booting).toBe(false))

    expect(databaseMocks.initializeStoryDatabase).toHaveBeenCalledTimes(1)
    expect(modelLimitMocks.refreshModelLimits).toHaveBeenCalledTimes(1)
    expect(databaseMocks.markProjectOpened).toHaveBeenCalledWith(project.id)
    expect(databaseMocks.loadProjectWorkspace).toHaveBeenCalledWith(project.id)
    expect(result.current.projects).toEqual([project])
    expect(result.current.workspace).toEqual(workspace)
    expect(result.current.bootError).toBe('')
    expect(onEmptyLibrary).not.toHaveBeenCalled()
  })

  it('reports an empty project library after initialization', async () => {
    const onEmptyLibrary = vi.fn()
    databaseMocks.listProjects.mockResolvedValue([])
    databaseMocks.getActiveProjectId.mockReturnValue(undefined)
    const { result } = renderHook(() => useAppBootstrap({ onEmptyLibrary, onToast: vi.fn() }))

    await waitFor(() => expect(result.current.booting).toBe(false))

    expect(result.current.projects).toEqual([])
    expect(result.current.workspace).toBeNull()
    expect(onEmptyLibrary).toHaveBeenCalledTimes(1)
    expect(databaseMocks.markProjectOpened).not.toHaveBeenCalled()
  })

  it('keeps the error name and message when database initialization fails', async () => {
    const databaseError = new Error('数据库损坏')
    databaseError.name = 'DatabaseOpenError'
    databaseMocks.initializeStoryDatabase.mockRejectedValue(databaseError)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { result } = renderHook(() => useAppBootstrap({ onEmptyLibrary: vi.fn(), onToast: vi.fn() }))

    await waitFor(() => expect(result.current.booting).toBe(false))

    expect(result.current.bootError).toBe('DatabaseOpenError: 数据库损坏')
    expect(consoleError).toHaveBeenCalledWith('本地作品数据库初始化失败', 'DatabaseOpenError: 数据库损坏')
    expect(databaseMocks.listProjects).not.toHaveBeenCalled()
  })

  it('recovers an interrupted illustration and reports the unchanged toast', async () => {
    const onToast = vi.fn()
    databaseMocks.listGeneratingImageAssets.mockResolvedValue({
      illustrations: [{ id: 'illustration-1', projectId: project.id, updatedAt: 42 }],
      characters: [],
    })
    imageAssetMocks.recoverPersistedImageAsset.mockResolvedValue({ localUri: 'local://recovered.png' })
    databaseMocks.setIllustrationReady.mockResolvedValue(undefined)
    const { result } = renderHook(() => useAppBootstrap({ onEmptyLibrary: vi.fn(), onToast }))

    await waitFor(() => expect(result.current.booting).toBe(false))

    expect(imageAssetMocks.recoverPersistedImageAsset).toHaveBeenCalledWith(project.id, 'illustration-1', 42)
    expect(databaseMocks.setIllustrationReady).toHaveBeenCalledWith('illustration-1', '', 'local://recovered.png')
    expect(onToast).toHaveBeenCalledWith('已恢复 1 个图片任务')
  })
})
