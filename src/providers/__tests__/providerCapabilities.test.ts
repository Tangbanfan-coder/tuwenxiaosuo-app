import { describe, expect, it } from 'vitest'
import { capabilitiesForPreset, presetForCapabilities, resolveCapabilities } from '../providerCapabilities'
import type { ProviderConfig } from '../types'

const legacyConfig: ProviderConfig = {
  id: 'p1', name: 'p', baseUrl: 'https://api.test/v1', model: 'gpt-4o', protocol: 'openai-compatible', secretRef: 'provider:text',
}

describe('resolveCapabilities', () => {
  it('旧配置（无 capabilities 字段）全部解析为 auto，行为与升级前一致', () => {
    const caps = resolveCapabilities(legacyConfig)
    expect(caps).toEqual({
      reasoningEffortParameter: 'auto',
      outputTokenParameter: 'auto',
      textTransport: 'auto',
      visionInput: 'auto',
      imageEdits: 'auto',
      maxReferenceImages: undefined,
      imageSizes: undefined,
      portraitSize: undefined,
      sceneSize: undefined,
      tokenizerStrategy: 'auto',
    })
  })

  it('已配置字段保留，未配置字段补齐为 auto', () => {
    const caps = resolveCapabilities({ ...legacyConfig, capabilities: { visionInput: 'unsupported', tokenizerStrategy: 'conservative' } })
    expect(caps.visionInput).toBe('unsupported')
    expect(caps.tokenizerStrategy).toBe('conservative')
    expect(caps.reasoningEffortParameter).toBe('auto')
    expect(caps.imageEdits).toBe('auto')
  })

  it('损坏的能力数据安全降级而不是崩溃', () => {
    const caps = resolveCapabilities({
      ...legacyConfig,
      capabilities: {
        imageSizes: '1024x1024' as unknown as string[],
        maxReferenceImages: -3,
        portraitSize: 42 as unknown as string,
      },
    })
    expect(caps.imageSizes).toBeUndefined()
    expect(caps.maxReferenceImages).toBeUndefined()
    expect(caps.portraitSize).toBeUndefined()
  })
})

describe('presetCapabilities', () => {
  it('自动兼容预设为空对象，等价于 legacy', () => {
    expect(capabilitiesForPreset('automatic')).toEqual({})
  })

  it('OpenAI 官方预设启用官方参数与流式（不含 responseFormat）', () => {
    expect(capabilitiesForPreset('openai-official')).toEqual({
      reasoningEffortParameter: 'supported',
      outputTokenParameter: 'auto',
      textTransport: 'stream',
      visionInput: 'supported',
      imageEdits: 'supported',
      tokenizerStrategy: 'o200k_base',
    })
  })

  it('严格中转预设省略可选参数并保守估算（不含 responseFormat）', () => {
    expect(capabilitiesForPreset('strict-relay')).toEqual({
      reasoningEffortParameter: 'unsupported',
      outputTokenParameter: 'none',
      textTransport: 'non-stream',
      visionInput: 'unsupported',
      imageEdits: 'unsupported',
      tokenizerStrategy: 'conservative',
    })
  })
})

describe('presetForCapabilities', () => {
  it('旧配置映射为自动兼容', () => {
    expect(presetForCapabilities(undefined)).toBe('automatic')
    expect(presetForCapabilities({})).toBe('automatic')
  })

  it('识别 OpenAI 官方与严格中转预设生成的对象', () => {
    expect(presetForCapabilities(capabilitiesForPreset('openai-official'))).toBe('openai-official')
    expect(presetForCapabilities(capabilitiesForPreset('strict-relay'))).toBe('strict-relay')
  })

  it('无法匹配预设的对象归为自定义', () => {
    expect(presetForCapabilities({ visionInput: 'unsupported' })).toBe('custom')
    expect(presetForCapabilities({ outputTokenParameter: 'max_tokens' })).toBe('custom')
  })

  it('仅配置图片尺寸相关字段时回显自定义，不误判为自动或官方预设', () => {
    expect(presetForCapabilities({ imageSizes: ['1024x1024', '768x1152'] })).toBe('custom')
    expect(presetForCapabilities({ portraitSize: '1024x1536' })).toBe('custom')
    expect(presetForCapabilities({ sceneSize: '1536x1024' })).toBe('custom')
  })

  it('imageSizes 按数组值比较：同集合不同顺序视为自定义', () => {
    expect(presetForCapabilities({ imageSizes: ['1024x1024', '768x1152'] })).toBe('custom')
  })

  it('遗留的 responseFormat 字段不影响预设回显（方案 B：该字段已删除但残留数据兼容）', () => {
    const legacyOfficial = {
      ...capabilitiesForPreset('openai-official'),
      responseFormat: 'chat-completions',
    }
    const legacyStrict = {
      ...capabilitiesForPreset('strict-relay'),
      responseFormat: 'chat-completions',
    }
    expect(presetForCapabilities(legacyOfficial)).toBe('openai-official')
    expect(presetForCapabilities(legacyStrict)).toBe('strict-relay')
  })
})
