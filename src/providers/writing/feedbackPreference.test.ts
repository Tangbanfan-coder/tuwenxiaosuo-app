import { describe, expect, it, vi } from 'vitest'
import { analyzeFeedbackPreference } from './feedbackPreference'

const config = { id: 'text', name: 'Text', baseUrl: 'https://example.test/v1', model: 'test', protocol: 'openai-compatible' as const, secretRef: 'secret' }
const response = (content: string) => ({ request: vi.fn().mockResolvedValue({ status: 200, data: { choices: [{ message: { content } }] } }), stream: vi.fn() })

describe('analyzeFeedbackPreference', () => {
  it('uses one non-stream request and parses abstract preferences', async () => {
    const transport = response('{"preferences":[{"dimension":"dialogue","instruction":"后续对白更直接简短"}]}')
    await expect(analyzeFeedbackPreference({ verdict: 'down', targetTexts: ['林默在雨夜说起上次的钥匙。'] }, config, transport)).resolves.toEqual([{ dimension: 'dialogue', instruction: '后续对白更直接简短' }])
    expect(transport.request).toHaveBeenCalledTimes(1); expect(transport.stream).not.toHaveBeenCalled()
  })
  it('rejects source echoes and protocol errors without retrying', async () => {
    const transport = response('{"preferences":[{"dimension":"plot","instruction":"后续保留林默在雨夜寻找钥匙"}]}')
    await expect(analyzeFeedbackPreference({ verdict: 'up', targetTexts: ['林默在雨夜寻找钥匙。'] }, config, transport)).rejects.toThrow('剧情事实')
    expect(transport.request).toHaveBeenCalledTimes(1)
    await expect(analyzeFeedbackPreference({ verdict: 'up', targetTexts: ['正文'] }, config, response('not json'))).rejects.toThrow('JSON')
    await expect(analyzeFeedbackPreference({ verdict: 'up', targetTexts: ['林默关上门。'] }, config, response('{"preferences":[{"dimension":"dialogue","instruction":"后续对白避免提及林默"}]}'))).rejects.toThrow('剧情事实')
    await expect(analyzeFeedbackPreference({ verdict: 'up', targetTexts: ['正文'] }, config, response('{"preferences":[{"dimension":"unknown","instruction":"后续表达更自然"}]}'))).rejects.toThrow('无效指令')
  })
  it('does not retry request failures', async () => {
    const transport = { request: vi.fn().mockRejectedValue(new Error('network')), stream: vi.fn() }
    await expect(analyzeFeedbackPreference({ verdict: 'up', targetTexts: ['正文'] }, config, transport)).rejects.toThrow('network')
    expect(transport.request).toHaveBeenCalledTimes(1)
  })
})
