import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowDown,
  BookPlus,
  BookOpen,
  Check,
  ChevronDown,
  Menu,
  Plus,
  Settings,
  TriangleAlert,
  UserRound,
  X,
} from 'lucide-react'
import ProjectDrawer from './components/ProjectDrawer'
import CharacterAssetsDrawer from './components/CharacterAssetsDrawer'
import ProviderSettingsDialog from './components/ProviderSettingsDialog'
import ReferenceImageDialog from './components/ReferenceImageDialog'
import SettingsDrawer from './components/SettingsDrawer'
import ContextUsage from './components/ContextUsage'
import Composer from './components/Composer'
import IllustrationLightbox, { type LightboxImage } from './components/IllustrationLightbox'
import TimelineMessage from './components/TimelineMessage'
import WritingInstructionsDialog from './components/WritingInstructionsDialog'
import SummaryHistoryDialog from './components/SummaryHistoryDialog'
import StyleCorpusDialog from './components/StyleCorpusDialog'
import ProseEvaluationDialog from './components/ProseEvaluationDialog'
import {
  applyParagraphRewrite,
  createProject,
  deleteProject,
  getStyleCorpusSummary,
  upsertPreferenceSignal,
  recordProseEvaluationEvent,
  listChapterSummaryVersions,
  renameProject,
  restoreChapterSummaryVersion,
  updateIllustrationMode,
  updateContextBudget,
  updateIllustrationStyle,
  updateProjectTheme,
  updateWritingInstructions,
  updateWritingStructure,
} from './data/storyDatabase'
import { createEvaluationEvent, evaluationIssueFields, proseDurationBucket, proseLengthBucket, proseLengthChangeBucket, rewriteRequestedEvaluation, writingTurnCompletedEvaluation } from './domain/proseEvaluation'
import { PROSE_STYLE_RULE_VERSION } from './domain/proseStyle'
import { resolveProjectIllustrationStyle } from './domain/illustrationStyles'
import { resolveIllustrationMode, type AppearanceMode, type ContextBudget, type ConversationMessage, type Feedback, type FeedbackVerdict, type IllustrationMode, type IllustrationStylePresetId, type RewriteStrength, type StoredParagraph, type ThemePresetId } from './domain/models'
import { browserTransport } from './providers/browserTransport'
import { loadProviderSettings, saveProviderSettings } from './providers/config'
import { loadGlobalWritingInstructions, saveGlobalWritingInstructions } from './providers/config'
import { logImagePipeline } from './providers/imagePipelineLog'
import { secretStore } from './providers/secretStore'
import { useAppBootstrap } from './hooks/useAppBootstrap'
import { useTimelineNavigation } from './hooks/useTimelineNavigation'
import { useWritingTurnController } from './hooks/useWritingTurnController'
import { useImageAssetWorkflow } from './hooks/useImageAssetWorkflow'
import ConfirmDialog from './components/ConfirmDialog'
import type { ProviderSettings, ProviderSlot, ReasoningEffort } from './providers/types'
import { analyzeFeedbackPreference, markStyleCorpusFragmentsUsed, retrieveStyleExamples, rewriteProseParagraph } from './providers/writing'

const APPEARANCE_KEY = 'illustrated-story-chat.appearance.v1'

function loadAppearanceMode(): AppearanceMode {
  return localStorage.getItem(APPEARANCE_KEY) === 'light' ? 'light' : 'dark'
}

