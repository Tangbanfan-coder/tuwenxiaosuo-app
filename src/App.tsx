import { useCallback, useEffect, useRef, useState } from 'react'
import {
  BookPlus,
  BookOpen,
  Check,
  ChevronDown,
  ImagePlus,
  Menu,
  Plus,
  Send,
  Settings,
  TriangleAlert,
  UserRound,
  X,
} from 'lucide-react'
import ProjectDrawer from './components/ProjectDrawer'
import CharacterAssetsDrawer from './components/CharacterAssetsDrawer'
import ProviderSettingsDialog from './components/ProviderSettingsDialog'
import ReferenceImageDialog, { type ReferenceImageTarget } from './components/ReferenceImageDialog'
import SettingsDrawer from './components/SettingsDrawer'
import ContextUsage, { type ContextUsageState } from './components/ContextUsage'
import ComposerAssetsMenu from './components/ComposerAssetsMenu'
import ReasoningEffortQuickControl from './components/ReasoningEffortQuickControl'
import IllustrationLightbox, { type LightboxImage } from './components/IllustrationLightbox'
import TimelineMessage from './components/TimelineMessage'
import WritingInstructionsDialog from './components/WritingInstructionsDialog'
import SummaryHistoryDialog from './components/SummaryHistoryDialog'
import {
  beginWritingTurn,
  completeWritingTurn,
  confirmCharacterPortrait,
  createCharacterDraft,
  createProject,
  deleteProject,
  failWritingTurn,
  listChapterSummaryVersions,
  renameProject,
  restoreChapterSummaryVersion,
  setCharacterPortraitFailed,
  setCharacterPortraitGenerating,
  setCharacterPortraitReady,
  setIllustrationFailed,
  setIllustrationGenerating,
  setIllustrationReady,
  updateAutoIllustrate,
  updateCharacterProfile,
  updateCharacterReferenceStyleMode,
  updateContextBudget,
  updateIllustrationStyle,
  updateProjectTheme,
  updateWritingInstructions,
  updateWritingStructure,
} from './data/storyDatabase'
import { resolveProjectIllustrationStyle } from './domain/illustrationStyles'
import type { AppearanceMode, CharacterAsset, ContextBudget, IllustrationAsset, IllustrationStylePresetId, ProjectWorkspace, ReferenceStyleMode, ThemePresetId } from './domain/models'
import { browserTransport } from './providers/browserTransport'
import { loadProviderSettings, saveProviderSettings } from './providers/config'
import { loadGlobalWritingInstructions, saveGlobalWritingInstructions } from './providers/config'
import { persistImageAsset, resolveImageSource } from './providers/imageAssetStore'
import { useAppBootstrap } from './hooks/useAppBootstrap'
import ConfirmDialog from './components/ConfirmDialog'
import { buildCharacterPortraitPrompt, editOpenAiImage, generateOpenAiImage } from './providers/images'
import { secretStore } from './providers/secretStore'
import type { ProviderSettings, ProviderSlot, ReasoningEffort } from './providers/types'
import { explicitlyRequestsNewChapter, generateWritingTurn, previewWritingTurnBudget, projectStreamingProse, type ContextBudgetPlan } from './providers/writing'

const APPEARANCE_KEY = 'illustrated-story-chat.appearance.v1'

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

function loadAppearanceMode(): AppearanceMode {
  return localStorage.getItem(APPEARANCE_KEY) === 'light' ? 'light' : 'dark'
}

