import type { ContextBudget } from '../../domain/models'
import { lookupModelLimit, resolveModelWindow } from '../modelLimits'
import { tokenEstimatorMetadata, type ResolvedTokenEstimator } from '../tokenEstimator'
import type { ProviderConfig } from '../types'
import { SYSTEM_PROMPT } from './prompt'

const CONTEXT_BUDGET_RATIOS: Record<ContextBudget, number> = {
  standard: 0.55,
  long: 0.75,
  full: 0.95,
}

const DEFAULT_OUTPUT_RESERVE_TOKENS = 16_000
const CONTEXT_SAFETY_MARGIN_TOKENS = 8_000
const MIN_CONTEXT_SAFETY_MARGIN_TOKENS = 512
const REQUEST_OVERHEAD_TOKENS = 2_000
export const CORE_RULES_MAX_CHARS = 10_000
const MIN_CONTEXT_TOKENS = 4_000
export const CONTEXT_SERIALIZATION_OVERHEAD_CHARS = 512
/** Legacy 512-character serialization guard expressed once as a fixed token reserve. */
const CONTEXT_SERIALIZATION_GUARD_TOKENS = 427
export const CONTEXT_NARROWING_FACTOR = 0.85

/**
 * Context pressure is measured against the usable content budget, before any
 * stage-specific trimming. Keep these thresholds centralized: the preview and
 * sent request deliberately derive their stage from the same values.
 */
export const CONTEXT_COMPRESSION_PRESSURE_THRESHOLDS = {
  organizing: 0.70,
  compressed: 0.90,
  critical: 1.15,
} as const

export type ContextCompressionStage = 'normal' | 'organizing' | 'compressed' | 'critical'

export function contextCompressionStageForPressure(pressureRatio: number): ContextCompressionStage {
  if (!Number.isFinite(pressureRatio)) return pressureRatio > 0 ? 'critical' : 'normal'
  if (pressureRatio >= CONTEXT_COMPRESSION_PRESSURE_THRESHOLDS.critical) return 'critical'
  if (pressureRatio >= CONTEXT_COMPRESSION_PRESSURE_THRESHOLDS.compressed) return 'compressed'
  if (pressureRatio >= CONTEXT_COMPRESSION_PRESSURE_THRESHOLDS.organizing) return 'organizing'
  return 'normal'
}

export function contextPressureRatioForDemand(contextDemandTokens: number, contextContentBudgetTokens: number) {
  if (contextContentBudgetTokens > 0) return contextDemandTokens / contextContentBudgetTokens
  return contextDemandTokens > 0 ? Number.MAX_SAFE_INTEGER : 0
}

export type ContextBudgetSectionKey =
  | 'systemPrompt'
  | 'projectWorkspace'
  | 'coreMemory'
  | 'timelineRetrievedContext'
  | 'recentMessages'
  | 'feedback'
  | 'userMessage'

export interface ContextBudgetPlanSection {
  key: ContextBudgetSectionKey
  label: string
  tokens: number
  percentageOfEstimatedInput: number
}

export interface BuildContextBudgetPlanInput {
  windowTokens: number
  contextBudget: ContextBudget
  outputReserveTokens: number
  safetyMarginTokens: number
  requestOverheadTokens?: number
  systemPrompt: string
  projectWorkspace?: string
  coreMemory?: string
  timelineRetrievedContext?: string
  recentMessages?: string
  /** Recent preference feedback text; it remains present in the plan even when empty. */
  feedback?: string
  userMessage: string
  /** The exact serialized context system-message content sent to the provider, when available. */
  serializedContext?: string
  /**
   * The untrimmed, normal-context demand measured with the active tokenizer.
   * When absent, the serialized context is its own demand for compatibility
   * with callers that only build an accounting plan.
   */
  contextDemandTokens?: number
  /** The exact retained serialized-context tokens after stage-specific selection. */
  contextRetainedTokens?: number
  estimator: ResolvedTokenEstimator
}

/**
 * Serializable context-window accounting shared by preview consumers and the
 * writing request path. It does not load data or mutate input text.
 */
