import { resolveIllustrationMode, type PreferenceSignal, type ProjectWorkspace, type StyleCorpusFragment } from '../../domain/models'
import { resolveTokenEstimator } from '../tokenEstimator'
import { resolveCapabilities } from '../providerCapabilities'
import type { ProviderConfig } from '../types'
import type { RetrievedParagraph } from '../retriever'
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
 * all I/O (DB loads) and retrieval first, then hands the already-filtered
 * scenes + already-retrieved paragraphs here. This module never touches the
 * DB or a retriever, so a Web Worker can import it without crossing function
 * boundaries (the retriever and onContextPlan callbacks stay on main thread).
 */
export interface ComputeWritingTurnContextInput {
  workspace: ProjectWorkspace
  scenes: StoredScene[]
  retrievedParagraphs: readonly RetrievedParagraph[]
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
    retrievedParagraphs,
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
    retrievedParagraphs,
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
