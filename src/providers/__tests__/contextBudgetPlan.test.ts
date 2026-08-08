import { describe, expect, it } from 'vitest'
import {
  CONTEXT_COMPRESSION_PRESSURE_THRESHOLDS,
  buildContextBudgetPlan,
  contextCompressionStageForPressure,
} from '../writing'
import { createOpenAiCompatibleTokenEstimator, resolveTokenEstimator } from '../tokenEstimator'

function sectionTokens(plan: ReturnType<typeof buildContextBudgetPlan>, key: string) {
  return plan.sections.find((section) => section.key === key)?.tokens
}

describe('context budget plan', () => {
  it('maps raw-token pressure through all four centralized stage boundaries', () => {
    const { organizing, compressed, critical } = CONTEXT_COMPRESSION_PRESSURE_THRESHOLDS

    expect(contextCompressionStageForPressure(0)).toBe('normal')
    expect(contextCompressionStageForPressure(organizing - Number.EPSILON)).toBe('normal')
    expect(contextCompressionStageForPressure(organizing)).toBe('organizing')
    expect(contextCompressionStageForPressure(compressed - Number.EPSILON)).toBe('organizing')
    expect(contextCompressionStageForPressure(compressed)).toBe('compressed')
    expect(contextCompressionStageForPressure(critical - Number.EPSILON)).toBe('compressed')
    expect(contextCompressionStageForPressure(critical)).toBe('critical')
  })

  it('returns serializable, tokenized sections and full-window accounting', () => {
    const estimator = resolveTokenEstimator({ protocol: 'openai-compatible', model: 'qwen-plus' })
    const serializedContext = '当前作品资料：{"projectTitle":"测试作品","sections":[{"核心状态":"林昭已经抵达北境"}]}'
    const plan = buildContextBudgetPlan({
      windowTokens: 16_000,
      contextBudget: 'long',
      outputReserveTokens: 2_000,
      safetyMarginTokens: 1_000,
      requestOverheadTokens: 200,
      systemPrompt: '你是小说协作作者。',
      projectWorkspace: '项目：测试作品\n当前章节：第一章',
      coreMemory: '林昭已经抵达北境。',
      timelineRetrievedContext: '昨夜@北境：发现蓝火。',
      recentMessages: '用户此前要求保持第三人称。',
      userMessage: '继续写林昭进入城门后的对话。',
      serializedContext,
      contextDemandTokens: 9_600,
      contextRetainedTokens: 1_200,
      estimator,
    })

    expect(plan.estimator).toEqual({ source: 'o200k_base', isFallback: false })
    expect(plan.sections.map((section) => section.key)).toEqual([
      'systemPrompt',
      'projectWorkspace',
      'coreMemory',
      'timelineRetrievedContext',
      'recentMessages',
      'feedback',
      'userMessage',
    ])
    expect(sectionTokens(plan, 'systemPrompt')).toBeGreaterThan(0)
    expect(sectionTokens(plan, 'projectWorkspace')).toBeGreaterThan(0)
    expect(sectionTokens(plan, 'coreMemory')).toBeGreaterThan(0)
    expect(sectionTokens(plan, 'timelineRetrievedContext')).toBeGreaterThan(0)
    expect(sectionTokens(plan, 'recentMessages')).toBeGreaterThan(0)
    expect(sectionTokens(plan, 'feedback')).toBe(0)
    expect(sectionTokens(plan, 'userMessage')).toBeGreaterThan(0)
    expect(plan.sections.every((section) => section.percentageOfEstimatedInput >= 0)).toBe(true)
    expect(plan.estimatedInputTokens).toBe(
      plan.requestOverheadTokens
      + (sectionTokens(plan, 'systemPrompt') ?? 0)
      + plan.serializedContextTokens
      + (sectionTokens(plan, 'userMessage') ?? 0),
    )
    expect(plan.usedTokens).toBe(plan.estimatedInputTokens + plan.outputReserveTokens + plan.safetyMarginTokens)
    expect(plan.remainingTokens).toBe(plan.windowTokens - plan.usedTokens)
    expect(plan.windowUsageRatio).toBeCloseTo(plan.usedTokens / plan.windowTokens)
    expect(plan.inputUsageRatio).toBeCloseTo(plan.estimatedInputTokens / plan.inputLimitTokens)
    expect(plan.contextTargetTokens).toBeGreaterThan(plan.contextAllocationTokens)
    expect(plan.contextContentBudgetTokens).toBe(plan.contextAllocationTokens - plan.contextSerializationGuardTokens)
    expect(plan.contextDemandTokens).toBe(9_600)
    expect(plan.contextRetainedTokens).toBe(1_200)
    expect(plan.contextPressureRatio).toBeCloseTo(plan.contextDemandTokens / plan.contextContentBudgetTokens)
    expect(plan.compressionStage).toBe(contextCompressionStageForPressure(plan.contextPressureRatio))
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan)
  })

  it('surfaces explicit fallback provenance and an over-limit result', () => {
    const estimator = createOpenAiCompatibleTokenEstimator({
      createEncoder() {
        throw new Error('simulate unavailable tokenizer')
      },
    })
    const plan = buildContextBudgetPlan({
      windowTokens: 100,
      contextBudget: 'standard',
      outputReserveTokens: 30,
      safetyMarginTokens: 10,
      requestOverheadTokens: 60,
      systemPrompt: 'system prompt',
      projectWorkspace: 'workspace context',
      coreMemory: 'memory',
      timelineRetrievedContext: 'timeline',
      recentMessages: 'recent',
      feedback: '',
      userMessage: 'user message',
      serializedContext: '当前作品资料：workspace context memory timeline recent',
      estimator,
    })

    expect(plan.estimator).toEqual({ source: 'chars-per-token', isFallback: true })
    expect(plan.isOverLimit).toBe(true)
    expect(plan.remainingTokens).toBeLessThan(0)
    expect(plan.contextCapacityTokens).toBeLessThan(0)
  })
})