export interface ContextBudgetPlan {
  estimator: { source: string; isFallback: boolean }
  windowTokens: number
  contextBudget: ContextBudget
  contextBudgetRatio: number
  contextNarrowingFactor: number
  outputReserveTokens: number
  safetyMarginTokens: number
  requestOverheadTokens: number
  inputLimitTokens: number
  contextCapacityTokens: number
  contextTargetTokens: number
  contextAllocationTokens: number
  contextSerializationGuardTokens: number
  contextContentBudgetTokens: number
  compressionStage: ContextCompressionStage
  contextDemandTokens: number
  contextRetainedTokens: number
  contextPressureRatio: number
  serializedContextTokens: number
  contextSerializationTokens: number
  estimatedInputTokens: number
  usedTokens: number
  remainingTokens: number
  isOverLimit: boolean
  windowUsageRatio: number
  inputUsageRatio: number
  sections: ContextBudgetPlanSection[]
}

export function effectiveWindowTokens(config: ProviderConfig) {
  return resolveModelWindow(config).tokens
}

export function maxOutputForRequest(config: ProviderConfig, windowTokens: number) {
  const configured = config.manualMaxOutputTokens
    ?? config.maxOutputTokens
    ?? lookupModelLimit(config.model)?.output
    ?? DEFAULT_OUTPUT_RESERVE_TOKENS
  return Math.min(configured, Math.floor(windowTokens * 0.5))
}

export function contextSafetyMarginTokens(windowTokens: number) {
  return Math.min(
    CONTEXT_SAFETY_MARGIN_TOKENS,
    Math.max(MIN_CONTEXT_SAFETY_MARGIN_TOKENS, Math.floor(windowTokens * 0.1)),
  )
}

const CONTEXT_BUDGET_SECTION_LABELS: Record<ContextBudgetSectionKey, string> = {
  systemPrompt: '系统提示',
  projectWorkspace: '项目/工作区',
  coreMemory: '核心记忆',
  timelineRetrievedContext: '时间线/检索上下文',
  recentMessages: '近期消息',
  feedback: '反馈（预留）',
  userMessage: '用户消息',
}

export function estimatedTokenCount(estimator: ResolvedTokenEstimator, text: string) {
  const count = estimator.estimator.estimate(text)
  return Number.isFinite(count) && count > 0 ? Math.ceil(count) : 0
}

