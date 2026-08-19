import { describe, expect, it, vi } from 'vitest'
import { buildContextBudgetPlan, estimatedTokenCount } from '../writing/budget'
import type { ResolvedTokenEstimator } from '../tokenEstimator'

/**
 * Regression guard for the token-count memoize and serializedContext reuse.
 * Without these, a future edit to estimatedTokenCount can silently revert to
 * re-encoding on every measure and re-introduce the long-conversation stall.
 * Each estimator uses a distinct text so the shared global cache does not leak
 * between cases; source 'custom' is a valid TokenEstimatorSource member.
 */
function mockEstimator(estimate: (text: string) => number): ResolvedTokenEstimator {
  return { estimator: { estimate: vi.fn(estimate) }, source: 'custom', isFallback: false }
}

describe('estimatedTokenCount 缓存', () => {
  it('二次调用同一文本只触发底层 estimate 一次', () => {
    const estimator = mockEstimator((text) => text.length)
    estimatedTokenCount(estimator, '稳定历史消息一')
    estimatedTokenCount(estimator, '稳定历史消息一')
    expect(estimator.estimator.estimate).toHaveBeenCalledTimes(1)
  })

  it('不同文本各自计算一次，重复访问命中缓存不再重算', () => {
    const estimator = mockEstimator((text) => text.length)
    estimatedTokenCount(estimator, '甲文本')
    estimatedTokenCount(estimator, '乙文本')
    estimatedTokenCount(estimator, '甲文本')
    expect(estimator.estimator.estimate).toHaveBeenCalledTimes(2)
  })

  it('空文本不进入缓存也不触发底层 estimate', () => {
    const estimator = mockEstimator((text) => text.length)
    expect(estimatedTokenCount(estimator, '')).toBe(0)
    expect(estimator.estimator.estimate).not.toHaveBeenCalled()
  })
})

describe('buildContextBudgetPlan 复用 serializedContextTokens', () => {
  it('传入 serializedContextTokens 时直接采用，不重新 encode serializedContext', () => {
    // estimate 故意放大为长度×1000，若重算会远大于 42；用 42 断言走的是复用路径。
    const estimator = mockEstimator((text) => text.length * 1000)
    const serialized = '当前作品资料：一段较长的序列化上下文，包含章节、角色与近期对话。'
    const plan = buildContextBudgetPlan({
      windowTokens: 128_000,
      contextBudget: 'standard',
      outputReserveTokens: 16_000,
      safetyMarginTokens: 8_000,
      systemPrompt: '系统提示',
      userMessage: '用户输入',
      serializedContext: serialized,
      serializedContextTokens: 42,
      contextDemandTokens: 42,
      contextRetainedTokens: 42,
      estimator,
    })
    expect(plan.serializedContextTokens).toBe(42)
    expect(estimator.estimator.estimate).not.toHaveBeenCalledWith(serialized)
  })
})