export default function App() {
  const timelineRef = useRef<HTMLElement>(null)
  const imageQueueRef = useRef<Promise<void>>(Promise.resolve())
  const queuedIllustrationIdsRef = useRef(new Set<string>())
  const [draft, setDraft] = useState('')
  const [contextUsagePlan, setContextUsagePlan] = useState<ContextBudgetPlan>()
  const [contextUsageState, setContextUsageState] = useState<ContextUsageState>('empty')
  const [contextUsageError, setContextUsageError] = useState('')
  const [contextUsageDetailsOpen, setContextUsageDetailsOpen] = useState(false)
  const [sending, setSending] = useState(false)
  const [projectMenuOpen, setProjectMenuOpen] = useState(false)
  const [appSettingsOpen, setAppSettingsOpen] = useState(false)
  const [characterAssetsOpen, setCharacterAssetsOpen] = useState(false)
  const [characterAssetsOrigin, setCharacterAssetsOrigin] = useState<'main' | 'reference-image'>('main')
  const [referenceImageOpen, setReferenceImageOpen] = useState(false)
  const [writingInstructionsOpen, setWritingInstructionsOpen] = useState(false)
  const [globalWritingInstructionsOpen, setGlobalWritingInstructionsOpen] = useState(false)
  const [globalWritingInstructions, setGlobalWritingInstructions] = useState(() => loadGlobalWritingInstructions())
  const portraitGenerationCancelledRef = useRef(false)
  const [portraitGenerationActive, setPortraitGenerationActive] = useState(false)
  const [summaryHistoryOpen, setSummaryHistoryOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSlot, setSettingsSlot] = useState<ProviderSlot>('text')
  const [toast, setToast] = useState<{ text: string; kind: 'success' | 'error' }>()
  const [providerSettings, setProviderSettings] = useState<ProviderSettings>(() => loadProviderSettings())
  const [imageProviderReady, setImageProviderReady] = useState(false)
  const [appearanceMode, setAppearanceMode] = useState<AppearanceMode>(() => loadAppearanceMode())
  const [visibleChapterId, setVisibleChapterId] = useState<string>()
  const [lightboxImage, setLightboxImage] = useState<LightboxImage>()
  const [streamingText, setStreamingText] = useState('')
  const streamingRawRef = useRef('')
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

  const {
    bootError,
    booting,
    openProject,
    projects,
    refreshProjects,
    refreshWorkspace,
    setProjects,
    setWorkspace,
    workspace,
  } = useAppBootstrap({
    onEmptyLibrary: () => setProjectMenuOpen(true),
    onToast: showToast,
  })

  useEffect(() => {
    setWorkspace((current) => current ? { ...current, globalWritingInstructions } : current)
  }, [globalWritingInstructions, setWorkspace])

  useEffect(() => {
    const userRequest = draft.trim()
    const textProvider = providerSettings.text
    if (!workspace || !textProvider.model.trim()) {
      setContextUsagePlan(undefined)
      setContextUsageError('')
      setContextUsageState('empty')
      return
    }

    let cancelled = false
    setContextUsageState('loading')
    setContextUsageError('')
    const previewTimer = window.setTimeout(() => {
      void previewWritingTurnBudget(workspace, userRequest, textProvider)
        .then((plan) => {
          if (cancelled) return
          setContextUsagePlan(plan)
          setContextUsageState(plan.isOverLimit ? 'over-limit' : plan.estimator.isFallback ? 'fallback' : 'ready')
        })
        .catch((error) => {
          if (cancelled) return
          setContextUsagePlan(undefined)
          setContextUsageState('error')
          setContextUsageError(error instanceof Error ? error.message : '未知预览错误')
        })
    }, 240)

    return () => {
      cancelled = true
      window.clearTimeout(previewTimer)
    }
  }, [draft, providerSettings.text, workspace])

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
            const nextProject = remaining[0]
            if (nextProject) {
              await openProject(nextProject.id)
            } else {
              setWorkspace(null)
              setProjectMenuOpen(true)
            }
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
    await refreshWorkspace(workspace.project.id)
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
      showToast(value.trim() ? '局部创作设定已保存' : '局部创作设定已清除')
    } catch (error) {
      showToast(error instanceof Error ? error.message : '局部创作设定保存失败', 'error')
      throw error
    }
  }

  function handleAppearanceChange(mode: AppearanceMode) {
    setAppearanceMode(mode)
    localStorage.setItem(APPEARANCE_KEY, mode)
  }

  function openProviderSettings(slot: ProviderSlot) {
    setSettingsSlot(slot)
    setSettingsOpen(true)
  }

  function closeProviderSettings() {
    setSettingsOpen(false)
  }

  function handleReasoningEffortChange(reasoningEffort: ReasoningEffort) {
    const nextTextProvider = { ...providerSettings.text, reasoningEffort }
    const hasActiveProvider = providerSettings.textProviders.some((provider) => provider.id === nextTextProvider.id)
    const nextSettings: ProviderSettings = {
      ...providerSettings,
      text: nextTextProvider,
      textProviders: hasActiveProvider
        ? providerSettings.textProviders.map((provider) => provider.id === nextTextProvider.id ? nextTextProvider : provider)
        : [nextTextProvider, ...providerSettings.textProviders],
    }
    saveProviderSettings(nextSettings)
    setProviderSettings(nextSettings)
  }

  function openCharacterAssets() {
    setCharacterAssetsOrigin('main')
    setCharacterAssetsOpen(true)
  }

  function closeCharacterAssets() {
    setCharacterAssetsOpen(false)
    if (characterAssetsOrigin !== 'reference-image') return
    setCharacterAssetsOrigin('main')
    setReferenceImageOpen(true)
  }

  async function handleAutoIllustrate(autoIllustrate: boolean) {
    if (!workspace) return
    const nextWorkspace: ProjectWorkspace = {
      ...workspace,
      project: { ...workspace.project, autoIllustrate },
    }
    setWorkspace((current) => current ? {
      ...current,
      project: { ...current.project, autoIllustrate },
    } : current)
    await updateAutoIllustrate(workspace.project.id, autoIllustrate)
    if (!autoIllustrate) return
    if (!(await providerIsReady('image'))) {
      showToast('自动配图已开启；请先配置图片模型，待生成角色会保留在角色资产中')
      return
    }
    const pendingPortraits = nextWorkspace.characters.filter((character) => (character.portraitStatus ?? 'planned') === 'planned')
    if (!pendingPortraits.length) return
    portraitGenerationCancelledRef.current = false
    setPortraitGenerationActive(true)
    void enqueueImageTask(async () => {
      try {
        for (const character of pendingPortraits) {
          if (portraitGenerationCancelledRef.current) break
          await generateCharacterPortrait(character, nextWorkspace)
        }
      } finally {
        setPortraitGenerationActive(false)
      }
    })
    showToast(`自动配图已开启，${pendingPortraits.length} 个角色定妆照进入队列`)
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

  function enqueueImageTask(task: () => Promise<void>) {
    const queued = imageQueueRef.current.then(task, task)
    imageQueueRef.current = queued.catch(() => undefined)
    return queued
  }

  function cancelPortraitGeneration() {
    portraitGenerationCancelledRef.current = true
    showToast('已停止后续定妆照生成；当前请求结束后不会继续排队')
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
      setCharacterAssetsOrigin('main')
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
      const storedImage = await persistImageAsset(dataUrl, workspace.project.id, characterId, 'imported')
      await setCharacterPortraitReady(characterId, storedImage.imageUrl, storedImage.localUri, referenceStyleMode)
      await refreshWorkspace(workspace.project.id)
      setReferenceImageOpen(false)
      setCharacterAssetsOrigin('reference-image')
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

  async function handleUpdateCharacterProfile(characterId: string, profile: { ageAndBuild: string; fixedTraits: string[]; defaultLook: string; wardrobe: string }) {
    if (!workspace) return
    try {
      await updateCharacterProfile(characterId, profile)
      await refreshWorkspace(workspace.project.id)
      showToast('角色档案已更新')
    } catch (error) {
      showToast(error instanceof Error ? error.message : '角色档案保存失败', 'error')
    }
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

  async function createCharacterWithoutReference(target: { name: string; role: string }) {
    if (!workspace) return
    await createCharacterDraft(workspace.project.id, target.name, target.role)
    await refreshWorkspace(workspace.project.id)
    setReferenceImageOpen(false)
    setCharacterAssetsOpen(true)
    showToast('角色已创建，可在角色资产中生成定妆照')
  }

  async function retryIllustration(illustrationId: string) {
    if (!workspace || !(await providerIsReady('image'))) {
      openProviderSettings('image')
      showToast('请先完成图片模型配置')
      return
    }
    const illustration = workspace.illustrations.find((item) => item.id === illustrationId)
    if (!illustration) return
    if (illustration.status === 'generating') {
      openCharacterAssets()
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
      streamingRawRef.current = ''
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
        streamingRawRef.current += delta
        setStreamingText(projectStreamingProse(streamingRawRef.current))
      })
      await completeWritingTurn(
        workspace.project.id,
        userMessageId,
        noticeId,
        result,
        workspace.project.autoIllustrate,
        explicitlyRequestsNewChapter(text),
      )
      // The final prose is about to be loaded from storage; do not render the
      // same turn twice while the workspace refresh is in flight.
      streamingRawRef.current = ''
      setStreamingText('')
      const nextWorkspace = await refreshWorkspace(workspace.project.id)
      await refreshProjects()
      if (result.visualPlan && nextWorkspace) {
        const newCharacterNames = new Set(result.visualPlan.characters.map((character) => character.name.toLocaleLowerCase()))
        const portraits = nextWorkspace.characters.filter((character) =>
          newCharacterNames.has(character.name.toLocaleLowerCase()) && (character.portraitStatus ?? 'planned') === 'planned',
        )
        const newIllustrations = nextWorkspace.illustrations.filter((illustration) => !previousIllustrationIds.has(illustration.id))
        const imageReady = await providerIsReady('image')
        const readyIllustrations = newIllustrations.filter((illustration) => (
          illustration.status === 'planned' && illustrationReferencesReady(illustration, nextWorkspace.characters)
        ))
        if (portraits.length && imageReady && workspace.project.autoIllustrate) {
          portraitGenerationCancelledRef.current = false
          setPortraitGenerationActive(true)
          void enqueueImageTask(async () => {
            try {
              for (const character of portraits) {
                if (portraitGenerationCancelledRef.current) break
                await generateCharacterPortrait(character, nextWorkspace)
              }
            } finally {
              setPortraitGenerationActive(false)
            }
          })
          showToast('正文已保存，定妆照已进入生成队列')
        } else if (!workspace.project.autoIllustrate) {
          showToast('正文和视觉计划已保存；自动配图未开启，可稍后手动生成')
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
        const partialProse = projectStreamingProse(streamingRawRef.current)
        await failWritingTurn(noticeId, message, partialProse)
        await refreshWorkspace(workspace.project.id)
      } else {
        setDraft(text)
      }
      showToast('本轮写作未完成', 'error')
    } finally {
      setSending(false)
      streamingRawRef.current = ''
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

  if (booting) {
    return (
      <main className="app-shell loading-shell" aria-busy="true">
        <div className="loading-mark"><BookOpen size={22} /><span>正在打开作品…</span></div>
      </main>
    )
  }

  if (!workspace) {
    return (
      <main className="app-shell" data-appearance={appearanceMode}>
        <header className="topbar">
          <button className="icon-button" type="button" aria-label="打开作品列表" onClick={() => setProjectMenuOpen(true)}>
            <Menu size={21} />
          </button>
          <div className="empty-library-title"><BookOpen size={16} /><span>我的作品</span></div>
          <span className="topbar-spacer" aria-hidden="true" />
        </header>
        <section className="empty-library" aria-labelledby="empty-library-title">
          <BookPlus size={30} aria-hidden="true" />
          <h1 id="empty-library-title">还没有作品</h1>
          <p>新建作品后，正文、角色和插画会各自独立保存。</p>
          <button className="primary-button" type="button" onClick={() => setProjectMenuOpen(true)}>
            <Plus size={17} aria-hidden="true" />
            新建作品
          </button>
        </section>
        <ProjectDrawer
          open={projectMenuOpen}
          projects={projects}
          onClose={() => setProjectMenuOpen(false)}
          onSelect={async (projectId) => {
            await openProject(projectId)
            setProjectMenuOpen(false)
          }}
          onCreate={handleCreateProject}
          onDelete={handleDeleteProject}
          onRename={handleRenameProject}
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
            onClick={openCharacterAssets}
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
                  <TimelineMessage
                    message={message}
                    illustration={illustration}
                    onRetryIllustration={retryIllustration}
                    imageProviderReady={imageProviderReady}
                    onOpenImageSettings={() => openProviderSettings('image')}
                    characters={workspace.characters}
                    onOpenCharacterAssets={openCharacterAssets}
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
          <div className="composer-toolbar">
            <div className="composer-tools">
              <ComposerAssetsMenu
                onOpenCharacterAssets={openCharacterAssets}
                onOpenReferenceImage={() => setReferenceImageOpen(true)}
              />
              <ReasoningEffortQuickControl value={providerSettings.text.reasoningEffort} onChange={handleReasoningEffortChange} />
              <button
                className="composer-tool-button auto-illustrate-button"
                type="button"
                aria-pressed={workspace.project.autoIllustrate}
                aria-label={`自动配图：${workspace.project.autoIllustrate ? '自动' : '关闭'}`}
                onClick={() => void handleAutoIllustrate(!workspace.project.autoIllustrate)}
              >
                <ImagePlus size={17} aria-hidden="true" />
                <span>配图</span>
                <strong>{workspace.project.autoIllustrate ? '自动' : '关闭'}</strong>
              </button>
            </div>
            <button className="send-button" type="button" aria-label="发送" disabled={!draft.trim() || sending} onClick={() => void sendMessage()}>
              <span className="send-button-surface"><Send size={18} /></span>
            </button>
          </div>
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
        suspended={writingInstructionsOpen || globalWritingInstructionsOpen || summaryHistoryOpen || settingsOpen || contextUsageDetailsOpen}
        projectTitle={workspace.project.title}
        activeThemeId={workspace.project.themeId}
        onClose={() => setAppSettingsOpen(false)}
        onThemeChange={handleThemeChange}
        activeIllustrationStyleId={illustrationStyle.id}
        activeCustomStylePrompt={illustrationStyle.customPrompt}
        onIllustrationStyleChange={handleIllustrationStyleChange}
        activeWritingInstructions={workspace.project.writingInstructions ?? ''}
        onEditWritingInstructions={() => {
          setWritingInstructionsOpen(true)
        }}
        globalWritingInstructions={globalWritingInstructions}
        onEditGlobalWritingInstructions={() => setGlobalWritingInstructionsOpen(true)}
        contextBudget={workspace.project.contextBudget ?? 'standard'}
        onContextBudgetChange={handleContextBudgetChange}
        contextUsagePlan={contextUsagePlan}
        contextUsageState={contextUsageState}
        onOpenContextUsage={() => {
          setContextUsageDetailsOpen(true)
        }}
        onOpenSummaryHistory={() => {
          setSummaryHistoryOpen(true)
        }}
        providerSettings={providerSettings}
        onOpenProviderSettings={openProviderSettings}
        appearanceMode={appearanceMode}
        onAppearanceChange={handleAppearanceChange}
      />

      <ContextUsage
        showTrigger={false}
        plan={contextUsagePlan}
        state={contextUsageState}
        error={contextUsageError}
        detailsOpen={contextUsageDetailsOpen}
        detailsPresentation="sheet"
        onDetailsOpenChange={setContextUsageDetailsOpen}
      />

      <WritingInstructionsDialog
        open={writingInstructionsOpen}
        projectTitle={workspace.project.title}
        value={workspace.project.writingInstructions ?? ''}
        structure={workspace.project.writingStructure}
        textProvider={providerSettings.text}
        onClose={() => {
          setWritingInstructionsOpen(false)
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
      <WritingInstructionsDialog
        open={globalWritingInstructionsOpen}
        projectTitle="所有作品"
        value={globalWritingInstructions}
        isGlobal
        onClose={() => setGlobalWritingInstructionsOpen(false)}
        onSave={async (value) => {
          const next = saveGlobalWritingInstructions(value)
          setGlobalWritingInstructions(next)
          setGlobalWritingInstructionsOpen(false)
          showToast(next ? '全局创作设定已保存' : '全局创作设定已清除')
        }}
        onSaveStructure={async () => undefined}
        textProvider={providerSettings.text}
      />

      <SummaryHistoryDialog
        open={summaryHistoryOpen}
        projectId={workspace.project.id}
        chapters={workspace.chapters}
        onClose={() => {
          setSummaryHistoryOpen(false)
        }}
        listVersions={listChapterSummaryVersions}
        restoreVersion={async (projectId, chapterId, versionId) => {
          await restoreChapterSummaryVersion(projectId, chapterId, versionId)
          const refreshedWorkspace = await refreshWorkspace(projectId)
          if (!refreshedWorkspace) throw new Error('摘要已恢复，但当前作品无法重新加载，请关闭后重试。')
          showToast('章节摘要已恢复，后续写作将立即使用恢复后的摘要')
        }}
      />

      <ProviderSettingsDialog
        open={settingsOpen}
        nested={appSettingsOpen}
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
        onClose={closeCharacterAssets}
        onGenerate={requestCharacterPortrait}
        onConfirm={confirmCharacter}
        onReferenceStyleModeChange={handleReferenceStyleModeChange}
        onUpdateProfile={handleUpdateCharacterProfile}
        onCreateCharacter={() => {
          setCharacterAssetsOpen(false)
          setReferenceImageOpen(true)
        }}
        onCancelGeneration={cancelPortraitGeneration}
        generationActive={portraitGenerationActive}
      />
      <ReferenceImageDialog
        open={referenceImageOpen}
        characters={workspace.characters}
        onClose={() => setReferenceImageOpen(false)}
        onImport={importCharacterReference}
        onCreate={createCharacterWithoutReference}
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
