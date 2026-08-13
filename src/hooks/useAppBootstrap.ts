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
  getWritingNotice,
  setWritingTurnBackgroundTask,
  completeWritingTurn,
  failWritingTurn,
} from '../data/storyDatabase'
import type { ProjectWorkspace, StoryProject } from '../domain/models'
import { recoverPersistedImageAsset } from '../providers/imageAssetStore'
import { refreshModelLimits } from '../providers/modelLimits'
import {
  acknowledgeBackgroundGenerationTask,
  listBackgroundGenerationTasks,
  readBackgroundGenerationTask,
} from '../providers/backgroundGeneration'
import { parseBackgroundWritingResponse } from '../providers/writing'

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

async function recoverBackgroundGenerationTasks() {
  const tasks = await listBackgroundGenerationTasks()
  let recovered = 0
  let unknown = 0
  // Drive recovery from native metadata first. This also closes the narrow
  // enqueue-success/IndexedDB-link-failure window without recreating a task.
  for (const task of tasks) {
    if (task.kind !== 'text') continue
    const metadata = task.metadata as { noticeId?: string; projectId?: string; userMessageId?: string; autoIllustrate?: boolean; forceNewChapter?: boolean } | undefined
    if (!metadata?.noticeId) continue
    const notice = await getWritingNotice(metadata.noticeId)
    if (!notice) continue
    // A committed database result is already exactly-once consumed, even if
    // the acknowledgement after it was interrupted.
    if (notice.status === 'ready' || notice.status === 'failed') {
      await acknowledgeBackgroundGenerationTask(task.id)
      continue
    }
    if (notice.status !== 'pending') continue
    if (!notice.backgroundTaskId) await setWritingTurnBackgroundTask(notice.id, task.id)
    if (task.state === 'completed') {
      // The native list() payload deliberately omits rawResponse; the detail
      // call below is the only source for the committed response body.
      const completedTask = task.rawResponse ? task : await readBackgroundGenerationTask(task.id)
      if (!completedTask?.rawResponse) continue
      let parsed
      try {
        if (!metadata?.projectId || !metadata.userMessageId) throw new Error('后台任务缺少写作关联信息')
        parsed = parseBackgroundWritingResponse(completedTask.rawResponse)
      } catch (error) {
        await failWritingTurn(notice.id, error instanceof Error ? error.message : '后台写作结果无法解析')
        await acknowledgeBackgroundGenerationTask(task.id)
        continue
      }
      try {
        await completeWritingTurn(metadata.projectId, metadata.userMessageId, notice.id, parsed, Boolean(metadata.autoIllustrate), Boolean(metadata.forceNewChapter), task.id)
        await acknowledgeBackgroundGenerationTask(task.id)
        recovered += 1
      } catch {
        // The raw response remains native-durable. Leave this notice pending
        // and do not acknowledge so a later boot can retry local consumption.
      }
    } else if (task.state === 'failed') {
      await failWritingTurn(notice.id, task.error || '后台写作失败')
      await acknowledgeBackgroundGenerationTask(task.id)
    } else if (task.state === 'unknown') {
      unknown += 1
    }
  }
  // Image DB state can already have been recovered from a local file before
  // this scan. Completed native tasks are acknowledgement-only in that case.
  for (const task of tasks) {
    // recoverInterruptedImageTasks has already made each generating asset
    // ready (when a valid local file exists) or failed with a visible manual
    // retry message. No unknown image task is silently retained or retried.
    if (task.kind === 'image' && (task.state === 'completed' || task.state === 'failed' || task.state === 'unknown')) {
      await acknowledgeBackgroundGenerationTask(task.id)
    }
  }
  return { recovered, unknown }
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
        const backgroundRecovery = await recoverBackgroundGenerationTasks()
        const invalidLegacyImages = await auditLegacyLocalIllustrations()
        const availableProjects = await listProjects()
        if (cancelled) return
        if (invalidLegacyImages) {
          onToastRef.current(`发现 ${invalidLegacyImages} 张不完整图片，请手动重新生成`)
        } else if (backgroundRecovery.recovered || backgroundRecovery.unknown) {
          onToastRef.current(`已补收 ${backgroundRecovery.recovered} 个写作结果${backgroundRecovery.unknown ? `，${backgroundRecovery.unknown} 个已发送任务状态不明且未重试` : ''}`)
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