export function buildContextBudgetPlan(input: BuildContextBudgetPlanInput): ContextBudgetPlan {
  const requestOverheadTokens = Math.max(0, Math.floor(input.requestOverheadTokens ?? REQUEST_OVERHEAD_TOKENS))
  const sectionTexts: Record<ContextBudgetSectionKey, string> = {
    systemPrompt: input.systemPrompt,
    projectWorkspace: input.projectWorkspace ?? '',
    coreMemory: input.coreMemory ?? '',
    timelineRetrievedContext: input.timelineRetrievedContext ?? '',
    recentMessages: input.recentMessages ?? '',
    feedback: input.feedback ?? '',
    userMessage: input.userMessage,
  }
  const rawSectionTokens = (Object.keys(sectionTexts) as ContextBudgetSectionKey[]).map((key) => ({
    key,
    tokens: estimatedTokenCount(input.estimator, sectionTexts[key]),
  }))
  const rawContextTokens = rawSectionTokens
    .filter((section) => section.key !== 'systemPrompt' && section.key !== 'userMessage')
    .reduce((sum, section) => sum + section.tokens, 0)
  const serializedContext = input.serializedContext
  const serializedContextTokens = serializedContext === undefined
    ? rawContextTokens
    : estimatedTokenCount(input.estimator, serializedContext)
  const systemPromptTokens = rawSectionTokens.find((section) => section.key === 'systemPrompt')?.tokens ?? 0
  const userMessageTokens = rawSectionTokens.find((section) => section.key === 'userMessage')?.tokens ?? 0
  const windowTokens = Math.max(0, Math.floor(input.windowTokens))
  const outputReserveTokens = Math.max(0, Math.floor(input.outputReserveTokens))
  const safetyMarginTokens = Math.max(0, Math.floor(input.safetyMarginTokens))
  const inputLimitTokens = windowTokens - outputReserveTokens - safetyMarginTokens
  const nonContextTokens = requestOverheadTokens + systemPromptTokens + userMessageTokens
  const contextCapacityTokens = inputLimitTokens - nonContextTokens
  const contextBudgetRatio = CONTEXT_BUDGET_RATIOS[input.contextBudget]
  const contextTargetTokens = Math.max(0, Math.floor(contextCapacityTokens * contextBudgetRatio))
  const contextAllocationTokens = Math.max(0, Math.floor(contextTargetTokens * CONTEXT_NARROWING_FACTOR))
  const contextContentBudgetTokens = Math.max(0, contextAllocationTokens - CONTEXT_SERIALIZATION_GUARD_TOKENS)
  const contextDemandTokens = Math.max(0, Math.floor(input.contextDemandTokens ?? serializedContextTokens))
  const contextRetainedTokens = Math.max(0, Math.floor(input.contextRetainedTokens ?? serializedContextTokens))
  // Keep the plan JSON-serializable even for a zero-sized budget. A very high
  // finite value still routes this safely to the critical stage.
  const contextPressureRatio = contextPressureRatioForDemand(contextDemandTokens, contextContentBudgetTokens)
  const compressionStage = contextCompressionStageForPressure(contextPressureRatio)
  const estimatedInputTokens = nonContextTokens + serializedContextTokens
  const usedTokens = estimatedInputTokens + outputReserveTokens + safetyMarginTokens
  const remainingTokens = windowTokens - usedTokens
  const denominator = estimatedInputTokens || 1
  const sections = rawSectionTokens.map((section) => ({
    key: section.key,
    label: CONTEXT_BUDGET_SECTION_LABELS[section.key],
    tokens: section.tokens,
    percentageOfEstimatedInput: section.tokens / denominator,
  }))

  return {
    estimator: tokenEstimatorMetadata(input.estimator),
    windowTokens,
    contextBudget: input.contextBudget,
    contextBudgetRatio,
    contextNarrowingFactor: CONTEXT_NARROWING_FACTOR,
    outputReserveTokens,
    safetyMarginTokens,
    requestOverheadTokens,
    inputLimitTokens,
    contextCapacityTokens,
    contextTargetTokens,
    contextAllocationTokens,
    contextSerializationGuardTokens: CONTEXT_SERIALIZATION_GUARD_TOKENS,
    contextContentBudgetTokens,
    compressionStage,
    contextDemandTokens,
    contextRetainedTokens,
    contextPressureRatio,
    serializedContextTokens,
    contextSerializationTokens: serializedContextTokens - rawContextTokens,
    estimatedInputTokens,
    usedTokens,
    remainingTokens,
    isOverLimit: remainingTokens < 0,
    windowUsageRatio: windowTokens ? usedTokens / windowTokens : 0,
    inputUsageRatio: inputLimitTokens > 0 ? estimatedInputTokens / inputLimitTokens : 0,
    sections,
  }
}

export function contextPlanForRequest(config: ProviderConfig, budget: ContextBudget, userRequest: string, estimator: ResolvedTokenEstimator) {
  const windowTokens = effectiveWindowTokens(config)
  const outputReserveTokens = maxOutputForRequest(config, windowTokens)
  const safetyMarginTokens = contextSafetyMarginTokens(windowTokens)
  return buildContextBudgetPlan({
    windowTokens,
    contextBudget: budget,
    outputReserveTokens,
    safetyMarginTokens,
    systemPrompt: SYSTEM_PROMPT,
    userMessage: userRequest,
    estimator,
  })
}

export function assertContextCapacity(plan: ContextBudgetPlan) {
  const minimumContextTokens = Math.min(
    MIN_CONTEXT_TOKENS,
    Math.max(512, Math.floor(plan.windowTokens * 0.15)),
  )
  if (plan.contextCapacityTokens < minimumContextTokens) {
    throw new Error(
      `当前请求已超过模型的上下文窗口：窗口 ${plan.windowTokens.toLocaleString()} token，扣除输出预留 ${plan.outputReserveTokens.toLocaleString()}、安全余量 ${plan.safetyMarginTokens.toLocaleString()} 和系统提示后所剩不足。请缩短本条输入、降低最大输出或改用更大窗口的模型。`,
    )
  }
}
