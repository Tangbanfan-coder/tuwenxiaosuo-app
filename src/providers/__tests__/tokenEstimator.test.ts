import { describe, expect, it } from 'vitest'
import {
  createOpenAiCompatibleTokenEstimator,
  resolveTokenEstimator,
} from '../tokenEstimator'

describe('o200k token estimator', () => {
  it.each(['deepseek-chat', 'qwen-plus', 'glm-4', 'kimi-k2', 'moonshot-v1'])(
    'uses the shared o200k_base adapter for OpenAI-compatible %s',
    (model) => {
      const resolved = resolveTokenEstimator({ protocol: 'openai-compatible', model })
      expect(resolved.source).toBe('o200k_base')
      expect(resolved.isFallback).toBe(false)
    },
  )

  it('counts Chinese, English, mixed punctuation and empty input through o200k_base', () => {
    const resolved = resolveTokenEstimator({
      protocol: 'openai-compatible',
      providerId: 'deepseek',
      model: 'deepseek-chat',
    })

    expect(resolved.source).toBe('o200k_base')
    expect(resolved.isFallback).toBe(false)
    expect(resolved.estimator.estimate('你好，世界！')).toBe(4)
    expect(resolved.estimator.estimate('Hello, world!')).toBe(4)
    expect(resolved.estimator.estimate('Hello，世界! 2026')).toBe(7)
    expect(resolved.estimator.estimate('')).toBe(0)
  })

  it('uses the explicit chars/1.2 fallback when the o200k adapter cannot initialize', () => {
    const resolved = createOpenAiCompatibleTokenEstimator({
      createEncoder() {
        throw new Error('tokenizer unavailable')
      },
    })

    expect(resolved.source).toBe('chars-per-token')
    expect(resolved.isFallback).toBe(true)
    expect(resolved.estimator.estimate('abcd')).toBe(4)
    expect(resolved.estimator.estimate('')).toBe(0)
  })

  it('records a runtime encoder failure as fallback rather than hiding it', () => {
    const resolved = createOpenAiCompatibleTokenEstimator({
      createEncoder: () => ({
        encode() {
          throw new Error('encoding failed')
        },
      }),
    })

    expect(resolved.estimator.estimate('中文')).toBe(2)
    expect(resolved.source).toBe('chars-per-token')
    expect(resolved.isFallback).toBe(true)
  })
})
