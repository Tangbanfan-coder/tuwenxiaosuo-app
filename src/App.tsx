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
import ContextUsage, { contextUsageToolbarSummary, type ContextUsageState } from './components/ContextUsage'
import ComposerAssetsMenu from './components/ComposerAssetsMenu'
import ReasoningEffortQuickControl from './components/ReasoningEffortQuickControl'
import IllustrationLightbox, { type LightboxImage } from './components/IllustrationLightbox'
import TimelineMessage from './components/TimelineMessage'
import WritingInstructionsDialog from './components/WritingInstructionsDialog'
import SummaryHistoryDialog from './components/SummaryHistoryDialog'
import StyleCorpusDialog from './components/StyleCorpusDialog'
import ProseEvaluationDialog from './components/ProseEvaluationDialog'
import {
  beginWritingTurn,
  applyParagraphRewrite,
  applyReferenceAppearanceAnalysis,
  completeWritingTurn,
  confirmCharacterPortrait,
  createCharacterDraft,
  createProject,
  deleteProject,
  failWritingTurn,
  getStyleCorpusSummary,
  recordProseEvaluationEvent,
  listChapterSummaryVersions,
  renameProject,
  restoreChapterSummaryVersion,
  restoreIllustrationsBlockedByReference,
  setCharacterPortraitFailed,
  setCharacterPortraitGenerating,
  setCharacterPortraitReady,
  setIllustrationFailed,
  setIllustrationBlockedByReference,
  setIllustrationGenerating,
  setIllustrationReady,
  setWritingTurnBackgroundTask,
  updateAutoIllustrate,
  updateCharacterProfile,
  updateCharacterReferenceStyleMode,
  updateContextBudget,
  updateIllustrationStyle,
  updateProjectTheme,
  updateWritingInstructions,
  updateWritingStructure,
} from './data/storyDatabase'
import { createEvaluationEvent, evaluationIssueFields, proseDurationBucket, proseLengthBucket, proseLengthChangeBucket, rewriteRequestedEvaluation, writingTurnCompletedEvaluation } from './domain/proseEvaluation'
import { PROSE_STYLE_RULE_VERSION } from './domain/proseStyle'
import { resolveProjectIllustrationStyle } from './domain/illustrationStyles'
import { resolveIllustrationReferences } from './domain/illustrationReferences'
import { resolvePreviousSceneIllustration } from './domain/sceneContinuity'
import type { AppearanceMode, CharacterAsset, ContextBudget, ConversationMessage, IllustrationAsset, IllustrationStylePresetId, ProjectWorkspace, ReferenceStyleMode, RewriteStrength, StoredParagraph, ThemePresetId } from './domain/models'
import { browserTransport } from './providers/browserTransport'
import { loadProviderSettings, saveProviderSettings } from './providers/config'
import { loadGlobalWritingInstructions, saveGlobalWritingInstructions } from './providers/config'
import { persistImageAsset, resolveImageSource } from './providers/imageAssetStore'
import { logImagePipeline } from './providers/imagePipelineLog'
import { buildIllustrationPrompt } from './providers/illustrationPrompt'
import { useAppBootstrap } from './hooks/useAppBootstrap'
import ConfirmDialog from './components/ConfirmDialog'
import { buildCharacterPortraitPrompt, editOpenAiImage, generateOpenAiImage } from './providers/images'
import { analyzeReferenceImage } from './providers/referenceAnalysis'
import { secretStore } from './providers/secretStore'
import { BackgroundTaskUncertainError, acknowledgeBackgroundGenerationTask, enqueueBackgroundTextTask, supportsBackgroundGeneration, waitForBackgroundGenerationTask } from './providers/backgroundGeneration'
import type { ProviderSettings, ProviderSlot, ReasoningEffort } from './providers/types'
import { explicitlyRequestsNewChapter, generateWritingTurn, markStyleCorpusFragmentsUsed, parseBackgroundWritingResponse, prepareBackgroundWritingRequest, projectStreamingProse, retrieveStyleExamples, rewriteProseParagraph, type ContextBudgetPlan } from './providers/writing'

const APPEARANCE_KEY = 'illustrated-story-chat.appearance.v1'

type ContextUsageReminderTier = 0 | 60 | 80 | 100

