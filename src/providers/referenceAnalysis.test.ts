import { describe, expect, it, vi } from 'vitest'
import { analyzeReferenceImage, parseReferenceAppearanceAnalysis } from './referenceAnalysis'
import type { HttpTransport, ProviderConfig } from './types'

const config: ProviderConfig = { id: 'text', name: '文本', baseUrl: 'https://api.test/v1', model: 'vision-model', protocol: 'openai-compatible', secretRef: 'provider:text' }

describe('reference appearance analysis', () => {
  it('sends image data to the configured chat completion service and parses the strict profile', async () => {
    const request = vi.fn().mockResolvedValue({ status: 200, data: { choices: [{ message: { content: '{"narrative_pronoun":"she","age_and_build":"青年，身形修长","fixed_traits":["齐肩黑发"],"default_look":"眉眼清秀","wardrobe":"深色风衣"}' } }] } })
    const result = await analyzeReferenceImage('data:image/png;base64,aW1hZ2U=', config, { request } as unknown as HttpTransport)

    expect(result).toEqual({ narrativePronoun: 'she', ageAndBuild: '青年，身形修长', fixedTraits: ['齐肩黑发'], defaultLook: '眉眼清秀', wardrobe: '深色风衣' })
    const body = JSON.parse(request.mock.calls[0][0].body)
    expect(body.messages[0].content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } })]))
  })

  it('fails clearly for invalid model output while the caller can keep the imported image', () => {
    expect(() => parseReferenceAppearanceAnalysis('not json')).toThrow('有效 JSON')
  })

  it('accepts a fenced JSON response from compatible gateways', () => {
    expect(parseReferenceAppearanceAnalysis('```json\n{"narrative_pronoun":"she","default_look":"黑色长发"}\n```'))
      .toMatchObject({ narrativePronoun: 'she', defaultLook: '黑色长发' })
  })

  it('rejects an empty profile instead of confirming an invented fallback', () => {
    expect(() => parseReferenceAppearanceAnalysis('{"narrative_pronoun":"she"}')).toThrow('可确认的角色特征')
  })

  it('normalizes an unsupported pronoun suggestion to TA', () => {
    expect(parseReferenceAppearanceAnalysis('{"narrative_pronoun":"unknown","default_look":"短发"}').narrativePronoun).toBe('ta')
  })
})

describe('vision capability gate', () => {
  it('visionInput=unsupported 时在网络请求前阻止识图并说明原因', async () => {
    const request = vi.fn()
    const transport = { request } as unknown as HttpTransport
    const noVision = { ...config, capabilities: { visionInput: 'unsupported' as const } }

    const promise = analyzeReferenceImage('data:image/png;base64,aW1hZ2U=', noVision, transport)

    await expect(promise).rejects.toThrow('当前文本模型不支持视觉输入（识图）')
    expect(request).not.toHaveBeenCalled()
  })

  it('visionInput=auto 时保持现有识图行为', async () => {
    const request = vi.fn().mockResolvedValue({
      status: 200,
      data: { choices: [{ message: { content: '{"narrative_pronoun":"he","default_look":"短发"}' } }] },
    })
    const transport = { request } as unknown as HttpTransport

    const result = await analyzeReferenceImage('data:image/png;base64,aW1hZ2U=', config, transport)
    expect(result.narrativePronoun).toBe('he')
    expect(request).toHaveBeenCalledTimes(1)
  })
})
