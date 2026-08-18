import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import {
  adoptWritingCandidate,
  beginWritingTurn,
  cancelWritingTurn,
  completeWritingTurn,
  failWritingTurn,
  getLatestEditableWritingUserMessage,
  getLatestRegenerableWritingTurn,
  getWritingCandidate,
  keepOriginalWritingCandidate,
  recordProseEvaluationEvent,
  retryWritingTurn,
  saveWritingCandidate,
  setWritingTurnBackgroundTask,
  saveLatestUserMessageRevision,
} from '../data/storyDatabase'
import type { ContextUsageState } from '../domain/contextUsage'
import { resolveIllustrationMode, type ConversationMessage, type IllustrationMode, type ProjectWorkspace, type WritingCandidate, type WritingTurnResult } from '../domain/models'
import { writingTurnCompletedEvaluation } from '../domain/proseEvaluation'
import { browserTransport, TransportCancelledError } from '../providers/browserTransport'
import {
  BackgroundTaskUncertainError,
  acknowledgeBackgroundGenerationTask,
  cancelBackgroundGenerationTask,
  enqueueBackgroundTextTask,
  supportsBackgroundGeneration,
  waitForBackgroundGenerationTask,
} from '../providers/backgroundGeneration'
import { secretStore } from '../providers/secretStore'
import type { ProviderSettings } from '../providers/types'
import {
  explicitlyRequestsNewChapter,
  generateWritingTurn,
  markStyleCorpusFragmentsUsed,
  parseBackgroundWritingResponse,
  prepareBackgroundWritingRequest,
  projectStreamingProse,
  type ContextBudgetPlan,
} from '../providers/writing'

export type GenerationPhase = 'idle' | 'starting' | 'running' | 'saving' | 'cancelling'
export type { ContextUsageState } from '../domain/contextUsage'

interface GenerationControl {
  attemptId: number
  cancelled: boolean
  phase: GenerationPhase
  noticeId?: string
  abortController?: AbortController
  backgroundTaskId?: string
}

interface UseWritingTurnControllerOptions {
  workspace: ProjectWorkspace | null
  providerSettings: ProviderSettings
  setWorkspace: Dispatch<SetStateAction<ProjectWorkspace | null>>
  refreshWorkspace: (projectId: string) => Promise<ProjectWorkspace | null | undefined>
  refreshProjects: () => Promise<unknown>
  showToast: (text: string, kind?: 'success' | 'error') => void
  openTextProviderSettings: () => void
  onWritingCompleted: (input: {
    result: WritingTurnResult
    nextWorkspace: ProjectWorkspace
    previousIllustrationIds: ReadonlySet<string>
    illustrationMode: IllustrationMode
  }) => Promise<void>
}

type WritingAttemptOutcome = 'completed' | 'failed' | 'cancelled' | 'uncertain' | 'superseded'
type ContextUsageReminderTier = 0 | 60 | 80 | 100

function contextUsageReminderTier(plan: ContextBudgetPlan): ContextUsageReminderTier {
  const usage = plan.contextPressureRatio * 100
  if (usage >= 100) return 100
  if (usage >= 80) return 80
  if (usage >= 60) return 60
  return 0
}