function contextUsageReminderTier(plan: ContextBudgetPlan): ContextUsageReminderTier {
  const usage = plan.contextPressureRatio * 100
  if (usage >= 100) return 100
  if (usage >= 80) return 80
  if (usage >= 60) return 60
  return 0
}

interface ComposerProps {
  sending: boolean
  autoIllustrate: boolean
  reasoningEffort: ReasoningEffort | undefined
  contextUsagePlan?: ContextBudgetPlan
  contextUsageState: ContextUsageState
  onSubmit: (text: string) => Promise<boolean>
  onOpenContextUsage: () => void
  onOpenCharacterAssets: () => void
  onOpenReferenceImage: () => void
  onReasoningEffortChange: (reasoningEffort: ReasoningEffort) => void
  onAutoIllustrateChange: () => void
}

function Composer({
  sending,
  autoIllustrate,
  reasoningEffort,
  contextUsagePlan,
  contextUsageState,
  onSubmit,
  onOpenContextUsage,
  onOpenCharacterAssets,
  onOpenReferenceImage,
  onReasoningEffortChange,
  onAutoIllustrateChange,
}: ComposerProps) {
  const [draft, setDraft] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const submit = async () => {
    const text = draft.trim()
    if (!text || sending || submitting) return
    setSubmitting(true)
    setDraft('')
    try {
      if (await onSubmit(text)) setDraft(text)
    } finally {
      setSubmitting(false)
    }
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Browsers disagree on composition state during the final IME Enter.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void submit()
    }
  }

  return (
    <footer className="composer-wrap">
      <div className="composer">
        <textarea
          rows={1}
          value={draft}
          placeholder="继续写下去，或告诉 AI 你想看到的画面…"
          aria-label="创作要求"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="composer-toolbar">
          <div className="composer-tools">
            <ComposerAssetsMenu onOpenCharacterAssets={onOpenCharacterAssets} onOpenReferenceImage={onOpenReferenceImage} />
            <ReasoningEffortQuickControl value={reasoningEffort} onChange={onReasoningEffortChange} />
            <ContextUsage
              plan={contextUsagePlan}
              state={contextUsageState}
              compactLabel={contextUsageToolbarSummary(contextUsagePlan, contextUsageState)}
              detailsOpen={false}
              showDetails={false}
              onDetailsOpenChange={(open) => { if (open) onOpenContextUsage() }}
            />
            <button
              className="composer-tool-button auto-illustrate-button"
              type="button"
              aria-pressed={autoIllustrate}
              aria-label={`自动配图：${autoIllustrate ? '自动' : '关闭'}`}
              onClick={onAutoIllustrateChange}
            >
              <ImagePlus size={17} aria-hidden="true" />
              <span>配图</span>
              <strong>{autoIllustrate ? '自动' : '关闭'}</strong>
            </button>
          </div>
          <button className="send-button" type="button" aria-label="发送" disabled={!draft.trim() || sending || submitting} onClick={() => void submit()}>
            <span className="send-button-surface"><Send size={18} /></span>
          </button>
        </div>
      </div>
    </footer>
  )
}

function loadAppearanceMode(): AppearanceMode {
  return localStorage.getItem(APPEARANCE_KEY) === 'light' ? 'light' : 'dark'
}