export default function App() {
  const [contextUsageDetailsOpen, setContextUsageDetailsOpen] = useState(false)
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
  const [summaryHistoryOpen, setSummaryHistoryOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSlot, setSettingsSlot] = useState<ProviderSlot>('text')
  const [toast, setToast] = useState<{ text: string; kind: 'success' | 'error' }>()
  const [providerSettings, setProviderSettings] = useState<ProviderSettings>(() => loadProviderSettings())
  const [appearanceMode, setAppearanceMode] = useState<AppearanceMode>(() => loadAppearanceMode())
  const [lightboxImage, setLightboxImage] = useState<LightboxImage>()
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

  const {
    cancelPortraitGeneration,
    confirmCharacter,
    createCharacterWithoutReference,
    handleAnalyzeReference,
    handleReferenceStyleModeChange,
    handleUpdateCharacterProfile,
    handleWritingCompleted,
    illustrationGenerationStages,
    imageProviderReady,
    importCharacterReference,
    portraitGenerationActive,
    requestCharacterPortrait,
    retryIllustration,
  } = useImageAssetWorkflow({
    workspace,
    providerSettings,
    refreshWorkspace,
    showToast,
    openProviderSettings,
    onRequireImageProviderForCharacter: () => {
      setCharacterAssetsOpen(false)
      setCharacterAssetsOrigin('main')
    },
    onOpenCharacterAssets: openCharacterAssets,
    onReferenceImported: () => {
      setReferenceImageOpen(false)
      setCharacterAssetsOrigin('reference-image')
      setCharacterAssetsOpen(true)
    },
    onCharacterCreated: () => {
      setReferenceImageOpen(false)
      setCharacterAssetsOpen(true)
    },
  })

  const {
    activeContextUsagePlan,
    activeContextUsageState,
    contextUsageError,
    editLatestRetryableUserMessage,
    generationPhase,
    handleStopGeneration,
    adoptCandidateProse,
    keepOriginalProse,
    latestRegenerableMessageId,
    latestRetryableUserMessageId,
    regenerateLatestProse,
    regeneratingProseMessageId,
    retryWriting,
    sendMessage,
    streamingText,
    writingCandidate,
  } = useWritingTurnController({
    workspace,
    providerSettings,
    setWorkspace,
    refreshWorkspace,
    refreshProjects,
    showToast,
    openTextProviderSettings: () => openProviderSettings('text'),
    onWritingCompleted: handleWritingCompleted,
  })

  const {
    handleTimelineScroll,
    handleTimelineUserIntent,
    jumpToLatest,
    showJumpToLatest,
    timelineRef,
    visibleChapterId,
  } = useTimelineNavigation({
    booting,
    projectId: workspace?.project.id,
    messageCount: workspace?.messages.length ?? 0,
    streamingText,
    activeChapterId: workspace?.project.activeChapterId,
    fallbackChapterId: workspace?.chapters[0]?.id,
    generationActive: generationPhase !== 'idle',
    completedProseMessageId: [...(workspace?.messages ?? [])].reverse().find((message) => message.kind === 'prose')?.id,
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

  async function handleAnalyzeFeedbackPreference(input: {
    feedback: Feedback[]
    verdict: FeedbackVerdict
    reason?: string
    targetTexts: string[]
  }) {
    const textProvider = providerSettings.text
    if (!textProvider.baseUrl.trim() || !textProvider.model.trim() || !(await secretStore.has(textProvider.secretRef))) {
      throw new Error('请先完成文本模型配置；反馈已经保存，但没有注入写作偏好')
    }
    const preferences = await analyzeFeedbackPreference({
      verdict: input.verdict,
      reason: input.reason,
      targetTexts: input.targetTexts,
    }, textProvider, browserTransport)
    await Promise.all(input.feedback.flatMap((feedback) => preferences.map((preference) => upsertPreferenceSignal({
      feedbackId: feedback.id,
      projectId: feedback.projectId,
      verdict: feedback.verdict,
      dimension: preference.dimension,
      instruction: preference.instruction,
      source: 'ai',
    }))))
  }

  useEffect(() => {
    if (!toast) return
    const timeout = window.setTimeout(() => setToast(undefined), 2600)
    return () => window.clearTimeout(timeout)
  }, [toast])

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

  async function handleIllustrationMode(illustrationMode: IllustrationMode) {
    if (!workspace) return
    setWorkspace((current) => current ? {
      ...current,
      project: { ...current.project, illustrationMode },
    } : current)
    await updateIllustrationMode(workspace.project.id, illustrationMode)
    showToast(illustrationMode === 'none' ? '已切换为无图，后续只生成正文' : illustrationMode === 'manual' ? '已切换为按需配图，后续视觉建议需手动生成' : '已切换为自动配图，后续写作会自动进入图片队列')
  }

  async function handleContextBudgetChange(contextBudget: ContextBudget) {
    if (!workspace) return
    setWorkspace((current) => current ? {
      ...current,
      project: { ...current.project, contextBudget },
    } : current)
    await updateContextBudget(workspace.project.id, contextBudget)
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

        <section ref={timelineRef} className="timeline" aria-label="创作对话" aria-live="polite" onScroll={handleTimelineScroll} onWheel={handleTimelineUserIntent} onTouchStart={handleTimelineUserIntent} onPointerDown={handleTimelineUserIntent} onKeyDown={handleTimelineUserIntent}>
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
                <div className="timeline-entry" data-message-id={message.id} data-chapter-id={startsChapter ? messageChapterId : undefined} key={message.id}>
                  <TimelineMessage
                    message={message}
                    illustration={illustration}
                    illustrationGenerationStage={illustration ? illustrationGenerationStages[illustration.id] : undefined}
                    onRetryIllustration={retryIllustration}
                    onRetryWriting={retryWriting}
                    canEditUserMessage={message.id === latestRetryableUserMessageId && generationPhase === 'idle'}
                    onEditUserMessage={editLatestRetryableUserMessage}
                    canRegenerate={message.id === latestRegenerableMessageId}
                    writingCandidate={writingCandidate?.proseMessageId === message.id ? writingCandidate : undefined}
                    regenerationBusy={regeneratingProseMessageId === message.id}
                    writingBusy={generationPhase !== 'idle'}
                    onRegenerateProse={regenerateLatestProse}
                    onKeepOriginalProse={keepOriginalProse}
                    onAdoptCandidateProse={adoptCandidateProse}
                    onAnalyzeFeedbackPreference={handleAnalyzeFeedbackPreference}
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
          {generationPhase !== 'idle' && streamingText && (
            <div className="timeline-entry">
              <article className="streaming-prose" aria-live="polite">{streamingText}</article>
            </div>
          )}
          <div className="ready-state" role="status">
            <span /><span /><span />
            <em>{generationPhase === 'cancelling' ? '正在停止…' : generationPhase !== 'idle' ? '正在保存你的想法…' : '等待你的下一步'}</em>
          </div>
        </section>
        {showJumpToLatest && (
          <button
            className="jump-to-latest"
            type="button"
            aria-label="回到最新内容"
            onClick={jumpToLatest}
          >
            <ArrowDown size={18} />
          </button>
        )}
      </div>

      <Composer
        generationPhase={generationPhase}
        illustrationMode={resolveIllustrationMode(workspace.project)}
        reasoningEffort={providerSettings.text.reasoningEffort}
        contextUsagePlan={activeContextUsagePlan}
        contextUsageState={activeContextUsageState}
        onSubmit={sendMessage}
        onStop={handleStopGeneration}
        onOpenContextUsage={() => setContextUsageDetailsOpen(true)}
        onOpenCharacterAssets={openCharacterAssets}
        onOpenReferenceImage={() => setReferenceImageOpen(true)}
        onReasoningEffortChange={handleReasoningEffortChange}
        onIllustrationModeChange={(mode) => void handleIllustrationMode(mode)}
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
