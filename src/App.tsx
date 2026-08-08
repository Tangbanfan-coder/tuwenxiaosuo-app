import { useCallback, useEffect, useRef, useState } from 'react'
import {
  BookOpen,
  Check,
  ChevronDown,
  Download,
  ImagePlus,
  LoaderCircle,
  Maximize2,
  Menu,
  RotateCcw,
  Send,
  Settings,
  Sparkles,
  TriangleAlert,
  UserRound,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import ProjectDrawer from './components/ProjectDrawer'
import CharacterAssetsDrawer from './components/CharacterAssetsDrawer'
import ProviderSettingsDialog from './components/ProviderSettingsDialog'
import ReferenceImageDialog, { type ReferenceImageTarget } from './components/ReferenceImageDialog'
import SettingsDrawer from './components/SettingsDrawer'
import WritingInstructionsDialog from './components/WritingInstructionsDialog'
import {
  beginWritingTurn,
  completeWritingTurn,
  confirmCharacterPortrait,
  createCharacterDraft,
  createProject,
  deleteProject,
  failWritingTurn,
  getActiveProjectId,
  initializeStoryDatabase,
  listGeneratingImageAssets,
  listProjects,
  listReadyLocalIllustrations,
  loadProjectWorkspace,
  markProjectOpened,
  renameProject,
  setCharacterPortraitFailed,
  setCharacterPortraitGenerating,
  setCharacterPortraitReady,
  setIllustrationFailed,
  setIllustrationGenerating,
  setIllustrationReady,
  updateAutoIllustrate,
  updateCharacterReferenceStyleMode,
  updateContextBudget,
  updateIllustrationStyle,
  updateProjectTheme,
  updateWritingInstructions,
  updateWritingStructure,
} from './data/storyDatabase'
import { resolveProjectIllustrationStyle } from './domain/illustrationStyles'
import type { AppearanceMode, CharacterAsset, ContextBudget, ConversationMessage, IllustrationAsset, IllustrationStylePresetId, ProjectWorkspace, ReferenceStyleMode, StoryProject, ThemePresetId } from './domain/models'
import { browserTransport } from './providers/browserTransport'
import { loadProviderSettings, saveProviderSettings } from './providers/config'
import { refreshModelLimits } from './providers/modelLimits'
import { persistImageAsset, recoverPersistedImageAsset, resolveImageSource, saveImageToDevice } from './providers/imageAssetStore'
import { usePresence } from './hooks/usePresence'
import ConfirmDialog from './components/ConfirmDialog'
import { buildCharacterPortraitPrompt, editOpenAiImage, generateOpenAiImage } from './providers/images'
import { secretStore } from './providers/secretStore'
import type { ProviderSettings, ProviderSlot } from './providers/types'
import { explicitlyRequestsNewChapter, generateWritingTurn } from './providers/writing'

const APPEARANCE_KEY = 'illustrated-story-chat.appearance.v1'
const IMAGE_INTEGRITY_AUDIT_KEY = 'illustrated-story-chat.image-integrity-audit.v1'

function characterHasConfirmedReference(character: CharacterAsset | undefined) {
  return Boolean(
    character
      && character.status === 'confirmed'
      && (character.continuity.referenceImageUrl || character.continuity.localUri),
  )
}

function illustrationReferencesReady(illustration: IllustrationAsset, characters: CharacterAsset[]) {
  return illustration.referenceCharacterIds.every((characterId) => (
    characterHasConfirmedReference(characters.find((character) => character.id === characterId))
  ))
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

function loadAppearanceMode(): AppearanceMode {
  return localStorage.getItem(APPEARANCE_KEY) === 'light' ? 'light' : 'dark'
}

export default function App() {
  const timelineRef = useRef<HTMLElement>(null)
  const imageQueueRef = useRef<Promise<void>>(Promise.resolve())
  const queuedIllustrationIdsRef = useRef(new Set<string>())
  const [projects, setProjects] = useState<StoryProject[]>([])
  const [workspace, setWorkspace] = useState<ProjectWorkspace | null>(null)
  const [draft, setDraft] = useState('')
  const [booting, setBooting] = useState(true)
  const [bootError, setBootError] = useState('')
  const [sending, setSending] = useState(false)
  const [projectMenuOpen, setProjectMenuOpen] = useState(false)
  const [appSettingsOpen, setAppSettingsOpen] = useState(false)
  const [characterAssetsOpen, setCharacterAssetsOpen] = useState(false)
  const [referenceImageOpen, setReferenceImageOpen] = useState(false)
  const [writingInstructionsOpen, setWritingInstructionsOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSlot, setSettingsSlot] = useState<ProviderSlot>('text')
  const [returnToSettingsDrawer, setReturnToSettingsDrawer] = useState(false)
  const [toast, setToast] = useState<{ text: string; kind: 'success' | 'error' }>()
  const [providerSettings, setProviderSettings] = useState<ProviderSettings>(() => loadProviderSettings())
  const [imageProviderReady, setImageProviderReady] = useState(false)
  const [appearanceMode, setAppearanceMode] = useState<AppearanceMode>(() => loadAppearanceMode())
  const [visibleChapterId, setVisibleChapterId] = useState<string>()
  const [lightboxImage, setLightboxImage] = useState<{ source: string; title: string; alt: string; localUri?: string }>()
  const [streamingText, setStreamingText] = useState('')
  const [confirmState, setConfirmState] = useState<{
    title: string
    message: string
    confirmLabel?: string
    danger?: boolean
    onConfirm: () => void
  }>()

  const showToast = useCallback((text: string, kind: 'success' | 'error' = 'success') => {
    setToast({ text, kind })
  }, [])

  const syncVisibleChapterFromScroll = useCallback(() => {
    const timeline = timelineRef.current
    if (!timeline) return
    const anchors = Array.from(timeline.querySelectorAll<HTMLElement>('[data-chapter-id]'))
    if (!anchors.length) return
    const threshold = timeline.getBoundingClientRect().top + 24
    let nextChapterId = anchors[0].dataset.chapterId
    for (const anchor of anchors) {
      if (anchor.getBoundingClientRect().top > threshold) break
      nextChapterId = anchor.dataset.chapterId
    }
    if (nextChapterId) setVisibleChapterId((current) => current === nextChapterId ? current : nextChapterId)
  }, [])

  const refreshProjects = useCallback(async () => {
    const nextProjects = await listProjects()
    setProjects(nextProjects)
    return nextProjects
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
          showToast(`发现 ${invalidLegacyImages} 张不完整图片，请手动重新生成`)
        } else if (recovery.recoveredCount || recovery.failedCount) {
          showToast(`已恢复 ${recovery.recoveredCount} 个图片任务${recovery.failedCount ? `，${recovery.failedCount} 个任务需要手动重试` : ''}`)
        }
        setProjects(availableProjects)
        const savedProjectId = getActiveProjectId()
        const initialProject = availableProjects.find((project) => project.id === savedProjectId) ?? availableProjects[0]
        if (initialProject) {
          await markProjectOpened(initialProject.id)
          const initialWorkspace = await loadProjectWorkspace(initialProject.id)
          if (!cancelled) setWorkspace(initialWorkspace)
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

  useEffect(() => {
    if (booting) return
    const frame = window.requestAnimationFrame(() => {
      timelineRef.current?.scrollTo({ top: timelineRef.current.scrollHeight, behavior: 'smooth' })
      window.requestAnimationFrame(syncVisibleChapterFromScroll)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [booting, workspace?.project.id, workspace?.messages.length, streamingText, syncVisibleChapterFromScroll])

  useEffect(() => {
    const defaultChapterId = workspace?.project.activeChapterId ?? workspace?.chapters[0]?.id
    setVisibleChapterId(defaultChapterId)
  }, [workspace?.project.id])

  useEffect(() => {
    if (!toast) return
    const timeout = window.setTimeout(() => setToast(undefined), 2600)
    return () => window.clearTimeout(timeout)
  }, [toast])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const provider = providerSettings.image
      const ready = Boolean(provider.baseUrl.trim() && provider.model.trim() && await secretStore.has(provider.secretRef))
      if (!cancelled) setImageProviderReady(ready)
    })()
    return () => { cancelled = true }
  }, [providerSettings.image])

  async function handleCreateProject(title: string) {
    const project = await createProject(title)
    await openProject(project.id)
    setProjectMenuOpen(false)
  }

  async function handleRenameProject(projectId: string, title: string) {
    const normalizedTitle = await renameProject(projectId, title)
    setProjects((current) => current.map((project) => project.id === projectId ? { ...project, title: normalizedTitle, updatedAt: Date.now() } : project))
    setWorkspace((current) => current?.project.id === projectId ? { ...current, project: { ...current.project, title: normalizedTitle } } : current)
    showToast('作品已重命名')
  }

  async function handleDeleteProject(projectId: string) {
    const project = projects.find((item) => item.id === projectId)
    if (!project) return
    setConfirmState({
      title: '删除作品',
      message: `确定删除作品“${project.title}”吗？正文、角色和插画都会被删除，且无法撤销。`,
      confirmLabel: '删除',
      danger: true,
      onConfirm: async () => {
        try {
          const deletingActive = workspace?.project.id === projectId
          await deleteProject(projectId)
          const remaining = await refreshProjects()
          if (deletingActive) {
            const nextProject = remaining[0] ?? await createProject('未命名作品')
            await openProject(nextProject.id)
          }
          showToast(`已删除作品“${project.title}”`)
        } catch (error) {
          showToast(error instanceof Error ? error.message : '删除作品失败', 'error')
        }
      },
    })
  }

  async function handleThemeChange(themeId: ThemePresetId) {
    if (!workspace) return
    await updateProjectTheme(workspace.project.id, themeId)
    const nextWorkspace = await loadProjectWorkspace(workspace.project.id)
    if (nextWorkspace) setWorkspace(nextWorkspace)
    await refreshProjects()
  }

  async function handleIllustrationStyleChange(styleId: IllustrationStylePresetId, customPrompt?: string) {
    if (!workspace) return
    try {
      await updateIllustrationStyle(workspace.project.id, styleId, customPrompt)
      await refreshWorkspace(workspace.project.id)
      await refreshProjects()
      showToast('插画画风已更新，将用于之后生成的图片')
    } catch (error) {
      showToast(error instanceof Error ? error.message : '插画画风保存失败', 'error')
      throw error
    }
  }

  async function handleWritingInstructionsSave(value: string) {
    if (!workspace) return
    try {
      await updateWritingInstructions(workspace.project.id, value)
      await refreshWorkspace(workspace.project.id)
      await refreshProjects()
      showToast(value.trim() ? '长期创作设定已保存' : '长期创作设定已清除')
    } catch (error) {
      showToast(error instanceof Error ? error.message : '长期创作设定保存失败', 'error')
      throw error
    }
  }

  function handleAppearanceChange(mode: AppearanceMode) {
    setAppearanceMode(mode)
    localStorage.setItem(APPEARANCE_KEY, mode)
  }

  function openProviderSettings(slot: ProviderSlot, returnToDrawer = false) {
    setSettingsSlot(slot)
    setReturnToSettingsDrawer(returnToDrawer)
    if (returnToDrawer) setAppSettingsOpen(false)
    setSettingsOpen(true)
  }

  function closeProviderSettings() {
    setSettingsOpen(false)
    if (!returnToSettingsDrawer) return
    setReturnToSettingsDrawer(false)
    setAppSettingsOpen(true)
  }

  async function handleAutoIllustrate(autoIllustrate: boolean) {
    if (!workspace) return
    setWorkspace((current) => current ? {
      ...current,
      project: { ...current.project, autoIllustrate },
    } : current)
    await updateAutoIllustrate(workspace.project.id, autoIllustrate)
  }

  async function handleContextBudgetChange(contextBudget: ContextBudget) {
    if (!workspace) return
    setWorkspace((current) => current ? {
      ...current,
      project: { ...current.project, contextBudget },
    } : current)
    await updateContextBudget(workspace.project.id, contextBudget)
  }

  async function providerIsReady(slot: ProviderSlot) {
    const provider = providerSettings[slot]
    return Boolean(provider.baseUrl.trim() && provider.model.trim() && await secretStore.has(provider.secretRef))
  }

  async function refreshWorkspace(projectId: string) {
    const nextWorkspace = await loadProjectWorkspace(projectId)
    if (nextWorkspace) setWorkspace(nextWorkspace)
    return nextWorkspace
  }

  function enqueueImageTask(task: () => Promise<void>) {
    const queued = imageQueueRef.current.then(task, task)
    imageQueueRef.current = queued.catch(() => undefined)
    return queued
  }

  function queueIllustration(illustration: IllustrationAsset, sourceWorkspace: ProjectWorkspace) {
    if (queuedIllustrationIdsRef.current.has(illustration.id)) return Promise.resolve()
    queuedIllustrationIdsRef.current.add(illustration.id)
    return enqueueImageTask(async () => {
      try {
        await generateIllustration(illustration, sourceWorkspace)
      } finally {
        queuedIllustrationIdsRef.current.delete(illustration.id)
      }
    })
  }

  async function generateCharacterPortrait(character: CharacterAsset, sourceWorkspace: ProjectWorkspace, feedback?: string) {
    await setCharacterPortraitGenerating(character.id)
    await refreshWorkspace(sourceWorkspace.project.id)
    try {
      const prompt = buildCharacterPortraitPrompt(character, sourceWorkspace.style, feedback)
      const currentReference = resolveImageSource(character.continuity.referenceImageUrl, character.continuity.localUri)
      const imageUrl = feedback && currentReference
        ? await editOpenAiImage(providerSettings.image, prompt, [currentReference], browserTransport)
        : await generateOpenAiImage(providerSettings.image, prompt, browserTransport)
      const storedImage = await persistImageAsset(imageUrl, sourceWorkspace.project.id, character.id)
      await setCharacterPortraitReady(character.id, storedImage.imageUrl, storedImage.localUri)
      await refreshWorkspace(sourceWorkspace.project.id)
      showToast(`${character.name}的定妆照等待确认`)
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误'
      await setCharacterPortraitFailed(character.id, message)
      await refreshWorkspace(sourceWorkspace.project.id)
      showToast(`${character.name}的定妆照生成失败`, 'error')
    }
  }

  async function requestCharacterPortrait(characterId: string, feedback?: string) {
    if (!workspace) return
    const character = workspace.characters.find((item) => item.id === characterId)
    if (!character) return
    if (!(await providerIsReady('image'))) {
      setCharacterAssetsOpen(false)
      openProviderSettings('image')
      showToast('请先完成图片模型配置')
      return
    }
    await enqueueImageTask(() => generateCharacterPortrait(character, workspace, feedback))
  }

  async function importCharacterReference(target: ReferenceImageTarget, dataUrl: string, referenceStyleMode: ReferenceStyleMode) {
    if (!workspace) return
    try {
      const characterId = 'characterId' in target
        ? target.characterId
        : (await createCharacterDraft(workspace.project.id, target.name, target.role)).id
      const storedImage = await persistImageAsset(dataUrl, workspace.project.id, characterId)
      await setCharacterPortraitReady(characterId, storedImage.imageUrl, storedImage.localUri, referenceStyleMode)
      await refreshWorkspace(workspace.project.id)
      setReferenceImageOpen(false)
      setCharacterAssetsOpen(true)
      showToast('参考图已导入，请确认角色外貌')
    } catch (error) {
      showToast(error instanceof Error ? error.message : '参考图导入失败', 'error')
    }
  }

  async function handleReferenceStyleModeChange(characterId: string, referenceStyleMode: ReferenceStyleMode) {
    if (!workspace) return
    await updateCharacterReferenceStyleMode(characterId, referenceStyleMode)
    await refreshWorkspace(workspace.project.id)
    showToast(referenceStyleMode === 'project' ? '该角色会统一为作品画风' : '该角色会保留参考图画风')
  }

  async function generateIllustration(illustration: IllustrationAsset, sourceWorkspace: ProjectWorkspace) {
    await setIllustrationGenerating(illustration.id)
    await refreshWorkspace(sourceWorkspace.project.id)
    try {
      const referenceCharacters = illustration.referenceCharacterIds
        .map((characterId) => sourceWorkspace.characters.find((character) => character.id === characterId))
        .filter((character): character is CharacterAsset => characterHasConfirmedReference(character))
      const referenceSources = referenceCharacters
        .map((character) => resolveImageSource(character.continuity.referenceImageUrl, character.continuity.localUri) as string)
      const illustrationStyle = resolveProjectIllustrationStyle(sourceWorkspace.style)
      const referenceRules = referenceCharacters.map((character, index) => {
        const mode = character.continuity.referenceStyleMode ?? 'project'
        return mode === 'reference'
          ? `参考图 ${index + 1}（${character.name}）：保留参考图自身的绘制或摄影风格；这是用户明确设置的跨画风角色。`
          : `参考图 ${index + 1}（${character.name}）：只提取身份、五官、发型和服装等外貌信息，必须重新渲染为作品统一画风。`
      })
      const prompt = [
        illustration.prompt,
        `作品统一画风：${illustrationStyle.visualPrompt}`,
        illustration.sceneStylePrompt && `本场景补充：${illustration.sceneStylePrompt}。如果与作品统一画风冲突，以作品统一画风为准。`,
        referenceRules.length && `参考图使用规则：\n${referenceRules.join('\n')}\n没有参考图的其他角色一律使用作品统一画风。`,
        `避免：${[illustrationStyle.negativePrompt, illustration.sceneNegativePrompt].filter(Boolean).join('；')}`,
      ].filter(Boolean).join('\n')
      const imageUrl = referenceSources.length
        ? await editOpenAiImage(providerSettings.image, prompt, referenceSources, browserTransport, '1536x1024')
        : await generateOpenAiImage(providerSettings.image, prompt, browserTransport, '1536x1024')
      const storedImage = await persistImageAsset(imageUrl, sourceWorkspace.project.id, illustration.id)
      await setIllustrationReady(illustration.id, storedImage.imageUrl, storedImage.localUri)
      await refreshWorkspace(sourceWorkspace.project.id)
      showToast('剧情插画已生成')
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误'
      await setIllustrationFailed(illustration.id, message)
      await refreshWorkspace(sourceWorkspace.project.id)
      showToast('剧情插画生成失败，没有自动重试', 'error')
    }
  }

  async function confirmCharacter(characterId: string) {
    if (!workspace) return
    await confirmCharacterPortrait(characterId)
    const nextWorkspace = await refreshWorkspace(workspace.project.id)
    if (!nextWorkspace || !nextWorkspace.project.autoIllustrate || !(await providerIsReady('image'))) return
    const eligible = nextWorkspace.illustrations.filter((illustration) => {
      if (illustration.status !== 'planned') return false
      return illustrationReferencesReady(illustration, nextWorkspace.characters)
    })
    for (const illustration of eligible) {
      void queueIllustration(illustration, nextWorkspace)
    }
  }

  async function retryIllustration(illustrationId: string) {
    if (!workspace || !(await providerIsReady('image'))) {
      openProviderSettings('image')
      showToast('请先完成图片模型配置')
      return
    }
    const illustration = workspace.illustrations.find((item) => item.id === illustrationId)
    if (!illustration) return
    if (illustration.status === 'generating' || !illustrationReferencesReady(illustration, workspace.characters)) {
      setCharacterAssetsOpen(true)
      return
    }
    await queueIllustration(illustration, workspace)
  }

  async function sendMessage() {
    const text = draft.trim()
    if (!text || !workspace || sending) return

    const textProvider = providerSettings.text
    if (!textProvider.baseUrl.trim() || !textProvider.model.trim() || !(await secretStore.has(textProvider.secretRef))) {
      showToast('请先完成文本模型配置')
      openProviderSettings('text')
      return
    }

      setSending(true)
      setDraft('')
      setStreamingText('')
      let noticeId: string | undefined
      try {
      const addedMessages = await beginWritingTurn(
        workspace.project.id,
        text,
        workspace.project.autoIllustrate,
        workspace.project.activeChapterId,
      )
      const userMessageId = addedMessages[0].id
      noticeId = addedMessages[1].id
      const previousIllustrationIds = new Set(workspace.illustrations.map((illustration) => illustration.id))
      setWorkspace((current) => current && current.project.id === workspace.project.id ? {
        ...current,
        project: { ...current.project, updatedAt: Date.now() },
        messages: [...current.messages, ...addedMessages],
      } : current)
      await refreshProjects()
      const result = await generateWritingTurn(workspace, text, textProvider, browserTransport, (delta) => {
        setStreamingText((current) => current + delta)
      }, (message) => showToast(message, 'error'))
      await completeWritingTurn(
        workspace.project.id,
        userMessageId,
        noticeId,
        result,
        workspace.project.autoIllustrate,
        explicitlyRequestsNewChapter(text),
      )
      const nextWorkspace = await loadProjectWorkspace(workspace.project.id)
      if (nextWorkspace) setWorkspace(nextWorkspace)
      await refreshProjects()
      if (result.visualPlan && workspace.project.autoIllustrate && nextWorkspace) {
        const newCharacterNames = new Set(result.visualPlan.characters.map((character) => character.name.toLocaleLowerCase()))
        const portraits = nextWorkspace.characters.filter((character) =>
          newCharacterNames.has(character.name.toLocaleLowerCase()) && (character.portraitStatus ?? 'planned') === 'planned',
        )
        const newIllustrations = nextWorkspace.illustrations.filter((illustration) => !previousIllustrationIds.has(illustration.id))
        const imageReady = await providerIsReady('image')
        const readyIllustrations = newIllustrations.filter((illustration) => (
          illustration.status === 'planned' && illustrationReferencesReady(illustration, nextWorkspace.characters)
        ))
        if (portraits.length && imageReady) {
          void enqueueImageTask(async () => {
            for (const character of portraits) await generateCharacterPortrait(character, nextWorkspace)
          })
          showToast('正文已保存，定妆照已进入生成队列')
        } else if (!imageReady) {
          showToast('正文和视觉计划已保存；请先配置图片模型')
        } else if (readyIllustrations.length) {
          for (const illustration of readyIllustrations) void queueIllustration(illustration, nextWorkspace)
          showToast('正文已保存，插画已进入生成队列')
        } else {
          showToast(newIllustrations.length ? '正文和视觉计划已保存；请先确认角色定妆照' : '正文和视觉计划已保存')
        }
      } else {
        showToast('正文已保存')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误'
      if (noticeId) {
        await failWritingTurn(noticeId, message)
        const nextWorkspace = await loadProjectWorkspace(workspace.project.id)
        if (nextWorkspace) setWorkspace(nextWorkspace)
      } else {
        setDraft(text)
      }
      showToast('本轮写作未完成', 'error')
    } finally {
      setSending(false)
      setStreamingText('')
    }
  }

  if (bootError) {
    return (
      <main className="app-shell loading-shell">
        <div className="storage-error" role="alert">
          <BookOpen size={24} />
          <h1>无法打开本地作品库</h1>
          <p>{bootError}</p>
          <button className="primary-button" type="button" onClick={() => window.location.reload()}>重新尝试</button>
        </div>
      </main>
    )
  }

  if (booting || !workspace) {
    return (
      <main className="app-shell loading-shell" aria-busy="true">
        <div className="loading-mark"><BookOpen size={22} /><span>正在打开作品…</span></div>
      </main>
    )
  }

  const activeChapter = workspace.chapters.find((chapter) => chapter.id === workspace.project.activeChapterId) ?? workspace.chapters[0]
  const visibleChapter = workspace.chapters.find((chapter) => chapter.id === visibleChapterId) ?? activeChapter
  const illustrationStyle = resolveProjectIllustrationStyle(workspace.style)
  const fallbackChapterId = workspace.chapters[0]?.id
  let previousMessageChapterId: string | undefined

  return (
    <main className="app-shell" data-appearance={appearanceMode}>
      <header className="topbar">
        <button className="icon-button" type="button" aria-label="打开作品列表" onClick={() => setProjectMenuOpen(true)}>
          <Menu size={21} />
        </button>
        <button className="project-title" type="button" aria-expanded={projectMenuOpen} onClick={() => setProjectMenuOpen(true)}>
          <BookOpen size={16} />
          <span>{workspace.project.title}</span>
          <ChevronDown size={15} />
        </button>
        <button
          className="icon-button"
          type="button"
          aria-label="打开设置"
          aria-expanded={appSettingsOpen}
          onClick={() => setAppSettingsOpen(true)}
        >
          <Settings size={20} />
        </button>
      </header>

      <div className="story-stage" data-theme={workspace.project.themeId}>
        <section className="story-meta">
          <h1>{visibleChapter?.title ?? workspace.project.title}</h1>
          <button
            className="character-count"
            type="button"
            aria-label={`查看角色资产，共 ${workspace.characters.length} 个角色`}
            onClick={() => setCharacterAssetsOpen(true)}
          >
            <UserRound size={18} aria-hidden="true" />
            <span>{workspace.characters.length} 个角色</span>
          </button>
        </section>

        <section ref={timelineRef} className="timeline" aria-label="创作对话" aria-live="polite" onScroll={syncVisibleChapterFromScroll}>
          {workspace.messages.length === 0 ? (
            <div className="empty-story">
              <BookOpen size={28} />
              <h2>这部作品还没有第一句话</h2>
              <p>可以写下题材、人物或一个场景。之后生成的正文、角色和插画只属于这部作品。</p>
            </div>
          ) : (
            workspace.messages.map((message) => {
              const illustration = message.illustrationId
                ? workspace.illustrations.find((item) => item.id === message.illustrationId)
                : undefined
              const messageChapterId = message.chapterId ?? illustration?.chapterId ?? fallbackChapterId
              const startsChapter = Boolean(messageChapterId && messageChapterId !== previousMessageChapterId)
              if (messageChapterId) previousMessageChapterId = messageChapterId
              return (
                <div className="timeline-entry" data-chapter-id={startsChapter ? messageChapterId : undefined} key={message.id}>
                  <MessageItem
                    message={message}
                    illustration={illustration}
                    onRetryIllustration={retryIllustration}
                    imageProviderReady={imageProviderReady}
                    onOpenImageSettings={() => openProviderSettings('image')}
                    characters={workspace.characters}
                    onOpenCharacterAssets={() => setCharacterAssetsOpen(true)}
                    onOpenIllustration={(source, title, alt, localUri) => setLightboxImage({ source, title, alt, localUri })}
                  />
                </div>
              )
            })
          )}
          {sending && streamingText && (
            <div className="timeline-entry">
              <article className="streaming-prose" aria-live="polite">{streamingText}</article>
            </div>
          )}
          <div className="ready-state" role="status">
            <span /><span /><span />
            <em>{sending ? '正在保存你的想法…' : '等待你的下一步'}</em>
          </div>
        </section>
      </div>

      <footer className="composer-wrap">
        <div className="composer-tools">
          <button type="button" onClick={() => setCharacterAssetsOpen(true)}><UserRound size={17} />角色资产</button>
          <button type="button" onClick={() => setReferenceImageOpen(true)}><ImagePlus size={17} />参考图</button>
          <label className="auto-toggle">
            <input
              type="checkbox"
              checked={workspace.project.autoIllustrate}
              onChange={(event) => void handleAutoIllustrate(event.target.checked)}
            />
            <span className="switch" />
            自动配图
          </label>
        </div>
        <div className="composer">
          <textarea
            rows={1}
            value={draft}
            placeholder="继续写下去，或告诉 AI 你想看到的画面…"
            aria-label="创作要求"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void sendMessage()
              }
            }}
          />
          <button className="send-button" type="button" aria-label="发送" disabled={!draft.trim() || sending} onClick={() => void sendMessage()}>
            <span className="send-button-surface"><Send size={18} /></span>
          </button>
        </div>
      </footer>

      <ProjectDrawer
        open={projectMenuOpen}
        projects={projects}
        activeProjectId={workspace.project.id}
        onClose={() => setProjectMenuOpen(false)}
        onSelect={async (projectId) => {
          await openProject(projectId)
          setProjectMenuOpen(false)
        }}
        onCreate={handleCreateProject}
        onDelete={handleDeleteProject}
        onRename={handleRenameProject}
      />

      <SettingsDrawer
        open={appSettingsOpen}
        projectTitle={workspace.project.title}
        activeThemeId={workspace.project.themeId}
        onClose={() => setAppSettingsOpen(false)}
        onThemeChange={handleThemeChange}
        activeIllustrationStyleId={illustrationStyle.id}
        activeCustomStylePrompt={illustrationStyle.customPrompt}
        onIllustrationStyleChange={handleIllustrationStyleChange}
        activeWritingInstructions={workspace.project.writingInstructions ?? ''}
        onEditWritingInstructions={() => {
          setAppSettingsOpen(false)
          setWritingInstructionsOpen(true)
        }}
        contextBudget={workspace.project.contextBudget ?? 'standard'}
        onContextBudgetChange={handleContextBudgetChange}
        providerSettings={providerSettings}
        onOpenProviderSettings={(slot) => openProviderSettings(slot, true)}
        appearanceMode={appearanceMode}
        onAppearanceChange={handleAppearanceChange}
      />

      <WritingInstructionsDialog
        open={writingInstructionsOpen}
        projectTitle={workspace.project.title}
        value={workspace.project.writingInstructions ?? ''}
        textProvider={providerSettings.text}
        onClose={() => {
          setWritingInstructionsOpen(false)
          setAppSettingsOpen(true)
        }}
        onSave={handleWritingInstructionsSave}
        onSaveStructure={async (structureJson) => {
          try {
            await updateWritingStructure(workspace.project.id, structureJson ?? '')
            await refreshWorkspace(workspace.project.id)
            showToast(structureJson ? '分层结构已保存' : '已恢复为原文携带')
          } catch (error) {
            showToast(error instanceof Error ? error.message : '分层结构保存失败', 'error')
            throw error
          }
        }}
      />

      <ProviderSettingsDialog
        open={settingsOpen}
        settings={providerSettings}
        initialSlot={settingsSlot}
        onClose={closeProviderSettings}
        onSave={(nextSettings) => {
          saveProviderSettings(nextSettings)
          setProviderSettings(nextSettings)
          showToast('模型配置已保存')
        }}
      />
      <CharacterAssetsDrawer
        open={characterAssetsOpen}
        characters={workspace.characters}
        onClose={() => setCharacterAssetsOpen(false)}
        onGenerate={requestCharacterPortrait}
        onConfirm={confirmCharacter}
        onReferenceStyleModeChange={handleReferenceStyleModeChange}
      />
      <ReferenceImageDialog
        open={referenceImageOpen}
        characters={workspace.characters}
        onClose={() => setReferenceImageOpen(false)}
        onImport={importCharacterReference}
      />
      <IllustrationLightbox image={lightboxImage} onClose={() => setLightboxImage(undefined)} onToast={showToast} />
      <ConfirmDialog
        open={Boolean(confirmState)}
        title={confirmState?.title ?? ''}
        message={confirmState?.message ?? ''}
        confirmLabel={confirmState?.confirmLabel}
        danger={confirmState?.danger}
        onClose={() => setConfirmState(undefined)}
        onConfirm={() => confirmState?.onConfirm()}
      />
      {toast && (
        <div className={`app-toast ${toast.kind === 'error' ? 'app-toast-error' : ''}`} role="status">
          {toast.kind === 'error'
            ? <TriangleAlert size={17} aria-hidden="true" />
            : <Check size={17} aria-hidden="true" />}
          {toast.text}
        </div>
      )}
    </main>
  )
}

function MessageItem({
  message,
  illustration,
  onRetryIllustration,
  imageProviderReady,
  onOpenImageSettings,
  characters,
  onOpenCharacterAssets,
  onOpenIllustration,
}: {
  message: ConversationMessage
  illustration?: IllustrationAsset
  onRetryIllustration: (illustrationId: string) => Promise<void>
  imageProviderReady: boolean
  onOpenImageSettings: () => void
  characters: CharacterAsset[]
  onOpenCharacterAssets: () => void
  onOpenIllustration: (source: string, title: string, alt: string, localUri?: string) => void
}) {
  const [showVisualPrompt, setShowVisualPrompt] = useState(false)
  const referencesReady = Boolean(illustration && illustrationReferencesReady(illustration, characters))
  const canGenerate = Boolean(illustration && imageProviderReady && referencesReady && (illustration.status === 'planned' || illustration.status === 'failed'))
  const imageSource = illustration ? resolveImageSource(illustration.imageUrl, illustration.localUri) : undefined

  if (message.kind === 'user') {
    return <div className="message-row user-row"><div className="user-bubble">{message.text}</div></div>
  }

  if (message.kind === 'notice') {
    return (
      <div className="message-row assistant-row notice-indent">
        <div className={`assistant-notice ${message.status ?? 'ready'}`} role={message.status === 'failed' ? 'alert' : 'status'}>
          {message.status === 'pending'
            ? <LoaderCircle className="spin" size={14} />
            : message.status === 'failed'
              ? <TriangleAlert size={14} />
              : <Sparkles size={14} />}
          {message.text}
        </div>
      </div>
    )
  }

  if (message.kind === 'prose') {
    return (
      <article className="story-prose">
        {message.paragraphs?.map((paragraph, index) => <p key={`${message.id}-${index}`}>{paragraph}</p>)}
      </article>
    )
  }

  return (
    <div className="message-row illustration-row">
      <figure className="illustration-card">
        {imageSource ? (
          <button
            className="illustration-image-button"
            type="button"
            aria-label={`放大查看${message.title ?? '剧情插画'}`}
            onClick={() => onOpenIllustration(imageSource, message.title ?? '剧情插画', message.title ?? '剧情插画', illustration?.localUri)}
          >
            <img className="generated-illustration" src={imageSource} alt={message.title ?? '剧情插画'} />
            <span className="illustration-zoom-hint" aria-hidden="true"><Maximize2 size={17} /></span>
          </button>
        ) : (
          <div className="illustration-placeholder" role="img" aria-label={`${message.title ?? '剧情'}插画生成占位图`}>
            {illustration?.status === 'generating' ? <LoaderCircle className="spin" size={27} aria-hidden="true" /> : <ImagePlus size={27} aria-hidden="true" />}
            <span className="placeholder-label">
              {illustration?.status === 'generating'
                ? '正在生成图片…'
                : !imageProviderReady
                   ? '请先配置图片模型'
                   : !referencesReady
                     ? '请先确认角色定妆照'
                     : '点击下方按钮生成插画'}
            </span>
          </div>
        )}
        <figcaption>
          <div><strong>{message.title}</strong><span>{illustrationStatusText(illustration, imageProviderReady, referencesReady)}</span></div>
          <div className="illustration-actions">
            {illustration && (illustration.status === 'failed' || illustration.status === 'planned') && !imageProviderReady && <button type="button" onClick={onOpenImageSettings}>配置图片模型</button>}
            {illustration && (illustration.status === 'failed' || illustration.status === 'planned') && imageProviderReady && !referencesReady && <button type="button" onClick={onOpenCharacterAssets}>查看角色资产</button>}
            {illustration && illustration.status === 'failed' && canGenerate && <button type="button" onClick={() => void onRetryIllustration(illustration.id)}>重新生成</button>}
            {illustration && illustration.status === 'planned' && canGenerate && <button type="button" onClick={() => void onRetryIllustration(illustration.id)}>生成插画</button>}
            <button type="button" aria-expanded={showVisualPrompt} onClick={() => setShowVisualPrompt((value) => !value)}>视觉指令</button>
          </div>
        </figcaption>
        {showVisualPrompt && <div className="visual-prompt"><strong>本轮画面描述</strong><p>{illustration?.prompt || '这条旧消息没有保存视觉指令。'}</p></div>}
      </figure>
    </div>
  )
}

const LIGHTBOX_MIN_SCALE = 1
const LIGHTBOX_MAX_SCALE = 8
const LIGHTBOX_TAP_MOVE_TOLERANCE = 8
const LIGHTBOX_DOUBLE_TAP_INTERVAL_MS = 300
const LIGHTBOX_DOUBLE_TAP_DISTANCE = 28
const LIGHTBOX_DOUBLE_TAP_SCALE = 2.5
const LIGHTBOX_PINCH_MIN_START_DISTANCE = 40
const LIGHTBOX_PINCH_SENSITIVITY = 0.6

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function IllustrationLightbox({
  image,
  onClose,
  onToast,
}: {
  image?: { source: string; title: string; alt: string; localUri?: string }
  onClose: () => void
  onToast: (message: string) => void
}) {
  const [scale, setScale] = useState(LIGHTBOX_MIN_SCALE)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [saving, setSaving] = useState(false)
  const [toolbarVisible, setToolbarVisible] = useState(true)
  const stageRef = useRef<HTMLDivElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const pointersRef = useRef(new Map<number, { x: number; y: number }>())
  const lastTapRef = useRef<{ x: number; y: number; at: number } | undefined>(undefined)
  const draggedRef = useRef(false)
  const lastPointerRef = useRef<{ x: number; y: number } | undefined>(undefined)
  const toolbarTimerRef = useRef<number | undefined>(undefined)
  const viewRef = useRef({ scale: LIGHTBOX_MIN_SCALE, x: 0, y: 0 })
  const gestureRef = useRef<'none' | 'pan' | 'pinch'>('none')
  const pinchRef = useRef<{
    startDistance: number
    startScale: number
    startMid: { x: number; y: number }
    startOffset: { x: number; y: number }
  } | undefined>(undefined)
  const { present, closing } = usePresence(Boolean(image), onClose, 180)
  const lastImageRef = useRef(image)
  if (image) lastImageRef.current = image
  const visibleImage = image ?? lastImageRef.current

  function applyView(nextView: { scale: number; x: number; y: number }) {
    viewRef.current = nextView
    setScale(nextView.scale)
    setOffset({ x: nextView.x, y: nextView.y })
  }

  useEffect(() => {
    applyView({ scale: LIGHTBOX_MIN_SCALE, x: 0, y: 0 })
    pointersRef.current.clear()
    gestureRef.current = 'none'
    pinchRef.current = undefined
    lastTapRef.current = undefined
    draggedRef.current = false
    lastPointerRef.current = undefined
  }, [image])

  useEffect(() => {
    if (!image) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [image, onClose])

  useEffect(() => {
    if (!image) return
    const stage = stageRef.current
    if (!stage) return
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault()
      const factor = event.deltaY < 0 ? 1.18 : 1 / 1.18
      zoomAround({ x: event.clientX, y: event.clientY }, factor)
    }
    stage.addEventListener('wheel', handleWheel, { passive: false })
    return () => stage.removeEventListener('wheel', handleWheel)
  })

  useEffect(() => {
    if (!toolbarVisible) return
    window.clearTimeout(toolbarTimerRef.current)
    toolbarTimerRef.current = window.setTimeout(() => setToolbarVisible(false), 2800)
    return () => window.clearTimeout(toolbarTimerRef.current)
  }, [toolbarVisible])

  if (!present || !visibleImage) return null

  function showToolbar() {
    setToolbarVisible(true)
  }

  function stageCenter() {
    const stage = stageRef.current
    if (!stage) return { x: 0, y: 0 }
    const rect = stage.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  }

  function clampOffset(nextOffset: { x: number; y: number }, nextScale: number) {
    const stage = stageRef.current
    const imageElement = imageRef.current
    if (!stage || !imageElement) return nextOffset
    const viewWidth = stage.clientWidth
    const viewHeight = stage.clientHeight
    const imageWidth = imageElement.offsetWidth * nextScale
    const imageHeight = imageElement.offsetHeight * nextScale
    const minVisible = 72
    const maxX = Math.max(0, Math.min(imageWidth, viewWidth) / 2 + (imageWidth > viewWidth ? minVisible : 0))
    const maxY = Math.max(0, Math.min(imageHeight, viewHeight) / 2 + (imageHeight > viewHeight ? minVisible : 0))
    return { x: clamp(nextOffset.x, -maxX, maxX), y: clamp(nextOffset.y, -maxY, maxY) }
  }

  function zoomAround(point: { x: number; y: number }, factor: number) {
    const current = viewRef.current
    const nextScale = clamp(current.scale * factor, LIGHTBOX_MIN_SCALE, LIGHTBOX_MAX_SCALE)
    const center = stageCenter()
    const nextOffset = clampOffset(
      {
        x: point.x - center.x - (point.x - center.x - current.x) * (nextScale / current.scale),
        y: point.y - center.y - (point.y - center.y - current.y) * (nextScale / current.scale),
      },
      nextScale,
    )
    applyView({ scale: nextScale, x: nextOffset.x, y: nextOffset.y })
  }

  function resetZoom() {
    applyView({ scale: LIGHTBOX_MIN_SCALE, x: 0, y: 0 })
  }

  function beginPinch() {
    const [first, second] = Array.from(pointersRef.current.values())
    const current = viewRef.current
    const distance = Math.hypot(first.x - second.x, first.y - second.y)
    pinchRef.current = {
      startDistance: Math.max(distance, LIGHTBOX_PINCH_MIN_START_DISTANCE),
      startScale: current.scale,
      startMid: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
      startOffset: { x: current.x, y: current.y },
    }
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    const stage = stageRef.current
    if (!stage) return
    stage.setPointerCapture(event.pointerId)
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    draggedRef.current = false
    lastPointerRef.current = { x: event.clientX, y: event.clientY }
    showToolbar()

    if (pointersRef.current.size === 2) {
      beginPinch()
      gestureRef.current = 'pinch'
    }
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!pointersRef.current.has(event.pointerId)) return
    const previous = lastPointerRef.current
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    lastPointerRef.current = { x: event.clientX, y: event.clientY }

    if (previous && Math.hypot(event.clientX - previous.x, event.clientY - previous.y) > LIGHTBOX_TAP_MOVE_TOLERANCE) {
      draggedRef.current = true
      lastTapRef.current = undefined
    }

    if (pointersRef.current.size >= 2) {
      if (gestureRef.current !== 'pinch') beginPinch()
      gestureRef.current = 'pinch'
      const pinch = pinchRef.current
      if (!pinch) return
      const [first, second] = Array.from(pointersRef.current.values())
      const distance = Math.hypot(first.x - second.x, first.y - second.y)
      const midpoint = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 }
      const rawFactor = distance / pinch.startDistance
      const factor = 1 + (rawFactor - 1) * LIGHTBOX_PINCH_SENSITIVITY
      const nextScale = clamp(pinch.startScale * factor, LIGHTBOX_MIN_SCALE, LIGHTBOX_MAX_SCALE)
      const center = stageCenter()
      const nextOffset = clampOffset(
        {
          x: midpoint.x - center.x - (pinch.startMid.x - center.x - pinch.startOffset.x) * (nextScale / pinch.startScale),
          y: midpoint.y - center.y - (pinch.startMid.y - center.y - pinch.startOffset.y) * (nextScale / pinch.startScale),
        },
        nextScale,
      )
      applyView({ scale: nextScale, x: nextOffset.x, y: nextOffset.y })
      return
    }

    if (gestureRef.current === 'pinch') {
      gestureRef.current = viewRef.current.scale > LIGHTBOX_MIN_SCALE ? 'pan' : 'none'
    }
    if (!previous) return
    const deltaX = event.clientX - previous.x
    const deltaY = event.clientY - previous.y
    const current = viewRef.current
    if (current.scale > LIGHTBOX_MIN_SCALE) {
      gestureRef.current = 'pan'
      const nextOffset = clampOffset({ x: current.x + deltaX, y: current.y + deltaY }, current.scale)
      applyView({ scale: current.scale, x: nextOffset.x, y: nextOffset.y })
    }
  }

  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    const stage = stageRef.current
    if (stage?.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId)
    pointersRef.current.delete(event.pointerId)

    if (pointersRef.current.size === 1) {
      const [remaining] = Array.from(pointersRef.current.values())
      pinchRef.current = undefined
      gestureRef.current = viewRef.current.scale > LIGHTBOX_MIN_SCALE ? 'pan' : 'none'
      lastPointerRef.current = { x: remaining.x, y: remaining.y }
      return
    }
    if (pointersRef.current.size === 0) {
      pinchRef.current = undefined
      gestureRef.current = 'none'
      lastPointerRef.current = undefined
    }

    const now = Date.now()
    const lastTap = lastTapRef.current
    if (!draggedRef.current && pointersRef.current.size === 0) {
      const tapPoint = { x: event.clientX, y: event.clientY }
      if (lastTap && now - lastTap.at < LIGHTBOX_DOUBLE_TAP_INTERVAL_MS && Math.hypot(tapPoint.x - lastTap.x, tapPoint.y - lastTap.y) < LIGHTBOX_DOUBLE_TAP_DISTANCE) {
        lastTapRef.current = undefined
        if (viewRef.current.scale <= LIGHTBOX_MIN_SCALE) zoomAround(tapPoint, LIGHTBOX_DOUBLE_TAP_SCALE)
        else resetZoom()
        return
      }
      lastTapRef.current = { x: tapPoint.x, y: tapPoint.y, at: now }
    } else {
      lastTapRef.current = undefined
    }
  }

  function handleStagePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.currentTarget === event.target && pointersRef.current.size === 0) {
      onClose()
      return
    }
    handlePointerDown(event)
  }

  async function handleSave() {
    if (!visibleImage || saving) return
    setSaving(true)
    try {
      await saveImageToDevice(visibleImage.source, visibleImage.localUri, visibleImage.title)
      onToast('图片已保存到相册')
    } catch (error) {
      onToast(error instanceof Error && error.message ? `保存失败：${error.message}` : '保存失败，请稍后重试')
    } finally {
      setSaving(false)
    }
  }

  const scalePercent = Math.round(scale * 100)

  return (
    <div className={`image-lightbox-backdrop${closing ? ' closing' : ''}`} role="presentation">
      <section
        ref={stageRef}
        className="image-lightbox-stage"
        role="dialog"
        aria-modal="true"
        aria-label={visibleImage.title}
        onPointerDown={handleStagePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        <img
          ref={imageRef}
          src={visibleImage.source}
          alt={visibleImage.alt}
          draggable={false}
          style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
        />
        <div className={`image-lightbox-toolbar${toolbarVisible ? ' visible' : ''}`}>
          <h2>{visibleImage.title}</h2>
          <div className="image-lightbox-tools">
            <button className="icon-button" type="button" aria-label="放大" onClick={() => zoomAround(stageCenter(), 1.5)}><ZoomIn size={19} /></button>
            <button className="icon-button" type="button" aria-label="缩小" onClick={() => zoomAround(stageCenter(), 1 / 1.5)}><ZoomOut size={19} /></button>
            <button className="icon-button" type="button" aria-label="复位缩放" onClick={resetZoom} disabled={scale === 1}><RotateCcw size={19} /></button>
            <button className="icon-button" type="button" aria-label="保存图片到手机" disabled={saving} onClick={() => void handleSave()}>
              {saving ? <LoaderCircle className="spin" size={19} /> : <Download size={19} />}
            </button>
            <button className="icon-button" type="button" aria-label="关闭图片预览" onClick={onClose}><X size={20} /></button>
          </div>
          {scale > LIGHTBOX_MIN_SCALE && <span className="image-lightbox-scale">{scalePercent}%</span>}
        </div>
      </section>
    </div>
  )
}

function illustrationStatusText(illustration: IllustrationAsset | undefined, imageProviderReady: boolean, referencesReady: boolean) {
  if (!illustration) return '自动插画 · 等待生成'
  if (illustration.status === 'generating') return '自动插画 · 正在生成'
  if (illustration.status === 'ready') return '自动插画 · 已保存'
  if (illustration.status === 'failed') return `自动插画 · ${illustration.errorMessage || '生成失败'}`
  if (!imageProviderReady) return '自动插画 · 等待配置图片模型'
  if (!referencesReady) return '自动插画 · 等待角色定妆照'
  return '自动插画 · 等待手动生成'
}
