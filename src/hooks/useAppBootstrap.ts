import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getActiveProjectId,
  initializeStoryDatabase,
  listGeneratingImageAssets,
  listProjects,
  listReadyLocalIllustrations,
  loadProjectWorkspace,
  markProjectOpened,
  setCharacterPortraitFailed,
  setCharacterPortraitReady,
  setIllustrationFailed,
  setIllustrationReady,
} from '../data/storyDatabase'
import type { ProjectWorkspace, StoryProject } from '../domain/models'
import { recoverPersistedImageAsset } from '../providers/imageAssetStore'
import { refreshModelLimits } from '../providers/modelLimits'

const IMAGE_INTEGRITY_AUDIT_KEY = 'illustrated-story-chat.image-integrity-audit.v1'

type UseAppBootstrapOptions = {
  onEmptyLibrary: () => void
  onToast: (message: string) => void
}

async function recoverInterruptedImageTasks() {
  const pending = await listGeneratingImageAssets()
  let recoveredCount = 0
  let failedCount = 0

  for (const illustration of pending.illustrations) {
    const storedImage = await recoverPersistedImageAsset(illustration.projectId, illustration.id, illustration.updatedAt)
    if (storedImage?.localUri) {
      await setIllustrationReady(illustration.id, '', storedImage.localUri)
      recoveredCount += 1
    } else {
      await setIllustrationFailed(illustration.id, '上次生成任务被中断，未发现已保存图片，请手动重试')
      failedCount += 1
    }
  }

  for (const character of pending.characters) {
    const storedImage = await recoverPersistedImageAsset(character.projectId, character.id, character.updatedAt)
    if (storedImage?.localUri) {
      await setCharacterPortraitReady(character.id, character.continuity.referenceImageUrl ?? '', storedImage.localUri, character.continuity.referenceStyleMode)
      recoveredCount += 1
    } else {
      await setCharacterPortraitFailed(character.id, '上次生成任务被中断，未发现已保存图片，请手动重试')
      failedCount += 1
    }
  }

  return { recoveredCount, failedCount }
}

async function auditLegacyLocalIllustrations() {
  if (localStorage.getItem(IMAGE_INTEGRITY_AUDIT_KEY) === 'complete') return 0

  const illustrations = await listReadyLocalIllustrations()
  let invalidCount = 0
  for (const illustration of illustrations) {
    const storedImage = await recoverPersistedImageAsset(illustration.projectId, illustration.id)
    if (storedImage?.localUri) continue
    await setIllustrationFailed(illustration.id, '手机中的图片文件不完整，请手动重新生成')
    invalidCount += 1
  }
  localStorage.setItem(IMAGE_INTEGRITY_AUDIT_KEY, 'complete')
  return invalidCount
}

export function useAppBootstrap({ onEmptyLibrary, onToast }: UseAppBootstrapOptions) {
  const [projects, setProjects] = useState<StoryProject[]>([])
  const [workspace, setWorkspace] = useState<ProjectWorkspace | null>(null)
  const [booting, setBooting] = useState(true)
  const [bootError, setBootError] = useState('')
  const onEmptyLibraryRef = useRef(onEmptyLibrary)
  const onToastRef = useRef(onToast)
  onEmptyLibraryRef.current = onEmptyLibrary
  onToastRef.current = onToast

  const refreshProjects = useCallback(async () => {
    const nextProjects = await listProjects()
    setProjects(nextProjects)
    return nextProjects
  }, [])

  const refreshWorkspace = useCallback(async (projectId: string) => {
    const nextWorkspace = await loadProjectWorkspace(projectId)
    if (nextWorkspace) setWorkspace(nextWorkspace)
    return nextWorkspace
  }, [])

  const openProject = useCallback(async (projectId: string) => {
    await markProjectOpened(projectId)
    const nextWorkspace = await loadProjectWorkspace(projectId)
    if (nextWorkspace) setWorkspace(nextWorkspace)
    await refreshProjects()
  }, [refreshProjects])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        await initializeStoryDatabase()
        void refreshModelLimits()
        const recovery = await recoverInterruptedImageTasks()
        const invalidLegacyImages = await auditLegacyLocalIllustrations()
        const availableProjects = await listProjects()
        if (cancelled) return
        if (invalidLegacyImages) {
          onToastRef.current(`发现 ${invalidLegacyImages} 张不完整图片，请手动重新生成`)
        } else if (recovery.recoveredCount || recovery.failedCount) {
          onToastRef.current(`已恢复 ${recovery.recoveredCount} 个图片任务${recovery.failedCount ? `，${recovery.failedCount} 个任务需要手动重试` : ''}`)
        }
        setProjects(availableProjects)
        const savedProjectId = getActiveProjectId()
        const initialProject = availableProjects.find((project) => project.id === savedProjectId) ?? availableProjects[0]
        if (initialProject) {
          await markProjectOpened(initialProject.id)
          const initialWorkspace = await loadProjectWorkspace(initialProject.id)
          if (!cancelled) setWorkspace(initialWorkspace)
        } else if (!cancelled) {
          onEmptyLibraryRef.current()
        }
      } catch (error) {
        const message = error instanceof Error ? `${error.name}: ${error.message}` : '未知的本地存储错误'
        console.error('本地作品数据库初始化失败', message)
        if (!cancelled) setBootError(message)
      } finally {
        if (!cancelled) setBooting(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  return {
    bootError,
    booting,
    openProject,
    projects,
    refreshProjects,
    refreshWorkspace,
    setProjects,
    setWorkspace,
    workspace,
  }
}
