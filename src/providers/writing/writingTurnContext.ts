import { resolveIllustrationMode, type PreferenceSignal, type ProjectWorkspace, type StoredParagraph, type StyleCorpusFragment } from '../../domain/models'
import { resolveTokenEstimator } from '../tokenEstimator'
import { resolveCapabilities } from '../providerCapabilities'
import type { ProviderConfig } from '../types'
import { retrieveParagraphsSync, type RetrievedParagraph } from '../retriever'
import type { StoredScene } from '../../data/storyDatabase'
import {
  buildContextBudgetPlan,
  contextCompressionStageForPressure,
  contextPlanForRequest,
  contextPressureRatioForDemand,
  estimatedTokenCount,
  type ContextBudgetPlan,
} from './budget'
import { buildProjectContextForTokenBudget, buildUntrimmedProjectContextForDemand } from './context'
import { systemPromptForIllustrationMode } from './prompt'

/**
 * Input for the pure context computation. The caller (main thread) performs
 * all I/O (DB loads) first, then hands the already-filtered scenes here. The
 * caller either supplies already-retrieved paragraphs (custom retriever
 * injection) or the raw paragraphs + retrieval query so retrieval can run
 * inside the worker (default Bigram BM25 path) — never both.
 * This module never touches the DB, so a Web Worker can import it without
 * crossing function boundaries (the onContextPlan callbacks stay on main
 * thread).
 */
export interface ComputeWritingTurnContextInput {
  workspace: ProjectWorkspace
  scenes: StoredScene[]
  /** Raw retrievable paragraphs; paired with retrievalQuery for worker-side retrieval. */
  paragraphs?: readonly StoredParagraph[]
  /** Retrieval query built on the main thread (cheap string assembly). */
  retrievalQuery?: string
  retrievalTopK?: number
  /** Pre-retrieved paragraphs from a custom Retriever (injected path). */
  retrievedParagraphs?: readonly RetrievedParagraph[]
  preferenceSignals: readonly PreferenceSignal[]
  styleCorpusFragments: readonly StyleCorpusFragment[]
  config: ProviderConfig
  userRequest: string
  excludeUserMessageId?: string
}

export interface ComputedWritingTurnContext {
  initialPlan: ContextBudgetPlan
  finalPlan: ContextBudgetPlan
  contextMessage: string
  rulesTruncated: boolean
  styleFragmentIds: string[]
}

/**
 * Pure, synchronous context computation extracted from prepareWritingTurnContext:
 * estimator resolution + initial plan + the two build passes (untrimmed demand
 * measurement, then stage-trimmed) + final budget plan. This is the
 * tokenizer-bound CPU work that blocks the main thread on long conversations;
 * isolating it lets a Web Worker run it off-thread while the memoize cache
 * lives in the worker realm across turns (higher hit rate than a per-turn
 * main-thread estimator).
 *
 * No I/O, no retriever, no callbacks. Deterministic given the same input.
 */
export function computeWritingTurnContext(input: ComputeWritingTurnContextInput): ComputedWritingTurnContext {
  const { workspace, scenes, retrievedParagraphs, preferenceSignals, styleCorpusFragments, config, userRequest, excludeUserMessageId } = input
  const resolvedRetrievedParagraphs = retrievedParagraphs ?? []
  const contextBudget = workspace.project.contextBudget ?? 'standard'
  const systemPrompt = systemPromptForIllustrationMode(resolveIllustrationMode(workspace.project))
  const estimator = resolveTokenEstimator({ protocol: config.protocol, providerId: config.id, model: config.model, tokenizerStrategy: resolveCapabilities(config).tokenizerStrategy })
  const initialPlan = contextPlanForRequest(config, contextBudget, userRequest, estimator, systemPrompt)

  // Measure the rich, untrimmed normal context before deciding which material
  // to tighten. This is intentionally based on tokenizer output, never text
  // length or the already-trimmed final payload.
  const rawContext = buildUntrimmedProjectContextForDemand(
    workspace,
    scenes,
    userRequest,
    estimator,
    resolvedRetrievedParagraphs,
    [],
    styleCorpusFragments,
    { excludeUserMessageId, preferenceSignals },
  )
  const contextDemandTokens = estimatedTokenCount(estimator, `当前作品资料：${rawContext.context}`)
  const compressionStage = contextCompressionStageForPressure(
    contextPressureRatioForDemand(contextDemandTokens, initialPlan.contextContentBudgetTokens),
  )
  const { context, rulesTruncated, contextSections } = buildProjectContextForTokenBudget(
    workspace,
    scenes,
    initialPlan.contextContentBudgetTokens,
    userRequest,
    estimator,
    resolvedRetrievedParagraphs,
    { compressionStage, preferenceSignals, styleCorpusFragments, excludeUserMessageId },
  )
  const contextMessage = `当前作品资料：${context}`
  const contextMessageTokens = estimatedTokenCount(estimator, contextMessage)
  const finalPlan = buildContextBudgetPlan({
    windowTokens: initialPlan.windowTokens,
    contextBudget,
    outputReserveTokens: initialPlan.outputReserveTokens,
    safetyMarginTokens: initialPlan.safetyMarginTokens,
    systemPrompt,
    projectWorkspace: contextSections.projectWorkspace,
    coreMemory: contextSections.coreMemory,
    timelineRetrievedContext: contextSections.timelineRetrievedContext,
    recentMessages: contextSections.recentMessages,
    feedback: contextSections.feedback,
    userMessage: userRequest,
    serializedContext: contextMessage,
    serializedContextTokens: contextMessageTokens,
    contextDemandTokens,
    contextRetainedTokens: contextMessageTokens,
    estimator,
  })

  return { initialPlan, finalPlan, contextMessage, rulesTruncated, styleFragmentIds: styleCorpusFragments.map((fragment) => fragment.id) }
}

/**
 * Main-thread fallback path (worker unavailable / transient failure): runs the
 * default Bigram BM25 retrieval synchronously, then computes the context with
 * the same pure pipeline the worker uses. Behavior is identical to the
 * worker-side path (paragraphIndex) — only the incremental cache is missing.
 * When the input already carries pre-retrieved paragraphs (custom Retriever
 * injection), it just delegates to computeWritingTurnContext.
 */
export function computeWritingTurnContextWithRetrieval(input: ComputeWritingTurnContextInput): ComputedWritingTurnContext {
  const { paragraphs, retrievalQuery, retrievalTopK, ...rest } = input
  if (paragraphs && retrievalQuery) {
    // trustFingerprint：段落来自本地 DB（写入时 fingerprint 已权威计算），
    // 跳过每轮全量哈希重算，与 worker 索引路径的信任策略保持一致。
    const retrieved = retrieveParagraphsSync({ query: retrievalQuery, paragraphs, topK: retrievalTopK }, undefined, undefined, { trustFingerprint: true })
    return computeWritingTurnContext({ ...rest, retrievedParagraphs: retrieved })
  }
  return computeWritingTurnContext(input)
}