export default function App() {
  const timelineRef = useRef<HTMLElement>(null)
  const imageQueueRef = useRef<Promise<void>>(Promise.resolve())
  const queuedIllustrationIdsRef = useRef(new Set<string>())
  const contextUsageReminderTiersRef = useRef(new Map<string, ContextUsageReminderTier>())
  const [contextUsagePlan, setContextUsagePlan] = useState<ContextBudgetPlan>()
  const [contextUsageProjectId, setContextUsageProjectId] = useState<string>()
  const [contextUsageState, setContextUsageState] = useState<ContextUsageState>('pending')
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
  const [styleCorpusOpen, setStyleCorpusOpen] = useState(false)
  const [proseEvaluationOpen, setProseEvaluationOpen] = useState(false)
  const [styleCorpusSummary, setStyleCorpusSummary] = useState<{ sourceCount: number; fragmentCount: number }>()
  const portraitGenerationCancelledRef = useRef(false)
  const [portraitGenerationActive, setPortraitGenerationActive] = useState(false)
  const [summaryHistoryOpen, setSummaryHistoryOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSlot, setSettingsSlot] = useState<ProviderSlot>('text')
  const [toast, setToast] = useState<{ text: string; kind: 'success' | 'error' }>()
  const [providerSettings, setProviderSettings] = useState<ProviderSettings>(() => loadProviderSettings())
  const [imageProviderReady, setImageProviderReady] = useState(false)
  const [illustrationGenerationStages, setIllustrationGenerationStages] = useState<Record<string, 'waiting' | 'downloading' | 'saving' | 'validating'>>({})
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
    const timer = window.setTimeout(() => logImagePipeline('info', { phase: 'logger-ready' }), 1000)
    return () => window.clearTimeout(timer)
  }, [])

  useEffect(() => {
    setWorkspace((current) => current ? { ...current, globalWritingInstructions } : current)
  }, [globalWritingInstructions, setWorkspace])

  const refreshStyleCorpusSummary = useCallback(async () => {
    setStyleCorpusSummary(await getStyleCorpusSummary())
  }, [])

  useEffect(() => { void refreshStyleCorpusSummary() }, [refreshStyleCorpusSummary])

  async function handleRewriteParagraph({ message, paragraph, strength }: { message: ConversationMessage; paragraph: StoredParagraph; strength: RewriteStrength }) {
    if (!workspace) throw new Error('当前作品尚未加载')
    if (!providerSettings.text.baseUrl.trim() || !providerSettings.text.model.trim()) throw new Error('请先配置文本模型')
    const startedAt = Date.now(); const paragraphs = message.paragraphs ?? []
    void recordProseEvaluationEvent(rewriteRequestedEvaluation({ projectId: message.projectId, messageId: message.id, paragraphId: paragraph.id, originalText: paragraph.text, issues: paragraph.styleIssues ?? [], strength })).catch(() => undefined)
    const styleExamples = await retrieveStyleExamples(workspace, paragraph.text, 2).catch(() => [])
    void recordProseEvaluationEvent(createEvaluationEvent('style_corpus_retrieved', { projectId: message.projectId, proseRuleVersion: PROSE_STYLE_RULE_VERSION, corpusFragmentCount: styleExamples.length })).catch(() => undefined)
    try { const rewritten = await rewriteProseParagraph({
      originalText: paragraph.text,
      issues: paragraph.styleIssues ?? [],
      previousParagraph: paragraphs[paragraph.index - 1],
      nextParagraph: paragraphs[paragraph.index + 1],
      styleConstraints: [globalWritingInstructions.slice(0, 1600), workspace.project.writingInstructions?.slice(0, 2400)].filter(Boolean).join('\n'),
      styleExamples: styleExamples.map((item) => item.fragment.text),
      strength,
    }, providerSettings.text, browserTransport)
      await markStyleCorpusFragmentsUsed(styleExamples.map((item) => item.fragment.id)).catch(() => undefined)
      void recordProseEvaluationEvent(createEvaluationEvent('rewrite_succeeded', { projectId: message.projectId, messageId: message.id, paragraphId: paragraph.id, proseRuleVersion: PROSE_STYLE_RULE_VERSION, durationBucket: proseDurationBucket(Date.now() - startedAt), corpusFragmentCount: styleExamples.length, paragraphLengthBucket: proseLengthBucket(paragraph.text), suggestionLengthBucket: proseLengthBucket(rewritten), lengthChangeBucket: proseLengthChangeBucket(paragraph.text, rewritten), beforeRuleIds: (paragraph.styleIssues ?? []).map((issue) => issue.ruleId), factProtection: 'not_checked' })).catch(() => undefined)
      return rewritten
    } catch (error) { void recordProseEvaluationEvent(createEvaluationEvent('rewrite_failed', { projectId: message.projectId, messageId: message.id, paragraphId: paragraph.id, proseRuleVersion: PROSE_STYLE_RULE_VERSION, durationBucket: proseDurationBucket(Date.now() - startedAt), failureKind: 'provider', factProtection: 'not_checked' })).catch(() => undefined); throw error }
  }

  async function handleApplyRewrite({ message, paragraph, rewrittenText }: { message: ConversationMessage; paragraph: StoredParagraph; rewrittenText: string }) {
    try { await applyParagraphRewrite({
      projectId: message.projectId, messageId: message.id, paragraphId: paragraph.id,
      paragraphIndex: paragraph.index, originalFingerprint: paragraph.fingerprint, rewrittenText,
    })
    void recordProseEvaluationEvent(createEvaluationEvent('rewrite_applied', { projectId: message.projectId, messageId: message.id, paragraphId: paragraph.id, proseRuleVersion: PROSE_STYLE_RULE_VERSION, paragraphLengthBucket: proseLengthBucket(paragraph.text), suggestionLengthBucket: proseLengthBucket(rewrittenText), lengthChangeBucket: proseLengthChangeBucket(paragraph.text, rewrittenText), beforeRuleIds: (paragraph.styleIssues ?? []).map((issue) => issue.ruleId), factProtection: 'not_checked' })).catch(() => undefined)
    await refreshWorkspace(message.projectId)
    showToast('已采用建议稿')
    } catch (error) { void recordProseEvaluationEvent(createEvaluationEvent('rewrite_apply_failed', { projectId: message.projectId, messageId: message.id, paragraphId: paragraph.id, proseRuleVersion: PROSE_STYLE_RULE_VERSION, failureKind: 'storage', factProtection: 'not_checked' })).catch(() => undefined); throw error }
  }

  useEffect(() => {
    if (!workspace) return
    if (contextUsageProjectId === workspace.project.id) return
    setContextUsagePlan(undefined)
    setContextUsageError('')
    setContextUsageState('pending')
  }, [contextUsageProjectId, workspace?.project.id])

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

  function enqueueImageTask<T>(task: () => Promise<T>) {
    const queued = imageQueueRef.current.then(task, task)
    imageQueueRef.current = queued.then(() => undefined, () => undefined)
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
      const nativeTarget = { projectId: sourceWorkspace.project.id, assetId: character.id, target: 'portrait' as const }
      const imageUrl = feedback && currentReference
        ? await editOpenAiImage(providerSettings.image, prompt, [currentReference], browserTransport, '1024x1536', undefined, nativeTarget)
        : await generateOpenAiImage(providerSettings.image, prompt, browserTransport, '1024x1536', undefined, nativeTarget)
      const storedImage = await persistImageAsset(imageUrl, sourceWorkspace.project.id, character.id)
      await setCharacterPortraitReady(character.id, storedImage.imageUrl, storedImage.localUri)
      await refreshWorkspace(sourceWorkspace.project.id)
      showToast(`${character.name}的定妆照已生成；去角色资产确认后，相关插画会自动继续`)
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误'
      await setCharacterPortraitFailed(character.id, message)
      await refreshWorkspace(sourceWorkspace.project.id)
      showToast(`${character.name}的定妆照生成失败`, 'error')
      return false
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
    const succeeded = await enqueueImageTask(() => generateCharacterPortrait(character, workspace, feedback))
    if (!succeeded) throw new Error('定妆照生成失败')
  }

  async function importCharacterReference(target: ReferenceImageTarget, dataUrl: string, referenceStyleMode: ReferenceStyleMode, autoAnalyze: boolean) {
    if (!workspace) return
    try {
      const characterId = 'characterId' in target
        ? target.characterId
        : (await createCharacterDraft(workspace.project.id, target.name, target.role)).id
      const storedImage = await persistImageAsset(dataUrl, workspace.project.id, characterId, 'imported')
      await setCharacterPortraitReady(characterId, storedImage.imageUrl, storedImage.localUri, referenceStyleMode)
      let analysisMessage = ''
      if (autoAnalyze) {
        if (await providerIsReady('text')) {
          try {
            const analysis = await analyzeReferenceImage(dataUrl, providerSettings.text, browserTransport)
            await applyReferenceAppearanceAnalysis(characterId, analysis)
            analysisMessage = '，外貌档案已识别，请核对后确认'
          } catch (analysisError) {
            analysisMessage = '；图片已保存，但外貌识别失败，可在角色资产中手动填写或重新识别'
            console.warn('Reference image analysis failed', analysisError instanceof Error ? analysisError.message : String(analysisError))
          }
        } else {
          analysisMessage = '；图片已保存，配置可识图的文本模型后可在角色资产中识别外貌'
        }
      }
      await refreshWorkspace(workspace.project.id)
      setReferenceImageOpen(false)
      setCharacterAssetsOrigin('reference-image')
      setCharacterAssetsOpen(true)
      showToast(`参考图已导入${analysisMessage || '，请补充档案后确认'}`)
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

  async function handleUpdateCharacterProfile(characterId: string, profile: { narrativePronoun?: CharacterAsset['narrativePronoun']; ageAndBuild: string; fixedTraits: string[]; defaultLook: string; wardrobe: string }) {
    if (!workspace) return
    try {
      await updateCharacterProfile(characterId, profile)
      await refreshWorkspace(workspace.project.id)
      showToast('角色档案已更新')
    } catch (error) {
      showToast(error instanceof Error ? error.message : '角色档案保存失败', 'error')
    }
  }

  async function handleAnalyzeReference(characterId: string) {
    if (!workspace) return
    const character = workspace.characters.find((item) => item.id === characterId)
    const referenceSource = character
      ? resolveImageSource(character.continuity.referenceImageUrl, character.continuity.localUri)
      : undefined
    if (!referenceSource) throw new Error('这张参考图无法作为识别输入，请重新导入原图后重试')
    if (!(await providerIsReady('text'))) {
      openProviderSettings('text')
      throw new Error('请先配置可识图的文本模型')
    }
    try {
      const analysis = await analyzeReferenceImage(referenceSource, providerSettings.text, browserTransport)
      await applyReferenceAppearanceAnalysis(characterId, analysis)
      await refreshWorkspace(workspace.project.id)
      showToast('外貌档案已重新识别，请核对并再次确认')
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : '外貌识别失败，请手动补充档案')
    }
  }

  async function generateIllustration(illustration: IllustrationAsset, sourceWorkspace: ProjectWorkspace) {
    const referenceResolution = resolveIllustrationReferences(illustration, sourceWorkspace.characters)
    if (!referenceResolution.ready) {
      await setIllustrationBlockedByReference(illustration.id, referenceResolution.reason)
      await refreshWorkspace(sourceWorkspace.project.id)
      showToast(referenceResolution.reason, 'error')
      return
    }
    await setIllustrationGenerating(illustration.id)
    setIllustrationGenerationStages((current) => ({ ...current, [illustration.id]: 'waiting' }))
    await refreshWorkspace(sourceWorkspace.project.id)
    const pipelineStartedAt = Date.now()
    try {
      const referenceCharacters = referenceResolution.characters
      const characterReferenceSources = referenceCharacters
        .map((character) => resolveImageSource(character.continuity.referenceImageUrl, character.continuity.localUri) as string)
      const previousSceneIllustration = resolvePreviousSceneIllustration(illustration, sourceWorkspace.illustrations)
      const sceneReferenceSource = previousSceneIllustration
        ? resolveImageSource(previousSceneIllustration.imageUrl, previousSceneIllustration.localUri)
        : undefined
      const referenceSources = sceneReferenceSource
        ? [...characterReferenceSources, sceneReferenceSource]
        : characterReferenceSources
      const prompt = buildIllustrationPrompt(illustration, sourceWorkspace.style, referenceCharacters, Boolean(sceneReferenceSource))
      const nativeTarget = { projectId: sourceWorkspace.project.id, assetId: illustration.id, target: 'illustration' as const }
      const setStage = (stage: 'waiting' | 'downloading' | 'saving' | 'validating') => {
        setIllustrationGenerationStages((current) => ({ ...current, [illustration.id]: stage }))
      }
      const imageUrl = referenceSources.length
        ? await editOpenAiImage(providerSettings.image, prompt, referenceSources, browserTransport, '1536x1024', setStage, nativeTarget)
        : await generateOpenAiImage(providerSettings.image, prompt, browserTransport, '1536x1024', setStage, nativeTarget)
      const storedImage = await persistImageAsset(imageUrl, sourceWorkspace.project.id, illustration.id, 'generated', setStage)
      await setIllustrationReady(illustration.id, storedImage.imageUrl, storedImage.localUri)
      await refreshWorkspace(sourceWorkspace.project.id)
      logImagePipeline('info', {
        phase: 'illustration-complete',
        illustrationId: illustration.id,
        usesReferences: referenceResolution.usesReferences,
        durationMs: Date.now() - pipelineStartedAt,
      })
      showToast('剧情插画已生成')
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误'
      logImagePipeline('warn', {
        phase: 'illustration-failed',
        illustrationId: illustration.id,
        usesReferences: referenceResolution.usesReferences,
        durationMs: Date.now() - pipelineStartedAt,
        message,
      })
      await setIllustrationFailed(illustration.id, message)
      await refreshWorkspace(sourceWorkspace.project.id)
      showToast('剧情插画生成失败，没有自动重试', 'error')
    } finally {
      setIllustrationGenerationStages((current) => {
        const { [illustration.id]: _finished, ...remaining } = current
        return remaining
      })
    }
  }

  async function confirmCharacter(characterId: string) {
    if (!workspace) return
    const legacyReferenceBlocks = workspace.illustrations.flatMap((illustration) => {
      if (illustration.status !== 'failed' || illustration.failureKind || !illustration.errorMessage) return []
      const resolution = resolveIllustrationReferences(illustration, workspace.characters)
      return !resolution.ready && illustration.errorMessage === resolution.reason
        ? [{ illustrationId: illustration.id, reason: resolution.reason }]
        : []
    })
    try {
      await confirmCharacterPortrait(characterId)
    } catch (error) {
      showToast(error instanceof Error ? error.message : '确认角色失败', 'error')
      return
    }
    await Promise.all(legacyReferenceBlocks.map(({ illustrationId, reason }) => (
      setIllustrationBlockedByReference(illustrationId, reason)
    )))
    let nextWorkspace = await refreshWorkspace(workspace.project.id)
    if (!nextWorkspace) return
    const confirmedWorkspace = nextWorkspace
    const readyReferenceBlocks = confirmedWorkspace.illustrations.filter((illustration) => {
      if (illustration.failureKind !== 'reference-unavailable') return false
      const resolution = resolveIllustrationReferences(illustration, confirmedWorkspace.characters)
      return resolution.ready && resolution.characters.some((character) => character.id === characterId)
    })
    if (readyReferenceBlocks.length) {
      await restoreIllustrationsBlockedByReference(confirmedWorkspace.project.id, readyReferenceBlocks.map((illustration) => illustration.id))
      nextWorkspace = await refreshWorkspace(workspace.project.id)
      if (!nextWorkspace) return
      showToast(`已解锁 ${readyReferenceBlocks.length} 张等待中的插画，自动配图开启时会继续生成`)
    }
    if (!nextWorkspace.project.autoIllustrate || !(await providerIsReady('image'))) return
    const eligible = nextWorkspace.illustrations.filter((illustration) => {
      if (illustration.status !== 'planned') return false
      const resolution = resolveIllustrationReferences(illustration, nextWorkspace.characters)
      return resolution.ready && resolution.characters.some((character) => character.id === characterId)
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

  async function sendMessage(text: string) {
    if (!workspace || sending) return true

    const textProvider = providerSettings.text
    if (!textProvider.baseUrl.trim() || !textProvider.model.trim() || !(await secretStore.has(textProvider.secretRef))) {
      showToast('请先完成文本模型配置')
      openProviderSettings('text')
      return true
    }

    setSending(true)
    streamingRawRef.current = ''
    setStreamingText('')
    let noticeId: string | undefined
    let shouldRestoreDraft = false
    let backgroundOutcome: 'none' | 'issued' | 'failed' | 'uncertain' | 'completed' = 'none'
    let expectedBackgroundTaskId: string | undefined
    let selectedStyleFragmentIds: string[] = []
    let contextReminder: { text: string; kind: 'success' | 'error' } | undefined
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
      const writingOptions = {
        onStyleFragmentsSelected: (fragmentIds: string[]) => { selectedStyleFragmentIds = fragmentIds },
        onContextPlan: (plan: ContextBudgetPlan) => {
          setContextUsagePlan(plan)
          setContextUsageProjectId(workspace.project.id)
          setContextUsageError('')
          setContextUsageState(plan.isOverLimit ? 'over-limit' : plan.estimator.isFallback ? 'fallback' : 'ready')
          const previousTier = contextUsageReminderTiersRef.current.get(workspace.project.id) ?? 0
          const nextTier = contextUsageReminderTier(plan)
          contextUsageReminderTiersRef.current.set(workspace.project.id, nextTier)
          if (nextTier > previousTier) {
            const reminder = nextTier === 60
              ? '上下文达到 60%，将开始整理近期内容'
              : nextTier === 80
                ? '上下文达到 80%，将明显压缩历史内容'
                : '上下文达到 100%，将优先保留核心规则与章节状态'
            contextReminder = { text: reminder, kind: nextTier === 100 ? 'error' : 'success' }
          }
        },
      }
      const forceNewChapter = explicitlyRequestsNewChapter(text)
      const backgroundTask = supportsBackgroundGeneration()
        ? await (async () => {
          const preparedBackgroundRequest = await prepareBackgroundWritingRequest(workspace, text, textProvider, writingOptions)
          return enqueueBackgroundTextTask({
            ...preparedBackgroundRequest,
            secretRef: textProvider.secretRef,
            metadata: { projectId: workspace.project.id, userMessageId, noticeId, autoIllustrate: workspace.project.autoIllustrate, forceNewChapter },
          })
        })()
        : undefined
      let result
      if (backgroundTask) {
        backgroundOutcome = 'issued'
        const linked = await setWritingTurnBackgroundTask(noticeId, backgroundTask.id)
        if (!linked) {
          backgroundOutcome = 'uncertain'
          throw new BackgroundTaskUncertainError('请求已发出，正在等待补收结果')
        }
        expectedBackgroundTaskId = backgroundTask.id
        let completed
        try { completed = await waitForBackgroundGenerationTask(backgroundTask.id) }
        catch { backgroundOutcome = 'uncertain'; throw new BackgroundTaskUncertainError() }
        if (completed.state === 'unknown') { backgroundOutcome = 'uncertain'; throw new BackgroundTaskUncertainError() }
        if (completed.state !== 'completed' || !completed.rawResponse) { backgroundOutcome = 'failed'; throw new Error(completed.error || '后台写作未完成') }
        try {
          result = parseBackgroundWritingResponse(completed.rawResponse)
        } catch (error) {
          backgroundOutcome = 'failed'
          throw error
        }
        backgroundOutcome = 'completed'
      } else {
        result = await generateWritingTurn(workspace, text, textProvider, browserTransport, (delta) => {
          streamingRawRef.current += delta
          setStreamingText(projectStreamingProse(streamingRawRef.current))
        }, writingOptions)
      }
      try {
        await completeWritingTurn(
          workspace.project.id,
          userMessageId,
          noticeId,
          result,
          workspace.project.autoIllustrate,
          forceNewChapter,
          expectedBackgroundTaskId,
        )
      } catch (error) {
        if (expectedBackgroundTaskId) {
          backgroundOutcome = 'uncertain'
          throw new BackgroundTaskUncertainError('结果已保存，正在等待下次补收')
        }
        throw error
      }
      await markStyleCorpusFragmentsUsed(selectedStyleFragmentIds).catch(() => undefined)
      void recordProseEvaluationEvent(writingTurnCompletedEvaluation({ projectId: workspace.project.id, corpusFragmentCount: selectedStyleFragmentIds.length, contextBudget: workspace.project.contextBudget ?? 'standard' })).catch(() => undefined)
      if (expectedBackgroundTaskId) await acknowledgeBackgroundGenerationTask(expectedBackgroundTaskId)
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
          illustration.status === 'planned' && resolveIllustrationReferences(illustration, nextWorkspace.characters).ready
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
      if (contextReminder) showToast(contextReminder.text, contextReminder.kind)
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误'
      if (noticeId && backgroundOutcome !== 'issued' && backgroundOutcome !== 'uncertain') {
        const partialProse = projectStreamingProse(streamingRawRef.current)
        await failWritingTurn(noticeId, message, partialProse)
        if (expectedBackgroundTaskId) await acknowledgeBackgroundGenerationTask(expectedBackgroundTaskId)
        await refreshWorkspace(workspace.project.id)
      }
      if (backgroundOutcome === 'issued' || backgroundOutcome === 'uncertain' || error instanceof BackgroundTaskUncertainError) {
        shouldRestoreDraft = false
        showToast(error instanceof Error ? error.message : '请求已发出，等待补收结果', 'error')
      } else {
        shouldRestoreDraft = true
        showToast('本轮写作未完成', 'error')
      }
    } finally {
      setSending(false)
      streamingRawRef.current = ''
      setStreamingText('')
    }
    return shouldRestoreDraft
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
  const activeContextUsagePlan = contextUsageProjectId === workspace.project.id ? contextUsagePlan : undefined
  const activeContextUsageState = contextUsageProjectId === workspace.project.id ? contextUsageState : 'pending'
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
                    illustrationGenerationStage={illustration ? illustrationGenerationStages[illustration.id] : undefined}
                    onRetryIllustration={retryIllustration}
                    imageProviderReady={imageProviderReady}
                    onOpenImageSettings={() => openProviderSettings('image')}
                    characters={workspace.characters}
                    onOpenCharacterAssets={openCharacterAssets}
                    onOpenIllustration={(source, title, alt, localUri) => setLightboxImage({ source, title, alt, localUri })}
                    onRewriteParagraph={handleRewriteParagraph}
                    onApplyRewrite={handleApplyRewrite}
                    onProseEvaluation={({ type, message, paragraph }) => {
                      const issues = paragraph.styleIssues ?? []
                      const event = type === 'analyzed'
                        ? createEvaluationEvent('prose_analyzed', { projectId: message.projectId, messageId: message.id, paragraphId: paragraph.id, proseRuleVersion: paragraph.styleRuleVersion ?? PROSE_STYLE_RULE_VERSION, paragraphLengthBucket: proseLengthBucket(paragraph.text), ...evaluationIssueFields(issues) })
                        : type === 'rewrite_opened'
                          ? createEvaluationEvent('rewrite_opened', { projectId: message.projectId, messageId: message.id, paragraphId: paragraph.id, proseRuleVersion: PROSE_STYLE_RULE_VERSION, paragraphLengthBucket: proseLengthBucket(paragraph.text), ...evaluationIssueFields(issues) })
                          : createEvaluationEvent('rewrite_kept_original', { projectId: message.projectId, messageId: message.id, paragraphId: paragraph.id, proseRuleVersion: PROSE_STYLE_RULE_VERSION, factProtection: 'not_checked' })
                      void recordProseEvaluationEvent(event).catch(() => undefined)
                    }}
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

      <Composer
        sending={sending}
        autoIllustrate={workspace.project.autoIllustrate}
        reasoningEffort={providerSettings.text.reasoningEffort}
        contextUsagePlan={activeContextUsagePlan}
        contextUsageState={activeContextUsageState}
        onSubmit={sendMessage}
        onOpenContextUsage={() => setContextUsageDetailsOpen(true)}
        onOpenCharacterAssets={openCharacterAssets}
        onOpenReferenceImage={() => setReferenceImageOpen(true)}
        onReasoningEffortChange={handleReasoningEffortChange}
        onAutoIllustrateChange={() => void handleAutoIllustrate(!workspace.project.autoIllustrate)}
      />

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
        suspended={writingInstructionsOpen || globalWritingInstructionsOpen || styleCorpusOpen || proseEvaluationOpen || summaryHistoryOpen || settingsOpen || contextUsageDetailsOpen}
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
        styleCorpusSummary={styleCorpusSummary}
        onOpenStyleCorpus={() => setStyleCorpusOpen(true)}
        onOpenProseEvaluation={() => setProseEvaluationOpen(true)}
        contextBudget={workspace.project.contextBudget ?? 'standard'}
        onContextBudgetChange={handleContextBudgetChange}
        contextUsagePlan={activeContextUsagePlan}
        contextUsageState={activeContextUsageState}
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
        plan={activeContextUsagePlan}
        state={activeContextUsageState}
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
      <StyleCorpusDialog
        open={styleCorpusOpen}
        textProvider={providerSettings.text}
        transport={browserTransport}
        onClose={() => setStyleCorpusOpen(false)}
        onChanged={() => void refreshStyleCorpusSummary()}
        onEvaluation={(event) => void recordProseEvaluationEvent(createEvaluationEvent(event.type === 'imported' ? 'style_corpus_imported' : 'style_corpus_deleted', { proseRuleVersion: PROSE_STYLE_RULE_VERSION, corpusFragmentCount: event.fragmentCount })).catch(() => undefined)}
      />
      <ProseEvaluationDialog open={proseEvaluationOpen} currentProjectId={workspace.project.id} onClose={() => setProseEvaluationOpen(false)} />
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
        onAnalyzeReference={handleAnalyzeReference}
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
