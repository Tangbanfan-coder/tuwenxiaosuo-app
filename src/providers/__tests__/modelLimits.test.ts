import { describe, expect, it } from 'vitest'
import { heuristicModelContextTokens, isModelKnown, lookupModelLimit, MODEL_LIMIT_URLS, withModelMetadata } from '../modelLimits'
import type { ProviderConfig } from '../types'

describe('模型窗口匹配', () => {
  it('支持带日期版本后缀的前缀匹配', () => {
    const limit = lookupModelLimit('gpt-4o-2024-08-06')
    expect(limit?.context).toBeGreaterThan(0)
  })

  it('支持带供应商前缀的模型 ID', () => {
    const limit = lookupModelLimit('anthropic/claude-opus-4')
    expect(limit?.context).toBeGreaterThan(0)
  })

  it('支持带日期版本后缀的前缀匹配', () => {
    const limit = lookupModelLimit('anthropic/claude-sonnet-4.5-20251001')
    expect(limit?.context).toBeGreaterThan(0)
  })

  it('未知模型返回 undefined 且标记为不可知', () => {
    expect(lookupModelLimit('totally-unknown-model-xyz')).toBeUndefined()
    expect(isModelKnown('totally-unknown-model-xyz')).toBe(false)
  })

  it('启发式对常见模型给出保守值', () => {
    expect(heuristicModelContextTokens('deepseek-chat')).toBe(64_000)
    expect(heuristicModelContextTokens('gpt-4-0613')).toBe(8_000)
    expect(heuristicModelContextTokens('unknown-weird-model')).toBe(32_000)
  })

  it.each(['grok-5', 'grok-4.5-mini'])('Grok 型号 %s 不会落入 32k 未知模型兜底', (model) => {
    expect(heuristicModelContextTokens(model)).toBe(256_000)
    expect(isModelKnown(model)).toBe(true)
    expect(lookupModelLimit(model)?.context ?? heuristicModelContextTokens(model)).toBeGreaterThan(32_000)
  })

  it('在线模型表优先使用 jsDelivr，并保留 GitHub Raw 回退', () => {
    expect(MODEL_LIMIT_URLS[0]).toContain('cdn.jsdelivr.net')
    expect(MODEL_LIMIT_URLS[1]).toContain('raw.githubusercontent.com')
  })
})

describe('切换模型时的元数据隔离', () => {
  const current: ProviderConfig = {
    id: 'p1',
    name: 'p',
    baseUrl: 'https://x/v1',
    model: 'gemini-2.5-pro',
    protocol: 'openai-compatible',
    secretRef: 'provider:text',
    contextLength: 1_000_000,
    maxOutputTokens: 64_000,
    manualContextLength: 100_000,
  }

  it('新模型没有元数据时不会继承上一个模型的自动窗口', () => {
    const next = withModelMetadata(current, { id: 'some-32k-model' })
    expect(next.contextLength).toBeUndefined()
    expect(next.maxOutputTokens).toBeUndefined()
    expect(next.model).toBe('some-32k-model')
  })

  it('手动覆盖值不被自动元数据覆盖', () => {
    const next = withModelMetadata(current, { id: 'new-model', contextLength: 128_000 })
    expect(next.manualContextLength).toBe(100_000)
    expect(next.contextLength).toBe(128_000)
  })

  it('新模型带元数据时替换旧的自动值', () => {
    const next = withModelMetadata(current, { id: 'claude-3-7-sonnet', contextLength: 200_000, maxOutputTokens: 32_000 })
    expect(next.contextLength).toBe(200_000)
    expect(next.maxOutputTokens).toBe(32_000)
  })
})
