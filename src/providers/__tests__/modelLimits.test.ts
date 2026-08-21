import { describe, expect, it, vi } from 'vitest'
import { heuristicModelContextTokens, isModelKnown, lookupModelLimit, lookupReasoningCapabilities, MODEL_LIMIT_URLS, refreshModelLimits, resolveModelWindow, withModelMetadata } from '../modelLimits'
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

describe('思考能力联合键匹配', () => {
  it('按 providerId 区分同名模型并保留 effort 值域', () => {
    expect(lookupReasoningCapabilities('zhipuai', 'glm-5.2')?.effortValues).toEqual(['high', 'max'])
    expect(lookupReasoningCapabilities('alibaba', 'glm-5.2')?.effortValues).toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('未知 provider 不跨 provider 回退', () => {
    expect(lookupReasoningCapabilities('missing-provider', 'glm-5.2')).toBeUndefined()
  })

  it('保留 budget_tokens 的 min/max 能力边界', () => {
    const capabilities = lookupReasoningCapabilities('siliconflow', 'deepseek-ai/DeepSeek-V4-Flash')
    expect(capabilities?.budgetRange).toEqual({ min: 128, max: 32768 })
    expect(capabilities?.options).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'budget_tokens', min: 128, max: 32768 }),
    ]))
  })
})

describe('模型表缓存版本', () => {
  it('忽略旧 v1 缓存，即使 v2 已记录本轮检查时间', async () => {
    const values = new Map<string, string>([
      ['illustrated-story-chat.model-limits.cache.v1', JSON.stringify({ schemaVersion: 1, models: [{ m: 'legacy-cache-only', c: 123 }] })],
      ['illustrated-story-chat.model-limits.checked.v2', String(Date.now())],
    ])
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => { values.delete(key) },
    })
    vi.stubGlobal('window', { setTimeout, clearTimeout })
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    try {
      await refreshModelLimits()
      expect(lookupModelLimit('legacy-cache-only')).toBeUndefined()
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('拒绝 schemaVersion 1 的远程模型表', async () => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => { values.delete(key) },
    })
    vi.stubGlobal('window', { setTimeout, clearTimeout })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ schemaVersion: 1, models: [{ m: 'v1-remote-only', c: 123 }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })))
    try {
      await refreshModelLimits()
      expect(lookupModelLimit('v1-remote-only')).toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
    }
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

describe('模型窗口来源区分', () => {
  it('手动配置优先于一切自动来源', () => {
    const result = resolveModelWindow({ manualContextLength: 100_000, contextLength: 1_000_000, model: 'gpt-4o' })
    expect(result).toEqual({ tokens: 100_000, source: 'manual' })
  })

  it('供应商元数据（/models 列表）优先于模型表', () => {
    const result = resolveModelWindow({ contextLength: 1_000_000, model: 'gpt-4o' })
    expect(result).toEqual({ tokens: 1_000_000, source: 'provider-metadata' })
  })

  it('模型表命中标记为 model-table', () => {
    const limit = lookupModelLimit('gpt-4o')
    expect(limit).toBeDefined()
    const result = resolveModelWindow({ model: 'gpt-4o' })
    expect(result).toEqual({ tokens: limit!.context, source: 'model-table' })
  })

  it('名称启发式命中（不在模型表）标记为 heuristic', () => {
    const result = resolveModelWindow({ model: 'grok-5' })
    expect(result).toEqual({ tokens: 256_000, source: 'heuristic' })
  })

  it('完全未知模型落入 unknown-default 32K 兜底', () => {
    const result = resolveModelWindow({ model: 'totally-unknown-model-xyz' })
    expect(result).toEqual({ tokens: 32_000, source: 'unknown-default' })
  })
})
