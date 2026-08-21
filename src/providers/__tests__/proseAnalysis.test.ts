import { describe, expect, it, vi } from 'vitest'
import type { HttpTransport, ProviderConfig, TransportRequest } from '../types'
import { analyzeProseStyle, parseModelProseAnalysis } from '../writing/proseAnalysis'

const config: ProviderConfig = { id: 'text', name: '文本', baseUrl: 'https://example.com/v1', model: 'model', protocol: 'openai-compatible', secretRef: 'secret' }

function transportWith(content: string) {
  let request: TransportRequest | undefined
  const transport = {
    request: vi.fn(async (input: TransportRequest) => { request = input; return { status: 200, data: { choices: [{ message: { content } }] } } }),
    stream: vi.fn(),
  } as unknown as HttpTransport
  return { transport, getRequest: () => request }
}

describe('prose model analysis', () => {
  it('parses empty model output without inventing issues', () => {
    expect(parseModelProseAnalysis('{"issues":[]}', ['具体动作。'])).toEqual([[]])
  })

  it('parses an open risk category not represented by a local rule', () => {
    const result = parseModelProseAnalysis(JSON.stringify({ issues: [{ paragraph_index: 0, category: 'scene-detachment', severity: 'warning', confidence: 0.84, explanation: '抽象判断替代了现场动作。', rewrite_goal: '补出人物此刻可观察的动作或物件变化。', matched_text: '一种说不清的感觉' }] }), ['一种说不清的感觉漫上心头。'])
    expect(result[0][0]).toMatchObject({ ruleId: 'model-scene-detachment', category: 'scene-detachment', source: 'text-model', confidence: 0.84, matchedText: '一种说不清的感觉' })
  })

  it('rejects invalid index, category, duplicate and over-limit output', () => {
    expect(() => parseModelProseAnalysis('{"issues":[{"paragraph_index":2,"category":"rhythm","severity":"hint","confidence":0.8,"explanation":"x","rewrite_goal":"y"}]}', ['段落。'])).toThrow('索引')
    expect(() => parseModelProseAnalysis('{"issues":[{"paragraph_index":0,"category":"unknown","severity":"hint","confidence":0.8,"explanation":"x","rewrite_goal":"y"}]}', ['段落。'])).toThrow('类别')
    const duplicate = { issues: [
      { paragraph_index: 0, category: 'rhythm', severity: 'hint', confidence: 0.8, explanation: 'x', rewrite_goal: 'y' },
      { paragraph_index: 0, category: 'rhythm', severity: 'hint', confidence: 0.9, explanation: 'x2', rewrite_goal: 'y2' },
    ] }
    expect(() => parseModelProseAnalysis(JSON.stringify(duplicate), ['段落。'])).toThrow('重复')
    const tooMany = { issues: Array.from({ length: 3 }, (_, index) => ({ paragraph_index: 0, category: ['rhythm', 'abstractness', 'voice-mismatch'][index], severity: 'hint', confidence: 0.8, explanation: `x${index}`, rewrite_goal: `y${index}` })) }
    expect(() => parseModelProseAnalysis(JSON.stringify(tooMany), ['段落。'])).toThrow('两项')
  })

  it('rejects non-strict wrappers, unknown fields, overlong explanations and cross-paragraph evidence', () => {
    const issue = { paragraph_index: 0, category: 'rhythm', severity: 'hint', confidence: 0.8, explanation: 'x', rewrite_goal: 'y' }
    expect(() => parseModelProseAnalysis(`\`\`\`json\n${JSON.stringify({ issues: [issue] })}\n\`\`\``, ['段落。'])).toThrow('严格 JSON')
    expect(() => parseModelProseAnalysis(JSON.stringify({ issues: [{ ...issue, extra: true }] }), ['段落。'])).toThrow('未知字段')
    expect(() => parseModelProseAnalysis(JSON.stringify({ issues: [{ ...issue, explanation: 'x'.repeat(121) }] }), ['段落。'])).toThrow('过长')
    expect(() => parseModelProseAnalysis(JSON.stringify({ issues: [{ ...issue, matched_text: '不存在' }] }), ['段落。'])).toThrow('不属于')
  })

  it('uses one non-streaming auxiliary request and preserves paragraph indexing', async () => {
    const { transport, getRequest } = transportWith('{"issues":[{"paragraph_index":1,"category":"rhythm","severity":"hint","confidence":0.8,"explanation":"节奏过于均匀。","rewrite_goal":"让句长和动作推进出现变化。"}]}')
    const result = await analyzeProseStyle({ paragraphs: ['第一段。', '第二段。'] }, config, transport)
    expect(result).toEqual([[], [expect.objectContaining({ ruleId: 'model-rhythm' })]])
    const body = JSON.parse(String(getRequest()?.body))
    expect(body.stream).toBe(false)
    expect(body.messages[0].content).toContain('只返回 JSON')
    expect(getRequest()?.androidTransport).toBe('native')
  })

  it('respects strict-relay prompt-only capability while retaining strict parser validation', async () => {
    const { transport, getRequest } = transportWith('{"issues":[]}')
    await analyzeProseStyle({ paragraphs: ['第一段。'] }, { ...config, capabilities: { structuredOutput: 'prompt_only' } }, transport)
    const body = JSON.parse(String(getRequest()?.body))
    expect(body.stream).toBe(false)
    expect(body.response_format).toBeUndefined()
  })
})