/** Owns the writing transaction, streaming lifecycle, and context usage state. */
export function useWritingTurnController({
  workspace,
  providerSettings,
  setWorkspace,
  refreshWorkspace,
  refreshProjects,
  showToast,
  openTextProviderSettings,
  onWritingCompleted,
}: UseWritingTurnControllerOptions) {
  const [generationPhase, setGenerationPhase] = useState<GenerationPhase>('idle')
  const [streamingText, setStreamingText] = useState('')
  const [contextUsagePlan, setContextUsagePlan] = useState<ContextBudgetPlan>()
  const [contextUsageProjectId, setContextUsageProjectId] = useState<string>()
  const [contextUsageState, setContextUsageState] = useState<ContextUsageState>('pending')
  const [contextUsageError, setContextUsageError] = useState('')
  const [latestRegenerableMessageId, setLatestRegenerableMessageId] = useState<string>()
  const [latestEditableUserMessageId, setLatestEditableUserMessageId] = useState<string>()
  const [regeneratingProseMessageId, setRegeneratingProseMessageId] = useState<string>()
  const [writingCandidate, setWritingCandidate] = useState<WritingCandidate>()
  const generationRef = useRef<GenerationControl>({ attemptId: 0, cancelled: false, phase: 'idle' })
  const streamingRawRef = useRef('')
  const contextUsageReminderTiersRef = useRef(new Map<string, ContextUsageReminderTier>())

  useEffect(() => {
    if (!workspace || contextUsageProjectId === workspace.project.id) return
    setContextUsagePlan(undefined)
    setContextUsageError('')
    setContextUsageState('pending')
  }, [contextUsageProjectId, workspace?.project.id])

  useEffect(() => {
    let cancelled = false
    if (!workspace) {
      setLatestRegenerableMessageId(undefined)
      setLatestEditableUserMessageId(undefined)
      setWritingCandidate(undefined)
      return
    }
    void (async () => {
      try {
        const target = await getLatestRegenerableWritingTurn(workspace.project.id)
        if (cancelled) return
        setLatestRegenerableMessageId(target?.prose.id)
        const editableUser = await getLatestEditableWritingUserMessage(workspace.project.id)
        if (cancelled) return
        setLatestEditableUserMessageId(editableUser?.id)
        setWritingCandidate(target?.prose.turnId ? await getWritingCandidate(workspace.project.id, target.prose.turnId) : undefined)
      } catch {
        if (!cancelled) {
          setLatestRegenerableMessageId(undefined)
          setLatestEditableUserMessageId(undefined)
          setWritingCandidate(undefined)
        }
      }
    })()
    return () => { cancelled = true }
  }, [workspace?.project.id, workspace?.messages])

  async function runWritingAttempt(input: { userMessageId: string; noticeId: string; userText: string }): Promise<WritingAttemptOutcome> {
    if (!workspace) return 'superseded'
    const textProvider = providerSettings.text
    const { userMessageId, noticeId, userText } = input
    const projectId = workspace.project.id
    const illustrationMode = resolveIllustrationMode(workspace.project)
    const attemptId = ++generationRef.current.attemptId
    generationRef.current.cancelled = false
    generationRef.current.phase = 'running'
    generationRef.current.noticeId = noticeId
    generationRef.current.backgroundTaskId = undefined
    generationRef.current.abortController = undefined

    setGenerationPhase('running')
    streamingRawRef.current = ''
    setStreamingText('')

    let backgroundOutcome: 'none' | 'issued' | 'failed' | 'uncertain' | 'completed' = 'none'
    let expectedBackgroundTaskId: string | undefined
    let selectedStyleFragmentIds: string[] = []
    let contextReminder: { text: string; kind: 'success' | 'error' } | undefined

    const isCurrent = () => generationRef.current.attemptId === attemptId
    const isCancelled = () => generationRef.current.cancelled

    try {
      const previousIllustrationIds = new Set(workspace.illustrations.map((illustration) => illustration.id))
      const writingOptions = {
        excludeUserMessageId: userMessageId,
        onStyleFragmentsSelected: (fragmentIds: string[]) => { selectedStyleFragmentIds = fragmentIds },
        onContextPlan: (plan: ContextBudgetPlan) => {
          setContextUsagePlan(plan)
          setContextUsageProjectId(projectId)
          setContextUsageError('')
          setContextUsageState(plan.isOverLimit ? 'over-limit' : plan.estimator.isFallback ? 'fallback' : 'ready')
          const previousTier = contextUsageReminderTiersRef.current.get(projectId) ?? 0
          const nextTier = contextUsageReminderTier(plan)
          contextUsageReminderTiersRef.current.set(projectId, nextTier)
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
      const forceNewChapter = explicitlyRequestsNewChapter(userText)
      const backgroundTask = supportsBackgroundGeneration()
        ? await (async () => {
          const preparedBackgroundRequest = await prepareBackgroundWritingRequest(workspace, userText, textProvider, writingOptions)
          return enqueueBackgroundTextTask({
            ...preparedBackgroundRequest,
            secretRef: textProvider.secretRef,
            metadata: { projectId, userMessageId, noticeId, illustrationMode, forceNewChapter },
          })
        })()
        : undefined

      if (!isCurrent()) return 'superseded'

      let result: WritingTurnResult
      if (backgroundTask) {
        backgroundOutcome = 'issued'
        generationRef.current.backgroundTaskId = backgroundTask.id
        if (isCancelled()) {
          await cancelBackgroundGenerationTask(backgroundTask.id).catch(() => undefined)
          throw new TransportCancelledError('生成已取消')
        }
        const linked = await setWritingTurnBackgroundTask(noticeId, backgroundTask.id)
        if (!linked) {
          backgroundOutcome = 'uncertain'
          throw new BackgroundTaskUncertainError('请求已发出，正在等待补收结果')
        }
        expectedBackgroundTaskId = backgroundTask.id
        let completed
        try { completed = await waitForBackgroundGenerationTask(backgroundTask.id) }
        catch { backgroundOutcome = 'uncertain'; throw new BackgroundTaskUncertainError() }
        if (!isCurrent()) return 'superseded'
        if (completed.state === 'unknown') { backgroundOutcome = 'uncertain'; throw new BackgroundTaskUncertainError() }
        if (completed.state === 'cancelled') { backgroundOutcome = 'failed'; throw new TransportCancelledError('生成已取消') }
        if (completed.state !== 'completed' || !completed.rawResponse) { backgroundOutcome = 'failed'; throw new Error(completed.error || '后台写作未完成') }
        try {
          result = parseBackgroundWritingResponse(completed.rawResponse)
        } catch (error) {
          backgroundOutcome = 'failed'
          throw error
        }
        backgroundOutcome = 'completed'
      } else {
        const abortController = new AbortController()
        generationRef.current.abortController = abortController
        if (isCancelled()) abortController.abort()
        result = await generateWritingTurn(workspace, userText, textProvider, browserTransport, (delta) => {
          if (!isCurrent()) return
          streamingRawRef.current += delta
          setStreamingText(projectStreamingProse(streamingRawRef.current))
        }, { ...writingOptions, signal: abortController.signal })
      }

      if (!isCurrent()) return 'superseded'
      if (isCancelled()) throw new TransportCancelledError('生成已取消')
      // Saving starts before the async database call. This closes the event-loop
      // window where a stale stop callback could cancel a completed turn.
      generationRef.current.phase = 'saving'
      setGenerationPhase('saving')
      try {
        await completeWritingTurn(projectId, userMessageId, noticeId, result, illustrationMode, forceNewChapter, expectedBackgroundTaskId)
      } catch (error) {
        if (expectedBackgroundTaskId) {
          backgroundOutcome = 'uncertain'
          throw new BackgroundTaskUncertainError('结果已保存，正在等待下次补收')
        }
        throw error
      }
      await markStyleCorpusFragmentsUsed(selectedStyleFragmentIds).catch(() => undefined)
      void recordProseEvaluationEvent(writingTurnCompletedEvaluation({ projectId, corpusFragmentCount: selectedStyleFragmentIds.length, contextBudget: workspace.project.contextBudget ?? 'standard' })).catch(() => undefined)
      if (expectedBackgroundTaskId) await acknowledgeBackgroundGenerationTask(expectedBackgroundTaskId)
      streamingRawRef.current = ''
      setStreamingText('')
      const nextWorkspace = await refreshWorkspace(projectId)
      await refreshProjects()
      if (nextWorkspace) await onWritingCompleted({ result, nextWorkspace, previousIllustrationIds, illustrationMode })
      else if (result.kind === 'prose') showToast('正文已保存')
      if (contextReminder) showToast(contextReminder.text, contextReminder.kind)
      return 'completed'
    } catch (error) {
      if (!isCurrent()) return 'superseded'
      if (isCancelled() || error instanceof TransportCancelledError) {
        await cancelWritingTurn(noticeId)
        if (expectedBackgroundTaskId) await acknowledgeBackgroundGenerationTask(expectedBackgroundTaskId).catch(() => undefined)
        await refreshWorkspace(projectId).catch(() => undefined)
        return 'cancelled'
      }
      const message = error instanceof Error ? error.message : '未知错误'
      if (backgroundOutcome !== 'issued' && backgroundOutcome !== 'uncertain') {
        const partialProse = projectStreamingProse(streamingRawRef.current)
        await failWritingTurn(noticeId, message, partialProse)
        if (expectedBackgroundTaskId) await acknowledgeBackgroundGenerationTask(expectedBackgroundTaskId)
        await refreshWorkspace(projectId)
      }
      if (backgroundOutcome === 'issued' || backgroundOutcome === 'uncertain' || error instanceof BackgroundTaskUncertainError) {
        showToast(error instanceof Error ? error.message : '请求已发出，等待补收结果', 'error')
        return 'uncertain'
      }
      showToast('本轮写作未完成', 'error')
      return 'failed'
    } finally {
      if (isCurrent()) {
        generationRef.current.phase = 'idle'
        setGenerationPhase('idle')
        streamingRawRef.current = ''
        setStreamingText('')
      }
    }
  }

  async function sendMessage(text: string) {
    if (!workspace || generationPhase !== 'idle') return true
    const textProvider = providerSettings.text
    if (!textProvider.baseUrl.trim() || !textProvider.model.trim() || !(await secretStore.has(textProvider.secretRef))) {
      showToast('请先完成文本模型配置')
      openTextProviderSettings()
      return true
    }

    let addedMessages: ConversationMessage[]
    try {
      addedMessages = await beginWritingTurn(workspace.project.id, text, resolveIllustrationMode(workspace.project), workspace.project.activeChapterId)
    } catch (error) {
      showToast(error instanceof Error ? error.message : '无法创建写作任务', 'error')
      return true
    }
    const userMessageId = addedMessages[0].id
    const noticeId = addedMessages[1].id
    setWritingCandidate(undefined)
    setWorkspace((current) => current && current.project.id === workspace.project.id ? {
      ...current,
      project: { ...current.project, updatedAt: Date.now() },
      messages: [
        ...current.messages.map((message) => message.pendingRevisionText ? { ...message, pendingRevisionText: undefined } : message),
        ...addedMessages,
      ],
    } : current)
    try {
      await refreshProjects()
    } catch {
      await failWritingTurn(noticeId, '作品列表刷新失败，本轮写作未启动').catch(() => undefined)
      await refreshWorkspace(workspace.project.id).catch(() => undefined)
      showToast('本轮写作未能启动，请重试', 'error')
      return true
    }

    setGenerationPhase('starting')
    const outcome = await runWritingAttempt({ userMessageId, noticeId, userText: text })
    return outcome === 'failed'
  }

  async function retryWriting(message: ConversationMessage) {
    if (!workspace || generationPhase !== 'idle' || message.kind !== 'notice') return
    try {
      const retry = await retryWritingTurn(message.projectId, message.id)
      setWorkspace((current) => current && current.project.id === workspace.project.id ? {
        ...current,
        project: { ...current.project, updatedAt: Date.now() },
        messages: current.messages.map((item) => item.id === message.id ? { ...item, text: retry.illustrationMode === 'none' ? '正在重新生成正文…' : '正在重新生成正文并整理视觉计划…', status: 'pending' as const, backgroundTaskId: '' } : item),
      } : current)
      setGenerationPhase('starting')
      await runWritingAttempt({ userMessageId: message.userMessageId ?? '', noticeId: message.id, userText: retry.userText })
    } catch (error) {
      showToast(error instanceof Error ? error.message : '重新生成失败', 'error')
    }
  }

  async function editLatestUserMessage(message: ConversationMessage, text: string) {
    if (!workspace || generationPhase !== 'idle' || message.kind !== 'user') return false
    try {
      const revision = await saveLatestUserMessageRevision(message.projectId, message.id, text)
      const updatedAt = Date.now()
      setWorkspace((current) => current?.project.id === message.projectId ? {
        ...current,
        project: { ...current.project, updatedAt },
        messages: current.messages.map((item) => item.id === message.id
          ? revision.mode === 'retry'
            ? { ...item, text: revision.text, pendingRevisionText: undefined }
            : { ...item, pendingRevisionText: revision.text === item.text ? undefined : revision.text }
          : item),
      } : current)
      setLatestEditableUserMessageId(message.id)
      if (revision.mode === 'pending') {
        setWritingCandidate(undefined)
        showToast('已保存修改；重新生成并采用新版后将应用')
      } else showToast('已更新发送内容，可重新生成')
      void refreshProjects().catch(() => undefined)
      return true
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存发送内容失败', 'error')
      return false
    }
  }

  async function regenerateLatestProse(message: ConversationMessage) {
    if (!workspace || generationPhase !== 'idle' || message.kind !== 'prose') return
    const textProvider = providerSettings.text
    if (!textProvider.baseUrl.trim() || !textProvider.model.trim() || !(await secretStore.has(textProvider.secretRef))) {
      showToast('请先完成文本模型配置')
      openTextProviderSettings()
      return
    }

    const target = await getLatestRegenerableWritingTurn(workspace.project.id)
    if (!target || target.prose.id !== message.id || !target.prose.turnId) {
      showToast('只能重新生成最近一轮成功正文', 'error')
      return
    }
    const requestedUserText = target.user.pendingRevisionText ?? target.user.text
    if (!requestedUserText) {
      showToast('最近一轮没有可用的用户要求', 'error')
      return
    }

    const attemptId = ++generationRef.current.attemptId
    const abortController = new AbortController()
    generationRef.current = { attemptId, cancelled: false, phase: 'running', abortController }
    setRegeneratingProseMessageId(message.id)
    setGenerationPhase('running')
    setStreamingText('')
    let selectedStyleFragmentIds: string[] = []
    try {
      const regenerationWorkspace: ProjectWorkspace = {
        ...workspace,
        project: { ...workspace.project, activeChapterId: target.chapter.id },
        messages: workspace.messages.filter((item) => item.turnId !== target.prose.turnId),
        chapters: workspace.chapters.map((chapter) => chapter.id === target.chapter.id
          ? { ...chapter, content: target.baseChapterContent, summary: target.baseChapterSummary }
          : chapter),
        characters: workspace.characters.filter((character) => character.turnId !== target.prose.turnId),
        illustrations: workspace.illustrations.filter((illustration) => illustration.turnId !== target.prose.turnId),
      }
      const request = `${requestedUserText}\n\n【重新生成要求】重新完成最近一轮正文，保持原始要求和已经存在的前史；不要引用、评价、概括或复述旧版本，只给出可供比较的新版本。`
      const result = await generateWritingTurn(regenerationWorkspace, request, textProvider, browserTransport, undefined, {
        signal: abortController.signal,
        excludeUserMessageId: target.user.id,
        onStyleFragmentsSelected: (fragmentIds) => { selectedStyleFragmentIds = fragmentIds },
        onContextPlan: (plan) => {
          setContextUsagePlan(plan)
          setContextUsageProjectId(workspace.project.id)
          setContextUsageError('')
          setContextUsageState(plan.isOverLimit ? 'over-limit' : plan.estimator.isFallback ? 'fallback' : 'ready')
        },
        regeneration: {
          turnId: target.prose.turnId,
          proseMessageId: target.prose.id,
          chapterId: target.chapter.id,
          baseParagraphCount: target.baseParagraphCount,
        },
      })
      if (generationRef.current.attemptId !== attemptId) return
      if (result.kind !== 'prose') throw new Error('重新生成没有返回正文候选稿')
      generationRef.current.phase = 'saving'
      setGenerationPhase('saving')
      const candidate = await saveWritingCandidate({
        projectId: workspace.project.id,
        turnId: target.prose.turnId,
        proseMessageId: target.prose.id,
        chapterId: target.chapter.id,
        baseChapterHash: target.baseChapterHash,
        baseChapterContent: target.baseChapterContent,
        sourceUserText: requestedUserText,
        result,
      })
      await markStyleCorpusFragmentsUsed(selectedStyleFragmentIds).catch(() => undefined)
      setWritingCandidate(candidate)
      setLatestRegenerableMessageId(target.prose.id)
      showToast('候选正文已生成，请比较后选择')
    } catch (error) {
      if (generationRef.current.attemptId !== attemptId) return
      if (generationRef.current.cancelled || error instanceof TransportCancelledError) showToast('已停止候选正文生成')
      else showToast(error instanceof Error ? error.message : '候选正文生成失败', 'error')
    } finally {
      if (generationRef.current.attemptId === attemptId) {
        generationRef.current.phase = 'idle'
        generationRef.current.abortController = undefined
        setRegeneratingProseMessageId(undefined)
        setGenerationPhase('idle')
      }
    }
  }

  async function keepOriginalProse(message: ConversationMessage) {
    if (!workspace || message.kind !== 'prose' || !message.turnId || writingCandidate?.proseMessageId !== message.id) return
    const userMessageId = await keepOriginalWritingCandidate(workspace.project.id, message.turnId)
    if (userMessageId) setWorkspace((current) => current?.project.id === workspace.project.id ? {
      ...current,
      messages: current.messages.map((item) => item.id === userMessageId ? { ...item, pendingRevisionText: undefined } : item),
    } : current)
    setWritingCandidate(undefined)
    showToast('已保留原版正文')
  }

  async function adoptCandidateProse(message: ConversationMessage) {
    if (!workspace || generationPhase !== 'idle' || message.kind !== 'prose' || !message.turnId || writingCandidate?.proseMessageId !== message.id) return
    const attemptId = ++generationRef.current.attemptId
    generationRef.current = { attemptId, cancelled: false, phase: 'saving' }
    setGenerationPhase('saving')
    const previousIllustrationIds = new Set(workspace.illustrations.map((illustration) => illustration.id))
    try {
      const adopted = await adoptWritingCandidate(workspace.project.id, message.turnId)
      setWritingCandidate(undefined)
      const nextWorkspace = await refreshWorkspace(workspace.project.id)
      await refreshProjects()
      if (nextWorkspace) await onWritingCompleted({
        result: adopted.result,
        nextWorkspace,
        previousIllustrationIds,
        illustrationMode: resolveIllustrationMode(nextWorkspace.project),
      })
      showToast('已采用新版正文')
    } catch (error) {
      showToast(error instanceof Error ? error.message : '新版正文采用失败', 'error')
    } finally {
      if (generationRef.current.attemptId === attemptId) {
        generationRef.current.phase = 'idle'
        setGenerationPhase('idle')
      }
    }
  }

  async function handleStopGeneration() {
    const controlPhase = generationRef.current.phase
    if (controlPhase !== 'starting' && controlPhase !== 'running') return
    generationRef.current.phase = 'cancelling'
    setGenerationPhase('cancelling')
    generationRef.current.cancelled = true
    generationRef.current.abortController?.abort()
    const { noticeId, backgroundTaskId } = generationRef.current
    if (noticeId) await cancelWritingTurn(noticeId).catch(() => undefined)
    if (backgroundTaskId) await cancelBackgroundGenerationTask(backgroundTaskId).catch(() => undefined)
    showToast('已停止本地接收；上游若已开始计费可能无法撤销。')
  }

  const activeContextUsagePlan = contextUsageProjectId === workspace?.project.id ? contextUsagePlan : undefined
  const activeContextUsageState: ContextUsageState = contextUsageProjectId === workspace?.project.id ? contextUsageState : 'pending'

  return {
    activeContextUsagePlan,
    activeContextUsageState,
    contextUsageError,
    contextUsagePlan,
    contextUsageState,
    generationPhase,
    editLatestUserMessage,
    handleStopGeneration,
    adoptCandidateProse,
    keepOriginalProse,
    latestRegenerableMessageId,
    latestEditableUserMessageId,
    regenerateLatestProse,
    regeneratingProseMessageId,
    retryWriting,
    sendMessage,
    streamingText,
    writingCandidate,
  }
}
